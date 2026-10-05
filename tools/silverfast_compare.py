#!/usr/bin/env python3
"""Compare a SilverFast linear ("HDR", Gamma 1) TIFF with the passes of a capture, to see how it
merged them. Prints statistics only.
    python3 tools/silverfast_compare.py silverfast.tif normal_frame.bin long_frame.bin [k=3]
frame .bin files come from tools/capture_extract.py (3600 dpi main frames, 5124 x 7058 raw RGB16).
Needs numpy, scipy, tifffile."""
import numpy as np, tifffile, sys
from numpy.fft import fft2, ifft2
from scipy import ndimage as nd
P, L = 5124, 7058
def square(path, shifts=(0, 24.22, 48.21)):           # same square-pixel reduction as the app
    a = np.memmap(path, dtype='<u2', mode='r').reshape(L, P, 3); H = (L - 49) // 2; out = np.empty((H, P, 3), np.float32)
    for c in range(3):
        i = int(shifts[c]); f = shifts[c] - i; x = a[i:i + 2 * H + 1, :, c].astype(np.float32); x = (1 - f) * x[:-1] + f * x[1:]
        out[..., c] = (x[0:2 * H:2] + x[1:2 * H:2]) / 2
    return out
def offset(ref, mov):
    a = np.log(ref[::8, ::8] + 64); b = np.log(mov[::8, ::8] + 64); a -= a.mean(); b -= b.mean()
    R = fft2(a) * np.conj(fft2(b)); r = np.real(ifft2(R / (np.abs(R) + 1e-9))); i, j = np.unravel_index(r.argmax(), r.shape)
    return r.max(), (i if i < r.shape[0] // 2 else i - r.shape[0]) * 8, (j if j < r.shape[1] // 2 else j - r.shape[1]) * 8
sf = tifffile.imread(sys.argv[1], key=0).astype(np.float32); n1 = square(sys.argv[2]); lo = square(sys.argv[3])
best = max((offset(f(sf)[..., 1], n1[..., 1]) + (name, f) for name, f in [('as is', lambda a: a), ('mirrored', lambda a: a[:, ::-1])]), key=lambda t: t[0])
print(f'SilverFast orientation: {best[3]} relative to the raw scan'); sf = best[4](sf)
_, dy, dx = offset(n1[..., 1], lo[..., 1])
def fine(ref, mov, dy, dx):                       # 1 px search around the coarse offset
    a = np.log(ref[600:2900:2, 600:4500:2] + 64); best = None
    for y in range(dy - 8, dy + 9):
        for x in range(dx - 8, dx + 9):
            b = np.log(np.roll(np.roll(mov, y, 0), x, 1)[600:2900:2, 600:4500:2] + 64)
            c = np.corrcoef(a.ravel(), b.ravel())[0, 1]
            if best is None or c > best[0]: best = (c, y, x)
    return best[1], best[2]
dy, dx = fine(n1[..., 1], lo[..., 1], dy, dx); lo = np.roll(np.roll(lo, dy, 0), dx, 1); print(f'long pass offset: rows {dy}, columns {dx}')
hp = lambda a: a - nd.uniform_filter(a, 5); s = (slice(300, -300), slice(300, -300))
for c in range(3):
    keep = lo[s + (c,)] < 60000; k = np.median(lo[s + (c,)][keep] / np.maximum(n1[s + (c,)][keep], 1))
    print(f'channel {"RGB"[c]}: long/normal ratio {k:.2f}; SilverFast/normal level {np.median(sf[s + (c,)]) / np.median(n1[s + (c,)]):.3f}')
    A, B, F = hp(n1[s + (c,)]), hp(lo[s + (c,)] / k), hp(sf[s + (c,)]); lvl = nd.uniform_filter(n1[s + (c,)], 9) / 655.35
    for a, b in [(0, 4), (4, 8), (8, 12), (12, 20), (20, 100)]:
        m = (lvl >= a) & (lvl < b)
        if m.sum() < 3000: continue
        w, *_ = np.linalg.lstsq(np.c_[A[m], B[m]], F[m], rcond=None)
        print(f'   1x level {a:3d}-{b:3d} % of full scale ({m.mean() * 100:5.1f} % px): detail weight 1x {w[0]:+.2f}, long {w[1]:+.2f}')
