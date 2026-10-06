# Stage previz (Blender side)

A procedural bpy generator for the kabuki stage: the deck, the riser with side stairs, the
upstage curtain (the projection canvas) and the LED batten grid in front of it, the midstage
kabuki, the flown frame, the FOH truss for the downstage projector, and stand-ins for the
talent. It exports one GLB that the Loom session (`src/projects/stage-previz/`) reads.

**Every dimension is an estimate** read off the designer's renders. They all live in
`layout.py`. Change them there and rebuild; the Loom session re-reads the projector positions,
throw ratios and cameras from the GLB.

## Run

```bash
B=/Applications/Blender.app/Contents/MacOS/Blender
$B --background --factory-startup --python tools/blender/stage-previz/build.py -- \
   --out renders/stage-previz/stage.glb --blend renders/stage-previz/stage.blend [--preview renders/stage-previz/preview]
node --import ./src/tooling/alias-hooks.ts src/projects/stage-previz/build.ts
```

The first command takes about 5 s. The second copies the GLB to
`public/media/stage-previz/stage.glb` and writes `projects/stage-previz/stage-previz.loom.json`.
An existing session is kept, because it holds your saved edits (Syphon sources, added nodes):
the new geometry arrives through the GLB on its next open. Projector positions, throw ratios
and cameras are baked into the session, so after moving those in `layout.py`, regenerate it
with `--force` (and pick the Syphon sources again) or copy the new values across by hand.

## Coordinates

Metres, Blender Z up, audience at −Y. **+X is stage left** (the audience's right). glTF / Loom
space is (x, z, −y), so Loom's +Z points at the audience.

## What Loom reads

- Areas, one Mesh File In each: `stage.*`, `grid.*`, `curtain.*`, `kabuki.*`, `led.*` (drawn
  unlit, dimmed by the LEDs slider), `talent.*`.
- `proj.SR`, `proj.SL`, `proj.DS`: the lens position, with `loom_look_at`, `loom_throw_ratio`
  and `loom_aspect` in the extras. The DS throw ratio is computed so the image is exactly the
  flat canvas width (`layout.ds_throw()`).
- `canvas.US`: the flat canvas extents and the deck height.
- `shot.foh`, `shot.iso`, `shot.wing`, `shot.projector`, `shot.wide`: the Shot switch in Loom.

The LED faces carry their colour as base colour with no emission. Loom draws them unlit, so an
emissive term would sit on top of the dimmer.
