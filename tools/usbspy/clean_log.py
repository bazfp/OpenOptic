#!/usr/bin/env python3
"""Reduce a usbspy log to the scanner's own traffic so it can be shared.

Keeps vendor control requests and bulk transfers; drops the per-call trace lines and the standard
requests (descriptor/string reads), which describe every other USB device the host program enumerated.
Usage: clean_log.py IN.log OUT.log"""
import re, sys

keep = re.compile(r'^[\d.]+ (BULKOUT|BULKIN)\S* ')
ctrl = re.compile(r'^[\d.]+ CTRL .*?rt=([0-9a-f]{2}) ')

with open(sys.argv[1]) as src, open(sys.argv[2], 'w') as dst:
    for line in src:
        m = ctrl.match(line)
        if line.startswith('0.0') and 'usbspy loaded' in line or keep.match(line) or (m and int(m.group(1), 16) & 0x60 == 0x40):
            dst.write(line)
        elif m is None and re.match(r'^[\d.]+ CTRL result', line):
            dst.write(line)
