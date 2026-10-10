# Photo Mapping: Point Cloud

A real 393,216-point surface carries the photograph's colour. Its depth changes positions in three dimensions, and the camera's slow lateral motion exposes parallax and occlusion. The matching source fields in this executable example are synthetic; choose **Photo point cloud** in Map from photo to use your saved depth EXR.

The graph keeps each job separate: **Point Grid → depth unprojection → photographic colour → Geometry → Render and Camera**. Adjust density on Point Grid, relief/FOV on the unprojection kernel, colour gain on the paint kernel, dot size on Geometry, and viewpoint/motion on Camera and its LFO. Coverage scales excluded points to zero area, preserving photographic occlusion without bright additive accumulation.

Near/far and FOV are assumptions for relative-depth display, not measured camera calibration or metric reconstruction. The initial photograph viewpoint is preserved by matching the unprojection and render FOV. A new viewpoint may expose gaps because a single photo contains no hidden surfaces.

Output presents the cloud from an off-axis camera before the final image-space clip, making recesses, parallax and occlusion clear. Window Out retains the final surface mask and projector warps. The regular calibration chart sits behind the same content switch. The reference underlay starts dark; raise its Level brightness to compare against the source image.
