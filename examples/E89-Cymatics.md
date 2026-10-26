# E89 — Cymatics

A dish of liquid on a speaker, filmed from straight above under a rig of coloured lamps. The
speaker shakes the dish; standing waves rise out of the surface and the lamps draw them as
fine contour lines on black. It opens on 29.14 Hz (A#0), the note of the reference
photograph, in a seven-lobed vessel that gives the figure its seven-fold symmetry.

Nothing here is a drawn pattern. The surface is a shallow-water simulation, and every
figure is the liquid answering the drive.

```
feedback_state(feedback) ─► wgsl_momentum(customWgsl) ─► wgsl_height(customWgsl) ─► switch_medium(switch)
feedback_modes(feedback) ─► wgsl_modes(customWgsl) ─► wgsl_plate(customWgsl) ─► switch_medium(switch)
switch_medium(switch) ─► wgsl_surface(customWgsl) ─► layer_sand(layer) ─► threshold_hot(threshold) ─► blur_halo(blur) ─► add_glow(add)
switch_medium(switch) ─► kernel_sand0(pointKernel) ─► points_sand0(renderPoints) ─► add_sand01(add) ─► add_sand(add) ─► wgsl_sandlit(customWgslMulti) ─► layer_sand(layer)
add_glow(add) ─► wgsl_hud(customWgsl) ─► output1(output)
```

## The liquid

`feedback_state` holds the whole state in one float texture: the surface height, the two
face velocities of a staggered grid, and the height change of the last step. Its Substeps
runs `wgsl_momentum` (velocities from the surface: gravity, surface tension, viscosity,
self-advection) and then `wgsl_height` (the surface from the velocities) forty times a frame.

Two mechanisms drive it, the two a real dish has:

- **The Faraday drive** (`Drive`). Shaking the dish swings gravity in the dish's own frame.
  Waves at half the drive frequency are pumped by that swing and grow out of the noise once
  the drive beats viscosity: the subharmonic standing waves of every cymatics photograph.
  Viscosity damps short waves harder than long ones, so high notes need more drive, as in a
  real dish. Turn it up for Faraday's lattices and, past that, their chaos.
- **The meniscus** (`Meniscus waves`). Where the liquid meets the shaking wall, waves run
  inward at the drive frequency itself. The meniscus climbs a bulging wall further, so it
  pumps hardest at the vessel's lobes: a ring of sources whose waves cross in the dish and
  draw the petals, islands and the star at the centre. `Symmetry (lobes)` sets how many.

Substeps all see one frame clock, so the oscillators keep their own: their phases live in
three cells in the corner of the state texture, outside the dish, advanced once per step.
The vessel's centre sits a fraction of a cell off the grid's, and its lobes carry the
figure's symmetry, so the square grid does not impose its own four-fold one. The level
relaxes slowly, against the wave set-up a shaking wall piles up.

`Round → square` bends the dish into a square plate for Chladni's figures; `Dish size`
scales the dish against the sound, so the documented Cymascope tones (Earth day 194.18 Hz,
Sun 126.22 Hz, Venus 221.23 Hz and the rest) still draw readable figures.

`Vessel` picks the container: round (with the lobes), a circle, a square or a hexagon. The
liquid's walls, the plate's outline and the camera's mask all read the same shape function.

## The plate

**Plate (Chladni)** swaps the liquid for a vibrating plate whose figure is computed from the
shape's own modes rather than simulated: its forced response, a sum over the modes weighted
by how close each one's resonance is to the drive (Tuan et al. 2015). Near a resonance one
mode dominates and the figure is crisp; between resonances it smears. A plate obeys Chladni's
law, frequency proportional to the square of the wavenumber.

- circle: Bessel modes J_m(k r) cos mθ with a free rim (the zeros of J′_m are computed when the
  example is built), driven by a ring of sources whose count is `Symmetry (lobes)`, so only the
  modes with that symmetry sound;
- square: Chladni's ψ± = cos(nπu)cos(mπv) ± cos(mπu)cos(nπv), driven at four points on the
  diagonals;
- hexagon: sums over the twelve images of a vector of the hexagonal reciprocal lattice, free at
  every edge.

`wgsl_modes` keeps each mode's amplitude in `feedback_modes` and lets it ring toward the
forced response, so a sweep rings from one figure into the next. `wgsl_plate` writes the
figure in the liquid's own layout, so the lamps, the strobe and the scope read a plate exactly
as they read the liquid. `Plate damping` sets how sharp the resonances are; it ships low (0.005), because a lightly
damped plate rings in one phase and its nodal lines close, where a heavily damped one mixes
phases and its sand lines break into dashes; `Plate drive point`
where the drive sits.

## Sand

**Sand** scatters four million grains over whatever is on show: a Point Kernel holds at most
a million, so four kernels (`kernel_sand0` … `kernel_sand3`), each drawing from its own random
stream, and their pictures summed (`add_sand`). Each frame every
grain makes six random hops, each in proportion to how hard the surface moves under it, and
drifts a little down the slope of that motion (Grabec & Sok 2023): the grains drain off the
places that move and gather on the lines that stand still, as Chladni's sand did, in about a
thousand cycles. `Sand → fine powder` turns the drift around, the way fine powder gathers where
the plate moves most (Faraday 1831). `points_sand0` … `points_sand3` draw the grains into the dish's own square
and `wgsl_sandlit`, the same surface as `wgsl_surface`, lights them from low on one side, over a
darkened plate. **Scatter sand** throws every grain back across the plate.

The sand is a Layer, `layer_sand`, and it ships off. Its Picture is `wgsl_sandlit` and the stack
below it is the plain `wgsl_surface`. Off is bypass: the plain surface passes straight through
and the compiler prunes the whole sand chain, so the four million grains cost nothing while the
sand is off. Its switch and fader sit on the Panel under the Plate toggle; the fader blends the
sand in over the plain surface. Switched on, the grains start scattered and gather again.

## The Faraday lattice

`Vessel` 4 draws the measured end states of the two-frequency Faraday experiments directly: a
standing sum of plane waves whose directions sit evenly round a circle, sharpened by the
quadratic term that makes hexagons point one way. `Symmetry (lobes)` sets the order: twelve
is Edwards and Fauve's twelve-fold quasipattern (two frequencies, 4:5, 1994), six a hexagonal
lattice, and `Second tone` with `Tone ratio` adds a second ring turned half a step, the
superlattices of Kudrolli, Pier and Gollub (6:7, 1998). The shallow-water liquid lacks the
nonlinearity that selects these states, so this is drawn rather than simulated.

## Recipes

`presets_recipes` holds ten documented figures, one button each on the Panel: the reference
photograph (A#0 in a seven-lobed dish), Schumann 7.83 Hz (a label; no source ties it to a
liquid figure), the owner's G at 24.5 Hz, a hexagonal dish, honey (a viscous liquid's
stripes), the twelve-fold quasipattern, the superlattice, Chladni's square and hexagonal
plates with sand, and a circular plate on its seven-fold resonance at 30.35 Hz. A published
frequency belongs to its dish, so these are mapped by figure (wavelengths across the dish),
not copied in hertz.

## The light

`wgsl_surface` is a camera above a mirror. Flat liquid reflects the camera and stays black.
A ring lamp of LED rows around the lens lights every slope tilted by half a row's angle, so
its rows draw the waves as contour lines of slope: the zebra stripes of the photographs.
Each row carries its own colour from the rig, so gentle and steep slopes differ in colour.
Six coloured lamps lower down catch the steep flanks that face them. `Centre → edge colour`
recolours the dish from the rig's centre colour to its edge colour. Six rigs ship: Cymascope,
Prism, Ember, Aurora, Peacock and Neon.

The tone curve acts on brightness alone, so lamps keep their colour instead of washing to
white. The liquid fades into the dark before its wall, and everything outside it is black.

The surface oscillates far faster than a frame, so `wgsl_surface` rebuilds it at a fixed
phase of the drive: a stroboscope, which holds the figure still. `Slow motion` drifts the
strobe's phase and `Shutter` opens the exposure across the cycle for long-exposure streaks.
Tilt, orbit and zoom move the camera; the viewer's orbit camera works too.

## Playing it

Everything is on `panel_cymatics`.

- **Lab.** `Frequency`, `Drive`, the 2nd and 3rd harmonics, a second tone at any ratio, a
  sweep in octaves and its rate, and the meniscus. `wgsl_hud` draws the same sum of
  partials on the oscilloscope; `Scope X-Y` plots it against the fundamental.
- **Tour.** A ladder of eight stops, low to high, on a minor-seventh arpeggio up from A#0
  (29.1 to 116.5 Hz), then one long sweep home. Each stop holds for nine seconds while its
  figure settles, then glides for five to the next, and nothing calms the water on the way:
  the glide is where the turbulence is, and the next figure grows out of it. The vessel's
  symmetry climbs with the pitch (5 to 12 lobes), the rig's palette moves with the glide, and
  each stop has its own signal (a pure tone, a second or third harmonic, a fifth above for
  interference and islands), crossfaded through the glide.
- **Song.** The shipped beat. `beat_kick` (band 109) drops into the water and flashes the
  lamps, `lag_low` (band 380) works the drive, `tail_mid` (band 968) adds the second harmonic
  and bends the pitch, `beat_high` (band 1300) the third harmonic and the shimmer,
  `tail_air` (band 3400) the second tone. The Range bounds are E79's, measured on this clip.
  `Reactivity` scales all of it.
- **Drop** lets a drop fall into the liquid; **Calm the water** lays a hand on it.
- **Scope + readout** shows the instrument panel in the frame's corner: the drive traced on
  a green phosphor graticule and its frequency in hertz (`wgsl_hud`). It is off by default.

A figure takes a few seconds to build after a change, as it does in a real dish.
