// Optional brightness/contrast add-on: neutral is a no-op, brightness shifts, contrast pivots on mid-grey, 8-bit and 16-bit agree.
const assert=require('node:assert/strict'),path=require('node:path');
require(path.join(__dirname,'..','adjust.js'));
assert(Adjust.isNeutral({})&&Adjust.isNeutral({brightness:0,contrast:0})&&!Adjust.isNeutral({brightness:1}));
const px=Uint8ClampedArray.from([10,128,250,255, 0,64,200,7]); const same=Uint8ClampedArray.from(px); Adjust.applyRGBA(same,{}); assert.deepEqual([...same],[...px],'neutral changes nothing');
{ const t=Adjust.table({brightness:0,contrast:0},256,255); for(let i=0;i<256;i++)assert.equal(t[i],i,'identity table'); }
{ const up=Adjust.table({brightness:40,contrast:0},256,255), dn=Adjust.table({brightness:-40,contrast:0},256,255);
  assert(up[100]>100&&dn[100]<100,'brightness shifts'); assert.equal(up[255],255); assert.equal(dn[0],0,'ends clamp'); }
{ const hi=Adjust.table({brightness:0,contrast:60},256,255), lo=Adjust.table({brightness:0,contrast:-60},256,255);
  assert(Math.abs(hi[128]-128)<=1&&Math.abs(lo[128]-128)<=1,'mid-grey is the pivot'); assert(hi[200]>200&&hi[60]<60,'more contrast spreads'); assert(lo[200]<200&&lo[60]>60,'less contrast squeezes');
  for(let i=1;i<256;i++){ assert(hi[i]>=hi[i-1]&&lo[i]>=lo[i-1],'monotonic'); } }
// alpha untouched; 16-bit matches 8-bit within rounding; the 4th (infrared) channel of RGBI is left alone
{ const a={brightness:25,contrast:30}, p=Uint8ClampedArray.from([50,100,200,77]); Adjust.applyRGBA(p,a); assert.equal(p[3],77);
  const v=Uint16Array.from([50*257,100*257,200*257]); Adjust.apply16(v,a); for(let c=0;c<3;c++)assert(Math.abs(v[c]/257-p[c])<=1.5,'16-bit agrees with 8-bit: '+v[c]/257+' vs '+p[c]);
  const r=Uint16Array.from([1000,2000,3000,4444]); Adjust.apply16(r,{brightness:50},4); assert.equal(r[3],4444,'IR channel untouched'); }
assert.deepEqual(Adjust.norm({brightness:999,contrast:'x'}),{brightness:999,contrast:0},'values beyond the slider range are kept');
assert.deepEqual(Adjust.norm({brightness:1e9,contrast:-1e9}),{brightness:1000,contrast:-1000},'limited to +-1000'); assert.deepEqual(Adjust.norm({brightness:NaN,contrast:Infinity}),{brightness:0,contrast:0});
{ const t=Adjust.table({brightness:0,contrast:400},256,255); assert(t.every(x=>x>=0&&x<=255)&&t[100]<5&&t[160]>250,'huge contrast is a hard threshold, still finite');
  const u=Adjust.table({brightness:0.5,contrast:0},256,255); assert(u[128]>=128&&u[128]<=129,'fractional values work (fine tuning)'); }
console.log('adjust: brightness/contrast add-on OK');
