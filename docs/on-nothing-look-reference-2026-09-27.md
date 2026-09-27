# "ON NOTHING" look: reference breakdown (2026-09-27)

The owner handed this breakdown as the look brief for a set of rendered shots. It dissects the
visual language of the official music video for Yeat, "ON NOTHING" (director Alex Ede,
cinematography and colour Jackson Magnabosco, CRT processing @phbs.xyz). We take the LOOK
(lighting, optics, grade, compositing, analog artefacts), not the subject matter. Fidelity comes
before real time; real time is welcome where it costs nothing in fidelity.

The breakdown below is kept as handed over, lightly reformatted (the recipe table was broken
in the paste). The build plan for the shots is in
[on-nothing-shots-plan-2026-09-27.md](on-nothing-shots-plan-2026-09-27.md).

---

## 1. The post-production and effects layer stack

To replicate or analyse this aesthetic without copying the subject matter, visualise the frame
as an 8-layer composite pipeline built from capture to final delivery:

```
[Layer 7] Graphic & 3D Typographic Elements (Pinned Tracking / Chrome Shaders)
[Layer 6] Analog Video Artifacts (CRT Re-scan, Scanlines, Phosphor Decay)
[Layer 5] Spatial & Temporal Compositing (Mirroring, Multi-Matte Splits, Echo Trails)
[Layer 4] Optical Warps & Transitions (Snap-Zoom Blurs, Whip Distortions)
[Layer 3] Digital Color Grade (Crushed Blacks, Bleach/Silver Curve, Metallic Rolloff)
[Layer 2] Lens Filters & Glare (Vertical Streak Filters, Anamorphic Flaring, Halos)
[Layer 1] Practical Atmosphere & Light (Haze, High-Output LED Tubes, Headlight Beams)
[Layer 0] Raw Sensor Capture (Low-key / High-key dual environments, High Shutter Angle)
```

## 2. Core aesthetic pillars

### A. Lighting design and atmosphere

- **Dual-world polarity.** The video operates across two opposing environments:
  1. **The industrial void:** a pitch-black warehouse where negative fill dominates. Background
     elements vanish entirely into pure black (`RGB: 0, 0, 0`).
  2. **The sterile white limbo:** an overexposed high-key infinity cyc casting clean,
     sharp-edged floor shadows.
- **Vertical streak arrays.** Suspended LED tubes (Astera Titan/Hyperion class) hung vertically in
  deliberate, equidistant columns behind the subject.
- **Hard direct backlighting.** Vehicle high-beams cut through light haze directly into the lens,
  silhouetting the subject and producing severe edge fringing and rim lighting.
- **Optical flaring and haloing.** Distinct circular halo flares when light points align on-axis
  with the lens, contrasted with horizontal and vertical streak flaring (streak filters or
  physical prism elements held in front of the lens).

### B. Colour grading and tone

- **Palette:** ultra-desaturated, monochromatic "liquid mercury". The grade strips warm skin tones
  almost entirely in favour of cool steel, neutral titanium and carbon blacks.
- **Tonal curve:**
  - **Blacks:** aggressively crushed; shadows have near-zero ambient lift, giving razor-sharp
    separation between subject and negative space.
  - **Highlights:** pushed close to clipping on specular surfaces (chrome badges, diamond
    jewellery, glossy automotive clear-coats), blooming slightly with soft diffusion.
  - **Subtle split toning:** deep shadows strictly neutral-to-cool, with rare amber/tungsten warm
    flickers occurring solely from lens-flare contamination.

### C. Camera movement and framing

- **Axial symmetry vs. unhinged handheld:** symmetrical, locked-off front compositions anchored
  dead centre alternate with chaotic, close-proximity handheld work with heavy Dutch tilts.
- **Focal lengths and perspectives:**
  - Extreme low-angle wide shots (ground-skimming) to make subjects loom over the frame.
  - Tight macro lenses with paper-thin depth of field to isolate textural elements (facets of
    jewellery, stitching, vehicle emblems).
- **Shutter timing:** high shutter speed (narrow shutter angle, 45° to 90° / 1/100 s–1/250 s at
  24 fps) during select performance shots, giving fast hand motions an abrupt, staccato,
  motion-blur-free cadence.

## 3. Timestamped reference breakdown

### 3D tracking and optical flares — `[00:00:00]`

- The title "On Nothing" rendered as 3D high-polish chrome script tracked to the front grille of a
  large luxury SUV.
- 3D camera matchmove plus a chrome shader with ray-traced reflections matching the ambient studio
  lights.
- Strong vertical directional blur/streak filter extending upward from the headlights.

### Symmetrical automotive tableau — `[00:00:06]`

- Central subject flanked symmetrically by three SUVs in a blackout room, backlit by vertical light
  columns.
- Low-key lighting; light haze catches the headlight beams, creating sharp rim-light silhouettes
  while floor reflections define depth.

### Optical snap-zoom warp — `[00:00:24]`

- Transition into a medium shot via a radial directional blur and crash-zoom punch.
- Post optic zoom curve paired with a radial blur centred on the performer's face to simulate a
  violent lens snap.

### Multi-matte split screen — `[00:00:28]`

- A hard vertical split: the hood ornament on the left against top-down floor shadows on the right.
- Geometric matte split blending two different lighting environments (dark warehouse vs. bright
  floor cyc) within one frame.

### Triangular prismatic slicing — `[00:00:29]`

- A diagonal, triangular kaleidoscopic mask reveals the subject's face surrounded by folded
  reflections.
- Glass prism/mirror attachment in front of the lens, or a tri-split composite matte with blending
  at the seam lines.

### On-axis direct halo flare — `[00:00:40]`

- Subject dead centre between vehicle headlights, facing the camera.
- Light shines directly down the barrel of the lens, generating a concentric circular rainbow halo
  flare and wrapping the silhouette in heavy spill light.

### CRT scanline overlay and raster artefacting — `[00:00:51]`

- Macro shot showing interlaced scanlines, RGB phosphor triad texture and subtle tube curvature.
- Analog CRT re-recording pass: the edit was run out to a physical CRT and re-filmed to imprint
  genuine phosphor blooming, horizontal raster lines and interlacing jitter.

### High-key cyc and frame echo / ghosting — `[00:01:17]`

- Stark transition: pure white background with the subject moving across the floor.
- Temporal echo (frame blending / time trail). Consecutive frames overlaid at stepped opacities
  (e.g. 20–40 % mix with a 2-frame delay), so feet and limbs leave a kinetic dark smear.

### Bilateral mirror symmetry — `[00:01:23]`

- Hands and jewellery reflected along a central vertical axis, joining at the centre of the frame.
- Horizontal mirror composite with the centre seam matched to ring contact points.

### Multi-image silhouette quadruplet — `[00:01:48]`

- Four identical profile silhouettes standing back-to-back in a row, edge-lit by a soft cyan-teal
  wash.
- One keyed silhouette take duplicated, horizontally offset and flipped symmetrically across four
  vertical quadrants.

### Kinetic wheel tracking with digital glyphs — `[00:02:00]`

- Low ground shot tracking next to a revolving wheel disc, overlaid with floating digital counter
  numbers and ghosted scanlines.
- Planar 2D tracking locking digital typography to the perspective plane of the car door, with
  directional blur streaks and CRT glitch overlays.

## 4. Replicating the visual language: production recipe

| Stage | Practical setup / production | Post-production execution |
|---|---|---|
| **Optics and camera** | Wide primes (18–28 mm) for low-angle hero shots. Clear streak filters (vertical) or anamorphic lenses. Narrow shutter angle (90°) for aggressive motion clarity. | Subtle chromatic aberration on extreme highlight edges. Radial zoom blur on sudden editorial cut points. |
| **Lighting** | Two primary sets: blackout studio and white cyc. Vertical LED tubes in straight parallel lines. High-output hard sources behind the subject aimed into the lens. | Glow/diffusion pass isolated to the top 5 % specular highlights. |
| **Texture and distortion** | Practical haze subtle and even; avoid thick patchy smoke to keep crushed black levels. | Re-scan onto a real CRT, or interlaced scanline displacement with CRT phosphor masking. Time-echo / frame-trail overlays on high-key movement. |
| **Colour grading** | Native ISO with clean shadows, no sensor noise in the deep blacks. | High-contrast S-curve with blacks pulled to 0. Desaturate midtones; cool cyan/steel tint into the upper mids. Bleach-bypass highlight rolloff. |
