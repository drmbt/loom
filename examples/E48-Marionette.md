# E48 — Marionette

Pose, showcased: a figure of light — seventeen joints as soft points, a skeleton of
glowing bones — walking a procedural cycle, ready to become whoever stands in front of
the webcam.

The shipped performer is SYNTHETIC: `wgsl_dancer` emits a procedural walk cycle as the SAME
17×1 keypoint texture MoveNet produces — one texel per joint, red and green the position
across the frame, blue the confidence — so every gate and the gallery card see a dancer,
deterministically. Flip `switch_pick` to 1 and the same two consumers read `pose1` tracking
whoever is at the camera. Webcam permission is only requested when `webcam1` activates,
never on load.

## The keypoint texture is the contract

Neither consumer knows which source is live:

- `texturepoints_joints` is `pointsFromTexture` in VALUE mode — texel i's contents are point i, "the
  model says where the wrist is, so the texture's layout is irrelevant".
- `wgsl_bones` textureLoads the same seventeen texels and draws the skeleton's segments
  analytically, each bone weighted by the lesser of its two joints' confidence — a
  person walking out of shot dissolves limb by limb instead of snapping to garbage.

Without the model, `pose1` publishes zero-confidence keypoints: nothing draws on the ML
branch, never a failure (§T715), and the switch's default keeps the document opening on
the synthetic dancer regardless.

```
webcam1(webcam) ─► pose1(pose) ── index 1 ──────┐
ramp_seed(ramp) ─► wgsl_dancer(customWgsl) ── 0 ┴─► switch_pick(switch) ─┬─► wgsl_bones(customWgsl)
                                                                          └─► texturepoints_joints(pointsFromTexture)
texturepoints_joints ─► geometry_marks(geometry) ─► render_shot(render) ─► add_glow(add) ◄─ wgsl_bones ─► output1
```

| Node | Type | Doing |
| --- | --- | --- |
| `ramp_seed` | `ramp` | 17×1, black — exists only to size the keypoint canvas |
| `wgsl_dancer` | `customWgsl` | the walk cycle, emitted in MoveNet's own texture contract |
| `webcam1` | `webcam` | the live source — permission only on activation |
| `pose1` | `pose` | MoveNet keypoints, stale-tolerant, zero-confidence without the model |
| `switch_pick` | `switch` | WHICH performer both consumers read |
| `texturepoints_joints` | `pointsFromTexture` | VALUE mode: texel i is point i; low confidence parks |
| `geometry_marks` | `geometry` | the joints as soft spherical points, warm against the cyan bones |
| `wgsl_bones` | `customWgsl` | the skeleton, confidence-faded per bone, at frame resolution |
| `material_spark` | `materialUnlit` | the joints' material |
| `camera_eye` | `camera` | a straight-on stage |
| `render_shot` | `render` | `antialias: msaa` for the point sprites |
| `add_glow` | `add` | joints over bones — one figure |
