#!/usr/bin/env python3
"""Analyse a Windows USBPcap capture (.pcapng) of a Genesys GL843/GL845 scanner.

Reproduces the analysis behind opticfilm-protocol-reference.md: decodes the GL84x
register protocol, prints each bulk operation with the register state in force,
and optionally extracts the main image and measures colour line shifts.

    python3 opticfilm-capture-analyse.py capture.pcapng              # summary + bulk ops
    python3 opticfilm-capture-analyse.py capture.pcapng --timeline   # full register stream
    python3 opticfilm-capture-analyse.py capture.pcapng --image      # extract largest read, measure shifts

Needs only the standard library; --image additionally needs numpy (and Pillow for a preview PNG).

USBPcap packet header (linktype 249), little-endian, packed:
    u16 headerLen, u64 irpId, u32 status, u16 urbFunction, u8 info (bit0 = completion),
    u16 bus, u16 device, u8 endpoint (bit7 = IN), u8 transfer (0 iso, 1 int, 2 ctl, 3 bulk),
    u32 dataLength                                   -> 27 bytes
    control transfers add u8 stage (0 setup, 1 data, 2 status, 3 complete) -> 28 bytes
A control transfer appears as a stage-0 submission carrying the 8-byte setup packet
followed by any OUT data, and a completion (info bit0 set) carrying any IN data.
Pair them by irpId.
"""
import argparse, mmap, struct, sys
from collections import Counter


def packets(path):
    with open(path, 'rb') as f:
        m = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    off, n, le, links, ifc = 0, len(m), '<', {}, 0
    while off + 12 <= n:
        btype, blen = struct.unpack_from(le + 'II', m, off)
        if btype == 0x0A0D0D0A:                       # section header
            le = '<' if m[off + 8:off + 12] == b'\x4d\x3c\x2b\x1a' else '>'
            blen = struct.unpack_from(le + 'I', m, off + 4)[0]; ifc = 0
        elif btype == 1:                              # interface description
            links[ifc] = struct.unpack_from(le + 'H', m, off + 8)[0]; ifc += 1
        elif btype == 6:                              # enhanced packet
            iid, th, tl, cap, _ = struct.unpack_from(le + 'IIIII', m, off + 8)
            if links.get(iid) == 249:
                yield ((th << 32) | tl), m[off + 28:off + 28 + cap]
        if blen < 12:
            break
        off += blen


def decode(path):
    """Return a list of protocol events (t, kind, a, b) and the raw events."""
    pend, raw = {}, []
    for ts, p in packets(path):
        hl, irp, status, func, info, bus, dev, ep, xfer, dlen = struct.unpack_from('<HQIHBHHBBI', p, 0)
        data, resp = bytes(p[hl:hl + dlen]), bool(info & 1)
        if xfer == 2:
            stage = p[27] if hl >= 28 else None
            if stage == 0 and not resp:
                bmr, breq, wv, wi, wl = struct.unpack_from('<BBHHH', data, 0)
                pend[irp] = dict(ts=ts, bmr=bmr, req=breq, wv=wv, wi=wi, out=data[8:])
            elif resp and irp in pend:
                e = pend.pop(irp); e.update(kind='ctl', inp=data); raw.append(e)
        elif xfer == 3:
            if resp and ep & 0x80:
                raw.append(dict(ts=ts, kind='bin', data=data))
            elif not resp and not ep & 0x80:
                raw.append(dict(ts=ts, kind='bout', data=data))
        elif xfer == 1 and resp:
            raw.append(dict(ts=ts, kind='int', data=data))
    if not raw:
        sys.exit('no USBPcap traffic found')
    t0, S, addr = raw[0]['ts'], [], None
    for e in raw:
        t = (e['ts'] - t0) / 1e6
        if e['kind'] == 'ctl':
            wv, wi, o, i = e['wv'], e['wi'], e['out'], e['inp']
            if e['bmr'] == 0x40 and wv == 0x83:
                if len(o) == 1:
                    addr = o[0]; S.append((t, 'addr', o[0], None))
                else:
                    for k in range(0, len(o) - 1, 2):
                        S.append((t, 'w', o[k], o[k + 1]))
            elif e['bmr'] == 0xC0 and wv == 0x84:
                S.append((t, 'r', addr, i[0] if i else None))
            elif wv == 0x8E:
                S.append((t, 'poll', wi, i[0] if i else None))
            elif wv == 0x82:
                S.append((t, 'hdr', tuple(o[:4]), int.from_bytes(o[4:8], 'little')))
            elif wv == 0x8D:
                S.append((t, 'bulkend', None, None))
            elif wv == 0x8C:
                S.append((t, '8c', wi, o[0] if o else None))
            elif e['bmr'] & 0x60 == 0:
                S.append((t, 'std', e['req'], (wv, i.hex())))
        elif e['kind'] == 'bin':
            S.append((t, 'bin', len(e['data']), None))
        elif e['kind'] == 'bout':
            S.append((t, 'bout', len(e['data']), e['data']))
        else:
            S.append((t, 'int', e['data'].hex(), None))
    return S, raw


def summary(S):
    c = Counter(s[1] for s in S)
    print('events:', dict(c))
    for t, k, a, b in S:
        if k == 'std' and a == 6 and b[0] == 0x0100 and len(b[1]) >= 28:
            d = bytes.fromhex(b[1])
            vid, pid, bcd = struct.unpack_from('<HHH', d, 8)
            print(f'device descriptor: {vid:04x}:{pid:04x} bcdDevice 0x{bcd:04x}'
                  + ('  -> 7600i-v1 (GL843)' if bcd == 0x400 else '  -> 7600i-v2 (GL845)' if bcd == 0x605 else ''))
            break
    print('0x8C writes:', [(round(t, 3), hex(a), hex(b)) for t, k, a, b in S if k == '8c'])
    print('0x8D sent:', sum(1 for s in S if s[1] == 'bulkend'))
    print('interrupt IN:', [(round(t, 3), a) for t, k, a, b in S if k == 'int'])
    bins = [s[2] for s in S if s[1] == 'bin']
    print(f'bulk IN: {len(bins)} transfers, {sum(bins):,} bytes; sizes {Counter(bins).most_common(4)}')


def bulk_ops(S):
    regs, last = {}, None
    u16 = lambda a: (regs.get(a, 0) << 8) | regs.get(a + 1, 0)
    u24 = lambda a: (regs.get(a, 0) << 16) | (regs.get(a + 1, 0) << 8) | regs.get(a + 2, 0)
    print('\nbulk operations with register state in force:')
    for t, k, a, b in S:
        if k == 'w':
            regs[a] = b
        elif k == 'addr':
            last = a
        elif k == 'hdr' and a[0] == 1:
            print(f'{t:8.3f} OUT {b:>9,} B via 0x{last:02X}  5B/5C={regs.get(0x5B,0):02X}{regs.get(0x5C,0):02X}  29-2B={u24(0x29):06X}')
        elif k == 'hdr':
            print(f'{t:8.3f} IN  {b:>11,} B  DPISET {u16(0x2C)} STR {u16(0x30)} END {u16(0x32)} LPERIOD 0x{u16(0x38):04X} '
                  f'LINCNT {u24(0x25)} LINESEL {regs.get(0x1E,0)&15} FEEDL {u24(0x3D)} '
                  f'01={regs.get(1,0):02X} 02={regs.get(2,0):02X} 03={regs.get(3,0):02X} A8={regs.get(0xA8,0):02X}')


def timeline(S):
    for t, k, a, b in S:
        if k == 'poll' and a == 0x20:
            continue                                  # write-acks: one after every write
        fa = hex(a) if isinstance(a, int) else a
        fb = hex(b) if isinstance(b, int) else ('' if b is None else (b.hex()[:32] if isinstance(b, bytes) else b))
        print(f'{t:9.3f} {k:6s} {fa} {fb}')


def image(S, raw, preview):
    import numpy as np
    regs = {}
    best = None
    for t, k, a, b in S:
        if k == 'w':
            regs[a] = b
        if k == 'hdr' and a[0] == 0 and (best is None or b > best[1]):
            best = (t, b, dict(regs))
    t0 = raw[0]['ts']
    t_hdr, size, R = best
    data = b''.join(e['data'] for e in raw if e['kind'] == 'bin' and (e['ts'] - t0) / 1e6 > t_hdr)[:size]
    u16 = lambda a: (R.get(a, 0) << 8) | R.get(a + 1, 0)
    px = (u16(0x32) - u16(0x30)) * u16(0x2C) // 1200
    lines = len(data) // (px * 6)
    print(f'\nlargest read at {t_hdr:.2f}s: {len(data):,} B = {px} px x {lines} lines (16-bit RGB)')
    a = np.frombuffer(data[:px * lines * 6], dtype='<u2').reshape(lines, px, 3).astype(np.float32)
    y0, y1, x0, x1 = lines // 6, lines * 5 // 6, px // 6, px * 5 // 6
    sub = a[y0:y1, x0:x1:4]
    R_, G_, B_ = [np.gradient(sub[:, :, c], axis=0) for c in range(3)]

    def shift(ref, mov, rng):
        best = []
        for dy in rng:
            A, M = ref[100:-100], np.roll(mov, -dy, axis=0)[100:-100]
            A, M = A - A.mean(), M - M.mean()
            best.append((float((A * M).sum() / np.sqrt((A * A).sum() * (M * M).sum())), dy))
        return max(best)
    g, bl = shift(R_, G_, range(-100, 101)), shift(R_, B_, range(-100, 101))
    print(f'colour line shifts in delivered lines: G {g[1]:+d} (r={g[0]:.2f}), B {bl[1]:+d} (r={bl[0]:.2f})')
    if preview:
        from PIL import Image
        gs, bs = max(g[1], 0), max(bl[1], 0)
        m = max(gs, bs)
        img = np.stack([a[0:lines - m, :, 0], a[gs:lines - m + gs, :, 1], a[bs:lines - m + bs, :, 2]], -1)[::8, ::8]
        lo, hi = np.percentile(img, 0.5, axis=(0, 1)), np.percentile(img, 99.5, axis=(0, 1))
        n = np.clip((img - lo) / (hi - lo), 0, 1)
        Image.fromarray((255 * (1 - n) ** (1 / 2.2)).astype(np.uint8)).save(preview)
        print(f'preview (inverted, square sample pitch, not aspect-corrected) -> {preview}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('capture')
    ap.add_argument('--timeline', action='store_true')
    ap.add_argument('--image', action='store_true')
    ap.add_argument('--preview', default=None, help='write an inverted preview PNG (with --image)')
    args = ap.parse_args()
    S, raw = decode(args.capture)
    if args.timeline:
        timeline(S)
    else:
        summary(S); bulk_ops(S)
    if args.image:
        image(S, raw, args.preview)
