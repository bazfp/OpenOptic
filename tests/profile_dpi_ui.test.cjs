// The roll list's resolution label (ui.html profileDpi): the number before "ppi"/"dpi", not the 8100's model number in its name.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../ui.html'),'utf8');
const line=html.split('\n').find(l=>l.startsWith('function profileDpi('));
assert(line,'profileDpi exists'); const profileDpi=eval('('+line+')');
for(const [name,want] of [['OpticFilm 8100 (3600 ppi)','3600'],['OpticFilm 8100 (7200 ppi)','7200'],['OpticFilm 8100 preview (900 ppi)','900'],
  ['Captured full frame 3600','3600'],['Captured full frame 7200','7200'],['Captured prescan',''],['',''],[undefined,'']])
  assert.equal(profileDpi(name),want,`${name} -> ${want}`);
console.log('roll list resolution label: 8100 names give their ppi, 7600i names unchanged');
