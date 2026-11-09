/* OPTIONAL add-on: brightness and contrast for the "ready to view" tone (kept in its own file so it can be left out of a
   contribution; the hooks that use it are marked "adjust add-on"). Applied AFTER the tone curve, on display-referred data only,
   so linear data is never touched. Contrast pivots on mid-grey with slope 2^(1.5 c); brightness shifts by b / 2 of full scale
   (0 = unchanged; the sliders cover -100..+100, typed values may go further and are limited to +-1000 only to keep the maths finite). No DOM; tested in tests/adjust.test.cjs. */
(() => {
  const LIMIT=1000, clampv=v=>Math.max(-LIMIT,Math.min(LIMIT,Number.isFinite(+v)?+v:0));
  const norm=a=>({brightness:clampv(a?.brightness),contrast:clampv(a?.contrast)});
  const isNeutral=a=>{ const n=norm(a); return n.brightness===0&&n.contrast===0; };
  // lookup table over [0, steps-1] -> [0, max]
  function table(a,steps,max){
    const {brightness,contrast}=norm(a), k=Math.pow(2,1.5*contrast/100), shift=brightness/200, t=new (max>255?Uint16Array:Uint8Array)(steps);
    for(let i=0;i<steps;i++){ const v=(i/(steps-1)-0.5)*k+0.5+shift; t[i]=Math.round(max*(v<0?0:v>1?1:v)); }
    return t;
  }
  // 8-bit RGBA preview pixels, in place (alpha untouched)
  function applyRGBA(px,a){ if(isNeutral(a))return px; const t=table(a,256,255); for(let i=0;i<px.length;i+=4){ px[i]=t[px[i]]; px[i+1]=t[px[i+1]]; px[i+2]=t[px[i+2]]; } return px; }
  // 16-bit interleaved samples, in place; channels = samples per pixel (3 for RGB, 4 for RGBI: the 4th is left alone)
  function apply16(v,a,channels=3){ if(isNeutral(a))return v; const t=table(a,16384,65535);
    for(let i=0;i<v.length;i++) if(i%channels<3) v[i]=t[v[i]>>2]; return v; }
  globalThis.Adjust={norm,isNeutral,table,applyRGBA,apply16};
})();
