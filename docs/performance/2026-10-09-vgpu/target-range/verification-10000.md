# Headed Chrome 10,000-draw verification

15 alternating paired trials, same hardware/builds, all final image hashes match.

Separate GPU medians are 2.258 → 1.799 ms/frame (20.3% difference). That does not verify a stable benefit: the median paired GPU change is +2.9% (slower), with an exploratory 95% interval from -30.9% to +23.9%. The original 11.3% GPU saving and an apparent draw-count cutoff remain unconfirmed.

CPU encode medians are 0.952 → 0.919 µs/draw. The repeat data and paired analysis are retained alongside the original batch; no samples were discarded.
