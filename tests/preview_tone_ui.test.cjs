// The preview follows the Tone setting for slides (ui.html previewFilm): raw linear look for "linear", toned look for "ready to view";
// negatives always keep the inverted film-aware look.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../ui.html'),'utf8');
const line=html.split('\n').find(l=>l.startsWith('const previewFilm='));
assert(line,'previewFilm exists'); const gl=true; const previewFilm=eval('('+line.slice('const previewFilm='.length).replace(/;\s*$/,'')+')');
assert.equal(previewFilm({film:'pos',tone:'linear'}),'display'); assert.equal(previewFilm({film:'pos',tone:'view'}),'pos');
assert.equal(previewFilm({film:'neg',tone:'linear'}),'neg'); assert.equal(previewFilm({film:'neg',tone:'view'}),'neg');
// without an 8100 (gl = null) the 7600i's preview is unchanged whatever the Tone setting
{ const gl=null; const pf=eval('('+line.slice('const previewFilm='.length).replace(/;\s*$/,'')+')'); assert.equal(pf({film:'pos',tone:'linear'}),'pos'); assert.equal(pf({film:'pos',tone:'view'}),'pos'); assert.equal(pf({film:'neg',tone:'linear'}),'neg'); }
// every place that renders a preview goes through it, and Tone/Film changes redraw the one on screen
assert(/renderPreview\(planes,g,s\.film==='display'\?'display':previewFilm\(s\),previewOpts\(s\)\)/.test(html),'makePreview uses previewFilm and previewOpts');
assert(/const previewOpts=s=>\(\{skipSaturated:!!gl\|\|s\.tone==='view'\}\)/.test(html),'saturated pixels are skipped only for the 8100 or Tone: ready to view');
assert(/film:s\.film==='display'\?'display':previewFilm\(s\)/.test(html),'the live view uses previewFilm');
assert(/if\(id==='tone'\|\|id==='film'\) redrawPreview\(\)/.test(html),'Tone and Film changes redraw the preview');
assert(/id="adjReset"/.test(html)&&/\$\('adjReset'\)\.addEventListener\('click'/.test(html),'reset button wired');
assert(/\['brightNum','brightness','num'\],\['contrastNum','contrast','num'\]/.test(html),'number boxes carry the settings');
console.log('preview follows Tone: slides linear/toned, negatives inverted, redraw wired');
