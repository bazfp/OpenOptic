// The infrared sequence (from SilverFast's iSRD capture) starts while the vendor's carriage was
// still returning from the colour pass: ~416 recorded status polls with MOTORENB set. Replayed
// literally against a parked carriage that was ~17 s of idling. They collapse to one poll that
// waits only while the motor really runs.
const assert=require('node:assert/strict');
require('../capture_profiles.js');require('../capture_runtime.js');require('../capture_sim.js');
(async()=>{
  const p=CAPTURE_PROFILES['full-ir'], c=CaptureRuntime.collapseRecordedWaits(p.ops), w=c.filter(o=>o.waitMotorIdle);
  assert.equal(w.length,1,'one collapsed wait'); assert(w[0].waitMotorIdle>=400,'covers the recorded polls: '+w[0].waitMotorIdle);
  assert.equal(p.ops.length-c.length,(w[0].waitMotorIdle-1)*3,'only the repeated poll triplets are removed');
  for(const k of ['prescan','full','full7200']) assert.equal(CaptureRuntime.collapseRecordedWaits(CAPTURE_PROFILES[k].ops),CAPTURE_PROFILES[k].ops,k+' unchanged');
  // A carriage parked by this app (its own homing, or the chip's return after pass 1) reports 0xDC:
  // FEEDFSH clear. Before the sequence's first move, a recorded FEEDFSH (0xFC) must not be waited for.
  for(const k of ['full-ir','full']){
    const q=CAPTURE_PROFILES[k], sim=CaptureSim.create(q,{}); let started=false, parkedReads=0;
    const io={...sim,async control(op){ const r=await sim.control(op);
      if(op.rt===0x40&&op.value===0x83&&op.data.some((v,j)=>j%2===0&&v===0x0f&&op.data[j+1]===1)) started=true;
      if(!started&&op.rt===0xc0&&op.value===0x84&&op.register===0x41){ parkedReads++; return Uint8Array.of(0xDC); }
      return r; }};
    let clock=0; await CaptureRuntime.run(q,io,{sleep:async ms=>{clock+=ms;},now:()=>clock,timeoutMs:5000});
    console.log(`${k}: parked carriage (status 0xDC, ${parkedReads} reads before the first move) does not stall the sequence`);
  }
  for(const busyPolls of [0,4]){
    const sim=CaptureSim.create(p,{}); let statusPolls=0, left=busyPolls; const logs=[];
    const io={...sim,async control(op){ const r=await sim.control(op);
      if(op.waitMotorIdle){ statusPolls++; if(left>0){ left--; return Uint8Array.of(op.expected[0]|1); } } return r; }};
    let clock=0; await CaptureRuntime.run(p,io,{sleep:async ms=>{clock+=ms;},now:()=>clock,log:m=>logs.push(m)});
    assert.equal(statusPolls,busyPolls+1,`polls: ${statusPolls}`);
    assert(logs.some(m=>/skipped the recorded wait/.test(m)),'logged');
    console.log(`full-ir: recorded ${w[0].waitMotorIdle}-poll wait → ${statusPolls} poll(s) with the motor ${busyPolls?'still running for '+busyPolls+' polls':'parked'}`);
  }
})().catch(e=>{console.error(e);process.exit(1);});
