# Stage previz (Blender side)

A procedural bpy generator for a touring concert stage: the house deck, the grated
(blowthrough) stage deck and riser with their strobes underneath, the riser's side stairs, the
pixel lines (a rack in front of the riser, hung trusses behind the scrim), the upstage scrim
(the projection canvas), the midstage kabuki, the flown frame, the three Barco UDX-4K40
projectors, and stand-ins for the talent. It exports one GLB that the Loom session
(`src/projects/stage-previz/`) reads.

Dimensions: `layout.py` is at **revision 2** (2026-10-08, VN79): the tour's dimensioned Front
Elevation and top plan. Heights are the elevation's dimensions above the house deck (5'0" here,
"may be different in each venue"), plan positions the plan's dimensions from the stage's
downstage edge; what the drawings draw but do not dimension (the hung pixel rows above 16'-11",
the projectors' lens heights, the scrim's swags) is read at their scale and noted where it is
set. The house deck is 60' x 40', the grated stage deck 48' x 16', the riser 32' x 8' with a
stair each side, the scrim flush against the riser's upstage face, hanging 23'-1" from a truss
at 22'-7" that it shares the trim with a front truss (the side projectors) 8' from the edge and
the DS projector's 8' truss 6'-4" downstage of it. The fixture list: ACME Pixel Line IP x63,
GLP JDC Burst 1 x38, Robe iForte FS x3 (not modelled), Barco UDX-4K40 x3. Change `layout.py` and
rebuild; `upgrade.ts` (below) brings a saved session along.

**Two exports are committed.** `public/media/stage-previz/stage.glb` (and `fx-pixel-map.png`) is
the first export, from the estimates revision 2 replaced: the base session, `-7`, `-8` and `-9`
are on it. `stage-r2.glb` (and `fx-pixel-map-r2.png`, with `fx-pixel-map-r2.{png,svg,csv}` beside
the sessions) is revision 2: `-10` is on it. The pixel map moved with the pixel rows, so a
Resolume composition laid out on `fx-pixel-map.png` needs `fx-pixel-map-r2.png` for `-10`.

## Run

```bash
B=/Applications/Blender.app/Contents/MacOS/Blender
$B --background --factory-startup --python tools/blender/stage-previz/build.py -- \
   --out renders/stage-previz/stage.glb --blend renders/stage-previz/stage.blend --fxmap renders/stage-previz [--preview renders/stage-previz/preview]
node --import ./src/tooling/alias-hooks.ts src/projects/stage-previz/build.ts
```

`layout.py` now builds revision 2, which ships as `stage-r2.glb`, not over `stage.glb`: build it to
`renders/stage-previz-r2/` and copy `stage.glb` → `public/media/stage-previz/stage-r2.glb` and the
three `fx-pixel-map.*` → `fx-pixel-map-r2.*` (the PNG to `public/media/stage-previz/` too). `build.ts`
and `upgrade.ts` still name `stage.glb`.

The first command takes about 5 s. The second copies the GLB to
`public/media/stage-previz/stage.glb` and writes `projects/stage-previz/stage-previz.loom.json`
(a file already there is kept unless you pass `--force`).

## The sessions

| File | What it is |
| --- | --- |
| `stage-previz.loom.json` | GENERATED: what `build.ts` writes from the committed GLB, and checked against it byte for byte (`src/projects/stage-previz/session.test.ts`). Do not save your own edits over it; save them under another name. |
| `stage-previz-7.loom.json` | A session saved from the app: its owner's fader values, Syphon servers, presets, a cue list and nodes of their own. `upgrade.ts` keeps it up to date. |
| `stage-previz-8.loom.json` | A session saved from the app, repackaged there into six components. `upgrade.ts` cannot reach inside components and refuses it, so what a new export changes (the deck height the low fog sits on) is edited inside its components, in the app. |
| `stage-previz-9.loom.json` | `-8` as its owner last saved it (Syphon servers, a Bloom Pyramid component), with the trussing on two faders, in FEET OFF THE VENUE FLOOR (the model's y = 0): **Truss trim** (the frame's bottom chord; the frame, its pipes, the side projectors, and the scrim and kabuki, which hang from it and lengthen or shorten to the house deck) and **DS truss trim** (the DS projector's own 4' truss, which carries its body, lens and aim). Both open at 21'. Four presets, every one on live input: `ds37_21ft`, `ds74_21ft`, `ds37_26ft`, `ds74_26ft` — the DS image 36' wide on the scrim, level and square, the 0.74 slid downstage to match the 0.37's coverage, and the side images re-solved at each trim to fill the deck's width, square, inside its sides and front. `src/projects/stage-previz/trims.test.ts` reads each preset back through the compile. Its trims live inside its components, as `-8`'s rig does, so `upgrade.ts` refuses it too. |
| `stage-previz-10.loom.json` | `-9` again on layout revision 2 (`stage-r2.glb`): the owner's latest save of `-8`, every parameter the generator derives from the GLB moved onto the new export (none had been edited by hand), then the trims and presets. The trims are in FEET ABOVE THE HOUSE DECK and open at the plot's 22'-7". Two presets, both on live input and both the 0.74 (the lens the show uses; the 0.37 is dropped): `ds74_plot`, the DS truss where the plot hangs it, the image level with its top edge on the scrim's top, 42.9' wide (past the 30' straight face onto the swags), and `ds74_fill`, the truss slid 8.5' upstage until the same image fills the 30' face exactly; in both the side images fill the downstage strip, square, from where the plot hangs them. `trims.test.ts` reads both back. |
| `stage-previz-11.loom.json` | `-10` with a quad multiview. **Quad** on the Panel (a Layer switch, `layer_quad`; opens off): off the single full-resolution view (Shot, Orbit, Zoom), on four views in one frame over it: front tight (top left), front wide (top right), front angled from stage right (bottom left), stage-right profile (bottom right). Each is an instance of `HazeView`, `HazeRender` with a camera of its own (eye, aim and field of view on the instance) and every pass at half size; `wgsl_quad` lays them out texel for texel. Off, the Layer is bypassed and the compile prunes the quad's whole chain: the session costs what `-10` does (123 passes); on, the four views add about 400. `multiview.test.ts` reads each view's camera back from its haze passes. |
| `stage-previz-12.loom.json` | `-11` with a **dual** view, front over a stage-right profile, each a full-width 1920 x 540 strip (`HazeStrip`, HazeView at a 32:9 strip's sizes), and the layouts as three Layers on a black base, **Single · Dual · Quad** on the Panel: only what is switched on renders (Single 125 passes, Dual 224, Quad 420; in `-11` the single view rendered under the quad). Opens on Single. Switch one on and the others off; one on covers what is under it, so two on render both. |

After a change to the source or a new export, regenerate the base session, and bring a saved
one along, against the committed GLB (which is read where it is and not rewritten):

```bash
node --import ./src/tooling/alias-hooks.ts src/projects/stage-previz/build.ts -- --glb public/media/stage-previz/stage.glb --force
node --import ./src/tooling/alias-hooks.ts src/projects/stage-previz/upgrade.ts -- projects/stage-previz/stage-previz-7.loom.json --glb public/media/stage-previz/stage.glb
```

The upgrade adds or refreshes the projector rig (below), the FX feed (below), the measured mesh
sizes, the deck height the low fog sits on and the shot cameras, keeps your fader values and
lens shifts, and leaves everything else in the file alone (the app's component library at the
file's root included). What the session already has is found by its name, so an FX feed you
rewired by hand stays as you wired it. A session that is already up to date is written back
byte for byte. Without `--glb` it reads the Blender export in `renders/stage-previz/` and also
copies the GLB and the FX pixel map into `public/media/stage-previz/` and the map beside the
session. Close the session in the app first: saving an already-open copy afterwards would
overwrite the upgrade.

## The projector rig

The DS (IMAG) projector hangs from its own 4' truss at the side projectors' truss height, on a
0.37 short-throw lens 16' from the scrim (`DS_*` in `layout.py`). The scrim's flat canvas is
36' wide, read off the 4' x 8' decks. The Panel's Projectors section drives the rig:

| Fader | Does |
| --- | --- |
| DS throw ratio | the DS lens |
| DS truss Z offset, ft | slides the truss, body and lens in z (+ toward the house); 0 = 16' throw |
| DS tilt, ° down | turns the body about its clamp; the lens moves with it, the aim follows the axis onto the scrim |
| DS keystone V / H, ° | the Projector node's keystone |
| Side tilt, ° down | both side projectors, each along its own pan line onto the deck |
| Side throw ratio | both side lenses |
| Side roll, ° | both side projectors' roll; 90 = portrait (stage right +, stage left −, so the pair stays mirrored) |
| Side keystone V / H, ° | both side projectors' keystone; H mirrored like the roll, V not. H squares the floor image (below) |
| Deck tone | the floor's brightness: its own material over a satin mid-grey, so projections read on it |
| Scrim | how much light the scrim and the kabuki send back; lower is more see-through |
| Strobe level | the strobes' brightness (the LEDs fader does the pixel lines) |

Under **Source** and **Shot** ("Feeds and view"), **Orbit the shot, °** (−180…180, 0 = the preset)
turns the view camera about the vertical through the shot's look-at, at the shot's own height, and
**Zoom the shot, ft** (−80…80, 0 = the preset) moves it along its line to the look-at, never closer
than 5% of the way. Each shot's look-at is the point on its axis nearest the stage centre
(`facts.ts`), so ±180° puts you as far behind the stage as the preset is in front of it, looking
back through the scrim. The haze follows the view, so the beams are right from any angle.

The side projectors hang from outriggers off the frame's downstage corners, over the middle of the
downstage strip (the two downstage deck rows, 16' deep), and pan straight across it, rolled to
portrait so each image's long side lies in its tilt plane. The beams CROSS: each image's far edge
lands on the opposite deck edge (stage left's content flipped, so the two land as mirror images).
`layout.side_rig()` derives the rest:

- **Keystone H 25.05°** squares each image: it puts the vanishing point of the image's long edges
  on the floor's horizon, so they land parallel and the image is an undistorted rectangle on the
  deck, the near end as wide as the far one, every pixel the same size.
- Squared up, the image's depth on the deck is 2·drop·tan(half-height) / sin(tilt). Holding that at
  the strip's **16'** fixes the lens for each tilt, and the tilt whose far edge then lands on the
  far deck edge is **39.55°**, with **throw 1.295**.
- The near edge falls 1.02 m (3.3') in from the projector's own deck edge. Each image is 44.7' x 16';
  both together cover the full 48', overlapping across the middle 41.3' (the outer 3.3' each side
  is the other projector's far end alone).

Loom's keystone is the trapezoid a tilted screen makes, so it reaches past the lens's native image
on its wide side: in a real projector, whose digital keystone only shrinks the raster, the near end
needs a wider lens than the throw ratio says, with the far end squeezed in.

Two engine bugs this rig exposed are fixed in Loom (VNB10, VNB11 on the fork's board): a keystoned
projector used to drop the narrow half of its image from the render while the haze beam still drew
it, and the projector's occlusion test leaked light onto surfaces within about a metre behind an
occluder at stage distances (the deck's front and side faces under its lip).

The upstage curtain is a SCRIM: Loom draws it additively, lit but occluding nothing, so the
light towers and LED battens standing 40 cm behind it show through it, and projector light
carries on through it. The kabuki is the same material: while it is in, the DS image lands on it
and carries on through to the scrim and the towers behind. Both drapes share one material on the
**Scrim** fader: how much of the light falling on them they send back (0.35 by default). Front-lit,
a scrim shows its image and hides what is dark behind it, as a real one does; lower the fader to
make it more see-through.

An additive surface writes no depth, so the haze composite used to fade the drapes by the distance
to whatever was BEHIND them: the empty house through the top of the scrim (it all but vanished,
except where a tower stood right behind it), the floor past the deck through its foot when seen
from above (it stood out solid). A depth-only render of the drapes from the view (`drapeDepth`)
now gives the composite their own distance, so the scrim reads the same from top to bottom.

The haze beams sample each ray EQUI-ANGULARLY about the projector's lens (dense where the light
is, near the lens) and jitter by their own half-resolution pixel; the composite resolves them
through a small tent. A close, wide lens (the DS 0.37) used to throw a coloured speckle into the
haze in front of the scrim; that is gone. `upgrade.ts` refreshes the beam and composite shaders
in a saved session as long as they still carry haze.ts's "generated by" line (a shader you
rewrote by hand is left alone).

The projector bodies are parts of the `rig` area, turned and slid by the `rigMotion` kernel with
the same numbers the projectors read (`src/projects/stage-previz/rig.ts`).

## The decks, the strobes and the pixel lines

The house deck is 48' x 32' (its height varies by venue; 1.4 m here). On it, two GRATED
blowthrough decks 1'6" deep: the stage's downstage 48' x 16' (its two front rows of decks), and
the riser's top, 7'7" over the house deck, directly upstage of the stage grate. The strobes (GLP
JDC Burst 1, 38) sit in the grates' cavities: 30 under the stage grate, six across from 2'0" in
off stage right at 8'10", five deep at 3'1" (2'10" in off its upstage edge); eight under the
riser's, 4' apart, 4' in off its back edge. Their light shows on the grated tops as windows.

The pixel lines (ACME Pixel Line IP, 63) are seven rows of nine 1 m bars: three on a Schedule 40
pipe rack on four 2' x 2' base plates in front of the riser (2'11", 4'11", 7'0" over the house
deck) and four on hung 12" box trusses behind the scrim (8'11" to 17'11", a 3' pitch read off the
elevation). Each bar is modelled as 39 pixels: an ASSUMPTION from its 117-channel DMX footprint
(39 RGB). Change `PIXELS_PER_BAR` if the bar's spec says otherwise.

## The FX feed: one stream for the pixel lines and the strobes

One 1920 x 1080 Syphon stream from Resolume (`syphonFX` in Loom) drives all of them:

- **Top half**: the pixel lines as seen from the house. 30' across = 1920 px (64 px/ft); each bar
  row is ONE texel row, its height mapped linearly from 1'11" to 18'11" over the house deck.
- **Bottom half**: the strobes in plan, downstage at the bottom. 48' across = 1920 px (40 px/ft);
  the downstage edge at the bottom row, the riser's back edge at the middle (22.5 px/ft deep).

Every pixel and every strobe shows ONE texel; the template draws each zone a pixel bigger on every
side (a bar row is three rows tall) so a feed a pixel off still lands. Send it at 1920 x 1080, filling
the frame. The build writes the map from `layout.py` as
`fx-pixel-map.png` (a template to load as a reference layer in Resolume; in Loom it is Source 2
on the FX feed), `fx-pixel-map.svg` (labelled) and `fx-pixel-map.csv` (every texel by fixture).
The PNG is committed twice, the same bytes: `public/media/stage-previz/fx-pixel-map.png` is the
one the app serves (a session's FX feed reads it), and `projects/stage-previz/fx-pixel-map.png`
sits beside the sessions with the SVG and the CSV, where the note in each session sends you to
pick it in Resolume. `upgrade.ts` writes both from one export.
The same numbers are baked into the GLB as uvs: each pixel and strobe window is a quad whose uvs
all name its texel, and Loom's unlit material reads its albedo map at the surface uv.

The projectors are Barco UDX-4K40: native 3840 x 2400, 16:10, so the projector aspect is 1.6 and
the side rig is derived for it. Their feeds from Resolume should be 16:10 (1920 x 1200 or 3840 x
2400); a 16:9 feed stretches to fill the raster.

## Coordinates

Metres, Blender Z up, audience at −Y. **+X is stage left** (the audience's right). glTF / Loom
space is (x, z, −y), so Loom's +Z points at the audience.

## What Loom reads

- Areas, one Mesh File In each: `stage.*`, `grid.*`, `curtain.*`, `kabuki.*`, `led.*` (the
  pixel-line pixels, unlit, reading the FX feed at their uvs), `strobe.*` (the strobe windows,
  likewise), `deck.*` (the walking surfaces: house deck, grates), `talent.*`, `rig.*` (the
  projector bodies and the DS truss, as parts).
- `proj.SR`, `proj.SL`, `proj.DS`: the lens position, with `loom_look_at`, `loom_throw_ratio`
  and `loom_aspect` in the extras. `proj.DS` also carries its mount: `loom_pivot` (the clamp),
  `loom_lens_offset` ([forward, drop] of the lens from the clamp), `loom_tilt_deg` (the tilt
  that centres the image on the canvas) and `loom_curtain_z`.
- `canvas.US`: the flat canvas extents and the deck height.
- `shot.foh`, `shot.iso`, `shot.wing`, `shot.projector`, `shot.wide`: the Shot switch in Loom.

The pixels and strobe windows carry a WHITE base colour and no emission. Loom draws them unlit,
their colour the FX feed's texel times the level fader, so any other base would tint the content
and an emissive term would sit on top of the dimmer.
