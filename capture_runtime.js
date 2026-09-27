/* Capture acquisition and deterministic reconstruction. No DOM dependencies. */
(() => {
  const bytes64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  const assert=(ok,msg)=>{if(!ok)throw new Error(msg);};
  const STATUS=0x41, MOTORENB=0x01, FEEDFSH=0x20, BUFEMPTY=0x40;
  // The GL843 advances its register address after every 0x84 read (observed in trace
  // 1790025029175: unaddressed re-reads returned 0x42, 0x43 ... 0x4F, including FEDCNT).
  // Every poll must therefore re-send the address, exactly as the vendor does.
  const ADDR_OP=reg=>({kind:'control',rt:0x40,request:0x0c,value:0x83,index:0,data:[reg]});
  const ACK_OP={kind:'control',rt:0xc0,request:0x0c,value:0x8e,index:0x20,length:1,expected:[1]};
  const writesMotorStart=op=>{
    if(op.rt!==0x40||op.value!==0x83||op.data.length<2)return false;
    for(let i=0;i<op.data.length;i+=2)if(op.data[i]===0x0f&&op.data[i+1]===1)return true;
    return false;
  };

  // Prepare once before homing or other USB access. Recorded profiles stay immutable.
  function prepareProfile(profile, options={}) {
    const pixelSampling=options.pixelSampling??'deletion';
    const exposureMultiplier=Number(options.exposureMultiplier??1);
    const invalid=message=>{const e=new Error(message);e.name='ScanConfigurationError';throw e;};
    if(!['deletion','average'].includes(pixelSampling)) invalid('Unknown sensor pixel sampling mode.');
    if(![1,1.5,2,3,4].includes(exposureMultiplier)) invalid('Choose an exposure of 1×, 1.5×, 2×, 3× or 4×.');
    if(exposureMultiplier!==1) invalid('Longer exposure is saved but not implemented yet. Fresh AFE/shading calibration and coordinated motor timing are required. Select recorded exposure (1×) to scan.');
    if(!profile) invalid('Unknown scan profile.');
    if(pixelSampling==='deletion') return profile; // Default wire sequence is unchanged.
    const ops=profile.ops.map(op=>{
      if(op.kind!=='control'||op.rt!==0x40||op.value!==0x83||op.data.length<2) return op;
      const data=op.data.slice();
      for(let i=0;i<data.length;i+=2) if(data[i]===0x03) data[i+1]|=0x40;
      return {...op,data};
    });
    return {...profile,ops,frames:profile.frames.map(f=>({...f,regs:{...f.regs,3:f.regs[3]|0x40}})),
      acquisitionOptions:{pixelSampling,exposureMultiplier,averagingReducesPixels:profile.dpi<7200,
        calibration:'recorded deletion-mode AFE and shading; live checks are comparisons, not fresh calibration'}};
  }

  async function run(profile, io, hooks={}) {
    // Validate before touching hardware: capture loss must never move image reads past
    // transfer completion or scan/lamp shutdown. Byte totals alone cannot catch that.
    const planned=new Map();
    for(const op of profile.ops){
      if(op.kind==='read'){
        const n=(planned.get(op.frame)||0)+op.length;
        assert(profile.frames[op.frame]&&n<=profile.frames[op.frame].bytes,'Invalid frame read budget');
        planned.set(op.frame,n);
      }
      const n=planned.get(profile.mainFrame)||0;
      if(n>0&&n<profile.frames[profile.mainFrame].bytes&&op.kind==='control'){
        const completion=op.rt===0xc0&&op.value===0x8e&&op.index===0x18;
        const shutdown=op.rt===0x40&&op.value===0x83&&op.data.length>1&&
          op.data.some((v,i)=>i%2===0&&((v===1&&!(op.data[i+1]&1))||(v===3&&!(op.data[i+1]&0x10))));
        assert(!completion&&!shutdown,'Invalid capture profile: main frame is incomplete before transfer completion or scan shutdown');
      }
    }
    for(let i=0;i<profile.frames.length;i++)
      assert(planned.get(i)===profile.frames[i].bytes,'Invalid capture profile: incomplete frame '+i);
    const regs={}, frames=new Map(); let address=0, lastStatus=null, moveStartedAt=null;
    const lampFrames=profile.lamp?[profile.lamp.line.frame,profile.lamp.shading.frame,profile.lamp.dark.frame]:[];
    const check=hooks.check||(()=>{}), sleep=hooks.sleep||(ms=>new Promise(r=>setTimeout(r,ms)));
    const timeoutMs=hooks.timeoutMs||60000, log=hooks.log||(()=>{});
    const now=hooks.now||(()=>Date.now());
    const send=async op=>{
      await io.control(op);
      if(op.value===0x83){
        if(op.data.length===1)address=op.data[0];
        else for(let i=0;i<op.data.length;i+=2)regs[op.data[i]]=op.data[i+1];
      }
    };
    const readIn=async op=>{
      const r=await io.control(op); assert(r&&r.length===op.length,'Short control read');
      if(op.value===0x84){ if(address===STATUS)lastStatus=r[0]; address=(address+1)&0xff; }
      return r;
    };
    const ack=async()=>{
      const deadline=now()+timeoutMs; let r=await readIn(ACK_OP);
      while(!(r[0]&1)){check();assert(now()<deadline,'Write acknowledge timeout');await sleep(5);r=await readIn(ACK_OP);}
    };
    // One addressed status read: set-address 0x41, write-ack, read 0x84 (vendor pattern).
    const readStatus=async op=>{ await send(ADDR_OP(STATUS)); await ack(); return readIn(op); };
    const pollStatus=async(op,r,mask,target,why)=>{
      const deadline=now()+timeoutMs; let extra=0;
      while((r[0]&mask)!==target){
        check(); assert(now()<deadline,'Capture profile readiness timeout: '+why+' (status 0x'+r[0].toString(16)+')');
        await sleep(15); r=await readStatus(op); extra++;
      }
      if(extra)log(`${why}: ${extra} additional status poll(s), status 0x${r[0].toString(16).toUpperCase()}`);
      return r;
    };
    const ctl=async op=>{
      check();
      if(op.rt===0x40){
        // Never start the motor while the previous move/scan is still running. In every
        // recorded start the last status read shows MOTORENB clear, so this adds no traffic
        // unless the scanner is genuinely still busy.
        if(writesMotorStart(op)&&lastStatus!==null&&(lastStatus&MOTORENB))
          await pollStatus({...ACK_OP,index:0,value:0x84,expected:[0]},[lastStatus],MOTORENB,0,'motor still enabled before start');
        await send(op);
        if(writesMotorStart(op)){ lastStatus=null; moveStartedAt=now(); }
        return;
      }
      let r=await readIn(op);
      if(op.value===0x8e&&op.index===0x20){
        const deadline=now()+timeoutMs;
        while(!(r[0]&1)){check();assert(now()<deadline,'Write acknowledge timeout');await sleep(5);r=await readIn(op);}
        return;
      }
      if(op.value===0x8e&&op.index===0x18){
        const deadline=now()+timeoutMs;
        while(r[0]&0x0c){check();assert(now()<deadline,'Bulk completion timeout');await sleep(20);r=await readIn(op);}
        return;
      }
      // op.register is the address in force when the vendor issued this read.
      if(op.value===0x84&&op.register===STATUS){
        const expected=op.expected[0];
        if(!(regs[1]&1)&&(expected&(FEEDFSH|MOTORENB))===FEEDFSH)
          await pollStatus(op,r,FEEDFSH|MOTORENB,FEEDFSH,'waiting for positioning move to finish');
        else if((regs[1]&1)&&!(expected&BUFEMPTY))
          await pollStatus(op,r,BUFEMPTY,0,'waiting for scan data');
      }
    };
    for(const op of profile.ops){
      check();
      if(op.kind==='delay'){
        if(op.timedStop){
          // The vendor stops its first positioning move by writing 0x02/FEEDL=1 a fixed time
          // after starting it (2.560 s and 2.572 s in the two captures); where the carriage ends
          // up depends on that moment, so time it from the start write, not from the last op.
          // Stopping at 1.23 s (old 1 s cap) left scans 2.1 mm early; not stopping ran the
          // carriage for ~20 s to the end of its travel.
          assert(moveStartedAt!==null,'timed stop without a preceding motor start');
          const target=moveStartedAt+op.ms;
          while(now()<target){ check(); await sleep(Math.max(1,Math.min(20,target-now()))); }
          continue;
        }
        await sleep(op.ms);continue;
      }
      if(op.kind==='control'){await ctl(op);continue;}
      if(op.kind==='write'){await io.write(bytes64(op.data));continue;}
      if(op.kind==='read'){
        const f=profile.frames[op.frame]; let state=frames.get(op.frame);
        if(!state){const keep=op.frame===profile.mainFrame||lampFrames.includes(op.frame);
          state={got:0,data:keep?new Uint8Array(f.bytes):null};frames.set(op.frame,state);}
        let remaining=op.length;
        // The scanner delivers a line every (LINESEL+1) line periods and its buffer is small: if the
        // host falls behind, the scanner can enter buffer-full backtracking
        // (7200 dpi needs 3.7 MB/s). Keep one read in flight and
        // use large transfers to cover the round-trip latency, and give up early if the rate is short.
        const main=op.frame===profile.mainFrame, need=main&&profile.scan?profile.scan.bytesPerSecond:0;
        const chunk=hooks.readChunk||CHUNK;
        // Request whole 512-byte packets and read any remainder on its own, as the vendor driver
        // does (62268 = 61952 + 316). A read that ends mid-packet while the scanner still has
        // more to send meets a full packet it has no room for (Linux reports EOVERFLOW).
        let unrequested=op.length;
        const request=()=>{
          const whole=Math.min(chunk,unrequested), n=whole>=PACKET?whole-whole%PACKET:whole, at=op.length-unrequested;
          unrequested-=n;
          const r=io.read(n).then(part=>({part,n}),e=>{ throw new Error(`frame ${op.frame}: bulk read of ${n} bytes at byte ${at} of ${op.length} failed: ${e.message}`); });
          r.catch(()=>{});   // awaited below; this only stops an early exit reporting it as unhandled
          return r;
        };
        let pending=request(), started=0, sinceStart=0;
        while(remaining){
          check();
          const {part,n}=await pending;
          assert(part&&part.length>0,`frame ${op.frame}: empty bulk read (asked for ${n} bytes)`);
          assert(part.length<=n,`frame ${op.frame}: bulk read returned ${part.length} of ${n} bytes`);
          assert(state.got+part.length<=f.bytes,'Frame exceeds captured header');
          remaining-=part.length; unrequested+=n-part.length;   // a short read is asked for again
          if(unrequested)pending=request();   // next transfer starts now
          if(state.data)state.data.set(part,state.got);
          state.got+=part.length;
          if(started){ sinceStart+=part.length;
            const secs=(now()-started)/1000;
            if(need&&secs>THROUGHPUT_GRACE_S&&sinceStart/secs<need*THROUGHPUT_MIN){
              const e=new Error(`the scan data is arriving at ${(sinceStart/secs/1e6).toFixed(2)} MB/s but this resolution needs ${(need/1e6).toFixed(2)} MB/s; stopping because the scanner may enter buffer-full backtracking`);
              e.name='ThroughputTooLow'; e.achieved=sinceStart/secs; e.needed=need; throw e;
            }
          } else started=now();
          if(hooks.progress)hooks.progress(op.frame,state.got,f.bytes);
        }
        if(main&&state.got===f.bytes&&started&&hooks.log)hooks.log(`image transferred at ${(sinceStart/((now()-started)/1000)/1e6).toFixed(2)} MB/s (needs ${(need/1e6).toFixed(2)})`);
        // white calibration reads: let the caller judge the lamp before the main scan starts
        if(state.got===f.bytes&&lampFrames.includes(op.frame)&&hooks.frameDone){
          const d=state.data; state.data=null; await hooks.frameDone(op.frame,d);
        }
      }
    }
    for(let i=0;i<profile.frames.length;i++)assert(frames.get(i)?.got===profile.frames[i].bytes,'Incomplete captured frame '+i);
    return frames.get(profile.mainFrame).data;
  }

  // ------------------------------------------------------------ geometry and alignment
  // Tri-linear CCD: R, G and B rows see the same film line at different times. The delay in
  // delivered lines is the row spacing (12/24 lines at 3600 lpi in SANE's model) times the
  // vertical sampling rate. The profile values are the integer vendor measurements; the
  // real delays are fractional (prescan ~9.8/19.4), so alignment is measured per scan.
  function geometry(p,shifts){
    const f=p.frames[p.mainFrame], s=shifts||p.shifts;
    const shift={r:s[0],g:s[1],b:s[2]}, maxShift=Math.ceil(Math.max(...s)-1e-6);
    // 7600i v1: SANE's 7200dpi sensor table specifies {4,0} at square sampling.
    // The captured profile delivers 14400 lines/inch: advance native even columns
    // by 8 raw lines. test07 independently measured the equivalent 4 TIFF rows.
    // Fixed captured windows start on an even sensor column (STRPIXEL=210).
    const stagger=p.dpi===7200?[Math.round(4*p.yres/7200),0]:[];
    const maxStagger=stagger.length?Math.max(...stagger):0;
    return {dpi:p.dpi,yres:p.yres,yMul:p.yres/p.dpi,pixels:f.pixels,lines:f.lines-maxShift-maxStagger,
      lincnt:f.lines,lincntReg:(f.regs[37]<<16)|(f.regs[38]<<8)|f.regs[39],lineBytes:f.pixels*6,
      totalBytes:f.bytes,shift,nominalShift:p.shifts.slice(),stagger,vendor:true,captured:true,profile:p.name,ir:false};
  }
  // Normalised cross-correlation of vertical gradients, R against G and B, then a parabolic
  // peak fit for sub-line precision. Falls back to the profile value when the image has
  // too little vertical structure to trust.
  function measureShifts(bytes,p,opts={}){
    const f=p.frames[p.mainFrame], P=f.pixels, L=f.lines, nominal=p.shifts;
    assert(bytes.byteLength===f.bytes,'Wrong image byte count');
    const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const maxNom=Math.max(...nominal), reach=Math.max(4,Math.ceil(maxNom*0.35));
    const y0=Math.floor(L*0.1), y1=L-Math.floor(L*0.1)-Math.ceil(maxNom+reach)-2;
    const x0=Math.floor(P*0.1), x1=P-Math.floor(P*0.1), step=Math.max(1,Math.floor((x1-x0)/(opts.columns||384)));
    const xs=[];for(let x=x0;x<x1;x+=step)xs.push(x);
    const rowsNeeded=y1+Math.ceil(maxNom+reach)+2-y0;
    // gradient planes for the sampled columns
    const grad=c=>{const g=new Float32Array(rowsNeeded*xs.length);
      for(let y=0;y<rowsNeeded;y++){const yy=y0+y;if(yy+1>=L)break;
        for(let i=0;i<xs.length;i++){const o=(yy*P+xs[i])*6+c*2;g[y*xs.length+i]=dv.getUint16(o+P*6,true)-dv.getUint16(o,true);}}
      return g;};
    const R=grad(0), rows=y1-y0, W=xs.length;
    const ncc=(M,k)=>{let sa=0,sm=0,saa=0,smm=0,sam=0,n=0;
      for(let y=0;y<rows;y++){const a=y*W,m=(y+k)*W;
        for(let i=0;i<W;i++){const A=R[a+i],B=M[m+i];sa+=A;sm+=B;saa+=A*A;smm+=B*B;sam+=A*B;n++;}}
      const cov=sam-sa*sm/n, va=saa-sa*sa/n, vm=smm-sm*sm/n;return va>0&&vm>0?cov/Math.sqrt(va*vm):0;};
    const out={shifts:[0],measured:[null],confidence:[1],used:['reference']};
    for(const c of [1,2]){
      const M=grad(c), nom=nominal[c], lo=Math.max(0,Math.floor(nom-reach)), hi=Math.ceil(nom+reach), cs=[];
      for(let k=lo;k<=hi;k++)cs.push(ncc(M,k));
      let bi=0;for(let i=1;i<cs.length;i++)if(cs[i]>cs[bi])bi=i;
      let est=lo+bi;
      if(bi>0&&bi<cs.length-1){const a=cs[bi-1],b=cs[bi],d=cs[bi+1],den=a-2*b+d;if(den<0)est+=0.5*(a-d)/den;}
      const ok=cs[bi]>=(opts.minConfidence??0.3)&&bi>0&&bi<cs.length-1;
      const v=Math.round(est*100)/100;
      out.measured.push(v);out.confidence.push(Math.round(cs[bi]*1000)/1000);
      out.shifts.push(ok?v:nom);out.used.push(ok?'measured':'nominal (low confidence)');
    }
    return out;
  }
  function decode(bytes,g){
    assert(bytes.byteLength===g.totalBytes,'Wrong image byte count');
    const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), out=[], P=g.pixels, stagger=g.stagger||[];
    for(const sh of [g.shift.r,g.shift.g,g.shift.b]){
      const c=out.length, plane=new Uint16Array(P*g.lines), i0=Math.floor(sh+1e-6), fr=sh-i0;
      if(fr<1e-3){
        for(let y=0;y<g.lines;y++)for(let x=0;x<P;x++)plane[y*P+x]=dv.getUint16(((y+i0+(stagger[x&1]||0))*P+x)*6+c*2,true);
      }else{
        // linear interpolation between the two delivered lines that bracket the true delay
        const w0=1-fr;
        for(let y=0;y<g.lines;y++){const a=(y+i0)*P, b=Math.min(y+i0+1,g.lincnt-1)*P;
          for(let x=0;x<P;x++){const st=(stagger[x&1]||0)*P;plane[y*P+x]=Math.round(w0*dv.getUint16((a+st+x)*6+c*2,true)+fr*dv.getUint16((b+st+x)*6+c*2,true));}}
      }
      out.push(plane);
    }
    return out;
  }
  function percentile(hist,n,q){
    const rank=(n-1)*q, a=Math.floor(rank),b=Math.ceil(rank);let count=0,lo=0,hi=0,found=false;
    for(let v=0;v<hist.length;v++){count+=hist[v];if(!found&&count>a){lo=v;found=true;}if(count>b){hi=v;break;}}
    return lo+(hi-lo)*(rank-a);
  }
  function levels(planes,g){
    // Same 150-sample inset and 0.5/99.5 percentiles as the reconstructed PNG.
    const mx=g.pixels>300?150:0,my=g.lines>300?150:0;
    return planes.map(pl=>{const h=new Uint32Array(65536);let n=0;
      for(let y=my;y<g.lines-my;y++)for(let x=mx;x<g.pixels-mx;x++){h[pl[y*g.pixels+x]]++;n++;}
      const lo=percentile(h,n,.005),hi=percentile(h,n,.995);return [lo,Math.max(lo+1,hi)];});
  }
  function renderRGB(planes,g,invert=true){
    const ls=levels(planes,g), out=new Uint8ClampedArray(g.pixels*g.lines*4);
    for(let i=0;i<g.pixels*g.lines;i++){
      for(let c=0;c<3;c++){const [lo,hi]=ls[c];let v=Math.max(0,Math.min(1,(planes[c][i]-lo)/(hi-lo)));if(invert)v=1-v;out[i*4+c]=Math.round(v*255);}
      out[i*4+3]=255;
    }
    return out;
  }


  // Preview rendering that behaves like film. Negatives: optical density D = log10(base/T),
  // normalised per channel between the film base (clear, 99.9th percentile of transmission)
  // and the densest area (0.1th percentile), then a display gamma. This removes the orange
  // mask and keeps dense highlights (bright subjects) tonal instead of clipping them, which a
  // linear inversion does. Slides/positives: linear levels with sRGB-like gamma.
  function renderPreview(planes,g,film='neg'){
    const N=g.pixels*g.lines, out=new Uint8ClampedArray(N*4), mx=Math.floor(g.pixels*0.02), my=Math.floor(g.lines*0.02);
    const neg=film!=='pos', lut=new Uint8ClampedArray(4096);
    for(let i=0;i<4096;i++)lut[i]=Math.round(255*Math.pow(i/4095,neg?1/1.4:1/2.2));
    for(let c=0;c<3;c++){
      const h=new Uint32Array(65536);let n=0;
      for(let y=my;y<g.lines-my;y++)for(let x=mx;x<g.pixels-mx;x++){h[planes[c][y*g.pixels+x]]++;n++;}
      const lo=Math.max(1,percentile(h,n,.001)), hi=Math.max(lo+1,percentile(h,n,.999)), pl=planes[c];
      if(neg){ const k=1/Math.log(hi/lo);
        for(let i=0;i<N;i++){const v=Math.min(hi,Math.max(lo,pl[i]));out[i*4+c]=lut[Math.round(4095*Math.log(hi/v)*k)];} }
      else { const k=1/(hi-lo);
        for(let i=0;i<N;i++){const v=Math.min(hi,Math.max(lo,pl[i]));out[i*4+c]=lut[Math.round(4095*(v-lo)*k)];} }
    }
    for(let i=0;i<N;i++)out[i*4+3]=255;
    return out;
  }


  // ------------------------------------------------------------ lamp check
  // Statistics of a white calibration read (central 80 % of the line, like the profile builder).
  function whiteStats(data,frame){
    const P=frame.pixels, L=frame.lines, x0=Math.floor(P/10), x1=P-Math.floor(P/10), dv=new DataView(data.buffer,data.byteOffset,data.byteLength);
    const sum=[0,0,0], lineMeans=[[],[],[]];
    for(let y=0;y<L;y++){ const ls=[0,0,0];
      for(let x=x0;x<x1;x++)for(let c=0;c<3;c++)ls[c]+=dv.getUint16(((y*P+x)*3+c)*2,true);
      for(let c=0;c<3;c++){ sum[c]+=ls[c]; lineMeans[c].push(ls[c]/(x1-x0)); } }
    const n=L*(x1-x0), mean=sum.map(v=>v/n);
    const cv=lineMeans.map((m,c)=>{ if(L<2)return 0; const mu=m.reduce((a,b)=>a+b,0)/L; return Math.sqrt(m.reduce((a,b)=>a+(b-mu)**2,0)/L)/mu*100; });
    return {mean:mean.map(v=>Math.round(v*10)/10),lineCvPct:cv.map(v=>Math.round(v*1000)/1000)};
  }
  // Compare with the vendor's reference. Level +-10 % and colour balance (G/R, B/R) +-5 % cover
  // the difference between the two official sessions (3.3 % and 2.9 %); line-to-line variation of
  // the 128-line white frame (flicker) may be at most 0.6 % (official: 0.02-0.24 %).
  // 256 KB per bulk transfer (the helper allows 1 MB); big enough to hide round-trip latency,
  // small enough for a smooth progress bar and for usbfs/WinUSB to handle comfortably.
  const CHUNK=0x40000, PACKET=512, THROUGHPUT_GRACE_S=6, THROUGHPUT_MIN=0.9;
  const LAMP_LIMITS={levelPct:10,balancePct:5,flickerPct:0.6,darkCounts:40};
  // Black level: the sequence replays the vendor's per-channel AFE offsets, which were calibrated
  // for the vendor's unit in that session (prescan 30/47/23, full 32/49/29). If this scanner's dark
  // level differs, every channel's black point is off by that difference, which is a colour cast.
  // The difference is measurable in the lamp-off dark frame the sequence reads before every scan.
  function darkVerdict(stats,ref){
    const delta=stats.mean.map((v,c)=>Math.round((v-ref.mean[c])*10)/10);
    const worst=Math.max(...delta.map(Math.abs));
    return {ok:worst<=LAMP_LIMITS.darkCounts,delta,worst,
      issues:worst>LAMP_LIMITS.darkCounts?[`black level off by R ${delta[0]}, G ${delta[1]}, B ${delta[2]} counts (the recorded AFE offsets suit a different unit/temperature)`]:[]};
  }
  function lampVerdict(kind,stats,ref){
    const issues=[], pct=(a,b)=>(a/b-1)*100;
    const level=pct(stats.mean.reduce((a,b)=>a+b,0),ref.mean.reduce((a,b)=>a+b,0));
    if(Math.abs(level)>LAMP_LIMITS.levelPct)issues.push(`${kind==='line'?'LED':'white'} level ${level>0?'+':''}${level.toFixed(1)} % from the official`);
    const gr=pct(stats.mean[1]/stats.mean[0],ref.mean[1]/ref.mean[0]), br=pct(stats.mean[2]/stats.mean[0],ref.mean[2]/ref.mean[0]);
    if(Math.abs(gr)>LAMP_LIMITS.balancePct||Math.abs(br)>LAMP_LIMITS.balancePct)issues.push(`colour balance G/R ${gr>0?'+':''}${gr.toFixed(1)} %, B/R ${br>0?'+':''}${br.toFixed(1)} %`);
    const flicker=Math.max(...stats.lineCvPct);
    if(flicker>LAMP_LIMITS.flickerPct)issues.push(`ripple ${flicker.toFixed(2)} % line to line (official ≤ ${Math.max(...ref.lineCvPct).toFixed(2)} %)`);
    return {ok:!issues.length,issues,levelPct:+level.toFixed(2),grPct:+gr.toFixed(2),brPct:+br.toFixed(2),flickerPct:+flicker.toFixed(3)};
  }

  // ------------------------------------------------------------ roll-scanning output
  // Clamp BOTH bounds before Uint16Array storage: a negative dark offset adds
  // signal and can exceed 65535. Typed-array assignment wraps rather than saturates.
  const HOST_LE=new Uint8Array(new Uint16Array([1]).buffer)[0]===1;
  // Interleaved little-endian RGB16 of the aligned frame, ready to follow a TIFF header.
  // average=true folds the vendor's 2x vertical oversampling (yres/dpi) into square pixels.
  // inPlace writes the result into the source buffer (allowed only when it shrinks, i.e. the
  // vertical oversampling is averaged): output row y is written while rows >= y*k are still being
  // read, so the write pointer never overtakes the read pointer. It halves peak memory, which
  // matters at 7200 dpi (868 MB raw in, 434 MB out).
  // mirror=true flips each row left-right (the 7600i delivers the film mirrored). Stagger still
  // follows the native sensor column parity, so it is applied before the flip.
  // filter='box' (default) averages each group of k lines after linear-interpolated channel
  // alignment. filter='lanczos3' resamples each channel once, straight from the raw lines, with a
  // Lanczos-3 kernel stretched by k: alignment and line reduction in one step, same output grid.
  function alignedFrame(bytes,g,{average=true,offsets=null,inPlace=false,mirror=false,filter='box'}={}){
    assert(HOST_LE,'Big-endian hosts are not supported');
    assert(bytes.byteLength===g.totalBytes&&bytes.byteOffset%2===0,'Wrong image buffer');
    assert(filter==='box'||filter==='lanczos3','Unknown line filter '+filter);
    const src=new Uint16Array(bytes.buffer,bytes.byteOffset,bytes.byteLength>>1), P=g.pixels, row=P*3, stagger=g.stagger||[];
    const k=average?Math.max(1,Math.round(g.yres/g.dpi)):1, H=Math.floor(g.lines/k);
    assert(!inPlace||k>=2,'in-place alignment needs the averaged (square-pixel) output');
    const out=inPlace?src.subarray(0,P*H*3):new Uint16Array(P*H*3), sh=[g.shift.r,g.shift.g,g.shift.b];
    if(filter==='lanczos3'&&k>=2){
      lanczosRows(src,out,{P,H,k,sh,stagger,offsets,inPlace,mirror});
      return {data:new Uint8Array(out.buffer,out.byteOffset,out.length*2),width:P,height:H,xdpi:g.dpi,ydpi:Math.round(g.yres/k),averaged:k,filter:'lanczos3',inPlace,mirrored:!!mirror};
    }
    const i0=sh.map(s=>Math.floor(s+1e-6)), fr=sh.map((s,c)=>s-i0[c]);
    // A mirrored row is built in a scratch row first: in place, output row 0 overlaps source row 0,
    // and writing column P-1-x would overwrite samples still to be read.
    const tmp=mirror?new Uint16Array(row):null;
    for(let y=0;y<H;y++){
      const o=y*row, dst=tmp||out, d0=tmp?0:o;
      for(let c=0;c<3;c++){
        const f=fr[c]<1e-3?0:fr[c], w0=(1-f)/k, w1=f/k;
        for(let x=0;x<P;x++){
          let acc=0;
          for(let j=0;j<k;j++){const r=(y*k+j+i0[c]+(stagger[x&1]||0))*row+x*3+c; acc+=w0*src[r]; if(w1)acc+=w1*src[r+row];}
          dst[d0+(mirror?P-1-x:x)*3+c]=Math.min(65535,Math.max(0,Math.round(acc-(offsets?offsets[c]:0))));
        }
      }
      if(tmp)out.set(tmp,o);
    }
    return {data:new Uint8Array(out.buffer,out.byteOffset,out.length*2),width:P,height:H,xdpi:g.dpi,ydpi:Math.round(g.yres/k),averaged:k,filter:k>=2?'box':'none',inPlace,mirrored:!!mirror};
  }
  const LANCZOS_A=3;
  function lanczos(t){ if(t===0)return 1; if(Math.abs(t)>=LANCZOS_A)return 0; const p=Math.PI*t; return LANCZOS_A*Math.sin(p)*Math.sin(p/LANCZOS_A)/(p*p); }
  // Tap offsets (in raw lines, relative to y*k + stagger) and normalised weights for one channel.
  // Output row y is centred where the box filter centres it: y*k + (k-1)/2, plus the channel delay.
  function lanczosTaps(k,shift){
    const b=(k-1)/2+shift, ms=[], ws=[];
    for(let m=Math.ceil(b-LANCZOS_A*k);m<=Math.floor(b+LANCZOS_A*k);m++){ const w=lanczos((m-b)/k); if(w!==0){ ms.push(m); ws.push(w); } }
    const sum=ws.reduce((a,w)=>a+w,0);
    return {ms,ws:ws.map(w=>w/sum)};
  }
  function lanczosRows(src,out,{P,H,k,sh,stagger,offsets,inPlace,mirror}){
    const row=P*3, Ltot=Math.floor(src.length/row), taps=sh.map(s=>lanczosTaps(k,s));
    // In place, output row y overwrites raw row y, and the first few output rows read raw rows
    // above themselves. Keep a copy of the raw rows that can be read after being overwritten.
    const reach=Math.max(0,-Math.min(...taps.map(t=>t.ms[0]))), head=inPlace?src.slice(0,Math.min(Ltot,reach+1)*row):null;
    const acc=new Float64Array(row), tmp=new Uint16Array(row);
    for(let y=0;y<H;y++){
      acc.fill(0);
      for(let c=0;c<3;c++){
        const {ms,ws}=taps[c];
        for(let p=0;p<2&&p<P;p++){
          const st=stagger[p]||0;
          for(let t=0;t<ms.length;t++){
            const n=Math.min(Ltot-1,Math.max(0,y*k+st+ms[t])), w=ws[t];
            const buf=inPlace&&n<y?head:src, base=n*row+c;   // rows < y are already overwritten
            for(let x=p;x<P;x+=2){ const i=x*3; acc[i+c]+=w*buf[base+i]; }
          }
        }
      }
      for(let x=0;x<P;x++){ const i=x*3, o=(mirror?P-1-x:x)*3;
        for(let c=0;c<3;c++) tmp[o+c]=Math.min(65535,Math.max(0,Math.round(acc[i+c]-(offsets?offsets[c]:0)))); }
      out.set(tmp,y*row);
    }
  }
  // Small aligned, square-pixel planes for on-screen preview and thumbnails.
  function previewPlanes(bytes,g,maxDim=1200,offsets=null,mirror=false){
    const src=new Uint16Array(bytes.buffer,bytes.byteOffset,bytes.byteLength>>1), P=g.pixels, row=P*3, stagger=g.stagger||[];
    const sqH=g.lines*g.dpi/g.yres, scale=Math.min(1,maxDim/Math.max(P,sqH));
    const W=Math.max(1,Math.round(P*scale)), H=Math.max(1,Math.round(sqH*scale));
    const bx=P/W, by=g.lines/H, sx=Math.max(1,Math.min(8,Math.round(bx))), sy=Math.max(1,Math.min(8,Math.round(by)));
    const sh=[g.shift.r,g.shift.g,g.shift.b].map(s=>Math.round(s)), planes=[0,1,2].map(()=>new Uint16Array(W*H));
    for(let y=0;y<H;y++)for(let x=0;x<W;x++)for(let c=0;c<3;c++){
      let acc=0,n=0;
      for(let j=0;j<sy;j++){const yy=Math.min(g.lines-1,Math.floor(y*by+(j+0.5)*by/sy));
        for(let i=0;i<sx;i++){const xx=Math.min(P-1,Math.floor(x*bx+(i+0.5)*bx/sx));acc+=src[(yy+sh[c]+(stagger[xx&1]||0))*row+xx*3+c];n++;}}
      planes[c][y*W+(mirror?W-1-x:x)]=Math.min(65535,Math.max(0,Math.round(acc/n-(offsets?offsets[c]:0))));
    }
    return {planes,g:{...g,pixels:W,lines:H,dpi:1,yres:1}};
  }
  // Baseline TIFF header for an uncompressed interleaved RGB16 strip that follows it.
  // Orientation: 1 as scanned, 3 rotate 180, 6 rotate 90 CW, 8 rotate 90 CCW (viewer applies it).
  function tiffHeader(w,h,xdpi,ydpi,{orientation=1,description='',software='OpticFilm 7600i roll scanner'}={}){
    const dataBytes=w*h*6;
    assert(Number.isSafeInteger(dataBytes)&&w>0&&h>0&&dataBytes<0xffffffff-65536,'Invalid or oversized TIFF dimensions');
    assert([1,3,6,8].includes(orientation),'Unsupported orientation');
    const ascii=s=>{const b=[...s].map(ch=>{const c=ch.charCodeAt(0);return c>=32&&c<127?c:63;});b.push(0);return b;};
    const desc=description?ascii(description):null, soft=ascii(software);
    const E=[[256,4,1,w],[257,4,1,h],[258,3,3,'bps'],[259,3,1,1],[262,3,1,2]];
    if(desc)E.push([270,2,desc.length,'desc']);
    E.push([273,4,1,'data'],[274,3,1,orientation],[277,3,1,3],[278,4,1,h],[279,4,1,dataBytes],
      [282,5,1,'xres'],[283,5,1,'yres'],[284,3,1,1],[296,3,1,2],[305,2,soft.length,'soft']);
    const ifd=8, ifdSize=2+E.length*12+4; let off=ifd+ifdSize; const place={};
    const reserve=(key,len)=>{place[key]=off;off+=len+(len&1);};
    reserve('bps',6);reserve('xres',8);reserve('yres',8);if(desc)reserve('desc',desc.length);reserve('soft',soft.length);
    off=(off+15)&~15; const dataOff=off;
    const buf=new ArrayBuffer(dataOff), dv=new DataView(buf), u8=new Uint8Array(buf);
    dv.setUint16(0,0x4949,true);dv.setUint16(2,42,true);dv.setUint32(4,ifd,true);dv.setUint16(ifd,E.length,true);
    let o=ifd+2;
    for(const [tag,type,count,v] of E){
      dv.setUint16(o,tag,true);dv.setUint16(o+2,type,true);dv.setUint32(o+4,count,true);
      if(v==='data')dv.setUint32(o+8,dataOff,true);
      else if(typeof v==='string')dv.setUint32(o+8,place[v],true);
      else if(type===3)dv.setUint16(o+8,v,true); else dv.setUint32(o+8,v,true);
      o+=12;
    }
    dv.setUint32(o,0,true);
    for(let i=0;i<3;i++)dv.setUint16(place.bps+i*2,16,true);
    dv.setUint32(place.xres,Math.round(xdpi),true);dv.setUint32(place.xres+4,1,true);
    dv.setUint32(place.yres,Math.round(ydpi),true);dv.setUint32(place.yres+4,1,true);
    if(desc)u8.set(desc,place.desc); u8.set(soft,place.soft);
    return buf;
  }

  globalThis.CaptureRuntime={prepareProfile,run,geometry,measureShifts,decode,levels,renderRGB,alignedFrame,previewPlanes,tiffHeader,renderPreview,whiteStats,lampVerdict,darkVerdict,LAMP_LIMITS};
})();
