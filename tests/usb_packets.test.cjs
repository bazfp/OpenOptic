// USB packet rules on Linux (usbfs/xHCI): the scanner streams each frame in 512-byte packets, the
// last one short. A bulk read that ends part-way through a packet while more data follows gets
// a full packet it has no room for, and Linux fails it with EOVERFLOW ("value too large for
// defined data type"). The official driver never does that: 62268 is read as 61952 + 316.
// Here every read must be whole packets, or the frame's final remainder, and the image must
// arrive in stream order.
const assert=require('node:assert/strict');
require('../capture_profiles.js');require('../capture_runtime.js');
const PACKET=512;
function device(p){
  let frame=-1,sent=0,size=0,counter=0; const reads=[];
  const deliver=n=>{
    const left=size-sent;
    if(n<left&&n%PACKET){ const e=new Error('value too large for defined data type'); e.code='EOVERFLOW'; throw e; }
    const len=Math.min(n,left), out=new Uint8Array(len);
    for(let i=0;i<len;i++)out[i]=(counter+i)&0xff;
    counter+=len; sent+=len; reads.push({frame,n,len}); return out;
  };
  return {reads,
    async control(op){ if(op.rt===0x40&&op.value===0x82&&op.data[0]===0){frame++;size=p.frames[frame].bytes;sent=0;} return Uint8Array.from(op.expected||[1]); },
    async write(){},
    async read(n){ return deliver(n); }};
}
(async()=>{
  for(const key of ['prescan','full','full7200']){
    const p=CAPTURE_PROFILES[key], d=device(p);
    const bytes=await CaptureRuntime.run(p,d,{sleep:async()=>{},readChunk:0x40000});
    // every read is whole packets except each frame's final remainder
    const byFrame=new Map(); for(const r of d.reads){ if(!byFrame.has(r.frame))byFrame.set(r.frame,[]); byFrame.get(r.frame).push(r); }
    for(const [f,rs] of byFrame){ rs.slice(0,-1).forEach(r=>assert.equal(r.n%PACKET,0,`${key} frame ${f}: mid-frame read of ${r.n}`));
      const last=rs[rs.length-1]; assert(last.n%PACKET===0||last.n<PACKET,`${key} frame ${f}: final read ${last.n}`);
      assert.equal(rs.reduce((a,r)=>a+r.len,0),p.frames[f].bytes); }
    // main image arrives in stream order (the device numbers its bytes)
    const first=d.reads.filter(r=>r.frame<p.mainFrame).reduce((a,r)=>a+r.len,0);
    for(let i=0;i<bytes.length;i+=4099)assert.equal(bytes[i],(first+i)&0xff,`${key}: image byte ${i} out of order`);
    const f2=byFrame.get(2).map(r=>r.n).join(' + ');
    console.log(`${key}: all ${d.reads.length} reads whole packets or a final remainder (white line ${f2}); image in order`);
  }
})().catch(e=>{console.error(e);process.exit(1);});
