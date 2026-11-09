#!/usr/bin/env python3
"""Condense a usbspy log (tools/usbspy) into one line per event for the OpticFilm 8100.

Register writes (0x40/0x04/0x83) are split into reg=value pairs, reads (0xC0/0x04/0x8E) become R reg=val,
bulk transfers keep their size. Usage: decode_usbspy.py LOG [--from T] [--to T]"""
import re, sys

LINE = re.compile(r'^([\d.]+) (CTRL|BULKOUT|BULKIN)\S* (.*)$')

def events(path):
    for l in open(path):
        m = LINE.match(l.rstrip('\n'))
        if not m:
            continue
        t, kind, rest = float(m.group(1)), m.group(2), m.group(3)
        data = bytes.fromhex(rest.split('data=')[1]) if 'data=' in rest and rest.split('data=')[1] else b''
        if kind == 'CTRL':
            f = dict(x.split('=') for x in rest.split() if '=' in x and not x.startswith('data'))
            if 'rt' not in f:
                continue  # the "CTRL result" line of a write
            rt, req, val, idx = (int(f[k], 16) for k in ('rt', 'req', 'val', 'idx'))
            if (rt, req, val) == (0x40, 4, 0x83):
                yield t, 'W', [(data[i], data[i + 1]) for i in range(0, len(data) - 1, 2)]
            elif (rt, req, val) == (0xC0, 4, 0x8E):
                yield t, 'R', (idx >> 8, data[0] if data else None)
            elif rt in (0x40, 0xC0):
                yield t, 'V', (rt, req, val, idx, data)
        elif kind == 'BULKOUT':
            n = int(re.search(r'len=(\d+)', rest).group(1)); ep = re.search(r'ep=(\w+)', rest).group(1)
            yield t, 'BO', (ep, n, data)
        else:
            n = int(re.search(r'got=(\d+)', rest).group(1)); ep = re.search(r'ep=(\w+)', rest).group(1)
            yield t, 'BI', (ep, n)

def main():
    a = sys.argv[1:]
    lo = float(a[a.index('--from') + 1]) if '--from' in a else 0
    hi = float(a[a.index('--to') + 1]) if '--to' in a else 1e9
    for t, k, v in events(a[0]):
        if not lo <= t <= hi:
            continue
        if k == 'W':
            print(f'{t:9.3f} W  ' + ' '.join(f'{r:02x}={x:02x}' for r, x in v))
        elif k == 'R':
            print(f'{t:9.3f} R  {v[0]:02x}={v[1]:02x}')
        elif k == 'V':
            print(f'{t:9.3f} V  rt={v[0]:02x} req={v[1]:02x} val={v[2]:04x} idx={v[3]:04x} {v[4].hex()}')
        elif k == 'BO':
            print(f'{t:9.3f} BO ep={v[0]} len={v[1]}')
        else:
            print(f'{t:9.3f} BI ep={v[0]} len={v[1]}')

if __name__ == '__main__':
    main()
