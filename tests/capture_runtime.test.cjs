const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
require('../capture_profiles.js');require('../capture_runtime.js');
(async()=>{
  for(const [name,p] of Object.entries(CAPTURE_PROFILES)){
    const expected=CaptureRuntime.collapseRecordedWaits(p.ops).filter(o=>o.kind==='control'||o.kind==='write');/* recorded waits for an earlier move collapse to one poll */let at=0,frame=-1,offset=0,budget=0,inserted=0,insertStep=0;
    // The only permitted additions are addressed status polls (0x83<-0x41, ack, 0x84), which the
    // runtime issues while waiting for a positioning move; everything recorded must follow in order.
    const isAddr41=o=>o.rt===0x40&&o.value===0x83&&o.data.length===1&&o.data[0]===0x41;
    const io={
      async control(o){
        if(insertStep===1){assert(o.rt===0xc0&&o.value===0x8e&&o.index===0x20,'inserted poll: ack expected');insertStep=2;return Uint8Array.of(1);}
        if(insertStep===2){assert(o.rt===0xc0&&o.value===0x84,'inserted poll: status read expected');insertStep=0;inserted++;return Uint8Array.of(0xF5);}
        if(isAddr41(o)&&!isAddr41(expected[at])){insertStep=1;return;}
        if(o.rt===0xc0&&o.value===0x8e&&o.index===0x18)assert.equal(budget,0,'USB completion polled before draining the frame');
        assert.deepEqual(o,expected[at++]);
        if(o.rt===0x40&&o.value===0x82&&o.data[0]===0){frame++;offset=0;budget=p.frames[frame].bytes;}
        return Uint8Array.from(o.expected||[]);},
      async write(b){assert.deepEqual(Buffer.from(b),Buffer.from(expected[at++].data,'base64'));},
      async read(n){assert(n<=budget);const len=Math.min(n,17001),b=new Uint8Array(len);
        for(let i=0;i<len;i++)b[i]=(offset+i)%251;offset+=len;budget-=len;return b;}
    };
    // virtual clock: sleeps advance it; record when move 1 starts and when the next register write goes out
    let clock=0,moveAt=null,stopAt=null,regsSeen={};const ctlOrig=io.control;
    io.control=async o=>{
      if(o.rt===0x40&&o.value===0x83&&o.data.length>1){
        if(moveAt!==null&&stopAt===null)stopAt=clock;
        for(let k=0;k<o.data.length;k+=2){regsSeen[o.data[k]]=o.data[k+1];
          if(o.data[k]===0x0f&&o.data[k+1]===1&&moveAt===null&&!(regsSeen[1]&1)&&(((regsSeen[0x3d]||0)<<16)|((regsSeen[0x3e]||0)<<8)|(regsSeen[0x3f]||0))>1)moveAt=clock;}
      }
      return ctlOrig(o);
    };
    const raw=await CaptureRuntime.run(p,io,{sleep:async ms=>{clock+=ms;},now:()=>clock});
    const want=p.ops.find(o=>o.kind==='delay'&&o.timedStop).ms;
    assert(stopAt-moveAt>=want&&stopAt-moveAt<want+25,`move 1 must be stopped ${want} ms after it starts, was ${stopAt-moveAt}`);
    assert.equal(at,expected.length);assert.equal(budget,0);
    for(const i of [0,1,65535,65536,raw.length-1])assert.equal(raw[i],i%251);
    const g=CaptureRuntime.geometry(p);
    assert.deepEqual([g.pixels,g.lincnt,g.lines,g.lincntReg],
      {prescan:[2050,2824,2805,5648],full:[5124,7058,7010,14116],full7200:[10248,14122,14018,28244],'full-ir':[5124,7058,7010,14116]}[name]);
    console.log(name+`: complete control/table sequence in order${inserted?` (+${inserted} status poll(s))`:''}; move 1 stopped at +${(stopAt-moveAt).toFixed(1)} ms (recorded ${want}); short reads and frame boundaries passed`);
  }
  const tiny={frames:[{bytes:24}],mainFrame:0,ops:[
    {kind:'control',rt:0xc0,request:12,value:0x8e,index:0x20,length:1,expected:[1]},
    {kind:'read',frame:0,length:24}]};
  // The old 7200 profile had correct total bytes, but read the missing portion
  // after teardown. Reject that sequence before sending any hardware commands.
  for(const teardown of [
    {kind:'control',rt:0xc0,value:0x8e,index:0x18},
    {kind:'control',rt:0x40,value:0x83,data:[1,0x22]},
    {kind:'control',rt:0x40,value:0x83,data:[3,0xaf]}]){
    const broken={frames:[{bytes:24}],mainFrame:0,ops:[
      {kind:'read',frame:0,length:12},teardown,{kind:'read',frame:0,length:12}]};
    let touched=false;
    await assert.rejects(()=>CaptureRuntime.run(broken,{control:async()=>{touched=true;},read:async()=>{touched=true;}}),/incomplete before/);
    assert.equal(touched,false,'invalid profile must fail before USB access');
  }
  let polls=0;
  await CaptureRuntime.run(tiny,{control:async()=>Uint8Array.of(++polls===1?0:1),read:async n=>new Uint8Array(n)},{sleep:async()=>{}});
  assert.equal(polls,2);
  await assert.rejects(()=>CaptureRuntime.run(tiny,{control:async()=>Uint8Array.of(1),read:async()=>new Uint8Array(0)},{sleep:async()=>{}}),/empty/);
  await assert.rejects(()=>CaptureRuntime.run(tiny,{}, {check:()=>{throw new Error('cancelled');}}),/cancelled/);
  const g={pixels:2,lines:2,totalBytes:48,shift:{r:0,g:1,b:2}},b=new Uint8Array(48),dv=new DataView(b.buffer);
  for(let i=0;i<24;i++)dv.setUint16(i*2,1000+i,true);
  const planes=CaptureRuntime.decode(b,g);
  assert.deepEqual(Array.from(planes[0]),[1000,1003,1006,1009]);
  assert.deepEqual(Array.from(planes[1]),[1007,1010,1013,1016]);
  assert.deepEqual(Array.from(planes[2]),[1014,1017,1020,1023]);
  console.log('Polling retry, empty-read failure, cancellation and little-endian channel alignment passed');
  // Lamp check hook: both white calibration frames are handed over complete; aborting stops the
  // sequence before the main scan reads anything.
  require('../capture_sim.js');
  // every profile must carry the calibration references and the scan pace...
  for(const [n,q] of Object.entries(CAPTURE_PROFILES)){
    for(const k of ['line','dark','shading'])assert(q.lamp[k]&&q.lamp[k].mean.length===3,n+' lacks the '+k+' reference');
    assert(q.scan.bytesPerSecond>0&&q.scan.lineSeconds>0,n+' lacks the scan pace');
  }
  // ...and the behaviour is exercised on the small profile (replaying 828 MB three times over is
  // needlessly slow; the op sequence of every profile is checked by the replay test above)
  for(const [name,p] of [['prescan',CAPTURE_PROFILES.prescan]]){
    const seen=[];const sim=CaptureSim.create(p);
    await CaptureRuntime.run(p,sim,{sleep:async()=>{},frameDone:(i,d)=>seen.push([i,d.length])});
    assert.deepEqual(seen,[p.lamp.line.frame,p.lamp.dark.frame,p.lamp.shading.frame].map(i=>[i,p.frames[i].bytes]));
    // dark frame: a unit whose black level sits high is measured and the correction is exact
    const off=[5,62,-3], dk=CaptureSim.create(p,{darkOffset:off});
    let dv=null; await CaptureRuntime.run(p,dk,{sleep:async()=>{},frameDone:(i,d)=>{if(i===p.lamp.dark.frame)dv=CaptureRuntime.darkVerdict(CaptureRuntime.whiteStats(d,p.frames[i]),p.lamp.dark);}});
    assert(!dv.ok&&dv.delta.every((v,c)=>Math.abs(v-off[c])<2),'black level must be measured: '+JSON.stringify(dv));
    const ok=CaptureSim.create(p,{darkOffset:[2,-3,1]});let dv2=null;
    await CaptureRuntime.run(p,ok,{sleep:async()=>{},frameDone:(i,d)=>{if(i===p.lamp.dark.frame)dv2=CaptureRuntime.darkVerdict(CaptureRuntime.whiteStats(d,p.frames[i]),p.lamp.dark);}});
    assert(dv2.ok,'small black-level differences are within tolerance');
    const warm=CaptureSim.create(p), cold=CaptureSim.create(p,{lampReadyAt:Date.now()+60000});
    const verdicts=[];
    for(const s of [warm,cold]){ const v={}; await CaptureRuntime.run(p,s,{sleep:async()=>{},frameDone:(i,d)=>{const k=i===p.lamp.line.frame?'line':'shading';v[k]=CaptureRuntime.lampVerdict(k,CaptureRuntime.whiteStats(d,p.frames[i]),p.lamp[k]);}}); verdicts.push(v); }
    assert(verdicts[0].line.ok&&verdicts[0].shading.ok,'warm lamp must pass: '+JSON.stringify(verdicts[0]));
    assert(!verdicts[1].line.ok&&!verdicts[1].shading.ok,'cold lamp must fail');
    assert(verdicts[1].shading.issues.some(x=>/ripple/.test(x))&&verdicts[1].line.issues.some(x=>/colour balance/.test(x)));
    const abort=CaptureSim.create(p,{lampReadyAt:Date.now()+60000});
    let reads=0;const counting={...abort,read:async n=>{reads++;return abort.read(n);}};
    await assert.rejects(()=>CaptureRuntime.run(p,counting,{sleep:async()=>{},frameDone:()=>{throw new Error('lamp not settled');}}),/lamp not settled/);
    const before=p.ops.filter(o=>o.kind==='read'&&o.frame<=p.lamp.line.frame).reduce((a,o)=>a+Math.ceil(o.length/0xf000),0);
    assert(reads<=before+2,`abort must stop before the main scan (${reads} reads)`);
    console.log(`${name}: checks frames ${seen.map(x=>x[0]).join(', ')} (white line, dark, white shading); black level measured ${dv.delta.join('/')} vs applied ${off.join('/')}; warm lamp passes, cold lamp fails (${verdicts[1].line.issues.concat(verdicts[1].shading.issues).join('; ')}); abort stops after ${reads} bulk reads`);
  }
  // Fractional alignment: halfway between two delivered lines
  const gf={pixels:1,lines:2,lincnt:3,totalBytes:18,shift:{r:0,g:0.5,b:1.25}},bf=new Uint8Array(18),df=new DataView(bf.buffer);
  for(let y=0;y<3;y++)for(let c=0;c<3;c++)df.setUint16((y*3+c)*2,1000*(y+1),true);
  const pf=CaptureRuntime.decode(bf,gf);
  assert.deepEqual([...pf[0]],[1000,2000]);assert.deepEqual([...pf[1]],[1500,2500]);assert.deepEqual([...pf[2]],[2250,3000]);
  // Transfer pacing: one read stays in flight, and a host too slow for the scanner's line rate is
  // stopped when it cannot sustain the rate, risking buffer-full backtracking.
  {const p=CAPTURE_PROFILES.prescan, need=p.scan.bytesPerSecond;
   const device=(rateFactor)=>{let clock=0,inFlight=0,maxInFlight=0,frame=-1,budget=0;
     return {clock:()=>clock,advance:ms=>{clock+=ms;},get maxInFlight(){return maxInFlight;},
       async control(op){ if(op.rt===0x40&&op.value===0x82&&op.data[0]===0){frame++;budget=p.frames[frame].bytes;} return Uint8Array.from(op.expected||[1]); },
       async write(){}, 
       async read(n){ inFlight++; maxInFlight=Math.max(maxInFlight,inFlight);
         const len=Math.min(n,budget); budget-=len;
         clock+=len/(need*rateFactor)*1000;      // the host's pace
         inFlight--; return new Uint8Array(len); }};};
   const fast=device(1.05);
   await CaptureRuntime.run(p,fast,{sleep:async ms=>fast.advance(ms),now:()=>fast.clock(),readChunk:0x40000});
   assert(fast.maxInFlight>=1,'a read must be outstanding while the previous one is processed');
   const slow=device(0.5);
   await assert.rejects(()=>CaptureRuntime.run(p,slow,{sleep:async ms=>slow.advance(ms),now:()=>slow.clock()}),
     e=>e.name==='ThroughputTooLow'&&Math.abs(e.achieved-need*0.5)/need<0.1&&/buffer-full backtracking/.test(e.message));
   const stoppedAfter=slow.clock()/1000;
   assert(stoppedAfter<40,'must give up within seconds, not after the whole scan: '+stoppedAfter.toFixed(1)+' s');
   console.log(`transfer pacing: required ${(need/1e6).toFixed(2)} MB/s; a host at half that is stopped ${stoppedAfter.toFixed(1)} s into the sequence`);
   for(const [k,q] of Object.entries(CAPTURE_PROFILES))
     console.log(`  ${k.padEnd(9)} line ${(q.scan.lineSeconds*1000).toFixed(1)} ms (LINESEL ${q.scan.lineSel}) -> ${(q.scan.seconds).toFixed(0)} s, ${(q.scan.bytesPerSecond/1e6).toFixed(2)} MB/s`);}

  // In-place alignment (used for large scans) must equal the normal path and reuse the buffer
  {const W=40,H=24,P=W,L=H,bytes=new Uint8Array(P*L*6),dvv=new DataView(bytes.buffer);
   for(let i=0;i<P*L*3;i++)dvv.setUint16(i*2,(i*7919)%65535,true);
   const gg={pixels:P,lines:L-4,lincnt:L,totalBytes:bytes.length,dpi:3600,yres:7200,shift:{r:0,g:1.5,b:3}};
   const normal=CaptureRuntime.alignedFrame(bytes,gg,{average:true});
   const copy=new Uint8Array(bytes), inplace=CaptureRuntime.alignedFrame(copy,gg,{average:true,inPlace:true});
   assert.deepEqual([...new Uint16Array(inplace.data.buffer,inplace.data.byteOffset,inplace.data.length/2)],
                    [...new Uint16Array(normal.data.buffer,normal.data.byteOffset,normal.data.length/2)]);
   assert.equal(inplace.data.buffer,copy.buffer,'in-place must reuse the source buffer');
   assert.throws(()=>CaptureRuntime.alignedFrame(bytes,gg,{average:false,inPlace:true}),/in-place/);
   console.log(`in-place alignment: identical output (${inplace.width}x${inplace.height}), source buffer reused, refused when the output would not shrink`);}

  // Shift measurement recovers known sub-line R->G/B delays from a textured synthetic scene
  const W=400,H=900,tG=9.6,tB=19.2,scene=y=>x=>30000+12000*Math.sin(y*0.37+x*0.05)*Math.cos(y*0.11-x*0.03)+6000*Math.sin(y*1.3+x*0.21);
  const syn={name:'syn',shifts:[0,10,19],mainFrame:0,frames:[{pixels:W,lines:H,bytes:W*H*6,regs:{37:0,38:0,39:0}}]};
  const sb=new Uint8Array(W*H*6),sd=new DataView(sb.buffer);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++)[0,tG,tB].forEach((d,c)=>sd.setUint16(((y*W+x)*3+c)*2,Math.round(scene(y-d)(x)),true));
  const ms=CaptureRuntime.measureShifts(sb,syn);
  assert(Math.abs(ms.shifts[1]-tG)<0.15&&Math.abs(ms.shifts[2]-tB)<0.15,'measured '+ms.shifts);
  const flat=new Uint8Array(W*H*6).fill(7);assert.deepEqual(CaptureRuntime.measureShifts(flat,syn).shifts,[0,10,19]);
  const gs=CaptureRuntime.geometry(syn,ms.shifts);assert.equal(gs.lines,H-20);
  console.log(`Fractional alignment and per-scan shift measurement passed (true ${tG}/${tB}, measured ${ms.shifts[1]}/${ms.shifts[2]}; flat image falls back to recorded)`);
  for(const page of ['ui.html','experimental.html']){
    const html=fs.readFileSync(require('node:path').join(__dirname,'..',page),'utf8');
    const script=html.split('<script>')[1].split('</script>')[0];new vm.Script(script);
    const ids=[...new Set([...script.matchAll(/\$\('(\w+)'\)/g)].map(m=>m[1]))].filter(id=>!html.includes('id="'+id+'"'));
    assert.deepEqual(ids,[],page+' references missing elements');
  }
  for(const f of ['roll.js','capture_sim.js','motion.js'])new vm.Script(fs.readFileSync(require('node:path').join(__dirname,'..',f),'utf8'));
  console.log('UI pages parse; every referenced element exists');
})().catch(e=>{console.error(e);process.exit(1);});
// Colour negative: too little inter-channel correlation to measure; fall back to the calibrated
// fractional delays of the real sensor, not the rounded profile values.
{const p=CAPTURE_PROFILES.full, f=p.frames[p.mainFrame], b=new Uint8Array(f.bytes), v=new Uint16Array(b.buffer);
 require('node:crypto').randomFillSync(v); for(let i=0;i<v.length;i++) v[i]=20000+(v[i]>>4);   // uncorrelated channels
 const m=CaptureRuntime.measureShifts(b,p);
 assert.deepEqual(m.shifts,[0,24.22,48.21]); assert.match(m.used[1],/calibrated/);
 console.log('Colour-film fallback: uncorrelated channels use the calibrated delays 24.22/48.21');}
