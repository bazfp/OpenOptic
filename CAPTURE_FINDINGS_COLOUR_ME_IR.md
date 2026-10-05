# Findings: colour-film captures with multi-exposure and iSRD (infrared)

Two USB captures of the official Plustek software on the OpticFilm 7600i v1 (bcdDevice 4.00),
both 3600 dpi, 48-bit colour, full frame, the same LuckyFilm colour negative frame:

| Capture | Size | Sequences | Image reads |
|---|---|---|---|
| `3600ppiMEfullframe48bitColorLuckyFilm.pcapng` ("Multi-exposure") | 226 MB, 136.8 s | 1 | 1 × 216,991,152 B |
| `3600ppiScan&Infraredfullframe48bitColorLuckyFilm.pcapng` ("iSRD") | 453 MB, 193.6 s | 2 | 2 × 216,991,152 B |

Every frame in both captures is complete (unlike the 7200 dpi capture, which lost packets).
Reproduce with `tools/capture_extract.py` (register/AFE state per read, tables, frames) and
`tools/ir_pass_analyse.py` (registration, crosstalk, defect coverage).

## Confirmed: matches the documented protocol

- Boot, AFE search (frames 0–4), dark and white references (frames 5, 6), two shading uploads
  (0x3C, 62,464 B each, after resetting RAMADDR 0x29–0x2B to 0), scan tables in slots 0–2, the two
  positioning moves (FEEDL 19,490 slow then 13,228 fast) and the main read: the same eight-frame
  structure. Every calibration frame of both captures has **register state identical** to the
  3600 dpi profile; the first iSRD pass is identical in full, including the main scan.
- Geometry: DPISET 600, STR 210–END 10458, 5,124 px × 7,058 lines (LINCNT 14,116), 7,200 lines/inch.
- Bulk-in splitting into whole packets plus remainder (60,928/61,440 + 512 and similar).
- Colour delays: the R/G/B line offsets are the 3600 dpi values (0/24/48 nominal).
- **Positioning stop is event-driven**, in all three new sequences: the stop write (0x02=0x08,
  FEEDL=1) follows the interrupt event `0x08` (GPIO4 position sensor) by 0.7–0.8 ms. The event came
  at 2,579.0 ms (ME) and 2,570.9 ms (both iSRD passes) after the move started: an 8 ms spread
  that a fixed timer cannot follow.
- Calibration levels against the 3600 reference (white 57,116/60,822/60,287, dark 978/1,071/1,237):

| Session | White R/G/B | Dark R/G/B | White line ripple |
|---|---|---|---|
| ME | 55,525 / 60,992 / 60,906 | 959 / 1,044 / 1,293 | ≤ 0.10 % |
| iSRD colour | 56,265 / 60,653 / 60,310 | 942 / 1,048 / 1,344 | ≤ 0.08 % |
| iSRD infrared | 59,723 / 59,866 / 62,907 | 0 / 0 / 0 (clamped) | 0.31–0.41 % |

  Colour sessions are within the app's limits; blue black level is 56–107 counts high, which the
  existing black-level correction handles.
- Session AFE results (gain R/G/B, offset R/G/B): ME 0x22/0x1A/0x22, 0x1F/0x2E/0x19; iSRD colour
  0x23/0x1A/0x21, 0x1E/0x2E/0x1A. Same as the reference within one or two steps.

## New: multi-exposure ("ME")

- **One image pass**, not two. Calibration runs at the normal exposure and is unchanged. Only
  the main scan differs from the 3600 profile:

| Register | 3600 normal | ME main scan |
|---|---|---|
| LPERIOD 0x38–0x39 | 0x36B0 = 14,000 (5.6 ms) | **0xA410 = 42,000 (16.8 ms)** |
| LINESEL 0x1E (low nibble) | 1 | **0** |
| BUFSEL 0x20 (buffer restart level) | 0x10 | **0x08** |
| Scan tables, slots 0–2 | 25,252 then 14,000 | 25,252 then **21,000** |

- Line time (0+1) × 42,000 × 0.4 µs = 16.8 ms. Motor steps per line (0+1) × 42,000 / 21,000 = 2:
  the same 7,200 lines/inch. The vendor drops the dummy line and scales the motor cruise exactly as
  the app's **Dummy lines** option does. The main pass takes 118.6 s (measured 119.6 s).
- The exposure is linear: signal is 3.02× (green) and 2.88× (blue) the normal pass at the same
  points, so the recorded shading (computed at 1×) still applies multiplicatively.
- On colour negative, **63 % of the red channel is clipped** at 65,535 (the orange mask passes red
  strongly); green and blue do not clip (p99.5 48,504 and 29,901).
- **The capture holds only SilverFast's last pass.** SilverFast had the normal colour (and IR)
  passes of this frame cached from the iSRD scan. Restarted, an ME scan with infrared enabled
  runs three passes: normal colour, infrared, then this 3× pass. SilverFast (9.2.10) then merges
  the 1× and 3× passes: its saved linear TIFF (`HDRScan = Yes`, `Gamma = 1`, 5,124 × 3,504, the
  same size as the app's aligned 3600 dpi output) is at 1× scale (red median 23,478 against
  23,481 for the 1× pass) with no clipped red. Its settings list `MultiExposure = TRUE` and a
  filter `sfAlignmentMultiExposure`, so the passes are registered before merging. Its iSRD
  settings record an IR offset estimate (`iSRD_ColOffset` −1, `iSRD_RowOffset` 0) and
  `Maximum ISRD Offset = 20`.
- SilverFast's merge, measured against both passes (`tools/silverfast_compare.py`): output at the
  1× scale; the passes are blended, with the 3× pass taking 0.6–0.8 of green, 0.35–0.8 of blue and
  about 0.5 of red wherever it is not clipped, close to noise-optimal weighting (0.75 for k = 3).
  Clipped 3× samples are not used. The 3× pass sits 2 rows and −1 column from the 1× pass. The
  TIFF is mirrored left to right and 0.5 column off the raw scan, slightly smoother, with two flat
  mid-grey (32,640) blocks along opposite edges.
- Interrupt events: `0x08` at 10.477 s (9 ms before move 1 starts, as the read is opened) and at
  13.065 s (move 1 stop point).

## New: iSRD (infrared)

- A complete colour job (identical to the 3600 profile), then a **complete second job** for
  infrared, starting with the AFE reset (0x8C 0x10=0xD4 twice), re-homing, recalibrating and
  repositioning. Pass 2 main read 113.5–193.6 s (80 s); total 194 s.
- Pass 2 register differences from the colour pass (everything else identical, including
  LPERIOD, LINESEL 1, scan tables and geometry):

| Register | Colour | IR pass calibration, white, main | IR pass dark frame |
|---|---|---|---|
| 0x03 (bit 4 = white LED) | 0xBF (on) | 0xAF (off) | 0xAF (off) |
| 0xA8 (GPOE27 + GPIO27/26/25) | 0x20 | **0x27** | **0x23** |

  GL843 datasheet, 0xA8: bits 5–3 GPOE27–25, bits 2–0 GPIO27–25. Only GPIO27 is an output
  (GPOE27 = 1), so **GPIO27 (0xA8 bit 2) switches the infrared LED**. Bits 0–1 are set throughout
  the IR job but drive input-only pins (no visible effect).
- IR AFE result: gain 0x37/0x3A/0x39 (vs ~0x22/0x1A/0x22), offsets ~0x0D/0x0E/0x00: the IR LED is
  weaker, and the black level is pushed to 0 (dark frame reads 0).
- IR image: all three CCD rows see the IR (median ~63,000, about 2.5–5 % at 65,535). Use the R
  row: blue is noisier (p0.5 25,862).
- **Pass-to-pass registration**: measured on dust, the colour image matches the IR image shifted
  by **+2.25 to +2.49 raw lines and +0.8 column**. The second positioning lands slightly
  differently, so every scan must be registered (sub-pixel), not assumed aligned.
- **Dye crosstalk**: log IR = 0.065 · log R + 0.002 · log G − 0.010 · log B + c (clean areas).
  About 6.5 % of the red-record (cyan dye) density leaks into IR, visible as a faint ghost of the
  picture. Removing it reduces the IR spread in clean areas from 0.025 to 0.016 (log units).
- Defects on this frame: 0.033 % of pixels more than 10 % darker than their surroundings in IR.
  Scratches and dust specks match bright streaks and specks in the inverted colour image.

## Issue found in the app

- Per-scan colour delay measurement has low confidence on colour negative (0.06–0.19) and falls
  back to the profile's whole-line values 24/48. The B&W captures measured 24.22/48.21, so colour
  film currently loses up to 0.2 line of colour registration. Fix: fall back to the measured
  fractional constants instead of the rounded profile values.

## Kodak Gold 200: full two-pass multi-exposure and a second iSRD capture

Two more 3600 dpi captures, Kodak Gold 200 colour negative:
`3600ppMultiExposureREALfullframe48bitColorKodakGoldFilm.pcapng` (232.6 s) and
`3600ppiScan&Infraredfullframe48bitColorKodakGoldFilm.pcapng` (196.8 s). All frames complete.

- **Multi-exposure is two complete sequences.** Pass 1 (main read 13.8–93 s) is identical to the
  3600 profile. Pass 2 recalibrates at 1× (register state identical to the profile apart from
  RAMADDR) and its main scan (113.0–232.6 s, 119 s) differs only in LPERIOD 42,000, LINESEL 0,
  BUFSEL 0x08 and scan-table cruise 21,000: exactly the app's exposure ×3 transform.
- **Pass-to-pass offset** (multi-exposure): under one raw line here (r = 0.993 at zero offset).
- **Long-pass black offset.** With each pass's own dark-frame level subtracted, the 3× pass is
  an affine function of the 1× pass: long = 3.11 · short + 873 (R), 3.12 · short + 1,185 (G),
  3.06 · short + 2,040 (B) counts. The extra offset is most likely dark signal from the 3×
  integration time, which the 1×-exposure dark frame does not remove. The merge must fit slope
  and offset per channel and scan, not divide by 3.
- **IR on Kodak Gold** behaves as on Lucky: same register changes (0x03 = 0xAF, 0xA8 = 0x27, dark
  frame 0x23), IR-to-colour offset +1.31 to +1.46 rows and +0.56 to +0.74 column (Lucky: +2.3 to
  +2.5, +0.8: it varies per scan), dye crosstalk log IR = 0.057 · log R (Lucky 0.065), 0.033 % of
  pixels defective.

### Film stock comparison (Lucky 200 vs Kodak Gold 200)

| Session | White R/G/B | Dark R/G/B | AFE gain R/G/B |
|---|---|---|---|
| Lucky, colour | 56,265 / 60,653 / 60,310 | 942 / 1,048 / 1,344 | 35 / 26 / 33 |
| Lucky, 3× session | 55,525 / 60,992 / 60,906 | 959 / 1,044 / 1,293 | 34 / 26 / 34 |
| Kodak Gold, colour | 56,969 / 61,976 / 61,385 | 1,003 / 1,067 / 1,337 | 35 / 27 / 35 |
| Kodak Gold, ME pass 1 | 55,172 / 60,720 / 59,665 | 976 / 1,020 / 1,404 | 34 / 26 / 33 |
| Kodak Gold, ME pass 2 | 55,302 / 60,766 / 60,678 | 980 / 1,034 / 1,395 | 34 / 26 / 34 |

- **Calibration does not depend on the film**: white and dark references and AFE gains agree
  within ~2 % and one gain step across stocks and sessions. The references are read through the
  holder, not the film, so the recorded calibration replays correctly for any stock.
- **The negatives differ**, as expected (raw 1× levels, p0.5 / median / p99.5):

| Film | R | G | B | 3× red clipped |
|---|---|---|---|---|
| Lucky 200 | 9,274 / 23,470 / 42,311 | 5,622 / 9,170 / 15,690 | 2,570 / 5,555 / 10,085 | 63 % |
| Kodak Gold 200 | 6,239 / 17,055 / 34,699 | 2,797 / 6,589 / 16,366 | 1,598 / 2,879 / 8,372 | 8 % |

  Kodak Gold is denser, especially in blue (median 4.4 % of full scale), so multi-exposure helps it
  more than Lucky. The different orange masks are handled per frame by the preview's levels and
  by negative converters; nothing in scanning is stock-specific.
