const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../experimental.html'),'utf8');
const code=html.slice(html.indexOf('function tiff('),html.indexOf('function download('));
const context={Uint8Array,Uint16Array,ArrayBuffer,DataView};vm.createContext(context);
vm.runInContext(code+'\nglobalThis.exports={tiff,rawTiffPayload};',context);
const {tiff,rawTiffPayload}=context.exports;
function parse(buf){
 const b=Buffer.from(buf);assert.equal(b.toString('ascii',0,2),'II');assert.equal(b.readUInt16LE(2),42);
 const at=b.readUInt32LE(4),n=b.readUInt16LE(at),tags={};
 for(let i=0;i<n;i++){const o=at+2+i*12;tags[b.readUInt16LE(o)]={type:b.readUInt16LE(o+2),count:b.readUInt32LE(o+4),value:b.readUInt32LE(o+8)};}
 return {b,tags,pixels:b.subarray(tags[273].value,tags[273].value+tags[279].value)};
}
const bytes=Uint8Array.from([0,0,1,0,255,255,0,128,0x34,0x12,0xfe,0xff]);
const scan={raw:{bytes,g:{pixels:2,lincnt:1,dpi:1440,yres:2880,shift:{r:0,g:10,b:19}},pass:'first RGB pass',hardwareShading:true},meta:{capture:'test'}};
const a=rawTiffPayload(scan),p=parse(a.buffer);
assert.deepEqual(p.pixels,Buffer.from(bytes));assert.equal(p.tags[256].value,2);assert.equal(p.tags[257].value,1);
assert.equal(p.tags[274].value,1);assert.equal(p.b.readUInt32LE(p.tags[282].value),1440);assert.equal(p.b.readUInt32LE(p.tags[283].value),2880);
assert.deepEqual([...new Uint16Array(a.buffer,p.tags[258].value,3)],[16,16,16]);
assert(Object.values(a.metadata.transforms).every(v=>v===false));assert.equal(a.metadata.hardwareShadingApplied,true);
// Neither exporter depends on the preview control. The source RGB bytes stay unchanged.
context.document={getElementById:()=>({checked:true})};const invertedPreview=rawTiffPayload(scan);
context.document={getElementById:()=>({checked:false})};const plainPreview=rawTiffPayload(scan);
assert.deepEqual(Buffer.from(invertedPreview.buffer),Buffer.from(plainPreview.buffer));
const planes=[[0,65535],[0x1234,32768],[1,65534]].map(a=>new Uint16Array(a));
const processed=parse(tiff(planes,null,2,1,3600,7200));
assert.deepEqual([...new Uint16Array(processed.pixels.buffer,processed.pixels.byteOffset,6)],[0,0x1234,1,65535,32768,65534]);
const ir=parse(tiff(planes,new Uint16Array([100,200]),2,1,3600,7200));assert.equal(ir.tags[338].value,0);
assert.throws(()=>tiff(null,null,3,1,0,0,bytes),/complete/);
console.log('Raw TIFF sample bytes, all rows, RGB16 tags, X/Y DPI, preview independence, processed values and IR tags passed');
// Optional real USB main-image fixtures; no PCAPs or pixel fixtures are included in the source archive.
for(const arg of process.argv.slice(2)){
 const raw=fs.readFileSync(arg),dims={34735200:[2050,2824,1440],175896576:[4608,6362,3600],216991152:[5124,7058,3600]}[raw.length];
 assert(dims,'Unknown capture fixture size');
 const [w,h,x]=dims,y=x*2;
 const out=tiff(null,null,w,h,x,y,raw),actual=parse(out);
 assert.deepEqual(actual.pixels,raw);assert.equal(actual.tags[257].value,h);
 console.log(path.basename(arg)+': TIFF strip is byte-for-byte identical to full USB main frame ('+raw.length+' bytes)');
}
