#!/usr/bin/env python3
"""Reconstruct supplied capture: python3 tools/reconstruct_capture.py input.pcapng output.png
Requires numpy and Pillow. Same alignment, levels and orientation as the app: R->G and R->B
line delays are measured per image to sub-line precision (vertical-gradient cross-correlation,
parabolic peak) and applied with linear interpolation; the recorded integer delays are the
fallback when the image has too little vertical detail. Pillow uses Lanczos while browsers
use their high-quality canvas resampler.
"""
import argparse, math
import numpy as np
from PIL import Image
from capture_analyse import decode

PROFILES = {34735200: (2050, 2824, [0, 10, 19]), 175896576: (4608, 6362, [0, 24, 48]), 216991152: (5124, 7058, [0, 24, 48]),
            868333536: (10248, 14122, [0, 48, 96])}


def measure_shifts(a, nominal, columns=384, min_conf=0.3):
    """Mirror of CaptureRuntime.measureShifts (capture_runtime.js)."""
    L, P, _ = a.shape
    max_nom = max(nominal); reach = max(4, math.ceil(max_nom * 0.35))
    y0 = L // 10; y1 = L - L // 10 - math.ceil(max_nom + reach) - 2
    x0 = P // 10; x1 = P - P // 10; step = max(1, (x1 - x0) // columns)
    xs = np.arange(x0, x1, step); rows_needed = y1 + math.ceil(max_nom + reach) + 2 - y0
    grad = lambda c: (a[y0 + 1:y0 + rows_needed + 1, xs, c].astype(np.float64) - a[y0:y0 + rows_needed, xs, c])
    R = grad(0)[:y1 - y0]
    shifts, conf, used = [0], [1.0], ['reference']
    for c in (1, 2):
        M = grad(c); nom = nominal[c]; lo = max(0, math.floor(nom - reach)); hi = math.ceil(nom + reach); cs = []
        for k in range(lo, hi + 1):
            A = R.ravel(); B = M[k:k + R.shape[0]].ravel()
            A = A - A.mean(); B = B - B.mean(); cs.append(float((A * B).sum() / math.sqrt((A * A).sum() * (B * B).sum())))
        bi = int(np.argmax(cs)); est = lo + bi
        if 0 < bi < len(cs) - 1:
            p, q, r = cs[bi - 1], cs[bi], cs[bi + 1]; den = p - 2 * q + r
            if den < 0: est += 0.5 * (p - r) / den
        ok = cs[bi] >= min_conf and 0 < bi < len(cs) - 1
        shifts.append(round(est, 2) if ok else nom); conf.append(round(cs[bi], 3)); used.append('measured' if ok else 'nominal')
    return shifts, conf, used


def align(a, shifts):
    L = a.shape[0]; height = L - math.ceil(max(shifts) - 1e-6); planes = []
    for c, s in enumerate(shifts):
        i = math.floor(s + 1e-6); f = s - i
        p = a[i:i + height, :, c].astype(np.float64)
        if f >= 1e-3:
            p = (1 - f) * p + f * a[i + 1:i + 1 + height, :, c]
        planes.append(np.rint(p))
    return np.stack(planes, axis=-1), height


def reconstruct(path):
    S, raw = decode(path)
    h = max((e for e in raw if e['kind'] == 'ctl' and e['wv'] == 0x82 and e['out'][0] == 0), key=lambda e: int.from_bytes(e['out'][4:8], 'little'))
    size = int.from_bytes(h['out'][4:8], 'little')
    data = b''.join(e['data'] for e in raw if e['kind'] == 'bin' and e['ts'] > h['ts'])[:size]
    if size not in PROFILES: raise ValueError('Unrecognised capture geometry; this tool supports the two supplied captures only')
    if len(data) != size:
        raise SystemExit(f'This capture holds only {len(data):,} of {size:,} image bytes '
                         '(the capture tool dropped packets at this data rate), so the picture cannot be '
                         'reconstructed from it. The profile built from it still replays correctly.')
    width, lines, nominal = PROFILES[size]; a = np.frombuffer(data, dtype='<u2').reshape(lines, width, 3)
    shifts, conf, used = measure_shifts(a, nominal)
    aligned, height = align(a, shifts)
    lo, hi = np.percentile(aligned[150:-150, 150:-150], [.5, 99.5], axis=(0, 1)); hi = np.maximum(hi, lo + 1)
    pos = 1 - np.clip((aligned - lo) / (hi - lo), 0, 1)
    im = Image.fromarray(np.rint(pos * 255).astype('uint8')).resize((width, height // 2), Image.Resampling.LANCZOS).transpose(Image.Transpose.ROTATE_90)
    return im, {'width': width, 'lines': lines, 'alignedLines': height, 'shifts': shifts, 'shiftConfidence': conf, 'shiftSource': used,
                'recordedShifts': nominal, 'levels': [lo.tolist(), hi.tolist()]}


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__); ap.add_argument('capture'); ap.add_argument('output'); args = ap.parse_args()
    im, meta = reconstruct(args.capture); im.save(args.output); print(meta)
