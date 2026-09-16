# E75 profiling — 1280 × 720

The final warmed-up headless run measured **64.1 ms per frame** over 25 frames, after five warm-up frames. This is a local diagnostic, not an editor FPS guarantee; the live app and other GPU clients may contend for the same device.

The initial diagnostic measured 373.9 ms/frame; disabling doubled room resolution and geometry supersampling measured 90.5 ms/frame. Restricting noise evaluation to the local mist volumes measured 40.0 ms/frame. Conditional panel evaluation and conservative audience bounds measured 24.6 ms/frame. These exploratory runs included their first five frames, unlike the final confirmation.

The initial optimizations retained the geometry and reflections, use MSAA at native resolution, avoid evaluating invisible panel content, reject rays outside audience bounds, and truncate negligible mist tails outside their local volumes. The current measurement includes TimeGrid, a packed video/scene texture and evolving projection families in addition to nested fitted shells, smaller secondary grit, soft-knee half-resolution bloom, slight depth-aware blur, feathered panel projections and wall-light spill. Geometry budget is concentrated on actual shell fragments rather than large secondary stones.

Run `node --import ./src/tooling/alias-hooks.ts artifacts/resonance/profile.ts shipped` for the current patch. Other modes are temporary profiling ablations, not production quality modes. Each JSON reports render-pass GPU spans separately; Apple GPU spans overlap and must **not** be added together. Compute dispatches are included in the settled wall measurement but are not individually attributed by the render-pass timer.

Timing varied materially during this session: a paired comparison measured 61.9 ms/frame with the video path and 54.7 ms/frame with that path disconnected. Restricting the new beam noise to its illuminated volume measured 55.7 ms/frame with the full graph. Earlier 20.2 ms measurements predate the richer projection path and should not be presented as current performance. Live editor performance still needs measurement.

The final graph, including the portrait video crops, moving video overlay and palette cycle, measured 64.1 ms/frame. This remains above a 60 FPS frame budget; no real-time performance claim is made.
