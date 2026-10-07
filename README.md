# OpenOptic

**An open roll scanner for the Plustek OpticFilm 7600i.** OpenOptic is an unofficial, open-source
scanning application for this film scanner (first version: USB `07b3:0c3b`, bcdDevice 4.00, Genesys GL843). A single executable runs a small
local web server, talks to the scanner over USB with the operating system's own interface, and
opens a roll-scanning page in your browser. No driver, SANE or SilverFast installation is needed.

It replays the USB command sequences that the official software sends, recorded from a real
7600i, so scans are made with the same register settings, motor tables and calibration as the
vendor software, and adds roll-oriented features on top:

- **Roll workflow**: load a frame, press Space (or the scanner's front button); each frame is saved
  as a linear 16-bit TIFF with a JSON record into a dated roll folder, and the roll list is read
  back from that folder.
- **1440, 3600 and 7200 dpi**, with sub-pixel colour alignment, Lanczos-3 line reduction and an
  optional faster mode without CCD dummy lines (3600 dpi in ~40 s).
- **Multi-exposure** (two passes, as SilverFast does): an extended-range linear merge for negative
  converters, or an HDR-style exposure fusion of the negatives.
- **Infrared dust and scratch repair** (iSRD-style): the IR pass is registered to the image,
  defects are detected against the scan's own IR noise and filled by exemplar inpainting; the IR
  channel is kept as the TIFF's 4th channel.
- Live line-by-line preview, front-button support, and a detailed record of every acquisition.

> **Status and disclaimer.** This is a hobby project, not affiliated with or endorsed by Plustek or
> LaserSoft Imaging. "OpticFilm", "SilverFast" and "iSRD" are trademarks of their owners. It drives
> the scanner's motor and lamp directly; it has been used on one scanner, and you use it at your
> own risk. Only the first 7600i hardware version (bcdDevice 4.00) is supported; later units
> (bcdDevice 6.05, GL845) are refused.

## Quick start

1. Download the file for your system from the [Releases](../../releases) page:

   | System | File |
   |---|---|
   | Windows (most PCs) | `openoptic-windows-x64.exe` |
   | Windows on ARM | `openoptic-windows-arm64.exe` |
   | Mac with Apple silicon (M1 or later) | `openoptic-macos-apple-silicon` |
   | Intel Mac | `openoptic-macos-intel` |
   | Linux PC | `openoptic-linux-x64` |
   | Linux ARM (Raspberry Pi 4/5 64-bit) | `openoptic-linux-arm64` |

2. Do the one-time setup for your system (below), close SilverFast or any other scanning software
   (only one program can hold the scanner), and run the file. Your browser opens the roll page;
   keep the console window open while you scan, and press Ctrl+C in it (or close it) to quit.
3. Press **Connect scanner**, load a frame, and press Space.

Scans are saved by the helper directly into the roll folder shown on the page (default `~/Pictures/OpenOptic/<today's date>`, e.g. `2026-10-06`, with files `Roll_01.tif`, `Roll_02.tif` …; **New roll…** starts a new dated folder beside it; change it with **Choose…**, which opens a folder browser and can also open your system's folder dialog, or set the default parent with `-out /path`). Choose a resolution (1440, 3600 or 7200 dpi; 7200 needs about 1.4 GB of free memory in the browser), load a frame, and press Space: the frame is scanned, saved as `<prefix><number>.tif` with a `.json` record, and released from memory, and the number advances. A `<prefix>_roll.json` file in the folder lists every frame. Existing files are never overwritten unless you choose Rescan on a frame.

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
chmod +x openoptic-macos-apple-silicon
xattr -d com.apple.quarantine openoptic-macos-apple-silicon
./openoptic-macos-apple-silicon
```

(Use `openoptic-macos-intel` on an Intel Mac.)

### Linux: allow your user to access the scanner

```
sudo ./openoptic-linux-x64 -install-udev
```

That writes the rule, reloads udev and tells you to re-plug the scanner; afterwards run the helper
normally. Two alternatives, if you prefer:

- **Just use sudo:** `sudo ./openoptic-linux-x64`. Nothing is installed, and scans you save still
  belong to you, not to root.
- **Install sane-backends** (`sudo apt install sane-utils`, `sudo dnf install sane-backends`) and
  re-plug the scanner: its scanner rules usually cover this device already.

If you would rather write the rule by hand, it is:

```
sudo tee /etc/udev/rules.d/70-openoptic.rules <<'EOF'
SUBSYSTEM=="usb", ATTR{idVendor}=="07b3", ATTR{idProduct}=="0c3b", MODE="0660", TAG+="uaccess"
EOF
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Replug the scanner after adding the rule.

## Main button, horizontal flip and Advanced options

The bar under the preview holds the resolution choice (1440 / 3600 / 7200 dpi, each showing file size and scan time), the main button, **Check framing** and, on the right, **Stop** (stops and parks the carriage). The main button reads **Connect scanner** until the scanner is connected, then **Scan & Save <name>.tif** (Space works for both). **Reconnect scanner** is in Diagnostics. In a dry run the button scans straight away; **End dry run** returns to your roll list and counter.

**Flip horizontally** (Roll section) is on by default. It mirrors the aligned TIFF, the preview JPEG, the on-screen framing prescan and the roll thumbnails. The flip is applied after channel alignment and 7200 dpi column-stagger correction (which follow native sensor column parity) and before the TIFF orientation tag. The raw USB TIFF is never flipped. The sidecar records it under `processing.horizontalMirror`.

**Multi-exposure** and **Infrared** sit in the top (Roll) section. Every sidebar explanation is behind an ⓘ next to its option. **Advanced** holds sensor pixel averaging, dummy lines, front-button actions, LED warm-up, keep LED on, and **Line doubling**.

The scanner samples twice as many lines as columns (the official software steps the carriage half as far per line as the sensor's column spacing). Line doubling offers three ways to handle this:

- **Average line pairs**: each output row is the mean of two raw lines, after linear-interpolated colour alignment.
- **Lanczos-3** (default): each colour channel is resampled once, straight from the raw lines, with a Lanczos-3 kernel stretched 2× (12 taps). Colour alignment, 7200 dpi stagger and line reduction happen in one step on the same output grid as the pair average. Compared with the pair average it keeps similar detail up to about 0.8 of the output Nyquist, has about a third of the worst-case aliasing (harsh grain), slightly less noise, and gives all three channels the same sharpness. Negative kernel lobes can leave a faint halo on very hard edges; values are clamped to 0–65535. Extra processing: about 0.5 s at 3600 dpi, 3 s at 7200 dpi.
- **Keep all lines**: every line, with separate X/Y dpi tags; most software displays it stretched.

The sidecar records the method under `processing.verticalAveraging` and `processing.interpolation`, and each TIFF entry records `lineFilter`.

## Dummy lines

**Advanced → Dummy lines** defaults to **none**, as SANE does: 3600 dpi in about 40 s instead of 80 s. It shortens the main scan. At 3600 and 7200 dpi the official software sets the GL843's LINESEL to 1 and 2: after every real CCD line it clocks out 1 or 2 unused lines. The datasheet gives their purpose only as resolving the "start/stop (discontinuous) problem", i.e. restarts after buffer-full backtracking.

| Setting | 3600 dpi | 7200 dpi | Data rate needed |
|---|---|---|---|
| As recorded | 79 s (1 dummy line) | 3 min 57 s (2) | 2.75 / 3.66 MB/s |
| One fewer | 40 s (0) | 2 min 38 s (1) | 5.49 / 5.49 MB/s |
| None | 40 s (0) | 79 s (0) | 5.49 / 10.98 MB/s |

Only the main scan changes: LINESEL is written in its start write, and its motor tables' cruise period is scaled by the same factor (14000 to 7000 at 3600 dpi; 42000 to 28000 or 14000 at 7200 dpi), so the carriage still moves the recorded number of steps per line. Line spacing, image size, colour offsets, LINCNT, exposure (LPERIOD), the calibration frames and the shading tables stay as recorded. The recorded white references were read with 1, 2 and 5 dummy lines and came out at the same level, so dummy lines do not lengthen the exposure.

The costs: each line is exposed while the carriage moves 2 or 3 times further, so vertical detail is softer (closer to SANE's default); the page must sustain the higher data rate or it stops the scan; and without dummy lines a restart after backtracking may leave a visible band. The frame sidecar records the setting under `acquisition.options.dummyLines` and `acquisition.scanTiming`.

## Scanner events, front buttons and the positioning stop

While connected, the page listens on the scanner's interrupt endpoint (0x83), as the Plustek software does, and logs every event (**Log** tab: `scanner event 0x..`).

**Positioning stop.** The captures showed the official software stops the first positioning move 0.8 ms after the scanner sends event `0x08`, which the app had been imitating with a fixed 2.56–2.57 s timer. The scan now stops that move on the event itself (the GPIO4 position sensor bit, `0x08`), accepting it only after half the recorded time; button events are ignored. If no event arrives by 150 ms after the recorded moment, it stops by timer and logs it. When events are unavailable it uses the recorded timing exactly, as before. The log line `positioning move stopped by … at +… ms` and the frame sidecar (`acquisition.positioningStop`) record which happened.

**Front buttons.** The two front buttons report on the same endpoint: button A (GPIO3, event `0x04`) and button B (GPIO2, event `0x02`). **Advanced → Front button A / B** sets what each does: Scan & Save (A's default), Check framing (B's default), Stop, or nothing. Pressing a button highlights its row there. Presses are ignored while the scanner is busy (unless set to Stop), while a frame is waiting to be saved, or while the folder dialog is open, and the log says why.

**Button monitor.** **Diagnostics → Monitor buttons (60 s)** logs every scanner event and every change of GPIO registers 0x6C/0x6D while you press the front buttons, then writes a `BUTTON MONITOR RESULT` line. Once the codes are known, a button can be mapped to **Scan & Save**.

If the event endpoint has errors, the page keeps retrying (it used to stop after three), and while the scanner is idle it also polls the GPIO inputs (register 0x6D, as the button monitor does) so presses still work. A press seen both ways acts once; polling pauses during every operation.

Event support depends on the helper's USB backend: Linux (usbfs) and Windows with WinUSB read the interrupt endpoint; Windows with Plustek's usbscan driver and macOS report it as unavailable and keep the timed stop. Under plain WebUSB the browser reads it directly.

## Loading a roll from its folder

With the helper, the roll list is what is in the roll folder: on start, whenever the **Folder**
changes, and when the window regains focus, the page reads the frame records (`<name>.json`) in
that folder. Frames deleted on disk disappear from the list; frames copied in appear. When the
folder is chosen, the roll name and digits are taken from its frame names and the next number
moves past the last frame. Frames without a stored preview get one (and a thumbnail) from their
TIFF, downsampled by the helper, one at a time in the background.

## How the preview is rendered

The on-screen preview, thumbnails and preview JPEG are rendered from the linear TIFF data with no
stored calibration: per channel, ignoring a 2 % margin, the 0.1 % and 99.9 % levels (`lo`, `hi`)
are taken from the frame itself; negatives are shown as `log(hi/v) / log(hi/lo)` with a 1/1.4
gamma, slides as a linear stretch with 1/2.2 gamma. This balances colour per frame (the orange
mask included) but does not measure the film base, varies from frame to frame, and is not saved in
the TIFF or its JSON. The scanner-side calibration (hardware shading, black-level correction,
recorded AFE gains) is already in the TIFF values. For darktable's negadoctor the equivalent
inputs would be Dmin = `hi`, Dmax = `log10(hi/lo)` and an offset from `lo`, ideally with Dmin taken
from the unexposed film base at the frame edge rather than from the picture.

## Frame previews

Selecting a saved frame shows a 2400 px preview (box-filtered from the full frame). These previews
are kept in the browser's IndexedDB for the helper's address, so they survive page reloads; the roll
list itself keeps 240 px thumbnails. Frames scanned before this version only have the thumbnail.
Deleting a frame also removes its stored preview.

## Roll strip and frame details

The roll is a single filmstrip row under the preview (scroll it sideways). Selecting a frame shows
one summary line (name, time, resolution, size, film, ME/IR) with **Rescan…** and **Delete…**;
**Info ▸** expands the file list, checksums and channel alignment. **Hide ▾** on the Roll/Log tab
bar collapses the whole panel so the preview gets the full height (clicking a tab opens it again).
Both choices are remembered in this browser.

## Deleting frames

With the helper the roll list is the roll folder, so select a frame and press **Delete …**: after a
confirmation, every file of that frame (TIFFs, its `.json`, preview JPEG, USB trace) is **moved**
into a `Deleted` sub-folder of the roll folder. Nothing is erased: restore a frame by moving its
files back, or empty `Deleted` yourself. The roll record JSON is updated, and the frame counter is
not changed; set **Number** yourself to reuse a freed number.

Frames whose `.json` is still there but whose TIFF was deleted or moved outside the app are shown
dashed and marked “file missing”; a bar above the list moves what is left of them to `Deleted`.

Without the helper (plain WebUSB browser) and in a dry run the list belongs to the browser, and
**Remove … from list** only drops the frame from it.

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

The old staged **Exposure** setting is replaced by **Multi-exposure** (below).

Choices persist across page reloads and are locked during acquisition. Frame JSON
sidecars record the applied options and effective register values; the source
capture hash continues to identify the original baseline recording. The previous
7200 dpi read-before-shutdown fix is included. These controls are on the main roll
page.

Tests: `node tests/scan_options.test.cjs`, `node tests/scan_options_ui.test.cjs`,
`node tests/capture_runtime.test.cjs`, and `node tests/roll.test.cjs`.

## Saturated-highlight correction

Black-level correction now clamps both limits of the 16-bit range. Older versions
could wrap a saturated channel to near zero when its measured dark offset was
negative, causing magenta TIFF highlights and strongly tinted negative previews.
Run `node tests/saturation.test.cjs` for the regression test.

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

Regression: `node tests/stagger.test.cjs` covers direction/parity, sharp edges,
fractional RGB alignment, full-height and averaged TIFFs, in-place output, preview
sampling, raw-byte preservation and sidecar metadata. This update also retains
the earlier scan-sequencing and black-level overflow fixes.

## Live preview while scanning

The viewer draws the frame as the scanner delivers it, line by line, with the colour delays
applied, inverted for negatives, mirrored and rotated as the final preview will be. Levels refine
as rows arrive. Each pass of a multi-pass frame is labelled ("pass 2 of 3: infrared · 40 %").

## Multi-exposure (3600 dpi)

The frame is always scanned exactly twice, as SilverFast does; **Long pass** only sets the second pass's exposure: the normal pass, then a long-exposure pass
(line period ×2, ×3 or ×4, no dummy lines, motor cruise scaled so the line spacing stays the same;
calibration stays at 1×). The ×3 pass is byte-for-byte the register state of SilverFast's own
multi-exposure pass. Two modes:

- **Extended range** (linear): the long pass is registered (sub-pixel) to the normal pass, fitted
  per channel as `long = slope·short + offset` (Kodak Gold: slopes 3.06–3.12, offsets 660–2,040
  counts, from the black level: the dark frame overestimates the image black), and the two are blended by inverse variance using a noise model from the
  calibration frames. The long pass fades out at 90–98 % of full scale, so clipped samples (the
  orange-mask red channel on Lucky film) come from the normal pass only. Output stays linear 16-bit
  at the normal-pass scale, ready for negative converters. On Kodak Gold shadow noise drops by
  about a quarter in red and green and nearly half in blue.

Time: the long pass's line time is its exposure, so with dummy lines off a k× pass takes k × 40 s
(2× 79 s, 3× 119 s, 4× 158 s) plus ~15 s to recalibrate and reposition. A 3600 dpi frame with
the 3× pass takes about 2 min 55 s (SilverFast: 3 min 53 s for the same job); with infrared as
well, about 3 min 50 s. The resolution menu shows the total and the passes.
- **Exposure fusion** (HDR look): the two passes are merged Mertens-style (contrast, saturation
  and well-exposedness weights, Laplacian-pyramid blend) **as negatives**: no inversion and no
  per-channel levels, so the orange mask and the scanner's colour balance pass through. The blend
  runs on gamma-encoded values and is decoded back to linear 16-bit (black 0); clipped long-pass
  samples are left out. Dense areas take more of the long pass, so overall contrast is compressed
  (the HDR look) while local detail is kept. Invert it in your negative converter as usual.

## Infrared dust and scratch repair (3600 dpi)

Adds a third, complete infrared sequence (white LED off, IR LED on via GPIO27, as recorded from
SilverFast's iSRD). Colour dyes are transparent to IR, so dust, hair and scratches are the only
dark marks. Processing: registration of the IR pass on the defects themselves (the pass lands
1–2.5 lines off), removal of the faint cyan-dye ghost (log IR ≈ 0.06·log R), a transmission map,
exclusion of the film holder, then detection by hysteresis against the scan's own IR noise (seeds
5σ below the clean level, grown through neighbours 2.5σ below it), so hairline scratches at
92–95 % IR transmission are found along their whole length. **Repair** then:

- leaves alone IR marks that do not show in the colour image (dust off the film plane, rings from
  out-of-focus specks: typically a quarter of what the IR sees), measured with a morphological
  closing so a strong edge such as the frame border never counts as a defect;
- fills only the visibly damaged pixels of each defect (the whole footprint for broad smudges),
  by exemplar (patch-based) inpainting from nearby film texture, which keeps the grain; thin
  defects are filled however long they are;
- divides only very large broad smudges by their IR transmission^γ.

Tested on your Kodak Gold and Lucky iSRD captures: ~480 and ~340 defects repaired, residual
contrast of the repaired areas within the grain for 92–98 % of them. **Detect only** leaves the colour alone.
B&W silver film and Kodachrome block IR; that is detected and the frame is not repaired.

Either way the registered infrared is saved as a **4th channel of the TIFF** (RGBI, 16-bit,
ExtraSamples = unspecified, as in SilverFast's 64-bit HDRi files). Programs that only read RGB
ignore the 4th channel; Photoshop shows it as an extra channel. No separate mask file is written.

While the extra passes are processed, the status line and progress bar show each step (aligning,
finding dust and scratches, merging or fusing, repairing). **Show repairs** on the preview (or the
R key) overlays what was repaired (detect only: what was found) in magenta with an amber halo; the
preview-size mask is kept in the frame's JSON (`processing.infrared.overlay`), so it also works for
frames loaded back from the folder.

Detection takes about 23 s per 3600 dpi frame and repair about 10 s (shown with a progress bar). Settings are recorded in the
sidecar under `processing.multiExposure` and `processing.infrared`; the roll list shows ME and IR
badges. Neither works with “raw USB only” TIFFs.

## Film stocks

Scanning is not stock-specific: the calibration is read through the holder, not the film, and
matched across Lucky 200 and Kodak Gold 200 within 2 %. The orange mask is handled per frame by
the preview levels and by negative converters. Kodak Gold is denser (blue median 4 % of full
scale against Lucky's 8 %), so it benefits more from multi-exposure.

## Command-line options

- `-port 47600`: the local port. Keep the default: the page keeps its settings and previews in the
  browser per address.
- `-no-browser`: don't open a browser; visit the printed address yourself.
- `-out /path`: the default parent folder for roll folders (default `~/Pictures/OpenOptic`).
- `-install-udev` (Linux): install the udev rule that gives your user access to the scanner, then exit.
- `-version`: print the version and exit.

## How it works

The scanner is driven by **replaying recorded command sequences** (`capture_profiles.js`): the
exact USB traffic of the official software for each resolution, recorded from a 7600i v1,
including its analogue front-end settings, motor tables and hardware shading uploads. The
calibration is therefore the recorded one for that unit, checked live: the white and dark
calibration reads of every scan are compared with the recording, and black level is corrected.
On top of the recordings the app can drop CCD dummy lines, lengthen the exposure (multi-exposure)
and run the recorded infrared sequence; every change is documented in
[docs/PROTOCOL.md](docs/PROTOCOL.md). All image processing (alignment, multi-exposure merge,
infrared repair, previews) runs in the page; the Go helper only does USB and file access.

The recordings and the tools that turned them into profiles are described in
[docs/CAPTURE_VALIDATION.md](docs/CAPTURE_VALIDATION.md) and `tools/build_capture_profiles.py`.

## Building and testing

Requires **Go 1.24** or newer and, for the tests, **Node.js 20** or newer.

```sh
make build        # ./openoptic for this system
make dist         # all six release binaries into dist/ (same as ./build.sh)
make test         # Go tests and the JavaScript test suite
```

The only third-party Go module is `github.com/ebitengine/purego`, which lets the macOS build
call IOKit without a C compiler. The helper embeds `ui.html` and the
JavaScript files at build time. Opening `ui.html` straight from disk also works for a dry run
(simulated scanner) without the helper.

To check without a scanner: run the helper, open **Diagnostics → Dry run** on the page; frames are
synthesised and written as real files.

## Documentation

| Document | Contents |
|---|---|
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | The scanner's USB protocol as evidenced by the captures: transfers, registers, status bits, tables, geometry and timing, scan sequence, motor, events |
| [docs/CAPTURE_FINDINGS_COLOUR_ME_IR.md](docs/CAPTURE_FINDINGS_COLOUR_ME_IR.md) | Colour-film, multi-exposure and infrared captures: settings, black level, IR data |
| [docs/DESIGN_MULTIEXPOSURE_AND_IR.md](docs/DESIGN_MULTIEXPOSURE_AND_IR.md) | Design and validation of multi-exposure and infrared repair |
| [docs/CAPTURE_VALIDATION.md](docs/CAPTURE_VALIDATION.md) | The recorded acquisition baseline |
| [docs/CHANGES_AND_FINDINGS.md](docs/CHANGES_AND_FINDINGS.md) | Development log: changes, findings and fixes |

## License

[MIT](LICENSE). The GL843 register semantics come from the Genesys Logic datasheet.
