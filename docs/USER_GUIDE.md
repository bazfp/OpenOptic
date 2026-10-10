# OpenOptic user guide

Everything you need to scan with OpenOptic, starting with the essentials. The later sections
explain how each feature works in detail; you don't need them to get great scans. For an
overview of the project, see the [README](../README.md).

**Using OpenOptic**

1. [Install and run](#install-and-run)
2. [Scan a roll](#scan-a-roll)
3. [Recommended settings](#recommended-settings)
4. [Dust and scratch repair](#dust-and-scratch-repair)
5. [Multi-exposure](#multi-exposure)
6. [Front buttons](#front-buttons)
7. [Managing your roll](#managing-your-roll)
8. [Inverting your negatives](#inverting-your-negatives)
9. [All options](#all-options)
10. [Troubleshooting](#troubleshooting)

**Technical details**

11. [Output files](#output-files)
12. [Image processing](#image-processing)
13. [Scan speed and dummy lines](#scan-speed-and-dummy-lines)
14. [How multi-exposure works](#how-multi-exposure-works)
15. [How dust and scratch repair works](#how-dust-and-scratch-repair-works)
16. [Scanner events and the positioning stop](#scanner-events-and-the-positioning-stop)
17. [How it works](#how-it-works)
18. [Building and testing](#building-and-testing)

> OpenOptic supports the first hardware version of the Plustek OpticFilm 7600i (USB `07b3:0c3b`,
> bcdDevice 4.00, Genesys GL843). It is a hobby project, not affiliated with or endorsed by
> Plustek or LaserSoft Imaging; "OpticFilm", "SilverFast" and "iSRD" are trademarks of their
> owners. It drives the scanner's motor and lamp directly and has been developed on one scanner;
> you use it at your own risk.

---

## Install and run

Download the file for your system from the
[Releases](https://github.com/bazfp/OpenOptic/releases) page:

| System | File |
|---|---|
| Windows (most PCs) | `openoptic-windows-x64.exe` |
| Windows on ARM | `openoptic-windows-arm64.exe` |
| Mac with Apple silicon (M1 or later) | `openoptic-macos-apple-silicon` |
| Intel Mac | `openoptic-macos-intel` |
| Linux PC | `openoptic-linux-x64` |
| Linux ARM (Raspberry Pi 4/5, 64-bit) | `openoptic-linux-arm64` |

**Close SilverFast or any other scanning software first.** Only one program can use the scanner
at a time.

- **Windows**: double-click the `.exe`. Keep the Plustek driver installed; nothing needs
  changing. The file isn't code-signed, so SmartScreen may warn the first time: click
  **More info → Run anyway**.
- **macOS**: the file is unsigned, so macOS quarantines it after download. Clear that once in
  Terminal, then run it (use `openoptic-macos-intel` on an Intel Mac):

  ```sh
  cd ~/Downloads
  chmod +x openoptic-macos-apple-silicon
  xattr -d com.apple.quarantine openoptic-macos-apple-silicon
  ./openoptic-macos-apple-silicon
  ```

- **Linux**: `chmod +x openoptic-linux-x64`, then `./openoptic-linux-x64`. If your user isn't
  allowed to open the scanner, it says so and prints the one-time fix
  (`sudo ./openoptic-linux-x64 -install-udev`, then re-plug the scanner).

Your browser opens the OpenOptic page. Keep the console window open while you scan; close it, or
press Ctrl+C in it, to quit.

## Scan a roll

1. **Connect.** Press **Connect scanner** (or Space). The header shows the scanner and its
   hardware revision.
2. **Check the roll.** In the **Roll** section, check the **Folder** and **File prefix**. By
   default each day gets its own folder, `~/Pictures/OpenOptic/<date>`, and frames are named
   `Roll_01.tif`, `Roll_02.tif` and so on. **New roll…** starts a new dated folder; **Choose…**
   picks any folder.
3. **Pick a resolution** from the menu under the preview. Each entry shows the file size and scan
   time:

   | Resolution | Frame size | File size | Time |
   |---|---|---|---|
   | 1440 dpi | about 2,050 × 1,400 px | ~16 MB | ~16 s |
   | **3600 dpi** | about 5,100 × 3,500 px (18 MP) | ~103 MB | ~40 s |
   | 7200 dpi | about 10,250 × 7,000 px (72 MP) | ~411 MB | ~79 s |

   7200 dpi needs about 1.4 GB of free memory in the browser.
4. **Load a frame** and press **Check framing** (or P) for a quick look.
5. **Scan.** Press **Space**, or the scanner's top front button. The frame appears line by line
   as it scans, is saved as a TIFF with a `.json` record, and appears in the filmstrip. The frame
   number advances.
6. **Next frame.** Slide the holder to the next frame and press again. With the front buttons you
   can scan a whole roll without touching the computer.

Existing files are never overwritten: to redo a frame, select it and press **Rescan…**. **Stop**
(on the right of the bar) stops the scanner and parks the carriage.

## Recommended settings

| You want… | Use |
|---|---|
| Everyday scans | 3600 dpi, everything else at its default |
| The most detail (large prints, grain) | 7200 dpi |
| Contact-sheet style quick scans | 1440 dpi |
| Dusty or scratched film | **Infrared → dust & scratch repair** (3600 dpi) |
| Dense, underexposed or high-contrast negatives | **Multi-exposure → extended range** (3600 dpi) |
| Slides | **Film → positive (slide)** |

The defaults (Lanczos-3 line doubling, no dummy lines, automatic calibration) are the best
choices for almost everyone.

## Dust and scratch repair

**Infrared → dust & scratch repair** adds an infrared pass after the colour scan. Film dyes are
transparent to infrared, so only dust, hairs and scratches show up in it. OpenOptic finds them and
fills the damaged pixels from the surrounding film texture, keeping the grain. Marks that don't
actually show in the picture are left alone.

- **Show repairs** on the preview (or the R key) highlights what was repaired in magenta.
- **Detect only** finds defects without changing the colour image.
- The infrared image is always saved as a fourth channel inside the TIFF (programs that only read
  RGB ignore it), so you can also use your own tools on it.
- Available at **3600 dpi**. The infrared pass adds about 55 s per frame, plus about 30 s of
  processing (shown with a progress bar).
- **Doesn't work on traditional black-and-white (silver) film or Kodachrome**, which block
  infrared. OpenOptic detects this and leaves the frame unrepaired. Chromogenic black-and-white
  films (such as Ilford XP2) are dye-based and should work.

The frame shows an **IR** badge in the filmstrip.

## Multi-exposure

**Multi-exposure** scans the frame twice, a normal pass and then a longer exposure, and merges
them for cleaner shadows. It helps most with dense negatives (overexposed film, or stocks like
Kodak Gold), where the scanner has little light to work with.

- **Extended range (linear)**: the right choice for negative converters. Dense areas take the long
  pass's lower noise; highlights come from the normal pass. The TIFF stays linear 16-bit.
- **Exposure fusion (HDR look)**: blends the two passes with evened-out local contrast. It is
  still saved as a negative, ready for your converter, but with an HDR-style tonal look.

**Long pass** sets the second exposure (2×, 3× or 4×; 3× matches SilverFast). At 3600 dpi a frame
with the 3× pass takes about 2 min 55 s; with infrared as well, about 3 min 50 s. The resolution
menu shows the total. The frame shows an **ME** badge in the filmstrip.

## Front buttons

The scanner's two front buttons work while OpenOptic is connected:

- **Top button (A)**: Scan & Save, the same as Space.
- **Bottom button (B)**: Check framing.

Change what each does under **Advanced → Front button A / B** (Scan & Save, Check framing, Stop or
nothing). Presses are ignored while the scanner is busy (unless set to Stop) or while a dialog is
open; the **Log** tab says why.

## Managing your roll

- **The filmstrip is the folder.** The roll list always shows the frames in the roll folder. It
  updates when you change folders or come back to the window. Frames you delete or copy in on disk
  disappear or appear, and the frame numbering continues after the last frame.
- **Select a frame** to see a large preview. **Info ▸** shows its files, checksums and colour
  alignment. **Hide ▾** collapses the panel to give the preview the full height.
- **Delete…** moves all of a frame's files into a `Deleted` sub-folder of the roll. Nothing is
  erased, so you can restore a frame by moving its files back. The frame counter doesn't change;
  set **Number** yourself to reuse a number, or press **Next free number**.
- Frames whose TIFF has gone missing are shown dashed and marked "file missing"; a bar above the
  list tidies them into `Deleted`.

## Inverting your negatives

OpenOptic saves the **raw negative**: linear 16-bit, uninverted, orange mask intact. Invert it in
a dedicated converter:

- **darktable** with the **negadoctor** module (free)
- **Negative Lab Pro** for Adobe Lightroom Classic
- **RawTherapee**'s Film Negative tool (free)

Tip: include a sliver of unexposed film base at the frame edge. Converters use it to neutralise
the orange mask.

The preview in OpenOptic is only a guide. It balances each frame automatically from the picture
itself, varies from frame to frame, and isn't saved in the TIFF. For negadoctor, the preview's
per-channel 0.1 % and 99.9 % levels (`lo`, `hi`) correspond to Dmin = `hi`,
Dmax = `log10(hi/lo)` and an offset from `lo`. Measuring Dmin from the film base is better.

## All options

**Roll** (top of the sidebar)

| Option | What it does |
|---|---|
| File prefix, Number, digits | Frame names: `<prefix><number>.tif`, with 2, 3 or 4 digits. **Next file** shows the next name. |
| Folder | Where frames are saved. **Choose…** opens a folder browser (and your system's folder dialog). |
| Film | Colour/B&W negative or positive (slide). Only changes the preview; the TIFF is the same. |
| Orientation | Rotation stored as a TIFF tag (90° left/right, 180°). |
| Flip horizontally | Mirrors the image; on by default. Turn it off if your frames come out reversed. |
| Multi-exposure, Long pass | See [Multi-exposure](#multi-exposure). |
| Infrared | See [Dust and scratch repair](#dust-and-scratch-repair). |
| Next free number, New roll… | Jump past the last frame; start a new dated roll folder. |

**Output options**

| Option | What it does |
|---|---|
| TIFF | **Aligned RGB 16-bit** (default), **aligned + raw USB** (also the unprocessed sensor data, for analysis) or **raw USB only**. Multi-exposure and infrared need an aligned TIFF. |
| Also save a preview JPEG | A small JPEG of the preview next to the TIFF. |
| Illumination check | Compares each scan's white calibration with the scanner's reference. **Warn** (default) scans anyway and notes it in the record; **wait and retry** waits for the LED to settle and rescans; **off** skips the check. |
| Automatic calibration | Each scan measures analogue gain, offsets and per-column dark/white shading. |

**Advanced**

| Option | What it does |
|---|---|
| Sensor pixels | **Deletion** (default) or **averaging** (experimental; combines neighbouring sensor pixels at 1440 and 3600 dpi). |
| LED warm-up | Seconds to wait after switching the LED on (default 1). |
| Keep the LED on | Keeps the LED lit between frames, switching off after 15 minutes idle. |
| Line doubling | How the scanner's double line rate becomes square pixels: **Lanczos-3** (default, sharpest), **average line pairs** or **keep all lines** (2× height). See [Image processing](#image-processing). |
| Dummy lines | **None** (default, fastest), **one fewer**, or **standard (Plustek timing)**, which is twice as slow. See [Scan speed and dummy lines](#scan-speed-and-dummy-lines). |
| Front button A / B | What each front button does. |

**Diagnostics**: **Home carriage**, **LED on/off**, **Reconnect scanner**, **Monitor buttons
(60 s)** (logs every button event, for scanners whose buttons don't respond), **Save USB trace of
last scan** (for bug reports) and **Dry run** (a simulated scanner that writes real files, to try
naming and folders without hardware).

Every explanation in the sidebar is behind the ⓘ next to its option. Settings are remembered in
your browser and locked while a scan runs.

**Keyboard**: Space = Connect / Scan & Save, P = Check framing, R = show repairs.

**Command line**

| Option | What it does |
|---|---|
| `-out /path` | Parent folder for roll folders (default `~/Pictures/OpenOptic`). |
| `-no-browser` | Don't open a browser; visit the printed address yourself. |
| `-port 47600` | The local port. Keep the default: the browser stores settings and previews per address. |
| `-install-udev` | Linux: let your user open the scanner without sudo, then exit. |
| `-version` | Print the version and exit. |

## Troubleshooting

- **"Scanner not found" or it won't connect**: close SilverFast, VueScan or any other scanning
  software, check the cable, and press **Diagnostics → Reconnect scanner**.
- **Linux: "no permission to open…"**: run `sudo ./openoptic-linux-x64 -install-udev` once and
  re-plug the scanner (or just run it with `sudo`; your files still belong to you).
- **Windows: the page names an unknown driver**: OpenOptic works with Plustek's usual driver
  (`usbscan`) and with WinUSB. Please report the driver name in an
  [issue](https://github.com/bazfp/OpenOptic/issues).
- **"This scanner reports bcdDevice 6.05"**: that's the later 7600i hardware (GL845 chip), which
  isn't supported yet. See the README's supported scanners.
- **Scans fail partway through with a read error or timeout**: the fast default timing needs a
  steady USB connection (use a direct port, not a hub). Set **Advanced → Dummy lines** to
  **one fewer** or **standard**, which halve the data rate.
- **7200 dpi fails or the tab crashes**: close other tabs; a 7200 dpi frame needs about 1.4 GB of
  browser memory.
- **Front buttons don't respond**: check **Advanced → Front button A / B**, and try
  **Diagnostics → Monitor buttons**. With Plustek's Windows driver and on macOS, OpenOptic polls
  the buttons instead of receiving events; that works but only while the scanner is idle.
- **Illumination warnings**: the LED hadn't settled. Raise **LED warm-up** or turn on **Keep the
  LED on**.

---

# Technical details

## Output files

Each frame writes, into the roll folder:

- `<name>.tif`: linear 16-bit RGB, or RGBI with the infrared channel (`ExtraSamples` =
  unspecified, the same layout as SilverFast's 64-bit HDRi files). Photoshop shows the fourth
  channel as an extra channel. The TIFF carries the X/Y resolution and orientation tags.
- `<name>.json`: the frame's record. It holds the scan settings, the scanner registers actually
  used, timing, illumination check, channel alignment, line doubling, black-level correction, and
  the multi-exposure and infrared results (including a small mask of what was repaired, used by
  **Show repairs**). It also holds SHA-256 checksums of the files.
- `<prefix>_roll.json`: a summary of every frame in the roll.
- Optionally `<name>_preview.jpg`, `<name>_raw.tif` (raw USB data) and `<name>_usbtrace.json`.

**Raw USB TIFFs** hold the sensor data exactly as delivered: unaligned colour lines, double line
rate, never flipped. They are for analysis, not editing.

**Frame previews**: selecting a frame shows a 2,400 px preview, box-filtered from the full TIFF by
the helper. Previews are cached in the browser (IndexedDB, per helper address), so they survive
page reloads; the filmstrip keeps 240 px thumbnails.

**How the preview is rendered**: per channel, ignoring a 2 % margin, the 0.1 % and 99.9 % levels
(`lo`, `hi`) are taken from the frame. Negatives are shown as `log(hi/v) / log(hi/lo)` with a 1/1.4
gamma, slides as a linear stretch with a 1/2.2 gamma. The scanner-side calibration (hardware
shading, black-level correction, analogue gains) is already in the TIFF values.

## Image processing

All processing runs in the browser after the scan.

**Colour alignment.** The sensor's red, green and blue lines sit at different positions, so each
colour arrives a fixed number of lines apart (nominally 0, 24 and 48 lines at 3600 dpi). OpenOptic
measures the actual offsets in every frame to sub-pixel precision and falls back to calibrated
values for low-contrast frames. The record stores them under `processing.channelShiftLines`.

**Line doubling.** The scanner samples twice as many lines as columns (the carriage steps half as
far per line as the sensor's column spacing).

- **Lanczos-3** (default): each colour channel is resampled once, straight from the raw lines,
  with a Lanczos-3 kernel stretched 2× (12 taps). Colour alignment, 7200 dpi stagger and line
  reduction happen in one step. Compared with averaging line pairs it keeps similar detail up to
  about 0.8 of the output Nyquist, has about a third of the worst-case aliasing (harsh grain),
  slightly less noise, and gives all three channels the same sharpness. Negative kernel lobes can
  leave a faint halo on very hard edges; values are clamped to 0–65535. Extra processing: about
  0.5 s at 3600 dpi, 3 s at 7200 dpi.
- **Average line pairs**: each output row is the mean of two raw lines, after linear-interpolated
  colour alignment.
- **Keep all lines**: every line, with separate X/Y dpi tags; most software displays it stretched.

Recorded under `processing.verticalAveraging` and `processing.interpolation`, and per TIFF as
`lineFilter`.

**7200 dpi stagger correction.** At 7200 dpi the sensor's even columns read eight raw lines (at
14,400 lines/inch) ahead of its odd columns, four output rows at 7200 dpi. This is corrected
automatically, together with colour alignment, and the unsupported final eight raw lines are
trimmed: with nominal shifts the TIFF is 10,248 × 7,009 instead of 10,248 × 7,013. Recorded under
`processing.columnStagger`.

**Black level and highlights.** Each scan measures per-column dark and white references and
uploads fresh shading coefficients to the scanner. No additional global black offset is subtracted.

**Horizontal flip.** Applied after alignment and stagger correction (which follow the sensor's
native column order) and before the orientation tag. Recorded under
`processing.horizontalMirror`.

**Sensor pixel averaging** (experimental) sets GL843 register 0x03 bit 6 on every write of the
scan, including the calibration reads and framing previews. Shading is recomputed from those
reads; illumination checks still compare against deletion-mode references. No
image-quality improvement has been verified on hardware. At 7200 dpi there's nothing to average.

**Film stocks.** Scanning isn't stock-specific: calibration is read through the holder, not the
film, and matched across Lucky 200 and Kodak Gold 200 within 2 %. Kodak Gold is denser (blue median
4 % of full scale against Lucky's 8 %), so it benefits more from multi-exposure.

## Scan speed and dummy lines

At 3600 and 7200 dpi Plustek's standard timing sets the GL843's LINESEL to 1 and 2: after every
real CCD line the sensor clocks out 1 or 2 unused "dummy" lines. The datasheet gives their purpose
only as resolving the "start/stop (discontinuous) problem", that is restarts after the scanner's
buffer fills. OpenOptic drops them by default, as SANE does:

| Setting | 3600 dpi | 7200 dpi | Data rate needed |
|---|---|---|---|
| None (default) | 40 s (0) | 79 s (0) | 5.49 / 10.98 MB/s |
| One fewer | 40 s (0) | 2 min 38 s (1) | 5.49 / 5.49 MB/s |
| Standard (Plustek timing) | 79 s (1 dummy line) | 3 min 57 s (2) | 2.75 / 3.66 MB/s |

Only the main scan changes. LINESEL is written in its start write, and the motor tables' cruise
period is scaled by the same factor (14000 to 7000 at 3600 dpi; 42000 to 28000 or 14000 at 7200
dpi), so the carriage still moves the same number of steps per line. Line spacing, image size,
colour offsets, LINCNT, exposure (LPERIOD), the calibration frames and the shading tables are
unchanged. White references read with 1, 2 and 5 dummy lines came out at the same level, so dummy
lines don't lengthen the exposure.

The costs of dropping them: each line is exposed while the carriage moves 2 or 3 times further, so
vertical detail is slightly softer (closer to SANE's default); the browser must sustain the higher
data rate or the scan stops; and a restart after the buffer fills may leave a visible band.
Recorded under `acquisition.options.dummyLines` and `acquisition.scanTiming`.

## How multi-exposure works

The frame is always scanned exactly twice, as SilverFast does. The second pass lengthens the line
period ×2, ×3 or ×4 with no dummy lines, and scales the motor cruise so the line spacing stays the
same. Calibration stays at 1×. The ×3 pass uses the same register settings as SilverFast's own
multi-exposure pass. With dummy lines off, a k× pass takes k × 40 s (2× 79 s, 3× 119 s, 4× 158 s),
plus about 15 s to recalibrate and reposition.

**Extended range.** The long pass is registered to the normal pass to sub-pixel precision and
fitted per channel as `long = slope·short + offset`. On Kodak Gold the slopes were 3.06–3.12 and
the offsets 660–2,040 counts; the offsets are fitted from the image, because the dark frame
overestimates the image black. The two passes are blended by inverse variance, using a noise model
from the calibration frames. The long pass fades out at 90–98 % of full scale, so clipped samples
(such as the orange mask's red channel on Lucky film) come from the normal pass only. Output stays
linear 16-bit at the normal pass's scale. On Kodak Gold, shadow noise drops by about a quarter in
red and green and nearly half in blue.

**Exposure fusion.** The two passes are merged Mertens-style (contrast, saturation and
well-exposedness weights, Laplacian-pyramid blend) **as negatives**: no inversion and no
per-channel levels, so the orange mask and the scanner's colour balance pass through. The blend
runs on gamma-encoded values and is decoded back to linear 16-bit (black 0); clipped long-pass
samples are left out. Dense areas take more of the long pass, so overall contrast is compressed
while local detail is kept.

Recorded under `processing.multiExposure`.

## How dust and scratch repair works

The infrared pass is a complete third sequence with the white LED off and the infrared LED on (via
GPIO27), the same lamp setup as SilverFast's iSRD. Processing:

1. **Registration**: the infrared pass lands 1–2.5 lines off, so it is registered on the defects
   themselves.
2. **Cleanup**: the faint cyan-dye ghost (log IR ≈ 0.06·log R) is removed, a transmission map is
   built, and the film holder is excluded.
3. **Detection** by hysteresis against the scan's own infrared noise: seeds 5σ below the clean
   level, grown through neighbours 2.5σ below it. Hairline scratches at 92–95 % infrared
   transmission are found along their whole length.
4. **Repair**:
   - Marks that don't show in the colour image are left alone, for example dust off the film
     plane or rings from out-of-focus specks (typically a quarter of what the infrared sees).
     Visibility is measured with a morphological closing, so a strong edge such as the frame
     border never counts as a defect.
   - Only the visibly damaged pixels of each defect are filled (the whole footprint for broad
     smudges), by exemplar (patch-based) inpainting from nearby film texture, which keeps the
     grain. Thin defects are filled however long they are.
   - Very large broad smudges are divided by their infrared transmission^γ instead.

On Kodak Gold 200 and Lucky 200 scans this repaired about 480 and 340 defects, with the repaired
areas' residual contrast within the grain for 92–98 % of them. Detection takes about 23 s per
3600 dpi frame and repair about 10 s. Recorded under `processing.infrared`, including the
preview-size overlay mask used by **Show repairs**.

## Scanner events and the positioning stop

While connected, the page listens on the scanner's interrupt endpoint (0x83) and logs every event
in the **Log** tab (`scanner event 0x..`).

- **Positioning stop.** The first positioning move ends when the frame holder reaches the position
  sensor, which the scanner reports as event `0x08` (GPIO4). The scan stops that move on the event
  itself, accepting it only after half the expected travel time (about 2.56 s). If no event
  arrives by 150 ms after the expected moment, it stops by timer and logs it. Recorded under
  `acquisition.positioningStop`.
- **Front buttons** report on the same endpoint: button A as GPIO3 (event `0x04`) and button B as
  GPIO2 (event `0x02`).
- **Polling fallback.** If the event endpoint errors, the page keeps retrying, and while the
  scanner is idle it also polls the GPIO inputs (register 0x6D), so presses still work. A press seen
  both ways acts once; polling pauses during every operation.
- **Backend support.** Linux (usbfs) and Windows with WinUSB read the interrupt endpoint. Windows
  with Plustek's `usbscan` driver and macOS report it as unavailable, so they use the timed
  positioning stop and button polling.
- **Button monitor.** **Diagnostics → Monitor buttons** logs every event and every change of GPIO
  registers 0x6C/0x6D for 60 s, then writes a `BUTTON MONITOR RESULT` line.

On Windows the helper prints which driver Windows has bound to the scanner: `usbscan` (Microsoft's
still-image driver, which Plustek's package installs) and WinUSB both work; any other driver has no
documented way for other programs to reach the scanner.

## How it works

A single executable runs a small local web server, talks to the scanner over USB with the operating
system's own interface, and serves the scanning page to your browser. No driver, SANE or SilverFast
installation is needed. All image processing (alignment, multi-exposure, infrared repair, previews)
runs in the page; the Go helper only does USB and file access.

Each resolution has a fixed scan profile (`capture_profiles.js`): the GL843 register settings,
analogue front-end gains and offsets, motor tables and hardware shading for that mode, validated
on a 7600i v1. Every scan recomputes analogue gains, offsets and hardware shading from its
probe reads. White reads are also compared with the profile's illumination references. On top of the
profiles the app can drop CCD dummy lines, lengthen the exposure and run the infrared pass. Every
register-level detail is documented in [PROTOCOL.md](PROTOCOL.md).

| Document | Contents |
|---|---|
| [PROTOCOL.md](PROTOCOL.md) | The scanner's USB protocol: transfers, registers, status bits, tables, geometry and timing, scan sequence, motor, events |
| [DESIGN_MULTIEXPOSURE_AND_IR.md](DESIGN_MULTIEXPOSURE_AND_IR.md) | Design and validation of multi-exposure and infrared repair |
| [CAPTURE_FINDINGS_COLOUR_ME_IR.md](CAPTURE_FINDINGS_COLOUR_ME_IR.md) | Colour-film, multi-exposure and infrared measurements |
| [CAPTURE_VALIDATION.md](CAPTURE_VALIDATION.md) | How the scan profiles were derived and validated (with `tools/build_capture_profiles.py`) |
| [CHANGES_AND_FINDINGS.md](CHANGES_AND_FINDINGS.md) | Development log |

## Building and testing

Requires **Go 1.24** or newer and, for the tests, **Node.js 20** or newer.

```sh
make build        # ./openoptic for this system
make dist         # all six release binaries into dist/ (same as ./build.sh)
make test         # Go tests and the JavaScript test suite
```

The only third-party Go module is `github.com/ebitengine/purego`, which lets the macOS build call
IOKit without a C compiler. The helper embeds `ui.html` and the JavaScript files at build time.
Opening `ui.html` straight from disk also works for a dry run without the helper.

To try it without a scanner, run the helper and use **Diagnostics → Dry run**; frames are
synthesised and written as real files.

OpenOptic is [MIT-licensed](../LICENSE). The GL843 register semantics come from the Genesys Logic
datasheet.
