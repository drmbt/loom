# Neon Wake verification

Analysed the supplied 109.8-second MP3 through the application's existing `analyseOffline`, using its default detector settings (threshold 0.05, retrigger 0.032). The decoded mono PCM and feature track remain in temporary files; the song is not added to the shipped example.

The old 450 ms hit tail and 40 ms secondary attack kept the snare lane around 60–77% on average in several busy ten-second windows. A 160 ms hit tail and 12 ms secondary attack reduce those averages to about 36–50%, increasing separation. The geometry follower remains independent: 1.1 s attack, 3.3 s release. Fissure emission and rim illumination now emphasize the short snare/kick lanes, and the localized glow receives a short transient contribution.

`neon-wake-30-38.mp4` renders the actual 30–38 s audio passage, after feeding the preceding 15 s into the feature history. The clip uses the supplied song's analysed channels, not the demonstration beat. Video walls remain procedural in this clip; camera hardware was not captured.

Tempo caveat: the embedded generation prompt says 178 BPM, while the existing analyser estimates approximately 120.11 BPM. Neither was independently established as a verified downbeat grid. The preview uses the analyser's tempo; the impulse-response verification concerns the actual detected band onsets. The shipped example retains its own demonstration track's declared grid.

GPU regressions cover fast hit separation, stable radial geometry, visible core openings, portrait center cropping, delayed cells, still-video motion, palette changes, and continuous panel staging. Reference-level photorealism and sustained real-time performance are not claimed.
