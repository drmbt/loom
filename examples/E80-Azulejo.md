# E80 — Azulejo

Two picture layers and a person-shaped window between them. An outer layer fills the frame,
the people standing in front of the camera are cut out of it, and an inner layer plays inside
the cut. The visual control is a projection on the Pavilhão de Portugal in Lisbon: a wall of
blue-and-white tiles, two people's silhouettes, and a night timelapse of the city inside them.

```
tiles1(customWgsl) / clipa1(movieFileIn) ─► outer1(switch) ──────────────► wall1(over) ─► out1(output)
city1(customWgsl) / clipb1(movieFileIn) ─► inner1(switch) ─► cut1(mask) ─┘
figures1(customWgsl) / matte1(matte) / seg1(personMask) ─► shape1(switch) ─► soft1(blur) ─► cut1(mask)
cam1(webcam) ─► matte1(matte), seg1(personMask)
```

`cut1` gives the inner layer the shape's coverage as its alpha, and `wall1` lays it over the
outer layer. `soft1` softens the cut edge by a few pixels, whichever mask is live.

## Use your own pictures

Every layer is a Switch, and index 0 is a stand-in shader, so the file shows the idea with no
media and no camera.

1. **outer1** — Index 1 plays `clipa1`. Load a video or a still into its File.
2. **inner1** — Index 1 plays `clipb1`. Load the footage that shows inside the people.
3. **shape1** — Index 1 is `matte1`, the browser Matte on `cam1` (MediaPipe
   SelfieSegmenter, downloaded once with your consent). Index 2 is `seg1`, the Apple Vision
   Person Mask (the desktop app, or the device helper on a Mac).

## Stand-ins and limits

`tiles1`, `city1` and `figures1` are placeholders. They take their size from `size1`, a
project-sized Solid. The tiles have a slow sheen, the city drifts and its windows change, and
the two figures sway, so the example moves with no input.

`cam1` is in the file, so opening it can ask for camera access even at index 0. A mask model's
edge steps at the model's own input resolution; raise `soft1` Size if the edge reads jagged
on your footage.

Visual control: [E80 reference](references/E80-Azulejo-reference.png).
