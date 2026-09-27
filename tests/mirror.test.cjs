// Horizontal flip: mirrored output must equal the unflipped output with every row reversed,
// for the aligned TIFF (separate and in place, averaged and full) and the preview planes.
const assert=require('node:assert/strict');
require('../capture_profiles.js');require('../capture_runtime.js');
const P=17,L=48,shifts=[0,1.5,3];
for(const dpi of [3600,7200]){
  const profile={dpi,yres:dpi*2,shifts,mainFrame:0,name:'mirror fixture',frames:[{pixels:P,lines:L,bytes:P*L*6,regs:{37:0,38:0,39:L}}]};
  const g=CaptureRuntime.geometry(profile),bytes=new Uint8Array(P*L*6),v=new Uint16Array(bytes.buffer);
  for(let i=0;i<v.length;i++)v[i]=(i*7919+13*(i%P))%60000;           // distinct, position-dependent samples
  const rev=(data,w,h)=>{const a=new Uint16Array(data.buffer,data.byteOffset,data.byteLength>>1),o=new Uint16Array(a.length);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)for(let c=0;c<3;c++)o[(y*w+w-1-x)*3+c]=a[(y*w+x)*3+c];return o;};
  for(const average of [false,true]){
    const plain=CaptureRuntime.alignedFrame(bytes,g,{average});
    const flipped=CaptureRuntime.alignedFrame(bytes,g,{average,mirror:true});
    assert(flipped.mirrored&&!plain.mirrored);
    assert.deepEqual(new Uint16Array(flipped.data.buffer,flipped.data.byteOffset,flipped.data.byteLength>>1),rev(plain.data,plain.width,plain.height),`dpi ${dpi} average ${average}`);
    if(average){
      const copy=new Uint8Array(bytes),inPlace=CaptureRuntime.alignedFrame(copy,g,{average,inPlace:true,mirror:true});
      assert.deepEqual(Buffer.from(inPlace.data),Buffer.from(flipped.data),'in-place mirrored matches separate output');
    }
  }
  const a=CaptureRuntime.previewPlanes(bytes,g,10),b=CaptureRuntime.previewPlanes(bytes,g,10,null,true),W=a.g.pixels;
  for(let c=0;c<3;c++)for(let y=0;y<a.g.lines;y++)for(let x=0;x<W;x++)assert.equal(b.planes[c][y*W+W-1-x],a.planes[c][y*W+x]);
}
console.log('Mirror: aligned TIFF (full/averaged, separate/in place, 3600/7200 stagger) and preview planes flip exactly');
