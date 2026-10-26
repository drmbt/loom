# Photo Mapping: Ribbon Peel

Architectural relief lifts into twenty-two horizontal ribbons. A travelling wave bends the coloured points away from the facade, exposing depth and negative space while the original image stays readable. Cool cyan light follows the strongest bends.

The editable chain is **Point Grid → depth unprojection → photographic colour → kernel_ribbons → kernel_attribute_light → Geometry → Render**. The ribbon kernel uses original grid coordinates to identify each band and the reconstructed depth attribute to vary its bend. It writes bend energy, ribbon identity, depth and horizontal position into `motion`; the next kernel reads bend energy to colour the active bands. Amount changes the peel, Speed changes the travelling wave and Strength changes the highlights. Amount zero shows the intact photographic reconstruction.

The motion is a reversible analytic deformation, not cloth physics. Camera movement is deliberately gentle so the point motion remains the subject. Density, point size, photographic gain and camera framing stay separately editable.

The facade photograph, depth and coverage share one synthetic source, with no inference or external assets. Replace those fields with registered photo/EXR inputs for a real site. Near/far and FOV are display assumptions. Output inspects the ribbons before clipping; Window Out follows the registered surface mask, calibration switch, Grid Warp and Corner Pin.
