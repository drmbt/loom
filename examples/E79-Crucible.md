# E79 — Crucible

A white-hot ring hangs in a dark eight-bay hangar and is the scene's key light. Six blocky
panelled hulls turn on two orbits around it, lit by the ring's own point light and a dim cool
key with shadows; ember debris drifts through red haze; the wet floor carries all of it.

The example exists for its VALUE CHAIN, which is the one an Unreal audio graph showed and this
tool could not express before T1347b/T1348b: a spectrum row picked off the source, put onto
0..1 by its measured occupied range, and turned into a beat or a tail.

```
clip1(audioFileIn) ─ band109x1(valueSelect) ─ beatrange1(valueRange) ─ beat1(valueBeat)
clip1(audioFileIn) ─ band968x1(valueSelect) ─ tailrange1(valueRange) ─ tail1(valueTail)
```

`beat1` flashes the halo from ember red to white, drives `halolight1`'s intensity (3 to 63, the
light the hulls receive) and the hulls' seam glow. `tail1` pushes the orbit round, lifts the
bodies and swells the ring's tube. The four Range bounds are measured on the shipped clip —
`band109` rests at 0.30–0.35 and peaks near 0.60 on each kick, `band968` lives in 0.42–0.50 —
so Beat's 0.5 threshold sits above every rest frame and below every kick. A different track
retunes those four numbers and nothing else.

The orbit and the ring's travelling heat run on absolute time, so silence still moves; the
audio adds on top. The stage is E75 Resonance's (analysis, projection atlas, depth-aware
compositing, wet floor, haze, DOF, bloom, FXAA) with the projection dimmed to a glow and the
audience removed.

Visual control: [E79 reference](references/E79-Crucible-reference.png).
