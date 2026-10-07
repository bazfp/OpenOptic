// Optional browser-level test: drives ui.html in jsdom against a running helper (dry-run scanner, real files).
//   npm install jsdom@24   (in any folder; set JSDOM_PATH to its node_modules/jsdom)
//   ./openoptic-linux-x64 -no-browser -port 47996 -out /tmp/e2e &   then
//   node tests/ui_e2e.cjs http://127.0.0.1:47996/ /tmp/e2e
// Drive the real page (served by the real helper) in jsdom: dry-run scanner, real files on disk.
const {JSDOM,VirtualConsole}=require(process.env.JSDOM_PATH||'jsdom');
const fs=require('fs'),path=require('path');
const base=process.argv[2], outRoot=process.argv[3];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const vc=new VirtualConsole(); const errors=[];
  vc.on('jsdomError',e=>errors.push(e.message)); vc.on('error',e=>errors.push(String(e)));
  const store={};
  const dom=await JSDOM.fromURL(base,{runScripts:'dangerously',resources:'usable',pretendToBeVisual:true,virtualConsole:vc,
    beforeParse(w){
      w.Blob=Blob; w.fetch=(u,o)=>fetch(new URL(u,base),o);
      w.localStorage.__proto__.setItem; // real jsdom localStorage
      w.confirm=()=>true; w.alert=m=>errors.push('alert: '+m); w.prompt=(q,d)=>w.__promptAnswer??d;
      w.HTMLCanvasElement.prototype.getContext=function(){const c=this;return {createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData(){},drawImage(){},translate(){},rotate(){},set imageSmoothingQuality(v){}};};
      w.HTMLCanvasElement.prototype.toDataURL=function(){return 'data:image/jpeg;base64,/9j/2Q==';};
    }});
  const w=dom.window,$=id=>w.document.getElementById(id);
  await new Promise(r=>w.addEventListener('load',r));
  const status=()=>$('rollStatus').textContent;
  const waitIdle=async(label)=>{for(let i=0;i<900;i++){await sleep(100);if(!/Scanning|Saving|Connecting|Quick/.test(status())&&!$('bScan').disabled)return;}throw new Error('timeout '+label+': '+status());};
  console.log('default folder:',$('outDir').value,'| prefix:',$('prefix').value,'| next:',$('nextName').textContent);
  // layout: scan controls sit under the preview, above the roll/log tabs, not in the options panel
  const ctl=$('bScan').closest('.controls');
  console.log('scan buttons under preview:',!!ctl&&ctl.parentElement.className==='stage'&&ctl.previousElementSibling.id==='viewer'&&!$('bScan').closest('aside')&&!!$('bPreview').closest('.controls'),
    '| warm-up default:',$('warm').value,'s');
  // folder popup: browse, create, choose
  fs.mkdirSync(path.join(outRoot,'Existing roll'),{recursive:true});
  $('outDir').value=path.join(outRoot,'not-yet-created'); $('outDir').dispatchEvent(new w.Event('change'));
  $('bChoose').click(); await sleep(400);
  console.log('popup open:',$('picker').open,'| shows:',$('pkPath').value,'|',$('pkInfo').textContent.slice(0,60));
  $('pkPath').value=outRoot; $('pkGo').click(); await sleep(300);
  console.log('  sub-folders:',[...$('pkList').querySelectorAll('button')].map(b=>b.textContent).join(', '),'| roots:',[...$('pkRoots').querySelectorAll('button')].map(b=>b.textContent).join(' '));
  w.__promptAnswer='Roll 042'; $('pkNew').click(); await sleep(400);
  console.log('  after New folder:',$('pkPath').value,'| exists on disk:',fs.existsSync(path.join(outRoot,'Roll 042')));
  $('pkNative').hidden=false; $('pkNative').click(); await sleep(400); console.log('  system dialog (none installed here):',$('pkInfo').textContent.slice(0,80));
  $('pkUse').click(); await sleep(100);
  console.log('  chosen:',$('outDir').value,'| popup closed:',!$('picker').open);
  // Space inside the popup must not start a scan
  $('bChoose').click(); await sleep(300); const before=status(); $('pkList').querySelector('button')?.dispatchEvent(new w.KeyboardEvent('keydown',{code:'Space',bubbles:true})); await sleep(200);
  console.log('  Space in popup ignored:',status()===before); $('picker').querySelector('button[value=cancel]').click(); $('picker').removeAttribute('open');
  // configure the roll
  const set=(id,v)=>{const e=$(id);e.value=v;e.dispatchEvent(new w.Event('change'));};
  set('prefix','Roll042_');set('nextNo','1');set('digits','2');set('orient','8');set('profileSel','prescan');
  $('bDry').click(); await sleep(300);
  console.log('dry run:',status());
  // cold lamp for the first 8 s: the page must stop, wait, retry, then scan
  set('lampCheck','wait');            // default is warn-only; exercise the retry path here
  w.__dryLampReadyAt=Date.now()+8000; let sawWait=false;
  const obs=setInterval(()=>{ if(/Illumination outside/.test(status()))sawWait=true; },100);
  for(let i=0;i<2;i++){ w.document.dispatchEvent(new w.KeyboardEvent('keydown',{code:'Space',bubbles:true})); await sleep(200); await waitIdle('frame'+i); console.log(' ',status()); }
  clearInterval(obs);
  const lampLog=[...$('log').children].map(d=>d.textContent).filter(t=>/illumination check|black level/.test(t));
  console.log('  cold lamp: page waited and retried:',sawWait,'| lamp-check log lines:',lampLog.length,'| first:',(lampLog[0]||'').trim().slice(10,120));
  console.log('  last lamp check:',(lampLog[lampLog.length-1]||'').trim().slice(10,140));
  // choose a taken number: must refuse before scanning
  set('nextNo','1'); $('bScan').click(); await sleep(300); await waitIdle('taken'); console.log('  taken number ->',status());
  $('bNextFree').click(); await sleep(500); console.log('  next free ->',$('nextName').textContent);
  // full resolution frame
  set('profileSel','full'); $('bScan').click(); await sleep(300); await waitIdle('full'); console.log(' ',status());
  const dir=path.join(outRoot,'Roll 042','dry-run');
  console.log('files:',fs.readdirSync(dir).sort().map(f=>f+' '+fs.statSync(path.join(dir,f)).size).join(' | '));
  const roll=JSON.parse(fs.readFileSync(path.join(dir,'Roll042_roll.json')));
  console.log('roll record frames:',roll.frames.map(f=>f.base+' '+f.files.map(x=>x.kind).join('+')).join(', '));
  console.log('roll list tiles:',w.document.querySelectorAll('#roll figure').length,'| dry-run frames kept out of the saved roll list:',JSON.parse(w.localStorage.getItem('opticfilm.roll.v1')).records.length===0);
  // unwritable folder -> frame kept in memory -> fix folder -> Retry
  set('profileSel','prescan'); set('outDir','/proc/not-writable');
  $('bScan').click(); await sleep(300); for(let i=0;i<300&&$('pendingRow').hidden;i++)await sleep(100);
  console.log('  unwritable folder ->',status().slice(0,110),'| retry shown:',!$('pendingRow').hidden,'| scan disabled:',$('bScan').disabled);
  set('outDir',path.join(outRoot,'Roll 042b')); $('bRetry').click(); await sleep(300); await waitIdle('retry');
  console.log('  after Retry ->',status());
  // rescan an earlier frame with overwrite
  const tile=[...w.document.querySelectorAll('#roll figure')].find(f=>f.textContent.includes('Roll042_04'));
  tile.click(); await sleep(100); [...$('details').querySelectorAll('button')][0].click(); await sleep(100);
  console.log('  rescan armed ->',$('scanLabel').textContent);
  $('bScan').click(); await sleep(300); await waitIdle('rescan');
  console.log('  after rescan ->',status(),'| next number unchanged:',$('nextName').textContent.split(' ')[0]);
  console.log('files in Roll 042b:',fs.readdirSync(path.join(outRoot,'Roll 042b','dry-run')).sort().join(' | '));
  console.log('page errors:',errors.length?errors:'none');
  w.close();
})().catch(e=>{console.error('E2E FAILED',e);process.exit(1);});
