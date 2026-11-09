#!/usr/bin/env python3
"""Extract vendor transactions and uploaded tables; never embed captured photographs.
Usage: python3 tools/build_capture_profiles.py prescan.pcapng 3600ppifullframehdr.pcapng [7200ppifullframehdr.pcapng]
       python3 tools/build_capture_profiles.py --add KEY "Name" DPI YRES G,B capture.pcapng[@SEQUENCE]
The --add form inserts or replaces one profile in the existing capture_profiles.js. SEQUENCE picks
one scan sequence of a capture that holds several (the iSRD capture: 0 = colour, 1 = infrared);
sequences start where the host re-reads the device descriptor before booting the scanner again.
"""
import base64, hashlib, json, pathlib, sys
from capture_analyse import decode

def sequences(raw):
    """Split a capture's events into scan sequences: each starts at a GET_DESCRIPTOR(device)
    followed within 50 ms by the vendor's first status read (0x8E index 0)."""
    starts=[]
    for i,e in enumerate(raw):
        if e['kind']=='ctl' and e['bmr']==0x80 and e['req']==6 and e['wv']==0x100:
            nxt=next((x for x in raw[i+1:i+8] if x['kind']=='ctl' and x['bmr']==0xC0 and x['wv']==0x8E and x['wi']==0),None)
            if nxt and nxt['ts']-e['ts']<50_000: starts.append(i)
    starts=starts or [0]
    return [raw[a:b] for a,b in zip(starts,starts[1:]+[len(raw)])]

def first_upload(ops,start):
    """Index where a move's own setup begins: the last contiguous run of table uploads (0x82 header + bulk write
    pairs) before its 0x0F=1 start. Everything earlier in the capture is the boot sequence."""
    heads=[j for j in range(start) if ops[j]['kind']=='control' and ops[j]['value']==0x82 and ops[j]['index']==1]
    if not heads: raise ValueError('no table uploads before the move')
    first=heads[-1]
    while first>=2 and ops[first-1]['kind'] in ('write','delay') and ops[first-2]['kind']=='control' and ops[first-2]['value']==0x82 and ops[first-2]['index']==1: first-=2
    return first

def forward_plan(ops,lo=5000,hi=50000,reverse=False,after=0):
    """GL845: the first recorded forward positioning move (scan off, between lo and hi steps) after op `after`. Forward
    travel has no home-sensor stop, so it is accepted only because the chip ends it by itself after its step count.
    reverse=True finds a bounded reverse move instead (the vendor's step back between the preview and the main scan)."""
    regs={}; start=steps=None
    for i,o in enumerate(ops):
        if o['kind']=='control' and o['rt']==0x40 and o['value']==0x83 and len(o['data'])>1:
            for a,b in zip(o['data'][::2],o['data'][1::2]):
                regs[a]=b
                n=(regs.get(0x3D,0)<<16)|(regs.get(0x3E,0)<<8)|regs.get(0x3F,0)
                if i>after and a==0x0F and b==1 and bool(regs.get(2,0)&4)==reverse and not regs.get(1,0)&1 and lo<=n<=hi: start,steps=i,n; break
        if start is not None: break
    if start is None: raise ValueError('no forward positioning move in this capture')
    first=first_upload(ops,start)
    keep=lambda o: o['kind'] in ('write','delay') or (o['kind']=='control' and o['rt']==0x40)
    return {'ops':[o for o in ops[first:start+1] if keep(o)],'steps':steps,'maxSteps':16000,'maxMs':8000,**({'reverse':True} if reverse else {}),'_start':start}

def scan_plan(ops,min_lines=500,after=0):
    """GL845: the first recorded scan pass (the quick preview). plan.ops runs from its table uploads up to its 0x0F=1
    start; the host then reads plan.bytes in plan.chunk-byte pieces, each announced by a 0x82 header, as the free trial software does.
    Geometry uses the GL843 registers: DPISET 0x2C, STRPIXEL 0x30, ENDPIXEL 0x32, LINCNT 0x25, LPERIOD 0x38."""
    regs={}; start=None
    for i,o in enumerate(ops):
        if o['kind']=='control' and o['rt']==0x40 and o['value']==0x83 and len(o['data'])>1:
            for a,b in zip(o['data'][::2],o['data'][1::2]):
                regs[a]=b
                if i>after and a==0x0F and b==1 and regs.get(1,0)&1 and ((regs.get(0x25,0)<<16)|(regs.get(0x26,0)<<8)|regs.get(0x27,0))>=min_lines: start=i; break
        if start is not None: break
    if start is None: raise ValueError('no scan pass in this capture')
    u16=lambda a:(regs[a]<<8)|regs[a+1]
    pixels=(u16(0x32)-u16(0x30))*u16(0x2C)//1200; lines=(regs[0x25]<<16)|(regs[0x26]<<8)|regs[0x27]
    line_ms=((regs.get(0x1E,0)&15)+1)*u16(0x38)*0.4e-3
    first=first_upload(ops,start)
    keep=lambda o: o['kind'] in ('write','delay') or (o['kind']=='control' and o['rt']==0x40)
    # After the data the vendor clears the SCAN bit (0x01=0x02) and writes 0x6C=0xFF BEFORE its next table upload;
    # without them the chip stays in scan mode and the next bulk write hangs (found on hardware).
    nxt=next(j for j in range(start+1,len(ops)) if ops[j]['kind']=='control' and ops[j]['value']==0x82 and ops[j]['index']==1)
    after=[o for o in ops[start+1:nxt] if o['kind']=='control' and o['rt']==0x40 and o['value']==0x83]
    return {'ops':[o for o in ops[first:start+1] if keep(o)],'after':after,'pixels':pixels,'lines':lines,'bytes':pixels*lines*6,'chunk':65024,
            'dpi':u16(0x2C)*6,'lineMs':round(line_ms,3),'startMs':6000,'maxMs':max(10000,round(lines*line_ms*3))}

def retarget_scan(plan,str_,end,lines,feedl=None):
    """GL845: a copy of a recorded scan plan with another window: first pixel, last pixel (7200 dpi grid units), line count.
    Only the registers that carry those are rewritten (STRPIXEL 0x30/31, ENDPIXEL 0x32/33, LINCNT 0x25-27, and 0x36/37, which
    equals pixels x 4.5 on every recorded pass: 900 ppi 1300 -> 5850, 3600 ppi 5200 -> 23400, three 7200 ppi widths); motor tables,
    line period and pre-roll stay as recorded. The result is re-read from its own register writes and asserted."""
    import copy
    new=copy.deepcopy(plan); dpiset=plan['dpi']//6; pixels=(end-str_)*dpiset//1200
    assert pixels*4.5==int(pixels*4.5), 'pixel count must give a whole 0x36/37 value'
    want={0x25:(lines>>16)&255,0x26:(lines>>8)&255,0x27:lines&255,0x30:(str_>>8)&255,0x31:str_&255,0x32:(end>>8)&255,0x33:end&255,
          0x36:(int(pixels*4.5)>>8)&255,0x37:int(pixels*4.5)&255}
    if feedl is not None: want.update({0x3D:(feedl>>16)&15,0x3E:(feedl>>8)&255,0x3F:feedl&255})   # pre-roll: set to the value of the full-frame plan it must line up with
    seen=set()
    for o in new['ops']:
        if o['kind']=='control' and o['rt']==0x40 and o['value']==0x83 and len(o['data'])>1:
            for k in range(0,len(o['data']),2):
                if o['data'][k] in want: o['data'][k+1]=want[o['data'][k]]; seen.add(o['data'][k])
    assert seen==set(want), 'plan does not write every window register: missing %s'%sorted(set(want)-seen)
    regs={}
    for o in new['ops']:
        if o['kind']=='control' and o['rt']==0x40 and o['value']==0x83 and len(o['data'])>1:
            for a,b in zip(o['data'][::2],o['data'][1::2]): regs[a]=b
    u16=lambda a:(regs[a]<<8)|regs[a+1]
    assert (u16(0x30),u16(0x32),(regs[0x25]<<16)|(regs[0x26]<<8)|regs[0x27],u16(0x36))==(str_,end,lines,int(pixels*4.5)), 'rewrite did not read back'
    if feedl is not None: assert ((regs[0x3D]<<16)|(regs[0x3E]<<8)|regs[0x3F])==feedl, 'pre-roll did not read back'
    new.update(pixels=pixels,lines=lines,bytes=pixels*lines*6,maxMs=max(10000,round(lines*plan['lineMs']*3)),
               derived={'from':'%dx%d px recorded pass'%(plan['pixels'],plan['lines']),'str':str_,'end':end,'note':'window registers rewritten'+('' if feedl is None else ', pre-roll set to %d'%feedl)+', nothing else'})
    return new

def home_plan(ops):
    """GL845: the recorded reverse home move and its stop, from the first long reverse move in the capture.

    plan.ops: everything from the move's table uploads up to and including its 0x0F=1 start (OUT controls, bulk
    writes and delays only; status reads are left to the runtime). plan.stop: the vendor's three-write stop that
    follows (01=22, 02=38, FEEDL=1, one register per transfer). The move must be in reverse (MTRREV), because only reverse travel is protected by the home sensor."""
    regs={}; start=None
    for i,o in enumerate(ops):
        if o['kind']=='control' and o['rt']==0x40 and o['value']==0x83 and len(o['data'])>1:
            for a,b in zip(o['data'][::2],o['data'][1::2]):
                regs[a]=b
                if a==0x0F and b==1 and regs.get(2,0)&4 and ((regs.get(0x3D,0)<<16)|(regs.get(0x3E,0)<<8)|regs.get(0x3F,0))>100000:
                    start=i; break
        if start is not None: break
    if start is None: raise ValueError('no long reverse home move in this capture')
    first=first_upload(ops,start)
    keep=lambda o: o['kind'] in ('write','delay') or (o['kind']=='control' and o['rt']==0x40)
    # The free trial software never interrupts a move: every move ends by itself (home sensor or step count), and afterwards it
    # rewrites its whole base register block (0x01..0x3F: SCAN off 0x01=0x22, motor idle 0x02=0x38, FEEDL=1).
    # The stop below takes just those registers from that block. That it halts a running motor is NOT shown by
    # the capture. Tried on hardware 2026-11-09 (tools/hwtest_8100.cjs stoptest/stopscan): it halts a running MOVE (446 ms) but does NOT abort a
    # running SCAN, hence stopVerified:'moves'. Scans are never stopped; a cancel reads and discards the rest of the pass (gl845.js runScan).
    base=None; acc={}
    for o in ops[start+1:]:
        if o['kind']=='control' and o['rt']==0x40 and o['value']==0x83 and len(o['data'])>=2:
            pairs=list(zip(o['data'][::2],o['data'][1::2]))
            if not acc and pairs[0]!=(1,0x22): continue
            acc.update(pairs)       # the block is sent in chunks of up to 32 pairs
            if 0x3F in acc:
                if acc.get(2)==0x38 and acc.get(0x3F)==1: base=acc
                break
    if base is None or any(base.get(r)!=0 for r in (0x3D,0x3E)): raise ValueError('no recorded base register block after the home move')
    stop=[{'kind':'control','rt':0x40,'request':4,'value':0x83,'index':0,'data':[1,0x22,2,0x38,0x3D,0,0x3E,0,0x3F,1]}]
    return {'boot':[o for o in ops[:first] if keep(o)],'ops':[o for o in ops[first:start+1] if keep(o)],'stop':stop,'stopVerified':'moves','maxMs':20000}

def build(path, name, dpi, yres, shifts, sequence=None, plans=True):
    events, raw = decode(path)
    if sequence is not None:
        seqs=sequences(raw)
        raw=seqs[sequence]
    # GL845 dialect (OpticFilm 8100): registers are read with 0xC0/0x04/0x8E and the register in the index,
    # and the bulk header's direction is its index (0 = read, 1 = write) instead of its first byte.
    gl845 = any(e['kind']=='ctl' and e['bmr']==0xC0 and e['req']==4 and e['wv']==0x8E and e['wi']&0xFF==0x22 for e in raw)
    is_in = lambda e: e['wv']==0x82 and ((e['wi']==0) if gl845 else e['out'][0]==0)
    headers = [e for e in raw if e['kind']=='ctl' and is_in(e)]
    main = max(headers, key=lambda e:int.from_bytes(e['out'][4:8], 'little'))
    pass_no = 0  # GL845: the host announces every 64 KB chunk itself; a scan start (0x0F=1) begins a new frame
    regs={}; ops=[]; addr=None; previous=None; image_no=-1; frames=[]; moves=[]; move_start=None
    for e in raw:
        if e['kind']=='ctl' and e['bmr'] in (0x40,0xC0):
            if previous is not None:
                gap=(e['ts']-previous)/1000
                if move_start is not None and e['bmr']==0x40 and e['wv']==0x83 and len(e['out'])>1:
                    # The first register write after a positioning move starts, with no status read
                    # in between, is the vendor STOPPING the move (it writes 0x02 and FEEDL=1 about
                    # 2.56 s in). The carriage position depends on this moment, so keep it exact,
                    # measured from the start write, instead of capping it like an ordinary pause.
                    ops.append({'kind':'delay','ms':round((e['ts']-move_start)/1000,1),'timedStop':True})
                elif gap>=20: ops.append({'kind':'delay','ms':min(round(gap),1000)})
                # a register write (the stop) or a status read (the move is left to finish) ends it;
                # write-acks and address writes in between do not
                if (e['bmr']==0x40 and e['wv']==0x83 and len(e['out'])>1) or (e['bmr']==0xC0 and (e['wv']==0x84 or (gl845 and e['wv']==0x8E and e['wi']&0xFF==0x22))):
                    move_start=None
            out=e['out']; op={'kind':'control','rt':e['bmr'],'request':e['req'],'value':e['wv'],'index':e['wi']}
            if e['bmr']==0x40:
                op['data']=list(out)
                if e['wv']==0x83:
                    if len(out)==1:addr=out[0]
                    else:
                        for a,b in zip(out[::2],out[1::2]):
                            regs[a]=b
                            if a==15 and b==1: pass_no+=1
                            if a==15 and b==1 and not regs.get(1,0)&1:
                                moves.append((regs.get(61,0)<<16)|(regs.get(62,0)<<8)|regs.get(63,0))
                                if moves[-1]>1: move_start=e['ts']
                if is_in(e):
                    r=dict(regs); u16=lambda a:r.get(a,0)*256+r.get(a+1,0)
                    n=int.from_bytes(out[4:8],'little'); pixels=(u16(0x32)-u16(0x30))*u16(0x2c)//1200
                    if gl845 and frames and frames[-1]['pass']==pass_no:
                        frames[-1]['bytes']+=n  # another chunk of the same scan pass
                    else:
                        image_no+=1
                        frames.append({'bytes':n,'pixels':pixels,'lines':n//(pixels*6) if pixels else 0,'regs':r,'main':e is main and not gl845,'pass':pass_no})
            else:
                op['length']=len(e['inp']); op['expected']=list(e['inp'])
                if e['wv']==0x84:op['register']=addr
                if gl845 and e['wv']==0x8E and e['wi']&0xFF==0x22:op['register']=e['wi']>>8
            ops.append(op); previous=e['ts']
        elif e['kind']=='bout':
            ops.append({'kind':'write','data':base64.b64encode(e['data']).decode()});previous=e['ts']
        elif e['kind']=='bin':
            # Aggregate adjacent completions; preserve each 0x82 transaction boundary.
            if ops and ops[-1]['kind']=='read':ops[-1]['length']+=len(e['data'])
            else:ops.append({'kind':'read','length':len(e['data']),'frame':image_no})
            previous=e['ts']
    if gl845:  # frames were summed per scan pass; the largest is the main scan, and lines follow from the total
        for fr in frames: fr['lines']=fr['bytes']//(fr['pixels']*6) if fr['pixels'] else 0
        max(frames,key=lambda fr:fr['bytes'])['main']=True
    main_frame=next(i for i,f in enumerate(frames) if f['main']); f=frames[main_frame]
    # The 7200 dpi capture clips packets at 65,535 bytes (46 % of image bytes missing). The control stream is what the profile replays, so a short main frame is tolerated:
    # the missing bytes extend the read inside the original USB transaction, before completion
    # polling or scan shutdown. Never append a read after the captured teardown.
    # Calibration frames must be complete, because their statistics are the illumination and black-level reference.
    read_main=sum(o['length'] for o in ops if o['kind']=='read' and o['frame']==main_frame)
    truncated=f['bytes']-read_main
    if truncated>0:
        reads=[o for o in ops if o['kind']=='read' and o['frame']==main_frame]
        if len(reads)!=1:
            raise ValueError('Cannot safely repair a truncated main frame with multiple/no read spans')
        reads[0]['length']+=truncated
    elif truncated<0:
        raise ValueError('Captured main frame exceeds its USB header length')
    # Lamp reference: statistics (no pixels) of the white calibration reads the vendor makes before
    # every scan. The app replays the vendor's AFE gains and shading tables instead of recalculating
    # them, so they are only right when the lamp is in the state these numbers describe.
    import numpy as np
    data={}
    lamp=None
    for i,h in enumerate([] if gl845 else headers):
        nxt=headers[i+1]['ts'] if i+1<len(headers) else float('inf')
        data[i]=b''.join(x['data'] for x in raw if x['kind']=='bin' and h['ts']<x['ts']<nxt)[:frames[i]['bytes']]
    def stats(i):
        fr=frames[i]; a=np.frombuffer(data[i],dtype='<u2').astype(np.float64).reshape(fr['lines'],fr['pixels'],3)
        c=a[:,fr['pixels']//10:fr['pixels']-fr['pixels']//10]; lm=c.mean(1)
        return {'frame':i,'mean':[round(v,1) for v in c.mean((0,1))],
                'lineCvPct':[round(float(v),3) for v in np.nan_to_num(lm.std(0)/np.where(lm.mean(0)>0,lm.mean(0),np.inf)*100)] if fr['lines']>1 else [0,0,0]}
    if not gl845:
        line=next(i for i,fr in enumerate(frames) if fr['lines']==1 and fr['pixels']>5000)
        shading=[i for i,fr in enumerate(frames) if fr['lines']==128]
        white=max(shading,key=lambda i:np.frombuffer(data[i],dtype='<u2').mean())
        dark=[i for i in shading if i!=white][0]
        lamp={'line':stats(line),'shading':stats(white),'dark':stats(dark)}
    # Scan pace: a delivered line takes (LINESEL+1) line periods (measured: 5.6, 11.2, 16.8 ms for
    # 1440/3600/7200 dpi, matching the captures' 15.8 s, 79 s and 237 s main reads). The host must
    # take the data at that rate or the scanner may enter buffer-full backtracking.
    linesel=frames[main_frame]['regs'][30]&15
    lperiod=(frames[main_frame]['regs'][56]<<8)|frames[main_frame]['regs'][57]
    line_seconds=(linesel+1)*lperiod*0.4e-6
    scan={'lineSel':linesel,'lPeriod':lperiod,'lineSeconds':round(line_seconds,6),
          'seconds':round(line_seconds*f['lines'],1),
          'bytesPerSecond':round(f['pixels']*6/line_seconds)}
    assert sum(o['length'] for o in ops if o['kind']=='read' and o['frame']==main_frame)==f['bytes']
    for i,fr in enumerate(frames):
        got=sum(o['length'] for o in ops if o['kind']=='read' and o['frame']==i)
        assert i==main_frame or got==fr['bytes'], f'calibration frame {i} incomplete in the capture ({got} of {fr["bytes"]} B)'
    home=None
    if gl845 and plans:
        home=home_plan(ops); home['forward']=forward_plan(ops); home['preview']=scan_plan(ops)
        # The vendor's full scan follows the preview: step back 15202 steps (bounded, sensor-protected), then scan.
        # Reproduced exactly, because the start position is only known relative to the preview pass.
        home['back']=forward_plan(ops,reverse=True,lo=5000,hi=50000,after=home['forward']['_start'])
        home['main']=scan_plan(ops,min_lines=2000,after=home['back']['_start'])
        for k in ('forward','back'): home[k].pop('_start')
    for fr in frames: fr.pop('pass',None)  # builder bookkeeping, not part of the profile
    return {'name':name,'source':pathlib.Path(path).name+('' if sequence is None else f' (sequence {sequence})'),'sha256':hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest(),
            'dpi':dpi,'yres':yres,'shifts':shifts,'mainFrame':main_frame,'frames':frames,'moves':moves,'lamp':lamp,'scan':scan,'captureTruncatedBytes':max(0,truncated),'ops':ops,**({'home':home} if home else {})}

if __name__=='__main__' and sys.argv[1]=='--add':
    key,name,dpi,yres,gb,cap=sys.argv[2:8]
    path,_,seq=cap.partition('@')
    prof=build(path,name,int(dpi),int(yres),[0]+[int(v) for v in gb.split(',')],int(seq) if seq else None)
    dest=pathlib.Path(__file__).resolve().parents[1]/'capture_profiles.js'
    text=dest.read_text(); head,_,body=text.partition('globalThis.CAPTURE_PROFILES=')
    profiles=json.loads(body.rstrip().rstrip(';')); profiles[key]=prof
    dest.write_text(head+'globalThis.CAPTURE_PROFILES='+json.dumps(profiles,separators=(',',':'))+';\n')
    print(dest, dest.stat().st_size, key, len(prof['ops']),'ops, frames',len(prof['frames']),'main',prof['mainFrame'],'scan',prof['scan'])
elif __name__=='__main__' and sys.argv[1]=='--home-plan':
    # python3 tools/build_capture_profiles.py --home-plan KEY capture.log home_plans.js: the GL845 boot + home plan only
    key,cap,out=sys.argv[2:5]
    prof=build(cap,key,3600,3600,[0,24,48])
    if len(sys.argv)>5:
        # optional 5th argument: a capture with a cropped 7200 ppi scan; its plan is widened to the same window as the 3600 ppi pass
        # (STRPIXEL 38, ENDPIXEL 10438 = 5200 px at 3600 ppi, 10400 px here) and to twice its lines
        p7=build(sys.argv[5],key,7200,7200,[0,24,48],plans=False)
        crop=scan_plan(p7['ops'],min_lines=1500)
        ref=prof['home']['main']; g={}
        for o in ref['ops']:
            if o['kind']=='control' and o['value']==0x83:
                for a,b_ in zip(o['data'][::2],o['data'][1::2]): g[a]=b_
        prof['home']['main7200']=retarget_scan(crop,(g[0x30]<<8)|g[0x31],(g[0x32]<<8)|g[0x33],ref['lines']*2)
    if len(sys.argv)>7:
        # optional 7th argument: a capture of a multi-exposure scan (the free trial software, 3600 ppi crop). Its SHORT pass (line period 31920, the exposure it
        # picks for a slide, 4/3 shorter than the 42560 of the long pass and of the full-frame plan) is widened to the full-frame window with the
        # full-frame plan's pre-roll. Checked against the data: the 42560 crop widened the same way equals the recorded full-frame plan in every
        # register but the pre-roll, with identical motor tables.
        p7=build(sys.argv[7],key,3600,3600,[0,24,48],plans=False); ops7=p7['ops']; starts=[]; r_={}
        for i,o in enumerate(ops7):
            if o['kind']=='control' and o['rt']==0x40 and o['value']==0x83 and len(o['data'])>1:
                for a,b_ in zip(o['data'][::2],o['data'][1::2]):
                    r_[a]=b_
                    if a==0x0F and b_==1 and r_.get(1,0)&1: starts.append(i)
        cand=[]; after=0
        for k in range(len(starts)):
            cand.append(scan_plan(ops7,min_lines=500,after=(after-1 if k else 0))); after=starts[k]+1
        short=next(c for c in cand if c['dpi']==3600 and abs(c['lineMs']-12.768)<0.01)
        ref=prof['home']['main']; g={}
        for o in ref['ops']:
            if o['kind']=='control' and o['value']==0x83:
                for a,b_ in zip(o['data'][::2],o['data'][1::2]): g[a]=b_
        prof['home']['main31920']=retarget_scan(short,(g[0x30]<<8)|g[0x31],(g[0x32]<<8)|g[0x33],ref['lines'],feedl=(g[0x3D]<<16)|(g[0x3E]<<8)|g[0x3F])
    if len(sys.argv)>6:
        # optional 6th argument: a capture with a 1800 ppi scan (the free trial software's pass for 300-400 dpi requests). It is a complete frame
        # (2592 x 1889 px, DPISET 300), so it is used exactly as recorded, with no register rewritten.
        p18=build(sys.argv[6],key,1800,1800,[0,24,48],plans=False)
        prof['home']['main1800']=scan_plan(p18['ops'],min_lines=1500)
    pathlib.Path(out).write_text('// Generated by tools/build_capture_profiles.py --home-plan from a usbspy capture; register writes and motor tables only, no image data.\n'
        +'globalThis.HOME_PLANS='+json.dumps({key:prof['home']},separators=(',',':'))+';\n')
    print(out,pathlib.Path(out).stat().st_size,'bytes: boot',len(prof['home']['boot']),'ops, home',len(prof['home']['ops']),'ops')
elif __name__=='__main__':
    profiles={'prescan':build(sys.argv[1],'Captured prescan',1440,2880,[0,10,19]),
              'full':build(sys.argv[2],'Captured full frame 3600',3600,7200,[0,24,48])}
    if len(sys.argv)>3: profiles['full7200']=build(sys.argv[3],'Captured full frame 7200',7200,14400,[0,48,96])
    dest=pathlib.Path(__file__).resolve().parents[1]/'capture_profiles.js'
    dest.write_text('// Generated from the supplied captures; includes calibration tables, no image pixels.\n'
                    +'globalThis.CAPTURE_PROFILES='+json.dumps(profiles,separators=(',',':'))+';\n')
    print(dest, dest.stat().st_size)
