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
  let nan=0; for(const v of r.data) if(Number.isNaN(v)) nan++;
  assert(!nan&&!r.displayReferred,'fused output is a linear negative, not a display positive');
  // not inverted: fusion reshuffles overall levels (dense areas take the long pass's level), but
  // local detail keeps its sign: high-pass of the output against high-pass of the negative
  const hp=src=>{ const b=Enhance.boxBlur(src,W,H,6), o=new Float32Array(W*H); for(let i=0;i<W*H;i++) o[i]=src[i]-b[i]; return o; };
  const corr=c=>{ const a=new Float32Array(W*H), b=new Float32Array(W*H); for(let i=0;i<W*H;i++){ a[i]=scene[i*3+c]; b[i]=r.data[i*3+c]; }
    const x=hp(a), y=hp(b); let sxy=0,sxx=0,syy=0; for(let yy=20;yy<H-20;yy++) for(let xx=20;xx<W-20;xx++){ const i=yy*W+xx; sxy+=x[i]*y[i]; sxx+=x[i]*x[i]; syy+=y[i]*y[i]; }
    return sxy/Math.sqrt(sxx*syy); };
  const cs=[0,1,2].map(corr); assert(cs.every(v=>v>0.6),'not inverted: local detail follows the negative '+cs.map(v=>v.toFixed(3)));
  // no colour balance: channel ratios stay the negative's (scene means R:G:B ≈ 16:7:3.5)
  const mean=c=>{ let s=0,n=0; for(let i=c;i<r.data.length;i+=3*5){ s+=r.data[i]; n++; } return s/n; }, m=[0,1,2].map(mean);
  const sm=[0,1,2].map(c=>{ let s=0,n=0; for(let i=c;i<scene.length;i+=3*5){ s+=scene[i]; n++; } return s/n; });
  assert(Math.abs(Math.log((m[0]/m[2])/(sm[0]/sm[2])))<0.5&&Math.abs(Math.log((m[1]/m[2])/(sm[1]/sm[2])))<0.5,`channel ratios kept: out ${m.map(Math.round)} vs scene ${sm.map(Math.round)}`);
  // between the passes: at least the 1× level, at most the long pass's
  const lo=m.every((v,c)=>v>0.9*sm[c]), hi=m.every((v,c)=>v<3.3*sm[c]+off[c]);
  assert(lo&&hi,`levels between the 1× and long passes: ${m.map(Math.round)}`);
  console.log(`exposure fusion: linear negative, not inverted (local-detail r ${cs.map(v=>v.toFixed(3)).join('/')}), channel means ${m.map(Math.round).join('/')} (scene ${sm.map(Math.round).join('/')}), 1× weight ${r.shortWeight}`);
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
  // real-scan lessons: an IR-only mark (no trace in colour) is left alone; a long faint scratch
  // (IR 0.93, larger than the old 4000-px fill limit) is found along its length and filled
  { const col=Uint16Array.from(clean), irT=new Float32Array(W*H).fill(1);
    for(let y=200;y<214;y++) for(let x=100;x<114;x++) if((y-207)**2+(x-107)**2<=36) irT[y*W+x]=0.93;          // IR-only blob
    for(let x=40;x<600;x++) for(let k=0;k<9;k++){ const y=Math.round(330+x*0.15)+k-4; irT[y*W+x]=Math.min(irT[y*W+x],0.93+Math.abs(k-4)*0.01); // 9-px IR band
      if(Math.abs(k-4)<=1) for(let c=0;c<3;c++){ const j=(y*W+x)*3+c; col[j]=Math.round((clean[j]-dark[c])*0.7+dark[c]); } }               // 3-px visible line
    const irv=new Uint16Array(W*H); for(let i=0;i<W*H;i++) irv[i]=Math.max(0,Math.min(FS,Math.round(55000*Math.pow((clean[i*3]-dark[0])/16000,0.06)*irT[i]+gauss()*25)));
    const d2=Enhance.irDetect(irv,col,W,H,{darkC:dark}), fixed=Uint16Array.from(col), r2=Enhance.irRepair(fixed,W,H,d2);
    let blobTouched=0; for(let y=200;y<214;y++) for(let x=100;x<114;x++) for(let c=0;c<3;c++) if(fixed[(y*W+x)*3+c]!==col[(y*W+x)*3+c]) blobTouched++;
    let e0=0,e1=0,n=0; for(let x=60;x<580;x++){ const y=Math.round(330+x*0.15); for(let c=0;c<3;c++){ const j=(y*W+x)*3+c; e0+=Math.abs(Math.log(col[j]+64)-Math.log(clean[j]+64)); e1+=Math.abs(Math.log(fixed[j]+64)-Math.log(clean[j]+64)); n++; } }
    assert.equal(blobTouched,0,'IR-only mark left alone'); assert(r2.invisible>=1,'counted as invisible');
    assert(e1<e0*0.35,`long faint scratch repaired along its length: ${(e0/n).toFixed(3)} -> ${(e1/n).toFixed(3)}`);
    console.log(`infrared, real-scan cases: IR-only mark untouched (${r2.invisible} skipped), 9-px-band scratch (IR 0.93) filled: error ${(e0/n).toFixed(3)} -> ${(e1/n).toFixed(3)}, ${r2.dividedComponents} divided`); }
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
