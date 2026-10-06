# E80 — Azulejo

Two picture layers and a person-shaped window between them. An outer layer fills the frame,
the people standing in front of the camera are cut out of it, and an inner layer plays inside
the cut. The visual control is a projection on the Pavilhão de Portugal in Lisbon: a wall of
blue-and-white tiles, two people's silhouettes, and a night timelapse of the city inside them.

```
wgsl_tiles(customWgsl) / movie_clipa(movieFileIn) ─► switch_outer(switch) ──────────────► over_wall(over) ─► output1(output)
wgsl_city(customWgsl) / movie_clipb(movieFileIn) ─► switch_inner(switch) ─► mask_cut(mask) ─┘
wgsl_figures(customWgsl) / matte1(matte) / personmask_seg(personMask) ─► switch_shape(switch) ─► blur_soft(blur) ─► mask_cut(mask)
webcam1(webcam) ─► matte1(matte), personmask_seg(personMask)
```

`mask_cut` gives the inner layer the shape's coverage as its alpha, and `over_wall` lays it over the
outer layer. `blur_soft` softens the cut edge by a few pixels, whichever mask is live.

## Use your own pictures

Every layer is a Switch, and index 0 is a stand-in shader, so the file shows the idea with no
media and no camera.

1. **switch_outer** — Index 1 plays `movie_clipa`. Load a video or a still into its File.
2. **switch_inner** — Index 1 plays `movie_clipb`. Load the footage that shows inside the people.
3. **switch_shape** — Index 1 is `matte1`, the browser Matte on `webcam1` (MediaPipe
   SelfieSegmenter, downloaded once with your consent). Index 2 is `personmask_seg`, the Apple Vision
   Person Mask (the desktop app, or the device helper on a Mac).

## Stand-ins and limits

`wgsl_tiles`, `wgsl_city` and `wgsl_figures` are placeholders. They take their size from `solid_size`, a
project-sized Solid. The tiles have a slow sheen, the city drifts and its windows change, and
the two figures sway, so the example moves with no input.

`webcam1` is in the file, so opening it can ask for camera access even at index 0. A mask model's
edge steps at the model's own input resolution; raise `blur_soft` Size if the edge reads jagged
on your footage.

Visual control: [E80 reference](references/E80-Azulejo-reference.png).
