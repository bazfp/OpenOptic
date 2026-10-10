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
  const PREVIEW_MAX=2400;
  async function pngDataURL(px,w,h){ const b=new Uint8Array(await (await Enhance.pngGray(px,w,h)).arrayBuffer()); let s='';
    for(let i=0;i<b.length;i+=0x8000) s+=String.fromCharCode.apply(null,b.subarray(i,i+0x8000)); return 'data:image/png;base64,'+btoa(s); }   // on-screen preview of a saved frame (long side, px)
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
    const started=new Date(), acq=await ctx.acquire(settings.profile), {bytes,profile,trace,lamp,positioning}=acq;
    const align=CaptureRuntime.measureShifts(bytes,profile), g=CaptureRuntime.geometry(profile,align.shifts);
    const offsets=!acq.calibrated&&settings.blackLevel&&lamp?.dark?lamp.dark.delta:null;
    const pending={number,base:baseName(settings.prefix,number,settings.digits),names,overwrite,
      settings:{...settings},started:started.toISOString(),bytes,profile,g,align,lamp:lamp||null,positioning:positioning||null,
      calibrated:!!acq.calibrated,offsets,preview:null,trace:trace||null,saved:[]};
    let pv;
    if(acq.long||acq.ir){
      await processPasses(pending,acq,ctx.log||(()=>{}),ctx.progress);
      const P=pending.aligned, rgb=new Uint16Array(P.data.buffer,P.data.byteOffset,P.data.byteLength>>1);
      pv=Enhance.previewFromAligned(rgb,P.width,P.height,PREVIEW_MAX);
    }else pv=CaptureRuntime.previewPlanes(bytes,g,PREVIEW_MAX,offsets,settings.mirror!==false);
    const display=!!pending.aligned?.displayReferred;   // fused output is a negative too (since v1.x older frames could be positives)
    pending.preview=await ctx.makePreview(pv.planes,pv.g,display?{...settings,film:'display'}:settings);   // {large, thumb}
    return saveFrame(ctx,pending);
  }

  // Extra passes (multi-exposure long pass, infrared pass): align every pass on the colour pass's
  // grid, then merge or fuse the exposures and detect/repair defects with the IR plane. The result
  // becomes pending.aligned (what the TIFF writer saves); the raw colour bytes stay for a raw TIFF.
  async function processPasses(p,acq,log,report){
    const s=p.settings, average=s.pixels!=='full', filter=s.pixels==='lanczos'?'lanczos3':'box', mirror=s.mirror!==false;
    const keepRaw=p.names.some(n=>n.kind==='raw-tiff');
    const alignPass=(bytes,profile,inPlace)=>CaptureRuntime.alignedFrame(bytes,CaptureRuntime.geometry(profile,p.align.shifts),{average,inPlace,mirror,filter});
    const a=alignPass(p.bytes,p.profile,!keepRaw&&average), W=a.width, H=a.height;
    const rgb=new Uint16Array(a.data.buffer,a.data.byteOffset,a.data.byteLength>>1);
    const darkS=p.lamp?.dark?.mean||[1000,1000,1000];
    const info={}, t0=Date.now();
    // progress across the steps this frame needs, weighted by their typical time
    const repairingPlanned=acq.ir&&s.infrared==='repair', fusing=acq.long&&s.multiExposure==='fusion';
    const plan=[acq.ir&&['ir-align','Aligning the infrared pass',1],acq.ir&&['detect','Finding dust and scratches',8],acq.long&&['long-align','Aligning the long exposure',1],
      acq.long&&!fusing&&['merge','Merging the exposures',1],repairingPlanned&&['repair','Repairing dust and scratches',fusing?4:2],fusing&&['fuse','Fusing the exposures',8]].filter(Boolean);   // in the order they run
    const total=plan.reduce((a,x)=>a+x[2],0);
    const stage=key=>{ const i=plan.findIndex(x=>x[0]===key), before=plan.slice(0,i).reduce((a,x)=>a+x[2],0), [,label,w]=plan[i];
      return f=>{ if(report) report(label,(before+w*Math.min(1,Math.max(0,f)))/total); }; };
    const tick=async(key)=>{ stage(key)(0); await new Promise(r=>setTimeout(r,0)); };
    // 1. infrared: detect on the linear colour pass (defects are dark there; registration needs it)
    let det=null, mask=null;
    if(acq.ir){
      await tick('ir-align');
      const I=alignPass(acq.ir.bytes,acq.ir.profile,average); acq.ir.bytes=null;
      const irgb=new Uint16Array(I.data.buffer,I.data.byteOffset,I.data.byteLength>>1), ir=new Uint16Array(W*H);
      for(let i=0;i<W*H;i++) ir[i]=irgb[i*3];          // IR is read by the red row
      det=await Enhance.runAsync(Enhance.irDetectSteps(ir,rgb,W,H,{darkC:darkS}),stage('detect')); mask=Enhance.dilate(det.core,W,H,2);
      info.infrared={mode:s.infrared,registration:det.registration,noise:det.noise,ghost:det.ghost,defectCoverage:det.coverage,irMedian:det.irMedian,irBlocked:det.irBlocked};
      if(det.irBlocked){ info.infrared.note='infrared blocked by the film (B&W silver image or Kodachrome?): no repair'; log('infrared: the film blocks IR (silver image?); not repaired'); }
      { const out=new Uint16Array(W*H); for(let i=0;i<W*H;i++) out[i]=Math.min(65535,Math.max(0,Math.round(det.ir[i]))); p.irPlane=out; }   // saved as the TIFF's 4th channel
      log(`infrared: ${det.coverage} % defects, offset ${det.registration.dy.toFixed(2)}/${det.registration.dx.toFixed(2)} px${det.registration.ok?'':' (not registered: '+det.registration.reason+')'}`);
    }
    const repairing=det&&!det.irBlocked&&s.infrared==='repair';
    let repairs=0; const nRepairs=fusing?2:1;
    const repair=async(img,label)=>{ const on=stage('repair'), k=repairs++;
      const r=await Enhance.runAsync(Enhance.irRepairSteps(img,W,H,det),f=>on((k+f)/nRepairs)); mask=r.mask;
      info.infrared.repair={inpaintedPixels:r.inpainted,filledDefects:r.filledComponents,dividedDefects:r.dividedComponents,confirmedDefects:r.confirmed,skippedInvisible:r.invisible,attenuationExponent:r.gamma,method:r.method,
        note:'IR defects found by hysteresis against the scan\'s own IR noise; repaired only where they show in the colour image; the visibly damaged pixels (whole footprint for broad smudges) filled by exemplar inpainting, which keeps grain; only very large broad smudges divided by IR transmission^γ'};
      log(`infrared repair${label}: ${r.filledComponents} defects filled (${r.inpainted} px), ${r.dividedComponents} large smudges corrected, ${r.invisible} IR-only marks left alone (not visible in colour)`); };
    // 2. multi-exposure
    if(acq.long){
      await tick('long-align');
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
        if(repairing){ lrgb=Enhance.shiftRGB(lrgb,W,H,shift.dy,shift.dx); await repair(rgb,' (1× pass)'); await repair(lrgb,' (long pass)'); }
        const f=await Enhance.runAsync(Enhance.fuseSteps(rgb,lrgb,W,H,{darkS,darkL,fit:fits,film:s.film,shift:repairing?{dy:0,dx:0}:shift}),stage('fuse'));
        Object.assign(info.multiExposure,{fits,fusion:{method:'Mertens exposure fusion (contrast, saturation, well-exposedness; Laplacian pyramid blend)',
          shortPassWeight:f.shortWeight,black:f.black,output:'linear 16-bit negative (not inverted or colour balanced, black 0), tone-compressed by exposure fusion: invert it in a negative converter'}});
      }else{
        await tick('merge');
        const r=Enhance.mergeRange(rgb,lrgb,W,H,{darkS,darkL,noise,shift});
        Object.assign(info.multiExposure,{fits:r.fits,longPassWeight:r.longWeight,
          method:'per-channel affine fit long = slope·short + offset, inverse-variance blend, long pass faded out at 90–98 % of full scale'});
        if(repairing) await repair(rgb,'');
      }
      log(`multi-exposure (${s.multiExposure}): long pass offset ${shift.dy.toFixed(2)}/${shift.dx.toFixed(2)} px, slopes ${info.multiExposure.fits.map(f=>f.slope).join('/')}`);
    }else if(repairing) await repair(rgb,'');
    // preview-size mask of what was repaired (or, detect only, found) for the on-screen overlay;
    // kept in the sidecar, so frames loaded back from the folder have it too
    if(mask&&info.infrared&&!det.irBlocked){ const m=Enhance.maskPreview(mask,W,H,PREVIEW_MAX);
      p.repairMask={width:m.width,height:m.height,png:await pngDataURL(m.data,m.width,m.height),mode:repairing?'repair':'detect',pixels:m.pixels}; }
    if(report) report('Finishing',1);
    log(`extra passes processed in ${((Date.now()-t0)/1000).toFixed(1)} s`);
    // black-level correction as in the normal path (linear output only)
    if(p.offsets&&!info.multiExposure?.fusion) for(let i=0;i<rgb.length;i++){ const v=rgb[i]-p.offsets[i%3]; rgb[i]=v<0?0:v>65535?65535:Math.round(v); }
    p.aligned={...a,data:new Uint8Array(rgb.buffer,rgb.byteOffset,rgb.byteLength),displayReferred:false};
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
          const note=pending.processing?.multiExposure?` multi-exposure ${pending.processing.multiExposure.mode}${pending.processing.multiExposure.fusion?' (exposure-fused negative)':''}`:'';
          // with infrared, the registered IR plane is the 4th sample of every pixel (RGBI, ExtraSamples
          // = unspecified), as in SilverFast's 64-bit HDRi files; the RGB data is unchanged
          const ir=pending.irPlane, ch=ir?4:3;
          const h=CaptureRuntime.tiffHeader(a.width,a.height,a.xdpi,a.ydpi,{orientation:settings.orientation,channels:ch,description:desc+note+(pending.processing?.infrared?.repair?' infrared-repaired':'')+(ir?' RGBI: 4th channel infrared, registered to the colour image':'')});
          const meta={width:a.width,height:a.height,xDpi:a.xdpi,yDpi:a.ydpi,channels:ir?'RGBI':'RGB',verticalSamplesAveraged:a.averaged,lineFilter:a.filter};
          let body=a.data;
          if(ir){ const rgb=new Uint16Array(a.data.buffer,a.data.byteOffset,a.data.byteLength>>1), n=a.width*a.height, o=new Uint16Array(n*4);
            for(let i=0,j=0,k=0;i<n;i++,j+=3,k+=4){ o[k]=rgb[j]; o[k+1]=rgb[j+1]; o[k+2]=rgb[j+2]; o[k+3]=ir[i]; } body=new Uint8Array(o.buffer); }
          await put(kind,name,[h,body],meta);
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
        positioningStop:p.positioning?{...p.positioning,note:'first positioning move: stopped on the scanner event 0x08 (interrupt endpoint) when available, else at the recorded time'}:null,
        scanTiming:profile.scan?{lineSel:profile.scan.lineSel,lineSeconds:profile.scan.lineSeconds,bytesPerSecond:profile.scan.bytesPerSecond,motorCruise:profile.motorCruise||'recorded'}:null,
        options:{...(profile.acquisitionOptions||{pixelSampling:'deletion',exposureMultiplier:1,
          dummyLines:{setting:'recorded',recorded:profile.scan?.lineSel??null,used:profile.scan?.lineSel??null},averagingReducesPixels:false}),
          calibration:p.calibrated?'live AFE and shading':'recorded vendor AFE and shading'},
        illuminationCheck:p.lamp?{...p.lamp,reference:profile.lamp,limits:CaptureRuntime.LAMP_LIMITS}:null,
        hardwareShading:(p.calibrated?'live':'recorded vendor')+' shading tables applied by the scanner before USB transfer'},
      processing:{multiExposure:p.processing?.multiExposure||null,infrared:p.processing?.infrared?{...p.processing.infrared,overlay:p.repairMask?{...p.repairMask,note:`${p.repairMask.mode==='repair'?'repaired':'detected'} defects at preview size (orientation as stored, before the TIFF orientation tag); 8-bit PNG, 255 = defect`}:null}:null,channelShiftLines:align.shifts,channelShiftSource:align.used,channelShiftConfidence:align.confidence,
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
      shifts:p.align.shifts,shiftConfidence:p.align.confidence,lampWarning:p.lamp?.warning||null,enhanced:[p.processing?.multiExposure?'ME':null,p.processing?.infrared?'IR':null].filter(Boolean),displayReferred:!!p.processing?.multiExposure?.fusion,repairMask:p.repairMask||null,thumb:p.preview?.thumb||null,large:p.preview?.large||null,status:'saved'};
    p.bytes=null;p.g=null;p.preview=null;p.trace=null;p.aligned=null;p.irPlane=null;
    return rec;
  }

  function manifest(settings,records){
    return {format:VERSION,roll:cleanPrefix(settings.prefix),updated:new Date().toISOString(),
      settings:{digits:settings.digits,tiff:settings.tiff,mirror:settings.mirror!==false,pixels:settings.pixels,film:settings.film,orientation:settings.orientation,profile:settings.profile,pixelSampling:settings.pixelSampling||'deletion',dummyLines:settings.dummyLines||'recorded'},
      frames:records.map(({thumb,large,repairMask,...r})=>r)};
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
