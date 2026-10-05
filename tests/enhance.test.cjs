// Multi-exposure merge, exposure fusion and infrared repair on synthetic frames with known answers.
const assert=require('node:assert/strict');
require('../enhance.js');
const W=640, H=480, FS=65535;
let seed=12345; const rnd=()=>((seed=(seed*1103515245+12345)>>>0)/4294967296);
const gauss=()=>{ let u=0,v=0; while(!u)u=rnd(); v=rnd(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); };
// smooth scene with texture, per channel, signal in counts above black at 1×
const scene=new Float32Array(W*H*3);
for(let y=0;y<H;y++) for(let x=0;x<W;x++) for(let c=0;c<3;c++)
  scene[(y*W+x)*3+c]=[16000,7000,3500][c]*(0.25+0.75*(0.5+0.5*Math.sin(x*0.031+c)*Math.cos(y*0.023)))+(x>W*0.7?[9000,4000,2000][c]:0);
const dark=[980,1040,1390], darkL=[985,1035,1400], slope=[3.11,3.12,3.06], off=[873,1185,2040], read=40, gain=0.5;
const expose=(k,o,d)=>{ const a=new Uint16Array(W*H*3);
  for(let i=0;i<a.length;i++){ const c=i%3, s=scene[i]*k+o[c]; const v=s+d[c]+gauss()*Math.sqrt(read+gain*Math.max(s,0)); a[i]=Math.max(0,Math.min(FS,Math.round(v))); }
  return a; };

// ---- extended range
{
  const short=expose(1,[0,0,0],dark), long=expose(3.1,off,darkL); for(let i=0;i<long.length;i++){ const c=i%3; long[i]=Math.min(FS,Math.round((long[i]-darkL[c]-off[c])/3.1*slope[c]+off[c]+darkL[c])); }
  const before=Uint16Array.from(short);
  const r=Enhance.mergeRange(short,long,W,H,{darkS:dark,darkL,noise:[0,1,2].map(()=>({read,gain}))});
  for(let c=0;c<3;c++){ assert(Math.abs(r.fits[c].slope-slope[c])<0.03,`slope ${c}: ${r.fits[c].slope}`); assert(Math.abs(r.fits[c].offset-off[c])<120,`offset ${c}: ${r.fits[c].offset}`); }
  // noise against the true scene, where the long pass is not clipped (blue everywhere)
  const err=(img,c)=>{ let s=0,n=0; for(let i=c;i<img.length;i+=3){ const d=img[i]-dark[c]-scene[i]; s+=d*d; n++; } return Math.sqrt(s/n); };
  const e0=err(before,2), e1=err(r.data,2);
  assert(e1<e0*0.7,`blue noise ${e0.toFixed(1)} -> ${e1.toFixed(1)}`);
  // red clips in the long pass on the bright right side: output there must follow the 1× pass
  let clipped=0, ok=0; for(let y=0;y<H;y++) for(let x=Math.floor(W*0.75);x<W;x++){ const i=(y*W+x)*3; if(long[i]>=FS){ clipped++; if(Math.abs(r.data[i]-before[i])<1) ok++; } }
  assert(clipped>1000&&ok/clipped>0.99,`clipped red follows the 1× pass (${ok}/${clipped})`);
  console.log(`extended range: fits ${r.fits.map(f=>f.slope+'/'+f.offset).join(', ')}; blue noise ${e0.toFixed(1)} -> ${e1.toFixed(1)}; ${clipped} clipped red px kept from 1×; long-pass weight ${r.longWeight.join('/')}`);
}
// ---- exposure fusion
{
  const short=expose(1,[0,0,0],dark), long=expose(3.1,off,darkL);
  const fit=[0,1,2].map(c=>({slope:3.1,offset:off[c]}));
  const r=Enhance.fuse(short,long,W,H,{darkS:dark,darkL,fit,film:'neg'});
  let mn=FS,mx=0,nan=0; for(const v of r.data){ if(Number.isNaN(v))nan++; mn=Math.min(mn,v); mx=Math.max(mx,v); }
  assert(!nan&&mx>40000&&mn<20000&&r.displayReferred,'fused positive spans a display range');
  console.log(`exposure fusion: positive ${mn}..${mx}, 1× weight ${r.shortWeight}`);
}
// ---- infrared detection and repair
{
  const clean=new Uint16Array(W*H*3); for(let i=0;i<clean.length;i++){ const c=i%3; clean[i]=Math.min(FS,Math.round(scene[i]+dark[c]+gauss()*30)); }
  const tTrue=new Float32Array(W*H).fill(1);
  const speck=(cy,cx,r,t)=>{ for(let y=cy-r;y<=cy+r;y++) for(let x=cx-r;x<=cx+r;x++) if((y-cy)**2+(x-cx)**2<=r*r) tTrue[y*W+x]=Math.min(tTrue[y*W+x],t); };
  for(let k=0;k<60;k++) speck(30+Math.floor(rnd()*(H-60)),30+Math.floor(rnd()*(W-60)),1+Math.floor(rnd()*3),rnd()<0.5?0.15:0.65);
  for(let x=60;x<560;x++){ const y=Math.round(100+x*0.4); tTrue[y*W+x]=Math.min(tTrue[y*W+x],0.2); tTrue[(y+1)*W+x]=Math.min(tTrue[(y+1)*W+x],0.35); }   // scratch
  const colour=Uint16Array.from(clean); for(let i=0;i<W*H;i++) for(let c=0;c<3;c++){ const j=i*3+c; colour[j]=Math.round((clean[j]-dark[c])*tTrue[i]+dark[c]); }
  // IR: ghost of the red record (cyan dye) ∝ R^0.06, defects, offset by (1.2, 0.7) px, noise
  const irTrue=new Float32Array(W*H); for(let i=0;i<W*H;i++) irTrue[i]=55000*Math.pow((clean[i*3]-dark[0])/16000,0.06)*tTrue[i];
  const ir=Enhance.shifted(irTrue,W,H,-1.2,-0.7), irU=new Uint16Array(W*H); for(let i=0;i<W*H;i++) irU[i]=Math.max(0,Math.min(FS,Math.round(ir[i]+gauss()*60)));
  const det=Enhance.irDetect(irU,colour,W,H,{darkC:dark});
  assert(det.registration.ok,'registered on the defects: '+JSON.stringify(det.registration));
  assert(Math.abs(det.registration.dy-1.2)<0.35&&Math.abs(det.registration.dx-0.7)<0.35,'registration '+JSON.stringify(det.registration));
  assert(Math.abs(det.ghost-0.06)<0.03,'ghost '+det.ghost); assert(!det.irBlocked);
  const near=Enhance.dilate(Uint8Array.from(tTrue,v=>v<1?1:0),W,H,2);   // within 2 px of a real defect
  let hit=0,defects=0,falsePos=0; for(let i=0;i<W*H;i++){ if(tTrue[i]<0.8){ defects++; if(det.core[i]) hit++; } else if(det.core[i]&&!near[i]) falsePos++; }
  assert(hit/defects>0.85,`mask finds the defects (${hit}/${defects})`); assert(falsePos<defects*0.02,`false positives away from defects: ${falsePos}`);
  const repaired=Uint16Array.from(colour), rep=Enhance.irRepair(repaired,W,H,det);
  const err=img=>{ let s=0,n=0; for(let i=0;i<W*H;i++) if(tTrue[i]<1) for(let c=0;c<3;c++){ const d=Math.log(img[i*3+c]+64)-Math.log(clean[i*3+c]+64); s+=d*d; n++; } return Math.sqrt(s/n); };
  const e0=err(colour), e1=err(repaired);
  assert(e1<e0*0.35,`repair error ${e0.toFixed(3)} -> ${e1.toFixed(3)}`);
  let touched=0; for(let i=0;i<W*H;i++) if(!rep.mask[i]) for(let c=0;c<3;c++) if(repaired[i*3+c]!==colour[i*3+c]) touched++;
  assert.equal(touched,0,'nothing outside the mask changes');
  console.log(`infrared: registered ${det.registration.dy.toFixed(2)}/${det.registration.dx.toFixed(2)} (true 1.2/0.7), ghost ${det.ghost} (true 0.06), found ${hit}/${defects} defect px; repair log error ${e0.toFixed(3)} -> ${e1.toFixed(3)} (${rep.attenuated} divided, ${rep.inpainted} inpainted: ${rep.method})`);
  // silver film: IR shows the image itself
  const silver=new Uint16Array(W*H); for(let i=0;i<W*H;i++) silver[i]=Math.round(60000*Math.pow((clean[i*3]-dark[0])/30000,0.9));
  assert(Enhance.irDetect(silver,colour,W,H,{darkC:dark}).irBlocked,'IR-blocking (silver) film is detected');
  console.log('infrared: silver-image film (IR shows the picture) is detected and left alone');
}
// ---- PNG mask
(async()=>{
  const m=new Uint8Array(32*16); m[5]=255; const png=await Enhance.pngGray(m,32,16), b=Buffer.from(await png.arrayBuffer());
  assert.deepEqual([...b.subarray(1,4)].map(c=>String.fromCharCode(c)).join(''),'PNG'); assert(b.length>60);
  console.log('mask PNG written ('+b.length+' bytes)');
})().catch(e=>{console.error(e);process.exit(1);});
