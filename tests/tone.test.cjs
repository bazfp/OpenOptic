// "Ready to view" tone for the saved TIFF (CaptureRuntime.toneView): dark slides come out mid-range, an open (saturated) strip does not set
// the white point, black stays dark, the curve is monotonic, negatives are inverted by density, and the result stays 16-bit.
const assert=require('node:assert/strict'),path=require('node:path');
require(path.join(__dirname,'..','capture_runtime.js'));
const W=400,H=300, rnd=(()=>{let s=12345;return()=>(s=(s*1103515245+12345)&0x7fffffff)/0x7fffffff;})();
// a dim "slide": values 400..6000 with some structure, plus a 4 % open strip at the right edge (saturated)
function slide(){ const v=new Uint16Array(W*H*3);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++)for(let c=0;c<3;c++) v[(y*W+x)*3+c]=x>=W*0.96?65535:Math.round(400+5600*((x/W)*0.7+rnd()*0.3)*(0.8+0.1*c));
  return v; }
{ const v=slide(), before=Uint16Array.from(v); const r=CaptureRuntime.toneView(v,W,H,'pos');
  const med=a=>{const s=Array.from(a).sort((p,q)=>p-q);return s[s.length>>1];};
  const body=[]; for(let y=0;y<H;y++)for(let x=0;x<W*0.9;x++)body.push(v[(y*W+x)*3+1]);
  assert(med(body)>20000&&med(body)<50000,'dim slide lands mid-range, median '+med(body));
  assert(r.levels.every(([lo,hi])=>hi<7000),'the open strip does not set the white point: '+JSON.stringify(r.levels));
  assert.equal(v[(W-1)*3],65535,'the open strip stays at full scale');
  // monotonic: sorting by input keeps output order (per channel)
  const idx=[...Array(W*H).keys()].sort((a,b)=>before[a*3+1]-before[b*3+1]); let last=-1; for(const i of idx){ assert(v[i*3+1]>=last,'monotonic'); last=v[i*3+1]; }
  const distinct=new Set(v).size; assert(distinct>3000,'stays smooth 16-bit, not posterized ('+distinct+' levels)'); assert(Math.max(...body)>40000);
  console.log(`tone positive: median ${med(body)}, levels ${JSON.stringify(r.levels)}, ${distinct} distinct values`); }
// negative: densest (darkest transmission) -> bright, film base -> dark
{ const v=new Uint16Array(W*H*3); for(let i=0;i<v.length;i++){ const x=((i/3)|0)%W; v[i]=Math.round(2000+60000*(x/W)); }   // dark on the left, clear on the right
  const r=CaptureRuntime.toneView(v,W,H,'neg'); assert.equal(r.film,'neg'); const row=y=>[v[(y*W+Math.floor(W*0.1))*3],v[(y*W+Math.floor(W*0.9))*3]];
  const [dense,base]=row(150); assert(dense>base&&dense>40000&&base<20000,'negative inverted by density: dense '+dense+', base '+base); }
// all-saturated and tiny inputs do not throw or produce NaN
{ const v=new Uint16Array(W*H*3).fill(65535); CaptureRuntime.toneView(v,W,H,'pos'); assert(v.every(x=>x>=0&&x<=65535)); }
// the on-screen preview and the saved "ready to view" data agree (what you see before the scan is what is saved), for both film types,
// including a frame with an open saturated strip that must not set the white point in either
for(const film of ['pos','neg']){
  const v=slide(); const planes=[0,1,2].map(c=>{const p=new Uint16Array(W*H); for(let i=0;i<W*H;i++)p[i]=v[i*3+c]; return p;});
  const shown=CaptureRuntime.renderPreview(planes,{pixels:W,lines:H},film,{skipSaturated:true}); CaptureRuntime.toneView(v,W,H,film);
  let worst=0; for(let i=0;i<W*H;i++)for(let c=0;c<3;c++)worst=Math.max(worst,Math.abs(shown[i*4+c]-(v[i*3+c]>>8)));
  assert(worst<=2,film+': preview and saved tone differ by '+worst+' of 255');
  console.log(`preview vs saved tone (${film}): within ${worst} of 255`);
}
// the default preview (no option) is the 7600i's: saturated pixels still count, so an open strip sets the white point and the picture is darker
{ const v=slide(), planes=[0,1,2].map(c=>{const p=new Uint16Array(W*H); for(let i=0;i<W*H;i++)p[i]=v[i*3+c]; return p;});
  const mean=a=>{ let s=0; for(let i=0;i<a.length;i+=4)s+=a[i+1]; return s/(a.length/4); };
  const old=mean(CaptureRuntime.renderPreview(planes,{pixels:W,lines:H},'pos')), skip=mean(CaptureRuntime.renderPreview(planes,{pixels:W,lines:H},'pos',{skipSaturated:true}));
  assert(old<skip*0.8,'default preview is the unchanged one (darker with an open strip): '+old+' vs '+skip); }
console.log('tone: ready-to-view curve OK');
