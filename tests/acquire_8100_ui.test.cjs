// The page's OpticFilm 8100 acquisition (acquire8100 in ui.html), run without a browser against the simulated carriage:
// it must return what the shared preview code expects, keep the page state right, and refuse everything but the preview and the 3600 dpi pass.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
for(const f of ['capture_runtime.js','motion.js','gl845.js','home_plans.js','shading.js','shading_8100.js'])require(path.join(__dirname,'..',f));
const {carriage}=require('./helpers/carriage845.cjs');
const html=fs.readFileSync(path.join(__dirname,'../ui.html'),'utf8');
const code=html.slice(html.indexOf('async function acquire8100('),html.indexOf('async function acquire(key'));
assert(code.includes('Gl845.scanFull')&&code.includes('Gl845.preview'),'sliced the right function');

(async()=>{
  const c=carriage(0), gl=Gl845.create(c.dev,{sleep:async ms=>c.hooks.sleep(ms)}); await gl.boot(HOME_PLANS['8100']);
  const calls={live:0,progress:[],say:[],lampOff:0,stop:0,arm:0};
  const ctx={gl,Gl845,HOME_PLANS,dry:false,live:null,trace:[],traceMark:0,positionKnown:true,lampOnAt:100,
    checkCancel:()=>{},sleep:async ms=>c.hooks.sleep(ms),performance:{now:()=>c.hooks.now()},log:()=>{},console:{warn:()=>{}},
    say:m=>calls.say.push(m),progress:f=>calls.progress.push(f),setLamp:()=>{},
    liveStart:()=>{ calls.live++; ctx.live={lp:{update:()=>0}}; },liveDraw:()=>{},
    atFrame:false,previewChain:0,idleHomeTimer:null,MAX_PREVIEW_CHAIN:4,fmtSecs:s=>Math.round(s)+" s",armIdleHome:()=>{ calls.arm++; },clearTimeout:()=>{},Shading,SHADING_8100,lampSet:async on=>{ if(!on)calls.lampOff++; ctx.lampOnAt=on?1:null; },stopMotor:async()=>{ calls.stop++; },Motion,CaptureRuntime};
  vm.createContext(ctx); vm.runInContext(code,ctx);
  const r=await vm.runInContext("acquire8100('prescan',{keepLamp:true},{})",ctx);
  assert.equal(r.bytes.length,7363200); assert.equal(r.profile.dpi,900); assert.equal(r.calibrated,false); assert(/flat-field/.test(r.calibrationNote),'the result says what was done to it'); assert.deepEqual(r.lamp.dark.mean,SHADING_8100.dark,'the dark level goes to the multi-exposure merge'); assert(r.lamp.dark.noise.tvar.length===3&&r.lamp.shading.noise.mean.length===3,'noise statistics for the merge');
  assert.equal(ctx.atFrame,true,'the preview leaves the carriage at the frame start'); assert.equal(ctx.positionKnown,false); assert.equal(calls.arm,1,'idle homing armed'); assert(Math.abs(c.pos-15112)<=70&&!c.hitEnd,'stepped back to the frame start: '+c.pos);
  assert.equal(calls.live,1,'live preview started once'); assert(calls.progress.some(f=>f>0.99)&&calls.progress.at(-1)===0,'progress ran to 100 % and was cleared');
  assert.equal(calls.lampOff,0,'keepLamp leaves the lamp on'); assert.deepEqual(c.violations,[]);
  // keepLamp off switches it off with the 8100's value (via lampSet)
  const c2=carriage(0), gl2=Gl845.create(c2.dev,{sleep:async ms=>c2.hooks.sleep(ms)}); await gl2.boot(HOME_PLANS['8100']);
  Object.assign(ctx,{gl:gl2,sleep:async ms=>c2.hooks.sleep(ms),performance:{now:()=>c2.hooks.now()},atFrame:false,previewChain:0});
  await vm.runInContext("acquire8100('prescan',{keepLamp:false},{})",ctx); assert.equal(calls.lampOff,1);
  // chained previews: the first moves forward, scans and steps back; the next ones only scan and step back; the fifth homes first
  { const starts=u=>u.filter(x=>x.dir==='out'&&x.value===0x83&&x.data.some((v,i)=>i%2===0&&v===0x0F&&x.data[i+1]===1)).length;
    const cc=carriage(0), g=Gl845.create(cc.dev,{sleep:async ms=>cc.hooks.sleep(ms)}); await g.boot(HOME_PLANS['8100']);
    Object.assign(ctx,{gl:g,dry:false,sleep:async ms=>cc.hooks.sleep(ms),performance:{now:()=>cc.hooks.now()},lampOnAt:100,positionKnown:true,atFrame:false,previewChain:0}); calls.arm=0;
    const seen=[];
    for(let i=1;i<=5;i++){ const n0=starts(cc.usb); await vm.runInContext("acquire8100('prescan',{keepLamp:true},{})",ctx); seen.push([starts(cc.usb)-n0,ctx.previewChain,Math.round(cc.pos)]); }
    assert.deepEqual(seen.map(x=>x[0]),[3,2,2,2,4],'moves per preview: forward+scan+back, then scan+back x3, then home+forward+scan+back: '+JSON.stringify(seen));
    assert.deepEqual(seen.map(x=>x[1]),[1,2,3,4,1],'chain counter'); assert(!cc.hitEnd&&cc.violations.length===0,cc.violations.join('; '));
    // a full scan from the frame start homes first and ends homed; the page state follows
    await vm.runInContext("acquire8100('full',{keepLamp:true},{})",ctx);
    assert.equal(ctx.atFrame,false); assert.equal(ctx.positionKnown,true); assert(cc.pos<=0&&cc.pos>=-60,'full scan from the frame start ends at home: '+cc.pos);
    console.log('chained previews: moves per preview '+JSON.stringify(seen.map(x=>x[0]))+', re-home on the 5th, full scan homes first'); }
  // the full 3600 dpi pass: same result shape, geometry and state handling
  { const cf=carriage(0), glf=Gl845.create(cf.dev,{sleep:async ms=>cf.hooks.sleep(ms)}); await glf.boot(HOME_PLANS['8100']); calls.live=0; calls.progress=[];
    Object.assign(ctx,{gl:glf,dry:false,sleep:async ms=>cf.hooks.sleep(ms),performance:{now:()=>cf.hooks.now()},lampOnAt:100,positionKnown:true,atFrame:false,previewChain:0});
    const f=await vm.runInContext("acquire8100('full',{keepLamp:true},{})",ctx);
    assert.equal(f.bytes.length,117811200); assert.equal(f.profile.dpi,3600); assert.deepEqual(f.profile.shifts,[0,12,24]); assert.equal(f.calibrated,false);
    assert.equal(ctx.positionKnown,true); assert(cf.pos<=0&&cf.pos>=-60&&!cf.hitEnd,'homed after the full scan: '+cf.pos); assert.deepEqual(cf.violations,[]);
    assert.equal(calls.live,1,'live view started once, for the main pass only'); assert(calls.progress.at(-1)===0); }
  // the 1800 dpi pass: a complete frame as the free trial software records it (2592 x 1889 px), same result shape and page state
  { const c1=carriage(0), g1=Gl845.create(c1.dev,{sleep:async ms=>c1.hooks.sleep(ms)}); await g1.boot(HOME_PLANS['8100']);
    Object.assign(ctx,{gl:g1,dry:false,sleep:async ms=>c1.hooks.sleep(ms),performance:{now:()=>c1.hooks.now()},lampOnAt:100,positionKnown:true,atFrame:false,previewChain:0});
    const f=await vm.runInContext("acquire8100('full1800',{keepLamp:true},{})",ctx);
    assert.equal(f.bytes.length,29377728); assert.equal(f.profile.dpi,1800); assert.deepEqual(f.profile.shifts,[0,6,12]); assert.equal(ctx.atFrame,false);
    assert(c1.pos<=0&&c1.pos>=-60&&!c1.hitEnd&&c1.violations.length===0,'homed after the 1800 dpi scan: '+c1.pos+' '+c1.violations.join('; ')); }
  // which 3600 dpi pass runs: negatives 42560 (64.3 s), slides 31920 (48.2 s); multi-exposure: short pass 31920, long pass (factor > 1) 42560
  { const secs=async(req)=>{ const cx=carriage(0), gx=Gl845.create(cx.dev,{sleep:async ms=>cx.hooks.sleep(ms)}); await gx.boot(HOME_PLANS['8100']);
      Object.assign(ctx,{gl:gx,dry:false,sleep:async ms=>cx.hooks.sleep(ms),performance:{now:()=>cx.hooks.now()},lampOnAt:100,positionKnown:true,atFrame:false,previewChain:0});
      ctx.req=req; const r=await vm.runInContext("acquire8100('full',req,{})",ctx); return +r.profile.scan.seconds.toFixed(1); };
    assert.equal(await secs({film:'neg',keepLamp:true}),64.3,'negative: 42560'); assert.equal(await secs({film:'pos',keepLamp:true}),48.2,'slide: 31920');
    assert.equal(await secs({film:'neg',multiExposure:'range',keepLamp:true}),48.2,'multi-exposure short pass: 31920, whatever the film');
    assert.equal(await secs({film:'pos',multiExposure:'range',exposureMultiplier:1.333,keepLamp:true}),64.3,'multi-exposure long pass: 42560');
    console.log('3600 dpi exposure by film and multi-exposure pass: 64.3 s negative, 48.2 s slide, short 48.2 s, long 64.3 s'); }
  // refusals: no 7200 dpi or infrared; no dry run; both leave the hardware alone and use the config-error name
  for(const [expr,re] of [["acquire8100('full-ir',{},{})",/1800, 3600 or 7200 dpi so far/],["(dry=true,acquire8100('prescan',{},{}))",/Dry run is not available/]]){
    const before=c2.usb.length; ctx.dry=false;
    await assert.rejects(()=>vm.runInContext(expr,ctx),e=>re.test(e.message)&&e.name==='ScanConfigurationError');
    assert.equal(c2.usb.length,before,'a refused job sends nothing'); }
  // a failure mid-scan: the motor is stopped (page cleanup) and the lamp state is forgotten
  const c3=carriage(0), d3=c3.dev, orig=d3.transferIn; let n=0; d3.transferIn=async(ep,len)=>(++n===4?{status:'stall'}:orig(ep,len));
  const gl3=Gl845.create(d3,{sleep:async ms=>c3.hooks.sleep(ms)}); await gl3.boot(HOME_PLANS['8100']);
  Object.assign(ctx,{gl:gl3,dry:false,sleep:async ms=>c3.hooks.sleep(ms),performance:{now:()=>c3.hooks.now()},lampOnAt:5,positionKnown:true,atFrame:false,previewChain:0}); calls.stop=0;
  await assert.rejects(()=>vm.runInContext("acquire8100('prescan',{keepLamp:true},{})",ctx),/stop sequence was sent/);
  assert.equal(calls.stop,1,'the page stops the motor after a failed job'); assert.equal(ctx.lampOnAt,null); assert.equal(ctx.positionKnown,false,'the next job homes first');
  console.log('acquire8100: preview and full-scan results, page state, refusals and failure cleanup OK');
})().catch(e=>{console.error(e);process.exit(1);});
