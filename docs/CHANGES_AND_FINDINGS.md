# OpticFilm 7600i v1 — changes, discoveries and raw TIFF export

## Fix: alternating-column wobble in 7200 dpi capture scans

The main capture pipeline had `stagger: []`, despite the SANE 7500i/7600i-v1
sensor table's `StaggerConfig{4,0}` at 7200 dpi. In the supplied test07 TIFF,
adjacent even/odd vertical-gradient correlation independently peaks at a four-row
offset in three image regions and all three channels. At the profile's 14400 lpi
wire sampling this requires native-column source offsets [8,0].

Geometry now reserves eight additional raw lines for this correction. Decode,
aligned TIFF export (including in-place conversion) and preview sampling all
apply the column offset before reducing resolution. Native source-column parity
is used, before any TIFF orientation. This convention is validated for the fixed
captured 7200 window (STRPIXEL 210); arbitrary windows are not supported here.
RGB delay measurement compares channels at the same columns and remains unchanged.

Raw exports retain every original image byte. Sidecars record the correction and
trim count. Lower-resolution profiles and hardware commands remain unchanged.
Nominal square-pixel output is 10248 × 7009. Tests cover sharp-edge restoration,
RGB fractional delays, both export allocation modes, source parity in downsampled
previews, and the actual roll export/metadata path. Raw TIFF, saturation and runtime
replay regressions also pass. No native binaries were built; a new hardware scan
has not been performed in this environment.

## Fix: magenta highlights and purple/green preview (test07)

Confirmed host-side overflow, not an averaging change: test07 used deletion/1×.
The sidecar records black corrections R +23.7, G -19.9, B +58 counts. Subtracting
-19.9 from saturated green yields 65554.9, rounded to 65555. The old code clamped
only the lower bound, so Uint16Array storage wrapped that to **19**, turning
white TIFF samples into approximately (65511, 19, 65477). The same bug affected
preview planes and their per-channel percentile/density mapping.

`alignedFrame()` and `previewPlanes()` now clamp to [0,65535] before typed-array
assignment. No scanner registers, calibration, timing or default settings change.
`tests/saturation.test.cjs` covers both bounds, positive/negative offsets, the
actual test07 correction, fractional alignment, and separate/in-place outputs.

Evidence and recovery:
- The trace comparison matched 1821/1821 recorded control/table-length operations,
  with additional readiness polls/preflight/home wait. Bulk-OUT payload bytes are
  not included in this application's trace, so their content cannot be checked
  from that JSON alone.
- The TIFF SHA-256 matches its sidecar. There are exactly 1,581,367 green samples
  below 20. Corrected nonnegative source values plus 19.9 cannot legitimately
  produce those values; they identify the overflow and can be saturated to 65535.
- A one-off repair script (since removed) produced test07-repaired.tif and a matching JSON
  with a new checksum and recovery provenance. Full-image comparison confirmed
  every red/blue sample and every other green sample stayed identical. The TIFF
  header/tags, orientation and dimensions are retained. This restores the result
  of proper saturation; it cannot recover detail already clipped by the scanner.
- The regenerated PNG uses the app's negative rendering on a sampled, repaired
  aligned TIFF, with orientation 3 applied. It is not a byte-for-byte recreation
  of the original raw-data preview. Visual review shows the magenta/green failure
  is gone. No creative colour correction or grayscale conversion was applied.

Validation: saturation regression and the roll workflow/sidecar tests pass. Native
binaries were not rebuilt; physical scanner testing was not available. The fix
covers all resolutions, although the observed failure is this 7200 dpi scan.

## Update: configurable sensor averaging; staged exposure settings

The main roll page now exposes sensor pixel deletion/averaging and exposure
multipliers. Defaults are deletion and recorded exposure (1×), preserving the
original wire sequence. Averaging modifies only AVEENB (0x03 bit 6) in a temporary
profile, including calibration reads; recorded profiles and timing stay intact.
Sidecars contain applied settings and effective register values. Live checks
remain comparisons against recorded deletion-mode calibration, not recalibration.

Longer-exposure selections are persisted but explicitly blocked before USB access,
including the error handler's usual stop command. Fresh calibration and coordinated
motor timing are deferred. No long-exposure acquisition is implemented or claimed.
See USER_GUIDE.md for usage and limitations. The options are locked during a scan and
the scan uses a settings snapshot. Existing 7200 dpi sequencing fixes are retained.

Validation: configuration tests for all three profiles, headless page acquisition
and error-handler tests, runtime replay tests, and roll/sidecar tests. A full browser
run was unavailable (no Chromium executable installed). No native executable was
built, and no physical scanner testing was possible.

## Fix: 7200 dpi teardown was replayed after only 53.7% of the image

The profile builder counted 465,941,396 captured main-image bytes against the USB
header's 868,333,536 bytes. It appended the missing 402,392,140-byte read to the
**end of the entire profile**, after completion polling, lamp-off (0x03=0xAF),
SCAN clear (0x01=0x22), and the rest of teardown. Correct totals hid incorrect order.

The PCAP enhanced-packet headers identify the loss precisely: 5,296 packets have
captured/original lengths 65,535/122,395, and 1,765 have 65,535/122,907. The
truncated tails total exactly 402,392,140 bytes. This is per-packet capture
truncation, not evidence that the scanner or USB link dropped image data.

This predicts the supplied log: 465,941,396 / 3,660,000 = 127.306 seconds;
180.51 - 53.15 = 127.36 seconds. The "image transferred" message was for the first
read operation, not the complete image. Bandwidth starvation is not established by
this log. The exact mechanical source of the changed noise remains unverified.

Changes:
- The builder extends the original main read to the full header length. It rejects
  ambiguous truncated captures with multiple/no main read spans.
- The bundled 7200 profile was rebuilt from the attached official capture. Its SHA
  matches the recorded source. All metadata, register commands, tables and timing
  are unchanged; only the missing read bytes move before completion/teardown.
- Runtime validates frame budgets and rejects premature completion/scan/lamp-off
  before USB access. The transfer-complete log requires the full frame.
- Replay and independent capture verification now check drain-before-completion,
  not just total byte counts and control command order. Regression cases cover
  completion polling, SCAN clear and lamp-off with an incomplete frame.
- Misleading runtime claims that slow USB necessarily causes carriage overrun were
  corrected to buffer-full backtracking (GL843 datasheet, register 0x02 and MAXWD).

Expected main image acquisition is about 237.25 seconds (3 min 57 s), plus setup
and parking. With the supplied log's setup timing, the complete image would be
near elapsed 290.4 s, not 180.5 s. Hardware validation is still required. No native executable was built (Go is not
installed in this environment).

Validation passed:
- `node tests/capture_runtime.test.cjs` (all three profiles and regression cases).
- `node tests/simulated_scanner.test.cjs` (all three profiles).
- `python3 tests/verify_captures.py --profile full7200 <attached capture>`.
- Rebuilding the 7200 profile from the actual capture yields exactly the intended
  read-placement change; all other profile fields remain identical.
- The original broken 7200 profile is rejected before any USB access.

The historical bandwidth diagnosis below is superseded by this sequencing finding.

## Update: GL843 datasheet, and the 7200 dpi scan stalling

### What the datasheet settled
The uploaded GL843 datasheet (Genesys Logic, rev 1.02) confirmed most of the reverse-engineered
register map and corrected several inferences. `PROTOCOL.md` is updated throughout, with the
datasheet's own bit names, and the remaining guesses still marked as guesses.

- **LINESEL (0x1E low nibble) is the CCD dummy-line count**, so a delivered line takes LINESEL+1
  line periods: 1, 2, 3 at 1440/3600/7200 dpi. That matches the captures exactly (15.8 s, 79.0 s,
  237.2 s) and corrects the duration I had for 7200 dpi (I had written ~158 s).
- **Motor steps per line = (LINESEL+1) × LPERIOD / scan-table cruise** = 5, 2, 1. All three
  resolutions travel the same 24.9 mm, so the carriage motion was never the problem.
- **ACDCDIS (0x02 bit 6) is 0 in every capture, which *enables* backtracking**, and MAXWD
  (0x35–0x37) sets the buffer-full threshold: "If available buffer size < MAXWD, then buffer full
  state will be set. The scanner execute backtracking." A host that cannot keep up makes the
  carriage reverse and re-scan repeatedly — which is the noise you heard.
- **The four slope tables are all uploaded**: fast moves use FMOVNO with the datasheet's "table
  four" (the 0x58000 upload), so my "home table that is never uploaded" was wrong. The homing code
  no longer writes to 0x60000, which is RAM of unknown purpose.
- **Register 0x03** is LAMPDOG / AVEENB / **XPASEL (transparency lamp, set for every scan)** /
  LAMPPWR / LAMPTIM; **0x9D holds STEPTIM**, which multiplies all motor step counts by 2×STEPTIM;
  0x21–0x24 are STEPNO, FWDSTEP, BWDSTEP, FASTNO; 0x42–0x47 are VALIDWORD; 0x1F is SCANFED.
- The control-transfer `wValue` codes (0x82, 0x83, 0x84, 0x8C, 0x8E) are a firmware command set,
  **not** the chip registers of the same number.

### The 7200 dpi problem
A delivered line at 7200 dpi takes 16.8 ms and is 61,488 bytes, so the host must sustain
**3.66 MB/s**, against 2.75 at 3600 dpi and 2.20 at 1440. Below that the buffer fills and the
scanner backtracks, over and over.

The app was asking for **60 KB at a time with nothing else in flight**, so every transfer paid a
full round trip through the helper before the next one started. Fixes:

- **256 KB per transfer** (the helper already allows 1 MB).
- **One transfer always in flight**: the next read is issued before the previous block is copied.
- **Pacing watchdog**: profiles now carry the required rate (`profile.scan.bytesPerSecond`,
  computed from LINESEL, LPERIOD and the line length). If the sustained rate falls below 90% of it
  after a six-second grace period, the scan is stopped with a plain message instead of letting the
  scanner thrash. Every scan logs its achieved rate.

**Not verified on hardware.** Whether your machine can sustain 3.66 MB/s through the helper is the
open question; if it cannot, you now get "the scan data is arriving at X MB/s but this resolution
needs 3.66 MB/s" within seconds instead of a stalling carriage. The log line "image transferred at
X MB/s" on a successful 3600 dpi scan is a good predictor: it needs to reach 3.66 for 7200 dpi.

### Tests
- Required rates and durations are derived per profile and match all three captures to 0.1 s.
- A simulated host at half the required rate is stopped 12.8 s in; a host slightly above it
  completes, with a read always in flight.
- The simulated scanner now delivers at each profile's true pace, and all three profiles replay
  with the correct timed move-1 stop.
- Homing still parks within 5 steps from every starting state with the single-table upload.

## Update: Linux access without editing udev rules, and a protocol document

### Linux access
The scanner's USB node is root-owned by default, so the helper could not open it without a udev
rule. Three ways now, none of which needs hand-editing files:

- `sudo ./openoptic-linux-x64 -install-udev` writes `/etc/udev/rules.d/70-openoptic.rules`, reloads
  udev and tells you to re-plug. Run without root, it prints the exact command instead.
- `sudo ./openoptic-linux-x64` just works, with nothing installed. Files and folders the helper
  creates while running under sudo are handed back to the invoking user (`SUDO_UID`/`SUDO_GID`), so
  scans are not left owned by root.
- Installing sane-backends is often enough on its own: its scanner rules usually cover this device.

A permission failure now prints all three options, and says when `70-openoptic.rules` or sane's
rules are already present (in which case re-plugging is what is missing).

`files_test.go` covers the ownership helper being inert when not running as root; the installer was
exercised both as root (writes the rule, reports missing `udevadm` clearly) and as an unprivileged
user (prints the sudo command).

### `PROTOCOL.md`
Everything the captures show about the scanner, in one document: transport and the control-transfer
vocabulary, the register-access protocol including the read address auto-increment, status bits,
a register map with the values seen in each capture, slope and shading table uploads with their RAM
addressing, the analogue front end and the vendor's calibration search, geometry and timing
formulas, the eight-frame scan sequence, motor behaviour including the timed stop and homing, the
consequences for anyone replaying the captures, and a list of what is still unknown.

Facts are separated from inference: every inferred item is marked, register names are flagged as
SANE conventions rather than vendor names, and the unknown parts (registers 0x60–0x66, the
interrupt endpoint, register 0x40's bits, the infrared LED) are listed as unknown. The tables were
generated from the three profiles rather than written from memory, and two claims I had drafted
from expectation were corrected against the data: the 7200 dpi capture uses different AFE gains
(0x23/0x1B/0x22), and the shading upload inherits its RAM address from the preceding slope upload
instead of setting one.

## Update: 7200 dpi scan profile

Built from `7200ppifullframehdr.pcapng` and selectable in the page as **maximum (7200 dpi)**.

| | prescan | full 3600 | **full 7200** |
|---|---:|---:|---:|
| DPISET / LINESEL | 240 / 0 | 600 / 1 | **1200 / 2** |
| Delivered | 2050 × 2824 | 5124 × 7058 | **10248 × 14122** |
| Sampling | 1440 × 2880 | 3600 × 7200 | **7200 × 14400** |
| On the wire | 33 MB | 207 MB | **828 MB** |
| Aligned square-pixel TIFF | 2050 × 1402, 16 MB | 5124 × 3505, 103 MB | **10248 × 7013, 411 MB** |
| LINCNT | 5648 | 14116 | **28244** |
| Shading upload | 24,984 B | 62,464 B | **124,928 B** (two transfers) |
| Positioning moves | 19490, 13228 | 19490, 13228 | **19490, 13228** (same frame) |
| Move-1 timed stop | 2571.9 ms | 2559.7 ms | **2571.8 ms** |
| Main read | ~16 s | ~79 s | **~160 s** |
| Measured channel delays | 9.84 / 19.30 | 24.22 / 48.21 | nominal **48 / 96**, measured per scan |

Same frame window and same calibration structure as the 3600 dpi scan; only the sampling changes.

**The capture is missing image data.** USBPcap dropped 402,392,140 B (46%) of the main frame at this data rate. The control stream is complete, which is what the profile replays, so the profile is sound; the picture cannot be reconstructed from that file. The builder now records the shortfall as `captureTruncatedBytes`, turns it into one more read operation, and **requires the calibration frames to be complete** (they are: they supply the illumination and black-level reference, which agrees with the other two sessions: white line 29347/40116/34524, dark 980/1100/1143).

**Memory.** A 7200 dpi frame is 828 MB raw plus a 411 MB result. `alignedFrame()` can now write its output into the source buffer when the output is smaller (averaged square pixels) and the raw TIFF is not also being saved. The write pointer never overtakes the read pointer, so the result is identical, verified bit for bit on real data and in a unit test. That keeps the peak around 1.3 GB instead of 1.7 GB. The page states the requirement in the option text, and the conversion is now done once and reused if a save has to be retried.

**Tests.** The new profile passes everything the others do: op-by-op replay with the recorded responses, geometry (10248 × 14122 → 14026 aligned lines), the timed move-1 stop at 2571.8 ms on the simulated scanner, illumination and black-level checks, and `verify_captures.py` against the capture (which reports the dropped bytes).

**Not tested:** an actual 7200 dpi scan, including whether the browser holds 1.3 GB on your machine and whether the USB transfer sustains the rate for ~3 minutes. `tools/reconstruct_capture.py` refuses this capture with an explanation, and `compare_frame.py` still expects the 3600 dpi capture as its reference.

## Update: illumination and black-level checks (prescan colour cast and wavy banding)

### Correction to the previous note
The 7600i is LED-lit, not a cold-cathode lamp. An LED settles immediately, so "lamp warm-up" does not explain the prescan cast, and waiting for it is the wrong default. The check below stays, because it still measures the light and the analogue front end, but it now **warns by default** instead of waiting, and the wording says LED.

### What is not the cause
- **The app's processing.** The official prescan data, through the app's alignment, TIFF and preview pipeline, is neutral (mean R/G/B 108/105/107) with no banding beyond picture content.
- **The new homing.** The prescan sequence rewrites every register it touches, and table slot 4 held the same curve before.

### The likely mechanism: replayed black level
The app replays the vendor's per-channel AFE settings rather than calibrating. Gains are the same in both recordings (35/26/35), but the **offsets differ per session**: prescan **30/47/23**, full scan **32/49/29**. Those offsets set each channel's black point for the vendor's unit at that moment. On another unit, or at another temperature, each channel's black point is off by the difference, which is a colour cast, and the error differs between prescan and full scan because the recorded offsets differ.

Every sequence reads a **dark frame with the LED off** just before the scan, so the difference is directly measurable: the recorded references are R/G/B 990/1060/1122 (prescan) and 978/1071/1237 (full).

### Changes
- **Profiles** carry references (statistics only) for three calibration reads: the white line, the dark frame, and the white shading frame. Recorded operations are unchanged.
- **Black-level check and correction.** The dark frame is measured on every scan and compared with the reference. Differences beyond 40 counts are reported, and with *correct black level* on (the default) the measured per-channel difference is subtracted from the image and recorded in the sidecar under `processing.blackLevelCorrection`. With the option off, a mismatch is a warning instead.
- **Illumination check.** The two white reads are compared with the reference: level ±10%, colour balance ±5%, line-to-line ripple ≤0.6%. Both official sessions pass against each other's reference. Default *warn*; *wait and retry* and *off* are also available.
- **Every scan** logs both measurements and stores them in the sidecar. Warnings appear in the status line and the roll record.

### Tests
- **Runtime:** the hook receives all three calibration frames complete; a simulated unit with a black level 5/62/−3 counts high is measured as 5/62/−3, a small difference passes, and aborting stops before the main scan.
- **Correction:** on official data, a synthetic +60-count error on green shifts the preview, and the correction restores the original values exactly.
- **Roll pipeline:** the measured difference is subtracted from the saved TIFF (verified pixel by pixel) and recorded in the sidecar; with the option off, neither happens.
- **Real page:** a dry run with illumination out of range warns, or with *wait and retry* selected, waits, retries and then saves.
- **Still unconfirmed:** that this explains your prescans. The next prescan's log lines ("black level …" and "illumination check …") and the sidecar will show it. If both are within tolerance and the prescan is still green and wavy, the cause is elsewhere; send the prescan TIFF, its sidecar and the USB trace.

## Update: homing rebuilt from the recorded motor primitives

### What the captures show
No capture contains a complete homing. Both recordings end while the chip's automatic return (0x02 = 0x30) is still under way, with status 0xA1 and HOME not yet set. They do show what that return, and every recorded move, runs with:

- **Fast curve:** reloaded into table 3 just before each scan (64102 … 625, cruise **4,000 steps/s**).
- **Move registers:** the official software's own set for moves: `0x02 = 0x18`, LPERIOD `0x36B0`, `0x1C = 0x20`, `0x10`–`0x15 = 0`, `0x6A = 0xFF`, and for a short feed `0x6A = 0x46`.
- **Stopping:** `0x02 = 0x08`, then `FEEDL = 1`.
- **Park position:** at the sensor edge. At the start of every recording, one short feed forward clears HOME.

### What was wrong with the app's homing
The previous `home()` was a SANE-derived guess:

- It ran on the **slow** curve (20325 … 2604, 960 steps/s): four times slower than the official return.
- It used `0x02 = 0xB4`.
- It polled only every 100 ms and stopped by cutting motor power, so it overshot into the sensor zone by a variable amount.
- If the carriage was already on the sensor, it did nothing, however deep inside the zone it was.
- It never stopped a motor still running after a failed scan before writing new tables and registers.

After a failure, the next scan therefore started from an unknown position, until the official software re-homed the carriage.

### New homing (`motion.js`)
1. **Stop** anything still running, the official way (`0x01` SCAN off, `0x02 = 0x08`, `FEEDL = 1`), and wait for the motor to go idle.
2. **Return fast** unless already on the sensor: reverse (`0x02` bit `0x04`), fast curve, the official move registers, stopped the moment HOME appears.
3. **Leave the sensor** 600 steps forward: fast curve with the short-feed acceleration, repeated if needed.
4. **Approach slowly** in reverse on the slow curve, stopping the instant HOME trips.

The carriage ends at the sensor edge having arrived in reverse, the same state the official automatic return leaves. Every table and register value comes from the recording; none are made up.

**When it runs.** A full homing runs on connect and before any scan whose previous state is not a completed scan: after a failure, a stop, or a manual Home. After a normal scan, the chip's own return is trusted, exactly as in the official sequence.

### Verification (`tests/motion.test.cjs`)
The simulated carriage has a home sensor edge, end stops, motion timed from the uploaded curve, deceleration on a stop request, and USB latency. Homing is run from five starting states:

- at the sensor edge
- deep in the home zone
- 45,000 steps out
- just outside the sensor
- still running a feed with SCAN on

All five park within **5 steps (0.009 mm)** of each other, just inside the sensor edge. None exceeds 4,000 steps/s, and none writes into a moving motor. A sensor that never trips gives an error with the motor stopped.

The model's stopping distance is an assumption. The property the test checks is that the result does not depend on where the carriage started.

On the scanner: after a failed scan, press **Home carriage** (Diagnostics) or just start the next scan. `compare_frame.py` on the following full scan should read about 0 mm along the travel, as after a normal scan.

## Update: scan window 2.1 mm early, then a hang — the first positioning move is a *timed* move (root cause, fixed)

### What the official software does
The first positioning move is started with FEEDL 19,490 on the slow motor table. Run to completion, that move takes about 20.5 s (table model; the app's run of it took about 25 s including polling). The official software does not let it finish. It **stops it a fixed time after starting it**, by writing `0x02 = 0x08` and then `FEEDL = 1`. The stop comes **2.5719 s** after the start write in `prescan.pcapng` and **2.5597 s** in `3600ppifullframehdr.pcapng`, 12 ms apart. Where the carriage ends up, and so where the frame sits in the scan window, is set by that moment. Move 2 (13,228 steps) is then run to completion.

### What went wrong
- **Release before last:** the profile builder stored the 2.57 s pause as an ordinary delay capped at 1 s. The app stopped move 1 at about +1.23 s, and every scan started early. On the table model, the steps covered between 1.23 s and 2.57 s come to 1,277 quarter-steps = **2.25 mm**, against the measured 2.12 mm (`tools/compare_frame.py` on `test02.tif`).
- **Last release:** I misread the pause as waiting for the move to finish and made the runtime wait for FEEDFSH. The move then ran its full course (965 extra polls, about 25 s in the log) and the carriage overshot to the end of its travel, so the prescan appeared stuck. That diagnosis was wrong, and so is the "register write while a move runs" check it added. Both are removed.

### Fix
- **`build_capture_profiles.py`:** the pause after a positioning-move start that ends in a register write with no status read in between is now stored exactly and marked `timedStop`: 2571.9 ms (prescan) and 2559.7 ms (full). It was the only such pause, and nothing else in the profiles changed.
- **`CaptureRuntime.run`:** `timedStop` pauses are timed from the moment the move's start write completed, not from the previous operation. The final sleeps are short (at most 20 ms, then the remainder), so the stop lands within a few milliseconds of the recorded moment. That is about 0.03 mm at that point of the move. No extra USB traffic.

### Verification
- **`tests/simulated_scanner.test.cjs`:** now runs the simulated scanner on a virtual clock. Move 1 lasts about 20.5 s unless stopped, and move 2 takes 3.44 s. The test fails a runtime that stops move 1 more than 25 ms away from the official moment, or never stops it.
  - The 1 s-cap release fails: stopped at +1000 ms.
  - The last release fails: never stopped, carriage runs its full travel.
  - The fixed runtime passes both profiles.
- **`tests/capture_runtime.test.cjs`:** checks, on a virtual clock, that the stop write goes out at +2571.9 ms (prescan) and +2559.7 ms (full), and that every recorded operation follows in order.
- **`tools/compare_trace.py`:** compares each timed stop with the capture, with a tolerance of 50 ms.
  - `test02_usbtrace.json`: "positioning move 1 stopped at +1.233 s; the vendor stops it at +2.572 s".
  - Fixed-runtime traces: OK for both profiles.
- **On the scanner:** a prescan should complete normally, the saved trace should pass `compare_trace.py`, and `compare_frame.py` on a full scan should report about 0 mm along the travel.

## Update: preview tone curve, folder chooser, controls, warm-up

### "Bottom of the frame missing" — corrected diagnosis (supersedes the earlier holder explanation)

The earlier version of this section blamed the film holder position and added an "off-centre" warning. **That was wrong and the warning has been removed.**

What trace `1790069194844_Roll001_01_usbtrace.json` and the official full-frame capture show:

- ~~Nothing is cropped anywhere in acquisition.~~ **Corrected above:** the commands matched, but the app interrupted the first positioning move, so the window started 2.1 mm early.
- **Nothing is cropped in saving.** Running the official software's own full-frame data through the app's save path gives a TIFF with all 5124 columns and 7008 of 7058 lines. The 50 missing lines are the channel-alignment margin plus the averaging remainder, 0.17 mm.
- **What looked missing was a bright subject rendered as blank white.** The dark band at the start of the sensor line is not the holder. It is the white fluffy blanket in the foreground, so dense on the negative that it is almost as dark as opaque material. Its edge is ragged in close-up. The frame's real straight edge is at the far end of the window.
  - The old preview inverted the negative **linearly**, which mapped this whole band (about 20% of the frame) to flat paper-white, so it read as cut off.
  - Film density is logarithmic, and the official software uses a film curve.

**Fix.** `CaptureRuntime.renderPreview()` inverts negatives by optical density: D = log10(base/T), normalised per channel between the film base (99.9th percentile of transmission) and the densest area (0.1th percentile), with gamma 1/1.4. This also removes the orange mask. Slides get linear levels with gamma 1/2.2.

On the official data, blown-to-white preview pixels fall from 20.2% to 1.5% (full frame) and from 16.8% to 0.7% (prescan). The band now shows the blanket's tone and edge. The on-screen preview, thumbnails and preview JPEG all use it.

TIFFs are unchanged: the scanner's linear 16-bit negative, with every pixel. How highlights look in them depends on the converter used.

The holder detector could not be made reliable. The blanket's edge is as straight across the frame and as dense as a holder edge, so it was removed rather than left to give wrong advice.

### Folder chooser
**Choose…** next to the folder opens a popup, served by the helper:

- It lists the current folder's sub-folders (hidden ones excluded) with shortcuts: Home, Pictures, Desktop, Documents, drives on Windows, and `/`, `/Volumes`, `/media`, `/mnt` elsewhere.
- It shows how many TIFFs the folder holds.
- **New folder…** creates one, suggesting the roll name. A typed path that doesn't exist yet is accepted and created on the first save.
- **System dialog…** opens the operating system's own folder picker on the computer running the helper:
  - Windows: PowerShell FolderBrowserDialog.
  - macOS: AppleScript `choose folder`.
  - Linux: zenity, kdialog or qarma, whichever is installed.
  
  This needs no cgo and returns the chosen path. The dialog can open behind the browser window.

A browser page cannot learn absolute folder paths by itself, so these popups go through the helper. The endpoints are `/api/files/list`, `/api/files/mkdir` and `/api/files/pickdir`. Folder names are restricted like file names.

### Controls and warm-up
- **Scan and save** and **Check framing**, with the status line and Retry/Discard, now sit directly under the preview, above the roll and log tabs. The left panel holds only setup: scanner, roll, output options, diagnostics.
- The lamp warm-up default is **1 s**. A stored old default of 20 s is migrated to 1 s; other stored values are kept.

### Tests
- **Go:** `TestListAndMkdir` covers listing, hidden-folder exclusion, TIFF count, the nearest parent for a missing folder, folder creation, and rejection of unsafe folder names.
- **`roll.test.cjs`:** a dense highlight band on a negative keeps a gradient in the new preview, where the old linear render clipped it.
- **`ui_e2e.cjs`:** checks that the scan buttons sit under the preview, the 1 s default, and the folder popup (browse, create, choose, system-dialog error path, Space ignored while open) before the scan checks.
- **Not tested here:** the Windows and macOS system dialogs (no such system available) and zenity/kdialog (not installed).

## Update: roll scanning workflow

The main page (`/`) is now a roll scanner: load a frame, press **Space**, and the frame is scanned, saved to the roll folder, and released from memory. A small preview and a file record stay in the roll list. The previous page, including the unverified SANE-derived custom mode, is unchanged at **`/experimental`** (`experimental.html`).

### Per-frame workflow

1. Before the carriage moves, the file names for the next number are checked against the folder. If any exist, the scan is refused with a suggestion instead of overwriting.
2. The frame is acquired with the capture-verified profile (the full frame at 3600 dpi by default, or the quick 1440 dpi index scan), using the corrected status polling.
3. The R→G/B channel delays are measured and a 1200-px preview is built from the aligned data.
4. The files are streamed to the helper (`/api/files/save`). The helper writes a temporary file, syncs it, renames it into place and returns size and SHA-256. File I/O does not hold the USB lock.
5. After every file is on disk, the full-resolution buffers are released. The roll list keeps a JPEG thumbnail (240 px) and a record: names, sizes, SHA-256, time, alignment and settings. The large preview is kept for the current session only.
6. `<prefix>_roll.json` in the folder is rewritten after each frame with the record of every frame. The next number advances.

If a save fails (disk full, folder missing, permissions), the scanned frame stays in memory. **Retry save** writes only the files still missing, so the folder can be fixed first. **Discard** drops the frame. Scanning is blocked until one of the two is chosen, and the browser warns before the page is closed.

**Rescan:** select a frame in the roll list and choose *Rescan … (overwrite)*. The next scan replaces that frame's files, and the next number is unchanged.

### File names

`<prefix><number>` with 2, 3 or 4 digits, for example `Roll042_07.tif`, `Roll042_07.json` (sidecar), optional `Roll042_07_raw.tif` and `Roll042_07_preview.jpg`. Prefixes keep letters, digits, space and `. _ - + ( )`; anything else is removed, and the helper rejects any name that could reach another folder. **Start new roll** suggests the next prefix (Roll042_ → Roll043_), resets the number to 1 and offers a matching folder.

### TIFF contents

- **Aligned RGB 16-bit (default):** channels are aligned with the measured sub-line delays. By default the 2× vertical oversampling is averaged, giving square 3600 × 3600 dpi pixels (5124 × 3504, about 103 MB). The option to keep 3600 × 7200 as sampled remains (about 206 MB).
- **Raw USB samples:** optional and unaligned. The strip is byte-identical to the transfer.
- **Values:** always the scanner's linear output, never inverted, levelled or gamma-corrected, which is what negative-conversion tools expect.
- **Film type:** affects only the preview and the preview JPEG.
- **Orientation:** written as the TIFF orientation tag, so pixels are not resampled or rotated.
- **Description:** the frame name and profile are written to the TIFF description.

Memory: a full frame peaks at about 217 MB raw plus 108 MB aligned while saving, then drops back to thumbnails. A 36-frame roll uses a few MB of browser memory after saving.

### Lamp

Warm-up (default 1 s; formerly 20 s) applies only when the lamp has been off. *Keep lamp on between frames* re-lights it after each scan (the recorded sequence ends with the lamp off) and switches it off after 15 minutes idle, so a roll scans without a warm-up per frame. The official software also switches the lamp back on after its scan.

### Dry run

*Diagnostics → Dry run* replays the recorded profiles against a simulated scanner that produces synthetic frames with known channel delays. Files are really written, to a `dry-run` subfolder of the roll folder. The saved roll list and counter are untouched. Connecting a scanner returns to them.

### Options review

| Old control | Status | Reason |
|---|---|---|
| Connect | kept; now also boots and homes | Boot and Home were always required, in that order |
| Boot, Home as workflow steps | automatic on connect; Home also under Diagnostics | |
| Prescan (captured) | kept as **Check framing** (not saved), plus a *quick index* profile that saves | |
| Scan frame | now **Scan and save frame** (Space) | |
| Stop and park | kept | |
| Film type | kept (negative / positive); Kodachrome removed | only changed preview inversion, same as positive |
| Invert preview checkbox | removed | follows film type |
| Rotate upright | replaced by **Orientation** (TIFF tag) | orientation depends on the roll and the shot, not a fixed rotation |
| Save raw / aligned TIFF, PNG buttons | replaced by automatic saving; TIFF kind in *Output options* | |
| Warm-up | kept, now only when the lamp was off | |
| Lamp on/off, USB trace, Dump registers | Diagnostics; trace saves the last scan into the roll folder | |
| Match captures (capture mode) | removed | capture mode is the only verified mode |
| Variant v1/v2 | removed | profiles exist for v1 only; v2 is refused with a pointer to /experimental |
| Resolution, Crop | removed | recorded profiles have fixed geometry (full frame 3600, index 1440) |
| IR pass, Multi-exposure, Multi-sampling | removed | never captured from the vendor; unverified |
| Calibrate, Apply calibration, Forget calibration | removed | the recorded hardware shading is used |
| Pass registration, 2× averaging checkbox | replaced by automatic measured alignment and the *Pixels* option | |
| Motor off, AFE gain/offset, protocol overrides (IR GPIO, XPASEL, 0x8C, header byte, LPERIOD, dummy px) | removed | research controls with no effect on recorded profiles |
| Dry run (old) | replaced | the old one could not run capture profiles |

Everything removed was kept on `/experimental` at the time; that page has since been removed.

### Helper changes

- `files.go`: `POST /api/files/check` and `POST /api/files/save`. The folder must be an absolute path and is created if missing. Names are restricted to letters, digits, space and `. _ - + ( )` with a `.tif`, `.tiff`, `.json` or `.jpg` extension. Files are never overwritten unless `overwrite=1`. Writes are atomic (temporary file, sync, rename) with SHA-256. Files up to 2 GiB are accepted.
- `-out` flag sets the default roll parent folder (default `~/Pictures/OpenOptic`). It is passed to the page along with the session token.
- Also serves `roll.js`, `capture_sim.js` and `/experimental`.
- `files_test.go` covers no-clobber, overwrite, atomicity, SHA-256, folder creation, and rejection of `../`, slashes, hidden names, other extensions and relative folders.

### Tests for this update

- `tests/roll.test.cjs` (headless) covers:
  - naming and prefix cleaning
  - aligned square TIFF dimensions and orientation tag
  - measured alignment against the simulated delays
  - a record under 1 KB with no image data
  - SHA-256 of the written file
  - refusal before scanning and explicit overwrite
  - failed save, retry writing only missing files, and release after save
  - raw strip identical to the USB bytes
  - next-free number and roll record
  - a full-frame 5124 × 3504 output
- `tests/ui_e2e.cjs` (optional, needs jsdom and a running helper) drives the real page against the real helper:
  - two quick frames and one full frame via Space
  - a taken number refused before scanning, and skip-to-next-free
  - an unwritable folder followed by Retry into a fixed folder
  - a rescan with overwrite that leaves the next number unchanged
  - dry-run frames kept out of the saved roll list
  
  An independent TIFF reader (`tifffile`) confirmed every file.
- `aligned` output equals the validated decoder exactly. Averaged output is within 1 LSB of the mean of the decoded line pairs.
- Not tested: real browsers (only jsdom) and the physical scanner with the new page. On the scanner, the command stream is the same verified replay as before. Additions are the lamp switch-on after each frame and the warm-up only when the lamp was off, which fall in the preflight/suffix that `compare_trace.py` allows.

## Update: full-frame 3600 dpi profile from `3600ppifullframehdr.pcapng`

The captured full scan now comes from the new official-software recording. Its command stream, calibration, shading uploads and motor tables replace the earlier `scanneroutput_1.pcapng` profile. The prescan profile is unchanged, byte for byte.

| | Previous full profile | New full-frame profile |
|---|---:|---:|
| Optical window (STR–END) | 1050–10266 | 210–10458 (prescan: 213–10463) |
| Delivered width × lines | 4608 × 6362 | **5124 × 7058** |
| Physical size | 32.5 × 22.4 mm | **36.2 × 24.9 mm** (same window as the prescan) |
| Second positioning move | 14,332 | **13,228** (same as the prescan) |
| Main transfer | 175,896,576 B | 216,991,152 B |
| LINCNT (2× lines read) | 12,724 | 14,116 |
| Shading table upload | 56,168 B | 62,464 B |
| Final AFE gain / offset R,G,B | 23 1B 24 / 1E 30 18 | 23 1A 23 / 20 31 1D |
| Motor tables, LPERIOD 14000, LINESEL 1, 0x01/0x02 = 23/30 | | identical |
| Measured R→G / R→B delay | — | **24.22 / 48.21 lines** |

The old full profile was a smaller crop, 2 mm further along the film and 4 mm narrower than the frame shown in the prescan. The new one scans the whole frame the prescan shows.

**Checks performed**

- **Resolution:** 7,058 lines × 2 line periods × 5.6 ms = 79.0 s, which equals the measured transfer time. The scan is 3600 × 7200 dpi, as before.
- **Frame content:** the reconstructed image shows the same full frame as the prescan.
- **Channel delays:** the measured delays agree with the prescan (19.30 × 2.5 = 48.25). Measured sub-line alignment reduces residual misregistration from 0.23/0.25 lines (integer 24/48) to 0.09/0.13 lines.
- **"HDR":** the recording contains a single RGB main pass. There is no second exposure or infrared pass on the wire, so any HDR processing happens in the vendor's software after transfer. Capture mode's single-pass acquisition matches it.

**Same fixes as the prescan.** The polling and alignment fixes live in the shared runtime and apply to both profiles:

- Every extra status poll re-sends the address.
- The motor is not started while the last status read shows it still running.
- Colour alignment is measured on each scan to sub-line precision.

The simulated-scanner test runs the new full profile with slow moves and confirms both moves (19,490 and 13,228 steps) are fully awaited. The original runtime fails the same test. A simulated full-scan trace compared against `3600ppifullframehdr.pcapng` with `tools/compare_trace.py` matches 1,812/1,812 capture ops and 22/22 identical bulk headers. The only additions are addressed status polls.

**Checking a real scan.** After a full scan on the scanner, save the USB trace and run `python3 tools/compare_trace.py 3600ppifullframehdr.pcapng openoptic-trace-XXXX.json`.

Other changes in this update:

- `build_capture_profiles.py` takes the new capture as its second argument.
- `verify_captures.py` passes for both captures.
- `reconstruct_capture.py` recognises the new frame size.
- The raw-TIFF test accepts it as a fixture; a strip byte-identical to all 216,991,152 received bytes was verified.

## Update: partial-frame scan and colour registration (trace 1790025029175)

### Symptom
Prescan and full scan moved the carriage and returned the full byte count, but the image showed only about the first third of the frame, and red appeared shifted against green/blue.

### Cause: status polls read the wrong register
The GL843 **advances its register address after every 0x84 read**. When a positioning move took longer than the vendor's recorded poll count, `CaptureRuntime.run` re-read 0x84 without re-sending the address. It therefore read 0x42, 0x43 … 0x4F instead of status 0x41. Register 0x4F contained 0x20, which satisfied the "FEEDFSH set, motor off" test, so replay continued while the carriage was still moving.

The supplied trace proves it. Three such polls occurred, and the stray reads include the feed counter (FEDCNT, 0x48–0x4A):

| Trace time | Wait | FEDCNT read by mistake | Outcome |
|---|---|---|---|
| 26.91 s | 1-step feed | 1 | harmless |
| 32.89 s | move 1 (19,490) | — (already FEEDFSH) | ended slightly early |
| 34.25 s | move 2 (13,228) | **4,327** | **main scan started ~50 ms later with ~8,900 steps (≈16 mm) still to go** |

The 25 mm prescan window therefore began about 16 mm before the frame and covered only the frame's first ~9 mm. The same code path affects the full scan (second move 14,332 steps).

Because the carriage was not settled at scan speed when acquisition began, the fixed R/G/B line delays did not hold for the start of the image. That is the most likely source of the red shift; see the alignment change below.

### Fixes
- **Addressed polling.** Every extra status poll is `0x83 ← 0x41`, write-ack `0x8E/0x20`, then `0x84`, the vendor's own pattern. The address pointer is tracked through reads.
- **Motor-start guard.** A register write containing `0x0F = 1` waits for MOTORENB to clear if the last status read still shows the motor running. Every recorded start already has MOTORENB clear, so this adds no traffic in a normal run.
- **Timeouts name the wait.** A readiness timeout reports which wait failed and the last status value. Extended polls are logged in the UI.
- **Measured, sub-line colour alignment.** The recorded delays (10/19 prescan, 24/48 full) are integer roundings. On the vendor prescan the true delays are **G 9.84, B 19.30** lines. Each scan now measures R→G and R→B by normalised cross-correlation of vertical gradients, with a parabolic peak fit, and applies them by linear interpolation between the two bracketing lines. Residual misregistration on the vendor prescan falls from −0.20/+0.38 lines to −0.10/+0.13. If peak correlation is below 0.3 (blank or featureless frame), the recorded integer delays are used and a warning is logged. The shifts used, their source and confidence are written to the TIFF sidecar under `reconstruction`.
- Aligned prescan height is now 2804 rows (ceil of the largest fractional delay) rather than 2805. Raw TIFF is unchanged: every received row, unaligned.
- `tools/reconstruct_capture.py` uses the same measurement and interpolation. Its planes agree with the JavaScript decode to within 1 LSB of 16 bits.

### New verification tools
- `tools/compare_trace.py prescan.pcapng openoptic-trace-….json` checks an app trace against a vendor capture. OUT payloads and bulk-OUT lengths must match in order. Allowed extras are a preflight prefix, repeated write-ack and bulk-complete polls, addressed status-poll triples, and the post-scan home wait. Any **un-addressed repeated 0x84 read is an error**. The supplied trace: 1811/1811 capture ops matched, 22/22 identical bulk headers, **43 errors** (the bad polls). A trace from the fixed runtime passes.
- `tests/simulated_scanner.test.cjs [trace.json]` simulates a GL843 with auto-incrementing addressing, the 0x4C–0x4F values the real unit returned, and moves slower than recorded. It fails on any motor start during a move. The original runtime fails it three times, including at main-scan start; the fixed runtime passes for both profiles. Given a path, it writes a UI-format prescan trace for `compare_trace.py`.

### Validation of this update
- All Node tests pass, including the existing exact op-by-op replay of both profiles with recorded responses. This confirms the guard adds no USB traffic when the scanner behaves as recorded.
- `verify_captures.py` still matches the embedded prescan profile byte for byte with `prescan.pcapng`. `capture_profiles.js` is unchanged.
- The Linux and Windows binaries were built (Go 1.22) and the Linux helper was checked to serve the updated UI and runtime. The macOS build could not be tested here because `purego` could not be downloaded; no Go source changed.
- **Not yet verified on hardware.** After the next scan, save the USB trace and run `compare_trace.py` against it. The UI log shows extended polls and the measured channel delays.

---

## Earlier work

This README records the work performed on the supplied Go/web application using `prescan.pcapng`, `scanneroutput_1.pcapng`, the protocol reference, and the supplied SANE backend snapshot. It includes the subsequent raw TIFF and independent preview-inversion update. The target is the Plustek OpticFilm 7600i **v1**, USB `07b3:0c3b`, revision `0x0400`, Genesys GL843.

## Using the exports

After completing a scan, the Export panel offers three separate outputs:

| Output | Content | Preview inversion applied? |
|---|---|---|
| **Save raw RGB16 TIFF + sidecar** | Every received RGB sample from the main acquisition, in original row/channel order | **No** |
| **Save aligned/processed TIFF + sidecar** | The 16-bit working image after channel alignment and any selected custom-mode processing | **No** |
| **Save rendered PNG** | The display rendering, including tonal stretch, aspect correction and optional upright orientation | Yes, when the preview checkbox is checked |

**Invert preview / PNG only** is an independent checkbox. You can inspect a negative as a positive and export the same uninverted TIFF. Changing Film selects a sensible preview default: negative checks inversion; positive and Kodachrome clear it. You can override that with the checkbox. Existing result thumbnails represent the rendering at the time they were added; the main preview and newly saved PNG use the current checkbox state.

Both TIFF exporters ignore preview inversion, preview contrast, preview gamma and preview rotation. TIFF metadata records separate X/Y sampling resolutions; an image viewer that ignores those tags may display vertically stretched samples. This does not alter the saved data.

### What “raw” means

Raw TIFF preserves the bytes **received over USB**, not an inferred pre-calibration sensor signal. Capture mode enables the scanner's hardware shading correction; that correction has already happened before those bytes reach the host and cannot be undone by raw export. The raw JSON sidecar explicitly records `hardwareShadingApplied: true` for captured profiles.

The raw export does **not** apply:

- Inversion, contrast normalization, gamma, rotation or resampling.
- RGB line-shift alignment or stagger correction.
- Removal of alignment margin rows.
- Host dark/white correction, multi-exposure merging or multisample averaging.

The raw TIFF uses uncompressed, little-endian, interleaved RGB, 16 bits per channel, a single image strip and Orientation 1. Its strip is a direct byte copy of the retained acquisition buffer. TIFF headers are new; the pixel bytes are unchanged. Unaligned raw images can show colour fringes until their CCD line delays are corrected in downstream software.

The captured main acquisition is retained in full. For custom multi-pass scans, raw export retains **the first normal-exposure RGB pass**, before host correction or merging. It is not an archive of every exposure, repeated sample or infrared pass. The selected pass is named in the sidecar. Aligned/processed TIFF can include the combined result and an infrared extra channel.

Only the latest completed scan's export data is retained in memory. Save before acquiring another scan or closing the page. Keeping the original data increases browser memory use, especially for the full scan and during TIFF serialization.

## Capture findings

| Setting | Prescan capture | Full-scan capture |
|---|---:|---:|
| Horizontal / vertical sampling | 1440 / 2880 dpi | 3600 / 7200 dpi |
| DPISET | 240 | 600 |
| STRPIXEL / ENDPIXEL | 213 / 10463 | 1050 / 10266 |
| Raw width × rows | **2050 × 2824** | **4608 × 6362** |
| Raw pixel bytes | **34,735,200** | **175,896,576** |
| LPERIOD | 14000 (`0x36B0`) | 14000 (`0x36B0`) |
| LINESEL | 0 | 1 |
| Programmed LINCNT | 5648 | 12724 |
| FEEDL during image scan | 1 | 1 |
| Positioning moves after shading | 19490, 13228 | 19490, 14332 |
| Scan-table first / cruise entry | 25252 / 2800 | 25252 / 14000 |
| Active 0x01 / 0x02 | `0x23` / `0x30` | `0x23` / `0x30` |
| Each hardware-shading upload | 24,984 bytes | 56,168 bytes |
| R/G/B alignment delays (recorded integer; now measured per scan) | 0 / 10 / 19 rows (measured 0 / 9.84 / 19.30) | 0 / 24 / 48 rows |
| Aligned width × rows | 2050 × 2804 (was 2805 with integer delays) | 4608 × 6314 (depends on measured delays) |
| Upright rendered PNG | 1402 × 2050 | 3157 × 4608 |

The full scan was described as 3200 dpi, but its DPISET 600 gives **3600 horizontal dpi**. Vertical sampling is inferred from the motor timing, LINESEL and measured channel offsets. The prescan uses twice the horizontal sample density along travel despite LINESEL being zero. Consequently, LINESEL alone cannot determine the X/Y sampling ratio.

Both recordings program twice as many scan lines as the host reads. They end acquisition from the host. The old formula tying the programmed line-count multiplier to LINESEL could not reproduce the prescan.

The recordings do not cover identical rectangles: their optical horizontal origins and second positioning moves differ. The application preserves each recorded frame. Fixed capture mode does not reinterpret a crop dragged on one image as the other capture's command sequence.

The original protocol reference describes the full 3600 dpi acquisition, not the prescan. Values from that document should not be applied indiscriminately to the prescan.

### Transport observations

- The GL843 uses one `0x82` header for an entire image transfer and a four-byte little-endian size; full scan exceeds 16 MB.
- Both recordings use `0x8C[0x0F] = 2` before image reads.
- Register/address/write-ack transport agrees with the supplied implementation and SANE.
- Bulk completion uses `0x8E/0x18`. No `0x8D` bulk-end operation occurs in either capture.
- Motor tables and hardware-shading coefficients are uploaded over bulk OUT.
- Neither of these two recordings exercises infrared acquisition. The later colour-film captures do
  (iSRD, multi-exposure): see `CAPTURE_FINDINGS_COLOUR_ME_IR.md` and the colour-film notes in
  `PROTOCOL.md` (IR LED via GPIO27, two-sequence jobs, FEEDFSH latch, black level of the passes).

### Calibration observations

The vendor performs AFE calibration reads and dark/white shading acquisitions, then uploads hardware-shading tables. The prescan's final gain/offset values differ slightly from the earlier full scan:

| Channel | Prescan gain / offset | Full scan gain / offset |
|---|---|---|
| R | `0x23 / 0x1E` | `0x23 / 0x1E` |
| G | `0x1A / 0x2F` | `0x1B / 0x30` |
| B | `0x23 / 0x17` | `0x24 / 0x18` |

These values belong to the recorded acquisitions, not universal calibration constants. AFE offsets use a 9-bit representation. SANE's host-side shading strategy differs legitimately from the vendor's hardware-side strategy.

## Acquisition changes

The default capture mode uses `capture_profiles.js`, generated from the two original captures, and `capture_runtime.js` to acquire **new** scanner data. Profiles include vendor control requests, expected control responses, motor tables and recorded shading uploads. They do not include the photographs or captured bulk-IN image payloads.

The previous partial vendor approximation was removed from the custom configuration path. Prescan now selects its own captured profile; full scan selects the full recording's profile. Custom crop, arbitrary resolution, IR, multi-exposure and multisampling controls are disabled in capture mode. The separate custom SANE-derived mode remains available.

Every captured vendor control payload and bulk-OUT payload is preserved in order. USB enumeration is handled by the native backend. Preflight homing and optional warm-up happen before replay. Bulk-IN reads use chunks up to `0xF000` while preserving headers and total frame sizes, and partial reads are accumulated. Recorded command gaps of at least 20 ms are retained up to one second; replay is not an exact timing emulator.

Acknowledgements, bulk completion, data readiness and terminal motor status can be polled longer than their recorded counts, with timeouts. Automatic return is checked against the home sensor after acquisition. Errors abort the operation; cancellation takes effect at an in-flight transfer boundary before parking.

**Live calibration:** normal acquisition replaces recorded AFE and shading values with measurements
from the existing probe reads. Initial gain uses the maximum four-pixel integer mean; offsets use
32 black pixels. Dark/white references trim eight samples from each end of 128 lines. Dark smoothing
uses a forward 100-value mean, separately by parity at 7200 dpi. All eight supplied colour/IR
captures match. The inclusive dark outlier threshold 64 fits them but remains uncertain within
63..67. Final colour gain increments remain 0/+1/+2.
Exact recorded replay remains available by omitting `hooks.calibrate` from `CaptureRuntime.run`.

## Reconstruction changes

The main data is decoded as little-endian RGB16. Delayed G/B rows are aligned to R and bottom rows without all three corresponding channels are removed. This affects the working image, never raw TIFF.

Captured preview and PNG use independent channel 0.5th/99.5th percentile levels, computed after a 150-sample inset on each edge, linear normalization, optional negative inversion and gamma 1. Vertical sample density is corrected, and optional upright orientation rotates 90 degrees counterclockwise. The browser uses high-quality canvas resampling; the offline Python reconstruction uses Pillow Lanczos. Minor resampling differences are expected.

No dust removal, artistic retouching or film-specific colour profile is applied. This matches the reconstruction recipe used in this conversation, not necessarily the official software's final colour rendering.

## Other bug fixes

- Custom calibration uses 36 mm width, fixing the one-pixel mismatch between the former 35.98 mm calibration and 36 mm prescan at 900 dpi.
- Host calibration retains its optical origin, can correct compatible sub-crops, and logs missing or incompatible calibration instead of silently skipping it. Capture mode avoids applying host correction a second time.
- Custom SANE-derived geometry no longer inherits a vendor vertical multiplier without the matching captured motor profile.
- Motor-off clears motor power; ACDCDIS controls backtracking and is not itself motor-off. The scan trigger is still sent for stationary reads.
- Incremental preview row tracking resets for every pass, and aspect handling uses separate X/Y resolution.
- Stop no longer sends concurrent motor commands while acquisition is issuing USB operations. Capture-mode selection is locked during an operation.
- AFE offset controls accept 0–511.
- The Go bridge checks short OUT writes instead of discarding transfer lengths and reporting success.
- The optional infrared TIFF plane is marked unspecified extra data, not an alpha channel.
- TIFF sidecars distinguish preview-only settings from actual export transformations; captured output does not claim unused custom crop values.
- Raw export now retains and copies all original rows, while aligned/processed export remains separate. Filenames identify `raw` versus `aligned`.

## Source files and tests

| File | Purpose |
|---|---|
| `ui.html` | Roll scanner page: scan, save to folder, release, roll list |
| `roll.js` | DOM-free roll pipeline: names, save-then-release, records |
| `capture_sim.js` | Simulated scanner for dry runs and tests |
| `files.go` | Helper endpoints that write roll files to disk and back the folder chooser |
| `picker.go` | Operating-system folder dialogs (Windows, macOS, Linux) |
| `access.go` | Linux udev-rule installer, file ownership under sudo, permission guidance |
| `docs/PROTOCOL.md` | Scanner protocol as evidenced by the captures |
| `motion.js` | Carriage stop and homing from recorded motor primitives |
| `main.go` | Embed/serve capture assets; reject short USB OUT writes |
| `capture_profiles.js` | Generated captured commands and uploaded calibration/motor data |
| `capture_runtime.js` | Replay with readiness checks; shared geometry, alignment and preview level calculations |
| `tools/build_capture_profiles.py` | Regenerate profiles from the two supplied PCAPs |
| `tools/capture_analyse.py` | Supplied capture decoder used for extraction and verification |
| `tools/reconstruct_capture.py` | Offline PNG reconstruction from either supplied capture |
| `tests/capture_runtime.test.cjs` | Command order, short reads, framing, polling, cancellation, alignment and script parsing |
| `tests/verify_captures.py` | Compare profiles with the original captured control/bulk-OUT bytes (tolerates capture-tool packet drops) |
| `tests/simulated_scanner.test.cjs` | Simulated GL843 (auto-incrementing address, slow moves); fails on motor start mid-move; can emit a trace |
| `tools/compare_trace.py` | Check an app USB trace against a vendor pcap; flags un-addressed status polls and register writes during a running move |
| `tools/compare_frame.py` | Measure an app TIFF's framing against the official full-frame capture |
| `docs/CAPTURE_VALIDATION.md` | Detailed captured acquisition baseline and original validation notes |

Run from the extracted source directory:

```sh
node tests/capture_runtime.test.cjs
node tests/simulated_scanner.test.cjs sim-prescan.json sim-full.json
python3 tools/compare_trace.py /path/to/prescan.pcapng sim-prescan.json
python3 tools/compare_trace.py /path/to/3600ppifullframehdr.pcapng sim-full.json
python3 tools/compare_trace.py /path/to/prescan.pcapng openoptic-trace-XXXX.json   # your own scanner trace
python3 tests/verify_captures.py /path/to/prescan.pcapng /path/to/3600ppifullframehdr.pcapng
python3 tools/reconstruct_capture.py /path/to/prescan.pcapng prescan.png
python3 tools/reconstruct_capture.py /path/to/3600ppifullframehdr.pcapng full.png
```

Offline image reconstruction needs NumPy and Pillow. Capture extraction/verification uses the Python standard library. Node tests need no third-party packages. The Go build needs `ui.html` and both capture JavaScript files present; run `./build.sh` with Go 1.22 or newer.

## Validation results and remaining limits

The command profiles were checked against both original PCAPs: all vendor control payloads and motor/shading uploads match, and all received frame bytes are accounted for. Runtime tests cover both command streams, short reads, acknowledgement retries, empty-read failures and cancellation. Actual captured pixels decoded through JavaScript agree with independent NumPy alignment samples and percentile levels. Both reconstructions were visually inspected.

The raw TIFF update was tested on the complete main-image data from both captures. The TIFF image strips are **byte-for-byte identical** to all 34,735,200 prescan bytes and all 175,896,576 full-scan bytes. Tests also check full row counts, RGB16 tags, separate X/Y resolution, unchanged processed sample values, IR extra-channel tagging and identical raw TIFF output regardless of preview inversion state.

JavaScript syntax checks passed. A Go compiler and runnable browser were unavailable in this environment, so no new native executable was built and no browser/hardware end-to-end run was completed. Actual USB operation, carriage motion and native backend behaviour still require testing on the scanner. Fresh vendor adaptive calibration and IR remain outside capture-validated functionality.
