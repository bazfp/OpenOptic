#!/usr/bin/env python3
"""Extract vendor transactions and uploaded tables; never embed captured photographs.
Usage: python3 tools/build_capture_profiles.py prescan.pcapng 3600ppifullframehdr.pcapng [7200ppifullframehdr.pcapng]
"""
import base64, hashlib, json, pathlib, sys
from capture_analyse import decode

def build(path, name, dpi, yres, shifts):
    events, raw = decode(path)
    headers = [e for e in raw if e['kind']=='ctl' and e['wv']==0x82 and e['out'][0]==0]
    main = max(headers, key=lambda e:int.from_bytes(e['out'][4:8], 'little'))
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
                if (e['bmr']==0x40 and e['wv']==0x83 and len(e['out'])>1) or (e['bmr']==0xC0 and e['wv']==0x84):
                    move_start=None
            out=e['out']; op={'kind':'control','rt':e['bmr'],'request':e['req'],'value':e['wv'],'index':e['wi']}
            if e['bmr']==0x40:
                op['data']=list(out)
                if e['wv']==0x83:
                    if len(out)==1:addr=out[0]
                    else:
                        for a,b in zip(out[::2],out[1::2]):
                            regs[a]=b
                            if a==15 and b==1 and not regs.get(1,0)&1:
                                moves.append((regs.get(61,0)<<16)|(regs.get(62,0)<<8)|regs.get(63,0))
                                if moves[-1]>1: move_start=e['ts']
                if e['wv']==0x82 and out[0]==0:
                    image_no+=1
                    r=dict(regs); u16=lambda a:r.get(a,0)*256+r.get(a+1,0)
                    n=int.from_bytes(out[4:8],'little'); pixels=(u16(0x32)-u16(0x30))*u16(0x2c)//1200
                    frames.append({'bytes':n,'pixels':pixels,'lines':n//(pixels*6),'regs':r,'main':e is main})
            else:
                op['length']=len(e['inp']); op['expected']=list(e['inp'])
                if e['wv']==0x84:op['register']=addr
            ops.append(op); previous=e['ts']
        elif e['kind']=='bout':
            ops.append({'kind':'write','data':base64.b64encode(e['data']).decode()});previous=e['ts']
        elif e['kind']=='bin':
            # Aggregate adjacent completions; preserve each 0x82 transaction boundary.
            if ops and ops[-1]['kind']=='read':ops[-1]['length']+=len(e['data'])
            else:ops.append({'kind':'read','length':len(e['data']),'frame':image_no})
            previous=e['ts']
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
    for i,h in enumerate(headers):
        nxt=headers[i+1]['ts'] if i+1<len(headers) else float('inf')
        data[i]=b''.join(x['data'] for x in raw if x['kind']=='bin' and h['ts']<x['ts']<nxt)[:frames[i]['bytes']]
    def stats(i):
        fr=frames[i]; a=np.frombuffer(data[i],dtype='<u2').astype(np.float64).reshape(fr['lines'],fr['pixels'],3)
        c=a[:,fr['pixels']//10:fr['pixels']-fr['pixels']//10]; lm=c.mean(1)
        return {'frame':i,'mean':[round(v,1) for v in c.mean((0,1))],
                'lineCvPct':[round(v,3) for v in (lm.std(0)/lm.mean(0)*100)] if fr['lines']>1 else [0,0,0]}
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
    return {'name':name,'source':pathlib.Path(path).name,'sha256':hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest(),
            'dpi':dpi,'yres':yres,'shifts':shifts,'mainFrame':main_frame,'frames':frames,'moves':moves,'lamp':lamp,'scan':scan,'captureTruncatedBytes':max(0,truncated),'ops':ops}

if __name__=='__main__':
    profiles={'prescan':build(sys.argv[1],'Captured prescan',1440,2880,[0,10,19]),
              'full':build(sys.argv[2],'Captured full frame 3600',3600,7200,[0,24,48])}
    if len(sys.argv)>3: profiles['full7200']=build(sys.argv[3],'Captured full frame 7200',7200,14400,[0,48,96])
    dest=pathlib.Path(__file__).resolve().parents[1]/'capture_profiles.js'
    dest.write_text('// Generated from the supplied captures; includes calibration tables, no image pixels.\n'
                    +'globalThis.CAPTURE_PROFILES='+json.dumps(profiles,separators=(',',':'))+';\n')
    print(dest, dest.stat().st_size)
