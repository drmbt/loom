# Photo Mapping: Video

This example maps animated content onto a synthetic facade with masked openings. The default content is an explicit procedural demo, so the example opens without external media. Video passes through an ordinary Level node; no combined effect shader hides the compositing.

Choose a local clip in the Movie File In node and set the content switch to 1 to use it. Index 0 selects the procedural demo. Adjust the movie's image fit for the desired framing. Video then follows the same surface mask, Grid Warp and Corner Pin as the other photo-mapping effects.

Set `switch_calibration` to 1 for the regular alignment chart and 0 for content. The chart passes through the same mask and projector warps. The Output viewer shows the reference preview; Window Out carries the projection.

Use File → Map from photo and select Mapped video to create a similar setup from a real photograph. Depth and mask inputs can be left for later loading; their explicit initial values are neutral depth and full coverage.
