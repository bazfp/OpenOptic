"""Stream a USBPcap capture of the 7600i: register/AFE state at every read header, bulk OUT tables,
interrupt events, and frame data (frames > 1 MB saved to disk). Writes <out>/summary.json."""
import sys,struct,json,os,base64
sys.path.insert(0,sys.argv[1]+'/tools')
from capture_analyse import packets
cap,out=sys.argv[2],sys.argv[3]; os.makedirs(out,exist_ok=True)
regs={}; afe={}; afe_idx=None; pend={}; t0=None
frames=[]; outs=[]; ints=[]; cur=None; fh=None; reg_writes=[]
def t(ts): return round((ts-t0)/1e6,4)
for ts,p in packets(cap):
    if t0 is None: t0=ts
    hl,irp,status,func,info,bus,dev,ep,xfer,dlen=struct.unpack_from('<HQIHBHHBBI',p,0)
    data=bytes(p[hl:hl+dlen])
    if xfer==1 and info&1: ints.append((t(ts),data.hex())); continue
    if xfer==3:
        if ep&0x80 and info&1 and cur is not None:
            cur['got']+=len(data)
            if fh: fh.write(data)
        elif not(ep&0x80) and not(info&1):
            outs.append({'t':t(ts),'via':outs_via,'slot5B':regs.get(0x5b,0),'slot5C':regs.get(0x5c,0),'len':len(data),'data':base64.b64encode(data).decode()})
        continue
    if xfer!=2: continue
    if not(info&1) and hl>=28 and p[27]==0:
        bmr,breq,wv,wi,wl=struct.unpack_from('<BBHHH',data,0); pend[irp]=(bmr,wv,wi,data[8:8+wl] if bmr==0x40 else b'')
        continue
    if not(info&1) or irp not in pend: continue
    bmr,wv,wi,o=pend.pop(irp)
    if bmr!=0x40: continue
    if wv==0x83:
        if len(o)==1: outs_via=o[0]
        else:
            for a,b in zip(o[::2],o[1::2]):
                regs[a]=b; reg_writes.append((t(ts),a,b))
                if a==0x51: afe_idx=b
                if a==0x3b and afe_idx is not None: afe[afe_idx]=(regs.get(0x3a,0)<<8)|b
    elif wv==0x82 and o[0]==0:
        n=int.from_bytes(o[4:8],'little')
        if fh: fh.close(); fh=None
        cur={'i':len(frames),'t':t(ts),'bytes':n,'got':0,'regs':{f'{k:02x}':v for k,v in sorted(regs.items())},'afe':{f'{k:02x}':v for k,v in sorted(afe.items())}}
        frames.append(cur)
        if n>1_000_000: fh=open(f'{out}/frame{cur["i"]:02d}.bin','wb'); cur['file']=f'frame{cur["i"]:02d}.bin'
if fh: fh.close()
json.dump({'frames':frames,'outs':outs,'interrupts':ints,'regWrites':reg_writes,'duration':t(ts)},open(f'{out}/summary.json','w'))
for f in frames: print(f['i'],f['t'],f['bytes'],f['got'],f.get('file',''))
print('interrupts',ints,'duration',t(ts))
