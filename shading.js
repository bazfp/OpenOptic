/* Software flat-field for the OpticFilm 8100. The chip applies no shading to its data, so the host does: for every
   sensor pixel the black level is kept and the signal above it is scaled so that the lamp's falloff towards the
   edges (about 15-18 %) and the pixel-to-pixel gain differences (about 1.4 %) disappear, with the centre of the
   frame unchanged. The reference (shading_8100.js, built by tools/build_shading_8100.py from the free trial software's white
   calibration pass) is per sensor pixel on the 7200 dpi grid; a scan at DPISET d samples every (1200/d)-th pixel.
   No DOM; tested in tests/shading.test.cjs. Raw 16-bit little-endian RGB, 6 bytes per pixel, in place. */
(() => {
  const SATURATED=65000, MIN_GAIN=0.5, MAX_GAIN=3;
  const fromBase64=s=>typeof atob==='function'?Uint8Array.from(atob(s),c=>c.charCodeAt(0)):Uint8Array.from(Buffer.from(s,'base64'));
  function load(ref){
    const b=fromBase64(ref.white), white=new Uint16Array(b.buffer,b.byteOffset,b.length/2);   // little-endian hosts only, checked in apply
    if(white.length!==ref.pixels*3)throw new Error('shading reference is the wrong size');
    const c0=Math.floor(ref.pixels*0.3), c1=Math.floor(ref.pixels*0.7), centre=[0,1,2].map(c=>{
      const v=[]; for(let i=c0;i<c1;i++)if(white[i*3+c]<SATURATED)v.push(white[i*3+c]); v.sort((a,b)=>a-b); return v[v.length>>1]; });
    return {str:ref.str,pixels:ref.pixels,white,dark:ref.dark,centre};
  }
  // Gain per output pixel and channel for a scan with geometry {str, dpiset, pixels}. Columns the reference cannot vouch for
  // (outside it, saturated, or barely above black) are left alone (gain 1).
  function gains(r,geom){
    const k=1200/geom.dpiset; if(!Number.isInteger(k)||k<1)throw new Error('shading: DPISET '+geom.dpiset+' does not divide the 1200 grid');
    const g=new Float32Array(geom.pixels*3).fill(1);
    for(let i=0;i<geom.pixels;i++){ const j=geom.str+i*k-r.str; if(j<0||j>=r.pixels)continue;
      for(let c=0;c<3;c++){ const w=r.white[j*3+c], span=w-r.dark[c];
        if(w>=SATURATED||span<2000)continue;
        g[i*3+c]=Math.max(MIN_GAIN,Math.min(MAX_GAIN,(r.centre[c]-r.dark[c])/span)); } }
    return g;
  }
  function apply(bytes,geom,lines,ref){
    if(new Uint8Array(new Uint16Array([1]).buffer)[0]!==1)throw new Error('shading needs a little-endian host');
    if(bytes.length!==geom.pixels*lines*6)throw new Error('shading: data does not match the geometry');
    const r=ref.centre?ref:load(ref), g=gains(r,geom);
    const v=bytes.byteOffset%2===0?new Uint16Array(bytes.buffer,bytes.byteOffset,bytes.length/2):null;
    if(!v)throw new Error('shading: data is not 16-bit aligned');
    const row=geom.pixels*3;
    for(let y=0;y<lines;y++){ const o=y*row;
      for(let s=0;s<row;s++){ const c=s%3, d=r.dark[c], x=v[o+s], y1=d+(x-d)*g[s]; v[o+s]=y1<0?0:y1>=65535?65535:y1+0.5; } }
    return bytes;
  }
  globalThis.Shading={load,gains,apply};
})();
