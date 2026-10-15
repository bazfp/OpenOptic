// Independent integer oracles through the real runtime: split reads and shading uploads.
const assert=require('node:assert/strict');require('../capture_runtime.js');
const afe=(addr,value=0)=>({kind:'control',rt:0x40,request:12,value:0x83,index:0,data:[0x51,addr,0x3a,value>>8,0x3b,value&255]});
function fixture(ir){
  const make=(pixels,lines,sample)=>{const b=new Uint8Array(pixels*lines*6),v=new DataView(b.buffer);
    for(let y=0;y<lines;y++)for(let x=0;x<pixels;x++)for(let c=0;c<3;c++)v.setUint16(((y*pixels+x)*3+c)*2,sample(x,y,c),true);return b;};
  const probe=rgb=>make(512,1,(x,y,c)=>rgb[c]);
  const data=[probe([2200,3200,4200]),probe([3470,5740,8010]),
    make(10,1,(x,y,c)=>c===0?(x===0?65535:x>=8?50000:10000):[0,40000,30000][c]),
    probe([22000,16000,12000]),probe([34700,28700,24700]),
    make(43,128,(x,y,c)=>x===42&&c===1?2000:1000),
    make(43,128,(x,y,c)=>y<8?0:y>=120?65535:50000),make(43,1,()=>0)];
  const frames=data.map((b,i)=>({pixels:b.length/6/(i===5||i===6?128:1),lines:i===5||i===6?128:1,bytes:b.length,regs:{168:ir?4:0}}));
  return {data,p:{dpi:7200,mainFrame:7,frames,scan:{bytesPerSecond:1},lamp:{line:{frame:2},dark:{frame:5},shading:{frame:6}},ops:[]}};
}
(async()=>{
  for(const ir of [false,true]){
    const {p,data}=fixture(ir);
    for(let i=0;i<8;i++){
      if([2,5,6].includes(i))for(let repeat=0;repeat<(i===5?2:1);repeat++)p.ops.push(...[5,6,7].map(a=>afe(a)));
      if(i===3||i===7)p.ops.push(...[2,3,4].map(a=>afe(a)));
      const n=data[i].length;p.ops.push({kind:'read',frame:i,length:n/2},{kind:'read',frame:i,length:n/2});
      if(i===5||i===6)p.ops.push({kind:'control',rt:0x40,request:12,value:0x83,index:0,data:[0x5b,16,0x5c,0]},
        ...[0,1].map(()=>({kind:'write',data:Buffer.alloc(512).toString('base64')})));
    }
    let frame=0,at=0;const writes=[],controls=[];
    const io={control:async op=>controls.push(op.data),write:async b=>writes.push(Buffer.from(b)),read:async n=>{
      const b=data[frame].subarray(at,at+n);at+=b.length;if(at===data[frame].length){frame++;at=0;}return b;}};
    const result=await CaptureRuntime.run(p,io,{calibrate:true});
    assert.deepEqual(result,data[7]);
    const values=controls.filter(d=>d[0]===0x51).map(d=>[d[1],d[3]*256+d[5]]);
    assert.deepEqual(values.slice(0,3),[[5,348],[6,288],[7,268]]);
    assert.deepEqual(values.slice(3,6),[[2,17],[3,29],[4,40]]);
    assert.deepEqual(values.slice(-3),[[2,ir?17:18],[3,ir?29:30],[4,ir?40:42]]);
    assert.deepEqual(values.slice(9,12).map(v=>v[1]),ir?[348,288,8]:[336,276,20]);
    assert.deepEqual(values.slice(12,15).map(v=>v[1]),ir?[328,268,28]:[334,274,22]);
    const words=i=>{const b=Buffer.concat(writes.slice(i,i+2));return new DataView(b.buffer,b.byteOffset,b.byteLength);};
    const first=words(0),final=words(2),six=v=>Array.from({length:6},(_,i)=>v.getUint16(i*2,true));
    assert.deepEqual(six(first),[1000,8192,1045,8192,1000,8192]);
    assert.deepEqual(six(final),ir?[1000,12750,1045,12750,1000,12750]:[1000,12750,1045,12962,1000,13421]);
    assert.deepEqual([0,4,8].map(at=>final.getUint16(512+at,true)),[1000,2000,1000]);
    for(const at of [504,506,508,510,1016,1018,1020,1022])assert.equal(final.getUint16(at,true),0);
  }
  // Vendor type-1 witnesses: saved profiles, low gain, and saturated post gain.
  // Assert both the programmed main codes and the resulting shading words.
  for(const [before,after,targets] of [
    [[35,25,33],[35,26,35],[79380,79119,82739]],
    [[35,26,32],[35,27,34],[79380,79119,82739]],
    [[17,29,40],[18,30,42],[77824,79119,81920]],
    [[0,0,0],[1,2,4],[78602,78336,81920]],
    [[63,63,63],[63,63,63],[79380,80686,86835]],
  ]){
    const {p,data}=fixture(false),c=new CaptureRuntime.Calibration(p);
    c.gain=before.slice();c.frameDone(5,data[5]);
    c.phase=5;
    const codes=()=>[2,3,4].map(a=>{const d=c.control(afe(a)).data;return d[3]*256+d[5];});
    assert.deepEqual(codes(),before); // Reference acquisitions retain measured gain.
    c.frameDone(6,data[6]);assert.deepEqual(codes(),after);
    assert.deepEqual(c.gain,before); // Keep the reference gain separate.
    const v=new DataView(c.table.buffer);
    assert.deepEqual([2,6,10].map(at=>v.getUint16(at,true)),targets.map(t=>Math.floor(t*8192/50000)));
  }
  // PostGain=100 must preserve every IR code, including quantization boundaries.
  for(let code=0;code<=63;code++){
    const {p,data}=fixture(true),c=new CaptureRuntime.Calibration(p);
    c.gain=[code,code,code];c.frameDone(5,data[5]);c.frameDone(6,data[6]);
    assert.deepEqual(c.mainGain,c.gain);
    const v=new DataView(c.table.buffer);
    assert.deepEqual([2,6,10].map(at=>v.getUint16(at,true)),[12750,12750,12750]);
  }
  const {p,data}=fixture(false),c=new CaptureRuntime.Calibration(p);
  c.frameDone(0,data[0]);assert.throws(()=>c.frameDone(1,data[0]),/Nonpositive/);
  const valid=new CaptureRuntime.Calibration(p);for(let i=0;i<6;i++)valid.frameDone(i,data[i]);
  assert.throws(()=>valid.frameDone(6,new Uint8Array(data[6].length)),/Zero white/);
  console.log('Live colour/IR calibration: gain statistic, sign-magnitude offsets, trimmed references, hot column, split USB transfers and probe failures passed');
})().catch(e=>{console.error(e);process.exit(1);});
