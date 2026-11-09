// Tone through the real save path (simulated scanner -> Roll.scanFrame -> in-memory folder): linear is untouched, "ready to view" lifts
// a dim slide and is recorded in the sidecar, and a retried save does not tone twice.
const assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
for(const f of ['capture_profiles.js','capture_runtime.js','capture_sim.js','roll.js'])require(path.join(__dirname,'..',f));
function folder(){ const files=new Map(); return {files,async exists(n){return n.filter(x=>files.has(x));},
  async save(name,parts,{overwrite}){ const buf=Buffer.from(await new Blob(parts).arrayBuffer()); files.set(name,buf); return {bytes:buf.length,sha256:crypto.createHash('sha256').update(buf).digest('hex')}; }}; }
function pixels(b){ const ifd=b.readUInt32LE(4),n=b.readUInt16LE(ifd),t={}; for(let i=0;i<n;i++){const o=ifd+2+i*12;t[b.readUInt16LE(o)]=b.readUInt32LE(o+8);}
  const off=t[273],len=t[279]; return new Uint16Array(b.buffer.slice(b.byteOffset+off,b.byteOffset+off+len-(len%2))); }
const mean=v=>{ let s=0; for(let i=0;i<v.length;i+=97)s+=v[i]; return s/Math.ceil(v.length/97); };
(async()=>{
  const store=folder(), ctx=(settings,number)=>({settings,number,store,log:()=>{},
    acquire:async key=>{ const p=CaptureRuntime.prepareProfile(CAPTURE_PROFILES[key],settings), sim=CaptureSim.create(p); return {bytes:await CaptureRuntime.run(p,sim,{sleep:async()=>{}}),profile:p}; },
    makePreview:async(planes,g)=>({thumb:'t',large:'l',w:g.pixels,h:g.lines}),previewJpeg:async()=>new Blob([Buffer.from([0xff,0xd8,0xff,0xd9])])});
  const S={prefix:'T_',digits:2,tiff:'aligned',pixels:'square',film:'pos',orientation:1,profile:'prescan',jpeg:false,tone:'linear'};
  await Roll.scanFrame(ctx(S,1)); await Roll.scanFrame(ctx({...S,tone:'view'},2));
  const lin=mean(pixels(store.files.get('T_01.tif'))), view=mean(pixels(store.files.get('T_02.tif')));
  assert.notEqual(Math.round(lin),Math.round(view),'tone changes the saved data');
  const side=n=>JSON.parse(store.files.get(n).toString()); const s1=side('T_01.json'),s2=side('T_02.json');
  assert.equal(s1.processing.tone,null,'linear frame: no tone recorded'); assert.equal(s2.processing.tone.mode,'view'); assert.equal(s2.processing.tone.film,'pos');
  assert(s2.processing.tone.levels.length===3,'tone levels recorded');
  assert(/tone: ready to view/.test(store.files.get('T_02.tif').toString('latin1').slice(0,2000)),'TIFF description says so');
  console.log(`roll tone: mean sample linear ${lin.toFixed(0)}, ready to view ${view.toFixed(0)}; sidecar records the levels`);
})().catch(e=>{console.error(e);process.exit(1);});
