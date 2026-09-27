# "ON NOTHING" reactivity: what moves inside a shot, measured (2026-09-27)

Row T1407b (reactivity). The owner: "we're missing a bunch of reactivity… the streaks are flickering
with beat or something… there's much more motion in most frames in terms of lights or layering."
The edit between clips (strobe cuts between angles, flash frames) is now done in loom as per-cut
**parts** in `edl.json` (cut.py, main 5ad2d202). This doc covers what happens INSIDE a shot, and
lists the few overlays and dissolves that cannot be one clip. Scope, at the lead's refocus: the
first 42 s (rows 1–37), verified on the built rows 1, 2, 17, 22, 25, 26 and 35.

Companion docs: [look reference](on-nothing-look-reference-2026-09-27.md),
[shots plan](on-nothing-shots-plan-2026-09-27.md), [shot list](on-nothing-shotlist-2026-09-27.md).

## The answers first

1. **The streak columns flicker, each column on its own, every frame, and it is free-running.**
   In a continuous dark shot the streak energy moves by about 10 % a frame (sd after the slow
   trend is removed; median 0.092 over 17 continuous shots, range 0.016–0.27) with no
   frame-to-frame memory (lag-1 autocorrelation −0.03). Ours moved by 0.4–0.6 %. The flicker
   does not lock to the beat grid, the backbeat, or loom's snare or hat lanes (every |z| < 1.5).
   Its depth does not follow the song's loudness either (correlation 0.12 with level, −0.40
   with onset density). What the owner reads as "with the beat" is a fast, irregular flicker.
2. **One lane does line up: loom's kick lane.** On a kick-lane hit the columns reach further,
   from the hit's own frame, and are half gone two frames later: +0.18 frame heights in the first
   42 s (z 4.1, n 9) and +0.06 over the whole song (z 3.7, n 34). The kick lane is sparse (17
   hits in 42 s), so this is a rare pop, not a pulse.
3. **The lamps' light on the room flickers with the columns.** Everything except the columns and
   the clipped cores moves by 2–10 % a frame (median 0.065); ours moved by 0.5 %.
4. **Exposure pulses, camera jolts and cuts are not on the beat.** Exposure pulses show |z| ≤ 1.4
   against every event train, and shake shows |z| ≤ 0.7. 24 % of the cuts land within ±1 frame
   of a beat, against 33 % by chance. Flash frames (29 in 42 s) sit at cuts: 23 of 29.
5. **Layering is mostly editorial.** The "layered" rows (9–11 and 16: 4.4–9.7 s and
   13.1–15.3 s) alternate 2–3 takes every 1–3 frames, each at its own exposure. A two-source
   mix fit finds only **2 true blend frames** in 42 s, both one-frame 50/50 dissolves. The one real
   overlay is a build-up of four hand takes over black at the end of row 17 (16.52–17.39 s).
   Frame echo (ghost trails) appears in the cyc at 1:17 (ghost opacity 0.53, darken), which the
   cyc shot already does. It does not appear in any built row of the first 42 s.

So the hook (`src/projects/on-nothing/shots/react.ts`) adds three things. The first is a free-running
per-column flicker of the streak glass, with rare column pops. The second is a flicker of the lamps
(headlight projectors and haze) that shares the columns' global term. The third is a short reach on
the kick lane. It adds no beat pulse, no camera jolt and no echo, because the reference has none of
them in these rows.

## Method

- The song: loom's own analysis (`walkTrack`, the one the renders hear) dumped per reference frame
  to `renders/on-nothing/agents/react/audio-lanes.csv`. It was cross-checked with a numpy STFT: a
  comb search over the flux finds **156.0 BPM**, beat one at 0.106 s, so a beat is 0.385 s =
  9.22 frames at 23.976. Per 16th-note slot, the snare/clap band (1.5–5 kHz) peaks on slots
  0 and 8, a backbeat every 2 beats (18.4 frames). Hats fall on the 8ths. The sub band is a
  sustained 808 with no clean kick transient.
- Loom's lanes over the song are 59 kick, 224 snare and 409 hat hits. Half-bar phase shows that
  **the snare lane is the backbeat**: 122 of 224 hits fall in the first quarter of a 2-beat
  cycle, landing 0–2 frames after the grid line (the analysis's trailing window; renders read
  2 frames ahead). The kick lane is sparse and off-grid.
- The picture: the reference decoded to 384×164, then measured per frame. Measurements are mean
  luma, "ambient" (mean excluding the streak mask and clipped pixels), and the top 0.2 % luma.
  The streak mask is vertical runs of ≥ 12 rows (7 % of the height) above luma 0.3, from which
  come area, mean brightness, 75th-percentile run length (the reach) and energy (brightness ×
  area). Shake is the global image shift by phase correlation. Cuts are ffmpeg scene score
  > 0.3 (a stricter 0.2 for "continuous"). A stack of our row clips is placed on the same frame
  grid and measured the same way.
- Correlation: the event-triggered average of each detrended measurement (minus a centred 7–9
  frame median, inside a shot only) around each event train, against 400 random draws of the
  same count (z-score). The beat-lock per shot uses circular shifts of the train.
- Scripts are kept out of the repo (the scratchpad `react/`): `decode.py`, `measure.py`,
  `analysis.py`, `rows.py`, `segs.py`, `pops.py`, `overlay_detect.py`, `plot.py`.

## 1. Streak columns

**Flicker per continuous dark shot** (no scene score over 0.2, ≥ 12 frames, mean luma < 0.3).
The flicker values are sd of the detrended value divided by the mean. The layered rows 9, 10, 11
and 16 (flicker 0.32–0.61) are left out. Their "flicker" is takes alternating, and it is in the
next table.

| row | in (s) | frames | streak energy | streak flicker | lag-1 autocorr | ambient flicker | exposure flicker |
|---|---|---|---|---|---|---|---|
| 1 | 0.38 | 29 | 0.141 | 0.070 | −0.01 | 0.045 | 0.046 |
| 2 | 1.63 | 17 | 0.028 | 0.023 | +0.91 (a ramp, not flicker) | 0.023 | 0.023 |
| 13 | 10.14 | 22 | 0.134 | 0.121 | −0.27 | 0.057 | 0.077 |
| 14 | 11.64 | 16 | 0.151 | 0.080 | +0.43 | 0.066 | 0.054 |
| 17 | 15.52 | 24 | 0.016 | 0.089 | −0.05 | 0.021 | 0.029 |
| 17 (insert) | 16.56 | 20 | 0.096 | 0.141 | +0.03 | 0.094 | 0.114 |
| 18 | 17.52 | 21 | 0.105 | 0.097 | +0.12 | 0.178 | 0.107 |
| 19 | 18.44 | 76 | 0.062 | 0.051 | −0.29 | 0.029 | 0.034 |
| 20 | 21.65 | 37 | 0.188 | 0.099 | −0.16 | 0.057 | 0.061 |
| 21 | 23.23 | 16 | 0.074 | 0.127 | +0.05 | 0.028 | 0.051 |
| 22 | 23.94 | 17 | 0.099 | 0.096 | −0.04 | 0.085 | 0.079 |
| 24 | 25.82 | 19 | 0.100 | 0.087 | −0.30 | 0.075 | 0.073 |
| 24 | 26.65 | 24 | 0.150 | 0.213 | +0.48 | 0.108 | 0.119 |
| 27 | 29.95 | 12 | 0.052 | 0.016 | +0.68 | 0.008 | 0.008 |
| 28 | 30.49 | 16 | 0.168 | 0.039 | +0.06 | 0.042 | 0.026 |
| 30 | 31.95 | 16 | 0.100 | 0.019 | +0.65 | 0.017 | 0.008 |
| 33 | 34.03 | 87 | 0.051 | 0.217 | −0.03 | 0.057 | 0.088 |
| 35 | 40.17 | 16 | 0.126 | 0.232 | +0.73 (the flare swelling) | 0.105 | 0.152 |
| 37 | 41.58 | 19 | 0.132 | 0.266 | −0.11 | 0.097 | 0.149 |
| **median** | | | 0.099 | **0.092** | −0.03 | **0.065** | 0.062 |

**The layered rows:** streak flicker 0.52 (row 9), 0.61 (10), 0.32 (11) and 0.46 (16), and exposure
flicker 0.21–0.29. These are takes alternating, not light (section 4).

**Pops.** A column's reach jumps ≥ 0.25 frame heights, or its energy ×1.6, for ≤ 4 frames and
then falls back. There are 31 pops in 42 s, 1–4 frames long (median 1). By time: 3.13–9.43 s
(16, most inside the layered rows), 13.26–14.10 (5), 21.81–22.36 (3) and 33.53–37.00 (7). Their
beat phase is uniform (median |phase| 0.27 against 0.25 by chance). 16 % land within 1 frame of a
beat (chance 33 %), 13 % of a kick-lane hit and 42 % of a hat-lane hit (chance about 35 %). So
they are free-running. The big ones: 33.53 s (reach +0.68 for 2 frames), 34.58 s (+0.68 for 4
frames), and 22.23 and 22.36 s (+0.33, +0.37).

**Against the song (event-triggered, in-shot, 0–42 s).** Peak is in the measurement's units, lag
is in frames after the event, and half-decay is in frames after the peak.

| measure | event | n | peak | lag | z | half-decay |
|---|---|---|---|---|---|---|
| streak energy | beat grid | 46 | +0.0038 | 0 | +0.3 | 1 |
| streak energy | backbeat | 23 | +0.0062 | 0 | +1.0 | 1 |
| streak energy | kick lane | 9 | +0.0164 | 0 | **+3.1** | 1 |
| streak energy | snare lane | 28 | +0.0043 | 3 | +0.2 | 1 |
| streak energy | hat lane | 61 | +0.0031 | 0 | +0.1 | 1 |
| streak reach (frame heights) | beat grid | 44 | +0.033 | 0 | +0.9 | 1 |
| streak reach | backbeat | 22 | +0.029 | 0 | +0.0 | 1 |
| streak reach | kick lane | 9 | +0.180 | 0 | **+4.1** | 2 |
| streak reach | snare lane | 27 | +0.010 | 2 | −1.1 | – |
| streak reach | hat lane | 58 | +0.023 | 0 | +0.1 | 1 |
| streak brightness | kick lane | 9 | +0.023 | 0 | +1.4 | 2 |
| streak brightness | all others | | ≤ +0.006 | | ≤ +0.1 | |

Whole song for comparison: streak reach on the kick lane +0.064, z +3.7, n 34, half-decay 2.
Streak energy on the backbeat grid +0.009, z +2.1. Every other pairing has |z| < 2.

## 2. Exposure pulses and flash frames

| measure | event | n | peak (luma) | lag | z | half-decay |
|---|---|---|---|---|---|---|
| exposure (mean luma) | beat grid | 57 | +0.010 | 3 | +0.8 | 1 |
| exposure | backbeat | 28 | +0.016 | 1 | +1.4 | 3 |
| exposure | kick lane | 11 | +0.011 | 0 | −0.2 | 1 |
| exposure | snare lane | 36 | +0.005 | 2 | −0.9 | 2 |
| exposure | hat lane | 76 | +0.008 | 2 | +0.3 | 2 |

No exposure pulse on any hit. Over the whole song, only row 107 (the driver, 1:57–2:03) pulses on
the beat: the window light goes from 0.10 to 0.2–0.27 luma for 2 frames, z 2.9 on the grid and
2.4 on the backbeat. It is outside this scope.

**Flash frames**, 0–42 s. A flash frame's mean luma rises > 0.12 over the frames 2–3 either
side. These go to the parts, not the chain. Frame numbers are 0-based at 23.976 fps.

| t (s) | frame | frames long | peak luma | rise | at a cut | beat phase |
|---|---|---|---|---|---|---|
| 2.88 | 69 | 1 | 0.43 | +0.16 | yes | +0.21 |
| 3.00 | 72 | 1 | 0.39 | +0.16 | yes | −0.47 |
| 3.46 | 83 | 1 | 0.38 | +0.15 | yes | −0.27 |
| 3.88 | 93 | 1 | 0.40 | +0.17 | no | −0.19 |
| 4.00 | 96 | 1 | 0.56 | +0.23 | yes | +0.13 |
| 4.13 | 99 | 1 | 0.55 | +0.35 | yes | +0.46 |
| 4.30 | 103 | 1 | 0.32 | +0.15 | yes | −0.11 |
| 4.42 | 106 | 1 | 0.51 | +0.31 | yes | +0.22 |
| 9.72 | 233 | 2 | 0.35 | +0.25 | yes | −0.01 |
| 9.84 | 236 | 2 | 0.39 | +0.26 | yes | +0.32 |
| 10.09 | 242 | 1 | 0.26 | +0.12 | no | −0.03 |
| 12.43 | 298 | 3 | 0.65 | +0.26 | no | +0.04 |
| 13.10 | 314 | 1 | 0.55 | +0.41 | yes | −0.22 |
| 15.39 | 369 | 2 | 0.29 | +0.21 | yes | −0.26 |
| 17.39 | 417 | 2 | 0.47 | +0.32 | yes | −0.06 |
| 25.07 | 601 | 4 | 0.66 | +0.24 | yes | −0.10 |
| 25.27 | 606 | 2 | 0.41 | +0.13 | yes | +0.44 |
| 25.73 | 617 | 2 | 0.35 | +0.13 | yes | −0.37 |
| 27.15 | 651 | 1 | 0.37 | +0.14 | no | +0.32 |
| 27.65 | 663 | 1 | 0.64 | +0.31 | yes | −0.38 |
| 29.03 | 696 | 7 | 0.93 | +0.52 | yes | +0.20 |
| 29.36 | 704 | 2 | 0.90 | +0.37 | yes | +0.07 |
| 29.70 | 712 | 2 | 0.85 | +0.34 | yes | −0.07 |
| 29.86 | 716 | 1 | 0.51 | +0.18 | yes | +0.37 |
| 30.66 | 735 | 7 | 0.43 | +0.18 | yes | +0.43 |
| 31.36 | 752 | 1 | 0.37 | +0.14 | no | +0.27 |
| 31.78 | 762 | 1 | 0.35 | +0.13 | no | +0.36 |
| 40.08 | 961 | 2 | 0.56 | +0.19 | yes | −0.06 |
| 41.17 | 987 | 1 | 0.40 | +0.13 | yes | −0.24 |

The 6 in-shot flashes (3.88, 10.09, 12.43, 27.15, 31.36 and 31.78 s) are 1–3 frames long with a
rise of +0.12–0.26, at random beat phase. At about one every 7 s they are too rare to model as a
lane.

## 3. Lamp flicker

The clipped cores give no information: the top 0.2 % of luma sits at 1.0, and the clipped area
shows |z| ≤ 1.9 against everything. The lamps' flicker shows in the room they light. Ambient
flicker has a median of 0.065 per frame in the continuous dark shots (table in section 1), and it
moves with the columns: the same shots that flicker hard in the columns flicker hard in the
ambient (rows 22, 24, 33, 35 and 37). It is not on the beat (exposure table above).

## 4. Layering: overlays, dissolves, echo

- **Alternating takes, rows 5–11 and 16.** In 3.0–9.7 s and 13.1–15.3 s, 2–3 angles alternate
  every 1–3 frames, each at its own exposure. For example, rows 9–11 cut between the dark wide
  tableau, the phone MCU and the lit wide. Row 16 keeps the tube wall and changes the
  foreground take. Frames that look like double exposures are mostly one take at a lower
  exposure: a two-source mix beats the best scaled single source by 40 % on only 2 frames of
  998. **These are parts (one clip per cut), not overlays.**
- **True one-frame dissolves**, which cannot be one clip: frame **439** (18.31 s, row 18, just
  before the row 19 cut) = 0.53 × f438 + 0.51 × f440. Frame **974** (40.62 s, inside row 35) =
  0.51 × f973 + 0.49 × f975.
- **Layer build-up, row 17's tail, frames 396–416** (16.52–17.35 s): hand-and-pistol takes
  stacked over black, lighten or screen, each new layer entering whole. Lit area steps
  0.10 → 0.20 at f402 → 0.24 at f406 → 0.27 at f410 → 0.34 at f413. That is layers 2–5 at 6, 4, 4
  and 3 frame intervals, not on the grid. The row then ends with a 2-frame flare flash
  (f417–418, luma 0.47) and a cut at f419.
- **Echo (ghost trails)**: the 1:17 cyc (row 72) ghosts the swinging foot at opacity
  **0.53** (sampled: ghost 0.32, floor 0.59, shoe 0.08), dark on white, a few frames behind.
  That is the cyc's ECHO (amount 0.55, darken 1). No built row in 0–42 s shows echo, so the hook
  adds none.

## 5. Camera shake

Shake is the image shift per frame by phase correlation, in px at 1920 wide. The medians per
shot are 0.2 (row 17, locked), 4.8 (row 2), 7.9 (row 35), 10.8 (row 22, the zoom) and
5–25 for the handheld inserts. Against the song, every |z| ≤ 0.7 (image speed: grid +0.2,
backbeat +0.7, kick +0.5, snare 0.0, hat −0.9). **The operator does not jolt on hits**, so the
hook does not touch the camera (`shots/handheld.ts` is unchanged).

## 6. Cuts against the beat

There are 45 cuts in 0–42 s (scene > 0.3). The median |beat phase| is 0.22 (uniform: 0.25), and
24 % land within ±1 frame of a beat (chance: 33 %). The edit does not cut on the beat either.

## What was built

`src/projects/on-nothing/shots/react.ts`:

- `STREAK_FLICKER_WGSL`: a pass over the streak glass's output, before the optics composite adds
  it back. The frame is cut into `bands` columns (16). Every 24 fps frame, each band's gain is
  `1 ± depth` (uniform), and with chance `popChance` it pops by `+pop`. The gain is interpolated
  across band edges. The whole glass is also multiplied by `gain`, an expression carrying the
  lamps' flicker and the kick lane. Everything steps per output frame (`floor(absTime × 24)`),
  so the 8 sub-frames of a `--final` render share one value and motion blur does not average
  the flicker away.
- `reactive(nodes, edges, profile, song)`: adds the pass. When a song is present it also adds
  the kick lane (`valueSelect kickCount` → `valueBeat`: threshold 0.5, retrigger 0.1 s, a linear
  tail of 0.12 s, so the pop is half gone after 1.5 frames). `lamp(base)` returns a lamp
  brightness that flickers with the room.
- `REACT_PROFILES`: `tableau` = depth 1.2, 16 bands, pop +1.4 at 1.2 %/band/frame, lamp ±0.15,
  kick +0.8. `title` = lamp ±0.5 on the whole glass. Both are tuned against the tables below.
- `flicker(base, depth)`: the same flicker as one expression, for a chain with a stock Streak
  node.

Hooked into:

- `document.ts` (the shared chain: tableau, zoom and wheel, plus halo and crt, which build on
  it). It adds one import and one `reactive(...)` line, then uses `react.lamp(2.5)` on the
  projectors, `react.lamp(0.25)` on the haze's head term, and `react.streak(["streak2", "out"])`
  into the optics composite. The split's plates build on the same chain with `audio: false`, so
  they flicker without the kick. Row 25 measures the same as before (exposure flicker 0.014
  against 0.015).
- `shots/title.ts`: one import, and `gain: flicker(0.8, REACT_PROFILES.title.lamp)` on the stock
  Streak.

The rest are not wired, because each needs more than a one-line call:

- `ring.ts` (row 2) is already livelier than the reference: a slow ramp, streak flicker 0.08
  against 0.02.
- `prism.ts` (row 26) and `split.ts` (row 25) are white or bright, with no streak columns
  measured.
- `quad.ts`, `cyc*.ts`, `closeups*.ts`, `crt.ts`, `mirror.ts` and `wheel.ts` are outside the
  first 42 s. The `ShotGraph.optics` chains (prism, quad and others) can opt in by redirecting
  the composite's `optics-more0` edge through `reactive(...).streak(["streak2", "out"])`.

## Verification (final renders with the song, rows 1, 2, 17, 22, 25, 26, 35)

The rows were rendered as cut.py renders them: each row's `--audio-start`, `--final`, 1920
wide, into `renders/on-nothing/agents/react/final/`. They were measured on the reference's
frame grid. "Before" is the shared `rows/` clips of 2026-09-27 23:37.

Continuous shots, same frames as the reference:

| row | streak flicker ref / before / after | ambient flicker ref / before / after | exposure flicker ref / before / after |
|---|---|---|---|
| 1 title | 0.070 / 0.008 / 0.084 | 0.045 / 0.005 / 0.017 | 0.046 / 0.006 / 0.043 |
| 2 ring (not hooked) | 0.023 / 0.090 / 0.078 | 0.023 / 0.066 / 0.047 | 0.023 / 0.069 / 0.053 |
| 17 tableau | 0.089 / 0.004 / 0.110 | 0.021 / 0.004 / 0.044 | 0.029 / 0.002 / 0.050 |
| 17 (16.56) | 0.141 / 0.004 / 0.106 | 0.094 / 0.006 / 0.045 | 0.114 / 0.002 / 0.065 |
| 22 zoom | 0.096 / 0.003 / 0.100 | 0.085 / 0.003 / 0.048 | 0.079 / 0.001 / 0.043 |
| 35 halo | 0.232 / 0.374 / 0.314 (all three a slow swell, lag-1 ≥ 0.73) | 0.105 / 0.089 / 0.016 | 0.152 / 0.190 / 0.125 |
| **median (1, 17, 22)** | **0.092 / 0.006 / 0.103** | **0.065 / 0.005 / 0.044** | 0.062 / 0.004 / 0.052 |

Whole rows: row 25 split has exposure flicker 0.011 / 0.015 / 0.014, and row 26 prism has no
streak columns (unchanged).

- The streak-energy curves on the beat grid, reference against before and after, with the kick
  and snare lanes marked: `renders/on-nothing/agents/react/streak-curves-final.png`
  (`streak-curves-draft.png` is the 960 draft).
- The kick lane, isolated: row 17 rendered with the column flicker off. The upper streak band
  rises 35 % on frames 19–21 (16.10–16.19 s) for the kick-lane hit at 16.18 s (read 2 frames
  ahead) and is back by frame 22.
- Six frames side by side (reference above, ours below):
  `renders/on-nothing/agents/react/compare-row17-6frames.png`.

What the numbers do not cover:

- The streak LEVEL differs from the reference (row 17's wide: 0.016 against our 0.036; row 22:
  0.099 against 0.037). That is the look's reach and threshold, not reactivity.
- Row 1's ambient stays under the reference (0.017 against 0.045). The title's lamps are not
  hooked; only its glass is.
- Under `--final`, the render's `--trail 0.5` (a lighten echo of the previous frame) is on. The
  phase-correlation shake of the final rows reads near zero (rows 26 and 35: 0.02 and 0.05
  against 8.6 and 0.9 in the drafts). The shake numbers above are therefore from drafts. The trail
  itself is an echo the reference does not show in these rows (section 4). Worth a look by
  whoever owns render.ts.

## For Resolve (only what cannot be one clip), 0–42 s

Strobe cuts between angles and flash frames are parts in `edl.json` (the flash table in section
2 gives their frames). What is left for the NLE:

| row | frames (0-based, 23.976) | t (s) | what | how |
|---|---|---|---|---|
| 17 | 396–416 | 16.52–17.35 | hand-and-pistol takes stacked over black, entering at f396, f402, f406, f410, f413 | 5 video tracks, lighten or screen, each layer cut in on its frame at full opacity |
| 17 → 18 | 417–418 | 17.39–17.43 | a 2-frame flare flash (luma 0.47) over the cut | a part, or an additive flare clip |
| 18 → 19 | 439 | 18.31 | a one-frame 50/50 dissolve (0.53 f438 + 0.51 f440) | a 1-frame cross dissolve on the cut at f439/440 |
| 35 | 974 | 40.62 | a one-frame 50/50 dissolve (0.51 f973 + 0.49 f975) | a 1-frame cross dissolve |

## Gaps (proposed rows)

- **Per-column reach, not only gain.** Our columns flicker in brightness. In the reference a
  column's reach changes too, and a pop shoots to the frame top. Wanted: a per-column reach
  input on the streak glass (a stock Streak "length map"), so a pop is a taller column rather
  than a brighter one.
- **The title's lamps.** Wanted: hook the title's flank lamps through `react.lamp` so its ambient
  flicker reaches the measured 0.045.
- **A song clock in the document.** A declared-tempo beat channel on a row that starts mid-song
  needs the row's song offset (render.ts has `--audio-start`; the document does not). Wanted:
  `OnNothingOptions.songTime`, so grid-locked effects (row 107's window pulses, 1:57) can be
  built when that row is in scope.
