const assert=require('node:assert/strict');
require('../capture_profiles.js');require('../capture_runtime.js');
for(const [name,base] of Object.entries(CAPTURE_PROFILES)){
  const original=JSON.stringify(base);
  assert.equal(CaptureRuntime.prepareProfile(base),base);
  assert.equal(CaptureRuntime.prepareProfile(base,{pixelSampling:'deletion',exposureMultiplier:'1'}),base);
  const p=CaptureRuntime.prepareProfile(base,{pixelSampling:'average'});
  assert.equal(p.ops.length,base.ops.length);
  let count=0;
  p.ops.forEach((op,i)=>{
    const expected=JSON.parse(JSON.stringify(base.ops[i]));
    if(expected.kind==='control'&&expected.rt===0x40&&expected.value===0x83&&expected.data.length>1)
      for(let j=0;j<expected.data.length;j+=2)if(expected.data[j]===3){expected.data[j+1]|=0x40;count++;}
    assert.deepEqual(op,expected,`only AVEENB may change: ${name} op ${i}`);
  });
  assert(count>0);
  for(const [i,f] of p.frames.entries()){
    assert.equal(f.regs[3],base.frames[i].regs[3]|0x40);
    assert.equal(f.bytes,base.frames[i].bytes);
  }
  assert.deepEqual(p.scan,base.scan);
  assert.equal(p.acquisitionOptions.averagingReducesPixels,name!=='full7200');
  assert.equal(JSON.stringify(base),original,'preparation must not mutate recorded profiles');
  for(const exposure of [1.5,0,NaN,Infinity,'bad',''])assert.throws(()=>CaptureRuntime.prepareProfile(base,{exposureMultiplier:exposure}),e=>e.name==='ScanConfigurationError');
  for(const k of [2,3,4]){ const q=CaptureRuntime.prepareProfile(base,{exposureMultiplier:String(k)}), r=q.frames[q.mainFrame].regs;
    assert.equal((r[0x38]<<8)|r[0x39],base.scan.lPeriod*k); assert.equal(r[0x1e]&15,0); assert.equal(r[0x20],0x08);
    assert.equal(q.scan.lineSeconds.toFixed(4),(base.scan.lPeriod*k*0.4e-6).toFixed(4)); assert.equal(q.acquisitionOptions.exposure.multiplier,k); }
  assert.throws(()=>CaptureRuntime.prepareProfile(base,{pixelSampling:'bad'}),/sampling/);
  console.log(name+': defaults unchanged, averaging-only register changes, metadata, immutable source, exposure ×2/×3/×4 transforms passed');
}
