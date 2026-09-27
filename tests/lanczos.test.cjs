// Lanczos-3 line reduction: exactness on flat fields, alignment of fractional channel delays and
// the 7200 dpi stagger, in-place/mirror equivalence, clamping, and less aliasing than pair averaging.
const assert=require('node:assert/strict');
require('../capture_profiles.js');require('../capture_runtime.js');
const u16=a=>new Uint16Array(a.data.buffer,a.data.byteOffset,a.data.byteLength>>1);
function fixture(P,L,dpi,shifts,scene){
  const profile={dpi,yres:dpi*2,shifts,mainFrame:0,name:'lanczos fixture',frames:[{pixels:P,lines:L,bytes:P*L*6,regs:{37:0,38:0,39:L}}]};
  const g=CaptureRuntime.geometry(profile),bytes=new Uint8Array(P*L*6),v=new Uint16Array(bytes.buffer);
  for(let y=0;y<L;y++)for(let x=0;x<P;x++)for(let c=0;c<3;c++)v[(y*P+x)*3+c]=Math.min(65535,Math.max(0,Math.round(scene(y-(g.stagger.length&&x%2===0?g.stagger[0]:0)-shifts[c],c,x))));
  return {g,bytes};
}
// 1. flat field stays exactly flat
{const {g,bytes}=fixture(12,80,3600,[0,1.37,2.71],(y,c)=>20000+c);
 const a=u16(CaptureRuntime.alignedFrame(bytes,g,{filter:'lanczos3'}));for(let i=0;i<a.length;i++)assert.equal(a[i],20000+i%3);}
// 2. ramp scene with fractional delays and 7200 stagger: output row y shows the scene at raw line 2y+0.5 (same grid as the box filter)
for(const dpi of [3600,7200]){
  const scene=(y,c)=>10000+100*y+1000*c,{g,bytes}=fixture(10,200,dpi,[0,1.37,2.71],scene);
  const a=CaptureRuntime.alignedFrame(bytes,g,{filter:'lanczos3'}),v=u16(a),box=u16(CaptureRuntime.alignedFrame(bytes,g));
  assert.equal(a.filter,'lanczos3');assert.equal(a.height,Math.floor(g.lines/2));
  let worst=0;for(let y=6;y<a.height-6;y++)for(let x=0;x<10;x++)for(let c=0;c<3;c++){
    const want=scene(2*y+0.5,c);worst=Math.max(worst,Math.abs(v[(y*10+x)*3+c]-want));assert(Math.abs(box[(y*10+x)*3+c]-want)<=1);}
  assert(worst<=1,`ramp error ${worst} at ${dpi} dpi`);
}
// 3. in place == separate buffer, with and without mirror; mirror is an exact row reversal
{const {g,bytes}=fixture(17,120,7200,[0,1.5,3.2],(y,c,x)=>(Math.sin(y*0.9+x)*20000+30000+c*500));
 for(const mirror of [false,true]){
   const sep=CaptureRuntime.alignedFrame(bytes,g,{filter:'lanczos3',mirror}),copy=new Uint8Array(bytes);
   const inp=CaptureRuntime.alignedFrame(copy,g,{filter:'lanczos3',mirror,inPlace:true});
   assert.deepEqual(Buffer.from(inp.data),Buffer.from(sep.data),'in place, mirror '+mirror);}
 const a=u16(CaptureRuntime.alignedFrame(bytes,g,{filter:'lanczos3'})),b=u16(CaptureRuntime.alignedFrame(bytes,g,{filter:'lanczos3',mirror:true})),W=17;
 for(let i=0;i<a.length/3;i++){const y=Math.floor(i/W),x=i%W;for(let c=0;c<3;c++)assert.equal(b[(y*W+W-1-x)*3+c],a[i*3+c]);}}
// 4. negative lobes at a hard edge clamp into 0..65535, black-level offsets still apply
{const {g,bytes}=fixture(4,80,3600,[0,0,0],y=>y<40?0:65535);
 const v=u16(CaptureRuntime.alignedFrame(bytes,g,{filter:'lanczos3',offsets:[100,100,100]}));
 assert(v.includes(0)&&v.every(x=>x>=0&&x<=65535));}
// 5. detail above the output Nyquist (0.35 cycles per raw line) aliases far less than with pair averaging
{const f=0.35,{g,bytes}=fixture(2,400,3600,[0,0,0],y=>30000+20000*Math.cos(2*Math.PI*f*y));
 const amp=v=>{let lo=65535,hi=0;for(let y=10;y<180;y++){const s=v[y*6];lo=Math.min(lo,s);hi=Math.max(hi,s);}return (hi-lo)/2;};
 const box=amp(u16(CaptureRuntime.alignedFrame(bytes,g))),lz=amp(u16(CaptureRuntime.alignedFrame(bytes,g,{filter:'lanczos3'})));
 assert(lz<box*0.5,`alias amplitude lanczos ${lz} vs box ${box}`);
 console.log(`Lanczos-3: flat/ramp exact (≤1 count), 3600/7200 stagger + fractional delays, in place and mirrored match, clamped; alias amplitude ${lz.toFixed(0)} vs pair average ${box.toFixed(0)}`);}
