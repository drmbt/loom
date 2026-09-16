# E75 — Resonance

A fractured stone sphere suspended in a dark circular hall. Audio opens a bounded spherical envelope; concentric floor lights, wall projections and ceiling shafts answer different features. The rendered picture contains no typography.

The installation has three nested layers: the outer fractured shell, a second fitted shell at radius 1.42, and a compact luminous core at radius 1.0. Its wider fissures and minimum 22% travel share preserve views into the luminous centre. The inner shell shares the outer shell’s angular alignment, so its fragments do not plug the outer openings, and starts opening only after the outer expansion passes 0.10, reaching a separate 1.7-unit displacement limit at peak energy. Both shells are real surface geometry. A `pointGrid` supplies connectivity; `pointKernel` constructs 128 irregular spherical Voronoi cells as closed curved wedges with 14% radial thickness. Collapsed pole rows make the connections between cells degenerate, so no visible triangles bridge fragments. Each vertex exposes its undeformed `rest` position and its cell's `radial` direction in the attribute inspector. The `tint` attribute carries the stone variation into a `materialPbr` surface. `mineral1` supplies a spatial roughness map so reflected light varies across each piece. The environment map renders the same architecture and panel states as the visible room, so changing the projections also changes their reflected contribution on the stone.

The `seam` attribute identifies the exposed lip. A second kernel reads neighbouring vertices to draw continuous warm light along those edges. Both the surface and its edge light have mirrored geometry below the floor.

Expansion translates each cell along its fixed radial direction. The displacement is clamped to 3.1 world units, with a dense population staying close to the original 2.1-unit sphere. The centre is 5.6 units above the floor; the maximum envelope clears the 0.32-unit pedestal. Every large departing piece is a cell of one of the fitted shells, so its departure uncovers an actual opening. The 192 secondary particles are small grit with individually seeded cut planes and mineral variation; they cannot read as large plates leaving an intact surface behind. Their closed surfaces share the protected envelope and converge as energy falls. A mirrored copy of the geometry supplies the floor reflection.

The renderer exposes camera depth. Reorder sets a constant alpha, then Mask packs that depth into the colour image’s alpha channel without colour-converting it. The room shader uses nearest-sampled depth to place the core in front of rear fragments and behind front fragments; colour remains filtered.

Bass strikes also wash light onto the stone beside each floor ring, preserving the dark areas beyond the fixtures. The wet floor uses individually varied stone slabs, mineral veins and coherent surface ripples; its wetness and viewing angle govern reflected architecture and core light. Localised mist drifts along the wall bases, while ceiling shafts slowly turn and breathe through a widening aperture. Tilted strands carry descending streaks and broad beat-grid crests, staggered across five groups; transients brighten these moving crests without moving the beam positions.

The room shader renders the cylindrical architecture, stepped ceiling aperture, low pedestal, concentric floor lights, integrated wall patterns, audience and scattering. The geometry uses hardware MSAA and the room shades at the project resolution. Thin-beam noise is evaluated only inside a conservative Gaussian bound (outside it, even the broadest tail is below exp(-20)); GPU comparisons preserve visible pixels at warm and violet phases. Local mist noise is evaluated only inside its occupied volumes; conservative audience bounds and conditional panel evaluation avoid shading work that cannot contribute to the picture. A subtle depth-aware lens pass keeps the central ten-unit depth range sharp and limits background/foreground blur to 1.4 pixels. `lens1.strength` set to zero disables it. Depth rejection prevents silhouette bleed. Soft-knee, hue-preserving bloom runs at half resolution before resolving at full resolution; MSAA and FXAA handle edge smoothing without returning to the expensive double supersampling. These shaders are editable graph nodes, alongside the geometry and attributes.

The bound `audioFileIn` plays the shipped demonstration track on open. Replace its file to use other music. The embedded **AudioAnalysis** component separates conditioned spectral levels from decaying onset impulses. Its levels lane follows, normalizes over 16 seconds, then settles; its hits lane retains independent kick, snare, hat, onset and beat counts with a 160 ms decay.

- `body1`: an additional 1.1-second attack / 3.3-second release follower. Low-band and overall normalized energy jointly control expansion with increased contrast between dormant and peak states; high-mid energy contributes to fissures. No drum impulse changes a fragment's identity or radial direction.
- `detail1`: smooths the hit lane over 12 ms. Kicks and beat pulses drive floor rings from a low resting glow into a much brighter strike and a travelling outward wave; snares open fissures and flash the core; hats drive dust and fine ceiling light.
- `air1`: a four-second follower controls slow atmosphere changes. Mid-band levels independently change wall projection brightness.
- `presence1`: a raw-level follower closes the geometry and recedes the atmosphere during silence; loudness acts as a presence gate rather than the only animation signal.

The camera is fixed. `fracture1.rotation` advances at four degrees per second (one turn every 90 seconds), independently of audio. Shell, chips, dust and fissure lights share that rotation around the vertical axis; their floor reflections follow it. Set Rotation to a constant to hold an angle, or change its `abstime * 4` expression to adjust the rate. Stored rest positions remain in the original local coordinates.

Each chip and dust particle has a fixed integer-hashed identity. Its direction, shape, size and travel limit are independent of frame number. Secondary rotation is a small bounded oscillation; its sensitivity to audio does not grow with elapsed time.

The inner layer follows `fracture1.expansion` with its delayed response; it can also be held independently through `innerfracture1.expansion`. For manual energy inspection, set `fracture1.expansion`, `chipform1.expansion`, `debris1.expansion`, `seams1.gain` and `room1.energy` to constants. Zero is the resting shell; one is the maximum envelope. The other band-driven controls continue responding to audio; restore the expressions to resume automatic expansion.

## Panel staging

`room1` has a six-scene bar sequencer. It starts with all panels showing different content, then advances through alternating bays, two-thirds of the bays, a dim shared image, low distinct projections, and an all-shared image. Each scene lasts eight four-beat bars; the final two bars smoothly crossfade into the next. Texture motion continues throughout the fade. Each panel gradually morphs between flowing water, mineral veins, caustic ribbons and constellations. Projection edges feather into the stone. Wall strips run a slow architectural chase beneath their transient accents, with their changing light washing the adjacent stone and its reflection environment; ceiling rings follow the slower atmosphere and high-frequency detail. By default, staging runs on a continuous absolute-time clock with Panel BPM linked to the clip's declared BPM. A timeline lap therefore does not jump back to the all-lit scene. The optional source-clock mode reads the clip's unfiltered `bar + barPhase` and intentionally follows transport wraps. Floor waves always read the source beat position independently of panel staging; neither clock goes through rank normalization or a lag. Set the clip's declared BPM, Beats / Bar and Beat Offset for the track. The patch keeps bar counting on a declared grid; automatic tempo estimates are not treated as verified downbeats. A declared grid continues across silence and follows the file transport.

- **Panel Clock**: 0 (default) uses continuous **Panel BPM** staging across timeline laps; 1 follows the source musical bars, including its transport resets.
- **Panel Sequence**: 1 runs the sequence; 0 holds **Panel Scene**.
- **Panel Scene**: 0 shared, 1 different, 2 alternating, 3 two-thirds, 4 dim shared, 5 low distinct (fully dark only when held with Sequence 0). While sequencing, it selects the starting offset.
- **Panel Bars / Panel Fade Bars**: scene duration and transition duration.
- **Panel Brightness**: overall projection level.
- **Panel Coverage**: smoothly limits the active bays using stable per-panel ranks.
- **Panel Variety**: 0 uses the same moving image everywhere; 1 uses independent seeds, flow rates and evolving patterns. Intermediate values blend them.
- **Panel Audio**: optional mid-band brightness response. Set it to 0 for staging independent of song features.
- **Projection Seed**: changes the reproducible panel identities and patterned selections.

For arbitrary combinations, hold scene 1 and adjust Coverage, Variety and Brightness. Every bay, including the back-left bays, has a projection surface; turning one off is an explicit staging choice.


## Live projection inputs

Set **panelsource1 → Index** to **1** for the webcam or **2** for the file selected on **panelmovie1**. Index **0** uses the procedural projections and does not request camera access. Sources are explicitly selected; missing capture is not replaced by generated imagery.

**timewall1** reuses **TimeGrid**: 12 × 2 portrait cells, 61 frames of history, staggered sweep holds and no grid churn; the architectural shader adds slight staggered scanline accents. The room distributes these cells across the 24 architectural bays, applying luminous contour lines, edge extraction and one shared lighting hue; brightness carries the image detail. Shared staging uses the same delayed cell everywhere; distinct staging assigns one cell per bay. The same live imagery illuminates the sphere's reflection environment. Columns/Rows should remain 12/2 to match the architectural mapping; Span and Spread control the temporal separation.

**room1 → Panel Style** selects automatic slow morphing (0), water (1), mineral (2), caustics (3) or constellation (4) in procedural mode. **Core Gradient** controls the copper-to-cool energy tint. Beam and scattered glow rise nonlinearly with the slow energy envelope, leaving quiet passages substantially softer; percussion adds shorter light accents without driving fragment positions.


Video is center-cropped before source selection and again to the physical bay aspect, preserving proportions. A moving ribbon and scan glow continue over a still camera image; eighth-note accents are offset across eight panel groups and occasional thin scanline shifts stay bounded. **Video Motion** and **Video Glitch** set these amounts. The video panels stay monochromatic within each frame. **Palette Cycle** slowly moves the room lighting and projections through gold, orange and violet (108 seconds); set it to 0 to hold the original warm palette.


All active panels use a continuously falling water sheet as their projection surface. Procedural patterns and TimeGrid video are gently refracted by the flow, and their light catches the moving ridges and droplets. The water remains visible beneath a still or dark picture and follows the room’s single lighting hue. **room1 → Panel Water** controls the surface treatment (1 default, 0 flat projection). Staging still controls the fixtures, and the same water/projector calculation feeds the reflected environment.


The object and room share one palette definition: fissures, internal chip glow, dust, rim/back lights, core, water and architectural fixtures follow the same cycle. Stone stays neutral and the core’s hot center lightens the shared hue toward white. **lens1 → Chromatic** adds radial color separation in pixels, driven by slow energy plus short light impulses; it is zero at rest, reaches at most 0.6 pixels from the default drivers, and has a shader safety cap of 0.75 pixels. Setting it to 0 disables it exactly.
