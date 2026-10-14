# grandMA3 show → stage previz (VN123)

This is a rough first pass. It replays a grandMA3 timecode show in the stage previz by baking the
pixel lines and JDC strobes into the FX-feed video layout. It adds no Loom engine code: the
session plays the bake through `movie_ma3FX` (StageFeeds, Source FX = 3), with the song on
`audiofile_reference`.

## 1. Dump the show (onPC, read-only)

1. Load the `.show` in grandMA3 onPC (2.5.1 here).
2. Edit `OUT` at the top of `ma3dump.lua` and `ma3dump2.lua`. The directory must exist, and
   `ma3dump2.lua` also needs `<OUT>/presets`.
3. On the command line, run:

```
Lua "dofile('/abs/path/tools/ma3/ma3dump.lua')"
Lua "dofile('/abs/path/tools/ma3/ma3dump2.lua')"
```

`obj:Export` writes one MA3 XML per object: sequences, timecodes, macros, groups, presets and so
on. Nothing in the show changes. `_patch.tsv` lists every fixture.

The patch with positions comes from the show's MVR export instead
(`gma3_library/mvr/*.mvr`, `GeneralSceneDescription.xml`). `projects/stage-previz/ma3/ma3-patch-10.12.csv`
is that patch. Its `previz_*` columns are previz metres: MVR Y − 4.79 m, with X and Z as they are.
The offset was fitted on the pixel-line rows and the strobe grid.

## 2. Bake

```bash
python tools/ma3/bake_fx.py --export <dump dir> --timecode TwentyfiveEight \
  --tc-start 3:00:00 --duration 190.9 --out public/media/stage-previz/ma3/twentyfiveeight-fx.mp4
```

It needs numpy and ffmpeg. `--tc-start` is the timecode at the audio's first sample (the LTC
reference WAVs carry it in their names). `--flip-pl` reverses the pixel-line cell order, because
the GDTF does not say which end is cell 1. `--audio <wav>` muxes a reference copy for side-by-side
viewing.

## What the bake models, and what it does not

- **Events:** timecode Goto and Go+ events. The sequence comes from `ValCueDestination`, so it
  works per song even though every song has its own "Kick 1".
- **Cues:** tracking, `CueInFade`, an `Off Sequence N` cue command plus the OffCue fade (how the
  hit sequences flash), and LTP between sequences.
- **Phasers:** dimmer steps with speed (raw / 2^24 = cycles per second), phase, width and
  transition. This is an approximation of MA's phaser engine, not a copy.
- **Pixel Line IP, Mode 10:**
  - master × sub 1 group × cell `fid.1.k` dimmer × RGB, for 32 cells
  - plus white cell `fid.2.⌈k/2⌉`, for 16 cells
  - each bar is painted over the previz bar's span, so its 39 texels resample the 32 cells
- **JDC Burst 1, Mode 3:** the mean of the 12 RGBW plate cells (`fid.4.k`) plus the 12 tube cells
  (`fid.3.k`), painted as one window. 4 of the 42 Bursts have no window in the r2 layout:
  FIDs 409–412, at previz y ≈ −0.17 m.
- **Not modelled:** strobe/shutter channels, MAtricks, preset resolution (it uses the values the
  show cooked into the cues), moving lights and the house rig, and calibration or gamma.

`projects/stage-previz/ma3/gdtf-fixtures.json` holds the channel and cell maps parsed from the
show's GDTFs.
