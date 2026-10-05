# OpticFilm scanner helper

A single executable that runs the OpticFilm 7600i scanner page on Linux, Windows and macOS. It serves the page to your browser on `127.0.0.1` and talks to the scanner itself, using the operating system's own USB interface (usbfs on Linux, the installed scanner driver on Windows, IOKit on macOS). Nothing needs to be installed, and any browser works, including Firefox and Safari, since WebUSB is no longer involved.

Pick the file for your system:

| System | File |
|---|---|
| Windows (most PCs) | `opticfilm-windows-x64.exe` |
| Windows on ARM | `opticfilm-windows-arm64.exe` |
| Mac with Apple silicon (M1 or later) | `opticfilm-macos-apple-silicon` |
| Intel Mac | `opticfilm-macos-intel` |
| Linux PC | `opticfilm-linux-x64` |
| Linux ARM (Raspberry Pi 4/5 64-bit) | `opticfilm-linux-arm64` |

Run it, and your browser opens the roll scanner page. Keep the console window open while you scan. Press Ctrl+C in it (or close it) to quit.

Scans are saved by the helper directly into the roll folder shown on the page (default `~/Pictures/OpticFilm/Roll001`; change it with **Choose…**, which opens a folder browser and can also open your system's folder dialog, or set the default parent with `-out /path`). Choose a resolution (1440, 3600 or 7200 dpi; 7200 needs about 1.4 GB of free memory in the browser), set a name prefix and starting number, load a frame, and press Space: the frame is scanned, saved as `<prefix><number>.tif` with a `.json` record, and released from memory, and the number advances. A `<prefix>_roll.json` file in the folder lists every frame. Existing files are never overwritten unless you choose Rescan on a frame.

The previous research page (custom resolution, crop, infrared; not verified against the vendor software) is at `/experimental`.

Close SilverFast and any other scanning software first. Only one program can hold the scanner at a time.

## One-time setup

### Windows

No driver change is needed. Keep the Plustek driver installed, and close SilverFast before connecting.

The helper checks which driver Windows has bound to the scanner and prints it in the console window:

- **usbscan** (Microsoft's still-image driver, which scanner driver packages commonly install): used directly through its documented interface.
- **WinUSB**: also works, if you ever switch to it with Zadig.
- **Anything else**: the page shows the driver's name. That driver has no documented way for other programs to reach the scanner, so please report the name.

The first time you run the `.exe`, SmartScreen may warn that it is unrecognised, because the file isn't code-signed. Click More info → Run anyway.

### macOS

No driver change is needed. The file is unsigned, so macOS quarantines it after download. In Terminal:

```sh
cd ~/Downloads
chmod +x opticfilm-macos-apple-silicon
xattr -d com.apple.quarantine opticfilm-macos-apple-silicon
./opticfilm-macos-apple-silicon
```

(Use `opticfilm-macos-intel` on an Intel Mac.)

### Linux: allow your user to access the scanner

```
sudo ./opticfilm-linux-x64 -install-udev
```

That writes the rule, reloads udev and tells you to re-plug the scanner; afterwards run the helper
normally. Two alternatives, if you prefer:

- **Just use sudo:** `sudo ./opticfilm-linux-x64`. Nothing is installed, and scans you save still
  belong to you, not to root.
- **Install sane-backends** (`sudo apt install sane-utils`, `sudo dnf install sane-backends`) and
  re-plug the scanner: its scanner rules usually cover this device already.

If you would rather write the rule by hand, it is:

```
sudo tee /etc/udev/rules.d/70-opticfilm.rules <<'EOF'
SUBSYSTEM=="usb", ATTR{idVendor}=="07b3", ATTR{idProduct}=="0c3b", MODE="0660", TAG+="uaccess"
EOF
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Replug the scanner after adding the rule.

## Options

- `-port 47600`: the local port to use. The page stores its calibration in the browser per address, so keeping the default port keeps your calibration between runs.
- `-no-browser`: don't open a browser automatically. Visit the printed address yourself.

## Capture-matched acquisition (default)

The default v1 mode follows the supplied prescan and full-scan recordings, including motor/AFE settings and the recorded hardware-shading uploads. Prescan samples at 1440 × 2880 dpi; full scan at 3600 × 7200 dpi (the file described as 3200 dpi programs 3600 dpi horizontally). Each uses its own fixed recorded frame. The profiles contain calibration data, not photographs: image pixels are read anew from the scanner.

Keep the same scanner/holder setup as the recordings. Connect, boot, home, then choose Prescan or Scan frame. Calibration in this mode is **the recorded calibration for your unit**, not a newly computed calibration. Custom crop, IR and multiple-exposure controls are disabled because those settings are not represented by these captures. Uncheck “match supplied captures” to use the separate SANE-derived custom mode and fresh host calibration.

Preview and rendered PNG align RGB channels, correct sample aspect ratio, stretch channel levels, invert negatives, and rotate upright by default. Save rendered PNG for the displayed result. Save raw RGB16 TIFF to preserve every received RGB sample, including channel-alignment margin rows, without host processing. Save aligned/processed TIFF for the working image, which may include channel alignment, host calibration or pass merging. Neither TIFF is inverted or rotated. The independent “invert preview / PNG only” checkbox changes only the displayed/rendered image. In custom multi-pass mode raw export retains the first normal-exposure RGB pass. The complete change log, discoveries and export semantics are in [README_CHANGES_AND_FINDINGS.md](README_CHANGES_AND_FINDINGS.md). Capture validation details are in [CAPTURE_VALIDATION.md](CAPTURE_VALIDATION.md).

The Go helper embeds `ui.html`, `capture_profiles.js` and `capture_runtime.js`; all three must be present when building. Opening `ui.html` directly also requires both JavaScript files alongside it.

## Testing status

Capture profiles and reconstruction were verified offline against both original USB captures. Command-stream, short-read, cancellation, and pixel/percentile tests passed. This update has not been rebuilt with Go or exercised on a physical scanner in the validation environment. The native backends still require hardware verification.

## Building from source

Install Go 1.22 or newer and run `./build.sh`. The only third-party module is `github.com/ebitengine/purego`, which lets the macOS build call IOKit without a C compiler. Source-level tests run with `node tests/capture_runtime.test.cjs` and `node tests/raw_tiff.test.cjs`.

## Protocol

`PROTOCOL.md` documents what the USB captures show about the scanner: transfer types, the register map with observed values, slope and shading tables, the analogue front end, geometry and timing formulas, the scan sequence, motor behaviour, and what is still unknown.

## Main button, horizontal flip and Advanced options

The bar under the preview holds the resolution choice (1440 / 3600 / 7200 dpi, each showing file size and scan time), the main button, **Check framing** and, on the right, **Stop** (stops and parks the carriage). The main button reads **Connect scanner** until the scanner is connected, then **Scan & Save <name>.tif** (Space works for both). **Reconnect scanner** is in Diagnostics. In a dry run the button scans straight away; **End dry run** returns to your roll list and counter.

**Flip horizontally** (Roll section) is on by default. It mirrors the aligned TIFF, the preview JPEG, the on-screen framing prescan and the roll thumbnails. The flip is applied after channel alignment and 7200 dpi column-stagger correction (which follow native sensor column parity) and before the TIFF orientation tag. The raw USB TIFF is never flipped. The sidecar records it under `processing.horizontalMirror`.

**Advanced** holds exposure, sensor pixel averaging, LED warm-up, keep LED on, and **Line doubling**.

The scanner samples twice as many lines as columns (the official software steps the carriage half as far per line as the sensor's column spacing). Line doubling offers three ways to handle this:

- **Average line pairs** (default): each output row is the mean of two raw lines, after linear-interpolated colour alignment.
- **Lanczos-3**: each colour channel is resampled once, straight from the raw lines, with a Lanczos-3 kernel stretched 2× (12 taps). Colour alignment, 7200 dpi stagger and line reduction happen in one step on the same output grid as the pair average. Compared with the pair average it keeps similar detail up to about 0.8 of the output Nyquist, has about a third of the worst-case aliasing (harsh grain), slightly less noise, and gives all three channels the same sharpness. Negative kernel lobes can leave a faint halo on very hard edges; values are clamped to 0–65535. Extra processing: about 0.5 s at 3600 dpi, 3 s at 7200 dpi.
- **Keep all lines**: every line, with separate X/Y dpi tags; most software displays it stretched.

The sidecar records the method under `processing.verticalAveraging` and `processing.interpolation`, and each TIFF entry records `lineFilter`.

## Dummy lines (experimental)

**Advanced → Dummy lines** shortens the main scan. At 3600 and 7200 dpi the official software sets the GL843's LINESEL to 1 and 2: after every real CCD line it clocks out 1 or 2 unused lines. The datasheet gives their purpose only as resolving the "start/stop (discontinuous) problem", i.e. restarts after buffer-full backtracking.

| Setting | 3600 dpi | 7200 dpi | Data rate needed |
|---|---|---|---|
| As recorded | 79 s (1 dummy line) | 3 min 57 s (2) | 2.75 / 3.66 MB/s |
| One fewer | 40 s (0) | 2 min 38 s (1) | 5.49 / 5.49 MB/s |
| None | 40 s (0) | 79 s (0) | 5.49 / 10.98 MB/s |

Only the main scan changes: LINESEL is written in its start write, and its motor tables' cruise period is scaled by the same factor (14000 to 7000 at 3600 dpi; 42000 to 28000 or 14000 at 7200 dpi), so the carriage still moves the recorded number of steps per line. Line spacing, image size, colour offsets, LINCNT, exposure (LPERIOD), the calibration frames and the shading tables stay as recorded. The recorded white references were read with 1, 2 and 5 dummy lines and came out at the same level, so dummy lines do not lengthen the exposure.

The costs: each line is exposed while the carriage moves 2 or 3 times further, so vertical detail is softer (closer to SANE's default); the page must sustain the higher data rate or it stops the scan; and without dummy lines a restart after backtracking may leave a visible band. This mode has not been tested on hardware. The frame sidecar records the setting under `acquisition.options.dummyLines` and `acquisition.scanTiming`.

## Scanner events, front buttons and the positioning stop

While connected, the page listens on the scanner's interrupt endpoint (0x83), as the Plustek software does, and logs every event (**Log** tab: `scanner event 0x..`).

**Positioning stop.** The captures showed the official software stops the first positioning move 0.8 ms after the scanner sends event `0x08`, which the app had been imitating with a fixed 2.56–2.57 s timer. The scan now stops that move on the event itself (the GPIO4 position sensor bit, `0x08`), accepting it only after half the recorded time; button events are ignored. If no event arrives by 150 ms after the recorded moment, it stops by timer and logs it. When events are unavailable it uses the recorded timing exactly, as before. The log line `positioning move stopped by … at +… ms` and the frame sidecar (`acquisition.positioningStop`) record which happened.

**Front buttons.** The two front buttons report on the same endpoint: button A (GPIO3, event `0x04`) and button B (GPIO2, event `0x02`). **Advanced → Front button A / B** sets what each does: Scan & Save (A's default), Check framing (B's default), Stop, or nothing. Pressing a button highlights its row there. Presses are ignored while the scanner is busy (unless set to Stop), while a frame is waiting to be saved, or while the folder dialog is open, and the log says why.

**Button monitor.** **Diagnostics → Monitor buttons (60 s)** logs every scanner event and every change of GPIO registers 0x6C/0x6D while you press the front buttons, then writes a `BUTTON MONITOR RESULT` line. Once the codes are known, a button can be mapped to **Scan & Save**.

Event support depends on the helper's USB backend: Linux (usbfs) and Windows with WinUSB read the interrupt endpoint; Windows with Plustek's usbscan driver and macOS report it as unavailable and keep the timed stop. Under plain WebUSB the browser reads it directly.

## Removing frames from the roll list

Select a frame and press **Remove … from list** to drop it from the roll list and the roll record JSON. Files on disk are never deleted by the page.

When running under the helper, the page checks the roll folder on load, when the folder changes, and whenever the browser window regains focus. Frames whose TIFFs are no longer there are shown dashed and marked “file missing”, and a bar above the list offers to remove them all at once. The frame counter is not changed; set **Number** yourself if you want to reuse freed numbers.

## Sensor averaging and exposure options

In **Advanced**, choose **Sensor pixels** before scanning. The default is
pixel deletion, exactly as recorded. Pixel averaging is experimental and sets
GL843 register 0x03 bit 6 on every write throughout the selected profile,
including dark/white reads and the final image. It applies to framing previews
as well. At 7200 dpi there is no horizontal reduction to average.

This setting is separate from the existing output line-pair averaging. Recorded
AFE and shading tables remain in use. Live dark/white checks run in averaging
mode even if illumination checking was set to off; they compare against the
recorded deletion-mode references and do not generate fresh shading coefficients.
No image-quality improvement has been verified on hardware.

**Exposure** defaults to the recorded 1× exposure. Choices of 1.5×, 2×, 3× and 4×
are saved for later development, but scanning or framing above 1× is blocked
before homing, lamp commands or acquisition. These are staged choices, not working
long-exposure modes. Select 1× to scan. Enabling them requires fresh AFE/shading
calibration, coordinated line/motor timing, register/table range validation, and
hardware tests. Merely increasing LPERIOD would alter the carriage distance per
line with the existing motor curve.

Choices persist across page reloads and are locked during acquisition. Frame JSON
sidecars record the applied options and effective register values; the source
capture hash continues to identify the original baseline recording. The previous
7200 dpi read-before-shutdown fix is included. These controls are on the main roll
page; the separate experimental page has not been changed.

Tests: `node tests/scan_options.test.cjs`, `node tests/scan_options_ui.test.cjs`,
`node tests/capture_runtime.test.cjs`, and `node tests/roll.test.cjs`.

## Saturated-highlight correction

Black-level correction now clamps both limits of the 16-bit range. Older versions
could wrap a saturated channel to near zero when its measured dark offset was
negative, causing magenta TIFF highlights and strongly tinted negative previews.
Run `node tests/saturation.test.cjs` for the regression test.

For an affected uncompressed RGB16 roll TIFF with its matching checksum sidecar:

```sh
python3 tools/repair_blacklevel_wrap.py input.tif input.json repaired.tif
```

This requires NumPy, refuses existing output paths, and writes a repaired TIFF
plus a sidecar with the new checksum and repair counts. Use only for files produced
by the old missing-upper-clamp pipeline. It changes identifiable wrapped samples
to 65535; it does not restore sensor-clipped highlight detail.

## 7200 dpi stagger correction

The capture-mode processing pipeline now compensates the 7600i v1's alternating
CCD columns. Native even columns read eight raw scan lines ahead of odd columns
at 14400 lines/inch, equivalent to four square-pixel rows at 7200 dpi. Correction
is applied together with RGB channel alignment, before vertical averaging and
preview downsampling. It is automatic at 7200 dpi only. The 1440/3600 profiles,
USB commands, timings, and raw USB TIFF payloads are unchanged.

The unsupported final eight raw lines are trimmed in addition to RGB alignment.
With nominal RGB shifts [0,48,96], the square TIFF is 10248 × 7009 instead of
10248 × 7013. Measured RGB shifts can change the final height. The per-frame JSON
records `processing.columnStagger`, using native column parity before orientation.
The separate experimental page already had its own stagger handling and is not
changed by this fix.

Regression: `node tests/stagger.test.cjs` covers direction/parity, sharp edges,
fractional RGB alignment, full-height and averaged TIFFs, in-place output, preview
sampling, raw-byte preservation and sidecar metadata. This update also retains
the earlier scan-sequencing and black-level overflow fixes.
