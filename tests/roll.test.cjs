// Headless roll workflow: simulated scanner -> Roll.scanFrame -> in-memory folder.
//   node tests/roll.test.cjs [dir-to-write-files]
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
for(const f of ['capture_profiles.js','capture_runtime.js','capture_sim.js','roll.js'])require(path.join(__dirname,'..',f));
const outDir=process.argv[2];

function folder(){
  const files=new Map();let failNext=null,writes=0;
  return {files,get writes(){return writes;},failOn(name){failNext=name;},
    async exists(names){return names.filter(n=>files.has(n));},
    async save(name,parts,{overwrite}){
      if(failNext===name){failNext=null;throw new Error('disk full (simulated)');}
      if(files.has(name)&&!overwrite)throw new Error('exists: '+name);
      const buf=Buffer.from(await new Blob(parts).arrayBuffer());writes++;
      files.set(name,buf);if(outDir)fs.writeFileSync(path.join(outDir,name),buf);
      return {bytes:buf.length,sha256:crypto.createHash('sha256').update(buf).digest('hex')};
    }};
}
function tiffInfo(b){
  assert.equal(b.toString('ascii',0,2),'II');const ifd=b.readUInt32LE(4),n=b.readUInt16LE(ifd),t={};
  for(let i=0;i<n;i++){const o=ifd+2+i*12;t[b.readUInt16LE(o)]={type:b.readUInt16LE(o+2),count:b.readUInt32LE(o+4),v:b.readUInt32LE(o+8),v16:b.readUInt16LE(o+8)};}
  return {w:t[256].v,h:t[257].v,orientation:t[274].v16,strip:b.subarray(t[273].v,t[273].v+t[279].v),dataOff:t[273].v};
}
(async()=>{
  // naming
  assert.equal(Roll.cleanPrefix('../Roll 7/a<b>'),'Roll 7ab');
  assert.equal(Roll.baseName('Roll12_',7,2),'Roll12_07');assert.equal(Roll.baseName('R',7,4),'R0007');
  assert.deepEqual(Roll.fileNames({prefix:'R_',digits:3,tiff:'both',jpeg:true},5).map(f=>f.name),['R_005.tif','R_005_raw.tif','R_005.json','R_005_preview.jpg']);

  const store=folder();let acquired=0,lastBytes=null,sim=null;
  const ctx=(settings,number,extra={})=>({settings,number,store,log:()=>{},...extra,
    acquire:async key=>{acquired++;const p=CaptureRuntime.prepareProfile(CAPTURE_PROFILES[key],settings);sim=CaptureSim.create(p);
      lastBytes=await CaptureRuntime.run(p,sim,{sleep:async()=>{}});return {bytes:lastBytes,profile:p};},
    makePreview:async(planes,g)=>({thumb:'data:thumb',large:'data:large',w:g.pixels,h:g.lines}),
    previewJpeg:async()=>new Blob([Buffer.from([0xff,0xd8,0xff,0xd9])])});
  const S={prefix:'Roll12_',digits:2,tiff:'aligned',pixels:'square',film:'neg',orientation:8,profile:'prescan',jpeg:false};

  // 1. a frame: saved, aligned, square, orientation tag, released
  const rec=await Roll.scanFrame(ctx(S,1));
  assert.deepEqual([...store.files.keys()],['Roll12_01.tif','Roll12_01.json']);
  const ti=tiffInfo(store.files.get('Roll12_01.tif'));
  assert.deepEqual([ti.w,ti.h,ti.orientation],[2050,Math.floor((2824-20)/2),8]);
  assert(Math.abs(rec.shifts[1]-sim.delays[1])<0.15&&Math.abs(rec.shifts[2]-sim.delays[2])<0.15,'alignment '+rec.shifts+' vs '+sim.delays);
  assert(JSON.stringify(rec).length<5000,'record must not hold image data');
  assert.equal(rec.files[0].sha256,crypto.createHash('sha256').update(store.files.get('Roll12_01.tif')).digest('hex'));
  const side=JSON.parse(store.files.get('Roll12_01.json'));
  assert.equal(side.frame,'Roll12_01');assert.equal(side.files[0].name,'Roll12_01.tif');assert.equal(side.processing.inversion,false);
  console.log(`frame 1: ${ti.w}x${ti.h} TIFF (orientation 8), shifts ${rec.shifts.join('/')} vs simulated ${sim.delays.map(v=>v.toFixed(2)).join('/')}, record ${JSON.stringify(rec).length} B`);

  // The sidecar describes the applied sensor mode and effective register values.
  await Roll.scanFrame(ctx({...S,pixelSampling:'average',exposureMultiplier:'1'},9));
  const averagedSide=JSON.parse(store.files.get('Roll12_09.json'));
  assert.equal(averagedSide.acquisition.options.pixelSampling,'average');
  assert.equal(averagedSide.acquisition.options.exposureMultiplier,1);
  assert(averagedSide.acquisition.registers[3]&0x40);
  assert.equal(side.acquisition.options.pixelSampling,'deletion');
  console.log('averaging choice and effective registers saved to sidecar; default remains deletion');

  // 2. same number is refused before the carriage moves
  const before=acquired;
  await assert.rejects(()=>Roll.scanFrame(ctx(S,1)),e=>e instanceof Roll.NameInUse&&e.names.includes('Roll12_01.tif'));
  assert.equal(acquired,before,'must not scan when the names are taken');
  // ...unless explicitly re-scanning that number
  await Roll.scanFrame(ctx(S,1,{overwrite:true}));
  console.log('existing names refused before scanning; explicit rescan overwrites');

  // 3. save failure keeps the frame for retry; retry writes only what is missing
  store.failOn('Roll12_02.json');
  let pending=null;
  await assert.rejects(()=>Roll.scanFrame(ctx({...S,tiff:'both',jpeg:true},2)),e=>{pending=e.pending;return e instanceof Roll.SaveFailed;});
  assert(pending.bytes&&pending.saved.length===3,'three files written before the failure');
  const w0=store.writes, rec2=await Roll.saveFrame(ctx({...S,tiff:'both',jpeg:true},2),pending);
  assert.equal(store.writes-w0,1,'retry writes only the missing sidecar');
  assert.equal(pending.bytes,null,'image released after save');
  const raw=tiffInfo(store.files.get('Roll12_02_raw.tif'));
  assert(raw.strip.equals(Buffer.from(lastBytes.buffer,lastBytes.byteOffset,lastBytes.byteLength)),'raw TIFF strip = received bytes');
  assert.deepEqual(rec2.files.map(f=>f.kind),['tiff','raw-tiff','jpeg','sidecar']);
  console.log('failed save kept the frame; retry completed it; raw TIFF strip identical to USB data');

  // 4. next free number and manifest
  assert.equal(await Roll.nextFree(store,S,1),3);
  const m=Roll.manifest(S,[rec,rec2]);assert.equal(m.frames.length,2);assert(!('thumb' in m.frames[0]));
  console.log('next free number and roll manifest ok');

  // 4a. black level: the measured dark-frame difference is subtracted and recorded
  {const delta=[0,40,0];
   const ctxB=(settings,number,calibrated=false)=>({...ctx(settings,number),acquire:async key=>{const pr=CAPTURE_PROFILES[key];const sm=CaptureSim.create(pr);
     return {bytes:await CaptureRuntime.run(pr,sm,{sleep:async()=>{}}),profile:pr,lamp:{dark:{delta,ok:false}},calibrated};}});
   const rb=await Roll.scanFrame(ctxB({...S,blackLevel:true},30));
   const side=JSON.parse(store.files.get('Roll12_30.json'));
   assert.deepEqual(side.processing.blackLevelCorrection.counts,delta);
   const withC=tiffInfo(store.files.get('Roll12_30.tif')).strip, off=await Roll.scanFrame(ctxB({...S,blackLevel:false},31));
   const without=tiffInfo(store.files.get('Roll12_31.tif')).strip;
   const g16=(b,i)=>b.readUInt16LE(i*2);
   const diffs=[];for(let i=1;i<3000;i+=3)diffs.push(g16(without,i)-g16(withC,i));
   assert(diffs.every(d=>d===40),'green channel must be 40 counts lower with the correction');
   assert.equal(JSON.parse(store.files.get('Roll12_31.json')).processing.blackLevelCorrection,null);
   await Roll.scanFrame(ctxB({...S,blackLevel:true},32,true));
   const liveSide=JSON.parse(store.files.get('Roll12_32.json'));
   assert.equal(liveSide.processing.blackLevelCorrection,null,'live shading must not receive a second dark correction');
   assert.equal(liveSide.acquisition.options.calibration,'live AFE and shading');
   assert(tiffInfo(store.files.get('Roll12_32.tif')).strip.equals(without));
   console.log('black level: measured difference '+delta.join('/')+' subtracted from the image and recorded in the sidecar');}

  // 4b. preview rendering: a dense highlight band on a negative must stay tonal, not clip
  {const W=200,H=100,pl=[0,1,2].map(()=>new Uint16Array(W*H));
   for(let y=0;y<H;y++)for(let x=0;x<W;x++)for(let c=0;c<3;c++)pl[c][y*W+x]=x<40?500+x*20:8000+((x*97+y*31)%20000);
   const px=CaptureRuntime.renderPreview(pl,{pixels:W,lines:H},'neg');
   const band=[];for(let x=2;x<40;x+=6)band.push(px[(50*W+x)*4]);
   assert(new Set(band).size===band.length&&band[0]>band[band.length-1],'dense band must keep a gradient: '+band);
   const lin=CaptureRuntime.renderRGB(pl,{pixels:W,lines:H},true);let white=0;for(let x=2;x<40;x++)if(lin[(50*W+x)*4]===255)white++;
   console.log(`preview: dense band keeps tone (${band.join(',')}); the old linear render clipped ${white}/38 of it to white`);}

  // 5. full-frame profile, square pixels
  const t=Date.now(),recF=await Roll.scanFrame(ctx({...S,profile:'full',orientation:1},10));
  const tf=tiffInfo(store.files.get('Roll12_10.tif'));
  assert.equal(tf.w,5124);assert(tf.h>=3500&&tf.h<=3505,'height '+tf.h);
  assert(Math.abs(recF.shifts[1]-sim.delays[1])<0.2&&Math.abs(recF.shifts[2]-sim.delays[2])<0.2);
  console.log(`full frame: ${tf.w}x${tf.h} TIFF, ${(store.files.get('Roll12_10.tif').length/1048576).toFixed(0)} MB, shifts ${recF.shifts.join('/')}, ${((Date.now()-t)/1000).toFixed(1)} s`);
})().catch(e=>{console.error(e);process.exit(1);});
