// Right-click a roll frame -> "Show in Finder / File Explorer" (ui.html): the menu element exists before the script that looks it up, only folder-mode frames
// that still have a TIFF get it, and choosing it asks the helper to reveal the frame's TIFF in the roll folder.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../ui.html'),'utf8');
const el=html.indexOf('id="frameMenu"'), script=html.indexOf('<script>');
assert(el>0&&script>0&&el<script,'the menu element comes before the page script that uses it');
assert(/f\.oncontextmenu=e=>\{ if\(!folderMode\(\)\|\|missing\.has\(r\.number\)\|\|!\(r\.files\|\|\[\]\)\.length\) return; e\.preventDefault\(\); select\(r\); showFrameMenu\(e,r\); \};/.test(html),'folder-mode frames with files get the menu; others keep the browser menu');
assert(/api\('\/api\/files\/reveal',\{dir:outFolder\(\),name:f\.name\}\)/.test(html),'reveals the frame file in the roll folder');
assert(/\(r\.files\|\|\[\]\)\.find\(x=>x\.kind==='tiff'\)/.test(html),'prefers the frame\'s TIFF');
assert(/\$\('fmReveal'\)\.onclick=/.test(html)&&/e\.key==='Escape'\) hideFrameMenu/.test(html),'wired, closes on Escape');
const name=html.match(/const FM_NAME=([^\n]*);/)[1]; const pick=(sep,plat)=>new Function('sep','navigator',`return ${name}`)(sep,{platform:plat,userAgent:plat});
assert.equal(pick('\\','Win32'),'File Explorer'); assert.equal(pick('/','MacIntel'),'Finder'); assert.equal(pick('/','Linux x86_64'),'the file manager');
console.log('roll frame menu: wired, label per platform, reveals the frame TIFF');
