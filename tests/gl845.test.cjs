// GL845 transport for the OpticFilm 8100: request encodings checked at the USB level against a simulated
// carriage, then the real boot and home plans (home_plans.js, from the the free trial software capture) run through it.
const assert=require('node:assert/strict'),path=require('node:path');
for(const f of ['gl845.js','motion.js','home_plans.js'])require(path.join(__dirname,'..',f));
const {carriage}=require('./helpers/carriage845.cjs');
const plan=HOME_PLANS['8100'];

(async()=>{
  // register read framing: one 0xC0/0x04/0x8E request, index = reg<<8 | 0x22, value + 0x55 trailer
  { const c=carriage(0), g=Gl845.create(c.dev);
    const v=await g.readReg(0x41);
    assert.equal(v&0x08,0x08,'sensor bit set at the home position');
    assert.deepEqual(c.usb.at(-1),{dir:'in',request:4,value:0x8E,index:0x4122,len:2});
    assert.equal(c.usb.some(u=>u.index===0x20),false,'no write-acknowledge polling on the GL845');
    const bad=Gl845.create({controlTransferIn:async()=>({status:'ok',data:new DataView(new Uint8Array([7,0x54]).buffer)})});
    await assert.rejects(()=>bad.readReg(1),/unexpected trailer/); }
  // register writes: 0x04/0x83 pair lists, at most 32 pairs per transfer
  { const c=carriage(0), g=Gl845.create(c.dev); const pairs=Array.from({length:70},(_,i)=>[i,i+1]);
    await g.writeRegs(pairs);
    const outs=c.usb.filter(u=>u.dir==='out'); assert.deepEqual(outs.map(u=>u.data.length),[64,64,12]);
    assert(outs.every(u=>u.request===4&&u.value===0x83&&u.index===0)); }
  // operations: vendor OUT controls, bulk writes and delays; nothing else
  { const c=carriage(0), g=Gl845.create(c.dev,{sleep:async ms=>c.hooks.sleep(ms)});
    await g.send({kind:'control',rt:0x40,request:4,value:0x82,index:1,data:[0,0,0,16,2,1,0,0]});
    await g.send({kind:'write',data:Buffer.from([1,2,3]).toString('base64')}); await g.send({kind:'delay',ms:50});
    assert.deepEqual(c.usb.map(u=>u.dir),['out','bulkout']);
    await assert.rejects(()=>g.send({kind:'control',rt:0xC0,request:4,value:0x8E,index:0,data:[]}),/only vendor OUT/);
    await assert.rejects(()=>g.send({kind:'poll'}),/unknown operation/); }
  // the real boot plan: begins with the one-byte status read, only OUT traffic afterwards, ends at idle
  { const c=carriage(0), g=Gl845.create(c.dev,{sleep:async ms=>c.hooks.sleep(ms)});
    await g.boot(plan);
    assert.deepEqual(c.usb[0],{dir:'in',request:0x0C,value:0x8E,index:0,len:1});
    assert(c.usb.slice(1).every(u=>u.dir!=='in'),'boot replays writes only');
    assert(!c.moving,'boot must not start the motor'); }
  // boot then home from far out, through the real encodings: parks at the sensor, reverse only, no ack polls
  for(const p0 of [31000,300,5]){
    const c=carriage(p0), g=Gl845.create(c.dev,{sleep:async ms=>c.hooks.sleep(ms)});
    await g.boot(plan);
    const m=Motion.createRecordedHome({send:g.send,status:g.status},plan,c.hooks);
    const s=await m.home();
    assert(s&0x08&&!(s&1)&&!c.hitEnd&&!c.forward&&c.pos<=0&&c.pos>=-60,`from ${p0}: parked at ${c.pos}`);
    assert.equal(c.usb.some(u=>u.dir==='in'&&u.index===0x20),false);
    console.log(`boot + home from ${String(p0).padStart(5)} steps: parked at ${String(c.pos).padStart(3)}, ${c.usb.length} USB requests`);
  }
  // the recorded forward positioning move (15210 steps) from home, then home again: bounded out, sensor-protected back
  { const fwd=plan.forward, c=carriage(0), g=Gl845.create(c.dev,{sleep:async ms=>c.hooks.sleep(ms)});
    assert.equal(fwd.steps,15210);
    await g.boot(plan);
    const r=await Motion.runForward({send:g.send,status:g.status},fwd,plan.stop,c.hooks);
    assert(!(r.status&1),'motor stopped'); assert(Math.abs(c.pos-15210)<=64,'forward move ended at '+c.pos); assert(!c.hitEnd);
    const m=Motion.createRecordedHome({send:g.send,status:g.status},plan,c.hooks); const s=await m.home();
    assert(s&0x08&&c.pos<=0&&c.pos>=-60&&!c.hitEnd,'homed again, parked at '+c.pos);
    console.log(`forward ${fwd.steps} steps then home: out to ${15210}, back parked at ${c.pos}`);
    // refusals: too many steps, wrong direction, scan move, step count not matching, no stop, motor already moving
    const wr=pairs=>({kind:'control',rt:0x40,request:4,value:0x83,index:0,data:pairs.flat()});
    const mk=(over,extra=[])=>({steps:15210,maxSteps:16000,maxMs:8000,ops:[wr([[0x01,2],[0x02,0x90],[0x3D,0],[0x3E,0x3B],[0x3F,0x6A],...extra]),wr([[0x0F,1]])],...over});
    assert.throws(()=>Motion.checkForwardPlan(mk({steps:40000,ops:[wr([[0x01,2],[0x02,0x90],[0x3D,0],[0x3E,0x9C],[0x3F,0x40],[0x0F,1]])]})),/exceeds the cap/);
    assert.throws(()=>Motion.checkForwardPlan(mk({ops:[wr([[0x01,2],[0x02,0x94],[0x3D,0],[0x3E,0x3B],[0x3F,0x6A],[0x0F,1]])]})),/in reverse/);
    assert.throws(()=>Motion.checkForwardPlan(mk({ops:[wr([[0x01,3],[0x02,0x90],[0x3D,0],[0x3E,0x3B],[0x3F,0x6A],[0x0F,1]])]})),/starts a scan/);
    assert.throws(()=>Motion.checkForwardPlan(mk({steps:15000})),/not the recorded 15000/);
    assert.throws(()=>Motion.checkForwardPlan({ops:[wr([[0x02,0x90]])],steps:1}),/never starts/);
    const c2=carriage(0); const g2=Gl845.create(c2.dev,{sleep:async ms=>c2.hooks.sleep(ms)});
    await assert.rejects(()=>Motion.runForward({send:g2.send,status:g2.status},fwd,[],c2.hooks),/no stop sequence/);
    assert.equal(c2.usb.length,0,'a refused plan sends nothing');
    const busy=carriage(20000,{moving:1}); const gb=Gl845.create(busy.dev,{sleep:async ms=>busy.hooks.sleep(ms)});
    await assert.rejects(()=>Motion.runForward({send:gb.send,status:gb.status},fwd,plan.stop,busy.hooks),/already moving/);
    // a motor that does not finish in time is stopped, and the failure is reported
    const slow=carriage(0,{stepsPerSec:200}); const gs=Gl845.create(slow.dev,{sleep:async ms=>slow.hooks.sleep(ms)});
    await assert.rejects(()=>Motion.runForward({send:gs.send,status:gs.status},{...fwd,maxMs:3000},plan.stop,slow.hooks),/did not finish.*stop sequence was sent/);
    assert(!slow.moving&&slow.pos<2000,'the slow motor was stopped near where it was ('+slow.pos+')'); }
  // the recorded preview pass: boot, forward move, 944-line scan read in 65024-byte chunks, then home
  { const pv=plan.preview; assert.equal(pv.bytes,7363200); assert.equal(pv.pixels*pv.lines*6,pv.bytes);
    const c=carriage(0), g=Gl845.create(c.dev,{sleep:async ms=>c.hooks.sleep(ms)}), io={send:g.send,status:g.status};
    await g.boot(plan); await Motion.runForward(io,plan.forward,plan.stop,c.hooks);
    let last=0; const r=await Gl845.runScan(g,pv,plan.stop,{...c.hooks,progress:got=>{ last=got; }});
    assert.equal(r.data.length,7363200); assert.equal(last,7363200); assert(!(r.status&1),'motor stopped after the pass');
    assert.deepEqual(c.violations,[],c.violations.join('; '));
    const reads=c.usb.filter(u=>u.dir==='bulkin'); assert.equal(reads.length,114); assert.equal(reads[0].len,65024); assert.equal(reads.at(-1).len,15488);
    const heads=c.usb.filter(u=>u.dir==='out'&&u.value===0x82&&u.index===0&&u.data.length===8); assert.equal(heads.length,114);
    assert.deepEqual(heads[0].data,[0,0,0,16,0,254,0,0]); assert.deepEqual(heads.at(-1).data,[0,0,0,16,0x80,0x3c,0,0]);   // 65024 and 15488, as in the capture
    assert.equal(r.data[2],((2>>1)*7+0)&255,'data comes through unmodified');
    const s2=await Motion.createRecordedHome(io,plan,c.hooks).home(); assert(s2&8&&!c.hitEnd&&c.pos<=0&&c.pos>=-60,'homed after the pass: '+c.pos);
    console.log(`preview pass: ${r.data.length} bytes in ${reads.length} chunks, no violations, homed after at ${c.pos}`);
    // refusals before anything is sent
    const bad=(over)=>({...pv,...over});
    assert(pv.after.length>=1&&JSON.stringify(pv.after).includes('"data":[1,2'),'the recorded plan clears the SCAN bit after the pass');
    assert.throws(()=>Gl845.checkScanPlan(bad({after:[]})),/no post-scan write/);
    assert.throws(()=>Gl845.checkScanPlan(bad({bytes:1000})),/do not match/);
    assert.throws(()=>Gl845.checkScanPlan(bad({lines:30000,bytes:pv.pixels*30000*6})),/exceeds the cap/);
    assert.throws(()=>Gl845.checkScanPlan(bad({chunk:70000})),/bad chunk/);
    assert.throws(()=>Gl845.checkScanPlan(bad({ops:pv.ops.slice(0,-1)})),/never starts/);
    const rev=JSON.parse(JSON.stringify(pv)); for(const o of rev.ops)if(o.kind==='control'&&o.value===0x83)for(let k=0;k<o.data.length;k+=2)if(o.data[k]===2)o.data[k+1]|=4;
    assert.throws(()=>Gl845.checkScanPlan(rev),/in reverse/);
    const c3=carriage(0), g3=Gl845.create(c3.dev,{sleep:async ms=>c3.hooks.sleep(ms)});
    await assert.rejects(()=>Gl845.runScan(g3,pv,[],c3.hooks),/no stop sequence/); assert.equal(c3.usb.length,0);
    const busy=carriage(5000,{moving:1}), gb=Gl845.create(busy.dev,{sleep:async ms=>busy.hooks.sleep(ms)});
    await assert.rejects(()=>Gl845.runScan(gb,pv,plan.stop,busy.hooks),/already moving/);
    // a device that cannot read bulk data is refused before ANY operation is sent (this once started a real scan)
    { const c5=carriage(0), d5={controlTransferIn:c5.dev.controlTransferIn,controlTransferOut:c5.dev.controlTransferOut,transferOut:c5.dev.transferOut};
      const g5=Gl845.create(d5,{sleep:async ms=>c5.hooks.sleep(ms)}); assert.equal(g5.hasBulkIn,false);
      await assert.rejects(()=>Gl845.runScan(g5,pv,plan.stop,c5.hooks),/cannot read bulk data \(nothing was sent\)/);
      assert.equal(c5.usb.length,0,'nothing may be sent to a device that cannot complete the scan'); }
    // a read failure in the middle: the stop is sent and the failure is reported
    const c4=carriage(0), d4=c4.dev, orig=d4.transferIn; let n=0; d4.transferIn=async(ep,len)=>(++n===5?{status:'stall'}:orig(ep,len));
    const g4=Gl845.create(d4,{sleep:async ms=>c4.hooks.sleep(ms)});
    await g4.boot(plan); await Motion.runForward({send:g4.send,status:g4.status},plan.forward,plan.stop,c4.hooks);
    await assert.rejects(()=>Gl845.runScan(g4,pv,plan.stop,c4.hooks),/stop sequence was sent/);
    assert(c4.usb.some(u=>u.dir==='out'&&u.data.join()==='1,34,2,56,61,0,62,0,63,1'),'the stop sequence was sent after the failed read'); }
  // the page-level preview: forward move, pass, home; the result must work with the page's existing preview code
  { require(path.join(__dirname,'..','capture_runtime.js'));
    const c=carriage(0), g=Gl845.create(c.dev,{sleep:async ms=>c.hooks.sleep(ms)});
    await g.boot(plan); let seen=0;
    const r=await Gl845.preview(g,plan,{...c.hooks,progress:got=>{ seen=got; }});
    assert.equal(r.bytes.length,7363200); assert.equal(seen,7363200); assert(c.pos<=0&&c.pos>=-60&&!c.hitEnd,'homed after the preview: '+c.pos);
    assert.deepEqual(c.violations,[],c.violations.join('; '));
    const p=r.profile, f=p.frames[p.mainFrame];
    assert.equal(f.pixels*f.lines*6,f.bytes); assert.equal(p.dpi,900);
    const al=CaptureRuntime.measureShifts(r.bytes,p), gm=CaptureRuntime.geometry(p,al.shifts);
    assert.equal(al.shifts.length,3); assert(gm.pixels===1300&&gm.lines>900&&gm.lines<=944,'geometry '+gm.lines);
    const pv=CaptureRuntime.previewPlanes(r.bytes,gm,1200,null,true); assert(pv.planes.length===3&&pv.g.pixels>0);
    const lp=CaptureRuntime.livePreview(p,{maxWidth:1000,mirror:true}); assert.equal(lp.update(r.bytes,r.bytes.length)>0,true);
    // starting away from home: it homes first
    const c2=carriage(30000), g2=Gl845.create(c2.dev,{sleep:async ms=>c2.hooks.sleep(ms)}); await g2.boot(plan);
    await Gl845.preview(g2,plan,c2.hooks); assert(c2.pos<=0&&c2.pos>=-60&&!c2.hitEnd&&c2.violations.length===0,'from 30000: '+c2.pos);
    console.log(`page-level preview: ${r.bytes.length} bytes, geometry ${gm.pixels}x${gm.lines}, measured shifts ${JSON.stringify(al.shifts)}, homed first from 30000 too`); }
  // chained preview: step back instead of home; the next one needs the carriage off the sensor and idle
  { const c=carriage(0), g=Gl845.create(c.dev,{sleep:async ms=>c.hooks.sleep(ms)}); await g.boot(plan);
    await assert.rejects(()=>Gl845.preview(g,plan,{...c.hooks,fromFrame:true}),/at home, not at the frame start/); assert(!c.moving,'refused before anything moved');
    const r1=await Gl845.preview(g,plan,{...c.hooks,keep:true}); assert.equal(r1.atFrame,true); assert(c.pos>14000&&c.pos<16000,'stepped back to the frame start '+c.pos);
    const p0=c.pos, r2=await Gl845.preview(g,plan,{...c.hooks,keep:true,fromFrame:true}); assert.equal(r2.bytes.length,7363200); assert(Math.abs(c.pos-p0)<=200&&!c.hitEnd,'chained pass stays at the frame start: '+p0+' -> '+c.pos);
    assert.deepEqual(c.violations,[],c.violations.join('; ')); }
  // the full scan: forward move, discarded preview pass, bounded reverse step, 3600 ppi main pass, home. The sensor must
  // never be passed forward, the bulk protocol must hold, and the main pass must start where the vendor's did
  // (the scan moves 2400/DPISET steps per line: 944 x 16 = 15104 for the preview, so 15210 + 15104 - 15202 = 15112 steps from home, the same film edge the preview started at).
  { assert.equal(plan.main.bytes,117811200); assert.equal(plan.main.pixels,5200); assert.equal(plan.main.lines,3776); assert.equal(plan.back.reverse,true); assert.equal(plan.back.steps,15202);
    const c=carriage(0), g=Gl845.create(c.dev,{sleep:async ms=>c.hooks.sleep(ms)});
    await g.boot(plan); let seen=0, scanStart=null;
    const r=await Gl845.scanFull(g,plan,{...c.hooks,progress:got=>{ if(!seen)scanStart=c.pos; seen=got; }});
    assert.equal(r.bytes.length,117811200); assert.equal(r.preview.length,7363200); assert.equal(seen,117811200); assert(c.pos<=0&&c.pos>=-60&&!c.hitEnd,'homed after the full scan: '+c.pos);
    assert(Math.abs(scanStart-15112)<=70,'main pass started at '+scanStart);
    assert.deepEqual(c.violations,[],c.violations.join('; '));
    assert.equal(r.profile.frames[0].pixels*r.profile.frames[0].lines*6,r.profile.frames[0].bytes); assert.equal(r.profile.dpi,3600);
    assert.throws(()=>Motion.checkForwardPlan({...plan.back,reverse:false}),/in reverse/); assert.throws(()=>Motion.checkForwardPlan({...plan.forward,reverse:true}),/is forward/);
    // a failure in the main pass sends the stop and throws; a plan without its back step is refused before anything moves
    const c2=carriage(0), g2=Gl845.create(c2.dev,{sleep:async ms=>c2.hooks.sleep(ms)}); await g2.boot(plan); const n0=c2.usb.length;
    await assert.rejects(()=>Gl845.scanFull(g2,{...plan,back:undefined},c2.hooks),/no recorded plan for main/); assert.equal(c2.usb.length,n0,'nothing sent');
    console.log(`full scan: ${r.bytes.length} bytes, main pass began ${scanStart} steps from home (the preview's own start, 15210), homed again, 0 protocol violations`); }
  // a cancel mid-scan. The real chip does NOT abort a scan on the stop sequence (hardware, 2026-11-09), so the rest of the pass is read and
  // discarded, the page's own Cancelled error is rethrown unchanged (so the page says "Stopped" and parks the carriage), and the cleanup writes
  // are sent, so the next table upload (bulk write) does not hang. The simulator models that chip: the scan runs to its end whatever is written.
  { class Cancelled extends Error{}
    const c=carriage(0), g=Gl845.create(c.dev,{sleep:async ms=>c.hooks.sleep(ms)}); await g.boot(plan); let chunks=0, cancel=false; const logs=[];
    await Motion.runForward({send:g.send,status:g.status},plan.forward,plan.stop,c.hooks);
    const hooks={...c.hooks,log:m=>logs.push(m),check:()=>{ if(cancel)throw new Cancelled('cancelled'); },progress:()=>{ if(++chunks===30)cancel=true; }};
    const err=await Gl845.runScan(g,plan.preview,plan.stop,hooks).then(()=>null,e=>e);
    assert(err instanceof Cancelled,'the cancel is rethrown unchanged: '+err); assert(logs.some(m=>/cannot abort a scan/.test(m)),'the user is told why Stop takes a while: '+logs);
    assert.equal(c.scan.read,plan.preview.bytes,'the whole pass was drained'); assert(!c.moving,'the scan is over and the carriage idle');
    const sent=c.usb.filter(u=>u.dir==='out'&&u.value===0x83).map(u=>u.data.join()); assert.equal(sent.at(-1),'108,255','the cleanup was sent last'); assert(!sent.includes('1,34,2,56,61,0,62,0,63,1'),'no stop sequence is needed after a drained scan');
    const mid=c.pos, m=Motion.createRecordedHome({send:g.send,status:g.status},plan,c.hooks); await m.home();   // its table uploads must not hang
    assert(c.pos<=0&&c.pos>=-60&&!c.hitEnd&&c.violations.length===0,'homed after the cancelled scan, from '+Math.round(mid)+': '+c.pos+' '+c.violations.join('; '));
    // a cancel before the scan has started sends nothing and starts nothing
    const c2=carriage(0), g2=Gl845.create(c2.dev,{sleep:async ms=>c2.hooks.sleep(ms)}); await g2.boot(plan); const n0=c2.usb.length; let first=true;
    const e2=await Gl845.runScan(g2,plan.preview,plan.stop,{...c2.hooks,check:()=>{ if(!first)throw new Cancelled('cancelled'); first=false; }}).then(()=>null,e=>e);
    assert(e2 instanceof Cancelled&&!c2.moving&&c2.scan===null,'a cancel before the scan starts leaves the chip idle'); assert(c2.usb.slice(n0).every(u=>u.dir!=='bulkin'),'nothing was read');
    console.log(`cancel mid-scan: pass drained (${plan.preview.bytes} bytes), Cancelled rethrown, cleanup sent, carriage idle, homed afterwards`); }
  // no scan may travel further than a frame: every recorded pass is within the limit, a longer one is refused before anything is sent
  { for(const k of ['preview','main','main31920','main1800','main7200'])Gl845.checkScanPlan(plan[k]);
    const longer=JSON.parse(JSON.stringify(plan.preview)); longer.lines=1100; longer.bytes=longer.pixels*longer.lines*6;   // 1100 lines x 16 steps = 17 600
    assert.throws(()=>Gl845.checkScanPlan(longer),/more than a frame/);
    const c=carriage(0), g=Gl845.create(c.dev,{sleep:async ms=>c.hooks.sleep(ms)}); await g.boot(plan); const n0=c.usb.length;
    await assert.rejects(()=>Gl845.runScan(g,longer,plan.stop,c.hooks),/more than a frame/); assert.equal(c.usb.length,n0,'nothing was sent'); }
  // the 1800 ppi pass: a complete frame, recorded as is; starts where the other full-frame passes do, travels the same distance, homes after
  { const m=plan.main1800; Gl845.checkScanPlan(m); const gm=Gl845.scanGeometry(m);
    assert.deepEqual([m.pixels,m.lines,m.bytes,m.dpi],[2592,1889,29377728,1800]); assert.deepEqual([gm.str,gm.end,gm.dpiset],[24,10392,300]); assert(!m.derived,'used exactly as recorded');
    const c=carriage(0), g=Gl845.create(c.dev,{sleep:async ms=>c.hooks.sleep(ms)}); await g.boot(plan); let first=null;
    const r=await Gl845.scanFull(g,plan,{...c.hooks,which:'main1800',progress:()=>{ if(first===null)first=c.pos; }});
    assert.equal(r.bytes.length,29377728); assert(Math.abs(first-15112)<=70,'1800 pass starts where the others do: '+first); assert(c.pos<=0&&c.pos>=-60&&!c.hitEnd&&c.violations.length===0,'homed: '+c.pos);
    assert.equal(Gl845.fullProfile(m).shifts[2],12); console.log('1800 ppi: '+r.bytes.length+' bytes through the simulated scanner, started at '+first+', homed, 0 protocol violations'); }
  // the 3600 ppi pass at the slide / short multi-exposure exposure (line period 31920): the 42560 plan with the exposure, four motor-timing registers
  // and three short scan-speed tables changed (as recorded), same window and pre-roll so the two multi-exposure passes line up
  { const m=plan.main31920, ref=plan.main; Gl845.checkScanPlan(m); assert.deepEqual([m.pixels,m.lines,m.bytes],[ref.pixels,ref.lines,ref.bytes]); assert.equal(m.lineMs,12.768); assert.equal(ref.lineMs,17.024);
    const regs=p=>{ const r={}; for(const o of p.ops)if(o.kind==='control'&&o.value===0x83)for(let k=0;k<o.data.length;k+=2)r[o.data[k]]=o.data[k+1]; return r; }, a=regs(ref), b=regs(m);
    const diff=Object.keys({...a,...b}).filter(k=>a[k]!==b[k]).map(Number).sort((x,y)=>x-y); assert.deepEqual(diff,[0x38,0x39,0x61,0x62,0x64,0x65],'only the line period and the motor timing differ: '+diff.map(x=>x.toString(16)));
    const ta=ref.ops.filter(o=>o.kind==='write').map(o=>o.data), tb=m.ops.filter(o=>o.kind==='write').map(o=>o.data);
    assert.equal(ta.length,5); assert.equal(tb.length,5); assert.equal(ta.filter((x,i)=>x===tb[i]).length,2,'the two long motor tables are unchanged; the three short scan-speed tables carry the new cruise speed');
    const c=carriage(0), g=Gl845.create(c.dev,{sleep:async ms=>c.hooks.sleep(ms)}); await g.boot(plan);
    const r=await Gl845.scanFull(g,plan,{...c.hooks,which:'main31920'}); assert.equal(r.bytes.length,ref.bytes); assert(c.pos<=0&&c.pos>=-60&&!c.hitEnd&&c.violations.length===0,'homed: '+c.pos+' '+c.violations.join('; '));
    console.log('3600 ppi slide exposure (31920): same plan as 42560 but exposure, motor timing and the three short scan-speed tables; runs and homes on the simulator'); }
  // the 7200 ppi pass: the recorded crop widened to the full window; consistent registers, same start as the 3600 pass, bounded travel, homes after
  { const m7=plan.main7200; Gl845.checkScanPlan(m7); const gm7=Gl845.scanGeometry(m7), gm3=Gl845.scanGeometry(plan.main);
    assert.deepEqual([m7.pixels,m7.lines,m7.bytes,m7.dpi],[10400,7552,471244800,7200]); assert.deepEqual([gm7.str,gm7.end,gm7.dpiset],[38,10438,1200]); assert.equal(gm7.str,gm3.str,'same first pixel as the 3600 ppi pass');
    assert.equal(m7.lines,plan.main.lines*2,'twice the lines of the 3600 ppi pass (same film length)'); assert(m7.derived&&/rewritten/.test(m7.derived.note));
    assert.throws(()=>Gl845.scanGeometry({...m7,pixels:10000}),/geometry mismatch/);
    // a plan whose 0x36/0x37 disagrees with its pixel count is refused
    const bad=JSON.parse(JSON.stringify(m7)); for(const o of bad.ops)if(o.kind==='control'&&o.value===0x83)for(let k=0;k<o.data.length;k+=2)if(o.data[k]===0x37)o.data[k+1]^=1;
    assert.throws(()=>Gl845.scanGeometry(bad),/0x36\/0x37/);
    assert.equal(Gl845.fullProfile(m7).shifts[2],48,'colour lines are twice as far apart in 7200 ppi lines');
    const c=carriage(0), g=Gl845.create(c.dev,{sleep:async ms=>c.hooks.sleep(ms)}); await g.boot(plan); let first=null;
    const t0=Date.now(), r=await Gl845.scanFull(g,plan,{...c.hooks,which:'main7200',progress:got=>{ if(first===null)first=c.pos; }});
    assert.equal(r.bytes.length,471244800); assert(c.pos<=0&&c.pos>=-60&&!c.hitEnd,'homed after the 7200 scan: '+c.pos); assert.deepEqual(c.violations,[],c.violations.join('; '));
    assert(Math.abs(first-15112)<=70,'7200 pass starts where the 3600 pass does: '+first);
    await assert.rejects(()=>Gl845.scanFull(g,{...plan,main7200:undefined},{...c.hooks,which:'main7200'}),/no recorded plan for main7200/);
    console.log(`7200 ppi: ${r.bytes.length} bytes through the simulated scanner in ${((Date.now()-t0)/1000).toFixed(0)} s, started at ${first}, homed, 0 protocol violations`); }
  assert.equal(plan.stopVerified,'moves');
  console.log('gl845: read/write framing, operation replay, real boot and home plans OK on the simulated carriage');
})().catch(e=>{console.error(e);process.exit(1);});
