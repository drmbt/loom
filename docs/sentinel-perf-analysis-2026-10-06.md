# Where a frame of sentinel-bot goes (T1666b)

2026-10-06. A measurement and a ranked list. No engine code and no project file was changed. The scripts are scratch and not in the repository (section 8).

What was measured: `projects/sentinel-bot/sentinel.loom.json` as committed at `0fbe1348` (220 nodes, live tier, three robots built), with the kit of the main checkout (`sentinel.glb`, dated 18:11 today; the same vertex and triangle counts as the committed file was built with, one lens 3.7 cm further forward).

A figure is **measured** unless it says estimated. A figure taken once says so. The machine was never quiet (section 2), so every timing carries a reference taken beside it.

## 1. The answer

1. **In the app the piece does not hold 30 frames a second, at either size.** Production build, the editor as the file opens, 160 to 200 s of the show from the top with the loop off. At 1280 × 720, three runs (two to the shipped beat, one to the owner's track): 33.7, 31.2 and 34.4 frames a second, median interval 28.9, 31.3 and 28.1 ms, p95 52, 54 and 50, p99 60, 62 and 58, worst 91, 102 and 79; **40 %, 45 % and 38 % of the frames took longer than 33.3 ms**. At 1920 × 1080: 27.6 (24.7 with other sessions on the GPU), median 39.3 ms, 58 % over 33.3 ms.
2. **It is not lost to one thing: three things are full at once.** At that rate the GPU is 81 to 94 % busy (13 to 18 ms to run the plan), the browser's GPU-process main thread 89 to 99 %, the page's main thread 74 to 95 %. Take one away and the next is the limit.
3. **On the main thread a frame is 10 to 18 ms of the frame loop, and more than half of that is the per-frame values-only compile** (8.6 of 15.3 ms profiled). Half of the compile is expressions: 362 of them a frame, 29,500 syntax-tree nodes, of which 91 % are the same subexpression evaluated again.
4. **The canvas is the other half of the main thread, and it is the spikes.** With the whole graph on the canvas, ten times a second a DOM update of the node tiles costs a Layerize of 20 to 30 ms: one frame task in three. The same updates make the GPU process raster the canvas for 5 to 13 ms a frame. This is T1653b's subject. With the graph's DOM hidden by a probe the same scenes ran at 38 to 59 frames a second in seven windows of eight (31 in the one where the thread ran slowest) against 31 to 42, and the frames over 33.3 ms fell from 13 to 47 in a hundred to two or fewer.
5. **A fullscreen Viewer does not escape it.** The editor behind it is still painted: Layerize 4.5 to 9.4 ms and raster 6 to 14 ms a frame, as with the editor in front.
6. **On the GPU, two thirds to three quarters of the frame does not depend on the pixel count.** It is triangles: 7.1 million a frame with one robot out, 16.2 million with three. At a sixteenth of the pixels the tunnel with the pack still costs 8.5 of its 12.8 ms, the fields 7.9 of 10.6.
7. **The robots are 51 to 58 % of the GPU frame whenever the pack is out, and most of that is the tentacles' rings**: 1,620 instances of 716 triangles, drawn nine times (lit, Normal, Depth, six shadow faces): 4.0 to 4.7 ms. The three hulls, 207,000 triangles each, cost 0.7 ms together.
8. **So meshes are worth optimising in one place and not in the other.** A lighter ring (or a level of detail by distance) is worth about 3.5 ms of GPU with three robots out; an index buffer about 1.2 to 1.5 ms, by a probe outside the engine. Decimating the hull is worth under half a millisecond.
9. **What is not the cost.** The lights: 527 pointset lights and their kernels cost about 1 ms together, the named ones 0.3 ms (T1623b's slices 1 to 3 did this). Garbage collection: 0.2 to 0.5 ms a frame, the longest pause 2 ms. Compiles and pipeline creation: none in any measured window, across every change of place. Compute: every kernel, sweep, rope and light pass together about 1 ms.
10. **"Sometimes" is the canvas's 10 Hz spike on a frame that is already at its limit, and the rest of this machine.** While I measured, the page's main thread ran the same fixed loop up to 2.7 times slower in some windows than in others, and with another session on the GPU the same plan took 36 ms instead of 13. The ranked list is section 5: the canvas (owned, T1653b), the expressions, the rings, the Depth and Normal layers, the places that are not on screen (owned, T1642b).

## 2. Method, and what the machine was doing

**The machine.** Apple M3 Max (10 performance and 4 efficiency cores, 36 GB), macOS 26.3.1, Node 24.11.1. Shared with several sessions and the owner for the whole of the work.

- Load average between 6 and 18. Other sessions ran `tsc`, vitest, Playwright's GPU lane and Dawn renders; the owner's Chrome and WindowServer took 30 to 60 % of a core each.
- The whole machine's GPU utilisation (`ioreg`, the accelerator's own counter), sampled with nothing of mine running: 0 to 19 % at the quietest, 46 to 73 % at other times, 98 % once.
- Every heavy run went through `tools/heavy.sh`. It does not stop work that is not in the queue.

**In the app (table A).**

- `vite build` of the tree above, and the same bundle built once more with its source map so a profile can be read (the same minified code). Served by `vite preview`.
- Playwright 1.62.1, its Chromium 151.0.7922.34 with `channel: "chromium"`, headless, no GPU flags, `--mute-audio`: the `chromium-gpu` lane's mechanism. Adapter `apple`/`metal-3`. Viewport 1920 × 1200, device pixel ratio 1 (2 in one run of A2).
- The project is opened through the product's own file input. The loop is switched off and the time reset, so the track plays through and the show goes where it goes.
- The page's display tick was 8.33 ms (120 Hz). The project asks for 60 frames a second (the default), so at best the app renders on every second tick, and every interval is a multiple of 8.33 ms.
- **Instruments**, planted before the app loads, none of which changes what it draws:
  - counters on the WebGPU prototypes and on `requestAnimationFrame`: for every display tick the time inside rAF callbacks, the submits, dispatches, render passes, draws, buffer writes, objects created, and every shader module and pipeline creation with its duration;
  - **a frame** is a tick in which the plan's dispatches ran (78 of them). Its interval is the time since the previous such tick;
  - a model context that keeps the tools the app publishes (`webmcp.ts`), so the harness calls the app's own `get_runtime_metrics` (the frame's GPU extent, twice a second), `recall_preset` and `get_channels` (the show's state, every two seconds);
  - CDP `Profiler` at 100 µs, read back through the source map; CDP `Tracing` for the threads.
- **References beside every window**: a fixed compute pass on a device of the harness's own, timed by its own timestamp pair five times a second (the GPU probe: 1.38 ms at its fastest, 5.0 to 5.7 ms on an idle GPU, which is B260's clock); a fixed loop on the page's own main thread (the CPU spin: 0.98 ms at its fastest); the machine's GPU utilisation twice a second.
- The probe is 0.7 % of the GPU and the spin 0.5 % of the thread. The tool calls are one small task every half second.

**Headless (tables B, C, D).**

- `scratchpad/t1666/frame.ts`, grown from B260's `consumer.ts`. The frame is run as the app runs it: the value graph, `prepareFrameCompiler().compileFrame`, the uniform animator, `backend.render`, each timed.
- Dawn on Metal. The device's timestamp queries; **a fixed reference compute pass timed beside every frame** (2.75 to 2.88 ms at its fastest in a batch; 3.1 to 3.9 ms beside the lightest variants, which is B260's clock and why raw milliseconds are not compared); the variants of a batch run in one process in the order listed, the first repeated last.
- **"Full clock"** is the median of the frame-by-frame ratio of the frame's GPU time to the reference, times the fastest reference median of the batch. Raw milliseconds are in the scratch output and are not compared across batches.
- The frame's GPU time is the sum of the extents of the 18 vgpu frames one headless render is split into.
- 100 to 120 timed frames a variant after 40 (the first two batches 60). The output is drained between frames.
- **Per-pass timing exists and cannot be used for shares.** With one device pass per draw the spans sum to 54 to 134 ms against a frame of 9.5 to 14.4 ms: on this GPU a pass's vertex and fragment stages overlap its neighbours'. The performance pane says the same of itself. So table B is by **ablation**: the frame, then the frame with one thing taken out.
- **Ablation is not additive either.** The casting light's shadow saves 1.0 ms taken out alone in one batch and 3.1 ms taken out after the finish chain: vertex-bound and fragment-bound work run side by side, and removing one shortens the frame only as far as the other. Each row is "what removing this alone saves"; rows do not sum to the frame.
- A scene is one of the document's own scene presets, held, with the eases shortened so it is there at once. Stills of all eight were looked at.

## 3. The tables

### A. The frame in the real app

**A1. The interval between frames, 160 s of the show from the top** (120 and 200 s where the notes say). Editor: the layout the file opens in, the whole graph fitted on the canvas (220 tiles at zoom 0.05), the Viewer in its pane at 472 × 266. In every row the GPU probe read 1.44 to 1.77 ms (full clock: the app keeps the GPU busy).

| Run | Size | Frames a second | Median | p95 | p99 | Worst | Over 33.3 ms | Over 50 ms | rAF of a frame, median | GPU extent, median (p95) | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| editor, first run | 1280 × 720 | 33.7 | 28.9 | 52.0 | 60.0 | 91 | 2,158 of 5,413 (40 %) | 312 (5.8 %) | 12.1 | 16.3 (24.8) | GPU clear; the frame loop's time rose from 11 to 16 ms from 104 s on (no spin: the reference was added after this run and the Viewer run) |
| the same, its first 100 s | | 36.3 | 26.6 | 47.1 | 54.6 | 74 | 35 % | 2.4 % | 11.1 | 17.1 | |
| the same, from 104 s | | 29.4 | 34.6 | 56.9 | 65.7 | 91 | 51 % | 13 % | 15.6 | 16.3 | |
| editor, second run | 1280 × 720 | 31.2 | 31.3 | 54.0 | 61.7 | 102 | 2,226 of 4,994 (45 %) | 417 (8.4 %) | 15.1 | 15.1 (38.3) | CPU spin 1.83 |
| Viewer fullscreen | 1280 × 720 | 30.8 | 29.2 | 56.2 | 65.0 | 93 | 1,954 of 4,947 (40 %) | 568 (11.5 %) | 17.4 | 18.3 (27.7) | load rose from 7 to 16 during the run |
| editor | 1920 × 1080 | 27.6 | 39.3 | 57.6 | 67.7 | 91 | 2,564 of 4,428 (58 %) | 463 (10.5 %) | 14.0 | 21.8 (30.1) | GPU clear; CPU spin 1.63 |
| editor, another run | 1920 × 1080 | 24.7 | 44.0 | 60.3 | 74.8 | 94 | 2,706 of 3,949 (69 %) | 743 (19 %) | 14.6 | 26.3 (42.6) | other sessions held 53 % of the GPU before it opened |
| editor, the project set to 30 fps | 1280 × 720 | 29.5 | 33.6 | 54.1 | 64.4 | 82 | 1,697 of 3,544 (48 %) | 283 (8.0 %) | 12.3 | 14.2 (24.0) | 120 s |
| editor, to the owner's track | 1280 × 720 | 34.4 | 28.1 | 49.9 | 58.2 | 79 | 2,624 of 6,888 (38 %) | 279 (4.1 %) | 12.5 | 14.9 (25.8) | 200 s; `metallic-pursuit.m4a`, built at 134 bpm (441 beats in 198 s), offset 0 |

- **A frame is never 16.7 ms for long.** In the first run 32 % of intervals were two ticks (16.7 ms), 15 % three, 22 % four (33.3 ms), 17 % five, 8 % six, 3 % seven or more.
- **Asking for 30 does not hold 30.** The 30 fps project made 28 % of its intervals exactly 33.3 ms and 38 % longer. A frame that carries a canvas spike misses its tick whatever the target.
- Per frame the app asks the device for 80 submits (78 of them one dispatch each), 34 render passes, 70 draws and 100 buffer writes of 22.4 KB together. It creates no bind group, texture, shader module or pipeline while it plays.

**A2. What the editor around the picture costs: one browser, one held scene, the layouts alternated.** The fields with the pack of three and the searchlights. 10 s a window, then 4 s of trace. Two runs of nine windows; the page's main thread was slower in some windows than others (the spin column), so read each row with its spin.

- **editor**: as in A1. **zoom**: the canvas zoomed in on the finish chain (zoom 0.75, a dozen tiles with their previews). **Viewer**: fullscreen, the editor mounted behind it. **no canvas**: a probe, not a product state: the graph's DOM hidden by a style the harness injects.
- Main and GPU-process figures are per main frame, from the trace.

| Run, window | Layout | Spin, ms | Frames a second | Over 33.3 ms | Main thread busy | rAF | Layerize, mean (frames over 10 ms) | GPU-process main thread busy | of it: WebGPU decode | raster | SwapBuffers (waiting for Dawn) | GPU extent, one reading |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| a1 | editor | 1.16 | 39.1 | 106 of 390 | 74 % | 11.6 | 4.9 (37 of 144) | 99 % | 4.2 | 7.1 | 15.3 (14.6) | 13.4 |
| a2 | Viewer | 1.42 | 42.2 | 66 | 85 % | 12.3 | 4.5 (38 of 165) | 98 % | 4.1 | 5.9 | 13.2 (12.5) | 13.5 |
| a3 | zoom | 1.91 | 42.8 | 15 | 100 % | 17.5 | 0.8 (0 of 178) | 69 % | 4.9 | 3.1 | 6.1 (4.9) | 14.3 |
| a4 | no canvas | 1.83 | 43.7 | 2 | 100 % | 17.0 | 0.0 (0 of 151) | 43 % | 4.7 | 0.1 | 5.2 (4.5) | 16.7 |
| a5 | editor | 1.83 | 33.0 | 122 | 91 % | 17.8 | 7.9 (34 of 106) | 94 % | 5.5 | 12.1 | 16.7 (15.4) | 13.4 |
| a6 | Viewer | 2.53 | 24.8 | 160 | 100 % | 20.7 | 9.4 (29 of 94) | 65 % | 5.9 | 14.0 | 6.1 (5.2) | 15.7 |
| a7 | zoom | 2.66 | 35.2 | 45 | 100 % | 22.3 | 1.2 (0 of 134) | 64 % | 6.3 | 4.7 | 6.5 (4.6) | 14.9 |
| a8 | no canvas | 2.59 | 31.2 | 115 | 100 % | 21.4 | 0.1 (0 of 118) | 35 % | 6.0 | 0.1 | 4.0 (3.1) | 15.5 |
| a9 | editor | 1.42 | 25.1 | 173 | 57 % | 12.2 | 9.3 (38 of 75) | 99 % | 6.1 | 13.0 | 33.0 (32.5) | 36.1 |
| b1 | editor | 1.83 | 31.4 | 138 | 87 % | 16.6 | 8.4 (37 of 110) | 97 % | 5.2 | 10.9 | 18.1 (16.4) | 26.4 |
| b2 | no canvas | 2.17 | 48.7 | 2 | 100 % | 18.6 | 0.0 (0 of 190) | 69 % | 4.8 | 0.1 | 8.3 (7.7) | 13.9 |
| b3 | Viewer | 1.63 | 43.2 | 57 | 91 % | 13.6 | 4.5 (37 of 169) | 98 % | 4.1 | 6.1 | 12.3 (11.5) | 13.4 |
| b4 | zoom | 2.24 | 39.1 | 11 | 100 % | 20.8 | 1.1 (0 of 144) | 72 % | 6.0 | 4.6 | 7.7 (5.9) | 14.2 |
| b5 | editor | 1.86 | 30.8 | 144 | 90 % | 15.9 | 6.0 (35 of 128) | 94 % | 4.3 | 8.6 | 15.6 (14.5) | 14.1 |
| b6 | no canvas | 2.17 | 38.0 | 5 | 100 % | 18.0 | 0.0 (0 of 143) | 39 % | 4.8 | 0.1 | 4.4 (3.7) | 14.7 |
| b7 | Viewer | 2.16 | 29.3 | 126 | 100 % | 15.0 | 5.2 (31 of 142) | 75 % | 4.7 | 6.9 | 8.3 (7.5) | 14.9 |
| b8 | zoom | 1.85 | 48.0 | 5 | 99 % | 17.0 | 0.8 (0 of 175) | 76 % | 5.1 | 3.2 | 8.0 (7.1) | 14.4 |
| b9 | editor | 1.82 | 32.7 | 140 | 85 % | 14.6 | 5.9 (36 of 128) | 97 % | 4.2 | 9.1 | 15.9 (14.7) | 13.0 |

Two more runs of the same kind, by layout (each cell a window, in the order taken):

| Run | Layout | Frames a second | Over 33.3 ms, of the window's frames | Spin | Layerize, mean | GPU-process main thread busy |
|---|---|---|---|---|---|---|
| fields, device pixel ratio 2 | editor | 42.2, 36.0, 34.2 | 54 of 420, 109 of 360, 121 of 342 | 1.12, 1.83, 1.83 | 3.8, 6.4, 7.6 | 98, 95, 93 % |
| | no canvas | **59.1**, 51.4 | 0, 0 | 1.59, 2.17 | 0.0, 0.0 | 71, 66 % |
| | Viewer | 40.7, 34.2 | 84, 91 | 1.82, 2.14 | 5.2, 6.9 | 93, 80 % |
| walk (tunnel, one robot), ratio 1 | editor | 34.2, 34.1, 38.6 | 135 of 342, 118, 85 | 1.44, 1.84, 1.83 | 5.0, 5.7, 6.5 | 94, 89, 91 % |
| | no canvas | 56.0, 40.1 | 0, 9 | 2.16, 2.16 | 0.0, 0.0 | 59, 30 % |
| | Viewer | 40.6, 36.1 | 68, 75 | 2.16, 1.84 | 5.1, 5.5 | 86, 67 % |
| | zoom | 40.7, 43.4 | 8, 2 | 2.53, 2.17 | 1.0, 0.9 | 61, 59 % |

What it says, each from the rows:

- **The editor with the whole graph on the canvas: the GPU process is the limit.** In every editor window with a clear GPU its main thread is 89 to 99 % busy. Its frame is the decode of the page's WebGPU commands (3.6 to 6.1 ms), the raster of the canvas (5 to 13 ms) and a wait inside `SwapBuffers` for the page's own commands to be scheduled (`IOSurfaceImageBacking::WaitForCommandsToBeScheduled`, 12 to 16 ms, about the time the GPU takes to run the plan). 31 to 42 frames a second over eleven such windows; 13 to 47 % of the frames over 33.3 ms.
- **Without the canvas: the page's main thread is the limit.** 97 to 100 % busy in every "no canvas" and "zoom" window; the GPU process falls to 30 to 76 %. 38 to 59 frames a second in seven "no canvas" windows of eight (31 in the one where the thread ran slowest), and 0 to 9 frames of a window over 33.3 ms in those seven. Once it reached the project's own 60: 59.1, no frame over 29 ms, the main thread 97 % busy at 15.8 ms a frame.
- **The pixel ratio did not show.** At ratio 2 the editor, Viewer and "no canvas" windows read as at ratio 1 (one run).
- **Zoomed in, the canvas costs a tenth of what it costs fitted.** Layerize 0.8 to 1.2 ms against 3.8 to 9.3; no frame over 10 ms; raster 3 to 5 ms. Twelve more render passes and draws a frame for the previews that are now on screen.
- **Fullscreen is the editor's cost with the editor out of sight.** Layerize and raster are those of the editor windows.
- **Window a9 is another session on the GPU**: the probe read 2.42 ms, the plan took 36 ms where it takes 13, and the frame rate fell to 25 with the main thread 43 % idle. That is what the owner's "sometimes" looks like when the cause is outside the app.
- **The fastest the frame loop was seen is 10.1 and 10.9 ms** (the first editor window of two runs, spin 1.12 and 1.16; before a project is open the spin reads 0.98 to 1.02). In most windows it was 14 to 18 ms and the spin 1.6 to 2.2. Whether a browser in front of a person gets the fast thread more often than a headless one does was not measured (section 6).

**A3. The main thread, by function** (CDP profile, 12 s of the show, 376 frames, editor layout, one profile; the rAF median was 16.9 ms then, so multiply by 0.6 to 0.64 for the fastest thread seen). Inclusive time per frame.

| Part | ms a frame | Of it |
|---|---|---|
| The frame loop (`frame-driver` tick) | 15.3 | |
| The value graph (channels advance) | 1.8 | `evaluate` 1.3 |
| **The per-frame compile, values lane (`compileFrame`)** | **8.6** | |
| - parameter resolution | 5.0 | |
| - - expression evaluation | 4.2 | reads of other nodes 2.8, of which the app's chain of channel resolvers 1.7 |
| - nodes re-emitting their passes | 2.2 | the Render 1.0, point kernels 0.85, materials 0.3 |
| - the generated-text key walk | 0.75 | |
| - the time probe, pass read and compare | 0.9 | |
| Uniform push (`updateUniforms`) | 1.3 | vgpu's validate, clone and pack |
| Plan execution and command encoding (`backend.render`) | 2.9 | dispatches 1.0; native `submit` 0.4 |
| Frame observers (pulse watcher) | 0.5 | |
| The preview tick | 1.15 | |
| React, render and commit | 1.6 | the value plots' and bars' own script is 0.05 |
| Garbage collection | 0.37 | |
| Outside script (`(program)`: style, layout, paint, Layerize, commit) | 10.7 | A2 and section 4 |

- `compileGraph` does not appear: **in the app every frame takes the values lane.**
- By thread, from the trace of the same state (6 s, 160 main frames, 27 frames a second): the page's main thread 89 % busy, 33 ms a main frame, of which animation-frame callbacks 17.7, Layerize 9.0, Paint 1.1, Layout 0.75, timers 2.5, garbage collection 0.34 (46 scavenges, none over 2.0 ms, no major collection). The GPU process's main thread 92 % busy.

**A4. Each held scene, editor layout, 1280 × 720** (8 s a scene, one run; spin 1.4 to 2.2).

| Scene | Frames a second | Median | p95 | Over 33.3 ms | rAF | GPU extent in the app | Headless, full clock (B) |
|---|---|---|---|---|---|---|---|
| walk: tunnel, one robot | 34.7 | 25.5 | 49.0 | 92 of 279 | 14.8 | 12.0 | 8.5 |
| eyes: tunnel, close | 35.3 | 25.0 | 49.4 | 95 | 14.6 | 12.5 | 9.3 |
| strike: tunnel, attacking | 32.4 | 26.5 | 51.2 | 114 | 15.3 | 15.3 | 10.9 |
| swim: tunnel, the pack | 29.2 | 32.1 | 56.5 | 111 of 234 | 16.7 | 18.4 | 12.8 |
| fields: pack, searchlights | 37.4 | 22.3 | 47.8 | 104 of 311 | 11.9 | 13.5 | 10.6 |
| stand: fields, attacking | 33.6 | 25.1 | 49.8 | 113 | 14.9 | 14.4 | 12.1 |
| dock: pack | 29.6 | 34.8 | 54.9 | 122 of 244 | 16.6 | 16.3 | 12.2 |
| temple: pack | 34.7 | 23.8 | 50.8 | 94 | 14.8 | 14.6 | 11.0 |

- No scene holds 30 in the editor layout: a third to a half of the frames are over 33.3 ms in every one.
- The headless figures for eyes, strike and stand are from the first sweep, which read 0.5 to 0.9 ms higher than the later batches on the scenes they share.
- The app's GPU extent is 1.3 to 1.45 times the headless figure. The app's is one extent from the first pass to the last with whatever else the GPU did between (the canvas's raster, the previews, the probe); the headless one is the plan's 18 segments summed. The difference was not taken apart.

### B. The GPU, headless, by ablation

Full-clock milliseconds at 1280 × 720. "Saves" is the baseline minus the frame without the thing. A baseline was read at the start and the end of each batch; where the two differ both are given. Differences under about 0.5 ms are inside the noise of a batch (a baseline read twice in one batch differed by 0.1 to 0.7 ms).

**B1. The frame, and what taking one thing out saves.**

| | walk (tunnel, 1 robot) | swim (tunnel, 3) | fields (3) | dock (3) | temple (3) |
|---|---|---|---|---|---|
| **The frame** | 8.5, 8.5 | 12.7 to 13.6 (four batches) | 10.5, 10.7 | 12.2, 12.1 | 11.0, 11.1 |
| At 320 × 180 (a sixteenth of the pixels) | 4.6 | 8.5 | 7.9 | 8.5 | 8.3 |
| The robots: hull, rings, claws | 2.25 (26 %) | 6.5 (51 %) | 6.1 (58 %) | 7.0 (58 %) | 6.0 (54 %) |
| - the rings | 1.3 | 4.7 | 4.0 | | |
| - the hulls | 0.16 | 0.70 | | | |
| - the claws | | 0.32 | | | |
| The finish chain with the Depth and Normal layers only it reads | 3.6 (42 %) | 4.6, 4.8 | 4.0 (38 %) | | |
| - Normal layer, reflections, occlusion | 2.3 | 3.1 | | | |
| - both layers and the four screen-space passes | 3.2 | 4.5 | | | |
| The casting light's shadow (`light_body`) | 1.0 | 3.2, 3.1, 3.1 (and 1.0 in the first batch, where that variant's reading spread from 3.5 to 5.0 times the reference) | 2.9 | | |
| The tunnel (`geometry_bore`) | 2.8 | 2.5 | | | |
| The place's own shell | | | towers 1.4 | hall 1.7 | cave 1.3 |
| The three places that are not on screen | 0.5 | 1.1 | 1.2 | | |
| The pointset lights of the place | lamps 0.0 | lamps 0.1 | searchlights 0.2, storm and strike 0.1 | work lamps 0.55, beams 0.2 | fires 0.25 |
| Every pointset light, the sun and their kernels | | 1.0 | | | |
| The named lights that do not cast (eyes, two followers) | | 0.3 | | | |
| Dust (`geometry_motes`), flames, formations, bridges, cones | | under 0.3 each | cones 0.2 | 0.1 | 0.0 |
| The Rope chain; the rope switched on | 0.2; +0.4 | | | | |

**B2. The finish chain, pass by pass** (swim; two batches).

| Taken out | Saves, ms |
|---|---|
| Occlusion (`wgsl_occlusion`) | 0.9, 1.2 |
| Focus (`wgsl_focus`) | 0.8, 0.2 |
| Air (`wgsl_haze`) | 0.3, none |
| Reflections (`wgsl_reflect`) | none, 0.1 |
| Bloom: bright pass, four down, four up, the add | 0.1, none |
| Lens, glitch and grade together | 0.4 |
| The four screen-space passes at half size instead | 1.7 |

- The chain's passes together are 1.9 to 2.5 ms (the two batches). The other 2.4 to 3 ms of "the finish chain" in B1 is **the scene drawn twice more**, into the Normal and the Depth targets, for the chain to read.

**B3. How it scales.**

| With | Measured | So |
|---|---|---|
| Pixels | walk 4.6 / 5.6 / 8.5 / 13.9 / 22.5 ms at 320 / 640 / 1280 / 1920 / 2560 wide; swim 8.5 / 9.5 / 12.8 / 19.0 / 28.1; fields 7.9 / 8.6 / 10.6 / 14.0 / 18.4 | a part that does not move (4.4 ms with one robot, 7.7 to 8.3 with three) plus 2.7 to 5.6 ms a megapixel. At 1280 × 720 the pixels are 46 % of the walk, 34 % of the swim, 26 % of the fields |
| Robots out | swim with 1, 2, 3 out: 8.45, 10.3, 12.75 | 2.15 ms a robot, whatever its size on screen |
| Triangles | a robot is 4.56 million triangle-passes (hull 0.62, rings 3.48, claws 0.46) for 2.15 ms; the rings alone 10.4 million for 4.7 ms | 0.45 to 0.47 ms a million triangles submitted |
| Lights | 75 lamps in the grid: nothing measurable; 527 pointset lights with their seven kernels and gathers: 1.0 ms | flat since T1623b's slices 1 to 3 |
| Points | the app's own spans for the 38 point nodes (kernels, grids, sweeps, curve frames, the rope) sum to 0.98 ms; headless, taking the Rope chain out saves 0.2 ms | compute is not the cost |

- CPU beside the same batches (the frame's CPU time over the spin, against the baseline's): without the three other places 0.69 to 0.73; without the pointset lights 0.86; without the finish chain 0.82 to 0.85. Table D has the absolute figures.

### C. The meshes

**C1. What is drawn** (from the compiled plan; every mesh and grid is a non-indexed triangle list: the vertex stage reads `meshIndices[vertex_index]` from a storage buffer, so it runs three times a triangle).

| Geometry | Triangles | Unique vertices | Vertex stage runs a draw | Instances | Passes that draw it | Triangles a frame |
|---|---|---|---|---|---|---|
| Hull (`mesh_hull`) | 206,990 | 152,490 | 620,970 | 1 a robot out | 3: lit, Normal, Depth | 0.62 M a robot |
| Ring | 716 | 1,250 | 2,148 | 540 a robot out (54 rings, ten tentacles) | 9: the three, and six faces of the body light's cube shadow | 3.48 M a robot |
| Claw | 5,084 | 5,722 | 15,252 | 10 a robot out | 9 | 0.46 M a robot |
| Tunnel (`geometry_bore`, a 256 × 768 grid) | 391,170 | 196,608 | 1,173,510 | 1 | 3 | 1.17 M |
| Towers (462 strips swept) | 188,496 | | 565,488 | 1 | 3 | 0.57 M |
| Hall | 109,634 | 55,296 | 328,902 | 1 | 3 | 0.33 M |
| Cave | 91,266 | 46,080 | 273,798 | 1 | 3 | 0.27 M |
| Formations, bridges, bolts | 56,666 | | | 1 | 3 | 0.17 M |
| Flames, dust, fire glow, beams, cones (additive) | 35,100 | | | | 1: lit | 0.04 M |

- **A frame submits 7.1 million triangles with one robot out and 16.2 million with three**, at any output size. 2.5 million of them are the four places, drawn whichever one the camera is in (three of them drawn in to points).
- A robot that is not out costs nothing at the draw: its instances are rejected by Group and the draw is an indirect draw of what is left (T1581b F1). The 16.2 million is with the pack out.
- 69 draw calls in 32 device render passes, 75 compute passes, 94 submits a frame headless.

**C2. Vertex-bound or fragment-bound.**

- **The rings are vertex-bound.** At 320 × 180 taking the rings out still saves 4.5 ms (4.7 at 1280 × 720). The three robots together still cost 5.9 ms there.
- With the unlit material on the rings the frame saves 3.9 ms, but that is not a clean test: an unlit geometry also leaves the shadow sweep (six passes fewer in the plan), so it removes two thirds of the rings' triangles with their shading.
- The hull's 0.7 ms is mostly its shading: unlit, 0.5 ms of it goes.
- The tunnel is half and half: unlit saves 1.1 of its 2.5 ms.

**C3. A probe of the mechanism** (`mesh-bench.ts`: raw WebGPU on Dawn, the kit's ring, 1,620 instances a dozen pixels across, the six varyings the engine's mesh-instance vertex stage writes; not the engine's shader. Reference beside every frame; the first variant repeated last: 2.38 and 2.37 times the reference).

| Variant | Frame over reference | Against the first |
|---|---|---|
| Lit, 9 passes, pulled by index from storage as the engine draws | 2.38, 2.37 | |
| The same with an index buffer | 1.92 | 20 % less; 31 % of the part that grows with triangles |
| The same with half the triangles | 1.62 | 32 % less |
| The same with a quarter of the triangles | 1.27 | 47 % less; 73 % of the part that grows with triangles |
| Depth only (one varying), 6 passes, pulled | 1.46 | |
| The same with an index buffer | 1.32 | 25 % of the part that grows with triangles |
| The same with a quarter of the triangles | 1.04 | |

- The part that grows with triangles is 1.52 times the reference for 10.4 million triangle-passes: 0.41 ms a million at the engine's clock, which is table B3's figure from the other direction.
- A lit pass costs 1.8 times a depth-only pass per triangle: the varyings a vertex writes are part of what a triangle costs.

**C4. So, honestly.**

- **Rings: yes.** They are a third of the GPU frame with the pack out and they are triangle-bound. A ring is 716 triangles and is small on screen in every shot but the close ones (eyes, strike).
  - A ring of a quarter of the triangles: about 3.5 ms of 12.8 with three robots out, 1.0 ms of 8.5 with one (three quarters of 4.7 and of 1.3).
  - Half the triangles: about 2.3 ms and 0.65 ms.
  - A level of detail by distance (the leader's rings whole, the followers' light) gets most of the first figure and keeps the close shots.
  - An index buffer: 25 to 31 % of the triangle-bound part in the probe, so 1.2 to 1.5 ms with three out. Estimated from the probe, not measured in the engine.
- **Hull: no.** Three hulls of 207,000 triangles cost 0.7 ms. Decimating it buys under half a millisecond and costs the close shots.
- **Culling what is off screen: little here.** The followers are in frame in the pack's shots, and what is behind the camera is already not rasterised; the vertex stage still runs for it. A cull by the shadow light's reach would not drop the followers either: they fly 5.5 and 11 m behind a light of range 12.
- **Merging draws: no.** 69 draws in 32 device passes; the encode is 2.9 ms on the main thread and is not where a millisecond hides (T1604b took that).
- **Drawing the scene once instead of three times** is the other mesh-shaped lever and is larger than any decimation of the hull: the Normal and Depth layers are two more passes over every triangle (ranked list, row 5).

### D. The CPU side, headless

**D1. A frame's CPU, part by part** (vgpu's mock device, so no GPU work bends it; 300 frames; the two quietest runs, spin 6.3 to 6.8 ms against 5.7 at its fastest. p10 to median).

| Part | ms | Notes |
|---|---|---|
| Value graph | 1.0 to 1.1 | 102 value nodes publish a frame |
| **The values-only compile** | **6.1 to 6.7** | 143 nodes re-resolved, 90 passes re-emitted and compared |
| Uniform push | 1.0 to 1.1 | 72 blocks a frame |
| Encode through vgpu (no device) | 1.25 to 1.4 | |
| **Together** | **9.5 to 10.4** | the app's fastest frame loop, 10.1 to 10.9 ms, is this with the browser's encode in place of the mock's, and the previews |
| With Dawn in the loop: encode and submit | 3.4 to 4.0 and 1.7 to 2.0 | 94 submits |
| The same frame through the full compile | 16.6 to 19.8 for the compile alone | what the values lane saves |
| Without the three places that are not on screen | 7.0 to 8.5 together | 2.8 ms less: compile 1.6, push 0.5, encode 0.6 |

- **Which lane.** The values lane, on every frame: no animated parameter of this document is structural (`uniformOnly` true), and the verifier refused none of 640 frames headless. In the app `compileGraph` is absent from the profile.

**D2. Expressions.**

| | |
|---|---|
| Expressions in the document | 365: 341 parameter slots and 24 statements of Value Expression nodes |
| Distinct texts | 206 |
| Characters | 186,805 |
| Syntax-tree nodes | 26,218; median 17 an expression, p90 220, largest 443 |
| Reads of another node in the text | `.chan` 3,210; `.par` 28 |
| Distinct read targets | 88 |
| Evaluated a frame (counted, V8 precise coverage over 200 frames) | 362 expressions; 29,535 tree nodes; 3,568 node reads, 3,540 of them through the channel resolver |
| Distinct subtrees | 2,290: **8.7 % of the nodes; the other 91 % are a subexpression that was already evaluated this frame** |

- **The `.par` reads are not the cost they were.** There are 28, all of `camera_rig` (the four screen-space passes read its eye, aim and lens), and since T1172 a read goes through a per-frame memo.
- **The `.chan` reads are.** The most read: `slider_fields.chan.fields` 392 times in the text, `speed_travel.chan.value` 378, `audiofile_track.chan.bar` 330, `lag_pack.chan.value` 320. In the app each read walks a chain of resolvers (MIDI, OSC, analyze, depth, vision) before the value graph answers: 1.7 ms a frame as profiled, of which the value graph's own answer is 0.5.
- **Where the nodes are.** `kernel_search` and `kernel_searchlights` hold 4,785 tree nodes each, 36 % of the document's, and are evaluated every frame whether a searchlight is on or not. `wgsl_haze` 3,741, `expression_camera` 1,602, `material_hull` 1,390.
- The most repeated: one 75-node subtree (the drift of a robot off the axis) appears 55 times, a 26-node one inside it 147 times; "which place is this" (94 nodes) 30 times.

**D3. The profile's top functions** (mock device, 600 frames of the fields; self time as a share of the frame tick).

| Function | Share |
|---|---|
| `evaluateNode` (expressions) | 11.6 % |
| the reference reader (`node-references.ts:635`) | 6.5 % |
| `descend` and `step` (`wgsl.ts`, the generated-text key walk) | 8.0 % |
| the channel resolver (`value-graph.ts:277`) | 4.7 % |
| `emitGeometry` (`scene.ts`) | 2.7 % |
| `evaluate` (`value-graph.ts`) | 2.6 % |
| `resolveSchemaWith` | 2.5 % |
| `compileFrame` itself | 2.2 % |
| garbage collector | 2.2 % |
| `nodeIdNamed`, `nodeNames` | 3.6 % |

- Calls a frame worth knowing: `updateUniforms` scans the plan's 220 passes for a loop marker on each of its 72 calls (15,840 predicate calls); vgpu's uniform `set` clones 11,800 values and validates 5,300 scalars.

## 4. What a slow frame is

Read from the windows above, the trace and the worst intervals of the long runs.

**1. A canvas spike (the editor layout, and fullscreen).**

- In the trace, frame tasks under 30 ms have a Layerize of 0.0 ms (median); tasks of 30 to 45 ms have 20.2 ms of it; tasks of 45 ms and over have 25.7 ms (p90 29.9).
- 52 of 160 frame tasks carry more than 10 ms of Layerize. They are **116 ms apart** (p10 97, p90 136): the 10 Hz DOM updates of the node tiles (value plots, value bars, readouts). The script of those updates is 0.05 ms a frame; the cost is the browser's.
- In the app's own terms: every long task of the long runs (135 in the first, all over 50 ms, 226 ms apart) holds a frame's rAF and about 20 ms of callbacks; the other 30 ms or more is not the frame loop.
- Of the frames over 51 ms in the first run, 48 % have such a task in their interval; of the 2,451 under 26 ms, one.

**2. A frame that was already at the limit.** There is no slack to absorb the spike: the GPU process's main thread is 89 to 99 % busy in the editor layout. So one frame in three is late by two or three display ticks.

**3. The pack, and the size.** Three robots out is 4.3 ms more GPU than one (headless), and the app's extent goes from 12 to 18 ms in the tunnel. At 1920 × 1080 the plan alone is 14 to 19 ms headless and 22 ms in the app.

**4. Somebody else's work.** Window a9 and the second 1920 run are the same picture with another session on the GPU: extent 36 ms for 13 (26 for 22 at 1920), the rate under 30 with the app doing nothing different. The last minute of the first 1280 run is the same picture with a slower main thread: a frame loop of 16 ms for 11 while the load average rose from 6.5 to 8.7 (that run has no spin to say more).

**What a slow frame is not.**

- **Not a compile and not a pipeline.** No shader module and no pipeline was created in any measured window; the show crossed every place (tunnel, fields, dock, temple, and back) with none. Every pass of every place is built at load and runs every frame.
- **Not a full compile.** No frame left the values lane.
- **Not garbage collection.** 7.7 scavenges a second of at most 2.0 ms; no major collection in the traced windows.
- **Not a shot change or a cue.** The worst twelve intervals of the first run (70 to 91 ms) are spread over the tunnel, the fields and the temple and carry no created object; nine of them sit in the minute the main thread ran slow.
- **Not the GPU's clock.** The probe read 1.44 to 1.77 ms through every measured window: the app keeps the GPU at full clock. (On an idle GPU the same probe reads 5.0 to 5.7 ms, which is B260 seen from the browser. A piece made light enough to leave the GPU idle between frames will meet that.)

## 5. The ranked list

By what a frame gets back, with the measurement it stands on. **M** is the page's main thread, **G** the GPU, **P** the browser's GPU process. A gain on one of the three is a gain in frame rate only while that one is the limit (A2): the canvas first, because it is two of them at once.

| # | What | Attacks (measured) | Gain expected, and how I know | Risk, or what changes in the picture | Size | Whose | Row |
|---|---|---|---|---|---|---|---|
| 1 | **A change inside a node repaints that node, not the canvas** | M: Layerize 3.8 to 9.3 ms a frame in 20 to 30 ms pieces ten times a second. P: raster 5 to 13 ms a frame | Measured with the canvas hidden, four runs: 31 to 42 frames a second become 38 to 59 in seven windows of eight; frames over 33.3 ms from 13 to 47 % to 2 % or less. Zoomed in the cost is already a tenth | none in the picture | medium | engine | **T1653b**, open, in work. This document adds the period (116 ms: the 10 Hz samplers) and the GPU-process half |
| 1a | the same today, with no code: **play with the canvas zoomed in on a few nodes, not fitted** | the same | measured (A2, six windows): 35 to 48 frames a second against 31 to 39 in the fields, 41 and 43 against 34 to 39 in the tunnel; 2 to 15 frames of a window over 33.3 ms against 85 to 144 (45 in the window where the thread ran slowest) | none | none | the person playing | |
| 2 | **A Viewer that covers the editor stops the editor's updates** | the same, behind a fullscreen Viewer: Layerize 4.5 to 9.4 ms, raster 6 to 14 ms | up to row 1's figure for anyone performing fullscreen, whatever row 1 does for the canvas | none | small | engine | new (N1) |
| 3 | **Expressions: a read and a repeated subexpression are worth one evaluation a frame** | M: 4.2 ms of a 15.3 ms frame loop as profiled (2.7 at the fastest thread) | 2.3 to 3.6 ms: 91 % of the tree nodes are repeats (D2), and the read chain alone is 1.7 ms for 88 distinct targets read 3,540 times. Estimated from the profile and the census | a memo must be per frame and per scope (the time probe evaluates at another time); a wrong key is a stale value | medium | engine | new (N2). T1172 did this for `.par` |
| 3b | the same in the document, until 3 lands: shared subexpressions as Constant nodes, read once | the same; `kernel_search` and `kernel_searchlights` are 36 % of the tree nodes | 1 to 2 ms, estimated the same way | none | small | project | T1561b |
| 4 | **Lighter rings for the tentacles** | G: 4.0 to 4.7 ms with three robots out, 1.3 with one; vertex-bound (C2) | a quarter of the triangles: 3.5 ms and 1.0 ms; half: 2.3 and 0.65 (B3's 0.45 ms a million, and the probe's 73 % and 32 %) | a ring's silhouette in the close shots (eyes, strike) unless it is a level of detail by distance | small in the kit (`tools/blender/sentinel-bot`); medium as a level of detail | project now; engine for levels of detail | T1561b; **T1592b F2**, unscheduled |
| 5 | **Depth and Normal written by the lit draw, not by two more draws of the scene** | G: 2.4 to 3 ms of 12.8 with three robots out (B2); about 1.5 of 8.5 with one (the chain's 3.6 less about 2 for its passes, which were not taken out one by one in that scene) | most of it: the two layers are two of the three passes over every layered triangle. Estimated from B1 and B2, not prototyped | a multisampled Render needs its own answer (the offline tier is one); none in the live tier | large | engine | **T1592b F4**, unscheduled; T1371b |
| 6 | **Nothing to do this frame** | M: 2.8 ms of 9.8 headless (compile 1.6, push 0.5, encode 0.6). G: 0.5 to 1.2 ms. P: 46 of the plan's 71 dispatches, each a submit | the measured figures, less whatever deciding costs | a stateful node behind an empty pointset (the row says) | medium | engine | **T1642b**, open. It measured the GPU half (0.8 to 1.0 ms); the main-thread half is three times that |
| 7 | **An index buffer for meshes and grids** | G: the triangle-bound part: rings 4.7 ms, tunnel about 1.3 | 25 to 31 % of it in the probe (C3): 1.2 to 1.5 ms with three out. Not measured in the engine; the grids (six runs a vertex) may gain more | none | medium | engine | **T1592b F3**, unscheduled |
| 8 | **The frame's dispatches in the frame's command buffer** | 78 of the app's 80 submits a frame are one dispatch each. P: 3.6 to 6.3 ms a frame decoding about 84 flushes. M: native `submit` and flush about 1.2 ms | not known: the decode's share that is per flush was not separated. At most 3 ms of P and 1 of M | vgpu's compute has no frame-level pass API (the backend's own comment); order must hold | medium, in the vgpu patch | engine | new (N3) |
| 9 | **The body light's shadow, where it is seen** | G: 1.0 ms with one robot out, 2.9 to 3.2 with three: six cube faces of every ring and claw | all of it in a place with nothing in reach to receive it; the owner's eye decides which those are | the shadow, where it was visible | small if a shadow can be switched by a value; today Cast Shadows is structure | project, on an engine wish | T1606b (reach for instances); new if "a light's sweeps skip by a value" is wanted |
| 10 | **The values-only compile re-emits 143 nodes whose shader, bindings and pass list cannot change** | M: 2.2 ms re-emitting, 0.75 walking keys, 0.9 probing and comparing, as profiled | not known without a design: half, if a node whose resolved values did not move is not re-emitted | the verifier is what makes the lane safe | large | engine | T1333b is the nearest open row; new (N4) if split |
| 11 | **Screen-space passes at half size** | G: 1.7 ms at 1280 × 720 measured, more at 1920 | measured | softer occlusion, reflections, air and focus | small | project | T1561b |
| 12 | **Play at 1280 × 720, scaled by the Viewer** | G: 1920 × 1080 is 3.4 to 6.2 ms more a frame (fields, tunnel); 58 % of frames over 33.3 ms against 38 to 45 % | measured (A1, B3) | a softer picture on a large screen | none | project | |
| 13 | Uniform push: skip a value that did not move before vgpu validates and clones it | M: 1.3 ms | under 1 ms, estimated | none | small | engine | none; not worth a row before 3 and 10 |

**Do not optimise these.**

- **The lights.** After T1623b's slices 1 to 3 every non-casting light of this document together is about 1.3 ms. Slices 4 and 5 (casting lights as rows, layered shadow targets) change text and bindings, not the sweeps: the shadow's milliseconds are triangles (row 9), which T1623b does not remove and T1606b might.
- **The hull.** 0.7 ms for three.
- **Bloom, lens, glitch, grade.** 0.5 ms together.
- **Dust, flames, formations, cones, the rope.** Under 0.4 ms each.
- **Garbage collection, the value graph's topology (T1179: 1.3 ms of evaluate here), the previews' tick (1.15 ms).** Real and small; behind everything above.

**The order I would take them in.** 1 and 2 (they free two of the three limits, and they are every document's). Then 3 and 6 for the main thread, which is the limit the moment the canvas is out of the way. Then 4 for this piece and 5 for every Render. 7 and 8 need a probe each before they are promised.

**Row text for the new ones.**

- **N1. A VIEWER THAT COVERS THE EDITOR STILL PAYS FOR THE EDITOR (found by §T1666b, measured).** fullscreen on sentinel-bot, 220 nodes fitted on the canvas behind it: Layerize 4.5 to 9.4 ms a main frame and 6 to 14 ms of raster on the GPU process's main thread, the same as with the editor in front (`docs/sentinel-perf-analysis-2026-10-06.md` A2); 29 to 38 of every 94 to 169 frame tasks carry more than 10 ms of Layerize. wanted: while the Viewer is fullscreen (and for any pane that is wholly covered) the canvas's 10 Hz DOM writes stop or the canvas is out of the render tree, and they come back with the editor. gate: a count of DOM writes or of Layerize time under a fullscreen Viewer through the composed app. relates to §T1653b (which makes the write cheap; this makes it not happen) and §T110.
- **N2. AN EXPRESSION'S READS AND REPEATED SUBEXPRESSIONS ARE EVALUATED ONCE A FRAME (found by §T1666b; §T1172 did it for `.par`).** sentinel-bot evaluates 362 expressions a frame: 29,535 tree nodes and 3,540 `.chan` reads of 88 distinct targets, 4.2 ms of a 15.3 ms frame loop in the app; 91 % of the tree nodes are a subexpression already evaluated that frame (2,290 distinct subtrees of 26,218 nodes), and in the app each `.chan` read walks the chain of external resolvers (MIDI, OSC, analyze, depth, vision) before the value graph answers, 1.7 ms. wanted: (1) a channel read memoised per frame by name, in front of the resolver chain; (2) identical subtrees shared at parse time and their value remembered per frame and per scope (the time probe evaluates at another time). expected 2.3 to 3.6 ms a frame on this document. gate: the count of tree nodes evaluated on a frame of the consumer's document, and equality with an evaluation that remembers nothing.
- **N3. A FRAME'S DISPATCHES GO OUT IN THE FRAME'S COMMAND BUFFER (found by §T1666b; needs a probe first).** 78 of the 80 submits a frame of sentinel-bot makes in the app are one dispatch each (`encodeDispatch`: vgpu's compute builds its own command buffer and submits at once). in the browser each is a flush to the GPU process: about 84 flushes a frame, 3.6 to 6.3 ms of that process's main thread decoding WebGPU, and about 1.2 ms of the page's. wanted first: the share of that decode that is per flush and not per command, on a fixture (dispatches in one encoder against one each, the reference beside it). then, if it is worth it: compute passes encoded into the open frame, order kept.
- **N4 (only if §T1333b is not the place). THE VALUES LANE RE-EMITS A NODE WHOSE RESOLVED VALUES DID NOT MOVE.** 143 nodes are re-resolved and their definitions' `compile` re-run every frame on sentinel-bot (2.2 ms in the app, plus 0.75 ms walking generated-text keys and 0.9 ms probing and comparing); the nodes of the three places that are not on screen resolve to the same values frame after frame. wanted: a node whose resolved parameters and scene inputs equal the last frame's keeps its passes without running `compile`. overlaps §T1642b.

## 6. What I could not measure, and what it would take

- **A quiet machine.** I never had one. Every figure has its reference beside it and the browser tables give the spin and the probe of each window; the absolute frame rates are those of this afternoon. A run with no other session alive would say whether the editor's 31 to 42 frames a second is the app's own ceiling or already somebody else's.
- **A browser in front of a person.** The measured browser is headless: no window, a 1920 × 1200 viewport, the pane sizes the file opens with, device pixel ratio 1 in all but one run. The owner's has its own size and layout and a foreground application's thread priority. The page's main thread ran a fixed loop in 0.98 to 2.66 ms; I cannot say how much of that spread a foreground browser would see, nor how much of it was other sessions and how much the scheduling of a headless browser's threads. Needed: the harness's counters and spin injected into the owner's own tab for one song (they are a page script).
- **Exclusive GPU time per pass**, in either harness: spans overlap on this GPU. Ablation answers "what does removing it save", and those savings do not sum (section 2).
- **The GPU cost of the browser's own raster and compositing.** I have its CPU side on the GPU process's main thread (5 to 13 ms a frame of raster) and the machine's utilisation, not its share of the GPU.
- **What the app's GPU extent holds that the headless frame does not** (1.3 to 1.45 times, A4).
- **Rows 7 and 8** are estimated from a probe and from counts. Each needs its own fixture with a reference before a number is promised.
- **Row 5** is arithmetic on B1 and B2, not a prototype.
- **The owner's track, properly.** One run plays `metallic-pursuit.m4a` (A1); its tempo is my arithmetic from a comment (441 beats in 198 s) and its beat offset a guess of 0, so its bars may not be the owner's bars. The other long runs play the shipped beat (124 bpm). Both shows visit the four places and call the pack.
- **The values-lane refusals in the app.** `get_runtime_metrics` does not carry `frameCompileReason`; I read the lane from the profile instead.

## 7. Found on the way

- **Three helper processes sat at 30 to 45 % of a core each for the whole session**: `src/mcp/serve.ts` as the owner's `pnpm helper --terminal --grant-export --phone` (19 hours old) and as two sessions' MCP servers (8 hours old; one of them reports itself not connected to any tab). A two-second sample of the first shows V8 building function templates under N-API callbacks, with Dawn's node binding loaded. Not investigated. It is a core of this machine gone before anything is opened.
- **`GpuFrameTiming`'s docblock** (`backend-types.ts`) says compute dispatches carry no span; since T1247 they do (`encodeDispatch`). A stale comment, not changed.
- **The show never leaves the tunnel with the loop on.** The default range is 600 frames; the track's bar count restarts every ten seconds. The owner plays it with the loop off; a person opening the file does not know to.
- **The committed project and the kit in the main checkout have parted**: a rebuild with today's kit moves the face light 3.7 cm (`0.640` to `0.677` in 30 expressions). The other session's work in progress, noted so nobody reads it as a measurement artefact.

## 8. The scripts

Scratch, not in the repository: the worker's `scratchpad/t1666/`, copied with the runs' result files to the session's scratchpad (`t1666/`) when this was written.

| File | What it is |
|---|---|
| `frame.ts` | the headless frame as the app runs it: variants by name (`scene.swim+nogeo.geometry_ring+w.320`), the reference pass, the CPU spin, per-part CPU, device-call counts, a mock-device mode, a V8 profile or call counts of the timed frames |
| `batch.sh`, `batches-2.sh`, `h-table.mjs` | the ablation batches and their tables |
| `mesh-bench.ts` | the ring probe of C3 |
| `plan-facts.ts`, `expr-census.ts` | the plan's draws and dispatches; the expressions counted |
| `app-lib.mjs` | the page's counters, the GPU probe and CPU spin, the tool capture |
| `app-measure.mjs`, `app-layouts.mjs` | the long runs of A1 and A4; the alternated layouts of A2 |
| `app-dist.mjs`, `app-series.mjs`, `app-slow.mjs` | distributions, time series and slow-frame groups from a run |
| `trace-lib.mjs`, `trace.mjs`, `trace-slow.mjs`, `prof.mjs` | the trace by thread and event; the profile through the source map |
| `gpu-util.sh` | the machine's GPU utilisation |
