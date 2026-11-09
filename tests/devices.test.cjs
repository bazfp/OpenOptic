// Device table: only the 7600i v1 is driven; every other known revision is recognised and refused with
// an explanation, and unknown devices are refused. A refusal must never claim commands were sent.
const assert=require('node:assert/strict'),path=require('node:path');
require(path.join(__dirname,'..','devices.js'));

assert.deepEqual(Devices.check(0x0C3B,0x0400),{ok:true,name:'Plustek OpticFilm 7600i',chip:'GL843',driver:'gl843',experimental:false});
const v2=Devices.check(0x0C3B,0x0605);
assert(!v2.ok&&/7600i v1/.test(v2.message),'7600i v2 keeps its existing refusal wording: '+v2.message);
assert.deepEqual(Devices.check(0x130C,0x0605),{ok:true,name:'Plustek OpticFilm 8100',chip:'GL845',driver:'gl845',experimental:true},'the 8100 is driven, experimental');
const old=Devices.check(0x0C3B,0x0605); assert(/No motor or lamp commands were sent/.test(old.message));
assert(!Devices.check(0x130C,0x0400).ok,'an 8100 with another revision is refused');
assert(!Devices.check(0x1234,0x0400).ok&&/Unknown scanner/.test(Devices.check(0x1234,0x0400).message));
for(const pid of Devices.PIDS)for(const bcd of Object.keys(Devices.DEVICES[pid].revisions).map(Number)){
  const r=Devices.check(pid,bcd); assert.equal(r.ok,Devices.DEVICES[pid].revisions[bcd].supported===true);
}
assert.deepEqual(Devices.PIDS,[0x0C3B,0x130C]);
console.log('devices: 7600i v1 supported; 8100 supported (experimental); 7600i v2 recognised and refused; unknown refused');
