# Photo Mapping: Contour Engraving

Ivory engraving follows the depth of window frames, pillars and the carved rosette. This example uses matching synthetic reference/depth/mask fields, without inference or external assets.

The visible recipe is **depth range → contour coverage → Multiply with Solid colour → Level**. Change spacing and width on the small contour stage, motion on its LFO, colour on Solid, and exposure on Level. Replace the source generators with a photograph and saved EXR maps to use the same recipe on a real surface.

Set the calibration Switch to 1 for the regular alignment chart, or 0 for content. Both travel through the same surface mask, Grid Warp, Corner Pin and Window Out.
