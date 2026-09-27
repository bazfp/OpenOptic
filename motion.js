/* Carriage homing built only from motor primitives the Plustek software itself uses in the
   captures. No DOM; the page injects register I/O, so it can be tested on a simulated carriage
   (tests/motion.test.cjs).

   Recorded primitives (3600ppifullframehdr / prescan):
     fast move   0x02=0x18, LPERIOD 0x36B0, 0x1C=0x20, 0x10-0x15=0, 0x6A=0xFF, fast table
                 (64102..625, cruise 4000 steps/s) in slot 3, FEEDL, 0x0F=1   (move 2)
     slow move   same with the slow table (20325..2604, cruise 960 steps/s)   (move 1)
     short feed  0x6A=0x46 (short acceleration), FEEDL=1                        (first feed)
     stop        0x02=0x08 then FEEDL=1 while the move runs                     (move 1 stop)
   The captures never home from an arbitrary position (they end while the automatic return is
   under way), so the procedure below combines these: stop anything running, return fast in
   reverse (0x02 bit 0x04, MTRREV) until the home sensor, leave it forward by a fixed amount,
   then approach it slowly in reverse and stop the moment it trips. The carriage then sits at
   the sensor edge having arrived in reverse, the state the vendor's automatic return leaves
   and the state its first one-step feed assumes. */
(() => {
  const HOME=0x08, MOTORENB=0x01, FEEDFSH=0x20, MTRREV=0x04;
  const MOTOR_REGS=[0x1C,0x1F,0x21,0x22,0x23,0x24,0x38,0x39,0x5E,0x5F,0x67,0x68,0x69,0x6B,0x6C,0x6D,0x6E,0x6F,0x80];

  // Motor context and tables exactly as the recording has them when move 2 starts.
  function recorded(profile){
    const reg=new Map(); let slot=null; const t3=[]; let ctx=null;
    for(const o of profile.ops){
      if(o.kind==='write'&&slot===3){ const b=typeof atob==='function'?Uint8Array.from(atob(o.data),c=>c.charCodeAt(0)):Buffer.from(o.data,'base64');
        const t=[];for(let i=0;i+1<b.length;i+=2)t.push(b[i]|(b[i+1]<<8)); t3.push(t); continue; }
      if(o.kind!=='control'||o.rt!==0x40||o.value!==0x83||o.data.length<2)continue;
      for(let k=0;k<o.data.length;k+=2){
        const r=o.data[k],v=o.data[k+1];
        if(r===0x5B)slot=(v&0x40)?((v>>3)&7):null;
        if(r===0x0F&&v===1&&!ctx){ const fl=((reg.get(0x3D)||0)<<16)|((reg.get(0x3E)||0)<<8)|(reg.get(0x3F)||0);
          if(fl>1&&t3.length>=3) ctx=new Map(reg); }
        reg.set(r,v);
      }
    }
    const byCruise=[...t3].sort((a,b)=>a[a.length-1]-b[b.length-1]);
    if(!ctx||t3.length<2)throw new Error('profile has no recorded fast move');
    return {fast:byCruise[0],slow:byCruise[byCruise.length-1],regs:ctx};
  }

  function create(io,rec,{log=()=>{},sleep,now,check=()=>{}}={}){
    // io: writeRegs([[reg,val],...]), status() -> 0x41, upload(slot, table)
    const u24=n=>[[0x3D,(n>>16)&0x0F],[0x3E,(n>>8)&0xFF],[0x3F,n&0xFF]];
    const base01=(rec.regs.get(0x01)??0x22)&~0x01;           // SCAN off, rest as recorded
    let loaded=null;

    async function waitIdle(ms,what){
      const t=now(); let s=await io.status();
      while(s&MOTORENB){ check(); if(now()-t>ms)throw new Error(what+': motor still running after '+Math.round(ms/1000)+' s'); await sleep(10); s=await io.status(); }
      return s;
    }
    // The vendor's way of ending a move early (move 1 in every capture).
    async function stop(){
      await io.writeRegs([[0x01,base01]]); await io.writeRegs([[0x02,0x08]]); await io.writeRegs(u24(1));
      return waitIdle(5000,'stop');
    }
    async function move(steps,{reverse,table,fmovno,until=null,timeout}){
      await waitIdle(5000,'before move');
      // Slot 3 (RAM 0x58000) is the GL843's "table four", the one FMOVNO (0x6A) uses for fast
      // moves; the datasheet has no fifth table, and the vendor never writes 0x60000, so nothing
      // else is uploaded (writing unknown RAM could land in the image buffer).
      if(loaded!==table){ await io.upload(3,table); loaded=table; }
      await io.writeRegs([[0x01,base01],...MOTOR_REGS.map(r=>[r,rec.regs.get(r)??0]),
        [0x10,0],[0x11,0],[0x12,0],[0x13,0],[0x14,0],[0x15,0],[0x6A,fmovno],
        [0x02,0x18|(reverse?MTRREV:0)],...u24(steps)]);
      await io.writeRegs([[0x0F,1]]);
      const t=now();
      for(;;){
        check(); const s=await io.status();
        if(until&&until(s)){ await stop(); return {status:await io.status(),reached:true}; }
        if(!(s&MOTORENB)&&(s&FEEDFSH))return {status:s,reached:false};
        if(now()-t>timeout){ await stop(); throw new Error('move did not finish in '+Math.round(timeout/1000)+' s'); }
        await sleep(2);
      }
    }
    async function home(){
      const t0=now(); let s=await io.status();
      if(s&MOTORENB){ log('carriage still moving: stopping it first'); s=await stop(); }
      if(!(s&HOME)){
        const r=await move(80000,{reverse:true,table:rec.fast,fmovno:0xFF,until:x=>x&HOME,timeout:30000});
        if(!r.reached)throw new Error('home sensor not found: the carriage reversed its full range without reaching it');
      }
      // leave the sensor forward by a fixed amount, fast table with the short-feed acceleration
      for(let i=0;;i++){
        const r=await move(600,{reverse:false,table:rec.fast,fmovno:0x46,timeout:5000});
        if(!(r.status&HOME))break;
        if(i>=4)throw new Error('home sensor stays on after moving 3000 steps forward');
      }
      // slow final approach in reverse; stop the instant the sensor trips
      const r=await move(3000,{reverse:true,table:rec.slow,fmovno:0xFF,until:x=>x&HOME,timeout:10000});
      if(!r.reached)throw new Error('home sensor not found on the final approach');
      log(`carriage parked at the home sensor (${((now()-t0)/1000).toFixed(1)} s)`);
      return r.status;
    }
    return {home,stop,waitIdle};
  }
  globalThis.Motion={recorded,create};
})();
