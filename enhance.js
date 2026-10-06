/* Multi-exposure merging, exposure fusion and infrared defect repair. No DOM dependencies.
   Works on aligned, square-pixel frames: interleaved little-endian RGB16 (Uint16Array, W×H×3), the
   same layout the TIFF writer uses, plus single-channel planes. Design and the measurements behind
   it: DESIGN_MULTIEXPOSURE_AND_IR.md and CAPTURE_FINDINGS_COLOUR_ME_IR.md. */
(() => {
  const assert=(ok,msg)=>{ if(!ok) throw new Error(msg); };
  // The slow steps are generators that yield their progress (0..1) between stages. runSync drives
  // them in one go (tests, tools); runAsync hands the browser a frame between stages so the page
  // can draw a progress bar instead of freezing for 20 s.
  function runSync(g){ let r; while(!(r=g.next()).done); return r.value; }
  async function runAsync(g,onProgress){ let r, last=0;
    while(!(r=g.next()).done){ if(onProgress) onProgress(r.value);
      const now=Date.now(); if(now-last>40){ last=now; await new Promise(res=>setTimeout(res,0)); } }
    if(onProgress) onProgress(1); return r.value; }
  const FS=65535;

  // ------------------------------------------------------------ plane helpers
  function plane(rgb,W,H,c,minus=0){
    const out=new Float32Array(W*H);
    for(let i=0,j=c;i<out.length;i++,j+=3) out[i]=rgb[j]-minus;
    return out;
  }
  // Separable box blur, radius r, edges clamped.
  function boxBlur(src,W,H,r){
    const tmp=new Float32Array(W*H), out=new Float32Array(W*H), n=2*r+1;
    for(let y=0;y<H;y++){ const o=y*W; let acc=0;
      for(let k=-r;k<=r;k++) acc+=src[o+Math.min(W-1,Math.max(0,k))];
      for(let x=0;x<W;x++){ tmp[o+x]=acc/n; acc+=src[o+Math.min(W-1,x+r+1)]-src[o+Math.max(0,x-r)]; } }
    const col=new Float64Array(W);
    for(let x=0;x<W;x++){ let acc=0; for(let k=-r;k<=r;k++) acc+=tmp[Math.min(H-1,Math.max(0,k))*W+x]; col[x]=acc; }
    for(let y=0;y<H;y++){ const o=y*W, add=Math.min(H-1,y+r+1)*W, sub=Math.max(0,y-r)*W;
      for(let x=0;x<W;x++){ out[o+x]=col[x]/n; col[x]+=tmp[add+x]-tmp[sub+x]; } }
    return out;
  }
  // Separable running max (isMax) or min over a size×size window, van Herk/Gil-Werman, O(1) per
  // pixel. Edges are replicated.
  function morph(src,W,H,size,isMax){
    const r=size>>1, tmp=new Float32Array(W*H), out=new Float32Array(W*H);
    const N=Math.max(W,H)+2*r, p=new Float32Array(N), g=new Float32Array(N), h=new Float32Array(N);
    const line=(len,read,write)=>{
      const m=len+2*r;
      for(let i=0;i<m;i++) p[i]=read(Math.min(len-1,Math.max(0,i-r)));
      for(let i=0;i<m;i++) g[i]=(i%size===0)?p[i]:(isMax?(p[i]>g[i-1]?p[i]:g[i-1]):(p[i]<g[i-1]?p[i]:g[i-1]));
      for(let i=m-1;i>=0;i--) h[i]=(i===m-1||(i+1)%size===0)?p[i]:(isMax?(p[i]>h[i+1]?p[i]:h[i+1]):(p[i]<h[i+1]?p[i]:h[i+1]));
      for(let x=0;x<len;x++){ const a=h[x], b=g[x+size-1]; write(x,isMax?(a>b?a:b):(a<b?a:b)); }
    };
    for(let y=0;y<H;y++){ const o=y*W; line(W,k=>src[o+k],(x,v)=>{tmp[o+x]=v;}); }
    for(let x=0;x<W;x++) line(H,k=>tmp[k*W+x],(y,v)=>{out[y*W+x]=v;});
    return out;
  }
  const closing=(src,W,H,size)=>morph(morph(src,W,H,size,true),W,H,size,false);
  // Bilinear sample of a plane at (y - dy, x - dx): moves content by (+dy, +dx).
  function shifted(src,W,H,dy,dx){
    if(Math.abs(dy)<0.02&&Math.abs(dx)<0.02) return src;
    const out=new Float32Array(W*H), iy=Math.floor(dy), ix=Math.floor(dx), fy=dy-iy, fx=dx-ix;
    for(let y=0;y<H;y++){
      const y0=Math.min(H-1,Math.max(0,y-iy-1)), y1=Math.min(H-1,Math.max(0,y-iy));
      for(let x=0;x<W;x++){
        const x0=Math.min(W-1,Math.max(0,x-ix-1)), x1=Math.min(W-1,Math.max(0,x-ix));
        out[y*W+x]=(src[y0*W+x0]*fx+src[y0*W+x1]*(1-fx))*fy+(src[y1*W+x0]*fx+src[y1*W+x1]*(1-fx))*(1-fy);
      }
    }
    return out;
  }
  const parabola=(a,b,c)=>{ const d=a-2*b+c; return d<0?0.5*(a-c)/d:0; };

  // ------------------------------------------------------------ registration
  // Translation between two images of the same content (the passes of a multi-exposure scan):
  // normalised correlation of log values on a central crop, integer search, parabolic peak.
  // Returns the shift to apply to `mov` (content moves by +dy, +dx) so it lies on `ref`.
  function registerSame(ref,mov,W,H,{maxShift=4,step=3}={}){
    const y0=Math.floor(H*0.2)+maxShift, y1=Math.floor(H*0.8)-maxShift, x0=Math.floor(W*0.2)+maxShift, x1=Math.floor(W*0.8)-maxShift;
    const n=Math.max(maxShift*2+1,3), score=new Float64Array(n*n);
    const lg=v=>Math.log(Math.max(1,v)+64);
    for(let a=0;a<n;a++) for(let b=0;b<n;b++){
      const dy=a-maxShift, dx=b-maxShift; let sa=0,sb=0,saa=0,sbb=0,sab=0,k=0;
      for(let y=y0;y<y1;y+=step) for(let x=x0;x<x1;x+=step){
        const A=lg(ref[y*W+x]), B=lg(mov[(y-dy)*W+(x-dx)]); sa+=A;sb+=B;saa+=A*A;sbb+=B*B;sab+=A*B;k++; }
      const cov=sab-sa*sb/k, va=saa-sa*sa/k, vb=sbb-sb*sb/k; score[a*n+b]=va>0&&vb>0?cov/Math.sqrt(va*vb):-1;
    }
    let bi=0; for(let i=1;i<score.length;i++) if(score[i]>score[bi]) bi=i;
    const a=Math.floor(bi/n), b=bi%n;
    const fy=a>0&&a<n-1?parabola(score[(a-1)*n+b],score[bi],score[(a+1)*n+b]):0;
    const fx=b>0&&b<n-1?parabola(score[a*n+b-1],score[bi],score[a*n+b+1]):0;
    return {dy:a-maxShift+fy, dx:b-maxShift+fx, correlation:+score[bi].toFixed(4), edge:a===0||a===n-1||b===0||b===n-1};
  }
  // Infrared to colour: IR shows only defects, so register on them. IR defect strength
  // D = 1 - IR/closing(IR); colour dark specks T = closing(log R) - log R; the shift that maximises
  // the D-weighted mean of T at the IR defects. Returns the shift to apply to the IR plane.
  function registerDust(ir,red,W,H,{maxShift=4,size=15}={}){
    const cy0=Math.floor(H*0.08), cy1=Math.floor(H*0.92), cx0=Math.floor(W*0.06), cx1=Math.floor(W*0.94), cw=cx1-cx0, ch=cy1-cy0;
    const I=new Float32Array(cw*ch), L=new Float32Array(cw*ch);
    for(let y=0;y<ch;y++) for(let x=0;x<cw;x++){ const s=(y+cy0)*W+x+cx0; I[y*cw+x]=ir[s]; L[y*cw+x]=Math.log(Math.max(1,red[s])+64); }
    const ci=closing(I,cw,ch,size), cl=closing(L,cw,ch,size);
    const idx=[], wts=[];
    for(let y=maxShift;y<ch-maxShift;y++) for(let x=maxShift;x<cw-maxShift;x++){ const i=y*cw+x, d=1-I[i]/Math.max(1,ci[i]); if(d>0.25){ idx.push(i); wts.push(d); } }
    if(idx.length<40) return {dy:0,dx:0,defects:idx.length,ok:false,reason:'too few defects to register on'};
    const n=2*maxShift+1, score=new Float64Array(n*n); let wsum=0; for(const w of wts) wsum+=w;
    for(let a=0;a<n;a++) for(let b=0;b<n;b++){ const off=(a-maxShift)*cw+(b-maxShift); let s=0;
      for(let k=0;k<idx.length;k++){ const j=idx[k]+off; s+=wts[k]*(cl[j]-L[j]); } score[a*n+b]=s/wsum; }
    let bi=0; for(let i=1;i<score.length;i++) if(score[i]>score[bi]) bi=i;
    const a=Math.floor(bi/n), b=bi%n, mean=score.reduce((p,v)=>p+v,0)/score.length;
    const fy=a>0&&a<n-1?parabola(score[(a-1)*n+b],score[bi],score[(a+1)*n+b]):0;
    const fx=b>0&&b<n-1?parabola(score[a*n+b-1],score[bi],score[a*n+b+1]):0;
    const contrast=score[bi]/Math.max(1e-9,mean);
    return {dy:a-maxShift+fy, dx:b-maxShift+fx, defects:idx.length, contrast:+contrast.toFixed(2),
      ok:contrast>1.25&&!(a===0||a===n-1||b===0||b===n-1), reason:contrast>1.25?'':'no clear registration peak'};
  }

  // ------------------------------------------------------------ multi-exposure: extended range
  // Per channel: fit long = slope·short + offset (both black-subtracted) where both are well
  // exposed. The offset is real: the long pass carries extra dark signal (Kodak Gold capture:
  // +873/+1185/+2040 counts at 3×). Robust two-pass least squares on a subsample.
  function fitAffine(s,l,W,H,{step=5}={}){
    const xs=[], ys=[];
    for(let y=Math.floor(H*0.05);y<H*0.95;y+=step) for(let x=Math.floor(W*0.05);x<W*0.95;x+=step){
      const i=y*W+x, a=s[i], b=l[i]; if(a>0.02*FS&&a<0.6*FS&&b<0.85*FS){ xs.push(a); ys.push(b); } }
    assert(xs.length>200,'too few well-exposed pixels to relate the two exposures');
    const solve=(keep)=>{ let n=0,sx=0,sy=0,sxx=0,sxy=0;
      for(let i=0;i<xs.length;i++) if(keep[i]){ n++; sx+=xs[i]; sy+=ys[i]; sxx+=xs[i]*xs[i]; sxy+=xs[i]*ys[i]; }
      const slope=(n*sxy-sx*sy)/(n*sxx-sx*sx); return {slope,offset:(sy-slope*sx)/n,n}; };
    let keep=new Uint8Array(xs.length).fill(1), f=solve(keep);
    const res=xs.map((x,i)=>Math.abs(ys[i]-(f.slope*x+f.offset))), sorted=[...res].sort((a,b)=>a-b), cut=3*sorted[Math.floor(sorted.length/2)]+1;
    keep=keep.map((_,i)=>res[i]<=cut?1:0); f=solve(keep);
    return {slope:+f.slope.toFixed(4),offset:Math.round(f.offset),samples:f.n};
  }
  // Affine fits of the long pass against the 1× pass, per channel (as mergeRange does).
  function fitPasses(short,long,W,H,{darkS,darkL,shift={dy:0,dx:0}}){
    return [0,1,2].map(c=>{ const s=plane(short,W,H,c,darkS[c]), l=shifted(plane(long,W,H,c),W,H,shift.dy,shift.dx);
      for(let i=0;i<l.length;i++) l[i]-=darkL[c]; return fitAffine(s,l,W,H); });
  }
  // Interleaved RGB16 moved by (dy, dx), bilinear: brings the long pass onto the 1× grid.
  function shiftRGB(rgb,W,H,dy,dx){
    const out=new Uint16Array(rgb.length);
    for(let c=0;c<3;c++){ const q=shifted(plane(rgb,W,H,c),W,H,dy,dx); for(let i=0,j=c;i<q.length;i++,j+=3) out[j]=Math.round(q[i]); }
    return out;
  }
  // Inverse-variance blend of the 1× pass and the long pass scaled onto it. Noise per channel on
  // the 1× scale: var(s) = read + gain·s; long scaled: (read + gain·(slope·s + offset))/slope².
  // The long pass fades out between 90 % and 98 % of full scale (near clipping). Output keeps the
  // 1× pass's black level, so the file reads like a normal 1× scan with less noise.
  function mergeRange(short,long,W,H,{darkS,darkL,noise,shift={dy:0,dx:0}}){
    const out=short, fits=[], use=[];
    for(let c=0;c<3;c++){
      const s=plane(short,W,H,c,darkS[c]), lraw=shifted(plane(long,W,H,c),W,H,shift.dy,shift.dx);
      const l=new Float32Array(W*H); for(let i=0;i<l.length;i++) l[i]=lraw[i]-darkL[c];
      const fit=fitAffine(s,l,W,H); fits.push(fit);
      const nz=noise&&noise[c]||{read:30,gain:0.4}, rS=nz.read, rL=nz.readLong??nz.read, g=nz.gain;
      let wsum=0;
      for(let i=0,j=c;i<s.length;i++,j+=3){
        const sv=s[i], lv=l[i], ls=(lv-fit.offset)/fit.slope;
        const varS=rS+g*Math.max(sv,0), varL=(rL+g*Math.max(lv,0))/(fit.slope*fit.slope);
        const taper=lraw[i]<=0.90*FS?1:lraw[i]>=0.98*FS?0:(0.98*FS-lraw[i])/(0.08*FS);
        const w=taper*varS/(varS+varL); wsum+=w;
        const v=Math.round(sv+w*(ls-sv)+darkS[c]); out[j]=v<0?0:v>FS?FS:v;
      }
      use.push(+(wsum/s.length).toFixed(3));
    }
    return {data:out,fits,longWeight:use};
  }

  // ------------------------------------------------------------ multi-exposure: exposure fusion
  // Mertens, Kautz & Van Reeth (2007), the method behind enfuse: each exposure is rendered as a
  // positive, weighted per pixel by contrast (|Laplacian|), saturation (RGB spread) and
  // well-exposedness (closeness to mid-grey), and blended through Laplacian pyramids. Output is a
  // display-referred positive (gamma-encoded), for viewing, not for negative converters.
  function reduce(src,w,h){ // 5-tap binomial, decimate by 2
    const w2=(w+1)>>1, h2=(h+1)>>1, tmp=new Float32Array(w2*h), out=new Float32Array(w2*h2), k=[1,4,6,4,1];
    for(let y=0;y<h;y++) for(let x=0;x<w2;x++){ let a=0; for(let t=-2;t<=2;t++){ const xx=Math.min(w-1,Math.max(0,2*x+t)); a+=k[t+2]*src[y*w+xx]; } tmp[y*w2+x]=a/16; }
    for(let y=0;y<h2;y++) for(let x=0;x<w2;x++){ let a=0; for(let t=-2;t<=2;t++){ const yy=Math.min(h-1,Math.max(0,2*y+t)); a+=k[t+2]*tmp[yy*w2+x]; } out[y*w2+x]=a/16; }
    return {d:out,w:w2,h:h2};
  }
  function expand(src,w2,h2,w,h){ // bilinear upsample to w×h
    const out=new Float32Array(w*h);
    for(let y=0;y<h;y++){ const fy=Math.min(h2-1,Math.max(0,(y-0.5)/2)), y0=Math.floor(fy), y1=Math.min(h2-1,y0+1), ty=fy-y0;
      for(let x=0;x<w;x++){ const fx=Math.min(w2-1,Math.max(0,(x-0.5)/2)), x0=Math.floor(fx), x1=Math.min(w2-1,x0+1), tx=fx-x0;
        out[y*w+x]=(src[y0*w2+x0]*(1-tx)+src[y0*w2+x1]*tx)*(1-ty)+(src[y1*w2+x0]*(1-tx)+src[y1*w2+x1]*tx)*ty; } }
    return out;
  }
  function gaussPyr(img,w,h,levels){ const p=[{d:img,w,h}]; for(let l=1;l<levels;l++){ const q=p[l-1]; p.push(reduce(q.d,q.w,q.h)); } return p; }
  function fuse(...a){ return runSync(fuseSteps(...a)); }
  function* fuseSteps(short,long,W,H,{darkS,darkL,fit,film,shift={dy:0,dx:0},sigma=0.2}){
    // True image black (the dark frame is read before hardware shading, so it overestimates it):
    // with both passes sharing black B, long - darkL = k(short - darkS) + offset gives
    // B = darkS - offset/(k - 1) (Kodak Gold capture: ~560/461/414 against dark frames ~1000-1400).
    const black=[0,1,2].map(c=>Math.max(0,Math.min(darkS[c],darkS[c]-fit[c].offset/Math.max(0.2,fit[c].slope-1))));
    const s=[0,1,2].map(c=>plane(short,W,H,c,black[c]));
    const clipL=new Uint8Array(W*H);   // long-pass samples near full scale (clipped red on orange-mask film) must not count
    const l=[0,1,2].map(c=>{ const p=shifted(plane(long,W,H,c),W,H,shift.dy,shift.dx); for(let i=0;i<p.length;i++){ if(p[i]>=0.97*FS) clipL[i]=1; p[i]=Math.max(1,p[i]-black[c]-(darkL[c]-darkS[c])); } return p; });
    yield 0.08;
    // Both passes stay negatives: no inversion and no per-channel levels, so the film's orange
    // mask and the scanner's colour balance pass through for the negative converter. Fusion works
    // on gamma-encoded values (as Mertens assumes); the result is decoded back to linear 16-bit.
    const enc=v=>Math.pow(Math.min(1,Math.max(0,v/FS)),1/2.2);
    for(let c=0;c<3;c++) for(let i=0;i<W*H;i++){ s[c][i]=enc(s[c][i]); l[c][i]=enc(l[c][i]); }
    // Mertens weights
    const weight=e=>{ const w=new Float32Array(W*H), g=new Float32Array(W*H);
      for(let i=0;i<W*H;i++) g[i]=(e[0][i]+e[1][i]+e[2][i])/3;
      for(let y=0;y<H;y++) for(let x=0;x<W;x++){ const i=y*W+x;
        const lap=Math.abs(4*g[i]-g[y*W+Math.max(0,x-1)]-g[y*W+Math.min(W-1,x+1)]-g[Math.max(0,y-1)*W+x]-g[Math.min(H-1,y+1)*W+x]);
        const m=g[i], sat=Math.sqrt(((e[0][i]-m)**2+(e[1][i]-m)**2+(e[2][i]-m)**2)/3);
        let ex=1; for(let c=0;c<3;c++) ex*=Math.exp(-((e[c][i]-0.5)**2)/(2*sigma*sigma));
        w[i]=(lap+1e-3)*(sat+1e-3)*(ex+1e-6); }
      return w; };
    yield 0.15;
    const w1=weight(s); yield 0.25;
    const w2=weight(l); yield 0.35;
    for(let i=0;i<W*H;i++){ const b=clipL[i]?w2[i]*1e-4:w2[i], t=w1[i]+b; w1[i]=w1[i]/t; }
    const levels=Math.max(1,Math.floor(Math.log2(Math.min(W,H)))-3), gw=gaussPyr(w1,W,H,levels);
    let mean1=0; for(let i=0;i<W*H;i++) mean1+=w1[i]; mean1/=W*H;
    const out=short;
    for(let c=0;c<3;c++){
      yield 0.4+c*0.2;
      const g1=gaussPyr(s[c],W,H,levels), g2=gaussPyr(l[c],W,H,levels); s[c]=null; l[c]=null;
      yield 0.47+c*0.2;
      // blended Laplacian pyramid, collapsed from the top
      let acc=null;
      for(let lv=levels-1;lv>=0;lv--){
        const {w,h}=g1[lv], wl=gw[lv].d, a=g1[lv].d, b=g2[lv].d;
        let la=a, lb=b;
        if(lv<levels-1){ const ua=expand(g1[lv+1].d,g1[lv+1].w,g1[lv+1].h,w,h), ub=expand(g2[lv+1].d,g2[lv+1].w,g2[lv+1].h,w,h);
          la=new Float32Array(w*h); lb=new Float32Array(w*h); for(let i=0;i<w*h;i++){ la[i]=a[i]-ua[i]; lb[i]=b[i]-ub[i]; } }
        const blend=new Float32Array(w*h); for(let i=0;i<w*h;i++) blend[i]=wl[i]*la[i]+(1-wl[i])*lb[i];
        if(acc){ const up=expand(acc.d,acc.w,acc.h,w,h); for(let i=0;i<w*h;i++) blend[i]+=up[i]; }
        acc={d:blend,w,h};
      }
      for(let i=0,j=c;i<W*H;i++,j+=3) out[j]=Math.round(Math.pow(Math.min(1,Math.max(0,acc.d[i])),2.2)*FS);   // back to linear, black 0
    }
    return {data:out,displayReferred:false,shortWeight:+mean1.toFixed(3),black:black.map(Math.round)};
  }

  // ------------------------------------------------------------ infrared: detection
  // ir: Uint16 plane (IR seen by the red row, aligned like the colour frame, IR black ≈ 0);
  // colour: aligned RGB16 with black level darkC. Steps: register on dust, remove the cyan-dye
  // ghost (log IR = a·log R + b, fitted per scan, so any C-41 stock works), transmission
  // t = IR'/local clean background, defects where t < threshold.
  function irDetect(...a){ return runSync(irDetectSteps(...a)); }
  function* irDetectSteps(ir,colour,W,H,{darkC=[0,0,0],threshold=0.9,size=15}={}){
    const R=plane(colour,W,H,0,darkC[0]);
    const I0=new Float32Array(W*H); for(let i=0;i<I0.length;i++) I0[i]=ir[i];
    yield 0.02;
    const reg=registerDust(I0,R,W,H);
    yield 0.3;
    const I=shifted(I0,W,H,reg.ok?reg.dy:0,reg.ok?reg.dx:0);
    yield 0.35;
    // ghost fit on clean pixels
    const bg0=closing(I,W,H,size); let n=0,sx=0,sy=0,sxx=0,sxy=0;
    yield 0.5;
    for(let y=Math.floor(H*0.05);y<H*0.95;y+=4) for(let x=Math.floor(W*0.05);x<W*0.95;x+=4){ const i=y*W+x;
      if(I[i]>0.95*bg0[i]&&R[i]>16&&I[i]>16){ const a=Math.log(R[i]), b=Math.log(I[i]); n++; sx+=a; sy+=b; sxx+=a*a; sxy+=a*b; } }
    const ghost=n>100?(n*sxy-sx*sy)/(n*sxx-sx*sx):0;
    const In=new Float32Array(W*H); for(let i=0;i<In.length;i++) In[i]=I[i]*Math.pow(Math.max(16,R[i]),-ghost);
    let irMedian=[]; for(let i=0;i<I.length;i+=97) irMedian.push(I[i]); irMedian.sort((a,b)=>a-b); irMedian=irMedian[irMedian.length>>1]||0;
    yield 0.55;
    const bg=boxBlur(closing(In,W,H,size),W,H,7), t=new Float32Array(W*H);
    yield 0.7;
    // Outside the film (the holder around the frame) IR is near zero; its edge would read as a
    // huge defect. Exclude it, widened by the background filter's reach.
    // Only large dark areas count (an opening with a 31 px window drops opaque specks and scratches).
    const dark=new Float32Array(W*H); for(let i=0;i<W*H;i++) dark[i]=I[i]<0.5*irMedian?1:0;
    const op=morph(dark,W,H,31,false); yield 0.78;
    const big=morph(op,W,H,31,true); yield 0.86;
    const excluded=morph(big,W,H,2*(size+9)+1,true), m=size+9;
    yield 0.95;
    for(let y=0;y<H;y++) for(let x=0;x<W;x++) if(y<m||x<m||y>=H-m||x>=W-m) excluded[y*W+x]=1;   // and the image border
    const core=new Uint8Array(W*H); let defects=0, film=0;
    for(let i=0;i<t.length;i++){ t[i]=In[i]/Math.max(1,bg[i]); if(excluded[i]) continue; film++; if(t[i]<threshold){ core[i]=1; defects++; } }
    // Silver-image film (B&W, Kodachrome) blocks IR: the "ghost" is then the whole picture.
    const irBlocked=ghost>0.35||irMedian<0.25*FS;
    return {t,core,ir:I,registration:reg,ghost:+ghost.toFixed(4),coverage:+(defects/Math.max(1,film)*100).toFixed(4),filmFraction:+(film/t.length).toFixed(3),irMedian:Math.round(irMedian),irBlocked};
  }
  function dilate(mask,W,H,r=1){
    const out=new Uint8Array(W*H);
    for(let y=0;y<H;y++) for(let x=0;x<W;x++) if(mask[y*W+x])
      for(let dy=-r;dy<=r;dy++) for(let dx=-r;dx<=r;dx++){ const yy=y+dy, xx=x+dx; if(yy>=0&&yy<H&&xx>=0&&xx<W) out[yy*W+xx]=1; }
    return out;
  }

  // ------------------------------------------------------------ infrared: repair
  // Measured on real film (Lucky 200, Kodak Gold 200): dust, hairs and scratches attenuate visible
  // light less than IR (visible ≈ t^0.55..0.72), and not uniformly, so dividing by the IR
  // transmission only partly removes them. Repair therefore works per defect (connected component
  // of the IR mask):
  //  - compact and thin defects (specks, dust, hairs, scratches; up to maxFillArea pixels) are
  //    filled from their surroundings by exemplar inpainting: each pixel is copied from the
  //    best-matching 5×5 patch nearby (log-RGB distance over known pixels), filling from the
  //    outside in, with candidates from neighbours' matches (PatchMatch-style propagation) and
  //    random samples. Copying real neighbourhoods keeps the film grain.
  //  - large faint smudges are corrected physically: RGB / t^γ, with γ measured per scan and
  //    channel from the defects themselves, since inventing content over a large area is worse.
  function components(mask,W,H){
    const label=new Int32Array(W*H), sizes=[0], stack=[];
    for(let i=0;i<W*H;i++){ if(!mask[i]||label[i]) continue;
      const id=sizes.length; let n=0; label[i]=id; stack.push(i);
      while(stack.length){ const k=stack.pop(); n++; const y=(k/W)|0, x=k-y*W;
        for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){ const yy=y+dy, xx=x+dx;
          if(yy>=0&&yy<H&&xx>=0&&xx<W){ const q=yy*W+xx; if(mask[q]&&!label[q]){ label[q]=id; stack.push(q); } } } }
      sizes.push(n); }
    return {label,sizes};
  }
  // γ per channel: median of log(v/v0)/log(t) over semi-transparent defect pixels, v0 the mean of
  // unmasked pixels within ±6 px.
  function attenuationExponent(colour,W,H,t,core,mask,{maxSamples=20000}={}){
    const est=[[],[],[]];
    for(let y=8;y<H-8&&est[0].length<maxSamples;y++) for(let x=8;x<W-8;x++){ const i=y*W+x; const tt=t[i];
      if(!core[i]||tt<0.4||tt>0.85) continue;
      for(let c=0;c<3;c++){ let s=0,n=0;
        for(let dy=-6;dy<=6;dy+=2) for(let dx=-6;dx<=6;dx+=2){ const q=(y+dy)*W+x+dx; if(!mask[q]){ s+=colour[q*3+c]; n++; } }
        if(n<12) continue; est[c].push(Math.log(Math.max(1,colour[i*3+c])/(s/n))/Math.log(tt)); } }
    return est.map(a=>{ if(a.length<30) return 0.62; a.sort((p,q)=>p-q); return +Math.min(1,Math.max(0.3,a[a.length>>1])).toFixed(3); });
  }
  function irRepair(...a){ return runSync(irRepairSteps(...a)); }
  function* irRepairSteps(colour,W,H,det,{maxFillArea=4000,grow=2,radius=36,candidates=48,maxExemplar=600000,seed=1}={}){
    const {t,core}=det, mask=dilate(core,W,H,grow);
    const gamma=attenuationExponent(colour,W,H,t,core,mask);
    const {label,sizes}=components(mask,W,H), hole=new Uint8Array(W*H);
    let attenuated=0, filledComponents=0, dividedComponents=0;
    const big=new Uint8Array(sizes.length); for(let k=1;k<sizes.length;k++){ big[k]=sizes[k]>maxFillArea?1:0; if(big[k]) dividedComponents++; else filledComponents++; }
    for(let i=0;i<W*H;i++){ const k=label[i]; if(!k) continue;
      if(!big[k]){ hole[i]=1; continue; }
      if(core[i]){ attenuated++; const tt=Math.max(0.25,t[i]);
        for(let c=0;c<3;c++){ const j=i*3+c, v=colour[j]/Math.pow(tt,gamma[c]); colour[j]=v>FS?FS:Math.round(v); } } }
    let holes=0; for(let i=0;i<W*H;i++) holes+=hole[i];
    yield 0.2;
    const filled=yield* inpaintSteps(colour,W,H,hole,{radius,candidates,maxExemplar,seed},0.2,0.8);
    return {attenuated,inpainted:holes,gamma,filledComponents,dividedComponents,method:filled.method,exemplar:filled.exemplar,diffused:filled.diffused,mask};
  }
  function inpaint(...a){ return runSync(inpaintSteps(...a)); }
  function* inpaintSteps(colour,W,H,hole,{radius=36,candidates=48,maxExemplar=400000,seed=1}={},p0=0,span=1){
    let rnd=seed>>>0||1; const rand=()=>((rnd=(rnd*1664525+1013904223)>>>0)/4294967296);
    const known=new Uint8Array(W*H), srcY=new Int32Array(W*H).fill(-1), srcX=new Int32Array(W*H).fill(-1);
    const LOG=new Float32Array(65536); for(let v=0;v<65536;v++) LOG[v]=Math.log(v+64);
    let total=0; for(let i=0;i<W*H;i++){ known[i]=hole[i]?0:1; total+=hole[i]; }
    const original=Uint8Array.from(known);   // only untouched pixels serve as sources
    let exemplar=0, diffused=0;
    const nb8=(i,fn)=>{ const y=(i/W)|0, x=i-y*W; for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){ const yy=y+dy, xx=x+dx; if((dy||dx)&&yy>=0&&yy<H&&xx>=0&&xx<W) fn(yy*W+xx,dy,dx); } };
    const knownCount=i=>{ let n=0; nb8(i,j=>{ n+=known[j]; }); return n; };
    const meanFill=i=>{ const acc=[0,0,0]; let n=0; nb8(i,j=>{ if(known[j]){ for(let c=0;c<3;c++) acc[c]+=colour[j*3+c]; n++; } });
      if(!n) return false; for(let c=0;c<3;c++) colour[i*3+c]=Math.round(acc[c]/n); known[i]=1; diffused++; return true; };
    const score=(py,px,qy,qx,best)=>{ let s=0,n=0;
      for(let dy=-2;dy<=2;dy++){ const ay=py+dy, by=qy+dy; if(ay<0||ay>=H||by<0||by>=H) continue;
        for(let dx=-2;dx<=2;dx++){ const ax=px+dx, bx=qx+dx; if(ax<0||ax>=W||bx<0||bx>=W) continue;
          const a=ay*W+ax, b=by*W+bx; if(!known[a]||!original[b]) continue;
          for(let c=0;c<3;c++){ const d=LOG[colour[a*3+c]]-LOG[colour[b*3+c]]; s+=d*d; } n++;
          if(n>=6&&s/n>best) return Infinity; } }
      return n>=6?s/n:Infinity; };
    const stamp=new Int32Array(W*H); let round=0;
    // first ring: hole pixels touching known ones, filled most-surrounded first
    let ring=[]; for(let i=0;i<W*H;i++) if(!known[i]&&knownCount(i)) ring.push(i);
    while(ring.length){
      round++; ring.sort((a,b)=>knownCount(b)-knownCount(a));
      const filled=[], stuck=[];
      for(const i of ring){
        if(known[i]) continue;
        const py=(i/W)|0, px=i-py*W;
        if(exemplar>=maxExemplar){ if(meanFill(i)) filled.push(i); else stuck.push(i); continue; }
        let best=Infinity, by=-1, bx=-1;
        const tryQ=(qy,qx)=>{ if(qy<2||qy>=H-2||qx<2||qx>=W-2) return; if(!original[qy*W+qx]) return;
          const s=score(py,px,qy,qx,best); if(s<best){ best=s; by=qy; bx=qx; } };
        nb8(i,(j,dy,dx)=>{ if(srcY[j]>=0) tryQ(srcY[j]-dy,srcX[j]-dx); });     // propagation
        for(let k=0;k<candidates;k++) tryQ(Math.round(py+(rand()*2-1)*radius),Math.round(px+(rand()*2-1)*radius));
        for(let r=Math.max(1,radius>>3);by>=0&&r>=1;r>>=1) for(let k=0;k<4;k++) tryQ(by+Math.round((rand()*2-1)*r),bx+Math.round((rand()*2-1)*r));
        if(by<0){ if(meanFill(i)) filled.push(i); else stuck.push(i); continue; }
        const q=by*W+bx; for(let c=0;c<3;c++) colour[i*3+c]=colour[q*3+c];
        known[i]=1; srcY[i]=by; srcX[i]=bx; exemplar++; filled.push(i);
      }
      yield p0+span*Math.min(1,(exemplar+diffused)/Math.max(1,total));
      if(!filled.length) break;   // nothing reachable (cannot happen unless the whole frame is hole)
      const next=[];
      const add=j=>{ if(!known[j]&&stamp[j]!==round){ stamp[j]=round; next.push(j); } };
      for(const i of filled) nb8(i,add);
      for(const i of stuck) add(i);
      ring=next;
    }
    return {method:diffused?'exemplar + neighbour mean':'exemplar (patch-based)',exemplar,diffused};
  }

  // ------------------------------------------------------------ output helpers
  // 8-bit greyscale PNG (defect masks): IDAT compressed with CompressionStream('deflate') (zlib).
  async function pngGray(px,W,H){
    const crcT=new Uint32Array(256); for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c=c&1?0xedb88320^(c>>>1):c>>>1; crcT[n]=c>>>0; }
    const crc=b=>{ let c=0xffffffff; for(const v of b) c=crcT[(c^v)&255]^(c>>>8); return (c^0xffffffff)>>>0; };
    const raw=new Uint8Array((W+1)*H); for(let y=0;y<H;y++){ raw[y*(W+1)]=0; raw.set(px.subarray(y*W,y*W+W),y*(W+1)+1); }
    const z=new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    const chunk=(type,data)=>{ const out=new Uint8Array(12+data.length), dv=new DataView(out.buffer);
      dv.setUint32(0,data.length); for(let i=0;i<4;i++) out[4+i]=type.charCodeAt(i); out.set(data,8);
      dv.setUint32(8+data.length,crc(out.subarray(4,8+data.length))); return out; };
    const ihdr=new Uint8Array(13), dv=new DataView(ihdr.buffer); dv.setUint32(0,W); dv.setUint32(4,H); ihdr[8]=8; ihdr[9]=0;
    return new Blob([Uint8Array.of(137,80,78,71,13,10,26,10),chunk('IHDR',ihdr),chunk('IDAT',z),chunk('IEND',new Uint8Array(0))],{type:'image/png'});
  }
  // Defect/repair mask at preview size (same grid as previewFromAligned): a preview pixel is set
  // if any frame pixel under it is, so hairline scratches stay visible.
  function maskPreview(mask,W,H,maxDim=1200){
    const scale=Math.min(1,maxDim/Math.max(W,H)), w=Math.max(1,Math.round(W*scale)), h=Math.max(1,Math.round(H*scale)), bx=W/w, by=H/h, out=new Uint8Array(w*h);
    let n=0;
    for(let y=0;y<H;y++){ const oy=Math.min(h-1,Math.floor(y/by)); for(let x=0;x<W;x++) if(mask[y*W+x]){ const o=oy*w+Math.min(w-1,Math.floor(x/bx)); if(!out[o]){ out[o]=255; n++; } } }
    return {data:out,width:w,height:h,pixels:n};
  }
  // Small display planes from an aligned frame (for previews of processed output).
  function previewFromAligned(rgb,W,H,maxDim=1200,minus=[0,0,0]){
    const scale=Math.min(1,maxDim/Math.max(W,H)), w=Math.max(1,Math.round(W*scale)), h=Math.max(1,Math.round(H*scale));
    const planes=[0,1,2].map(()=>new Uint16Array(w*h)), bx=W/w, by=H/h;
    // box average over each output pixel's footprint (picking single pixels aliases grain)
    for(let y=0;y<h;y++){ const y0=Math.floor(y*by), y1=Math.max(y0+1,Math.min(H,Math.floor((y+1)*by)));
      for(let x=0;x<w;x++){ const x0=Math.floor(x*bx), x1=Math.max(x0+1,Math.min(W,Math.floor((x+1)*bx))); let r=0,g=0,b=0;
        for(let yy=y0;yy<y1;yy++) for(let xx=x0,j=(yy*W+x0)*3;xx<x1;xx++,j+=3){ r+=rgb[j]; g+=rgb[j+1]; b+=rgb[j+2]; }
        const n=(y1-y0)*(x1-x0), i=y*w+x, v=[r/n-minus[0],g/n-minus[1],b/n-minus[2]];
        for(let c=0;c<3;c++) planes[c][i]=v[c]<0?0:Math.round(v[c]); } }
    return {planes,g:{pixels:w,lines:h}};
  }

  globalThis.Enhance={runSync,runAsync,irDetectSteps,irRepairSteps,fuseSteps,inpaintSteps,maskPreview,fitPasses,shiftRGB,components,attenuationExponent,boxBlur,morph,closing,shifted,registerSame,registerDust,fitAffine,mergeRange,fuse,irDetect,irRepair,inpaint,dilate,pngGray,previewFromAligned};
})();
