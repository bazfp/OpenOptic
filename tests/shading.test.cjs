// Software flat-field for the OpticFilm 8100: a uniform light seen through the reference's own response must come out flat,
// black must stay black, the centre must not change, and what the reference cannot vouch for is left alone.
const assert=require('node:assert/strict'),path=require('node:path');
for(const f of ['shading.js','gl845.js','home_plans.js','shading_8100.js'])require(path.join(__dirname,'..',f));
const ref=Shading.load(SHADING_8100), plans=HOME_PLANS['8100'];

// the 1800 ppi geometry (every 4th sensor pixel) too
{ const g18=Gl845.scanGeometry(HOME_PLANS['8100'].main1800); assert(g18.str>=SHADING_8100.str&&g18.end<=SHADING_8100.str+SHADING_8100.pixels,'1800 ppi window inside the reference'); }
// the 7200 ppi geometry also maps onto the reference (every sensor pixel: k = 1)
{ const g7=Gl845.scanGeometry(HOME_PLANS['8100'].main7200); assert(g7.str>=SHADING_8100.str&&g7.end<=SHADING_8100.str+SHADING_8100.pixels,'7200 ppi window inside the reference');
  const gains=Shading.gains(Shading.load(SHADING_8100),g7); assert.equal(gains.length,g7.pixels*3); }
// the real plans map onto the reference grid
const gm=Gl845.scanGeometry(plans.main), gp=Gl845.scanGeometry(plans.preview);
assert.deepEqual([gm.str,gm.dpiset,gm.pixels],[38,600,5200]); assert.deepEqual([gp.str,gp.dpiset,gp.pixels],[24,150,1300]);
assert(gm.str>=ref.str&&gm.end<=ref.str+ref.pixels&&gp.str>=ref.str&&gp.end<=ref.str+ref.pixels,'geometries lie inside the reference');
assert.throws(()=>Gl845.scanGeometry({...plans.main,pixels:5000}),/geometry mismatch/);

// the noise statistics for the multi-exposure merge (read noise from the dark frame, photon-transfer gain from the white): physically sensible
{ const n=SHADING_8100.noise; for(let c=0;c<3;c++){ const read=Math.max(1,n.dark.tvar[c]), sig=n.white.mean[c]-n.dark.mean[c], gain=(n.white.tvar[c]-read)/sig;
    assert(read>100&&read<3000,'read noise variance '+read); assert(gain>1&&gain<12,'gain '+gain); assert(sig>30000,'white signal '+sig); } }
// uniform light through the reference's response: level L above black in the centre
function scan(geom,lines,level){
  const k=1200/geom.dpiset, n=geom.pixels*lines*3, v=new Uint16Array(n);
  for(let y=0;y<lines;y++)for(let i=0;i<geom.pixels;i++)for(let c=0;c<3;c++){
    const w=ref.white[(geom.str+i*k-ref.str)*3+c], resp=(w-ref.dark[c])/(ref.centre[c]-ref.dark[c]);
    v[(y*geom.pixels+i)*3+c]=Math.min(65535,Math.round(ref.dark[c]+level*resp)); }
  return new Uint8Array(v.buffer);
}
for(const [name,geom] of [['3600 dpi',gm],['900 dpi',gp]]){
  const lines=6, bytes=scan(geom,lines,20000), before=new Uint16Array(bytes.buffer.slice(0));
  Shading.apply(bytes,geom,lines,ref); const v=new Uint16Array(bytes.buffer);
  const g=Shading.gains(ref,geom); let corrected=0,worst=0;
  const mid=Math.floor(geom.pixels/2), centreVal=c=>v[mid*3+c];
  for(let i=0;i<geom.pixels;i++)for(let c=0;c<3;c++){ if(g[i*3+c]===1)continue; corrected++;
    worst=Math.max(worst,Math.abs(v[i*3+c]-(ref.dark[c]+20000))/20000); }
  assert(corrected>geom.pixels*3*0.8,name+': most pixels are corrected ('+corrected+')');
  assert(worst<0.01,name+': flat to 1 % of the signal, worst '+worst.toFixed(4));
  let spreadBefore=0; for(let i=0;i<geom.pixels;i++)spreadBefore=Math.max(spreadBefore,Math.abs(before[i*3+1]-before[mid*3+1]));
  assert(spreadBefore>0.1*20000,name+': the raw data really was uneven ('+spreadBefore+')');
  for(let c=0;c<3;c++)assert(Math.abs(centreVal(c)-(ref.dark[c]+20000))<150,name+': centre unchanged');
  console.log(`shading ${name}: raw spread ${(100*spreadBefore/20000).toFixed(0)} % -> flat within ${(worst*100).toFixed(2)} % (${corrected} of ${geom.pixels*3} samples corrected)`);
}
// black stays black; negative excursions below black are not amplified into the signal
{ const lines=2, geom=gm, bytes=new Uint8Array(geom.pixels*lines*6), v=new Uint16Array(bytes.buffer); for(let s=0;s<v.length;s++)v[s]=Math.round(ref.dark[s%3]);
  Shading.apply(bytes,geom,lines,ref); for(let s=0;s<v.length;s++)assert(Math.abs(v[s]-ref.dark[s%3])<=1,'black kept at '+s); }
// saturated white columns are left alone (gain 1) and clipping is clamped, not wrapped
{ const g=Shading.gains(ref,gm); let sat=0; for(let i=0;i<gm.pixels;i++)for(let c=0;c<3;c++){ const w=ref.white[(gm.str+i*2-ref.str)*3+c]; if(w>=65000){ sat++; assert.equal(g[i*3+c],1); } }
  assert(sat>0,'the reference does contain saturated columns, as measured');
  const b=new Uint8Array(gm.pixels*6), v=new Uint16Array(b.buffer); v.fill(65535); Shading.apply(b,gm,1,ref); assert(v.every(x=>x<=65535)); }
// refusals
assert.throws(()=>Shading.apply(new Uint8Array(10),gm,1,ref),/does not match the geometry/);
assert.throws(()=>Shading.gains(ref,{...gm,dpiset:700}),/does not divide/);
assert.throws(()=>Shading.load({...SHADING_8100,pixels:100}),/wrong size/);
console.log('shading: flat-field OK (3600 and 900 dpi geometry, black kept, saturated columns left alone)');
