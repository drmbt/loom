# E42 — Current

A mosaic of small lit tiles, each a facet of the picture behind it. Where the subject
travels the tiles **turn** into the local flow; where the picture holds still the grid is
perfectly calm.

Calm is every tile flat, identical, identity. Turning is spinning their edges into the
flow, leaning their faces along it, and swelling with the motion under them — and because
they are lit by one raking key, the lean reads as **shading**: a swept region catches the
light differently from a calm one, so you see the direction of motion as brightness before
you see it as shape.

This is T723's first witness — the per-instance quaternion, landed with zero consumers —
and T721's mapped scale rides beside it, on E41's exact source rig.

## Graph

```
noise_bed(noise 4d) ──┐
circle_orb(circle ┄ lfo_pathx/lfo_pathy) ─┴─► add_stand(add) ─┐ order 0
movie_clip(movieFileIn) ───────────────────────────────────────┴─► switch_pick(switch) ─┬─► cache_past(cache, 6 back)
                                                                                        ▼                  ▼
switch_pick ─► reorder_pack.in1 (rgb)                                      difference_moved(difference)
level_gain ─► reorder_pack.in2 (a)  ─► reorder_pack(reorder) ─► kernel_flow.field           │
                                                    level_gain(level) ◄─────────────────────┘
grid1(pointGrid 48×27) ─► kernel_flow(pointKernel) ─► geometry_tiles(geometry, instances quad)
material_facet(materialPhong) ── by name ──► geometry_tiles ─► render_shot(render ◄ camera_view, light_rake) ─► output1
```

| Node | Type | Doing |
| --- | --- | --- |
| `kernel_flow` | `pointKernel` | four `fieldAt` taps → the motion's local GRADIENT → a composed quaternion: spin about +Z into the flow, lean about the in-plane axis along it |
| `geometry_tiles` | `geometry` | instanced quads with all three maps at once: `tint` (the picture), `scale` (T721, from `tint.w` = motion), `orient` (T723, the quaternion) |
| `material_facet` | `materialPhong` | the reason the lean is VISIBLE: a specular facet under `light_rake`'s low key answers "which way is this tile turned" per pixel |
| `reorder_pack` | `reorder` | E41's pack, verbatim: rgb = source colour, a = motion — one field input carries both readings |
| `light_rake` | `light` | low from the left, so a tile leant into rightward flow faces the light and a leftward one turns away — direction as light |

## Why a quaternion, witnessed rather than cited

T723's commit argues the choice: Euler cannot compose, a bare direction cannot carry
roll. This kernel **uses** the property — the tile's turn is `spin(atan2(g)) ⊗ lean(|g|)`,
two rotations composed into one attribute — and the claims verify the composition is
alive: turned tiles must carry a non-zero xy part, which spin alone (the flat-sprite
version of this example) could never produce.

The convention is pinned from the draw's own contract, not re-derived: xyzw with w last,
right-handed and active — `(0, 0, sin45, cos45)` carries +X to +Y.

## Calm means identity, exactly

Below the gradient epsilon the kernel writes `(0, 0, 0, 1)` — not a small rotation, the
identity to the float. That is a claim in `current-claims.gpu.test.ts`, read off the
orient buffer through the harness's `probeBuffers` seam (pixels cannot testify about a
rotation): every tile off the orb's analytic recent path holds identity exactly, every
turned tile is unit-length and on the path. The epsilon exists because the understudy's
bed simmers (§V687 — something almost-still, not frozen), and it was raised once after
looking at the frame (§V383): at 0.02 the bed's murmur scattered spun tiles across the
calm field.

## §V712, made deliberate

Negate the gradient in a mutated clone and every moving tile turns half around — its
quaternion lands near-orthogonal to the shipped one (`⟨spin(θ), spin(θ+π)⟩ = 0`) — while
the calm tiles agree exactly and the mean display luma, the still-frame statistic a look
baseline eats, moves by **under 2%**. Total wrongness, statistically invisible. The claim
asserts both halves: the buffer sees the flip, the picture statistics do not — which is
the measured reason buffer-level claims exist for this example at all (§V712/§V717).

## Where the seams show

- **The gradient is a reading of the difference field, not optical flow.** It points
  across the motion's edge, not along the velocity; for a compact moving subject the
  swirl this produces is the honest picture of the field we actually measure. Real
  optical flow (two-frame correlation) is a different instrument.
- **The lean angle and epsilon are tuned constants**, fitted against the understudy's
  measured field (§V696); very fast footage may want a lower `level_gain.whitelevel`.
- **Point `movie_clip` at real footage** (`switch_pick.index = 1`) and the mosaic re-tiles it live —
  the understudy proves the mechanism; the video input is the point.
