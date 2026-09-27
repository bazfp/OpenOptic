/* Roll scanning: naming, one-frame pipeline, save-then-release, records. No DOM dependencies.
   Needs CaptureRuntime (capture_runtime.js). The UI injects acquisition, file storage and
   preview rendering, so the whole flow can be exercised headlessly (tests/roll.test.cjs). */
(() => {
  const VERSION='roll-1';
  const ORIENTATIONS={1:'as scanned',6:'rotate 90° clockwise',8:'rotate 90° counter-clockwise',3:'rotate 180°'};
  class NameInUse extends Error{constructor(names){super('Already in the folder: '+names.join(', '));this.names=names;}}
  class SaveFailed extends Error{constructor(cause,pending){super('Could not save: '+(cause?.message||cause));this.cause=cause;this.pending=pending;}}

  // Letters, digits and . _ - + ( ) and spaces; nothing that could name another folder.
  function cleanPrefix(s){
    return String(s??'').replace(/[^A-Za-z0-9._\-+() ]/g,'').replace(/^[.\s]+/,'').slice(0,64);
  }
  function baseName(prefix,number,digits){
    assert(Number.isInteger(number)&&number>=0&&number<=999999,'Frame number must be 0–999999');
    return cleanPrefix(prefix)+String(number).padStart(digits||2,'0');
  }
  function fileNames(settings,number){
    const b=baseName(settings.prefix,number,settings.digits), n=[];
    if(settings.tiff!=='raw')n.push({kind:'tiff',name:b+'.tif'});
    if(settings.tiff!=='aligned')n.push({kind:'raw-tiff',name:b+'_raw.tif'});
    n.push({kind:'sidecar',name:b+'.json'});
    if(settings.jpeg)n.push({kind:'jpeg',name:b+'_preview.jpg'});
    return n;
  }
  function manifestName(settings){return (cleanPrefix(settings.prefix).replace(/[_\-. ]+$/,'')||'roll')+'_roll.json';}
  function assert(ok,msg){if(!ok)throw new Error(msg);}

  // Acquire one frame. Checks the names are free BEFORE moving the carriage.
  async function scanFrame(ctx){
    const {settings,number,overwrite=false}=ctx, names=fileNames(settings,number);
    if(!overwrite){
      const taken=await ctx.store.exists(names.map(n=>n.name));
      if(taken.length)throw new NameInUse(taken);
    }
    const started=new Date(), {bytes,profile,trace,lamp}=await ctx.acquire(settings.profile);
    const align=CaptureRuntime.measureShifts(bytes,profile), g=CaptureRuntime.geometry(profile,align.shifts);
    const offsets=settings.blackLevel&&lamp?.dark?lamp.dark.delta:null;   // per-channel black-level correction
    const pv=CaptureRuntime.previewPlanes(bytes,g,1200,offsets,settings.mirror!==false);
    const preview=await ctx.makePreview(pv.planes,pv.g,settings);   // {large, thumb} (data URLs in the UI)
    const pending={number,base:baseName(settings.prefix,number,settings.digits),names,overwrite,
      settings:{...settings},started:started.toISOString(),bytes,profile,g,align,lamp:lamp||null,offsets,preview,trace:trace||null,saved:[]};
    return saveFrame(ctx,pending);
  }

  // Save every output of a pending frame, then drop the full-resolution data. Resumable: a
  // retry skips files already written. On failure the pending frame (still holding the image)
  // travels with the SaveFailed error so the UI can offer Retry / Discard.
  async function saveFrame(ctx,pending){
    const {settings,g,bytes,profile,align}=pending, log=ctx.log||(()=>{});
    const done=new Set(pending.saved.map(f=>f.name));
    const put=async(kind,name,parts,meta={})=>{
      if(done.has(name))return;
      const r=await ctx.store.save(name,parts,{overwrite:pending.overwrite});
      pending.saved.push({kind,name,bytes:r.bytes,sha256:r.sha256||null,...meta});done.add(name);
      log(`saved ${name} (${(r.bytes/1048576).toFixed(1)} MB)`);
    };
    const desc=`${pending.base} OpticFilm 7600i ${profile.name}`;
    try{
      for(const {kind,name} of pending.names){
        if(done.has(name))continue;
        if(kind==='tiff'){
          // convert once (a retry reuses it): with no raw-TIFF output and averaged pixels the
          // conversion may reuse the source buffer, halving peak memory on large scans
          const average=settings.pixels!=='full', inPlace=average&&!pending.names.some(n=>n.kind==='raw-tiff');
          let a=pending.aligned||(pending.aligned=CaptureRuntime.alignedFrame(bytes,g,{average,offsets:pending.offsets,inPlace,mirror:settings.mirror!==false,filter:settings.pixels==='lanczos'?'lanczos3':'box'}));
          const h=CaptureRuntime.tiffHeader(a.width,a.height,a.xdpi,a.ydpi,{orientation:settings.orientation,description:desc});
          const meta={width:a.width,height:a.height,xDpi:a.xdpi,yDpi:a.ydpi,verticalSamplesAveraged:a.averaged,lineFilter:a.filter};
          await put(kind,name,[h,a.data],meta);
        }else if(kind==='raw-tiff'){
          const h=CaptureRuntime.tiffHeader(g.pixels,g.lincnt,g.dpi,g.yres,{orientation:1,description:desc+' raw USB samples, channels not aligned'});
          await put(kind,name,[h,bytes],{width:g.pixels,height:g.lincnt,xDpi:g.dpi,yDpi:g.yres});
        }else if(kind==='jpeg'){
          const blob=await ctx.previewJpeg(pending.preview);
          if(blob)await put(kind,name,[blob]);
        }
      }
      const side=sidecar(pending);
      const sideName=pending.names.find(n=>n.kind==='sidecar').name;
      await put('sidecar',sideName,[JSON.stringify(side,null,2)]);
    }catch(e){throw new SaveFailed(e,pending);}
    return release(pending);
  }

  function sidecar(p){
    const {settings,g,profile,align}=p, f=profile.frames[profile.mainFrame];
    return {format:VERSION,frame:p.base,number:p.number,scanned:p.started,
      device:'Plustek OpticFilm 7600i (07b3:0c3b, GL843, bcdDevice 4.00)',
      film:settings.film,orientation:{tiffTag:settings.orientation,meaning:ORIENTATIONS[settings.orientation]},
      files:p.saved.filter(s=>s.kind!=='sidecar'),
      acquisition:{profile:profile.name,sourceCapture:profile.source,sourceCaptureSha256:profile.sha256,
        samplingDpi:{x:g.dpi,y:g.yres},delivered:{width:g.pixels,lines:g.lincnt},
        registers:f.regs,moves:profile.moves,
        options:profile.acquisitionOptions||{pixelSampling:'deletion',exposureMultiplier:1,
          averagingReducesPixels:false,calibration:'recorded vendor AFE and shading'},
        illuminationCheck:p.lamp?{...p.lamp,reference:profile.lamp,limits:CaptureRuntime.LAMP_LIMITS}:null,
        hardwareShading:'recorded vendor shading tables applied by the scanner before USB transfer'},
      processing:{channelShiftLines:align.shifts,channelShiftSource:align.used,channelShiftConfidence:align.confidence,
        recordedChannelShifts:profile.shifts,interpolation:settings.pixels==='lanczos'?'Lanczos-3 kernel (alignment and line reduction in one resample)':'linear between bracketing lines',
        columnStagger:{rawLineOffsets:g.stagger||[],
          order:'native even/odd columns, before orientation',
          appliedTo:'aligned TIFF and preview; raw USB TIFF unchanged',
          extraRawLinesTrimmed:g.stagger?.length?Math.max(...g.stagger):0},
        horizontalMirror:settings.mirror!==false?{applied:true,appliedTo:'aligned TIFF and preview; raw USB TIFF unchanged',order:'after channel alignment and column stagger, before the TIFF orientation tag'}:{applied:false},
        verticalAveraging:settings.pixels==='full'?'none':settings.pixels==='lanczos'?`Lanczos-3 resampling, ${Math.round(g.yres/g.dpi)}:1, combined with channel alignment (12 taps per channel)`:`${Math.round(g.yres/g.dpi)} lines averaged per output row`,
        blackLevelCorrection:p.offsets?{counts:p.offsets,note:'per-channel dark-frame difference from the recorded AFE offset calibration, subtracted from the image'}:null,
        inversion:false,levels:false,gamma:false,
        note:'TIFF values are the scanner\'s linear 16-bit output: not inverted, not colour balanced. Preview inversion applies to the on-screen image and preview JPEG only.'}};
  }

  // Keep only what the roll list needs; the multi-hundred-MB buffers become unreachable here.
  function release(p){
    const rec={number:p.number,base:p.base,scanned:p.started,film:p.settings.film,profile:p.profile.name,
      orientation:p.settings.orientation,mirror:p.settings.mirror!==false,files:p.saved.map(({kind,name,bytes,sha256,width,height})=>({kind,name,bytes,sha256,width,height})),
      shifts:p.align.shifts,shiftConfidence:p.align.confidence,lampWarning:p.lamp?.warning||null,thumb:p.preview?.thumb||null,large:p.preview?.large||null,status:'saved'};
    p.bytes=null;p.g=null;p.preview=null;p.trace=null;p.aligned=null;
    return rec;
  }

  function manifest(settings,records){
    return {format:VERSION,roll:cleanPrefix(settings.prefix),updated:new Date().toISOString(),
      settings:{digits:settings.digits,tiff:settings.tiff,mirror:settings.mirror!==false,pixels:settings.pixels,film:settings.film,orientation:settings.orientation,profile:settings.profile,pixelSampling:settings.pixelSampling||'deletion',exposureMultiplier:Number(settings.exposureMultiplier??1)},
      frames:records.map(({thumb,large,...r})=>r)};
  }

  async function nextFree(store,settings,from,limit=10000){
    for(let n=from;n<from+limit&&n<=999999;n++){
      const taken=await store.exists(fileNames(settings,n).map(f=>f.name));
      if(!taken.length)return n;
    }
    throw new Error('No free number found');
  }

  globalThis.Roll={VERSION,ORIENTATIONS,NameInUse,SaveFailed,cleanPrefix,baseName,fileNames,manifestName,scanFrame,saveFrame,manifest,nextFree};
})();
