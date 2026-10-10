/* Dry-run scanner for captured profiles: answers every recorded control transfer with the
   vendor's recorded response and streams a synthetic textured frame whose G/B channels lag
   R by known fractional line delays, so alignment and saving can be tested without hardware.
   Not a model of the chip's timing; see tests/simulated_scanner.test.cjs for that. */
(() => {
  // lampReadyAt (Date.now() ms): until then the white calibration reads show a cold lamp
  // (dimmer, green-shifted, flickering), afterwards the vendor's reference statistics.
  // pace (bytes/s): deliver the main frame at that rate, yielding to the page between reads, so
  // the dry run shows the scan arriving like a real one (live preview, progress).
  function create(profile,{delays=null,seed=7,lampReadyAt=0,darkOffset=[0,0,0],pace=0}={}){
    const f=profile.frames[profile.mainFrame], P=f.pixels, L=f.lines;
    const d=delays||[0,profile.shifts[1]+0.23,profile.shifts[2]+0.31];
    let rnd=seed; const r=()=>((rnd=(rnd*1103515245+12345)&0x7fffffff)/0x7fffffff);
    const ph=[r()*6,r()*6,r()*6];
    // separable texture: rows carry the vertical structure the alignment measures
    const row=d.map(dc=>{const t=new Float32Array(L);for(let y=0;y<L;y++){const v=y-dc;
      t[y]=Math.sin(v*0.071+ph[0])*0.6+Math.sin(v*0.23+ph[1])*0.3+Math.sin(v*0.61+ph[2])*0.1;}return t;});
    const col=new Float32Array(P);for(let x=0;x<P;x++)col[x]=0.55+0.45*Math.sin(x*0.013)*Math.cos(x*0.0047);
    const base=[21000,17000,12000];
    let frame=-1,offset=0,budget=0,t0=0; const afe={};
    return {delays:d,
      async control(op){
        if(op.rt===0x40){
          if(op.value===0x83&&op.data[0]===0x51){const d=Object.fromEntries(Array.from({length:op.data.length/2},(_,i)=>op.data.slice(i*2,i*2+2)));afe[d[0x51]]=d[0x3a]*256+d[0x3b];}
          if(op.value===0x82&&op.data[0]===0){frame++;offset=0;budget=profile.frames[frame].bytes;}return;
        }
        return Uint8Array.from(op.expected||[1]);
      },
      async write(){},
      async read(n){
        const len=Math.min(n,budget,0xf000), out=new Uint8Array(len);
        const lf=profile.lamp&&[profile.lamp.line,profile.lamp.shading,profile.lamp.dark].find(r=>r.frame===frame);
        const isDark=profile.lamp&&frame===profile.lamp.dark.frame;
        if(lf){
          const F=profile.frames[frame], cold=!isDark&&Date.now()<lampReadyAt, gain=cold?[0.78,0.86,0.80]:[1,1,1];
          for(let i=0;i<len;i+=2){const s_=(offset+i)>>1, c=s_%3, y=Math.floor(s_/3/F.pixels);
            const flick=cold?1+0.015*Math.sin(y*0.9):1, v=Math.min(65535,Math.round(lf.mean[c]*gain[c]*flick*(1+(r()-0.5)*0.004)+(isDark?darkOffset[c]:0)));
            out[i]=v&255;out[i+1]=v>>8;}
        }else if(profile.frames[frame].pixels===512){
          const rgb=[0,1,2].map(c=>{let off=afe[5+c]??128;off=off&256?-(off&255):off;
            return Math.max(0,Math.min(65535,Math.floor((off+70)*20*6/(6-5*(afe[2+c]||0)/63))));});
          for(let i=0;i<len;i++){const s=Math.floor((offset+i)/2),v=rgb[s%3];out[i]=(offset+i)%2?v>>8:v&255;}
        }else if(frame===profile.mainFrame){
          if(pace){ if(!offset) t0=Date.now(); const due=t0+offset/pace*1000; await new Promise(res=>setTimeout(res,Math.max(0,due-Date.now()))); }
          for(let i=0;i<len;i+=2){const s=(offset+i)>>1, px=Math.floor(s/3), c=s%3, y=Math.floor(px/P), x=px%P;
            const v=base[c]+9000*row[c][y]*col[x]; out[i]=v&255; out[i+1]=(v>>8)&255;}
        }else out.fill(0x40);
        offset+=len;budget-=len;return out;
      }};
  }
  globalThis.CaptureSim={create};
})();
