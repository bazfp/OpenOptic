#!/usr/bin/env python3
"""Recover the old roll pipeline's negative-offset Uint16 overflow in a saved TIFF.
Usage: python3 tools/repair_blacklevel_wrap.py input.tif input.json output.tif
Requires numpy. Input must be an uncompressed little-endian RGB16 roll TIFF.
Only wrapped samples are saturated; other samples and all TIFF metadata are retained.
"""
import hashlib,json,math,pathlib,shutil,struct,sys
import numpy as np

def digest(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for b in iter(lambda:f.read(8*1024*1024),b''):h.update(b)
    return h.hexdigest()

def repair(source,sidecar,dest):
    source,sidecar,dest=map(pathlib.Path,(source,sidecar,dest));outjson=dest.with_suffix('.json')
    if dest.exists() or outjson.exists():raise ValueError('Output already exists; choose a new output name')
    meta=json.loads(sidecar.read_text());offsets=meta['processing']['blackLevelCorrection']['counts']
    if len(offsets)!=3 or not all(math.isfinite(v) and abs(v)<65535 for v in offsets):raise ValueError('Unsupported correction')
    sha=digest(source)
    recorded=next(f for f in meta['files'] if f['kind']=='tiff')
    if recorded.get('sha256')!=sha:raise ValueError('TIFF does not match the sidecar checksum')
    with source.open('rb') as f:
        h=f.read(8)
        if h[:4]!=b'II\x2a\x00':raise ValueError('Expected classic little-endian TIFF')
        f.seek(struct.unpack_from('<I',h,4)[0]);n=struct.unpack('<H',f.read(2))[0];tags={}
        for _ in range(n):
            t,k,count,v=struct.unpack('<HHII',f.read(12));tags[t]=(k,count,v)
        if any(tags[t][1]!=1 for t in [256,257,259,262,273,277,279,284]):raise ValueError('Expected single-strip RGB TIFF')
        if [tags[t][2] for t in [259,262,277,284]]!=[1,2,3,1]:raise ValueError('Expected uncompressed interleaved RGB')
        if tags[258][:2]!=(3,3):raise ValueError('Expected three 16-bit channels')
        f.seek(tags[258][2])
        if struct.unpack('<HHH',f.read(6))!=(16,16,16):raise ValueError('Expected RGB16')
    w,h=tags[256][2],tags[257][2];start=tags[273][2]
    if tags[279][2]!=w*h*6 or start+w*h*6!=source.stat().st_size:raise ValueError('Unexpected TIFF layout')
    shutil.copyfile(source,dest)
    a=np.memmap(dest,dtype='<u2',mode='r+',offset=start,shape=(h,w,3))
    counts=[0,0,0];thresholds=[math.floor(-v+.5) if v<0 else 0 for v in offsets]
    # Without wrap, nonnegative source data plus an additive correction cannot
    # produce values below round(-offset). Wrapped values are therefore identifiable.
    for y in range(0,h,64):
        block=a[y:y+64]
        for c,threshold in enumerate(thresholds):
            if threshold:
                channel=block[:,:,c];mask=channel<threshold
                counts[c]+=int(mask.sum());channel[mask]=65535
    a.flush();del a
    resultsha=digest(dest)
    meta['frame']=dest.stem
    meta['files']=[{**recorded,'name':dest.name,'bytes':dest.stat().st_size,'sha256':resultsha}]
    meta['processing']['blackLevelOverflowRepair']={
        'sourceFile':source.name,'sourceSha256':sha,'wrappedSamplesPerChannel':counts,
        'thresholdsExclusive':thresholds,'replacement':65535,
        'method':'Recover the old missing-upper-clamp bug: corrected nonnegative data cannot lie below the rounded additive offset. Saturate these wrapped samples; leave all other samples and TIFF tags unchanged.'}
    outjson.write_text(json.dumps(meta,indent=2)+'\n')
    print(json.dumps({'tiff':str(dest),'sidecar':str(outjson),'sha256':resultsha,'repairedSamples':counts}))

if __name__=='__main__':repair(*sys.argv[1:])
