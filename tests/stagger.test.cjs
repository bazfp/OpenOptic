const assert=require('node:assert/strict');
require('../capture_profiles.js');require('../capture_runtime.js');
for(const key of ['prescan','full'])assert.deepEqual(CaptureRuntime.geometry(CAPTURE_PROFILES[key]).stagger,[]);
const real=CaptureRuntime.geometry(CAPTURE_PROFILES.full7200);
assert.deepEqual(real.stagger,[8,0]);assert.equal(real.lines,14018);assert.equal(Math.floor(real.lines/2),7009);
// Even columns see the scene eight raw lines late. A linear signal gives an
// exact oracle for fractional RGB delays as well as the column stagger.
const P=16,L=48,shifts=[0,1.5,3],profile={dpi:7200,yres:14400,shifts,mainFrame:0,name:'stagger fixture',frames:[{pixels:P,lines:L,bytes:P*L*6,regs:{37:0,38:0,39:L}}]};
const g=CaptureRuntime.geometry(profile),bytes=new Uint8Array(P*L*6),v=new Uint16Array(bytes.buffer);
const scene=(y,c)=>10000+200*y+1000*c;
for(let y=0;y<L;y++)for(let x=0;x<P;x++)for(let c=0;c<3;c++)v[(y*P+x)*3+c]=scene(y-(x%2===0?8:0)-shifts[c],c);
const before=Buffer.from(bytes),decoded=CaptureRuntime.decode(bytes,g);
for(let y=0;y<g.lines;y++)for(let x=0;x<P;x++)for(let c=0;c<3;c++)assert.equal(decoded[c][y*P+x],scene(y,c));
for(const average of [false,true]){
 const a=CaptureRuntime.alignedFrame(bytes,g,{average}),k=average?2:1,values=new Uint16Array(a.data.buffer,a.data.byteOffset,a.data.length/2);
 for(let y=0;y<a.height;y++)for(let x=0;x<P;x++)for(let c=0;c<3;c++)assert.equal(values[(y*P+x)*3+c],scene(y*k+(k-1)/2,c),'stagger before averaging');
 if(average){const copy=new Uint8Array(bytes);const inPlace=CaptureRuntime.alignedFrame(copy,g,{average,inPlace:true});assert.deepEqual(Buffer.from(inPlace.data),Buffer.from(a.data),'in-place matches separate output');}
}
assert.deepEqual(Buffer.from(bytes),before,'source/raw USB samples unchanged');
// Compare preview to an independently de-staggered buffer. The parity must refer
// to the source column, not the thumbnail column after downsampling.
const corrected=new Uint8Array(bytes.length),cv=new Uint16Array(corrected.buffer);
for(let y=0;y<L-8;y++)for(let x=0;x<P;x++)for(let c=0;c<3;c++)cv[(y*P+x)*3+c]=v[((y+(x%2===0?8:0))*P+x)*3+c];
for(const maxDim of [5,100]){
 const actual=CaptureRuntime.previewPlanes(bytes,g,maxDim),expected=CaptureRuntime.previewPlanes(corrected,{...g,stagger:[]},maxDim);
 assert.deepEqual(actual.planes,expected.planes,'preview source-column parity');
}
const edge=new Uint8Array(bytes.length),ev=new Uint16Array(edge.buffer);
for(let y=0;y<L;y++)for(let x=0;x<P;x++)for(let c=0;c<3;c++)ev[(y*P+x)*3+c]=y-(x%2===0?8:0)>=20?60000:1000;
const eg=CaptureRuntime.geometry(profile,[0,0,0]),out=CaptureRuntime.alignedFrame(edge,eg),ov=new Uint16Array(out.data.buffer);
for(let x=0;x<P;x++){assert.equal(ov[(9*P+x)*3],1000);assert.equal(ov[(10*P+x)*3],60000);}
console.log('Stagger: 7200-only geometry, direction/parity, sharp edge, RGB interpolation, in-place TIFF, preview and raw preservation passed');
// Exercise the actual roll export path: corrected TIFF and unmodified raw TIFF,
// with metadata describing the correction in native scan coordinates.
require('../roll.js');
(async()=>{
 const saved=new Map();
 await Roll.scanFrame({settings:{prefix:'stagger_',digits:1,tiff:'both',pixels:'square',profile:'full7200',orientation:3,film:'neg'},number:1,
  acquire:async()=>({bytes:new Uint8Array(bytes),profile}),
  makePreview:async()=>({thumb:'',large:''}),
  store:{exists:async()=>[],save:async(name,parts)=>{const b=Buffer.from(await new Blob(parts).arrayBuffer());saved.set(name,b);return {bytes:b.length};}}});
 const side=JSON.parse(saved.get('stagger_1.json'));
 assert.deepEqual(side.processing.columnStagger.rawLineOffsets,[8,0]);
 assert.equal(side.processing.columnStagger.extraRawLinesTrimmed,8);
 const raw=saved.get('stagger_1_raw.tif');
 assert.deepEqual(raw.subarray(raw.length-bytes.length),Buffer.from(bytes));
 assert.equal(side.files.find(f=>f.kind==='tiff').height,Math.floor(g.lines/2));
 console.log('Roll export: raw samples unchanged, aligned height trimmed, stagger metadata saved');
})().catch(e=>{console.error(e);process.exit(1);});
