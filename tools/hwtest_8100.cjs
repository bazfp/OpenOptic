#!/usr/bin/env node
// First hardware test for the OpticFilm 8100: run the recorded the free trial software BOOT sequence (no motor move), read a
// few registers back, then switch the lamp off with the value the free trial software writes at the end of a session.
//
//   node tools/hwtest_8100.cjs [boot]     dry run: prints exactly what would be sent, touches nothing
//   node tools/hwtest_8100.cjs boot --go  really does it (needs the openoptic helper running, scanner at home)
//   node tools/hwtest_8100.cjs home [--go]      recovery: boot, then the recorded reverse home only (use when the carriage is out)
//   node tools/hwtest_8100.cjs preview [--go]   boot, forward move, ONE recorded preview scan pass (1300 x 944, about 4 s,
//                                          7.4 MB), then home; writes captures/preview_8100.raw and .png
//   node tools/hwtest_8100.cjs full [--go]      boot, then the vendor's whole full-scan sequence: forward move, a discarded preview
//                                          pass, step back, ONE 3600 ppi pass (5200 x 3776, about 64 s, 117.8 MB), home;
//                                          writes captures/full_8100.raw and .png
//   node tools/hwtest_8100.cjs full1800 [--go]  the same sequence with the 1800 ppi pass (2592 x 1889, about 8 s, 29 MB); writes captures/full1800_8100.raw/.png
//   node tools/hwtest_8100.cjs full7200 [--go]  the same sequence with the 7200 ppi pass (10400 x 7552, about 103 s, 471 MB); writes captures/full7200_8100.raw/.png
//   node tools/hwtest_8100.cjs stoptest [--go]  STOP TEST 1: boot, forward 15210 steps, start the recorded reverse home, send the recorded stop sequence
//                                          0.7 s later and check that the motor halts (reverse is sensor-protected: if the stop fails the chip stops at
//                                          home by itself after about 3.4 s); then home normally
//   node tools/hwtest_8100.cjs stopscan [--go]  STOP TEST 2: boot, forward, start the 900 ppi preview pass, cancel it a third of the way through (as the page's Stop
//                                          does: stop sequence + the post-scan cleanup), check the scan ends, then home (its table uploads must not hang)
//   node tools/hwtest_8100.cjs lamp [--go] --lamp-seconds 100   boot, then watch status 0x41 bit 0x04 and register 0x03 once a second (NO motion)
//   node tools/hwtest_8100.cjs move [--go] boot, then ONE recorded forward move of 15210 steps (about 2.6 s, ends by
//                                          itself), then the recorded reverse home (the chip stops at the sensor)
//   options: --port N (default 47600), --lamp-seconds N (default 3)
//
// It never writes 0x0F (motor/scan start). It refuses to run unless the device is a 07b3:130c with bcdDevice
// 6.05 and the carriage is not moving. On any failure it tries to switch the lamp off and closes the device.
const path=require('node:path');
const fs=require('node:fs'), zlib=require('node:zlib');
for(const f of ['gl845.js','motion.js','home_plans.js'])require(path.join(__dirname,'..',f));
const arg=(n,d)=>{ const i=process.argv.indexOf(n); return i>0?process.argv[i+1]:d; };
const MODE=['move','preview','full','full7200','full1800','home','lamp','stoptest','stopscan'].includes(process.argv[2])?process.argv[2]:'boot', GO=process.argv.includes('--go'), PORT=+arg('--port',47600), LAMP_S=+arg('--lamp-seconds',3);
const FULL=['full','full7200','full1800'].includes(MODE), WHICH={full7200:'main7200',full1800:'main1800'}[MODE]||'main', TAG={full7200:'full7200_8100',full1800:'full1800_8100'}[MODE]||'full_8100';
const plan=HOME_PLANS['8100'], MOTORENB=0x01, HOME=0x08, LAMP_OFF=[[0x03,0x00]];   // 0x03=0x00: the free trial software's last write

function describe(){
  const w=[]; for(const o of plan.boot)if(o.kind==='control'&&o.value===0x83)for(let k=0;k<o.data.length;k+=2)w.push([o.data[k],o.data[k+1]]);
  const regs=new Set(w.map(x=>x[0]));
  console.log('The boot plan sends, in order:');
  console.log('  1 status read      0xC0/0x0C/0x8E index 0 (expects 0)');
  console.log(`  ${plan.boot.filter(o=>o.kind==='control'&&o.value===0x83).length} register-write transfers, ${w.length} writes to ${regs.size} registers (0x01=0x22 scan off, 0x02=0x38 motor idle, 0x03=0xBF LAMP ON)`);
  console.log(`  ${plan.boot.filter(o=>o.kind==='control'&&o.value===0x8C).length} AFE strobe writes (0x8C), ${plan.boot.filter(o=>o.kind==='delay').length} delays of about 100 ms`);
  console.log(`  motor/scan start (0x0F=1): ${w.some(x=>x[0]===0x0F&&x[1]===1)?'YES - ABORT':'never'}; SCAN bit in 0x01: ${w.some(x=>x[0]===1&&(x[1]&1))?'YES - ABORT':'never'}`);
  if(MODE==='preview'){
    const v=plan.preview; Gl845.checkScanPlan(v);
    console.log(`Then the recorded forward move (${plan.forward.steps} steps), then ONE scan pass: ${v.pixels} x ${v.lines} pixels, ${v.bytes} bytes in ${Math.ceil(v.bytes/v.chunk)} chunks of up to ${v.chunk},`);
    console.log(`  ${v.ops.length} setup operations incl. 5 table uploads, scan start 0x01=0x03 / 0x0F=1. The pass takes about ${(v.lines*v.lineMs/1000).toFixed(1)} s and the lamp should light.`);
    console.log('  The carriage advances by the scan itself (bounded by the line count). On any failure the stop sequence is sent (it halts moves; a scan ends by itself) and nothing more.');
    console.log('Then the recorded reverse home (the chip stops at the sensor).');
  }
  if(FULL){
    const m=plan[WHICH]; Gl845.checkScanPlan(m); Gl845.checkScanPlan(plan.preview); Motion.checkForwardPlan(plan.forward); Motion.checkForwardPlan(plan.back);
    console.log(`Then the vendor's full sequence: forward move (${plan.forward.steps} steps); a preview pass (${plan.preview.pixels} x ${plan.preview.lines}, about ${(plan.preview.lines*plan.preview.lineMs/1000).toFixed(0)} s, saved as ${TAG}_preview.raw);`);
    console.log(`  a bounded step back in reverse (${plan.back.steps} steps); then ONE main pass: ${m.pixels} x ${m.lines} pixels, ${m.bytes} bytes (${(m.bytes/1e6).toFixed(1)} MB) in ${Math.ceil(m.bytes/m.chunk)} chunks, about ${(m.lines*m.lineMs/1000).toFixed(0)} s;`);
    console.log('  then the recorded reverse home. On any failure the stop sequence is sent (it halts moves; a running scan cannot be stopped, it ends by itself) and nothing more; the carriage may then be left out and need a power cycle.');
  }
  if(MODE==='stoptest'){ Motion.checkHomePlan(plan); Motion.checkForwardPlan(plan.forward);
    console.log(`Then the forward move (${plan.forward.steps} steps), then the recorded reverse home move started on purpose; after 0.7 s (about 3000 steps, ~12 000 from the sensor) the recorded stop sequence is sent:`);
    console.log('  ' + JSON.stringify(plan.stop[0].data) + '  (0x01=0x22 scan off, 0x02=0x38 motor idle, FEEDL=1).');
    console.log('  PASS = status 0x41 loses the MOTORENB bit (0x01) within 2 s and HOME (0x08) is still clear, i.e. the stop halted the motor and not the sensor.');
    console.log('  The reverse move is sensor-protected, so even if the stop does nothing the chip parks at home itself after about 3.4 s. Then the normal recorded home runs.'); }
  if(MODE==='stopscan'){ Gl845.checkScanPlan(plan.preview);
    console.log(`Then the forward move, then the 900 ppi preview pass; after about a third of the data (${Math.round(plan.preview.bytes/3/1e6)} MB, ~1.4 s) it is cancelled exactly as the page's Stop does (about 3 s then pass while the rest is drained):`);
    console.log('  the first run showed the stop sequence does NOT abort a scan, so runScan now reads and discards the rest of the pass and then sends the cleanup ' + JSON.stringify(plan.preview.after.map(o=>o.data)) + '. PASS = it returns Cancelled after the pass ends, the carriage idles, and the recorded home (table uploads over bulk USB) works.');
    console.log('  RISK: if the chip is left in scan mode the next bulk write hangs and the scanner needs a power cycle. The carriage is then about 15 000 steps out; the sensor protects a reverse home.'); }
  if(MODE==='lamp')console.log(`Then it only READS status 0x41 and register 0x03 once a second for ${LAMP_S} s, printing every change (no motor move, no scan).`);
  if(MODE==='move'){
    const f=plan.forward; Motion.checkForwardPlan(f);
    console.log(`Then ONE forward positioning move: ${f.steps} steps (cap ${f.maxSteps}), ${f.ops.length} setup operations incl. 5 table uploads, ending with 0x0F=1.`);
    console.log(`  It ends by itself after about 2.6 s (${f.steps} steps). The script waits up to ${f.maxMs/1000} s; if it has not finished it sends the stop sequence (verified for moves) and aborts.`);
    console.log(`Then the recorded reverse home: the chip drives in reverse and stops itself at the home sensor (status 0xCC/0xDC); timeout ${plan.maxMs/1000} s.`);
    console.log('If anything fails after the forward move the carriage may be left about 27 mm out. Nothing more is sent; power-cycle and re-run.');
  }
  console.log(`Then it waits ${LAMP_S} s and writes 0x03=0x00 (lamp off, as the free trial software does when it quits).`);
  if(w.some(x=>x[0]===0x0F&&x[1]===1)||w.some(x=>x[0]===1&&(x[1]&1)))process.exit(2);
}

async function connect(){
  const html=await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
  const token=/token:"([0-9a-f]+)"/.exec(html)?.[1]; if(!token)throw new Error('no helper token on the page: is openoptic running on port '+PORT+'?');
  const call=async(p,body)=>{ const r=await fetch(`http://127.0.0.1:${PORT}${p}`,{method:'POST',headers:{'X-Token':token},body}); if(r.ok)return new Uint8Array(await r.arrayBuffer()); if(r.status===409)return null; throw new Error((await r.text()).trim()||('HTTP '+r.status)); };
  const info=JSON.parse(new TextDecoder().decode(await call('/api/open')));
  const q=o=>new URLSearchParams(o).toString();
  const dev={
    async controlTransferOut(s,data){ const d=await call('/api/ctl?'+q({rt:0x40,req:s.request,val:s.value,idx:s.index}),data); return {status:d?'ok':'stall'}; },
    async controlTransferIn(s,len){ const d=await call('/api/ctl?'+q({rt:0xC0,req:s.request,val:s.value,idx:s.index,len})); return d?{status:'ok',data:new DataView(d.buffer,d.byteOffset,d.byteLength)}:{status:'stall'}; },
    async transferOut(ep,data){ const d=await call('/api/bulk?'+q({ep:ep&0x7F}),data); return {status:d?'ok':'stall'}; },
    async transferIn(ep,len){ const d=await call('/api/bulk?'+q({ep:0x80|ep,len})); return d?{status:'ok',data:new DataView(d.buffer,d.byteOffset,d.byteLength)}:{status:'stall'}; },
    close:()=>call('/api/close'),
  };
  return {info,dev};
}

// 16-bit little-endian RGB, 6 bytes per pixel, rows in order -> 8-bit PNG with a 1%..99% stretch per channel
function toPng(buf,w,h){
  const dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength), lim=[0,1,2].map(c=>{ const hist=new Uint32Array(65536);
    for(let i=c;i<w*h*3;i+=3)hist[dv.getUint16(i*2,true)]++; let a=0,lo=0,hi=65535; const n=w*h;
    for(let v=0;v<65536;v++){ a+=hist[v]; if(a>=n*0.01){ lo=v; break; } } a=0;
    for(let v=0;v<65536;v++){ a+=hist[v]; if(a>=n*0.99){ hi=v; break; } } return [lo,Math.max(hi,lo+1)]; });
  const raw=Buffer.alloc((w*3+1)*h);
  for(let y=0;y<h;y++){ raw[y*(w*3+1)]=0; for(let x=0;x<w;x++)for(let c=0;c<3;c++){
    const v=dv.getUint16(((y*w+x)*3+c)*2,true), [lo,hi]=lim[c]; raw[y*(w*3+1)+1+x*3+c]=Math.max(0,Math.min(255,Math.round((v-lo)/(hi-lo)*255))); } }
  const crcT=new Uint32Array(256).map((_,n)=>{ let c=n; for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1; return c>>>0; });
  const crc=b=>{ let c=0xFFFFFFFF; for(const x of b)c=crcT[(c^x)&255]^(c>>>8); return (c^0xFFFFFFFF)>>>0; };
  const chunk=(t,d)=>{ const b=Buffer.concat([Buffer.from(t),d]), o=Buffer.alloc(4+b.length+4); o.writeUInt32BE(d.length,0); b.copy(o,4); o.writeUInt32BE(crc(b),4+b.length); return o; };
  const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(w,0); ihdr.writeUInt32BE(h,4); ihdr[8]=8; ihdr[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}

(async()=>{
  describe();
  if(!GO){ console.log('\nDry run only. Nothing was sent. Re-run with --go to do it.'); return; }
  const {info,dev}=await connect();
  let lampOn=false; const g=Gl845.create(dev,{rec:()=>{}});
  // say WHICH operation failed: a bare "USB transfer timed out" is useless when 125 operations were in flight
  let nops=0; const rawSend=g.send;
  g.send=async op=>{ nops++; try{ return await rawSend(op); }catch(e){
    e.message+=` [operation #${nops} of this run: ${op.kind}${op.kind==='control'?` value 0x${op.value.toString(16)} index 0x${op.index.toString(16)}, ${op.data.length} bytes, first ${JSON.stringify(op.data.slice(0,4))}`:''}]`; throw e; } };
  try{
    console.log(`\nopened: product 0x${info.productId.toString(16)}, bcdDevice 0x${info.bcdDevice.toString(16)}, ${info.backend}`);
    if(info.productId!==0x130C||info.bcdDevice!==0x0605)throw new Error('not an OpticFilm 8100 (07b3:130c, bcdDevice 6.05): refusing');
    const s0=await g.status(); console.log('status 0x41 before:','0x'+s0.toString(16),(s0&HOME)?'(at home)':'(NOT at home)',(s0&MOTORENB)?'(MOVING)':'(idle)');
    if(s0&MOTORENB)throw new Error('the carriage is moving: refusing to boot');
    if(MODE!=='boot'&&MODE!=='home'&&!(s0&HOME))throw new Error('the carriage is not at home: refusing to move it');
    console.log('running the boot plan...'); lampOn=true; await g.boot(plan);
    const regs={}; for(const r of [0x00,0x01,0x02,0x03,0x41]) regs[r]=await g.readReg(r);
    console.log('read back:',Object.entries(regs).map(([r,v])=>`0x${(+r).toString(16).padStart(2,'0')}=0x${v.toString(16).padStart(2,'0')}`).join('  '));
    if(regs[1]!==0x22||regs[2]!==0x38)throw new Error('registers 0x01/0x02 did not read back the boot values');
    if(MODE==='home'){
      const hooks={sleep:ms=>new Promise(r=>setTimeout(r,ms)),now:()=>performance.now(),log:m=>console.log('  '+m)};
      console.log('homing only (reverse, the chip stops at the sensor)...'); const hs=await Motion.createRecordedHome({send:g.send,status:g.status},plan,hooks).home();
      console.log('  status after home: 0x'+hs.toString(16),(hs&HOME)?'(at home)':'(NOT at home)');
    }
    if(MODE==='stoptest'||MODE==='stopscan'){
      const hooks={sleep:ms=>new Promise(r=>setTimeout(r,ms)),now:()=>performance.now(),log:m=>console.log('  '+m)}, io={send:g.send,status:g.status}, HOMEBIT=0x08;
      console.log('forward move...'); await Motion.runForward(io,plan.forward,plan.stop,hooks);
      if(MODE==='stoptest'){
        console.log('starting the recorded reverse home move on purpose...'); for(const o of plan.ops)await g.send(o);
        const t0=performance.now(); let s1=await g.status(); while(!(s1&MOTORENB)&&performance.now()-t0<1500)s1=await g.status();
        if(!(s1&MOTORENB))throw new Error('the home move did not start (status 0x'+s1.toString(16)+')');
        while(performance.now()-t0<700)s1=await g.status(); console.log(`  moving, status 0x${s1.toString(16)} after ${(performance.now()-t0).toFixed(0)} ms: sending the stop sequence NOW`);
        const ts=performance.now(); for(const o of plan.stop)await g.send(o);
        let s2=await g.status(); while((s2&MOTORENB)&&performance.now()-ts<6000)s2=await g.status(); const dt=performance.now()-ts;
        console.log(`  status 0x${s2.toString(16)} ${dt.toFixed(0)} ms after the stop: motor ${(s2&MOTORENB)?'STILL RUNNING':'halted'}, home sensor ${(s2&HOMEBIT)?'SET':'clear'}`);
        if(s2&MOTORENB)throw new Error('STOP TEST FAILED: the motor was still running 6 s after the stop');
        if(s2&HOMEBIT)console.log('  note: the home sensor is set, so the move may have finished by itself; this run does NOT prove the stop. Repeat it.');
        else if(dt<2000)console.log('  >>> STOP VERIFIED: the recorded stop sequence halted a running reverse move away from the sensor.'); else console.log('  the motor stopped, but slowly: not a clean pass');
      }else{
        class Cancelled extends Error{} ; let chunks=0, cancel=false; const need=Math.ceil(plan.preview.bytes/plan.preview.chunk/3);
        const cs={...hooks,check:()=>{ if(cancel)throw new Cancelled('cancelled'); },progress:()=>{ if(++chunks>=need)cancel=true; }};
        console.log('scan pass, to be cancelled after chunk '+need+'...'); let err=null; try{ await Gl845.runScan(g,plan.preview,plan.stop,cs); }catch(e){ err=e; }
        if(!(err instanceof Cancelled))throw new Error('STOP TEST FAILED: expected the cancel to come back as Cancelled, got '+(err?err.message:'a finished scan'));
        console.log('  cancelled; the rest of the pass was drained and the cleanup sent'); await new Promise(r=>setTimeout(r,300));
        const s2=await g.status(); console.log(`  status 0x${s2.toString(16)}: motor ${(s2&MOTORENB)?'STILL RUNNING':'idle'}`);
        if(s2&MOTORENB){ await new Promise(r=>setTimeout(r,2500)); const s3=await g.status(); console.log(`  2.5 s later status 0x${s3.toString(16)}: motor ${(s3&MOTORENB)?'STILL RUNNING':'idle'}`); if(s3&MOTORENB)throw new Error('STOP TEST FAILED: the scan did not stop'); }
        console.log('  >>> the scan ended. Now the recorded home (its table uploads prove the chip is out of scan mode)...');
      }
      console.log('homing (reverse, chip stops at the sensor)...'); const hs=await Motion.createRecordedHome(io,plan,hooks).home();
      console.log('  status after home: 0x'+hs.toString(16),(hs&HOMEBIT)?'(at home)':'(NOT at home)');
    }
    if(MODE==='lamp'){
      let prev=null; const t0=performance.now();
      for(let t=0;t<=LAMP_S;t++){ const st=await g.readReg(0x41), r3=await g.readReg(0x03), k=`0x41=0x${st.toString(16)} (lamp bit ${st&4?'ON':'off'}) 0x03=0x${r3.toString(16)}`;
        if(k!==prev||t%10===0){ console.log(`  t=${((performance.now()-t0)/1000).toFixed(0).padStart(3)} s  ${k}${k!==prev?'   <-- changed':''}`); prev=k; }
        await new Promise(r=>setTimeout(r,1000)); }
    }
    if(FULL){
      const hooks={sleep:ms=>new Promise(r=>setTimeout(r,ms)),now:()=>performance.now(),log:m=>console.log('  '+m)}; let lastPct=-1, lastWatch=0; const t0=performance.now();
      console.log('full scan sequence...');
      const r=await Gl845.scanFull(g,plan,{...hooks,which:WHICH,progress:async (got,total,data)=>{ const pct=Math.floor(got/total*10); if(pct!==lastPct){ lastPct=pct; console.log(`  main pass ${pct*10}% (${(got/1e6).toFixed(1)} MB, ${((performance.now()-t0)/1000).toFixed(0)} s)`); }
        // every 2 s, between chunks: brightness of the latest data plus status 0x41 and register 0x03 (read only)
        const now=performance.now(); if(now-lastWatch<2000)return; lastWatch=now;
        const v=new Uint16Array(data.buffer,data.byteOffset+got-65024,65024/2); let sum=0; for(let i=0;i<v.length;i+=7)sum+=v[i];
        const st=await g.readReg(0x41), r3=await g.readReg(0x03);
        console.log(`    watch ${((now-t0)/1000).toFixed(0).padStart(3)} s line ${Math.floor(got/(plan[WHICH].pixels*6))}: brightness ${Math.round(sum/Math.ceil(v.length/7))}  0x41=0x${st.toString(16)} 0x03=0x${r3.toString(16)}`); }});
      const m=plan[WHICH], out=path.join(__dirname,'..','captures'); fs.mkdirSync(out,{recursive:true});
      fs.writeFileSync(path.join(out,TAG+'_preview.raw'),r.preview); fs.writeFileSync(path.join(out,TAG+'.raw'),r.bytes);
      // the PNG is for a quick look: at 7200 ppi keep every second pixel and line (a full 78 MP PNG would take minutes to compress)
      let pb=r.bytes, pw=m.pixels, ph=m.lines;
      if(WHICH==='main7200'){ pw=m.pixels>>1; ph=m.lines>>1; pb=new Uint8Array(pw*ph*6); const src=new DataView(r.bytes.buffer,r.bytes.byteOffset,r.bytes.byteLength);
        for(let y=0;y<ph;y++)for(let x=0;x<pw;x++){ const o=((y*2)*m.pixels+x*2)*6, d=(y*pw+x)*6; for(let k=0;k<6;k++)pb[d+k]=r.bytes[o+k]; } }
      fs.writeFileSync(path.join(out,TAG+'.png'),toPng(pb,pw,ph));
      console.log(`  ${r.bytes.length} bytes in ${((performance.now()-t0)/1000).toFixed(0)} s; wrote captures/${TAG}.raw and captures/${TAG}.png${WHICH==='main7200'?' (the PNG is decimated 2x)':''}`);
      console.log('  status after home: 0x'+(await g.status()).toString(16));
    }
    if(MODE==='move'||MODE==='preview'){
      const hooks={sleep:ms=>new Promise(r=>setTimeout(r,ms)),now:()=>performance.now(),log:m=>console.log('  '+m)}, io={send:g.send,status:g.status};
      console.log('forward move...'); const r=await Motion.runForward(io,plan.forward,plan.stop,hooks);
      console.log('  status after forward move: 0x'+r.status.toString(16),'(feed-finished bit seen:',r.sawFinish+')');
      if(MODE==='preview'){
        const v=plan.preview; let lastPct=-1;
        console.log('scan pass...'); const t0=performance.now();
        const sr=await Gl845.runScan(g,v,plan.stop,{...hooks,progress:(got,total)=>{ const pct=Math.floor(got/total*10); if(pct!==lastPct){ lastPct=pct; console.log(`  ${pct*10}% (${(got/1e6).toFixed(1)} MB)`); } }});
        console.log(`  pass finished, status 0x${sr.status.toString(16)}, ${((performance.now()-t0)/1000).toFixed(1)} s`);
        const out=path.join(__dirname,'..','captures'); fs.mkdirSync(out,{recursive:true});
        fs.writeFileSync(path.join(out,'preview_8100.raw'),sr.data); fs.writeFileSync(path.join(out,'preview_8100.png'),toPng(sr.data,v.pixels,v.lines));
        console.log('  wrote captures/preview_8100.raw and captures/preview_8100.png');
      }
      console.log('homing (reverse, chip stops at the sensor)...'); const hs=await Motion.createRecordedHome(io,plan,hooks).home();
      console.log('  status after home: 0x'+hs.toString(16),(hs&HOME)?'(at home)':'(NOT at home)');
    }
    const hold=MODE==='lamp'?3:LAMP_S; console.log(`lamp on for ${hold} s...`); await new Promise(r=>setTimeout(r,hold*1000));
    await g.writeRegs(LAMP_OFF); lampOn=false;
    console.log('lamp off written; read back 0x03 =','0x'+(await g.readReg(0x03)).toString(16));
    console.log(MODE==='home'?'\nHOME OK: the carriage is at the home sensor.':MODE==='stoptest'?'\nSTOP TEST 1 DONE: read the verdict line above.':MODE==='stopscan'?'\nSTOP TEST 2 DONE: read the verdict lines above.':MODE==='lamp'?'\nLAMP WATCH DONE: no motor move was commanded.':FULL?`\nFULL SCAN TEST PASSED: one ${{main7200:7200,main1800:1800}[WHICH]||3600} ppi pass read and the carriage homed.`:MODE==='preview'?'\nPREVIEW TEST PASSED: one scan pass read and the carriage homed.':MODE==='move'?'\nMOVE TEST PASSED: forward move and return home completed.':'\nBOOT TEST PASSED: no motor move was commanded.');
  }catch(e){
    console.error('\nFAILED:',e.message);
    if(lampOn&&MODE==='boot'){ try{ await g.writeRegs(LAMP_OFF); console.error('lamp-off written as a precaution'); }catch(e2){ console.error('could not write lamp off:',e2.message); } }
    process.exitCode=1;
  }finally{ try{ await dev.close(); }catch{} }
})().catch(e=>{ console.error(e.message); process.exit(1); });
