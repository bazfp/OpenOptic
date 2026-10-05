// Exercise the page's actual acquisition/guard code without a browser or USB device.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
require('../capture_profiles.js');require('../capture_runtime.js');
const html=fs.readFileSync(require('node:path').join(__dirname,'../ui.html'),'utf8');
const acquisition=html.slice(html.indexOf('async function acquire('),html.indexOf('class LampNotReady'));
const guards=html.slice(html.indexOf('function enableScan()'),html.indexOf("async function connectScanner("));
(async()=>{
  const elements=new Map();let hardware=0,prepared=null,message='';
  const context={CAPTURE_PROFILES,CaptureRuntime:{...CaptureRuntime,run:async p=>{prepared=p;const e=Error('test acquisition boundary');e.name='ScanConfigurationError';throw e;}},
    CaptureSim:{create:()=>({})},settings:{pixelSampling:'average',exposureMultiplier:'1.5'},trace:[],traceMark:0,
    operationActive:false,cancelFlag:false,connected:true,dry:false,pending:null,
    $:id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);},
    log:()=>{},say:m=>{message=m;},progress:()=>{},console:{error:()=>{}},Cancelled:class extends Error{},
    checkCancel:()=>{},sleep:async()=>{},performance:{now:()=>0},window:{},
    status:async()=>{hardware++;return 8;},home:async()=>{hardware++;},
    stopMotor:async()=>{hardware++;},warmIfNeeded:async()=>{hardware++;},
    positionKnown:true,lampOnAt:null,gpioPoll:{busy:null}};
  vm.createContext(context);vm.runInContext(acquisition+guards,context);
  await vm.runInContext("guard(()=>acquire('prescan'))()",context);
  assert.equal(hardware,0,'staged exposure must not touch hardware, including guard cleanup');
  assert.match(message,/Choose an exposure/);
  context.settings.exposureMultiplier='1';context.dry=true;context.connected=false;
  await vm.runInContext("guard(()=>acquire('prescan'))()",context);
  assert.equal(prepared.acquisitionOptions.pixelSampling,'average');
  assert(prepared.frames[prepared.mainFrame].regs[3]&0x40);
  context.operationActive=true;vm.runInContext('enableScan()',context);
  assert(elements.get('pixelSampling').disabled&&elements.get('multiExposure').disabled&&elements.get('infrared').disabled);
  context.operationActive=false;vm.runInContext('enableScan()',context);
  assert(!elements.get('pixelSampling').disabled&&!elements.get('multiExposure').disabled&&!elements.get('infrared').disabled);
  console.log('Page acquisition/guard: invalid exposure touches no hardware; averaging reaches runtime; controls lock/unlock');
})().catch(e=>{console.error(e);process.exit(1);});
