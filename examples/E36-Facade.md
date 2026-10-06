# E36 — Facade

A building facade at night, lit by two projectors throwing up at it from below. Their
images overlap across the middle of the wall and the overlap simply ADDS.

The left projector carries a slowly scrolling warm gradient — the content — and the right
one a white alignment grid, the chart every install throws first. In the overlap the grid
lines glow through the gradient, brighter than either throw alone, exactly what two real
machines do in a blend zone before anyone feathers them. Along the top of the wall runs a
row of dentil blocks, and because the throws come from below, each block prints a shadow
finger on the wall ABOVE itself — the beam cannot reach what the architecture hides.

This is previz, not a music video: the frame exists to answer the two questions
a site visit answers. Where do the images land and overlap, and what does the
building block?

## Graph

```
lfo_drive(lfo) ┄drives┄► ramp_warm.phase
ramp_warm(ramp: warm scroll)  ──► projector_left.cookie
checker_chart(checker: 8×5 grid) ──► projector_right.cookie

grid_wall(pointGrid 32×18)  ─► kernel_walllay(pointKernel: stand up) ─► geometry_wall(geometry: surface)
grid_ground(pointGrid 24×16)─► kernel_groundlay(pointKernel: lie flat)─► geometry_ground(geometry: surface)
grid_corn(pointGrid 9×1)    ─► kernel_cornlay(pointKernel: 9 dentils) ─► geometry_cornice(geometry: box ×9)

geometry_wall geometry_ground geometry_cornice ─(names)─► render_shot(render) ◄─(names)─ camera_view, light_moon, projector_left projector_right ─► output1
                                                                     ▲ eye.x ┄ lfo_drift
```

| Node | Type | Doing |
| --- | --- | --- |
| `projector_left` | `projector` | the content throw: warm gradient cookie, `throwRatio 1.8`, `shiftY 0.35`, aimed at the wall's mid-height |
| `projector_right` | `projector` | the alignment throw: checker chart cookie, same lens, aimed 1.6 to the right — the two images share a ~1.8-wide blend zone |
| `geometry_cornice` | `geometry` | nine boxes on the cornice line, jutting off the wall face — the occluders that print shadow fingers above themselves |
| `ramp_warm` | `ramp` | the content, and the motion: its `phase` rides `lfo_drive`, so the gradient scrolls through the left throw as a value (§V5), no rebuild |
| `checker_chart` | `checker` | an 8×5 alignment grid, the first thing a real install ever projects |
| `light_moon` | `light` | dim, cool, no shadows — enough to read the architecture, never enough to compete with a throw |
| `lfo_drift` | `lfo` | 0.03 Hz on the camera's eye.x; a locked-off previz reads as a screenshot |

## The lens does the aiming, not the tilt

Both projectors LOOK at the wall's mid-height and still reach the cornice line,
because `shiftY 0.35` slides each image up the facade while the throw axis stays
level. That is lens shift — the off-axis parameter a real install actually
turns — and it is why the projected rectangles stay rectangles. Tilting the
projector up instead would keystone the image into a trapezoid, and someone
would then dial `keystoneV` to fight the distortion they just created. The
trade every projectionist knows — shift first, keystone only when you run out
of shift — is why those are separate parameters on the node, and this file
demonstrates the correct half of it. (`keystoneH`/`keystoneV` sit at 0 here,
deliberately.)

`throwRatio 1.8` is the number printed on a lens barrel: throw distance ÷ image
width. At roughly 6.3 units of throw that is a ~3.5-wide image per projector;
the aim points sit 1.6 apart, which leaves the ~1.8-wide additive blend zone in
the middle of the wall.

## Brightness is nominal at the Look At, and the beam is light

`brightness 1.1` means "1.1 at the aimed-at surface": the node's falloff is
inverse-square about the throw distance, so pulling a projector back and
re-aiming keeps the landing brightness readable instead of exploding it.
`falloff` stays on — it is the physical default. And the contribution is
ADDITIVE LIGHT multiplied through the surface's own albedo, never a decal
painted over the picture: that is why the blend zone is brighter than either
beam, why the dim moonlit wall still reads as a wall inside the beams, and why
projecting onto a black surface would honestly show almost nothing.

Unwire a cookie and the projector throws plain white — a focus light. That is
deliberately useful: it is how a venue tech starts, with light on the building
before there is content.

## Occlusion on, because the site is the point

`occlusion` stays on for both projectors, so each renders the scene's depth
from its own lens and a surface it cannot see receives nothing. The dentil
blocks of `geometry_cornice` are the demonstration: beams from below graze past them
and the wall directly above each block stays dark, in exactly the fingers a
site survey would sketch. Turn `occlusion` off and the beams paint straight
through the blocks — a decal that lies about the building. Sometimes that lie
is wanted (content mocked flat onto elevation drawings); here the truth is the
feature.

One placement rule is load-bearing enough to repeat from the file: the wall,
ground and cornice all wear the default LIT material, and the cornice MUST — an
unlit geometry exchanges no light in either direction (§V617/§V666), so an
unlit cornice would cast no projector shadow and this example's whole occlusion
story would silently vanish, reading as "shadows broke" when the material had
simply opted out of light.

## Things to try

- Drag `projector_left`'s `eye` sideways: the warm image walks across the wall, the
  blend zone narrows or widens, and the cornice fingers stay glued to the
  architecture — they re-derive from the pose every frame, nothing is baked.
- Push `shiftY` to 0 and re-aim by raising `lookAt` instead: same coverage,
  now trapezoidal. Then fight it with `keystoneV`. That round trip is the whole
  shift-versus-keystone lesson.
- Swap the cookies: alignment grid through the left lens, content through the
  right. The blend zone still adds; nothing about the throws cares what rides
  them.
- Turn `light_moon`'s intensity to 0: pure projector light, the true dark-site look.
