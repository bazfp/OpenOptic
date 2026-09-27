#!/usr/bin/env python3
"""Measure how an app TIFF is framed relative to the official software's scan of the same frame.

    python3 tools/compare_frame.py 3600ppifullframehdr.pcapng Roll001_01.tif

Reports the offset of the app image against the official capture along the carriage travel
(fixed by the scanner; should be ~0 mm) and across the sensor (depends on where the holder was
placed by hand). Works for full-frame TIFFs saved with square (averaged) or as-sampled pixels
and any orientation tag. Needs numpy, Pillow and tifffile.
"""
import sys, numpy as np, tifffile
from PIL import Image
from capture_analyse import decode
from reconstruct_capture import align, measure_shifts

def official_frame(pcap):
    S, raw = decode(pcap)
    h = max((e for e in raw if e['kind'] == 'ctl' and e['wv'] == 0x82 and e['out'][0] == 0), key=lambda e: int.from_bytes(e['out'][4:8], 'little'))
    size = int.from_bytes(h['out'][4:8], 'little')
    data = b''.join(e['data'] for e in raw if e['kind'] == 'bin' and e['ts'] > h['ts'])[:size]
    if size != 216991152:
        sys.exit('expected the official full-frame capture (216,991,152-byte main frame)')
    a = np.frombuffer(data, dtype='<u2').reshape(7058, 5124, 3)
    al, _ = align(a, measure_shifts(a, [0, 24, 48])[0])
    return al[:, :, 1].astype(np.float32), 3600, 7200

def app_frame(path):
    with tifffile.TiffFile(path) as t:
        p = t.pages[0]; a = p.asarray()[:, :, 1].astype(np.float32)
        xr = p.tags['XResolution'].value; yr = p.tags['YResolution'].value
    return a, xr[0] / xr[1], yr[0] / yr[1]      # stored as scanned; orientation tag is display-only

def main(pcap, tif, dpi=360):
    to = lambda img, xd, yd: np.log(np.maximum(np.asarray(Image.fromarray(img).resize((round(img.shape[1] * dpi / xd), round(img.shape[0] * dpi / yd)), Image.BILINEAR)), 50))
    A = to(*official_frame(pcap)); B = to(*app_frame(tif)); m = 80; ca = A[m:-m, m:-m]; best = (-2, 0, 0)
    for dy in range(-79, 80):
        for dx in range(-79, 80, 2):
            b = B[m + dy:B.shape[0] - m + dy, m + dx:B.shape[1] - m + dx]
            h = min(ca.shape[0], b.shape[0]); w = min(ca.shape[1], b.shape[1])
            if h < 50 or w < 50: continue
            a_ = ca[:h, :w] - ca[:h, :w].mean(); b_ = b[:h, :w] - b[:h, :w].mean()
            r = (a_ * b_).sum() / np.sqrt((a_ * a_).sum() * (b_ * b_).sum())
            if r > best[0]: best = (r, dy, dx)
    r, dy, dx = best; mm = 25.4 / dpi
    print(f'match r={r:.3f}')
    print(f'along carriage travel: {dy * mm:+.2f} mm  ({"OK" if abs(dy * mm) < 0.3 else "OFF: the scan started " + ("early" if dy > 0 else "late")})')
    print(f'across sensor (holder placed by hand): {dx * mm:+.2f} mm')
    if r < 0.8: print('low match: is this the same frame as the official capture?')

if __name__ == '__main__':
    if len(sys.argv) != 3: sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
