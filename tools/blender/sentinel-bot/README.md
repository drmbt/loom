# Sentinel kit (Blender side of the sentinel-bot project, T1561b)

`build.py` cuts the reference sentinel FBX into the GLB kit that loom's `meshFileIn` imports.
The FBX is a free model from CGTrader under its royalty-free licence. It is **not** in the repository
and neither is the kit built from it (the owner's decision): the kit goes to
`public/media/sentinel-bot/`, which is gitignored.

## Run

```bash
B=/Applications/Blender.app/Contents/MacOS/Blender
$B --background --factory-startup --python tools/blender/sentinel-bot/build.py -- \
   --fbx <Export-FBX_Sentinel_Final_EO_1.fbx> --out public/media/sentinel-bot/sentinel.glb \
   [--preview <png dir>] [--mandible-ratio 0.35] [--body-ratio 1.0] [--samples 40]
```

- A build takes about 40 s (the bake is sampled at `--samples` frames to measure the hinges).
- Blender 5.1's legacy FBX importer fails on this file (`KeyError: Armature.001`); the script uses
  `bpy.ops.wm.fbx_import`.
- The build stops with an error if the FBX's repeated pieces (rings, hubs, phalanges) are not identical
  in their joint frames to 0.1 mm, because the kit holds each piece once.

## What the FBX is

679 objects, 771k triangles: a body, a mesh of eye lenses, four articulated front arms of six links each,
and ten tentacles. Each tentacle is its own 66-joint armature carrying 54 ring meshes, a claw hub and
four fingers of two phalanges. One baked action (frames 2–1601) animates every joint; no IK constraints
survive. Measured: all 540 rings are the same mesh in bone space, 0.06 m apart, the first at the socket
and the hub 3.18 m along.

## What the kit is

Each piece once, in the frame of the joint that carries it, right-handed, glTF axes, metres.

| node | frame | notes |
|---|---|---|
| `body.*`, `eyes.*`, `lamp.*` | robot: origin at the body centre, +Z forward, +Y up | no `loom_part` |
| `mand_<k>_<level>` | robot frame at the reference pose, origin at its joint | `loom_part`, `loom_parent`; decimated by `--mandible-ratio` |
| `ring` | joint: origin at the joint, +Z toward the tip, +Y the frame's normal (loom's curve-frame convention) | one ring; draw it at every station |
| `hub` | joint | the claw's cone |
| `claw` | the hub's joint | the whole claw as one rigid piece, fingers at rest: for a draw that cannot afford nine pieces |
| `phalanx_<f>_<p>` | its own joint | finger `f` (0–3), link `p` (0 = knuckle) |
| `socket.<t>` | robot | marker: where tentacle `t` leaves the body |
| `eye.<i>` | robot | marker: the middle of an eye's face (on its axis, as far forward as it reaches); extras `loom_face`, its radius as seen from in front (what a picture in the lens is as wide as) |
| `kit.info` | – | marker: `loom_tentacles`, `loom_ring_count`, `loom_ring_pitch`, `loom_ring_start`, `loom_hub_distance`, `loom_fingers`, `loom_claw_open`, `loom_claw_closed` |

Hinged nodes (`mand_*`, `phalanx_*`) carry what the bake shows about their joint as extras:

- `loom_joint`: the joint's origin in its parent's frame (phalanges only; an arm link's origin is its node).
- `loom_rest`: its rest orientation on the parent, quaternion x y z w (phalanges only).
- `loom_axis`: the hinge axis. Parent frame for a phalanx, robot frame for an arm link.
- `loom_range`: the smallest and largest angle the bake reaches about that axis, radians, from rest.
- `loom_fit`: how far the bake strays from a pure hinge (radians), and how far the joint slides (metres).

The phalanges fit a hinge to about 18°; the arm links do not (up to 75° off axis), so treat an arm
link's axis as its dominant one, not as a constraint.

## Materials

The FBX's materials are mostly default grey with image textures loom does not read, so the kit reduces
them to **roles**, written as `loom_heat` in tenths (loom flattens it to the vertex's `surface.z`):
0 shell, 0.2 chrome, 0.4 brass, 0.6 red paint, 0.8 ring core, 1.0 eye lens. The look is the loom
material's.
