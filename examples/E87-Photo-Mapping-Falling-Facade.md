# Photo Mapping: Falling Facade

A stone facade separates into staggered sections. Each cohort of photographic points shares a release time, spin and falling trajectory, so windows and pillars break apart as pieces of architecture. A dim source-image underlay keeps the intact architecture readable while warm highlights trace the active sections; the wall reforms and the wave begins again.

The editable chain is **Point Grid → depth unprojection → photographic colour → kernel_falling → kernel_attribute_light → Geometry → Render**. The falling kernel divides the original image into ten columns and seven rows and writes release strength, tile identity, cohort seed and falling age into the custom `motion` attribute. The next kernel reads the release strength to light the moving sections. Amount controls the breakup, Speed controls the cycle, and Strength controls the attribute lighting. Amount zero returns the intact, photographic surface.

This is an analytic, reversible collapse-and-reform animation, not a rigid-body simulation: the sections do not collide. Original photographic coordinates define the cohorts, preserving recognizable pieces rather than treating the surface as unrelated sand grains.

The matching RGB/depth/mask inputs are synthetic facade fields, with no inference or external assets. Replace them with registered photograph and EXR maps for a real site. Near/far and FOV are display assumptions. Output shows the moving cloud before image-space clipping; Window Out keeps the original surface mask and projector calibration path, so projection remains on the registered surface.
