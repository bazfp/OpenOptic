// Whole-frame pipeline with extra passes: colour + 3× long pass + infrared, through Roll.scanFrame.
// Checks the saved files (TIFF, IR TIFF, mask PNG, sidecar) and that merge and repair ran.
const assert=require('node:assert/strict');
require('../capture_runtime.js');require('../enhance.js');require('../roll.js');
const P=480, L=760, shifts=[0,2,4], FS=65535;
const profile={name:'synthetic 3600',dpi:3600,yres:7200,shifts,mainFrame:0,frames:[{pixels:P,lines:L,bytes:P*L*6,regs:{37:0,38:0,39:L}}]};
let seed=99; const rnd=()=>((seed=(seed*1103515245+12345)>>>0)/4294967296), gauss=()=>{let u=0;while(!u)u=rnd();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*rnd());};
const scene=(y,x,c)=>[15000,6500,3200][c]*(0.3+0.7*(0.5+0.5*Math.sin(x*0.05+c)*Math.cos(y*0.017)));
const dust=new Float32Array(P*L).fill(1);   // transmission in raw coordinates
for(let k=0;k<25;k++){ const cy=60+Math.floor(rnd()*(L-120)), cx=40+Math.floor(rnd()*(P-80)), r=2+Math.floor(rnd()*3);
  for(let y=cy-2*r;y<=cy+2*r;y++) for(let x=cx-r;x<=cx+r;x++) if(((y-cy)/2)**2+(x-cx)**2<=r*r) dust[y*P+x]=0.2; }
const frame=(fn)=>{ const b=new Uint8Array(P*L*6), v=new Uint16Array(b.buffer);
  for(let y=0;y<L;y++) for(let x=0;x<P;x++) for(let c=0;c<3;c++){ const yy=y-shifts[c]; v[(y*P+x)*3+c]=Math.max(0,Math.min(FS,Math.round(fn(yy,x,c)))); } return b; };
const dk=[980,1040,1390];
const colour=frame((y,x,c)=>scene(y,x,c)*dust[Math.max(0,y)*P+x]+dk[c]+gauss()*25);
const long=frame((y,x,c)=>Math.min(FS,(scene(y,x,c)*dust[Math.max(0,y)*P+x])*3.1+[870,1180,2040][c]+dk[c]+gauss()*45));
const irb=frame((y,x,c)=>55000*Math.pow(scene(y-2,x,0)/15000,0.06)*dust[Math.max(0,y-2)*P+x]+gauss()*60);   // IR 2 raw lines off
const lamp={dark:{mean:dk,noise:{mean:dk,tvar:[2400,2400,2400]}},shading:{mean:[57000,61000,60000],noise:{mean:[57000,61000,60000],tvar:[270000,240000,270000]}}};
(async()=>{
  for(const mode of ['range','fusion']){
    const saved=new Map(), logs=[];
    const settings={prefix:'mp_',digits:2,tiff:'aligned',pixels:'square',profile:'full',orientation:1,film:'neg',mirror:true,blackLevel:false,multiExposure:mode,meFactor:'3',infrared:mode==='range'?'repair':'detect'};
    const rec=await Roll.scanFrame({settings,number:1,log:m=>logs.push(m),
      acquire:async()=>({bytes:new Uint8Array(colour),profile,lamp,long:{bytes:new Uint8Array(long),profile,lamp,factor:3},ir:{bytes:new Uint8Array(irb),profile,lamp:{dark:{mean:[0,0,0]}}}}),
      makePreview:async(planes,g,s)=>({thumb:'t',large:s.film}),
      store:{exists:async()=>[],save:async(name,parts)=>{const b=Buffer.from(await new Blob(parts).arrayBuffer());saved.set(name,b);return {bytes:b.length};}}});
    const names=[...saved.keys()].sort();
    const side=JSON.parse(saved.get('mp_01.json'));
    assert(names.includes('mp_01.tif')&&names.includes('mp_01_irmask.png'),'files: '+names);
    assert.equal(names.includes('mp_01_ir.tif'),mode==='fusion','IR TIFF only in detect mode');
    const me=side.processing.multiExposure, ir=side.processing.infrared;
    assert.equal(me.mode,mode); assert(me.fits.every(f=>Math.abs(f.slope-3.1)<0.15),'fits '+JSON.stringify(me.fits));
    assert(ir.registration.ok&&Math.abs(ir.registration.dy+1)<0.5,'IR content 2 raw lines low is moved up one output row: '+JSON.stringify(ir.registration));
    if(mode==='range'){ assert(ir.repair.filledDefects>=15,'defects filled: '+JSON.stringify(ir.repair)); assert.deepEqual(rec.enhanced,['ME','IR']); }
    else assert(me.fusion&&/positive/.test(me.fusion.output));
    const tif=saved.get('mp_01.tif'); assert(tif.length>P*370*6,'TIFF holds the frame');
    console.log(`${mode}: ${names.join(', ')}; slopes ${me.fits.map(f=>f.slope).join('/')}; IR offset ${ir.registration.dy.toFixed(2)}/${ir.registration.dx.toFixed(2)}${ir.repair?`; ${ir.repair.filledDefects} defects filled`:''}`);
  }
})().catch(e=>{console.error(e);process.exit(1);});
