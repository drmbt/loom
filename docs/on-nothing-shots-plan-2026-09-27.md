# "ON NOTHING" shots: plan (2026-09-27)

Owner brief (2026-09-27): take the look breakdown in
[on-nothing-look-reference-2026-09-27.md](on-nothing-look-reference-2026-09-27.md) and build it out
so loom renders a few different shots. Real time is welcome, fidelity comes first. The scene is its
own project, like the furnace. Every render and every reference frame goes to the gitignored
`renders/on-nothing/` inside the repo, so nothing has to be hunted for.

Owner decisions: the subjects are procedural SUV-class cars and a mannequin figure built in Blender
(no brand likeness, no performer likeness); all four shots below; own project, not a shipped example.
Umbrella row: T1400b.

## What the reference actually shows (read from the frames, not from the breakdown)

The reference video sits at `renders/on-nothing/reference/ref.mp4`, with 1 fps contact sheets in
`sheets/` and full-size key frames in `key/`. Reading them changed three things in the breakdown:

- **The "vertical LED columns" are mostly the streak filter.** Every headlight and floor-level lamp
  is smeared UPWARD into a wide, soft-edged column as wide as the source, fading over a third of the
  frame, with fine vertical striations inside it. A few real tubes exist, but the signature is the
  optical smear. The smear sits over the subject too: a column crosses the figure's torso.
- **The frame is 2.35:1** (1920×818), with a heavy vignette, soft and smeared edges (a swirl or
  field-curvature blur outside the centre third) and barrel distortion on the wide shots.
- **The warehouse is not pure black.** Trusses and the roof read at about 2–4 % in the wide shots,
  and the floor carries a faint warm cast where the headlights hit it. Pure black is reserved for
  the close-ups and the silhouette shot.

Other measured traits: headlights clip to white with a round halo; floor reflections of the
headlights are long and vertical (a damp, glossy floor); the palette is neutral grey with a cold
teal lift only in the silhouette shot; skin and warm tones are nearly gone; the grain is fine and
visible in the blacks.

## The four shots

| shot | reference | camera | set | what must read |
|---|---|---|---|---|
| `tableau` | 0:07, 0:16, 0:19 | 24 mm, 1.1 m high, dead centre, locked off (slow push) | blackout warehouse, five SUVs in a shallow arc facing the lens, figure in front of the centre car | headlight columns, beams in haze, rim-lit figure, glossy floor reflections, trusses at 3 % |
| `title` | 0:00 | 20 mm, 0.9 m, a metre from the grille | same warehouse, the centre car | chrome script title in front of the grille bars, reflections of the tubes in the chrome, white flanking cars, streaks at the frame edges |
| `quad` | 1:48 | 50 mm, chest height, profile | black void, one teal backlight through haze | a rim-lit profile silhouette, duplicated four times (flipped alternately), teal haze gradient |
| `cyc` | 1:17, 1:45 | 35 mm, 1.2 m, three-quarter | white infinity cyc, one hard key | figure walking across the floor, hard floor shadow, frame echo trails, vignette, over-exposure |

A CRT re-scan pass (0:51) is a post option on every shot.

## Pipeline

**Blender** (`tools/blender/on-nothing/`, headless, seeded, never hand-edited): the warehouse (floor,
walls, roof trusses, a row of hanging tubes), five SUV bodies (subdivision-surface bodies with a
vertical-bar grille, headlight lenses as emissive surfaces, multi-spoke wheels, glass), the figure,
the cyc, and the title script. Cameras are `shot.<name>`; light markers are `lamp.<kind>.<nn>` with
colour, lumens and cone in `extras`, as the furnace does.

**The figure** is one smooth mesh (skin modifier + subdivision, applied) skinned in loom, not in
glTF (the decoder refuses skins by design). Each vertex carries its two bones and the first bone's
weight in TEXCOORD_0 (u = boneA × 32 + boneB, v = weight). A point kernel builds the bone chain
from pose parameters each frame and blends the two transforms, so the figure walks, gestures and
turns through ordinary drivable knobs.

**loom** (`src/projects/on-nothing/`): one document builder per shot family, reading the GLB's
facts the way the furnace does. The render chain, in linear HDR:

1. Render with MSAA, depth, normal and albedo outputs; shadowed point lights at the headlights, so
   the figure throws a shadow toward the lens.
2. Deferred spot fixtures for the headlight cones and the tubes (the furnace lamp-pass mechanism).
3. Screen-space reflections, for the floor and the clear coat.
4. Haze: in-scattering from the headlight cones and the tubes along each view ray, up to the
   surface depth.
5. The streak filter: a bright pass smeared upward (a one-sided, multi-scale vertical blur) with
   fixed vertical striations, added back.
6. The halo: a ring kernel over the quarter-size bright pass, a slightly different radius per
   channel, so an on-axis source wears a thin rainbow ring.
7. Bloom (the furnace pyramid mechanism).
8. Lens: barrel distortion, edge blur, chromatic aberration at the edges, vignette.
9. Grade: blacks crushed to 0, desaturated mids, cold upper mids, bleach-bypass highlight rolloff,
   grain.
10. Per shot: frame echo (a feedback blend with a two-frame delay) for `cyc`; the four-way mirror
   for `quad`.
11. Optional CRT: curvature, RGB phosphor triads, scanlines, interlace jitter, phosphor bloom.

The renderer is `src/projects/on-nothing/render.ts`, stills and clips into `renders/on-nothing/`.

## Judging

Every stage ends with the render placed next to the matching key frame, never next to an earlier
render or another example. Measure what can be measured: black level, the headlight columns'
height as a fraction of the frame, frame-to-frame luma change.

## State (2026-09-27, end of day one)

All four shots render, as stills and as clips, through `src/projects/on-nothing/render.ts`. Frames
land in `renders/on-nothing/stills/` and `renders/on-nothing/clips/`, and the four-shot contact
sheet is `renders/on-nothing/contact-2026-09-27.png`. At 1920×818 a frame takes 15–60 ms
(quad/cyc to tableau/title), so each shot runs about as fast as real time.

What landed, and where:

- `tools/blender/on-nothing/`: the scene generator (README there). The cars are lofted and
  subdivided. The figure is the CC0 MakeHuman body (MPFB), its bones folded to 19. The
  warehouse, the cyc and the chrome title script are built there too.
- `scene-facts.ts` / `load-facts.ts`: the GLB's areas, cameras, stages, lamps and bones.
- `skin-kernel.ts`: the figure posed by per-bone knobs (the stopgap for T1401b).
- `surface.ts`: one Material · WGSL that draws by class. It covers damp concrete, clear coat,
  chrome, faceted jewellery, glass, emissive groups, skin, cloth and the cyc.
- `atmosphere.ts`: haze in-scatter from the GLB's lamps (spot cones, tubes, the backlight), the
  reflection environment and the headlight cookie. There is one shadowed projector per car.
- `fx.ts`: the streak filter (three chained box passes, flat-sided slabs), the halo ring, the
  optics composite, the lens (barrel, swirl edge blur, edge CA, snap-zoom, vignette), the grade
  (Hable shoulder, black crush, desaturation, bleach bypass, steel split, grain), the frame echo
  (darken trail), the mirror tiles and the CRT.
- `document.ts`: the four shot graphs. Screen-space reflections, occlusion and depth of field come
  from the furnace's passes, reused.

Findings along the way:

- A `scale` resolution is relative to the node's INPUT, not the project. A chain of passes
  therefore states each factor against the pass before it. The furnace's bloom pyramid uses
  `0.5 / 2^level` on each level, so its levels shrink much faster than its comment says.
- A Render binds two textures per projector (the cookie and the occlusion map) against the
  16-texture stage limit. That caps a Render at about seven projectors, so the cars get one
  two-lobed projector each.
- A directional light's shadow volume is framed around the world origin. Any set that needs sun
  shadows must sit there.
- The Blender glTF exporter drops an empty's rotation. Every aim therefore rides in `extras`.

Rows: T1400b is the umbrella. T1401b covers glTF skins in mesh import. T1402b promotes these passes
to stock nodes, so the shots can be built in the app with no project code (the owner's ask,
2026-09-27).
