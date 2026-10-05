# Design: multi-exposure and infrared smart repair

Status: **design phase**. Nothing here is implemented yet. Evidence comes from the two colour-film
captures analysed in `CAPTURE_FINDINGS_COLOUR_ME_IR.md`. Each section separates what the captures
show from what is proposed.

## 1. Summary

| | Multi-exposure (ME) | Infrared smart repair (IR) |
|---|---|---|
| Purpose | More signal in dense negative areas (shadows of slides, highlights of negatives); less noise | Find dust and scratches with the IR LED and repair them |
| Vendor method (captured) | One main pass at 3× exposure, calibration at 1× | Full colour job, then a full second job with the IR LED |
| Registers changed | LPERIOD 14,000→42,000, LINESEL 1→0, cruise 14,000→21,000, BUFSEL 0x10→0x08 | 0x03 0xBF→0xAF (white LED off), 0xA8 0x20→0x27 (GPIO27 = IR LED), IR calibration |
| Key finding | Red clips on 63 % of a colour negative at 3×; needs a 1× image as well | Passes land 2.3–2.5 raw lines apart; IR has a 6.5 % cyan-dye ghost |
| Proposed | Two passes (1× + 3×) merged, or a single pass with a shorter red exposure if that works | Colour pass + IR pass, registered, ghost removed, defects repaired |
| Time at 3600 dpi | ≈ 3.7 min (≈ 3 min with Dummy lines "none" on the 1× pass) | ≈ 3.3 min (194 s captured) |

## 2. Shared groundwork

### 2.1 Profiles from the new captures
- Extend `tools/build_capture_profiles.py` to split a capture into sequences (the iSRD capture
  holds two eight-frame sequences; frame numbering restarts at the AFE reset `0x8C 0x10=0xD4`).
- **IR profile** `full-ir`: the second sequence of the iSRD capture, as recorded (its own AFE
  search, dark frame with `0xA8=0x23`, IR white, IR main). Lamp references come from its own
  frames (IR white ~59.7k/59.9k/62.9k, dark 0, ripple up to 0.41 %), so the illumination check has
  IR-specific limits (ripple limit 0.6 % still passes).
- **Long exposure** as a *transform* of the existing `full` profile, like `withLineSel`:
  `withExposure(profile, k)` sets the main scan's LPERIOD to 14,000·k, LINESEL to 0, cruise to
  7,000·k, BUFSEL to 0x08. Test: `withExposure(full, 3)` must reproduce the ME capture's main-scan
  writes and tables op for op. k=3 is the only captured value; k=2 (28,000) and k=4 (56,000, still
  below 0xFFFF) are extrapolations, marked experimental.
- 7200 dpi and prescan variants are not captured. Transforms are plausible (same registers), but
  stay experimental until captured.

### 2.2 Two-pass jobs
Both features need a second main pass. Proposed sequence for one frame:

1. The existing sequence, unchanged, up to the end of the first main read (the carriage
   auto-returns, 0x02=0x30).
2. Wait for home, then for the second pass either
   - **ME:** reuse the calibration, repeat the two positioning moves (event-driven stop), run the
     long main scan. The vendor ME runs with the 1× calibration, so no recalibration.
   - **IR:** replay the IR sequence in full (AFE reset, IR calibration, positioning, IR main),
     exactly as captured.
3. Release raw buffers as early as possible (§5).

The carriage stops on the GPIO4 event, so both passes start at nearly the same place. The
residual offset (2–3 raw lines, under 1 column) is measured per scan (§4.3), never assumed.

### 2.3 Fix first: colour-film channel delays
On colour negative the per-scan delay measurement falls back to the profile's 24/48. Fall back to
the B&W-measured 24.22/48.21 instead. Small change, benefits every colour scan.

## 3. Multi-exposure

### 3.1 What the capture shows
One main pass at 3× exposure (one carriage pass, confirmed), linear (×3.02 green, ×2.88 blue), red 63 % clipped on this negative.
No 1× image pass is in the capture. Calibration stays at 1× and the hardware shading still applies.

### 3.2 Options

| Option | Passes | How | Status |
|---|---|---|---|
| **A. Two-pass merge** | 1× + k× | Merge per pixel, use the long pass where it is not clipped | Fallback that always works |
| **B. Long pass only** | k× | What the vendor does (one pass, confirmed); fine where nothing clips (dense slides, B&W) | Option, warns when red clips |
| **C. Single pass, shorter red** | 1 | LPERIOD 3×, EXPR set so red integrates 1× | **Experiment first** (vendor speed without the red clipping): EXPR/G/B exist ("exposure time for red/green/blue channel of CCD"), are 0 in every capture, and may not be wired on this sensor |

Experiment for option C, without scanning film: run the calibration sequence with LPERIOD 42,000
and EXPR = 14,000, then read the 128-line white reference. If red reads about the 1× level and
green/blue about 3×, per-channel exposure works and option C becomes a single 2-minute pass.

### 3.3 Merge (option A)
For each channel c, on linear data:
1. Subtract each pass's black level (dark frame mean, ~1,000 counts) **before** scaling. Otherwise
   the merge is biased in the shadows.
2. Register the long pass to the 1× pass: translation, sub-pixel, phase correlation on unclipped
   green/blue detail (same image content, strong correlation).
3. Estimate the real ratio k_c by regression where both passes are between 5 % and 80 % of full
   scale; do not trust the nominal 3 (measured 3.02 and 2.88).
4. Blend weight w = 1 where the long pass is below 75 % of full scale, falling smoothly to 0 at
   90 %. Output = w · long/k_c + (1 − w) · short.
5. Write 16-bit linear at the 1× scale, so existing TIFFs, previews and converters see the same
   levels; only the noise drops (≈ √3 shot noise, 3× read noise where the long pass is used).

### 3.4 Output and records
- The same aligned TIFF, plus an optional raw TIFF per pass.
- Sidecar: k per channel, registration offset, fraction of pixels from each pass, both dark
  levels.

## 4. Infrared smart repair

### 4.1 What the captures show
- IR job = full second sequence: white LED off, GPIO27 on, IR AFE gains ~0x37–0x3A, black at 0.
- IR image on all three CCD rows; the R row is cleanest. Median ~63,000.
- Offset to the colour pass: +2.25 to +2.49 raw lines, +0.8 column.
- Ghost: log IR ≈ 0.065 · log R (cyan dye), removable by regression.
- This frame: 0.033 % of pixels are defects (>10 % IR drop), mostly fine diagonal scratches and
  specks.

### 4.2 Modes

| Mode | Output |
|---|---|
| Off | As today |
| **Detect** | Colour TIFF unchanged + IR TIFF (16-bit grey, aligned to the colour pass) + defect mask PNG |
| **Repair** | Repaired colour TIFF + the Detect files (unrepaired original optional) |

Detect comes first: it is safe, useful immediately for other software, and lets repair be
tuned against real masks.

### 4.3 Pipeline
1. Colour pass (existing) → aligned colour frame.
2. IR pass → IR plane from the R row, aligned with the same channel-delay and stagger handling,
   reduced to square pixels like the colour frame. Free the IR raw buffer.
3. **Register** IR to colour: translation from dust (the method in `tools/ir_pass_analyse.py`:
   colour-pass dark specks at IR defect positions, sub-pixel peak), with phase correlation on the
   frame and holder edges as a cross-check. Reject the scan for repair (Detect only, warned) if
   the two disagree by more than 0.5 px.
4. **Ghost removal**: fit log IR = a·log R + b in clean areas (IR within 5 % of its local maximum),
   and keep IR' = IR / R^a.
5. **Transmission map**: t = IR' / local clean background (closing + smoothing, ~15 px).
6. **Mask**: defect where t < 0.90, grown by 1–2 px; component sizes recorded.
7. **Repair** (on linear colour data):
   - **Semi-transparent dust** (0.5 ≤ t < 0.9): divide RGB by t. Dust attenuates visible and IR
     roughly equally, so this restores the image underneath where some light got through.
   - **Opaque defects** (t < 0.5) and long thin scratches: fill from the surroundings. Use a
     direction-aware fill along the scratch orientation (from the mask's principal axis), falling
     back to fast-marching inpainting for specks. Grain is re-synthesised from nearby noise so
     filled areas don't look smooth.
8. Save, then release the IR plane.

### 4.4 Limits and safety
- **B&W silver film and Kodachrome block IR.** IR then shows the image itself. Detect it from
  very low IR or a large ghost coefficient, and disable repair with a clear message. The film
  setting gives a first hint.
- The IR LED ripple (≤ 0.41 % captured) is far below defect contrast; no change needed.
- Repair never touches pixels outside the mask, and the mask is saved so results can be checked.

## 5. Memory and time (3600 dpi)

| Step | Peak memory |
|---|---|
| Today, single pass | raw 217 MB → aligned in place |
| ME | raw 1× 217 MB (aligned in place to 103 MB) + raw long 217 MB, merged into the 1× frame as it is aligned |
| IR | aligned colour 103 MB + raw IR 217 MB, reduced at once to a 36 MB plane |

Both fit comfortably at 3600 dpi. At 7200 dpi (868 MB per raw pass) ME and IR need the second
pass processed in stripes as it arrives; that is phase 7.

## 6. User interface (proposed)
- **Advanced → Exposure** becomes **Multi-exposure: off / 2 passes, long pass 2× / 3× / 4×**, with
  3× marked "as Plustek's software".
- **Output options → Infrared: off / detect (save IR + mask) / repair**, disabled with an
  explanation when the film type is B&W.
- The resolution dropdown's time estimate includes the extra pass.
- The roll list shows a small badge (ME, IR) and the repair statistics in the frame details.

## 7. Phases

| Phase | Work | Verification |
|---|---|---|
| 1 | Capture analysis, findings, this design | done |
| 2 | Channel-delay fallback fix; multi-sequence profile builder; `full-ir`; `withExposure(k)`; two-pass acquisition | Op-for-op equality with the captures; simulated-scanner tests for both jobs |
| 3 | Option C experiment (per-channel exposure, white reference only) | Levels of R vs G/B |
| 4 | ME merge (option A, and C if it works) | Fixture tests with synthetic data; statistics on the captured frames (no images in the repo) |
| 5 | IR Detect: IR plane, registration, ghost removal, mask, saved files | Registration within 0.25 px on the captured frames; mask overlap with visible defects |
| 6 | IR Repair | Before/after crops on the captured frame; no change outside the mask |
| 7 | 7200 dpi and prescan variants, stripe processing | Needs captures at 7200 dpi |

## 8. Open questions
1. ~~ME: one pass or two?~~ One pass (confirmed). Still useful: the vendor's saved TIFF from that
   scan, to see whether its red channel is clipped or filled from the preview.
2. IR at 7200 dpi: worth a capture if you will use it.
3. Do you scan B&W silver film? It decides how much effort goes into IR-failure detection.
4. Is ~3.7 min per frame acceptable for ME at 3600 dpi, or should option C (single pass) be the
   priority even though it is speculative?
