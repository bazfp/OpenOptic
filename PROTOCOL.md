# Plustek OpticFilm 7600i (v1) USB protocol

Sources: the **GL843 datasheet** (Genesys Logic, rev 1.02, 2006) for register semantics, and USB
captures of the Plustek software driving one scanner for how they are used:
`prescan.pcapng` (1440 dpi), `3600ppifullframehdr.pcapng`, `7200ppifullframehdr.pcapng`, plus the
earlier `scanneroutput_1.pcapng`. Values that were read off the wire are stated as facts. Anything
inferred is marked **(inferred)**. Register names and bit meanings below are the **datasheet's own**, except where marked. Entries
still marked **(inferred)** are ones the datasheet does not cover or that the captures contradict.

Device: `07b3:0c3b`, bcdDevice **4.00**, Genesys Logic **GL843** ASIC, LED illumination plus a
separate infrared LED (the "i" models). A different bcdDevice is a different variant and none of
this is verified for it.

---

## 1. Transport

| Endpoint | Use |
|---|---|
| Control (EP0) | everything: register access, status, bulk set-up |
| Bulk OUT | slope tables, shading tables (payload of a set-up control transfer) |
| Bulk IN | image and calibration data |
| Interrupt IN | occasional 1-byte `0x08`. Seen before the first positioning move and about 2.56 s after it starts. Its meaning is unconfirmed; the app does not use it |

All control transfers are vendor requests to the device. Two request codes appear, and which one
is used depends only on the payload length:

| bmRequestType | bRequest | wValue | wIndex | Direction | Meaning |
|---|---|---|---|---|---|
| 0x40 | 0x0C | 0x83 | 0 | OUT, 1 byte | set the register address for the next read |
| 0x40 | 0x04 | 0x83 | 0 | OUT, 2–64 bytes | write registers, as `reg, value` pairs |
| 0xC0 | 0x0C | 0x84 | 0 | IN, 1 byte | read the register at the current address |
| 0xC0 | 0x0C | 0x8E | 0x20 | IN, 1 byte | write acknowledge: bit 0 set when the write completed |
| 0xC0 | 0x0C | 0x8E | 0x18 | IN, 1 byte | bulk-transfer status: bits 2–3 clear when the transfer is finished |
| 0xC0 | 0x0C | 0x8E | 0x00 | IN, 1 byte | read once at the start of a session (value 0) |
| 0x40 | 0x04 | 0x82 | 0 | OUT, 8 bytes | bulk set-up: `dir, 0, 0, 0, len32 (little endian)`; `dir` 0 = IN (read image), 1 = OUT (upload a table) |
| 0x40 | 0x0C | 0x8C | 0x0F | OUT, 1 byte | value 0x02, issued around every AFE access **(inferred: AFE strobe)** |

These `wValue` codes are a firmware-level command set, **not** chip registers: the datasheet's
registers 0x82–0x8E are unrelated (flow-control, packing, RS232, ROM).
| 0x40 | 0x0C | 0x8C | 0x10 | OUT, 1 byte | value 0xD4, issued twice during boot **(inferred: AFE reset/mode)** |

**Sequence for a register write:** send the `0x83` pair list, then poll `0x8E/0x20` until bit 0 is
set. The captures poll it exactly once per write in normal conditions.

**Sequence for a register read:** write the address (`0x83` with a single byte), poll `0x8E/0x20`,
then read `0x84`. The address **advances by one after every `0x84` read**, so a repeated read
without re-addressing returns the next register, not the same one again. Reading 0x41 fourteen
times without re-addressing returns 0x42…0x4F.

**Sequence for a bulk transfer:** write `0x82` with direction and length, then perform the bulk
transfer, then poll `0x8E/0x18` until bits 2–3 are clear. Image reads are one `0x82` followed by
as many bulk IN transfers as needed; the host chooses the chunk size (the vendor uses up to 64 KB,
the app uses 60 KB).

---

**Bulk read sizes.** The vendor driver only ever requests whole 512-byte packets, then reads
any remainder on its own: the 62,268-byte white line arrives as 61,952 + 316, and main-image
reads as 61,440/60,928 + 512. A single read whose length ends part-way through a packet, while
the scanner still has data to send, fails on Linux usbfs with EOVERFLOW ("value too large for
defined data type"). The app follows the vendor pattern for every frame.

---

**Interrupt endpoint (0x83, 1-byte packets).** The vendor software keeps one read pending on it
from boot and re-submits after every reply; it never polls the GPIO registers. Each byte is a mask
of the GPIO inputs (register 0x6D, bit n-1 = GPIOn) that changed, reported once per falling edge:

| Byte | GPIO | Source | Idle level in 0x6D (0x56 at rest) |
|---|---|---|---|
| `0x02` | GPIO2 | front button B, active low | 1 |
| `0x04` | GPIO3 | front button A, active low | 1 |
| `0x08` | GPIO4 | carriage/holder position sensor | 0 at rest |

Button events and register changes were confirmed with the page's button monitor: one event per
press, none on release, and 0x6D drops the button's bit while it is held. In the 7200 dpi capture
the software received `0x08` 4 ms after first opening the read (a latched sensor change) and again
2.571 s after positioning move 1 started, and stopped the move 0.8 ms later. The datasheet describes
GPIO1-4 as "hot key" inputs latched until read; this scanner sets GPIO1-7 as inputs (0x6F = 0x80).

**Reading it from a host.** Only one interrupt read can be pending; the helper answers a second
concurrent read with "busy" (HTTP 429) and a read that times out with "no event" (HTTP 204), which
is normal while idle. A pending read neither blocks nor is blocked by control and bulk traffic, and
no event is lost while none is pending: the scanner holds the change until the next read (it
arrived 4 ms after the vendor first opened the read). After a reconnect the old read can still be
pending for up to its timeout, so the first new reads may come back busy. As a fallback the same
button state is visible by polling register 0x6D while the scanner is idle (select 0x6D, then
read): the button's bit drops while it is held. Polling must not interleave with any other
register access, since a read is two transfers (select, then read).

---

**Colour-film captures (multi-exposure, iSRD).** Two further 3600 dpi captures confirm the
sequence above and add three facts; details in `CAPTURE_FINDINGS_COLOUR_ME_IR.md`:

- **Longer exposure** is LPERIOD alone: the vendor's multi-exposure main scan uses LPERIOD 42,000
  (3×, 16.8 ms), LINESEL 0, scan-table cruise 21,000 (still 2 steps per line) and BUFSEL
  (0x20) 0x08 instead of 0x10, with calibration left at 1×. Signal scales linearly (3.0×).
- **Infrared**: white LED off (0x03 bit 4 = 0) and **GPIO27 high (0xA8 = 0x27)** turns on the IR
  LED; the IR dark frame uses 0xA8 = 0x23. The IR job is a complete second sequence with its own
  calibration (AFE gain ~0x37–0x3A, offsets ~0). Successive passes land 2–3 raw lines apart.
- **RAMADDR (0x29–0x2B)** is set to 0 before each shading upload.
- **The iSRD infrared job starts while the carriage is still returning** from the colour pass: before
  its first motor start the vendor polls status 416 times with MOTORENB set (0xB5), then reads
  0xFC (FEEDFSH latched by that return). A carriage parked by this app reads 0xDC: FEEDFSH is
  clear and stays clear until the sequence's own first move. The replay therefore waits for
  FEEDFSH only after it has started a move itself; before that it waits only while MOTORENB is
  set (the 416 polls collapse to one such wait). Waiting for the recorded 0xFC stalled the
  infrared pass until the 60 s readiness timeout.
- **Multi-exposure is two complete sequences** (Kodak Gold capture): pass 2 recalibrates at 1×
  and differs only in its main scan (the four changes above). With each pass's dark frame removed,
  long = slope·short + offset with slopes 3.11–3.12 and offsets 660–1,830 counts (870–2,040 in the
  first fit; it varies by scan). The offset is **not** extra dark signal in the long pass: behind
  the opaque film holder the 1× pass reads 409/334/386 (R/G/B) while its dark frame reads
  976/1,020/1,404, so the dark frame (taken before hardware shading) overestimates the image black
  by 570–1,020 counts. The 3× pass reads 662/357/494 behind the holder: its black is only 20–250
  counts higher. A common black B = darkS − offset/(slope − 1) (≈ 630/460/540 here) makes the two
  passes proportional in the mid-tones; near black they are not exactly proportional (the 3× pass,
  mapped onto the 1× scale, reads up to ~5 % high in the densest parts of the negative). Use an
  affine or level-dependent relation between passes, never a plain ×k.
- Calibration levels and AFE gains do not depend on the film stock (Lucky 200 and Kodak Gold 200
  agree within 2 % and one gain step); the references are read through the holder.
- The interrupt endpoint reports `0x08` (GPIO4 position sensor), `0x04` (front button A, GPIO3)
  and `0x02` (front button B, GPIO2).

---

## 2. Status registers

### 0x41 — main status

| Bit | Name | Meaning observed |
|---|---|---|
| 0x80 | PWRBIT | power status; mirrors bit 4 of register 0x06 |
| 0x40 | BUFEMPTY | set while the image buffer holds no data; clears when data is ready to read |
| 0x20 | FEEDFSH | set when a feed (positioning move) has finished |
| 0x10 | SCANFSH | set when a scan has finished |
| 0x08 | HOMESNR | datasheet: 1 = "home sensor is off (located in home position)". Observed: set while parked at home, cleared by one step forward |
| 0x04 | LAMPSTS | 1 = lamp (here: LED) on |
| 0x02 | FEBUSY | 1 = front end busy, cannot be read or written |
| 0x01 | MOTORENB | set while the motor is energised, including a short hold after motion stops |

Typical values: `0xDC` parked at home, idle; `0xD5` moving; `0xF5` feed finished, motor still
energised; `0xF4` feed finished and motor released; `0xE5`/`0xA5` during a scan, where the 0x40 bit
clearing signals that image data can be read; `0xA1` at the end of a scan while the carriage is
returning. With the white LED off (infrared jobs, or LED switched off between frames) the same
states read 0x04 lower: `0xD8` parked, `0xF0` feed finished and released.

**FEEDFSH is a latch, not a state.** It is set when a move ends (including the chip's own
auto-return after a scan) and cleared by the next motor start. After this app's colour pass ended
with the auto-return, the next sequence began at `0xE8` (FEEDFSH latched, home, LED off); after
the app's own homing it read `0xDC` (FEEDFSH clear). The vendor's iSRD job began at `0xB5`
(carriage still returning, motor on) and then `0xFC`. A replay must therefore not wait for a
recorded FEEDFSH before the sequence has started a move of its own; before that, wait only while
MOTORENB is set.

### 0x40 — secondary status
Polled only at the very end of a scan. Values `0x33 → 0x31 → 0x33 → 0x37` were observed; the bit
meanings are unknown. The app does not use it.

### 0x42–0x47 — VALIDWORD
25-bit count of image data waiting in SDRAM, in units of two words. The vendor reads it after the
buffer reports data; the app does not rely on it.

### 0x48–0x4A — FEDCNT
20-bit feed counter (0x48 masked with 0x1F, then 0x49, 0x4A). Counts motor steps of the current
move. Reading 4,327 here while a 13,228-step move was running is what first proved a move was
being interrupted.

---

## 3. Register map

Values seen across the three captures. Empty means the register is never written.

### Mode and illumination
| Reg | Values | Meaning |
|---|---|---|
| 0x01 | 0x02, 0x03, 0x22, 0x23 | bit 0 SCAN (start acquiring), bit 1 SHDAREA (apply shading), bit 5 set in all scan states **(inferred)** |
| 0x02 | 0x00, 0x08, 0x10, 0x18, 0x30, 0x38 | 0x80 NOTHOME (1 = auto-go-home stops after FEEDL steps instead of at the sensor), 0x40 ACDCDIS (**0 enables carriage backtracking when the buffer fills** — 0 in every capture), 0x20 AGOHOME, 0x10 MTRPWR, 0x08 FASTFED (1 = move using two accel/decel tables), 0x04 MTRREV (reverse), 0x02 HOMENEG (home-sensor edge to decelerate on), 0x01 LONGCURV. `0x18` = fast feed, `0x30` = scan with auto-return, `0x08` = the stop written to end a move |
| 0x03 | 0x8F, 0x9F, 0xAF, 0xBF | 0x80 LAMPDOG (lamp sleep mode), 0x40 AVEENB (dpi averaging vs deletion), **0x20 XPASEL (1 = transparency lamp, set for every scan here)**, 0x10 LAMPPWR (illumination on), 0x0F LAMPTIM. 0xBF = transparency light on, 0xAF = off |
| 0x04 | 0x22, 0x62 | AFE/CCD configuration **(inferred)** |
| 0x05 | 0x40, 0x48 | pixel clock / CCD mode **(inferred)** |
| 0x06 | 0xF0 | fixed |
| 0x0B | 0x4A | clock configuration; also read back once during boot |
| 0x0D | 0x00, 0x01, 0x03 | bit 0 CLRLNCNT, bit 1 CLRMCNT: clear the line counter and FEDCNT |
| 0x0F | 0x01 | **start**: writing 1 begins the configured scan or feed |

### Exposure and CCD timing
| Reg | Values | Meaning |
|---|---|---|
| 0x10–0x15 | all 0 in every capture | per-channel exposure; zeroed before moves **(inferred)** |
| 0x16–0x1D | 0x3B/0x27, 0x0C, 0x10, 0x2A, 0x30/0x00, 0x00, 0x00/0x20, 0x9A/0x84 | CCD timing constants. 0x1C takes 0x20 for moves and scans |
| 0x1E | 0x10, 0x11, 0x12, 0x15 | high nibble WDTIME (watchdog, units of 30 s); low nibble **LINESEL = number of dummy lines for a CCD**, so a delivered line takes LINESEL+1 line periods |
| 0x1F | 0x00, 0x01 | SCANFED: steps to move to the scanning position (multiplied by 2×STEPTIM) |
| 0x20 | 0x02, 0x05, 0x07, 0x0C, 0x10, 0x13, 0x17, 0x35 | BUFSEL: buffer condition. "When buffer is full, scanner will stop and wait for host to read out image data" |
| 0x21 | 0x01, 0x02, 0x04 | STEPNO: accel/decel steps of **table one** (scanning) |
| 0x24 | 0x01, 0x02, 0x04 | FASTNO: accel/decel steps of **table two**, used when the buffer fills |
| 0x22 | 0x01 | FWDSTEP: forward steps when the buffer condition is met |
| 0x23 | 0x01 | BWDSTEP: backward steps when the buffer is full (backtracking) |
| 0x25–0x27 | see §6 | LINCNT, 24-bit line count |
| 0x29–0x2B | 0x00 | RAM address high bytes for uploads |
| 0x2C–0x2D | 0x00F0, 0x0258, 0x04B0 | **DPISET**: 240, 600 or 1200 |
| 0x2E, 0x2F | 0x80 | shading/threshold constants |
| 0x30–0x31 | 20, 210, 213 | **STRPIXEL**, first optical pixel |
| 0x32–0x33 | 532, 10398, 10458, 10463 | **ENDPIXEL**, last optical pixel |
| 0x34 | 0x14 (0x3C during boot) | DUMMY: CCD dummy pixels |
| 0x35–0x37 | 5706 … 15828 | **MAXWD**, maximum words per line, in units of two words. "If available buffer size < MAXWD, then buffer full state will be set. The scanner execute backtracking" |
| 0x38–0x39 | 0x36B0 = 14000 | **LPERIOD**, line period (exposure time), unit = pixel count; 5.6 ms measured |
| 0x3A–0x3B | data | AFE data register (see §5) |
| 0x3D–0x3F | 1, 19490, 13228 | **FEEDL**, 20-bit feed length in motor steps |

### Motor
| Reg | Values | Meaning |
|---|---|---|
| 0x5E | 0x01 | DECSEL/STOPTIM |
| 0x5F | 0x01 | FMOVDEC |
| 0x60–0x65 | never written | Z1MOD, Z2MOD: the "remainder value" of the MOD operation in the accel/decel tables. Never set in any capture, so their state comes from whatever preceded the recording |
| 0x67, 0x68 | 0x80 | bits 7:6 STEPSEL / FSTPSEL (step type for scanning and fast moving), bits 5:0 MTRPWM / FASTPWM |
| 0x69 | 0x01 | FSHDEC: deceleration steps at the end of a scan |
| 0x6A | 0x04, 0x46, 0xFF | FMOVNO: accel/decel steps for fast moving, **table four**. 0x46 for the one-step feed, 0xFF for long moves. Multiplied by 2×STEPTIM |
| 0x6B–0x6F | 0x31, 0x4C, 0x80/0x00, 0x4C, 0x80 | GPIO: motor enable, illumination and sensor lines **(inferred)** |
| 0x80 | 0xFF | **(inferred)**; the datasheet's 0x80 is unrelated to motor tables |
| 0x9D | written during boot | RAMDLY, MOTLAG, CMODE, **STEPTIM** (step counts above are multiplied by 2×STEPTIM), MULDMYLN, IFRS |

### AFE and other
| Reg | Values | Meaning |
|---|---|---|
| 0x51 | 0x00–0x07 | AFE register select (see §5) |
| 0x52–0x5A | 0x01…0xC0 | CCD line/phase arrangement constants |
| 0x5B–0x5C | see §4 | RAM address for uploads |
| 0xA6–0xA9 | 0x00, 0x07, 0x20, 0x01 | GPIO direction/state **(inferred)** |

---

## 4. RAM uploads: slope tables and shading

Both are written by setting a RAM address in 0x5B/0x5C, then a bulk OUT transfer whose set-up uses
a different wValue: **0x28 for slope tables**, **0x3C for shading**.

**Address encoding.** `0x5B` holds bits 19:12 of the address, `0x5C` bits 11:4. Each slope upload
writes the pair with bit 0x40 set, transfers, then rewrites `0x5B` with 0x40 cleared. Observed
exactly this sequence in all three captures: `0x58/0x00 → 0x18`, `0x40/0x00 → 0x00`,
`0x48/0x00 → 0x08`, `0x50/0x00 → 0x10`. Bit 0x40 therefore looks like a "slope-table area" select
**(inferred)**.

The **shading upload does not set an address at all**: it follows the last slope upload, so it runs
with `0x5B = 0x10`, `0x5C = 0x00`. Whether that is address 0x10000 or a separate shading area
selected by the cleared 0x40 bit is **not established**; what matters for a replay is that the
register state is inherited, so the uploads must stay in their recorded order.

| 0x5B/0x5C | Address | Table |
|---|---|---|
| 0x40 0x00 | 0x40000 | the datasheet's **table one**: scanning, sized by STEPNO (0x21) |
| 0x48 0x00 | 0x48000 | **table two**: used when the buffer fills (backtracking), sized by FASTNO (0x24) |
| 0x50 0x00 | 0x50000 | **table three** **(inferred: deceleration/stop)** |
| 0x58 0x00 | 0x58000 | the datasheet's **table four**: fast moving, sized by FMOVNO (0x6A) |
| 0x10 0x00 (inherited) | 0x10000 **(inferred)** | shading tables |

There are four tables, and all four are uploaded; nothing is left implicit. Step *counts* (STEPNO,
FWDSTEP, BWDSTEP, FASTNO, FMOVNO, SCANFED) are multiplied by 2 × STEPTIM (register 0x9D).

**Slope table format.** 256 little-endian 16-bit step periods, 512 bytes, in pixel-clock units of
0.4 µs (derived: the table predicts the second positioning move's duration as 3.44 s against 3.45 s
measured). The chip accelerates through the first `0x6A` entries, cruises at the last one used, and
decelerates symmetrically.

Two curves are used, both uploaded to slot 3 at different moments:

| Curve | First entry | Cruise | Rate | Used for |
|---|---|---|---|---|
| fast | 64102 | 625 | 4,000 steps/s | the one-step feed, the second positioning move, and the return home |
| slow | 20325 | 2604 | 960 steps/s | the first positioning move |

**Shading upload.** Written before the main scan, in two bulk transfers (wValue 0x3C). The size scales
with line length: 24,984 B (1440 dpi), 62,464 B (3600), 124,928 B (7200). Content is the vendor's
computed per-pixel correction; the scanner applies it in hardware, which is why image data arrives
already shaded.

---

## 5. Analogue front end

The AFE is reached through registers: write `0x51 = index`, then `0x3A` (high) and `0x3B` (low) as
the value, each access bracketed by `0x8C/0x0F = 0x02`.

| AFE index | Meaning | Final values |
|---|---|---|
| 0x00, 0x01 | configuration | 0xF8, 0x80 |
| 0x02, 0x03, 0x04 | gain R, G, B | prescan and 3600: 0x23/0x1A/0x23; 7200: 0x23/0x1B/0x22 |
| 0x05, 0x06, 0x07 | offset R, G, B | prescan 0x1E/0x2F/0x17; 3600 0x20/0x31/0x1D; 7200 0x1E/0x31/0x19 |

Gains and offsets are both session results; neither is a constant of the model.

**Observed calibration loop.** Offsets and gains are searched, not computed in one step: the vendor
writes extreme values, reads a short 512-pixel strip (frames 0, 1, 3, 4 below), and converges. The
order seen in the prescan capture is: zero the offsets → read → set them to 0xFF → read → mid values
→ read → set gains → read → refine offsets → final gains. **The app does not repeat this**: it
replays the recorded final values, which is why its output depends on the black level and
illumination matching the recorded session (see §9).

---

## 6. Geometry, pacing and the buffer

With `DPIHW = 1200` (derived from the captures):

```
delivered pixels per line = (ENDPIXEL - STRPIXEL) * DPISET / 1200
horizontal dpi            = 7200 * DPISET / 1200          (optical resolution 7200 dpi)
line time                 = (LINESEL + 1) * LPERIOD * 0.4 us      (LINESEL = CCD dummy lines)
motor steps per line      = (LINESEL + 1) * LPERIOD / scan-table cruise period
vertical dpi              = 14400 / motor steps per line
bytes                     = pixels * lines * 6            (16-bit RGB, little endian, interleaved)
scan duration             = delivered lines * line time
required host data rate   = pixels * 6 / line time
```

Per resolution, with the durations the captures actually took:

| | prescan | full 3600 | full 7200 |
|---|---|---|---|
| DPISET | 240 | 600 | 1200 |
| STRPIXEL–ENDPIXEL | 213–10463 | 210–10458 | 210–10458 |
| Pixels × lines | 2050 × 2824 | 5124 × 7058 | 10248 × 14122 |
| LINCNT | 5648 | 14116 | 28244 |
| LINESEL | 0 | 1 | 2 |
| Line time | 5.6 ms | 11.2 ms | 16.8 ms |
| Scan-table cruise | 2800 | 14000 | 42000 |
| Motor steps per line | 5 | 2 | 1 |
| Sampling | 1440 × 2880 | 3600 × 7200 | 7200 × 14400 |
| Carriage travel | 24.9 mm | 24.9 mm | 24.9 mm |
| Main transfer | 34,735,200 B | 216,991,152 B | 868,333,536 B |
| Duration: model / measured | 15.8 / 15.8 s | 79.0 / 79.0 s | 237.2 / 237.2 s |
| **Required host rate** | **2.20 MB/s** | **2.75 MB/s** | **3.66 MB/s** |

`LINCNT` is twice the delivered line count at every resolution, whatever LINESEL is.

**Dropping dummy lines and lengthening exposure.** Both change only the main scan's start write and
its scan tables (slots 0–2: start step 25,252, then the cruise period). To keep the same steps per
line, the cruise period C is scaled with the line time:

```
C' = C · k · (LINESEL' + 1) / (LINESEL + 1)      k = exposure multiplier (LPERIOD' = k · LPERIOD)
```

| Main scan | LINESEL | LPERIOD | Cruise | Line time | 3600 dpi | 7200 dpi | Host rate 3600 / 7200 |
|---|---|---|---|---|---|---|---|
| as recorded | 1 / 2 | 14,000 / 42,000 | 14,000 / 42,000 | 11.2 / 16.8 ms | 79 s | 3 min 57 s | 2.75 / 3.66 MB/s |
| no dummy lines | 0 | 14,000 | 7,000 / 14,000 | 5.6 ms | 39.5 s | 79 s | 5.49 / 10.98 MB/s |
| exposure ×2 | 0 | 28,000 | 14,000 | 11.2 ms | 79 s | — | 2.75 MB/s |
| exposure ×3 (= SilverFast's ME pass, byte for byte) | 0 | 42,000 | 21,000 | 16.8 ms | 118.5 s | — | 1.83 MB/s |
| exposure ×4 | 0 | 56,000 | 28,000 | 22.4 ms | 158 s | — | 1.37 MB/s |

Exposure > 1× also sets BUFSEL (0x20) to 0x08, as the vendor does. Dummy lines do not lengthen the
exposure (the recorded white references, read with 1, 2 and 5 dummy lines, came out at the same level), and
image size, LINCNT and the colour delays are unchanged. The CCD integration time is the line time,
so a k× pass necessarily takes k times a no-dummy-line pass. Each extra complete sequence (an IR
or long-exposure pass) adds recalibration and positioning: ~20 s in the vendor captures (the app's time estimate assumes
~15 s).

**The host must keep up.** MAXWD (0x35–0x37) sets the buffer-full threshold and ACDCDIS (0x02 bit
6) is 0 in every capture, which *enables* backtracking: "If available buffer size < MAXWD, then
buffer full state will be set. The scanner execute backtracking." The carriage then reverses by
BWDSTEP, re-accelerates over table two (FASTNO) and re-scans. A host that cannot sustain the rate
above therefore makes the carriage move back and forth repeatedly — audible, and the scan stalls
rather than finishing. This is why the rate matters most at 7200 dpi.

**The host may also read fewer lines than LINCNT.** The prescan programs 5,648 and reads 2,824;
reading stops, the buffer fills and the scan halts. The delivered image is the first 2,824 lines.

**Scan window.** 213–10463 optical pixels ≈ 36.2 mm across the sensor; the carriage travel used is
24.9 mm at every resolution. The film frame's long side runs across the sensor.

**Colour channel delays.** The sensor's three rows are physically apart, so each channel sees a film
line at a different time. Delay in delivered lines, measured by cross-correlation:

| | R | G | B |
|---|---|---|---|
| prescan (2880 lpi) | 0 | 9.84 | 19.30 |
| full 3600 (7200 lpi) | 0 | 24.22 | 48.21 |
| full 7200 (14400 lpi), scaled from 7200 lpi, not measured | 0 | 48.44 | 96.42 |

They scale with vertical sampling (19.30 × 2.5 = 48.25), i.e. a fixed physical spacing of roughly
12 and 24 lines at 3600 lpi. Align by shifting G and B **earlier** by those amounts; the fractional
part matters (integer rounding leaves up to 0.4 line of colour fringing). On colour negatives
the per-scan cross-correlation is weak (confidence 0.06–0.19: the orange mask decorrelates the
channels), so these calibrated values are the fallback, used when they agree with the profile's
whole-line shifts within one line. Being a physical row spacing, the delays should not depend on
LINESEL or exposure (the 3× capture kept 0/24/48); untested on hardware without dummy lines.

## 7. Scan sequence

The same eight-frame structure at every resolution. Frame numbers match the app's profiles.

| # | Bytes (prescan) | Registers | Purpose |
|---|---|---|---|
| 0, 1 | 3,072 | DPISET 1200, STR 20–532, LINCNT 1, 0x01=0x03, motor off, LED on | 512-pixel strips for AFE offset search |
| 2 | 62,268 | DPISET 1200, STR 20–10398 | full-width white line: the illumination/AFE reference |
| 3, 4 | 3,072 | as 0, 1 | further AFE search steps |
| 5 | 1,574,400 | scan geometry, 128 lines, **LED off** (0x03=0xAF), motor off | dark reference |
| 6 | 1,574,400 | scan geometry, 128 lines, LED on, `0x02=0x10` (motor powered) | white reference |
| 7 | 34,735,200 | scan geometry, LINCNT, `0x01=0x23`, `0x02=0x30` | the image |

Around them:

1. **Boot.** A fixed block of register writes (the app replays it verbatim), then GPIO, then AFE
   configuration. Status reads 0xDC: parked at home.
2. **One-step feed.** `0x03=0xBF`, `0x02=0x18`, `0x6A=0x46`, FEEDL=1, fast table to slot 3, start.
   Status goes 0xDD → 0xF5 → 0xF4 within ~150 ms. One step clears the HOME bit, which shows the
   carriage parks exactly on the sensor edge.
3. **AFE calibration** (frames 0–4).
4. **Dark and white references** (frames 5, 6), then the shading upload and the scan slope tables.
5. **Positioning move 1**: FEEDL 19,490 on the **slow** curve. The vendor **stops it after
   2.560–2.572 s** by writing `0x02=0x08` and `FEEDL=1`, **0.8 ms after the scanner sends event
   `0x08` on its interrupt endpoint** (see "Interrupt endpoint" below); it is an event, not a
   timer. Run to completion the move would take ~20 s. The
   stop moment sets where the frame lands, so it must be timed from the start write.
6. **Positioning move 2**: FEEDL 13,228 on the **fast** curve, run to completion (3.45 s), polled
   until status is 0xF4.
7. **Main scan**: `0x02=0x30` (auto-return), `0x01=0x23`, start; poll 0x41 until BUFEMPTY clears,
   read `0x42`–`0x47`, then the bulk image.
8. **End**: `0x01=0x22` clears SCAN, which triggers the automatic return; poll 0x40, then `0x03=0xBF`
   leaves the LED on. Both captures end while the carriage is still returning.

Positioning moves are identical in all three captures (19,490 then 13,228), so the frame window is
the same at every resolution.

---

## 8. Motor behaviour

- **Steps.** FEEDL counts motor quarter-steps: 14,400 per inch (derived; consistent with the 24 mm
  frame height measured between the film rebates).
- **Stopping a move.** Write `0x02 = 0x08` (motor power off, fast-feed bit kept) and `FEEDL = 1`.
  FEEDFSH appears within ~10 ms, MOTORENB clears 0.12–0.38 s later.
- **Starting.** Never write `0x0F = 1` while MOTORENB is set.
- **Homing.** No capture contains a complete homing; both end mid-return. What is known: the return
  uses `0x02 = 0x30` with the fast curve in slot 3, and parks with the carriage on the sensor edge,
  arriving in reverse. The app reproduces this with recorded primitives: fast reverse until HOME,
  600 steps forward, then a slow reverse approach stopped the instant HOME trips.
- **Direction.** `0x02` bit 0x04 (MTRREV) reverses. The app's homing relies on this.

---

## 9. Consequences for anyone replaying these captures

- **Register reads auto-increment.** Re-address before every read.
- **Pauses are not all idle time.** The pause after the first positioning move is the mechanism that
  positions the carriage.
- **The AFE values are session calibrations.** Gains matched across all three sessions, but offsets
  did not. Replaying them ties the output to the illumination and black level of the recorded
  session; the dark frame (5) and white reads (2, 6) let a host measure the difference and correct
  it. Reference figures: white line R/G/B ≈ 29.3–30.7k / 40.1–40.6k / 33.8–34.5k; dark frame ≈
  980–990 / 1060–1100 / 1122–1237.
- **Shading is applied in hardware**, so image data arrives corrected but only for the uploaded
  table.
- **Image data is linear 16-bit RGB**, not inverted or balanced. Negatives need a density (log)
  conversion; a linear inversion clips dense highlights.
- **The 7200 dpi recording truncates packets at 65,535 bytes**: 46% of its image
  payload is absent, while its control stream is complete. PCAP captured/original
  lengths account for all 402,392,140 missing bytes. This does not establish USB loss. Restore the missing bytes within the original image
  read, before completion polling or scan/lamp shutdown; appending them after teardown
  causes the halfway failure documented in README_CHANGES_AND_FINDINGS.md.

## 10. What is still unknown

- Registers 0x60–0x66 (motor phase/step select): never written in any capture.
- Register 0x40's bits.
- The exact AFE search algorithm (only its observed steps are recorded above).
- Whether the scan window can be moved beyond optical pixel 10463, and what shading would be needed.
- Why the 1× and 3× passes are not exactly proportional near black (CCD/AFE non-linearity, flare, or
  dark current at 3× integration); measured only on one Kodak Gold frame.
- Whether FEEDFSH is set after the app's own homing stop (the polls read 0xDC for the ~10 ms
  observed); the replay no longer depends on it.
- Infrared and long-exposure sequences exist only at 3600 dpi (no 7200 dpi capture), and no
  capture shows dropped dummy lines or exposure > 1× together with buffer-full backtracking.
