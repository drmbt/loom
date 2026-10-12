# Photo Mapping: Point Cloud

A photographed surface becomes 393,216 coloured points. Travelling curls move the points through space: the depth attribute changes their displacement and phase, so recesses and relief separate instead of moving as one flat card. Cyan highlights follow the crests of the deformation.

The editable chain is **Point Grid → depth unprojection → photographic colour → kernel_current → kernel_attribute_light → Geometry → Render**. The motion kernel writes a custom `motion` attribute; the following kernel reads its strength to brighten and colour the active points. Inspect that attribute in the point spreadsheet. Set Amount to zero to disable both deformation and its colour cue; Speed controls the travelling wave. Density, point size, colour gain and camera pose remain separate controls.

The source photograph, depth and coverage are matching synthetic facade fields. Replace them with a registered photograph and saved EXR maps for a real site. Coverage suppresses points in windows and outside the facade. Near/far and FOV describe assumed relative-depth display geometry, not measured metric reconstruction.

The camera moves gently; the points do the main animation. These are reversible time-driven deformations, not a persistent particle simulation. Output inspects the cloud before image-space clipping; Window Out follows the surface mask, Grid Warp and Corner Pin. The calibration switch selects the alignment chart through the same projector path. Reference brightness starts at zero.
