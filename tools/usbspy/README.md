# usbspy: USB capture on macOS without USBPcap

Apple Silicon Macs expose no USB capture interface, so `tcpdump` cannot record a scanner's traffic. `usbspy`
instead logs every IOUSBLib call a scanner program makes: control requests, bulk reads and writes, and a
generic trace of every other call. It is loaded into the program with `DYLD_INSERT_LIBRARIES`, which works only
for programs that allow it (their code signature carries `allow-dyld-environment-variables`, as the free trial software's does).
Nothing is modified, and SIP stays on. Use it only on your own hardware.

```sh
./build.sh                                   # builds libusbspy.dylib (arm64 + x86_64)
export DYLD_INSERT_LIBRARIES=$PWD/libusbspy.dylib USBSPY_LOG=$PWD/../../captures/run1.log
/Applications/<program>.app/Contents/MacOS/<program> &   # start the program directly, from this shell
unset DYLD_INSERT_LIBRARIES
```

Notes:
- Start the program straight from the shell. `nohup`, `env` and other system tools are SIP-protected and strip
  `DYLD_*` variables.
- Quit the program normally (Cmd-Q). Killing it mid-session can leave the scanner needing a power cycle.
- Bulk IN payloads are logged in full when the announced transfer is 4 MB or less (calibration frames) and
  truncated to their first 32 bytes otherwise. `USBSPY_FULL=1` logs everything (very large).
- `clean_log.py IN OUT` keeps only the scanner's own vendor requests and bulk transfers, dropping the standard
  requests (descriptors) that describe every other USB device the program enumerated. Do this before sharing a log.
- `tools/capture_analyse.py` and `tools/build_capture_profiles.py` read these logs like `.pcapng` captures.
  Bulk IN transfers the logger truncated are zero-padded to their true length: sizes are right, those pixels are not.
