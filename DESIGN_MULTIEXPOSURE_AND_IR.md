# Design: multi-exposure and infrared smart repair

Status: **implemented at 3600 dpi** (phases 1–5; see section 7). Evidence comes from the colour-film
captures analysed in `CAPTURE_FINDINGS_COLOUR_ME_IR.md`. Each section separates what the captures
show from what is proposed.

## 1. Summary

| | Multi-exposure (ME) | Infrared smart repair (IR) |
|---|---|---|
| Purpose | More signal in dense negative areas (shadows of slides, highlights of negatives); less noise | Find dust and scratches with the IR LED and repair them |
| Vendor method (captured) | One main pass at 3× exposure, calibration at 1× | Full colour job, then a full second job with the IR LED |
| Registers changed | LPERIOD 14,000→42,000, LINESEL 1→0, cruise 14,000→21,000, BUFSEL 0x10→0x08 | 0x03 0xBF→0xAF (white LED off), 0xA8 0x20→0x27 (GPIO27 = IR LED), IR calibration |
| Key finding | Red clips on 63 % of a colour negative at 3×; needs a 1× image as well | Passes land 2.3–2.5 raw lines apart; IR has a 6.5 % cyan-dye ghost |
| Proposed | Two passes (1× + 3×), aligned and blended with noise-optimal weights, as SilverFast does | Colour pass + IR pass, registered, ghost removed, defects repaired |
| Time at 3600 dpi | ≈ 3.7 min (SilverFast ME + IR: three passes, ≈ 5 min) (≈ 3 min with Dummy lines "none" on the 1× pass) | ≈ 3.3 min (194 s captured) |

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
The captured main pass is SilverFast's 3× pass (its 1× pass came from its cache; a fresh ME scan runs 1×, IR if enabled, then 3×), linear (×3.02 green, ×2.88 blue), red 63 % clipped on this negative.
No 1× image pass is in the capture. Calibration stays at 1× and the hardware shading still applies.

### 3.2 Options

| Option | Passes | How | Status |
|---|---|---|---|
| **A. Two-pass merge** | 1× + k× | Merge per pixel, use the long pass where it is not clipped | **What SilverFast does** (1× pass, then 3× pass, aligned and merged); proposed default |
| **B. Long pass only** | k× | Fine where nothing clips (dense slides, B&W) | Option, warns when red clips |

**Not pursued:** a single pass with a shorter red exposure (EXPR/EXPG/EXPB). SilverFast uses
separate passes, so that is the proven route.

**SilverFast's merge, measured** on its saved linear TIFF of this frame (`HDRScan = Yes`,
`Gamma = 1`) against the two captured passes (`tools/silverfast_compare.py`). The TIFF is mirrored
left to right relative to the raw scan and sits 0.5 column off (its own resampling); no rotation.
The 3× pass is 2 rows and −1 column from the 1× pass, which SilverFast corrects
(`sfAlignmentMultiExposure`).
- Output brightness = the 1× pass (ratio 1.00 red, 1.02 green, 1.05 blue): merged onto the 1×
  scale.
- It **blends** the passes; it does not switch. Share of the 3× pass in the fine detail, where
  the 3× pass is not clipped: green 0.61–0.79, blue 0.80 in the darkest areas falling to 0.35
  near 50 % of full scale, red 0.43–0.53. Where the 3× pass clips (most of red on this
  negative) the output comes from the 1× pass.
- These shares are close to noise-optimal (inverse-variance) weighting: scaled down by k, the
  long pass has 1/k of the shot-noise variance, so its ideal weight is k/(k+1) = 0.75 for k = 3,
  rising towards k²/(k²+1) = 0.9 where read noise dominates.
- The output is slightly smoother than either pass (some filtering or different line
  resampling), and has two flat mid-grey blocks (32,640 in all channels) along the top-left and
  bottom-right edges, purpose unknown.

### 3.3 Merge (option A)
For each channel c, on linear data:
1. Subtract each pass's black level (dark frame mean, ~1,000 counts) **before** scaling. Otherwise
   the merge is biased in the shadows.
2. Register the long pass to the 1× pass: translation, sub-pixel, phase correlation on unclipped
   green/blue detail (same image content, strong correlation).
3. Estimate the real ratio k_c by regression where both passes are between 5 % and 80 % of full
   scale; do not trust the nominal 3 (measured 3.02 and 2.88).
4. Blend with **inverse-variance weights**, as SilverFast's output suggests: per pixel, estimate
   each pass's noise variance on the 1× scale from a noise model (shot + read noise, measured
   from the dark and white references), and weight by 1/variance, giving the long pass ≈ 0.75
   (k = 3) in mid-tones and up to ≈ 0.9 in deep shadows. Taper the long pass's weight to 0
   between 90 % and 98 % of full scale so clipped or nearly clipped samples are never used.
   Output = w · long/k_c + (1 − w) · short. Measured against SilverFast's TIFF of the captured
   frame.
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
pass processed in stripes as it arrives; that is phase 6.

## 6. User interface (implemented)
- **Advanced → Multi-exposure: off / extended range / exposure fusion** and **Long pass 2× / 3× / 4×**
  (3× as SilverFast).
- **Output options → Infrared: off / detect (save IR + mask) / repair**, refused with an
  explanation at other resolutions or with raw-only TIFFs; IR-blocking film is detected per frame.
- The resolution dropdown's time estimate includes the extra pass.
- The roll list shows a small badge (ME, IR) and the repair statistics in the frame details.

## 7. Phases

| Phase | Work | Verification |
|---|---|---|
| 1 | Capture analysis, findings, this design | done |
| 2 | Channel-delay fallback fix; multi-sequence profile builder; `full-ir`; `withExposure(k)`; two-pass acquisition | Op-for-op equality with the captures; simulated-scanner tests for both jobs (done) |
| 3 | ME merge (option A) | Fixture tests with synthetic data; compare with SilverFast's TIFF of the captured frame (statistics only, no images in the repo) (done) |
| 4 | IR Detect: IR plane, registration, ghost removal, mask, saved files | Registration within 0.25 px on the captured frames; mask overlap with visible defects (done) |
| 5 | IR Repair | Before/after crops on the captured frame; no change outside the mask (done) |
| 6 | 7200 dpi and prescan variants, stripe processing | Needs captures at 7200 dpi |

## 8. Open questions
1. ~~ME: one pass or two?~~ SilverFast runs a 1× pass, then the 3× pass, aligns and merges them
   (`sfAlignmentMultiExposure`). Its saved linear TIFF of this frame is a reference for testing our merge.
2. IR at 7200 dpi: worth a capture if you will use it.
3. Do you scan B&W silver film? It decides how much effort goes into IR-failure detection.
4. Which comes first, ME or IR repair? ME lowers noise on every film (on this negative mostly in
   green and blue); IR repair removes dust and scratches.

## 9. As built

- Pass order per frame: colour, infrared, long exposure (live preview labels each).
- IR detection always runs on the **linear** colour pass. In exposure-fusion mode both passes are
  repaired with the same mask (the long pass first resampled onto the colour grid), then fused.
- ME offset: with each pass's dark frame removed the long pass reads slope·short + 660–2,040
  counts (Kodak Gold, varies by scan), so the merge fits slope and offset per channel and scan. The
  offset comes from the black level, not from extra dark signal: the image black measured behind
  the holder (409/334/386) is far below the dark frame (976/1,020/1,404), because hardware shading
  subtracts the dark reference. Fusion uses the common black `darkS − offset/(slope−1)`, which
  makes the passes proportional (see CAPTURE_FINDINGS_COLOUR_ME_IR.md, "Black level and
  linearity").
- IR repair: superseded by section 10 (hysteresis detection, visibility gate, routing by width).
- Tests: `tests/enhance.test.cjs` (synthetic ground truth), `tests/multipass_roll.test.cjs`
  (whole-frame pipeline both modes), `tests/scan_options.test.cjs` and `tests/dummy_lines.test.cjs`
  (×3 matches the capture op for op).

- Exposure fusion works on the **negatives** (since the Kodak Gold review): no inversion or
  per-channel levels before fusing; gamma-encoded blend, decoded to a linear negative TIFF. The
  first version fused inverted, levelled positives and saved a display-referred positive, which
  took the inversion and colour balance away from the negative converter.

## 10. Infrared repair, revised on the real captures

Graded on both iSRD captures (Kodak Gold, Lucky) with per-defect residuals and crops:

- **Detection** used a fixed IR transmission cut (t < 0.9). Real hairline scratches and dust sit
  at t ≈ 0.92–0.95, 8–15σ above the IR noise (σ ≈ 0.004–0.006 on a 3×3 mean) yet above the cut,
  so whole scratches were missed. Now hysteresis: seeds 5σ (≥ 2 %) below the clean level, grown
  through neighbours 2.5σ (≥ 1 %) below it.
- **Visibility gate**: a quarter of the IR marks do not show in the colour image (soft rings of
  dust off the film plane). They are left alone. Visibility is v = closing(log colour) − log
  colour, which ignores edges larger than the closing; a ring-vs-inside mean test was fooled by
  the frame border and filled black into the picture.
- **Hole = visible damage**: the IR footprint is wider and softer than the visible mark (10-px IR
  band for a 2-px scratch), so only pixels with v above the grain (median + 3 MAD) or near-opaque
  IR are filled; broad smudges (≥ 13 px across) keep their whole footprint.
- **Routing by width**: the area rule (> 4000 px → divide by t^γ) sent long scratches and fibre
  webs to a correction that barely changes them. Now everything is inpainted except broad
  smudges over 20,000 px.
- Result: ~480 (Gold) and ~340 (Lucky) defects repaired; repaired areas within the grain for
  98–99 % by the residual measure; scratches, hairs, fibre webs and smudges removed (crops in
  ir-repair-real-scans.png). Repair now takes ~10 s per 3600 dpi frame (detection ~23 s).

## 11. Validation of the multi-exposure modes

Run on a simulated negative with known values (orange-mask channel balance, densities 0–2.4, the
measured noise model and black behaviour, 3× red clipping) and on the Kodak Gold capture.

**Extended range (linear merge)**

| Check | Simulation | Kodak Gold |
|---|---|---|
| Fit vs truth | slope within 0.3 %, offset within ~10 counts | 3.115–3.120 |
| Bias of the merge | ≤ 4.6 counts at every level | ±20 counts in the bulk; +45 (blue) to ~+100 (red, few pixels) counts in the densest parts of the negative |
| Noise | within 2 % of the inverse-variance optimum; 2.6–2.9× lower than 1× | 0.48–0.72× of 1× in shadows and mid-tones (grain is common to both passes) |
| Clipped long-pass samples | output = 1× exactly (all of them) | red highlights 1.00× (unchanged) |
| Fade-out at 90–98 % of full scale | no step | smooth, ≤ 42 counts at ~18,000 (0.2 %) |
| Registration | — | residual < 1 px |

The only systematic error is the straight-line relation between the passes near black: about
3–4 % (≈ 0.015 D) high in blue in the densest areas. A level-dependent mapping (fitted per level
band on smoothed data) instead of one affine fit would remove it. Not implemented yet.

**Exposure fusion (negatives)**

| Check | Simulation | Kodak Gold |
|---|---|---|
| Output | linear negative, not inverted, black 0, no clipping | same; 0 pixels at full scale |
| Black recovered | 626/452/543 vs true 625/458/540 | 664/465/538 |
| Colour vs truth / 1× (log ratio) | median −0.005 (R/G), −0.023 (B/G); p5–p95 width 0.05 / 0.09 | median 0.002 (R/G), 0.007 (B/G); p5–p95 within ±0.03 |
| Tone gain (green) | 1.05× at the film base rising to ~2.65× (dense) | 1.25× thin, 1.7× mid, 2.5–2.8× dense |
| Local detail | r 0.94–0.96 vs truth | — |
| Pixels below the fusion black (clamped) | — | 0.06–0.32 % |

Fusion lifts dense areas of the negative (scene highlights) towards the long pass's level while
keeping local detail, which after inversion compresses highlights: the intended HDR look. A first
simulation assumed the long-pass offset was extra dark signal (true black = dark frame); under
that wrong model the fusion black is mis-estimated and colours shift strongly. The holder
measurement rules that model out.
