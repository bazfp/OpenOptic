const assert=require('node:assert/strict');
require('../capture_profiles.js');require('../capture_runtime.js');
for(const [key,base] of Object.entries(CAPTURE_PROFILES)){
  const original=JSON.stringify(base);
  for(const dummyLines of ['none','recorded'])for(const exposureMultiplier of [1,3]){
    if(base.dpi===7200&&dummyLines==='none'&&exposureMultiplier===1)continue;   // rejected: 10.98 MB/s stalls
    const double=CaptureRuntime.prepareProfile(base,{dummyLines,exposureMultiplier});
    const p=CaptureRuntime.prepareProfile(base,{dummyLines,exposureMultiplier,singleSampling:true});
    const f=p.frames[p.mainFrame], b=base.frames[base.mainFrame];
    assert.equal(f.lines,Math.floor(b.lines/2));assert.equal(f.bytes,f.lines*f.pixels*6);
    assert.equal(p.yres,p.dpi);assert.deepEqual(p.shifts,base.shifts.map(v=>v/2));
    const lincnt=(f.regs[0x25]<<16)|(f.regs[0x26]<<8)|f.regs[0x27];
    assert.equal(lincnt,f.lines*2);
    assert.equal(p.motorCruise.used,(double.motorCruise?.used||p.motorCruise.recorded)*0.5,
      'twice the steps per delivered line');
    const read=p.ops.findIndex(o=>o.kind==='read'&&o.frame===p.mainFrame);
    assert.equal(p.ops[read].length,f.bytes);
    const header=p.ops.slice(0,read).findLast(o=>o.kind==='control'&&o.rt===0x40&&o.value===0x82);
    assert.equal(Buffer.from(header.data).readUInt32LE(4),f.bytes);
    for(let i=0;i<p.mainFrame;i++)assert.deepEqual(p.frames[i],double.frames[i],'calibration frames unchanged');
    const g=CaptureRuntime.geometry(p);
    assert.equal(g.yMul,1);assert.equal(g.totalBytes,f.bytes);
    if(key==='full7200'){
      assert.deepEqual(g.stagger,[4,0]);
      assert.equal(f.lines,7061);assert.equal(f.bytes,434166768);
    }
    assert(p.acquisitionOptions.singleSampling);
    const planned=p.ops.filter(o=>o.kind==='read'&&o.frame===p.mainFrame).reduce((a,o)=>a+o.length,0);
    assert.equal(planned,f.bytes);
  }
  assert.equal(JSON.stringify(base),original,'recorded profiles remain immutable');
}
console.log('Single sampling: halved row budgets and transfer headers, doubled motor step rate, native dpi, colour delays and stagger across colour/IR/exposure modes and dummy line settings');

require('../capture_sim.js');require('../roll.js');
(async()=>{
  const settings={prefix:'Single_',digits:2,tiff:'aligned',pixels:'off',film:'neg',orientation:1,
    profile:'prescan',singleSampling:true,dummyLines:'none'};
  const p=CaptureRuntime.prepareProfile(CAPTURE_PROFILES.prescan,settings),files=new Map();let clock=1000;
  await Roll.scanFrame({settings,number:1,store:{exists:async()=>[],save:async(name,parts)=>{
    const b=Buffer.from(await new Blob(parts).arrayBuffer());files.set(name,b);return {bytes:b.length};}},
    acquire:async()=>({profile:p,bytes:await CaptureRuntime.run(p,CaptureSim.create(p),
      {now:()=>clock,sleep:async ms=>{clock+=ms;}})}),makePreview:async()=>({})});
  assert(files.has('Single_01.tif'),'single-sampled aligned TIFF must save without in-place averaging');
  const side=JSON.parse(files.get('Single_01.json'));
  assert(side.acquisition.options.singleSampling);
  assert(side.processing.verticalAveraging.includes('1:1'));
  console.log('Single-sampled simulated acquisition saves a TIFF at native dpi and records it');
})().catch(e=>{console.error(e);process.exit(1);});
