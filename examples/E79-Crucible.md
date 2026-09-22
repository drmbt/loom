# E79 — Crucible

A white-hot ring at the centre of a black void, seen down a tunnel of machinery: three tiers
of dark ribbed modules around the ring — an inner ring of tangential modules, a wide field of
radial teeth, foreground giants nearest the lens — about a hundred and ninety in all, snapped
to angular sectors and turning slowly as tiers, with amber and green strips at their stations.
A few hundred shards drift past beside the ring. Red haze flares on the hit. A cool key and a
hot back rim, both casting shadows, rake the ribs; the ring's own point light punches on every
hit. The lens swoops on a spherical orbit: radius breathing 15 to 27, azimuth swinging across
the front, elevation dipping to a low angle looking up through the teeth.

The example exists for its VALUE CHAIN — the one an Unreal audio graph showed and this tool
could not express before T1347b/T1348b: a spectrum row picked off the source, put onto 0..1
by its measured occupied range, and turned into a beat or a tail.

```
clip1(audioFileIn) ─ band109x1(valueSelect) ─ beatrange1(valueRange) ─ beat1(valueBeat)
clip1(audioFileIn) ─ band968x1(valueSelect) ─ tailrange1(valueRange) ─ tail1(valueTail)
```

`beat1` flashes the halo from ember to white, lights the rib seams on every hull and throws a
shard wave; through `punch1` (a 50 ms attack) it drives `halolight1` (8 to 118, the light every
hull face turned toward the ring receives) and the haze flare, so a hit punches rather than
strobes. `tail1` pushes every orbit round, swells the tube, breathes the green
windows and the accent light. The four Range bounds are measured on the shipped clip —
`band109` rests at 0.30–0.35 and peaks near 0.60 on each kick, `band968` lives in 0.42–0.50 —
so Beat's 0.5 threshold sits above every rest frame and below every kick. A different track
retunes those four numbers and nothing else.

The hulls are eight point grids of 24 bodies each — one grid, many bodies, the first and last
row of each body collapsed to a point so neighbours never join, two rows in each end plane so
the caps are flat faces — with hard box corners from duplicated corner columns, ribs across the
length, a channel down each broad face and lit strips at the stations. Nothing tumbles: each
tier turns as one, the shards drift, the ring's heat travels, the camera swoops, all on absolute
time, so silence still moves; the audio adds on top.

Visual control: [E79 reference](references/E79-Crucible-reference.png).
