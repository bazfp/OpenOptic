#!/usr/bin/env python3
"""Compare an application USB trace (Save USB trace JSON) with a vendor USBPcap capture.

    python3 tools/compare_trace.py prescan.pcapng openoptic-trace-XXXX.json

The application is expected to reproduce the vendor's control/bulk-OUT stream exactly. The
only permitted differences are:
  * a preflight prefix (boot/home/warm-up) before the replay starts,
  * extra readiness polls: write-ack (0x8E/0x20), bulk-complete (0x8E/0x18), and addressed
    status reads [0x83 <- 0x41, 0x8E/0x20, 0x84] (e.g. waiting for a move to finish),
  * a suffix after the replay (waiting for the carriage to reach home).
Responses to IN transfers may differ (the scanner is live); OUT payloads must be identical.

A repeated 0x84 read WITHOUT re-sending the register address is reported as an error: the
GL843 advances its address after every read, so such a poll reads 0x42, 0x43, ... instead
of the status register and ends the wait early. Exit status is non-zero on any error.
"""
import json, sys
from capture_analyse import decode


def pcap_ops(path):
    _, raw = decode(path)
    ops = []
    t0 = raw[0]['ts'] if raw else 0
    for e in raw:
        ts = (e['ts'] - t0) / 1e6
        if e['kind'] == 'ctl' and e['bmr'] in (0x40, 0xC0):
            if e['bmr'] == 0x40:
                ops.append(('out', e['req'], e['wv'], e['wi'], tuple(e['out']), ts))
            else:
                ops.append(('in', e['req'], e['wv'], e['wi'], tuple(e['inp']), ts))
        elif e['kind'] == 'bout':
            ops.append(('bulkout', len(e['data']), ts))
    return ops


def trace_ops(path):
    doc = json.load(open(path))
    ops = []
    for e in doc['trace']:
        if e['dir'] == 'bulkout':
            ops.append(('bulkout', e['len'], e.get('t')))
        else:
            ops.append((e['dir'], e.get('req'), e['value'], e['index'], tuple(e['data']), e.get('t')))
    return doc, ops


def key(e):
    if e[0] == 'bulkout':
        return ('bulkout', e[1])
    if e[0] == 'in':
        return ('in', e[2], e[3])            # request code may be omitted by UI helpers
    return ('out', e[1], e[2], e[3], e[4])


def is_addr(e, reg=None):
    return e[0] == 'out' and e[2] == 0x83 and len(e[4]) == 1 and (reg is None or e[4][0] == reg)


def is_in(e, value, index=None):
    return e[0] == 'in' and e[2] == value and (index is None or e[3] == index)


def move_stops(ops):
    """For each positioning move (0x0F=1 with SCAN clear and FEEDL > 1): seconds from the start
    write to the host's next register write if the host stops it without polling status first
    (a timed stop), or None if the host polls status and lets it run."""
    regs, addr, out, cur = {}, None, [], None
    for t in ops:
        if t[0] == 'out' and t[2] == 0x83:
            d = t[4]
            if len(d) == 1:
                addr = d[0]
                continue
            if cur is not None:
                out.append(round(t[-1] - cur, 3)); cur = None
            for q in range(0, len(d) - 1, 2):
                regs[d[q]] = d[q + 1]
                if d[q] == 0x0F and d[q + 1] == 1 and not (regs.get(1, 0) & 1) and \
                        ((regs.get(0x3d, 0) << 16) | (regs.get(0x3e, 0) << 8) | regs.get(0x3f, 0)) > 1:
                    cur = t[-1]
        elif t[0] == 'in' and t[2] == 0x84:
            if addr == 0x41 and cur is not None:
                out.append(None); cur = None
            if addr is not None:
                addr = (addr + 1) & 0xFF
    return out


def compare(pcap, trace, verbose=True):
    P = pcap
    doc, T = trace
    kP = [key(e) for e in P]
    kT = [key(e) for e in T]
    # replay start: first position where the next 40 trace ops equal the capture's first 40
    n0 = min(40, len(P))
    start = next((j for j in range(len(T) - n0 + 1) if kT[j:j + n0] == kP[:n0]), None)
    if start is None:
        print('ERROR: capture sequence start not found in trace')
        return 1
    i, j = 0, start
    errors, extra = [], {'ack': 0, 'bulk-complete': 0, 'status (addressed)': 0}
    prev_p = None               # last matched capture op
    addr = None
    move_errors = []
    for n, (sp, st) in enumerate(zip(move_stops(P), move_stops(T[start:])), 1):
        if sp is None:
            continue                                    # the vendor lets this move finish
        if st is None:
            move_errors.append((start, None, f'positioning move {n} was left to run; the vendor stops it at +{sp:.3f} s (carriage overshoots)'))
        elif abs(st - sp) > 0.05:
            move_errors.append((start, None, f'positioning move {n} stopped at +{st:.3f} s; the vendor stops it at +{sp:.3f} s (frame misplaced)'))
    while i < len(P) and j < len(T):
        if kT[j] == kP[i]:
            if is_addr(T[j]):
                addr = T[j][4][0]
            prev_p = P[i]
            i += 1; j += 1
            continue
        t = T[j]
        # extra write-ack or bulk-complete poll
        if is_in(t, 0x8E, 0x20) and prev_p is not None and (is_in(prev_p, 0x8E, 0x20) or prev_p[0] == 'out'):
            extra['ack'] += 1; j += 1; continue
        if is_in(t, 0x8E, 0x18) and prev_p is not None and is_in(prev_p, 0x8E, 0x18):
            extra['bulk-complete'] += 1; j += 1; continue
        # extra addressed status poll triple
        if (j + 2 < len(T) and is_addr(t, 0x41) and is_in(T[j + 1], 0x8E, 0x20) and is_in(T[j + 2], 0x84)):
            extra['status (addressed)'] += 1; j += 3; continue
        # the bug this tool exists to catch
        if is_in(t, 0x84) and prev_p is not None and is_in(prev_p, 0x84):
            errors.append((j, t, f'repeated 0x84 read without re-addressing (reads register 0x{(addr or 0) + 1:02X}+, not 0x{addr or 0:02X})'))
            j += 1; continue
        errors.append((j, t, f'unexpected op; capture expects {P[i][:5]}'))
        break
    errors = move_errors + errors
    if i < len(P):
        errors.append((j, None, f'trace ended {len(P) - i} ops before the capture sequence finished'))
    suffix = T[j:]
    bad_suffix = [e for e in suffix if not (is_addr(e, 0x41) or is_in(e, 0x8E) or is_in(e, 0x84))]
    # summary
    print(f"trace: {doc.get('variant')}  bcdDevice {doc.get('bcdDevice')}")
    print(f'capture ops: {len(P)}  trace ops: {len(T)}')
    print(f'preflight prefix before replay: {start} ops')
    print(f'capture ops matched in order: {i}/{len(P)} (every OUT payload and bulk-OUT length identical)')
    print('additional readiness polls: ' + ', '.join(f'{k} {v}' for k, v in extra.items()))
    print(f'suffix after replay: {len(suffix)} ops' + (f' ({len(bad_suffix)} not status polls)' if bad_suffix else ' (home-sensor status polls only)'))
    hdr_p = [int.from_bytes(bytes(e[4][4:8]), 'little') for e in P if e[0] == 'out' and e[2] == 0x82]
    hdr_t = [int.from_bytes(bytes(e[4][4:8]), 'little') for e in T[start:] if e[0] == 'out' and e[2] == 0x82]
    print(f'bulk headers: capture {len(hdr_p)}, trace {len(hdr_t)}, identical sizes: {hdr_p == hdr_t}')
    if errors:
        print(f'\n{len(errors)} ERROR(S):')
        shown = 0
        for j, t, msg in errors:
            if shown < 12:
                ts = f"t={t[-1]:.3f}s " if t and isinstance(t[-1], float) else ''
                where = f'trace[{j}] ' if t is not None else ''
                print(f'  {where}{ts}{msg}' + (f' -> {list(t[4])}' if t and t[0] == 'in' else ''))
            shown += 1
        if shown > 12:
            print(f'  ... {shown - 12} more')
        return 1
    print('\nOK: trace reproduces the capture; differences are only permitted readiness polls, preflight and home wait.')
    return 0


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    sys.exit(compare(pcap_ops(sys.argv[1]), trace_ops(sys.argv[2])))
