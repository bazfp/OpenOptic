// Homing on a simulated carriage: position in motor steps, home sensor active at pos <= 0,
// mechanical stops, motion timed from the uploaded slope table (0.4 us units, acceleration
// through the first 0x6A entries, symmetric deceleration), a stop request decelerates over up
// to 32 steps, MOTORENB clears 80 ms after motion ends, every USB transfer costs 1.5 ms.
const assert=require('node:assert/strict'),path=require('node:path');
for(const f of ['capture_profiles.js','motion.js'])require(path.join(__dirname,'..',f));
const REC=Motion.recorded(CAPTURE_PROFILES.full);

function carriage(pos,{running=false,sensor=true}={}){
  const regs={0x01:0x22,0x02:0x08},tables={};let clock=0,mv=null,enbUntil=0,feedDone=true,maxRate=0,lastDir=0,violations=[];
  const period=(t,k,n,left)=>t[Math.min(k,left,n-1)]*0.4e-3;               // ms per step
  function advance(ms){
    const end=clock+ms;
    while(mv&&mv.next<=end){
      clock=mv.next; pos=Math.max(-400,Math.min(70000,pos+mv.dir)); mv.done++;
      if(mv.done>=mv.total){ feedDone=true; enbUntil=clock+80; lastDir=mv.dir; mv=null; break; }
      const p=period(mv.table,mv.done,mv.n,mv.total-mv.done); maxRate=Math.max(maxRate,1000/p); mv.next=clock+p;
    }
    clock=Math.max(clock,end);
  }
  function start(){
    if(mv||clock<enbUntil)violations.push('motor started while still running');
    const feedl=((regs[0x3D]&0x0F)<<16)|(regs[0x3E]<<8)|regs[0x3F], t=tables[3];
    mv={dir:(regs[0x02]&0x04)?-1:1,total:feedl,done:0,table:t,n:Math.min(regs[0x6A]===0xFF?t.length:regs[0x6A],t.length),next:clock+t[0]*0.4e-3};
    feedDone=false;
  }
  function requestStop(){ if(mv){ const lvl=Math.min(mv.done,mv.n-1); mv.total=Math.min(mv.total,mv.done+Math.min(32,lvl+1)); } }
  const status=()=>0x80|0x40|0x10|((sensor&&pos<=0)?0x08:0)|((mv||clock<enbUntil)?0x01:0)|(feedDone?0x20:0);
  const io={
    async writeRegs(pairs){ advance(1.5);
      for(const [r,v] of pairs){
        if(mv&&[0x3D,0x3E,0x3F,0x6A,0x1C].includes(r)&&!(r===0x3F&&v===1)&&!(regs[0x02]===0x08))violations.push(`register 0x${r.toString(16)} changed while moving`);
        regs[r]=v;
        if(r===0x0F&&v===1)start();
        if((r===0x02&&!(v&0x10))||(r===0x3F&&v===1&&regs[0x3E]===0&&regs[0x3D]===0))requestStop();
      } },
    async status(){ advance(4.5); return status(); },
    async upload(slot,t){ advance(12); if(mv)violations.push('table uploaded while moving'); tables[slot]=t; }
  };
  const hooks={sleep:async ms=>advance(ms),now:()=>clock};
  if(running){ tables[3]=REC.fast; regs[0x01]=0x23; regs[0x02]=0x18; regs[0x6A]=0xFF; regs[0x3D]=0; regs[0x3E]=0xEA; regs[0x3F]=0x60; start(); advance(2000); }
  return {io,hooks,get pos(){return pos;},get time(){return clock;},get maxRate(){return maxRate;},get lastDir(){return lastDir;},violations};
}

(async()=>{
  const cases=[['at the sensor edge',0],['deep in the home zone',-300],['far out (45000 steps)',45000],
    ['just outside the sensor',5],['still running a feed, SCAN on',20000,{running:true}]];
  const parks=[];
  for(const [name,p0,opt] of cases){
    const c=carriage(p0,opt), m=Motion.create(c.io,REC,c.hooks);
    const t0=c.time; const s=await m.home();
    assert(s&0x08,'HOME set at the end'); assert.deepEqual(c.violations,[],name+': '+c.violations.join('; '));
    assert(c.maxRate<=4000*1.01,`${name}: moved at ${c.maxRate.toFixed(0)} steps/s, above the recorded fast table (4000)`);
    assert.equal(c.lastDir,-1,'final approach must be in reverse, like the automatic return');
    parks.push(c.pos);
    console.log(`${name.padEnd(32)} parked at ${String(c.pos).padStart(4)} steps (sensor edge 0) in ${((c.time-t0)/1000).toFixed(1)} s, max ${c.maxRate.toFixed(0)} steps/s`);
  }
  const spread=Math.max(...parks)-Math.min(...parks);
  assert(parks.every(p=>p<=0&&p>=-60),'park within 60 steps (0.1 mm) inside the sensor edge: '+parks);
  assert(spread<=10,'park must not depend on where the carriage started: spread '+spread);
  console.log(`park position spread across all starting states: ${spread} steps (${(spread/14400*25.4).toFixed(3)} mm)`);
  // a dead sensor must fail safely: error, motor stopped
  const c=carriage(45000,{sensor:false}), m=Motion.create(c.io,REC,c.hooks);
  await assert.rejects(()=>m.home(),/home sensor not found/);
  assert(!(await c.io.status()&0x01),'motor stopped after the failure');
  console.log('sensor never trips: homing fails with an error and the motor is stopped');
})().catch(e=>{console.error(e);process.exit(1);});
