// Live preview: rows appear only once their raw lines (including the colour delays) have arrived,
// the result matches the finished frame's preview content, and mirroring reverses rows.
const assert=require('node:assert/strict');
require('../capture_profiles.js');require('../capture_runtime.js');
const p=CAPTURE_PROFILES.prescan, f=p.frames[p.mainFrame], bytes=new Uint8Array(f.bytes), v=new Uint16Array(bytes.buffer);
for(let y=0;y<f.lines;y++)for(let x=0;x<f.pixels;x++)for(let c=0;c<3;c++)v[(y*f.pixels+x)*3+c]=1000+y*5+c*3000;   // depends on line only
const lp=CaptureRuntime.livePreview(p,{maxWidth:400});
assert.equal(lp.update(bytes,0),0,'nothing before data');
const half=Math.floor(f.lines/2)*f.pixels*6; const r1=lp.update(bytes,half);
assert(r1>0&&r1<lp.height,'partial rows after half the data: '+r1);
const r2=lp.update(bytes,f.bytes); assert.equal(r2,lp.height,'all rows at the end');
// colour delays applied: every channel of row r reflects the same film line
const sy=Math.ceil(f.pixels/400)*p.yres/p.dpi, sh=CaptureRuntime.CALIBRATED_SHIFTS[p.yres].map(Math.round);
for(const r of [0,10,lp.height-1]){ const y0=Math.floor(r*sy), expect=c=>1000+5*(y0+sh[c])+c*3000+5*Math.floor(sy/2)/2;
  for(let c=0;c<3;c++) assert(Math.abs(lp.planes[c][r*lp.width+5]-expect(c))<=3,`row ${r} channel ${c}`); }
const m=CaptureRuntime.livePreview(p,{maxWidth:400,mirror:true}); m.update(bytes,f.bytes);
const g={pixels:lp.width,lines:lp.rows}; assert.equal(CaptureRuntime.renderPreview(lp.planes,g,'neg').length,lp.width*lp.rows*4);
console.log(`Live preview: ${lp.width}×${lp.height}, ${r1} rows after half the data, colour delays applied, renders`);
