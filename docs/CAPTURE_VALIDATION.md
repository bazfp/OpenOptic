# 7200 dpi sequencing correction

The 7200 profile now reads all 868,333,536 bytes before transfer completion and
scan shutdown. The previous builder appended 402,392,140 missing capture bytes
after teardown, causing a premature transition at 127.3 seconds (53.7% of the
frame). See [CHANGES_AND_FINDINGS.md](CHANGES_AND_FINDINGS.md) for the evidence and validation.

The main scan takes approximately 237.2 seconds. Capture verification can now be
run on the supplied capture alone:

```sh
python3 tests/verify_captures.py --profile full7200 /path/to/7200ppifullframehdr.pcapng
```

The historical notes below describe the original two-profile implementation.

# Capture-matched update

The default mode acquires new image data using the vendor commands extracted from the two supplied recordings. It does not display a saved photograph. The bundled profiles contain register writes, control-read expectations, motor tables and shading uploads; they contain no captured bulk-IN image data.

## Verified acquisition settings

| Field | Prescan | Full scan |
|---|---:|---:|
| Source | prescan.pcapng | 3600ppifullframehdr.pcapng |
| ASIC / revision | GL843 / 0x0400 | GL843 / 0x0400 |
| X/Y sampling dpi | 1440 / 2880 | 3600 / 7200 |
| DPISET | 240 | 600 |
| STRPIXEL / ENDPIXEL | 213 / 10463 | 210 / 10458 |
| Acquired width / lines | 2050 / 2824 | 5124 / 7058 |
| Main transfer bytes | 34,735,200 | 216,991,152 |
| LPERIOD | 14000 | 14000 |
| LINESEL | 0 | 1 |
| LINCNT | 5648 | 14116 |
| Main FEEDL | 1 | 1 |
| Positioning moves after shading | 19490, 13228 | 19490, 13228 |
| Scan table first / cruise value | 25252 / 2800 | 25252 / 14000 |
| Main register 0x01 / 0x02 | 0x23 / 0x30 | 0x23 / 0x30 |
| Each shading upload | 24,984 bytes | 62,464 bytes |
| R/G/B line delays (recorded / measured) | 0/10/19 / 0/9.84/19.30 | 0/24/48 / 0/24.22/48.21 |
| Aligned width / lines (measured delays) | 2050 / 2804 | 5124 / 7009 |
| Upright square-pixel PNG dimensions | 1402 × 2050 | 3504 × 5124 |

Although described as 3200 dpi, the full recording programs DPISET 600: 3600 horizontal samples/inch. Motor timing, LINESEL and channel offsets support 7200 vertical samples/inch. There is no 3200 dpi hardware profile in this recording. Vertical resolutions are inferred from those independent observations; USB does not supply a textual resolution label.

Both profiles now cover the same frame: the full-frame capture uses the prescan's positioning moves (19490, 13228) and nearly the same optical window (210–10458 vs 213–10463). The earlier full profile (scanneroutput_1.pcapng) was a smaller crop that started at optical pixel 1050 with a 14332-step second move; it has been replaced. Each acquisition preserves its recorded frame, rather than pretending both captures have identical crop boundaries. Custom crop fields are disabled in capture mode.

## Exact and intentionally different behaviour

Every vendor control transaction's request/value/index/payload and every bulk-OUT payload is retained in order, including the recorded AFE and shading calibration sequence. USB enumeration is supplied by the native backend and is not replayed. Bulk-IN reads are regrouped into at most 0xF000-byte chunks while preserving every header and frame byte count. Short reads are accumulated.

Physical preflight homing and optional lamp warm-up happen before replay. Recorded inter-command gaps of 20 ms or longer are retained up to one second, but this is not a USB timing emulator. Write acknowledgements, bulk completion, data-ready and terminal motor status can be polled additional times, with a 60-second deadline, instead of trusting recorded poll counts. Each extra status poll re-sends the 0x41 address, because the GL843 advances its register address after every read; a motor start is held back while the last status read shows MOTORENB set. Automatic return is checked against the home sensor after replay. Transport errors abort the sequence; Stop cancels at a transfer boundary and parks through the existing homing routine.

### Calibration limitation

Capture mode deliberately reuses the AFE values and hardware-shading coefficients recorded for this scanner. Calibration image reads are executed and drained, but the vendor's adaptive algorithms have not been reverse-engineered and **new coefficients are not computed** from those images. This is a reproducible command-matching baseline, not a replacement for fresh adaptive calibration as the lamp ages or conditions change. It may reproduce fixed-pattern or tonal errors under different conditions.

Fresh host-side dark/white calibration remains available in custom mode, separately from capture replay. Capture-mode images must not receive this host correction a second time. IR, multisampling, multiple exposure, arbitrary DPI and crop are outside the two captured profiles and are disabled in that mode. The previous SANE-derived custom mode remains available and is not certified by these recordings.

## Reconstruction

Read the main image as little-endian interleaved 16-bit RGB. Align G/B to R using delays measured on the image itself (sub-line cross-correlation of vertical gradients, linear interpolation between bracketing lines), falling back to the integer values in the table above when correlation is below 0.3. Discard bottom rows with no corresponding delayed samples. For rendered PNG/preview, determine independent channel 0.5th/99.5th percentiles after a 150-sample inset on every edge, clamp/stretch linearly, invert for negative film, and use gamma 1. Reduce vertical size according to X/Y sampling, then optionally rotate 90 degrees counterclockwise. Default film type is negative. Positive film and Kodachrome are not inverted.

This reproduces the previous preview's processing choices. Canvas uses the browser's high-quality resampling; the supplied offline Python tool uses Pillow Lanczos, so PNG pixels can differ slightly at the resampling stage. No automatic dust removal or film colour profile is applied.

The aligned/processed TIFF contains the working 16-bit image without preview contrast/inversion/rotation, with separate X/Y resolution tags. The additional raw RGB16 TIFF copies the complete received USB main-image bytes directly into its image strip, before channel alignment or any host processing. Preview inversion is a separate checkbox and cannot change either TIFF payload. Use PNG to save what is displayed. IR in custom TIFF output is marked unspecified extra data, not alpha.

## Additional fixes

- Custom calibration width now matches the 36 mm prescan width. Calibration records its optical origin and can correct a compatible sub-crop; missing/incompatible calibration is logged instead of silently skipped.
- Custom SANE profiles no longer inherit the 3600 vendor vertical multiplier without its motor profile.
- Motor-off clears motor power; ACDCDIS only disables backtracking. Acquisition still receives the scan trigger.
- Preview aspect correction uses X/Y resolution, and incremental preview row tracking resets for each pass.
- Stop no longer writes USB commands concurrently with the in-flight acquisition. The capture-mode switch is locked while an operation runs.
- AFE offset controls support the 9-bit range.
- The Go HTTP bridge rejects short OUT writes instead of discarding the byte count and reporting success.
- Full capture source settings and hashes are retained in the TIFF JSON sidecar; fixed capture frames are not labelled with unused crop-input values.

## Validation performed

- All vendor control request/value/index/data sequences and all uploaded motor/shading bytes compared against both original PCAPs.
- All received image bytes accounted for per capture; header/frame lengths verified.
- Runtime tests exercised both full command streams, partial bulk reads, frame boundaries, acknowledgement retry, empty reads and cancellation.
- Real captured image data decoded through JavaScript: aligned channel sample values and percentile levels matched an independent NumPy calculation for both recordings.
- Both images independently reconstructed and visually inspected with corrected proportions and orientation.
- Browser JavaScript parsed successfully. A runnable browser and Go compiler were unavailable in the validation environment, so the native executable was not rebuilt and a browser/hardware end-to-end run was not performed. USB operation on the physical scanner remains to be verified.

Run from this source directory:

```sh
node tests/capture_runtime.test.cjs
node tests/raw_tiff.test.cjs
python3 tests/verify_captures.py /path/to/prescan.pcapng /path/to/3600ppifullframehdr.pcapng /path/to/7200ppifullframehdr.pcapng
python3 tools/reconstruct_capture.py /path/to/prescan.pcapng prescan.png
python3 tools/reconstruct_capture.py /path/to/3600ppifullframehdr.pcapng full.png
```

Only offline image reconstruction needs NumPy and Pillow. Profile verification/extraction uses the Python standard library. Profiles can be regenerated with `python3 tools/build_capture_profiles.py prescan.pcapng scanneroutput_1.pcapng`. The PCAPs and photographs are not included in this source archive.
