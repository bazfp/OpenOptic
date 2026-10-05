// Front buttons on real-hardware paths, with a fake USB device: the interrupt listener survives
// errors and resumes, the GPIO poll catches presses when no events arrive, a press seen by both
// paths acts once, and polling never runs during an operation.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../ui.html'),'utf8');
const code=html.slice(html.indexOf('const scannerEvents='),html.indexOf('function stopScannerEvents'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const clicks=[], logs=[], el=new Map();
  let reg6d=0xF6, intrQueue=[], selected=null, readsDuringOp=0;
  const dev={configuration:{interfaces:[{alternate:{endpoints:[{type:'interrupt',direction:'in',endpointNumber:3,packetSize:1}]}}]},
    async interruptIn(){ await sleep(20); const x=intrQueue.shift(); if(x instanceof Error) throw x; return x?{status:'ok',data:Uint8Array.of(x)}:{status:'timeout'}; },
    async controlTransferOut(setup,data){ if(setup.value===0x83) selected=data[0]; return {status:'ok'}; },
    async controlTransferIn(setup){ if(ctx.operationActive) readsDuringOp++; await sleep(2);
      return {status:'ok',data:new DataView(Uint8Array.of(setup.value===0x8E?1:(selected===0x6D?reg6d:0)).buffer)}; }};
  const ctx={dev,connected:true,dry:false,operationActive:false,monitoring:false,pending:null,settings:{btn3:'scan',btn2:'preview'},
    performance,setTimeout,clearTimeout,console,sleep,
    hex:v=>'0x'+v.toString(16).padStart(2,'0'),
    log:(k,m)=>logs.push(m),
    $:id=>{ if(!el.has(id)) el.set(id,{id,disabled:false,open:false,classList:{add(){},remove(){}},click(){ clicks.push(id); }}); return el.get(id); }};
  ctx.rawIn=async(request,value,index,len)=>{ const r=await dev.controlTransferIn({value}); return new Uint8Array(r.data.buffer); };
  vm.createContext(ctx); vm.runInContext(code+';globalThis.T={scannerEvents,startScannerEvents,startButtonPoll,gpioPoll,lastPress};',ctx);
  const T=ctx.T;
  // 1. listener: errors (including a pending-read 429) never stop it; events after them still act
  const busy=Object.assign(new Error('pending'),{name:'Busy'});
  intrQueue=[busy,new Error('io'),new Error('io'),new Error('io'),0x04];
  T.startScannerEvents();
  for(let i=0;i<100&&!clicks.length;i++) await sleep(50);
  assert.deepEqual(clicks,['bScan'],'button A event after 3 errors still scans: '+logs.join(' | '));
  assert(logs.some(m=>/interrupted/.test(m))&&logs.some(m=>/resumed/.test(m)),'error and recovery are logged');
  // 2. poll: no events, button B pressed (bit 0x02 drops) -> Check framing, once
  T.startButtonPoll(); await sleep(400); clicks.length=0; T.lastPress.btn2=-1e9;
  reg6d=0xF4; await sleep(400); reg6d=0xF6; await sleep(400);
  assert.deepEqual(clicks,['bPreview'],'GPIO poll press of B');
  // 3. same press via event and poll -> one action
  clicks.length=0; T.lastPress.btn3=-1e9; intrQueue.push(0x04); reg6d=0xF2; await sleep(400); reg6d=0xF6; await sleep(300);
  assert.deepEqual(clicks,['bScan'],'event + poll of one press act once');
  // 4. holder sensor bit changing does not count as a press and does not block later presses
  clicks.length=0; reg6d=0xFE; await sleep(500); assert.deepEqual(clicks,[],'non-button bit change ignored');
  T.lastPress.btn3=-1e9; reg6d=0xFA; await sleep(400); reg6d=0xFE; await sleep(300);
  assert.deepEqual(clicks,['bScan'],'press still detected after the sensor bit changed');
  // 5. no polling while an operation runs
  ctx.operationActive=true; readsDuringOp=0; await sleep(500); ctx.operationActive=false;
  assert.equal(readsDuringOp,0,'no register reads during operations');
  T.scannerEvents.run++; T.gpioPoll.run++;
  console.log('Front buttons: listener survives errors and resumes; GPIO poll backup; one action per press; sensor-bit changes ignored; idle-only polling');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
