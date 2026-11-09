// Simulated OpticFilm 8100 carriage, shared by the GL845 tests. See motion_gl845.test.cjs for the model.
// A one-off 64 000-step scan on the real scanner ground against the forward end stop; Tom estimated it at about 32 000 steps from home (an ESTIMATE, not measured;
// the farthest position known to be safe is 30 200, the end of a full-frame pass). The simulator treats 32 000 as hitEnd, so a plan that overshoots fails a test.
function carriage(pos,{moving=null,sensor=true,stepsPerSec=4000}={}){
  const regs={},ms=1000/stepsPerSec;let clock=0,mv=null,enbUntil=0,sent=0,hitEnd=false,forward=false,scan=null,header=null;const violations=[];
  function advance(dt){
    const end=clock+dt;
    while(mv&&mv.next<=end){
      clock=mv.next; pos+=mv.dir; mv.done++;
      if(pos<=-400||pos>=32000){ hitEnd=true; pos=Math.max(-400,Math.min(32000,pos)); mv=null; break; }
      if(mv.dir<0&&sensor&&pos<=0&&mv.homeStop){ mv.total=Math.min(mv.total,mv.done+8); mv.homeStop=false; } // the chip stops itself at the sensor
      if(mv.done>=mv.total){ enbUntil=clock+80; mv=null; break; }
      mv.next=clock+ms;
    }
    clock=Math.max(clock,end);
    if(scan&&!scan.done&&clock>=scan.t0+scan.lines*scan.lineMs){ scan.done=true; enbUntil=clock+100; pos+=scan.lines*scan.spl; }
  }
  const u16=a=>(regs[a]<<8)|regs[a+1], u24=a=>(regs[a]<<16)|(regs[a+1]<<8)|regs[a+2];
  // bytes the scanner has produced so far (it starts delivering 100 ms after the start)
  const produced=()=>!scan?0:Math.min(scan.bytes,Math.max(0,Math.floor((clock-scan.t0-100)/scan.lineMs))*scan.lineBytes);
  function start(){
    if(regs[1]&1){   // scan: geometry from the same registers as the GL843 (DPISET 0x2C, STRPIXEL 0x30, ENDPIXEL 0x32, LINCNT 0x25)
      const pixels=Math.floor((u16(0x32)-u16(0x30))*u16(0x2C)/1200), lines=u24(0x25);
      if(scan&&!scan.done)violations.push('scan started while another is running');
      scan={t0:clock,spl:2400/u16(0x2C),lines,pixels,lineBytes:pixels*6,bytes:lines*pixels*6,lineMs:((regs[0x1E]&15)+1)*u16(0x38)*0.4e-3,read:0,done:false};
      forward=true; return;
    }
    const feedl=((regs[0x3D]&0x0F)<<16)|(regs[0x3E]<<8)|regs[0x3F], dir=(regs[0x02]&0x04)?-1:1;
    if(dir>0)forward=true;
    mv={dir,total:feedl,done:0,next:clock+ms,homeStop:dir<0};
  }
  if(moving)Object.assign(regs,{0x02:moving<0?0x94:0x90}),start();
  const regFile=()=>regs;
  const apply=(data)=>{ for(let k=0;k<data.length;k+=2){ const r=data[k],v=data[k+1]; regs[r]=v;
      if(r===0x0F&&v===1)start();
      if(r===0x3F&&v===1&&regs[0x3D]===0&&regs[0x3E]===0&&mv)mv.total=Math.min(mv.total,mv.done+Math.min(32,mv.done+1)); } };
  const scanning=()=>scan&&!scan.done;
  const statusByte=()=>0x80|(produced()>scan?.read||0?0:0x40)|0x10|((sensor&&pos<=0)?0x08:0)|((mv||scanning()||clock<enbUntil)?0x01:0);
  const usb=[];   // every request the host made, for encoding checks
  const dev={
    async controlTransferOut(s,data){ advance(1.5); usb.push({dir:'out',request:s.request,value:s.value,index:s.index,data:[...data]});
      if(s.requestType!=='vendor')return {status:'stall'};
      if(s.request===4&&s.value===0x83)apply([...data]);
      if(s.request===4&&s.value===0x82&&s.index===0&&data.length>=8)header=data[4]|(data[5]<<8)|(data[6]<<16)|(data[7]<<24);
      return {status:'ok',bytesWritten:data.length}; },
    async controlTransferIn(s,len){ advance(4.5); usb.push({dir:'in',request:s.request,value:s.value,index:s.index,len});
      let bytes=[0];
      if(s.value===0x8E&&s.request===4&&(s.index&0xFF)===0x22){ const r=s.index>>8; bytes=[r===0x41?statusByte():(regs[r]||0),0x55]; }
      return {status:'ok',data:new DataView(new Uint8Array(bytes).buffer)}; },
    async transferIn(ep,len){ usb.push({dir:'bulkin',ep,len});
      if(!scan){ violations.push('bulk read with no scan'); return {status:'stall'}; }
      if(header===null)violations.push('bulk read without a 0x82 header'); else if(header!==len)violations.push(`bulk read of ${len} after a header for ${header}`);
      header=null;
      const need=scan.read+len; if(need>scan.bytes){ violations.push('read past the end of the image'); return {status:'stall'}; }
      if(produced()-scan.read>8*1024*1024)violations.push('scanner buffer overrun: host too slow');
      const lines=Math.ceil(need/scan.lineBytes); advance(Math.max(0,scan.t0+100+lines*scan.lineMs-clock+0.01));   // blocks until the data exists
      const out=new Uint8Array(len); for(let i=0;i<len;i++)out[i]=((scan.read+i)>>1)*7+((scan.read+i)&1?3:0)&0xFF;
      scan.read=need; advance(1.5); return {status:'ok',data:new DataView(out.buffer)}; },
    async transferOut(ep,data){ advance(1.5);
      if(scan&&(regs[1]&1)){ violations.push('bulk write while the SCAN bit is still set (the real chip hangs)'); throw new Error('USB transfer timed out'); } usb.push({dir:'bulkout',ep,len:data.length}); return {status:'ok',bytesWritten:data.length}; },
  };
  const io={
    async send(o){ advance(1.5); sent++;
      if(o.kind!=='control'||o.value!==0x83)return;
      for(let k=0;k<o.data.length;k+=2){ const r=o.data[k],v=o.data[k+1]; regs[r]=v;
        if(r===0x0F&&v===1)start();
        if(r===0x3F&&v===1&&regs[0x3D]===0&&regs[0x3E]===0&&mv)mv.total=Math.min(mv.total,mv.done+Math.min(32,mv.done+1)); } },
    async status(){ advance(4.5); return statusByte(); }
  };
  return {io,dev,usb,hooks:{sleep:async t=>advance(t),now:()=>clock},get pos(){return pos;},get sent(){return sent;},get hitEnd(){return hitEnd;},get forward(){return forward;},get moving(){return !!mv||!!scanning();},violations,get scan(){return scan;}};
}


module.exports={carriage};
