# Photo Mapping: Moonlit Stone

A synthetic facade demonstrates moving ivory grazing light, relative depth and masked openings. The photo, depth and mask fields are analytic demo data; this example does not estimate depth or demonstrate model accuracy.

Set `switch_calibration` to 1 for the regular alignment chart, or 0 for the effect. Both paths pass through the same surface mask, Grid Warp and Corner Pin before Window Out. The Output viewer shows the reference preview; Window Out carries the calibrated projection.

The graph separates **depth range → illumination → Multiply with Solid tint → Level exposure**. Animate light direction with its LFO, adjust relief/shadow in the small illumination shader, and change colour or exposure downstream. Use Grid Warp and Corner Pin to align the projector. For your photo and saved EXRs, choose **Grazing light · modular** in File → Map from photo.
