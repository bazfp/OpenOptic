/* GL845 transport for the OpticFilm 8100, as seen in the free trial software captures (tools/usbspy). Differences from the
   GL843 7600i: a register is read with one vendor IN request, 0xC0/0x04/0x8E, index = (register << 8) | 0x22,
   returning the value and a constant 0x55; there is no write-acknowledge poll; every register write is a
   0x04/0x83 list of (register, value) pairs. No DOM; the page injects the USB device, so it is tested on a
   simulated scanner (tests/gl845.test.cjs). Not wired into the page yet: devices.js still refuses the 8100. */
(() => {
  const TRAILER=0x55;
  const fromBase64=s=>typeof atob==='function'?Uint8Array.from(atob(s),c=>c.charCodeAt(0)):Uint8Array.from(Buffer.from(s,'base64'));
  function create(dev,{epIn=1,epOut=2,sleep=ms=>new Promise(r=>setTimeout(r,ms)),rec=()=>{}}={}){
    const vendor=(request,value,index)=>({requestType:'vendor',recipient:'device',request,value,index});
    async function readReg(reg){
      const r=await dev.controlTransferIn(vendor(0x04,0x8E,(reg<<8)|0x22),2);
      if(r.status!=='ok'||r.data.byteLength!==2)throw new Error('register read failed: 0x'+reg.toString(16));
      const v=new Uint8Array(r.data.buffer,r.data.byteOffset,2);
      if(v[1]!==TRAILER)throw new Error('register 0x'+reg.toString(16)+' read returned an unexpected trailer 0x'+v[1].toString(16));
      rec({dir:'in',reg,value:v[0]}); return v[0];
    }
    async function ctlOut(request,value,index,data){
      rec({dir:'out',req:request,value,index,data:[...data]});
      const r=await dev.controlTransferOut(vendor(request,value,index),Uint8Array.from(data));
      if(r.status!=='ok')throw new Error('control write failed: 0x'+value.toString(16));
    }
    async function writeRegs(pairs){   // up to 32 pairs per transfer, as the vendor driver sends them
      for(let i=0;i<pairs.length;i+=32)await ctlOut(0x04,0x83,0,pairs.slice(i,i+32).flat());
    }
    async function send(op){           // one recorded operation: OUT control, bulk write or delay
      if(op.kind==='control'){
        if(op.rt!==0x40)throw new Error('only vendor OUT controls can be replayed, got rt 0x'+op.rt.toString(16));
        await ctlOut(op.request,op.value,op.index,op.data);
      }else if(op.kind==='write'){
        const r=await dev.transferOut(epOut,fromBase64(op.data));
        if(r.status!=='ok')throw new Error('bulk write failed');
      }else if(op.kind==='delay')await sleep(op.ms);
      else throw new Error('unknown operation '+op.kind);
    }
    async function run(ops,{check=()=>{}}={}){ for(const o of ops){ check(); await send(o); } }
    // The vendor starts every session with a one-byte status read at 0x8E/0 (value 0), then the boot registers.
    async function boot(plan,opts){
      const r=await dev.controlTransferIn(vendor(0x0C,0x8E,0),1);
      if(r.status!=='ok'||r.data.byteLength!==1||new Uint8Array(r.data.buffer,r.data.byteOffset,1)[0]!==0)throw new Error('unexpected status at session start');
      await run(plan.boot,opts);
    }
    async function bulkIn(len){
      const r=await dev.transferIn(epIn,len);
      if(r.status!=='ok'||r.data.byteLength!==len)throw new Error(`bulk read returned ${r.data?.byteLength??0} of ${len} bytes`);
      return new Uint8Array(r.data.buffer,r.data.byteOffset,len);
    }
    return {readReg,status:()=>readReg(0x41),writeRegs,send,run,boot,bulkIn,hasBulkIn:typeof dev.transferIn==='function'};
  }
  // A recorded scan pass (the quick preview). Status 0x41: MOTORENB 0x01, BUFEMPTY 0x40. The host starts the pass,
  // waits until the buffer holds data, then reads chunk after chunk, each announced by a 0x82 header with its
  // length. The scanner must be drained at once or it backs off, so nothing else happens between chunks.
  // plan = {ops, pixels, lines, bytes, chunk, startMs, maxMs}; stopOps comes from the home plan (UNVERIFIED).
  const MOTORENB=0x01, BUFEMPTY=0x40, MTRREV=0x04, MAX_LINES=20000;
  // The farthest forward position KNOWN to be safe is about 30 200 steps from the home sensor: where every recorded full-frame pass ends (it starts about
  // 15 100 steps out and travels 15 100 more). The end stop is somewhere beyond: a one-off 64 000-step scan ground against it, and Tom estimated it at about
  // 32 000 steps from how long the resulting image was (an estimate, NOT measured). So no scan may travel further than a frame (the chip cannot abort a
  // scan and forward travel has no sensor stop), counting 2400 / DPISET steps per line.
  const MAX_SCAN_STEPS=16000;
  function checkScanPlan(plan){
    const r={}; let started=false, reverse=false;
    for(const o of plan.ops){
      if(o.kind!=='control'||o.rt!==0x40||o.value!==0x83||o.data.length<2)continue;
      for(let k=0;k<o.data.length;k+=2){ r[o.data[k]]=o.data[k+1];
        if(o.data[k]===0x0F&&o.data[k+1]===1){ started=true; reverse=!!((r[0x02]||0)&MTRREV); } }
    }
    if(!started)throw new Error('scan plan refused: it never starts');
    if(reverse)throw new Error('scan plan refused: it moves in reverse');
    if(!((r[0x01]||0)&1))throw new Error('scan plan refused: the SCAN bit is not set at the start');
    const off=(plan.after||[]).some(o=>o.kind==='control'&&o.value===0x83&&o.data.some((v,i)=>i%2===0&&v===0x01&&!(o.data[i+1]&1)));
    if(!off)throw new Error('scan plan refused: it has no post-scan write that clears the SCAN bit (0x01)');
    if(plan.bytes!==plan.pixels*plan.lines*6)throw new Error('scan plan refused: bytes do not match pixels x lines x 6');
    if(plan.lines>MAX_LINES)throw new Error(`scan plan refused: ${plan.lines} lines exceeds the cap of ${MAX_LINES}`);
    const steps=plan.lines*2400/(plan.dpi/6); if(steps>MAX_SCAN_STEPS)throw new Error(`scan plan refused: it travels ${Math.round(steps)} steps, more than a frame (${MAX_SCAN_STEPS}); the farthest position known to be safe is about 30200 steps from home`);
    if(!(plan.chunk>0&&plan.chunk<=65024&&plan.chunk%512===0))throw new Error('scan plan refused: bad chunk size');
    return plan;
  }
  async function runScan(g,plan,stopOps,{log=()=>{},sleep,now,check=()=>{},progress=()=>{}}={}){
    checkScanPlan(plan);
    if(!g.hasBulkIn)throw new Error('scan refused: the device cannot read bulk data (nothing was sent)');
    if(!stopOps?.length)throw new Error('scan refused: no stop sequence');
    let s=await g.status();
    if(s&MOTORENB)throw new Error('scan refused: the carriage is already moving');
    // The recorded stop sequence halts a MOVE (tools/hwtest_8100.cjs stoptest, 2026-11-09) but NOT a running scan (stopscan: status still
    // 0xa5, motor running, 2.8 s later): the pass ends by itself after its line count. So a cancel mid-scan reads and discards the rest of the
    // pass, then sends the same two writes a finished scan ends with (SCAN off, 0x6C=0xFF; without them the next table upload hangs the chip).
    // Stop therefore takes up to the rest of the pass. Any other failure sends the stop sequence as a best effort.
    let scanning=false, got=0;
    const header=n=>g.send({kind:'control',rt:0x40,request:4,value:0x82,index:0,data:[0,0,0,0x10,n&255,(n>>8)&255,(n>>16)&255,(n>>>24)&255]});
    const cleanup=async()=>{ for(const o of plan.after||[])await g.send(o); };
    const stop=async()=>{ try{ for(const o of stopOps)await g.send(o); await cleanup(); }catch(e){} };
    const stopAndThrow=async why=>{ await stop(); throw new Error(why+': the stop sequence was sent (a running scan cannot be aborted: it ends by itself)'); };
    const drain=async()=>{
      log(`cancel requested: the OpticFilm 8100 cannot abort a scan, so the rest of this pass (${Math.ceil((plan.bytes-got)/plan.bytes*plan.lines*plan.lineMs/1000)} s) is read and discarded before parking`);
      const t=now(); while((await g.status())&BUFEMPTY){ if(now()-t>plan.startMs)throw new Error('no scan data while draining'); await sleep(5); }
      while(got<plan.bytes){ const n=Math.min(plan.chunk,plan.bytes-got); await header(n); await g.bulkIn(n); got+=n; }
      const u=now(); while((await g.status())&MOTORENB){ if(now()-u>plan.maxMs)throw new Error('scan did not finish while draining'); await sleep(10); }
      await cleanup();
    };
    try{
      for(const o of plan.ops){ check(); await g.send(o); }
      scanning=true;   // the last operation of plan.ops starts the scan
      const t=now();
      while((s=await g.status())&BUFEMPTY){ check(); if(now()-t>plan.startMs)await stopAndThrow('no scan data after '+Math.round(plan.startMs/1000)+' s'); await sleep(5); }
      for(let r=0x42;r<=0x45;r++)await g.readReg(r);   // the vendor reads these four once before the first chunk
      const data=new Uint8Array(plan.bytes);
      while(got<plan.bytes){
        check(); const n=Math.min(plan.chunk,plan.bytes-got);
        await header(n);
        data.set(await g.bulkIn(n),got); got+=n; await progress(got,plan.bytes,data);
      }
      const u=now();
      while((s=await g.status())&MOTORENB){ check(); if(now()-u>plan.maxMs)await stopAndThrow('scan did not finish in '+Math.round(plan.maxMs/1000)+' s'); await sleep(10); }
      await cleanup();   // SCAN off, 0x6C=0xFF: required before the next bulk write
      log(`scan pass of ${plan.lines} lines read: ${got} bytes in ${((now()-t)/1000).toFixed(2)} s`);
      return {data,status:s};
    }catch(e){
      if(/stop sequence was sent/.test(e.message))throw e;
      if(e?.constructor?.name==='Cancelled'){   // the page's own cancel: finish the pass quietly, then let the page park the carriage and say "Stopped"
        if(scanning){ try{ await drain(); }catch(e2){ await stop(); throw new Error('cancel could not finish the pass ('+e2.message+'): the stop sequence was sent; power-cycle the scanner if it does not respond'); } }
        throw e; }
      await stopAndThrow(e.message);
    }
  }
  // A profile object shaped like the 7600i ones, so the page's existing preview code (colour-line alignment,
  // live drawing, rendering) can use the 8100's pass. Square pixels and shifts [0,3,6] are ASSUMED: the shifts
  // are SANE's 0/12/24 lines at 3600 lpi scaled to 900 lpi; measureShifts then measures the real ones.
  function previewProfile(v){
    return {name:'OpticFilm 8100 preview ('+v.dpi+' ppi)',dpi:v.dpi,yres:v.dpi,shifts:[0,3,6],mainFrame:0,
      frames:[{bytes:v.bytes,pixels:v.pixels,lines:v.lines,regs:{},main:true}],scan:{seconds:v.lines*v.lineMs/1000},moves:[]};
  }
  // One preview pass. plans = HOME_PLANS['8100']. Default: start from the home sensor (homing first if needed), forward
  // positioning move, pass, home again. The free trial software chains previews more cheaply: after a pass it steps back plans.back
  // (bounded, sensor-protected reverse, 2.6 s) which lands on the pass's own start, and the next pass starts right there.
  //   keep:true      end with that step back instead of homing; the result says atFrame:true
  //   fromFrame:true start from there (refused unless the carriage is idle and off the home sensor), no home, no forward move
  // Returns {bytes, profile, atFrame}. Any failure leaves the carriage wherever it stopped; the page homes it before the next job.
  async function preview(g,plans,{progress=()=>{},keep=false,fromFrame=false,...hooks}={}){
    const M=globalThis.Motion, io={send:g.send,status:g.status}, homer=M.createRecordedHome(io,plans,hooks), s=await g.status();
    if(fromFrame){
      if(s&MOTORENB)throw new Error('chained preview refused: the carriage is moving');
      if(s&0x08)throw new Error('chained preview refused: the carriage is at home, not at the frame start');
    }else{
      if(!(s&0x08))await homer.home();
      await M.runForward(io,plans.forward,plans.stop,hooks);
    }
    const r=await runScan(g,plans.preview,plans.stop,{...hooks,progress});
    if(keep)await M.runForward(io,plans.back,plans.stop,hooks); else await homer.home();
    return {bytes:r.data,profile:previewProfile(plans.preview),atFrame:!!keep};
  }
  // First pixel, last pixel and DPISET of a scan plan, from its register writes (STRPIXEL 0x30, ENDPIXEL 0x32, DPISET 0x2C;
  // the units are the 7200 dpi sensor grid). Used to map a pass onto the shading reference.
  function scanGeometry(plan){
    const r={};
    for(const o of plan.ops){ if(o.kind!=='control'||o.rt!==0x40||o.value!==0x83)continue; for(let k=0;k+1<o.data.length;k+=2)r[o.data[k]]=o.data[k+1]; }
    const u16=a=>(r[a]<<8)|r[a+1], str=u16(0x30), end=u16(0x32), dpiset=u16(0x2C);
    const pixels=Math.floor((end-str)*dpiset/1200); if(pixels!==plan.pixels)throw new Error(`scan geometry mismatch: registers say ${pixels} pixels, the plan ${plan.pixels}`);
    if(u16(0x36)!==pixels*4.5)throw new Error(`scan geometry mismatch: register 0x36/0x37 is ${u16(0x36)}, a ${pixels} pixel line needs ${pixels*4.5} (as on every recorded pass)`);
    return {str,end,dpiset,pixels};
  }
  // Colour-line shifts are the ones measured on real 900 ppi data (2.96 / 5.93 lines) scaled to the pass's resolution.
  function fullProfile(v){
    const k=v.dpi/3600;   // the colour lines are a fixed distance apart on the sensor: 12 / 24 lines at 3600 ppi, twice that at 7200
    return {name:'OpticFilm 8100 ('+v.dpi+' ppi)',dpi:v.dpi,yres:v.dpi,shifts:[0,12*k,24*k],mainFrame:0,
      frames:[{bytes:v.bytes,pixels:v.pixels,lines:v.lines,regs:{},main:true}],scan:{seconds:v.lines*v.lineMs/1000},moves:[]};
  }
  // The full-resolution scan, reproducing the vendor's sequence exactly: forward positioning move, a preview pass
  // (its data is returned as `preview`; it is what carries the head over the film), a bounded step back, then the main pass.
  // The main pass's start position is only known relative to those moves, so none of them is skipped.
  // Returns {bytes, preview, profile}: the main pass plus the 900 ppi pass that preceded it. progress(got, total, data) reports the main pass only.
  // which: 'main' (3600 ppi, recorded as is) or 'main7200' (the recorded 7200 ppi pass widened to the same window; its start is the same
  // as the 3600 ppi pass's, because both begin after the same step back).
  async function scanFull(g,plans,{progress=()=>{},which='main',...hooks}={}){
    const M=globalThis.Motion, io={send:g.send,status:g.status}, homer=M.createRecordedHome(io,plans,hooks), main=plans[which];
    if(!main||!plans.back)throw new Error('full scan refused: no recorded plan for '+which);
    if(!((await g.status())&0x08))await homer.home();
    await M.runForward(io,plans.forward,plans.stop,hooks);
    const pv=await runScan(g,plans.preview,plans.stop,hooks);
    await M.runForward(io,plans.back,plans.stop,hooks);
    const r=await runScan(g,main,plans.stop,{...hooks,progress});
    await homer.home();
    return {bytes:r.data,preview:pv.data,profile:fullProfile(main)};
  }
  globalThis.Gl845={create,TRAILER,checkScanPlan,runScan,previewProfile,fullProfile,scanGeometry,preview,scanFull};
})();
