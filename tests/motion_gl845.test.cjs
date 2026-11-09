// Recorded reverse homing for the OpticFilm 8100 (GL845) on a simulated carriage. Modelled on the
// The free trial software capture: the chip drives in reverse for far more steps than the travel and stops itself at the
// home sensor; 0x41 reads moving (bit 0), stopped, HOME (bit 3). Forward travel has no sensor stop, so the
// test also fails any plan that moves forward, and a dead sensor must end with the motor stopped before
// the mechanical end of travel.
const assert=require('node:assert/strict'),path=require('node:path');
require(path.join(__dirname,'..','motion.js'));

const wr=pairs=>({kind:'control',rt:0x40,request:4,value:0x83,index:0,data:pairs.flat()});
const HOME_PLAN=(maxMs)=>({maxMs,
  ops:[wr([[0x01,0x02],[0x02,0x94],[0x3D,0x02],[0x3E,0x6F],[0x3F,0xFE]]),
       {kind:'control',rt:0x40,request:4,value:0x82,index:1,data:[0,0,0,0x10,2,1,0,0]},{kind:'write',data:'AAAA'},
       wr([[0x0F,1]])],
  stop:[wr([[0x01,0x22]]),wr([[0x02,0x38]]),wr([[0x3D,0],[0x3E,0],[0x3F,1]])]});

const {carriage}=require('./helpers/carriage845.cjs');

(async()=>{
  for(const [name,p0,opt] of [['at the sensor edge',0],['deep in the home zone',-300],['just outside the sensor',5],
      ['far out (31000 steps)',31000],['reverse move already running',20000,{moving:-1}],['forward move running',20000,{moving:1}]]){
    const c=carriage(p0,opt), m=Motion.createRecordedHome(c.io,HOME_PLAN(20000),c.hooks);
    const s=await m.home();
    assert(s&0x08,name+': HOME set at the end'); assert(!(s&0x01),name+': motor stopped');
    assert(!c.hitEnd,name+': hit the end of travel');
    if(p0<=0)assert.equal(c.pos,p0,name+': the free trial software sends no move when the sensor is already on, nor do we (limit: the park position then depends on where it was)');
    else assert(c.pos<=0&&c.pos>=-60,`${name}: parked at ${c.pos}, within 60 steps of the sensor edge`);
    if(!opt?.moving)assert.equal(c.forward,false,name+': the plan must never move forward');
    console.log(`${name.padEnd(32)} parked at ${String(c.pos).padStart(4)} steps`);
  }
  { const c=carriage(0), m=Motion.createRecordedHome(c.io,HOME_PLAN(20000),c.hooks); await m.home();
    assert.equal(c.sent,0,'already at the sensor: nothing may be sent'); }
  { // a dead sensor: homing fails, the motor is stopped, and the carriage never reaches the end of travel
    const c=carriage(31000,{sensor:false}), m=Motion.createRecordedHome(c.io,HOME_PLAN(5000),c.hooks);
    await assert.rejects(()=>m.home(),/did not finish.*stopped/);
    assert(!c.moving&&!(await c.io.status()&1),'motor stopped after the failure'); assert(!c.hitEnd,'dead sensor: reached the end of travel'); }
  // a stopped carriage that is not at the sensor after a plan that did not reach it must fail, not pretend
  { const c=carriage(31000,{sensor:true}), p=HOME_PLAN(20000); p.ops[0]=wr([[0x01,0x02],[0x02,0x94],[0x3D,0],[0x3E,0],[0x3F,100]]);
    const m=Motion.createRecordedHome(c.io,p,c.hooks); await assert.rejects(()=>m.home(),/stopped without reaching/); }
  // plans that could drive forward or never stop are refused before anything is sent
  { const fwd=HOME_PLAN(1000); fwd.ops[0]=wr([[0x01,0x02],[0x02,0x90],[0x3D,0x02],[0x3E,0x6F],[0x3F,0xFE]]);
    assert.throws(()=>Motion.createRecordedHome({},fwd,{}),/not in reverse/);
    const nostop=HOME_PLAN(1000); nostop.stop=[]; assert.throws(()=>Motion.checkHomePlan(nostop),/no stop sequence/);
    assert.throws(()=>Motion.checkHomePlan({ops:[wr([[0x02,0x94]])],stop:[wr([[0x01,0x22]])]}),/never starts/); }
  // the plan extracted from the real the free trial software capture (tools/build_capture_profiles.py, GL845 dialect)
  { const real=JSON.parse(require('node:fs').readFileSync(path.join(__dirname,'fixtures','8100_home_plan.json'),'utf8'));
    assert.equal(real.stopVerified,'moves','the stop is proven on hardware for moves only (stoptest); it does not abort a scan (stopscan)');
    for(const [name,p0] of [['real plan: far out',31000],['real plan: just outside',5]]){
      const c=carriage(p0), m=Motion.createRecordedHome(c.io,real,c.hooks); const s=await m.home();
      assert(s&0x08&&!(s&1)&&!c.hitEnd&&!c.forward&&c.pos<=0&&c.pos>=-60,`${name}: parked at ${c.pos}`);
      console.log(`${name.padEnd(32)} parked at ${String(c.pos).padStart(4)} steps`); }
    const dead=carriage(31000,{sensor:false}), md=Motion.createRecordedHome(dead.io,{...real,maxMs:5000},dead.hooks);
    await assert.rejects(()=>md.home(),/did not finish/); assert(!dead.moving&&!dead.hitEnd,'real plan, dead sensor: stopped before the end of travel'); }
  console.log('dead sensor, short move, forward plan and missing stop are all refused or stopped safely');
})().catch(e=>{console.error(e);process.exit(1);});
