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
    if(settings.infrared==='detect')n.push({kind:'ir',name:b+'_ir.tif'});
    if(settings.infrared==='detect'||settings.infrared==='repair')n.push({kind:'mask',name:b+'_irmask.png'});
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
    const started=new Date(), acq=await ctx.acquire(settings.profile), {bytes,profile,trace,lamp,positioning}=acq;
    const align=CaptureRuntime.measureShifts(bytes,profile), g=CaptureRuntime.geometry(profile,align.shifts);
    const offsets=settings.blackLevel&&lamp?.dark?lamp.dark.delta:null;   // per-channel black-level correction
    const pending={number,base:baseName(settings.prefix,number,settings.digits),names,overwrite,
      settings:{...settings},started:started.toISOString(),bytes,profile,g,align,lamp:lamp||null,positioning:positioning||null,offsets,preview:null,trace:trace||null,saved:[]};
    let pv;
    if(acq.long||acq.ir){
      await processPasses(pending,acq,ctx.log||(()=>{}));
      const P=pending.aligned, rgb=new Uint16Array(P.data.buffer,P.data.byteOffset,P.data.byteLength>>1);
      pv=Enhance.previewFromAligned(rgb,P.width,P.height,1200);
    }else pv=CaptureRuntime.previewPlanes(bytes,g,1200,offsets,settings.mirror!==false);
    const display=pending.processing?.multiExposure?.mode==='fusion';
    pending.preview=await ctx.makePreview(pv.planes,pv.g,display?{...settings,film:'display'}:settings);   // {large, thumb}
    return saveFrame(ctx,pending);
  }

  // Extra passes (multi-exposure long pass, infrared pass): align every pass on the colour pass's
  // grid, then merge or fuse the exposures and detect/repair defects with the IR plane. The result
  // becomes pending.aligned (what the TIFF writer saves); the raw colour bytes stay for a raw TIFF.
  async function processPasses(p,acq,log){
    const s=p.settings, average=s.pixels!=='full', filter=s.pixels==='lanczos'?'lanczos3':'box', mirror=s.mirror!==false;
    const keepRaw=p.names.some(n=>n.kind==='raw-tiff');
    const alignPass=(bytes,profile,inPlace)=>CaptureRuntime.alignedFrame(bytes,CaptureRuntime.geometry(profile,p.align.shifts),{average,inPlace,mirror,filter});
    const a=alignPass(p.bytes,p.profile,!keepRaw&&average), W=a.width, H=a.height;
    const rgb=new Uint16Array(a.data.buffer,a.data.byteOffset,a.data.byteLength>>1);
    const darkS=p.lamp?.dark?.mean||[1000,1000,1000];
    const info={}, t0=Date.now();
    // 1. infrared: detect on the linear colour pass (defects are dark there; registration needs it)
    let det=null, mask=null;
    if(acq.ir){
      const I=alignPass(acq.ir.bytes,acq.ir.profile,average); acq.ir.bytes=null;
      const irgb=new Uint16Array(I.data.buffer,I.data.byteOffset,I.data.byteLength>>1), ir=new Uint16Array(W*H);
      for(let i=0;i<W*H;i++) ir[i]=irgb[i*3];          // IR is read by the red row
      det=Enhance.irDetect(ir,rgb,W,H,{darkC:darkS}); mask=Enhance.dilate(det.core,W,H,2);
      info.infrared={mode:s.infrared,registration:det.registration,ghost:det.ghost,defectCoverage:det.coverage,irMedian:det.irMedian,irBlocked:det.irBlocked};
      if(det.irBlocked){ info.infrared.note='infrared blocked by the film (B&W silver image or Kodachrome?): no repair'; log('infrared: the film blocks IR (silver image?); not repaired'); }
      if(s.infrared==='detect'){ const out=new Uint16Array(W*H); for(let i=0;i<W*H;i++) out[i]=Math.min(65535,Math.max(0,Math.round(det.ir[i]))); p.irPlane={data:new Uint8Array(out.buffer),width:W,height:H}; }
      log(`infrared: ${det.coverage} % defects, offset ${det.registration.dy.toFixed(2)}/${det.registration.dx.toFixed(2)} px${det.registration.ok?'':' (not registered: '+det.registration.reason+')'}`);
    }
    const repairing=det&&!det.irBlocked&&s.infrared==='repair';
    const repair=(img,label)=>{ const r=Enhance.irRepair(img,W,H,det); mask=r.mask;
      info.infrared.repair={inpaintedPixels:r.inpainted,filledDefects:r.filledComponents,dividedDefects:r.dividedComponents,attenuationExponent:r.gamma,method:r.method,
        note:'compact defects filled by exemplar inpainting (patch-based, keeps grain); large faint ones divided by IR transmission^γ'};
      log(`infrared repair${label}: ${r.filledComponents} defects filled (${r.inpainted} px), ${r.dividedComponents} large ones corrected`); };
    // 2. multi-exposure
    if(acq.long){
      const L=alignPass(acq.long.bytes,acq.long.profile,average); acq.long.bytes=null;
      let lrgb=new Uint16Array(L.data.buffer,L.data.byteOffset,L.data.byteLength>>1);
      const green=x=>{ const g=new Float32Array(W*H); for(let i=0;i<W*H;i++) g[i]=x[i*3+1]; return g; };
      const shift=Enhance.registerSame(green(rgb),green(lrgb),W,H);
      const darkL=acq.long.lamp?.dark?.mean||darkS;
      const nm=l=>l?.dark?.noise&&l?.shading?.noise?CaptureRuntime.noiseModel(l.dark.noise,l.shading.noise):null;
      const n1=nm(p.lamp), n2=nm(acq.long.lamp);
      const noise=n1?n1.map((n,c)=>({read:n.read,readLong:n2?n2[c].read:n.read,gain:Math.min(20,n.gain)})):null;
      info.multiExposure={mode:s.multiExposure,factor:acq.long.factor,registration:shift,noiseModel:noise};
      if(s.multiExposure==='fusion'){
        const fits=Enhance.fitPasses(rgb,lrgb,W,H,{darkS,darkL,shift});
        if(repairing){ lrgb=Enhance.shiftRGB(lrgb,W,H,shift.dy,shift.dx); repair(rgb,' (1× pass)'); repair(lrgb,' (long pass)'); }
        const f=Enhance.fuse(rgb,lrgb,W,H,{darkS,darkL,fit:fits,film:s.film,shift:repairing?{dy:0,dx:0}:shift});
        Object.assign(info.multiExposure,{fits,fusion:{method:'Mertens exposure fusion (contrast, saturation, well-exposedness; Laplacian pyramid blend)',
          shortPassWeight:f.shortWeight,black:f.black,output:'display-referred positive (gamma-encoded), not for negative converters'}});
      }else{
        const r=Enhance.mergeRange(rgb,lrgb,W,H,{darkS,darkL,noise,shift});
        Object.assign(info.multiExposure,{fits:r.fits,longPassWeight:r.longWeight,
          method:'per-channel affine fit long = slope·short + offset, inverse-variance blend, long pass faded out at 90–98 % of full scale'});
        if(repairing) repair(rgb,'');
      }
      log(`multi-exposure (${s.multiExposure}): long pass offset ${shift.dy.toFixed(2)}/${shift.dx.toFixed(2)} px, slopes ${info.multiExposure.fits.map(f=>f.slope).join('/')}`);
    }else if(repairing) repair(rgb,'');
    if(mask) p.irMask={data:Uint8Array.from(mask,v=>v?255:0),width:W,height:H};
    log(`extra passes processed in ${((Date.now()-t0)/1000).toFixed(1)} s`);
    // black-level correction as in the normal path (linear output only)
    if(p.offsets&&!info.multiExposure?.fusion) for(let i=0;i<rgb.length;i++){ const v=rgb[i]-p.offsets[i%3]; rgb[i]=v<0?0:v>65535?65535:Math.round(v); }
    p.aligned={...a,data:new Uint8Array(rgb.buffer,rgb.byteOffset,rgb.byteLength),displayReferred:!!info.multiExposure?.fusion};
    p.processing=info;
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
          const note=pending.processing?.multiExposure?` multi-exposure ${pending.processing.multiExposure.mode}${a.displayReferred?' (tone-mapped positive)':''}`:'';
          const h=CaptureRuntime.tiffHeader(a.width,a.height,a.xdpi,a.ydpi,{orientation:settings.orientation,description:desc+note+(pending.processing?.infrared?.repair?' infrared-repaired':'')});
          const meta={width:a.width,height:a.height,xDpi:a.xdpi,yDpi:a.ydpi,verticalSamplesAveraged:a.averaged,lineFilter:a.filter};
          await put(kind,name,[h,a.data],meta);
        }else if(kind==='raw-tiff'){
          const h=CaptureRuntime.tiffHeader(g.pixels,g.lincnt,g.dpi,g.yres,{orientation:1,description:desc+' raw USB samples, channels not aligned'});
          await put(kind,name,[h,bytes],{width:g.pixels,height:g.lincnt,xDpi:g.dpi,yDpi:g.yres});
        }else if(kind==='ir'&&pending.irPlane){
          const q=pending.irPlane, h=CaptureRuntime.tiffHeader(q.width,q.height,pending.aligned.xdpi,pending.aligned.ydpi,{orientation:settings.orientation,channels:1,description:desc+' infrared (registered to the colour image)'});
          await put(kind,name,[h,q.data],{width:q.width,height:q.height});
        }else if(kind==='mask'&&pending.irMask){
          const q=pending.irMask; await put(kind,name,[await Enhance.pngGray(q.data,q.width,q.height)],{width:q.width,height:q.height});
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
        positioningStop:p.positioning?{...p.positioning,note:'first positioning move: stopped on the scanner event 0x08 (interrupt endpoint) when available, else at the recorded time'}:null,
        scanTiming:profile.scan?{lineSel:profile.scan.lineSel,lineSeconds:profile.scan.lineSeconds,bytesPerSecond:profile.scan.bytesPerSecond,motorCruise:profile.motorCruise||'recorded'}:null,
        options:profile.acquisitionOptions||{pixelSampling:'deletion',exposureMultiplier:1,dummyLines:{setting:'recorded',recorded:profile.scan?.lineSel??null,used:profile.scan?.lineSel??null},
          averagingReducesPixels:false,calibration:'recorded vendor AFE and shading'},
        illuminationCheck:p.lamp?{...p.lamp,reference:profile.lamp,limits:CaptureRuntime.LAMP_LIMITS}:null,
        hardwareShading:'recorded vendor shading tables applied by the scanner before USB transfer'},
      processing:{multiExposure:p.processing?.multiExposure||null,infrared:p.processing?.infrared||null,channelShiftLines:align.shifts,channelShiftSource:align.used,channelShiftConfidence:align.confidence,
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
      shifts:p.align.shifts,shiftConfidence:p.align.confidence,lampWarning:p.lamp?.warning||null,enhanced:[p.processing?.multiExposure?'ME':null,p.processing?.infrared?'IR':null].filter(Boolean),thumb:p.preview?.thumb||null,large:p.preview?.large||null,status:'saved'};
    p.bytes=null;p.g=null;p.preview=null;p.trace=null;p.aligned=null;p.irPlane=null;p.irMask=null;
    return rec;
  }

  function manifest(settings,records){
    return {format:VERSION,roll:cleanPrefix(settings.prefix),updated:new Date().toISOString(),
      settings:{digits:settings.digits,tiff:settings.tiff,mirror:settings.mirror!==false,pixels:settings.pixels,film:settings.film,orientation:settings.orientation,profile:settings.profile,pixelSampling:settings.pixelSampling||'deletion',exposureMultiplier:Number(settings.exposureMultiplier??1),dummyLines:settings.dummyLines||'recorded'},
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
