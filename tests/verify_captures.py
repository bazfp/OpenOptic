#!/usr/bin/env python3
"""Independent wire-payload comparison against original PCAPs.
python3 tests/verify_captures.py prescan.pcapng 3600ppifullframehdr.pcapng [7200ppifullframehdr.pcapng]
"""
import base64, hashlib, json, pathlib, sys
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'tools'))
from capture_analyse import decode
root=pathlib.Path(__file__).resolve().parents[1]
profiles=json.loads((root/'capture_profiles.js').read_text().split('globalThis.CAPTURE_PROFILES=')[1].rstrip(';\n'))
args=sys.argv[1:]
names=['prescan','full','full7200']
if args[:1]==['--profile']:
    names=[args[1]]; args=args[2:]
    assert len(args)==1 and names[0] in profiles
for name,path in zip(names,args):
    p=profiles[name];_,raw=decode(path)
    assert p['sha256']==hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
    expected=[]
    for e in raw:
        if e['kind']=='ctl' and e['bmr'] in (64,192):
            expected.append(('control',e['bmr'],e['req'],e['wv'],e['wi'],e['out'] if e['bmr']==64 else e['inp']))
        elif e['kind']=='bout':expected.append(('write',e['data']))
    actual=[]
    for o in p['ops']:
        if o['kind']=='control':actual.append(('control',o['rt'],o['request'],o['value'],o['index'],bytes(o.get('data',o.get('expected')))))
        elif o['kind']=='write':actual.append(('write',base64.b64decode(o['data'])))
    assert actual==expected, name+' wire payload mismatch'
    # Verify transaction boundaries as well as totals: no reads may migrate past
    # the completion poll, even when capture payload bytes are missing.
    budget=0
    for o in p['ops']:
        if o['kind']=='control' and o['rt']==64 and o['value']==0x82 and o['data'][0]==0:
            assert budget==0, name+' new read header before previous frame was drained'
            budget=int.from_bytes(bytes(o['data'][4:8]),'little')
        elif o['kind']=='read':
            budget-=o['length']; assert budget>=0, name+' reads exceed active USB transaction'
        elif o['kind']=='control' and o['rt']==192 and o['value']==0x8e and o['index']==0x18:
            assert budget==0, name+' completion polled before all image bytes were read'
    assert budget==0
    read_ops=sum(o['length'] for o in p['ops'] if o['kind']=='read')
    captured=sum(len(e['data']) for e in raw if e['kind']=='bin')
    missing=p.get('captureTruncatedBytes',0)
    assert read_ops==captured+missing, name+' image byte accounting'
    note=f'; {missing:,} B of the main frame are absent from the capture and are restored within the original read transaction before completion/shutdown' if missing else ''
    print(name+': every vendor control payload/response and bulk OUT payload matches; all received image bytes accounted for'+note)
