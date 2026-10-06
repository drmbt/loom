# E79 — Crucible

A white-hot ring in a black void with a sphere inside it: eight belts of steel plates turning
against each other, splitting apart along the axis on every hit and closing through the punch,
twisting and squaring off toward a superellipsoid on the tail lane, over a lava heart whose
surface flows and cracks white-hot. Around it, a hierarchy of machinery: a hundred small
ribbed modules hugging the ring, three dozen mid hulls deep behind it receding into the fog, a
handful of giants cutting the frame's edges, dust drifting past. Five coloured lights sit among
the hulls, each on its own spectrum row, so different corners of the structure light to
different parts of the music. A slow orbit looks slightly up at the core.

The example exists for its VALUE CHAINS — the ones an Unreal audio graph showed and this tool
could not express before T1347b/T1348b: a spectrum row picked off the source, put onto 0..1 by
its measured occupied range, and turned into a beat or a tail.

```
audiofile_clip(audioFileIn) ─ select_band109(valueSelect) ─ range_beat(valueRange) ─ beat1(valueBeat) ─ lag_punch(valueLag)
audiofile_clip(audioFileIn) ─ select_band968(valueSelect) ─ range_tail(valueRange) ─ tail1(valueTail)
audiofile_clip(audioFileIn) ─ select_band380(valueSelect) ─ range_band380(valueRange) ─ tail_band380(valueTail)
audiofile_clip(audioFileIn) ─ select_band1300(valueSelect) ─ range_band1300(valueRange) ─ beat_band1300(valueBeat)
audiofile_clip(audioFileIn) ─ select_band3400(valueSelect) ─ range_band3400(valueRange) ─ tail_band3400(valueTail)
```

`beat1` (109 Hz) flashes the halo from ember to white and lights the core's plate edges;
through `lag_punch` (a 50 ms attack) it drives `light_halo` and the haze flare and splits the
belts, so a hit punches rather than strobes. `tail1` (968 Hz) twists and squares the core and
drives the green `light_accent`. `tail_band380` drives the amber `light_amber` deep left and the
inner modules' strips; `beat_band1300` the white-blue `light_flash` high right and the mid hulls'
strips; `tail_band3400` the cyan `light_cyan` low behind and the giants' strips. Every Range's
bounds are measured on the shipped clip (band109 rests 0.30–0.35 and peaks ~0.60 per kick;
band968 0.42–0.50; band380 0.32–0.78; band1300 0.46–0.58; band3400 0.27–0.33). A different
track retunes those numbers and nothing else.

The hulls are six point grids of 24 bodies each — one grid, many bodies, the first and last row
of each body collapsed to a point so neighbours never join, two rows in each end plane so the
caps are flat — drawing only a share of their bodies, because what is left out is the
composition. Each tier turns as one and breathes its radius, the lit stations chase along the
bodies, the giants drift in depth, the ring's heat travels, the camera orbits — all on absolute
time, so silence still moves; the audio lights things and opens the core, and moves nothing
else.

Visual control: [E79 reference](references/E79-Crucible-reference.png).
