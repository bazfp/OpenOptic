const assert=require('node:assert/strict');require('../capture_runtime.js');
// Actual test07 offsets: saturated green used to wrap 65535 + 19.9 to 19.
const samples=[0,1,100,65510,65515,65516,65534,65535], offsets=[23.7,-19.9,58];
for(const inPlace of [false,true]){
 const P=samples.length,L=6,bytes=new Uint8Array(P*L*6),src=new Uint16Array(bytes.buffer);
 for(let y=0;y<L;y++)for(let x=0;x<P;x++)for(let c=0;c<3;c++)src[(y*P+x)*3+c]=samples[x];
 const g={pixels:P,lines:4,lincnt:L,totalBytes:bytes.length,dpi:7200,yres:14400,shift:{r:0,g:.5,b:1}};
 const pv=CaptureRuntime.previewPlanes(bytes,g,100,offsets);
 const aligned=CaptureRuntime.alignedFrame(bytes,g,{offsets,inPlace});
 const out=new Uint16Array(aligned.data.buffer,aligned.data.byteOffset,aligned.data.byteLength/2);
 for(let y=0;y<2;y++)for(let x=0;x<P;x++)for(let c=0;c<3;c++){
   const want=Math.min(65535,Math.max(0,Math.round(samples[x]-offsets[c])));
   assert.equal(out[(y*P+x)*3+c],want,`TIFF x${x} c${c} inPlace=${inPlace}`);
   assert.equal(pv.planes[c][y*P+x],want,`preview x${x} c${c}`);
 }
 assert.equal(out[(P-1)*3+1],65535);
}
// Positive/negative boundary correction, and 1x vertical sampling (non-in-place).
for(const offset of [-100,-19.9,0,23.7,100]){
 const bytes=new Uint8Array(12);new Uint16Array(bytes.buffer).set([0,0,0,65535,65535,65535]);
 const g={pixels:2,lines:1,lincnt:1,totalBytes:12,dpi:7200,yres:7200,shift:{r:0,g:0,b:0}};
 const r=CaptureRuntime.alignedFrame(bytes,g,{average:false,offsets:[offset,offset,offset]});
 const got=new Uint16Array(r.data.buffer);
 assert.equal(got[0],Math.min(65535,Math.max(0,Math.round(-offset))));
 assert.equal(got[3],Math.min(65535,Math.max(0,Math.round(65535-offset))));
}
console.log('Saturation regression passed: TIFF and preview, both bounds, fractional alignment, in-place and separate output');
