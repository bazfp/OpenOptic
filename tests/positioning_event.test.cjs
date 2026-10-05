// Move 1 stop: the vendor stops the first positioning move 0.8 ms after the scanner sends 0x08 on
// its interrupt endpoint. With scanner events available, the runtime stops on that event; it
// ignores other values and implausibly early events, falls back to a timer 150 ms after the
// recorded moment if none comes, and keeps the exact recorded timing when events are unavailable.
const assert=require('node:assert/strict');
require('../capture_profiles.js');require('../capture_runtime.js');
async function scan(key,{events,available=true}={}){
  const p=CAPTURE_PROFILES[key]; let clock=0, stopAt=null, startAt=null; const logs=[]; let positioned=null;
  const io={
    async control(op){
      if(op.rt===0x40&&op.value===0x83&&op.data.length>1){
        for(let i=0;i<op.data.length;i+=2){
          if(op.data[i]===0x0f&&op.data[i+1]===1&&stopAt===null)startAt=clock;   // the last start before the first stop is move 1
          if(op.data[i]===0x02&&op.data[i+1]===0x08&&stopAt===null)stopAt=clock;
        }
      }
      return Uint8Array.from(op.expected||[1]);
    },
    async write(){}, async read(n){ return new Uint8Array(n); }};
  const hooks={sleep:async ms=>{clock+=ms;},now:()=>clock,log:m=>logs.push(m),positioned:x=>{positioned=x;},
    events:events?()=>{ const base=clock; let i=0;   // events[k]={at:ms after the start write, value}
      return {available:()=>available,
        async next(ms){ const e=events[i]; if(e&&base+e.at<=clock+ms){ clock=Math.max(clock,base+e.at); i++; return {value:e.value}; } clock+=ms; return null; }}; }:undefined};
  // every motor start gets a cursor with the same schedule; only move 1's stop waits on one
  await CaptureRuntime.run(p,io,hooks);
  return {stop:stopAt-startAt,logs,positioned,recorded:p.ops.find(o=>o.timedStop).ms};
}
(async()=>{
  for(const key of ['prescan','full','full7200']){
    const plain=await scan(key);
    assert(Math.abs(plain.stop-plain.recorded)<25,`${key}: timed stop at ${plain.stop} vs ${plain.recorded}`);
    assert.equal(plain.positioned.source,'timer');
    const ev=await scan(key,{events:[{at:2300,value:0x08}]});
    assert(Math.abs(ev.stop-2300)<=1,`${key}: should stop on the event (${ev.stop})`); assert.equal(ev.positioned.source,'scanner event');
    const late=await scan(key,{events:[{at:2650,value:0x08}]});
    assert(Math.abs(late.stop-2650)<=1,`${key}: a slightly late event still decides (${late.stop})`);
    const noisy=await scan(key,{events:[{at:300,value:0x08},{at:1500,value:0x20},{at:2400,value:0x08}]});
    assert(Math.abs(noisy.stop-2400)<=1,`${key}: early/other events ignored (${noisy.stop})`);
    assert.equal(noisy.logs.filter(l=>/ignored scanner event/.test(l)).length,2);
    const buttons=await scan(key,{events:[{at:2000,value:0x04},{at:2100,value:0x02},{at:2450,value:0x0c}]});
    assert(Math.abs(buttons.stop-2450)<=1,`${key}: button presses ignored, sensor bit with a button still counts (${buttons.stop})`);
    const none=await scan(key,{events:[]});
    assert(Math.abs(none.stop-(none.recorded+150))<=50,`${key}: timer fallback (${none.stop})`); assert.match(none.positioned.source,/timer/);
    const unsupported=await scan(key,{events:[{at:1000,value:0x08}],available:false});
    assert(Math.abs(unsupported.stop-unsupported.recorded)<25,`${key}: unavailable events keep recorded timing`);
    console.log(`${key}: timed ${plain.stop.toFixed(0)} ms (recorded ${plain.recorded}); event at 2300 → ${ev.stop.toFixed(0)}; late 2650 → ${late.stop.toFixed(0)}; early/other ignored → ${noisy.stop.toFixed(0)}; no event → ${none.stop.toFixed(0)}`);
  }
})().catch(e=>{console.error(e);process.exit(1);});
