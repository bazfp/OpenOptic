// Simulated GL843 for the captured profiles, on a virtual clock driven by the runtime's sleeps.
//  * The register address advances after every 0x84 read (as the real chip does).
//  * Moves take real time: move 1 would run ~20.5 s (slow table) unless the host stops it;
//    move 2 takes 3.44 s. Status 0x41 reads 0xD5 while moving.
//  * Failures: starting the motor during a move; stopping move 1 at the wrong moment (the
//    vendor stops it 2.56-2.57 s after the start write; earlier or later misplaces the frame).
// Optionally writes the resulting USB traces in the UI's "Save USB trace" format:
//   node tests/simulated_scanner.test.cjs [prescan-trace.json] [full-trace.json]
// CAPTURE_RUNTIME / CAPTURE_PROFILES_FILE select other versions for regression checks.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
require(process.env.CAPTURE_PROFILES_FILE||path.join(__dirname,'../capture_profiles.js'));
require(process.env.CAPTURE_RUNTIME||path.join(__dirname,'../capture_runtime.js'));
// ms from the start write to the stop write in each official capture; the test requires the
// runtime to reproduce it, so a profile without an entry here would go unchecked.
const OFFICIAL_STOP={prescan:2571.9,full:2559.7,full7200:2571.8,'full-ir':2571.7};   // full-ir: iSRD capture, sequence 1 (stop 0.8 ms after the GPIO4 event)
// Values the real scanner returned for 0x4C-0x4F when polled without re-addressing (trace 1790025029175).
const OBSERVED={0x4c:0x00,0x4d:0x80,0x4e:0x80,0x4f:0x20};

function scanner(p){
  const regs={},trace=[];let address=0,frame=-1,budget=0,clock=0,move=null;
  const violations=[],moves=[];
  const rec=e=>{e.t=+(clock/1000).toFixed(4);trace.push(e);};
  const moving=()=>move&&clock<move.end;
  const io={
    async control(op){
      if(op.rt===0x40){
        rec({dir:'out',req:op.request,value:op.value,index:op.index,data:[...op.data]});
        if(op.value===0x83&&op.data.length>1){
          if(moving()&&!move.stoppedAt){ move.stoppedAt=clock-move.start; move.end=clock+10; }
          for(let i=0;i<op.data.length;i+=2){
            const r=op.data[i],v=op.data[i+1];regs[r]=v;
            if(r===0x0f&&v===1){
              if(moving())violations.push(`motor start while a move is still running (trace #${trace.length-1})`);
              const feedl=((regs[0x3d]||0)<<16)|((regs[0x3e]||0)<<8)|(regs[0x3f]||0);
              if(!(regs[1]&1)&&feedl>1){ move={feedl,start:clock,end:clock+(feedl>15000?20500:3440),stoppedAt:null}; moves.push(move); }
              else if(!(regs[1]&1)) move={feedl,start:clock,end:clock+80,stoppedAt:null};
            }
          }
        } else if(op.value===0x83) address=op.data[0];
        if(op.value===0x82&&op.data[0]===0){frame++;budget=p.frames[frame].bytes;}
        return;
      }
      let v;
      if(op.value===0x8e&&op.index===0x20)v=1;
      else if(op.value===0x8e&&op.index===0x18)v=0;
      else if(op.value===0x84){
        if(address===0x41&&moving())v=0xd5;               // moving, FEEDFSH clear
        else if(address===op.register)v=op.expected[0];   // addressed: behave as recorded
        else v=OBSERVED[address]??0;                      // wrong register (e.g. 0x42+)
        address=(address+1)&0xff;
      } else v=op.expected[0];
      rec({dir:'in',req:op.request,value:op.value,index:op.index,data:[v]});
      return Uint8Array.of(v);
    },
    async write(b){rec({dir:'bulkout',len:b.length});},
    // deliver at the pace this resolution actually runs at (a line every (LINESEL+1) line periods)
    async read(n){assert(n<=budget);const len=Math.min(n,0x40000);budget-=len;clock+=len/(p.scan.bytesPerSecond/1000);return new Uint8Array(len);}
  };
  return {io,trace,violations,moves,hooks:{sleep:async ms=>{clock+=ms;},now:()=>clock}};
}

(async()=>{
  const outs={prescan:process.argv[2],full:process.argv[3]};let failed=false;
  for(const [name,p] of Object.entries(CAPTURE_PROFILES)){
    const s=scanner(p);
    try{ await CaptureRuntime.run(p,s.io,{...s.hooks,log:()=>{}}); }catch(e){ s.violations.push('run failed: '+e.message); }
    const m1=s.moves[0];
    if(!m1)s.violations.push('no positioning move');
    else if(m1.stoppedAt===null)s.violations.push(`move 1 was never stopped: the carriage runs its full ~20 s travel`);
    else if(OFFICIAL_STOP[name]===undefined)s.violations.push(`no official stop time recorded for profile "${name}"`);
    else if(Math.abs(m1.stoppedAt-OFFICIAL_STOP[name])>25)s.violations.push(`move 1 stopped at +${m1.stoppedAt.toFixed(0)} ms, the official software stops it at +${OFFICIAL_STOP[name]} ms (frame misplaced by ~${(Math.abs(m1.stoppedAt-OFFICIAL_STOP[name])/1000*960/14400*25.4).toFixed(1)} mm)`);
    let bad=0;for(let i=1;i<s.trace.length;i++)if(s.trace[i].value===0x84&&s.trace[i-1].value===0x84)bad++;
    if(bad)s.violations.push(`${bad} unaddressed repeated 0x84 reads`);
    if(s.violations.length){failed=true;console.log(`${name}: FAIL\n  - `+[...new Set(s.violations)].join('\n  - '));continue;}
    console.log(`${name}: move 1 stopped at +${m1.stoppedAt.toFixed(1)} ms (official ${OFFICIAL_STOP[name]}), move 2 (${s.moves[1].feedl} steps) awaited before the scan, status polls addressed`);
    if(outs[name])fs.writeFileSync(outs[name],JSON.stringify({device:'07b3:0c3b',bcdDevice:'4.00',fake:false,
      variant:'7600i-v1 (bcdDevice 4.00, GL843, = 7500i) [simulated scanner]',trace:s.trace},null,1));
  }
  if(failed)process.exit(1);
})().catch(e=>{console.error(e.message||e);process.exit(1);});
