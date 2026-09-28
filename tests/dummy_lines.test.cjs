// Fewer CCD dummy lines (Advanced → Dummy lines). Only the main scan changes: its LINESEL, written
// in the start write, and its motor tables (cruise period scaled so the carriage still moves the
// recorded steps per delivered line). Calibration frames, geometry and LINCNT stay as recorded.
const assert=require('node:assert/strict');
require('../capture_profiles.js');require('../capture_runtime.js');
const tables=p=>{ let slot=null; const out=[];
  p.ops.forEach((o,i)=>{ if(o.kind==='control'&&o.rt===0x40&&o.value===0x83&&o.data.length>1)
      for(let j=0;j<o.data.length;j+=2) if(o.data[j]===0x5b) slot=(o.data[j+1]&0x40)?((o.data[j+1]>>3)&7):null;
    if(o.kind==='write'){ const b=Buffer.from(o.data,'base64'), t=[]; for(let k=0;k+1<b.length;k+=2)t.push(b[k]|b[k+1]<<8); out.push({i,slot,t}); } });
  return out; };
(async()=>{
  for(const key of ['prescan','full','full7200']){
    const base=CAPTURE_PROFILES[key], original=JSON.stringify(base), L=base.scan.lineSel, LP=base.scan.lPeriod;
    assert.equal(CaptureRuntime.prepareProfile(base,{dummyLines:'recorded'}),base,'default wire sequence unchanged');
    for(const setting of ['fewer','none']){
      const p=CaptureRuntime.prepareProfile(base,{dummyLines:setting}), L2=setting==='none'?0:Math.max(0,L-1);
      if(L2===L){ assert.equal(p,base); continue; }
      const before=tables(base), after=tables(p), changed=[];
      assert.equal(p.ops.length,base.ops.length);
      p.ops.forEach((op,i)=>{ if(JSON.stringify(op)!==JSON.stringify(base.ops[i])) changed.push(i); });
      const mainTables=after.filter((t,k)=>JSON.stringify(t.t)!==JSON.stringify(before[k].t));
      assert(mainTables.length>=1&&mainTables.every(t=>t.slot<=2),'only main-scan tables (slots 0-2) change');
      const C=before.find(t=>t.i===mainTables[0].i).t.at(-1), C2=mainTables[0].t.at(-1);
      assert.equal((L2+1)*LP/C2,(L+1)*LP/C,'steps per delivered line (vertical sampling) preserved');
      const start=changed.find(i=>p.ops[i].kind==='control');
      assert.deepEqual(changed,[...mainTables.map(t=>t.i),start].sort((a,b)=>a-b),'nothing else changes');
      const d=p.ops[start].data, j=d.indexOf(0x0f);
      assert.deepEqual(d.slice(j-2,j+2),[0x1e,(base.frames[base.mainFrame].regs[0x1e]&0xf0)|L2,0x0f,1],'LINESEL set in the start write');
      assert.ok(p.ops.findIndex(o=>o.kind==='read'&&o.frame===base.mainFrame)>start);
      for(const [i,f] of p.frames.entries()){ assert.equal(f.bytes,base.frames[i].bytes); assert.deepEqual({...f.regs,30:0},{...base.frames[i].regs,30:0}); }
      assert.equal(p.frames.slice(0,-1).every((f,i)=>f.regs[0x1e]===base.frames[i].regs[0x1e]),true,'calibration frames keep their dummy lines');
      assert.equal(p.scan.seconds.toFixed(0),(base.scan.seconds*(L2+1)/(L+1)).toFixed(0));
      assert.deepEqual(p.acquisitionOptions.dummyLines,{setting,recorded:L,used:L2});
      // combined with sensor averaging, both changes apply
      const both=CaptureRuntime.prepareProfile(base,{dummyLines:setting,pixelSampling:'average'});
      assert(both.frames[both.mainFrame].regs[3]&0x40); assert.equal(both.frames[both.mainFrame].regs[0x1e]&15,L2);
      // the modified sequence still runs end to end and delivers the same image size
      const img=await CaptureRuntime.run(p,{control:async op=>Uint8Array.from(op.expected||[1]),write:async()=>{},read:async n=>new Uint8Array(n)},{sleep:async()=>{}});
      assert.equal(img.length,base.frames[base.mainFrame].bytes);
      console.log(`${key} ${setting}: LINESEL ${L}→${L2}, cruise ${C}→${C2}, ${base.scan.seconds} s → ${p.scan.seconds} s at ${(p.scan.bytesPerSecond/1e6).toFixed(2)} MB/s; only ${mainTables.length} tables and the start write change`);
    }
    assert.equal(JSON.stringify(base),original,'recorded profile not mutated');
  }
  assert.throws(()=>CaptureRuntime.prepareProfile(CAPTURE_PROFILES.full,{dummyLines:'bad'}),e=>e.name==='ScanConfigurationError');
})().catch(e=>{console.error(e);process.exit(1);});
