# Realtime performance investigation — 2026-10-02

## Ownership and method

The user authorized a deep investigation and fixes, starting with rendering and the upstream GPU dependency. Investigation-first and Caveman skills guide the work. Record measured costs separately from inferred costs. Preserve resolution, precision, timing, resource ownership, and explicit errors.

Initial worktree: only untracked `.mcp.json`. It remains untouched. This session made no Git history operations.

Concurrent ownership:

- Root: upstream audit, dependency/patch migration, backend API adaptations, consolidated validation and this report.
- Rendering agent: rendering-core binding work and regression tests in `vgpu-backend.ts`.
- Media/audio agent: FFT workspace and inference image preparation.
- UI agent: realtime preview hooks and their tests.

Agents coordinate file claims before edits. Existing September performance reports are historical evidence, not current production measurements.

Another session committed T1524b preset work at 03:48:08 local time while the broad suite, started at 03:45, was running. Old channel/morph modules cached by Vite combined with new tests, producing eleven fade assertions across three files. The old resolver ignored the new morph argument and returned the destination, exactly matching those failures. A fresh isolated channel run passed all fifteen tests. Keep mixed-revision discovery results distinct from fresh-process validation; no preset or clock fallback was added.

## Upstream audit

Loom uses the published `vgpu` package with a pnpm patch, rather than a fork dependency. Installed baseline: `0.4.1`. Registry `latest`: `0.5.0`, published September 14, 2026. The upstream default branch is `canary`; its October 2 head is `341101abcf3c781721766bee6d03fc82c9d91f54`. Unreleased canary changes are outside this stable upgrade.

Sources: [stable release](https://github.com/vercel-labs/vgpu/releases/tag/v0.5.0), [migration guide](https://github.com/vercel-labs/vgpu/blob/v0.5.0/docs/migrations/0.5.0.docs.md), [npm registry](https://registry.npmjs.org/vgpu).

Breaking contracts: explicit texture `kind`, immutable allocations, attachment-specific reads with explicit mip/region, intrinsic WGSL host layouts, and strict binding-value validation. Node/Linux now defaults to Vulkan. Mac/browser backend selection is unchanged. Optional native tooling is not required.

Patch audit: 17 of 18 patched files apply directly to `0.5.0`. Compute needs a semantic port. Its bind-cache owner is now `compute:${id}`; eviction must use that exact key. Preserve upstream binding validation before reserving timing queries. Otherwise a destroyed binding could reserve a query that never gets written. All existing patch capabilities remain required: MSAA preservation, raw buffer-region binding, bind-group eviction, frame extent, compute/draw timing, dropped timing reports, and compatible presentation views.

Implemented: ported the patch, pinned `0.5.0`, updated API consumers and ran real GPU regression suites. Rollback is the recorded `0.4.1` pin, original patch and lockfile; no saved-project schema changes. Published tarballs and audit metadata are isolated in `/private/tmp/loom-vgpu-audit`.

## Realtime path and proven costs

The frame driver evaluates values and supplies transport time. The compiler reuses structural plans for value-only changes. The backend writes uniforms, binds current resource halves, encodes render/compute passes, submits GPU work, and presents. Node tiles and graph backgrounds run separate preview schedulers. Audio worklet hops feed analysis; camera decode events advance source identities. Inference prepares GPU input, reads it back, runs the model, encodes the result, and transfers it to the main thread.

| Surface | Repeated work removed | Deterministic proof |
| --- | --- | --- |
| Rendering resource swaps | Every substep scanned unrelated dynamic bindings and allocated filtered lists | Twelve independent simulations, eight substeps: texture descriptor reads per frame 2,352 to 48; buffer regions also covered |
| Rendering schedule | Expanded loops and split direct-submit segments every frame | One expansion/segment walk across repeated frames; live counts 3→5→2 invalidate correctly, including same-signature recompilation and device recovery |
| Node previews | Rebuilt two output maps and enumerated unchanged graph nodes each tick | Sixty cooked frames retain sixty presentations, with one output-index build; replacement plans rebuild and bind new resources |
| Empty graph background | Layout measurement and transparent GPU clear every display frame | Sixty empty frames: zero layout reads/updates; final mark removal clears once, then stays quiet |
| Preview demand | Shared activity could retain retired background demand or expire another quiet producer | Explicit producer ownership; grace and settle tests preserve quiet consumers and isolate retirement |
| UI telemetry visibility | One store subscription, MutationObserver and visibility check per listener | Ninety-four listeners share one subscription/observer/check; hidden transitions, duplicates, floating documents and final cleanup remain covered |
| Component library | Refreshed catalogue/upgrades and published fresh state on parameter-only graph revisions | Sixty separately flushed parameter commands: 122 queries to two; placement, removal, upgrades, catalogue versions and same-version reauthoring still refresh |
| Audio FFT | Two fftSize Float64 scratch arrays allocated each hop | At fftSize 2,048: 32,768 B/hop removed; 48 kHz with hop 512 removes 3,072,000 B/s/source |
| Spectral centroid | Recomputed the same byte-to-magnitude power for each occupied bin | A 256-entry Float64 lookup retains exactly the same values; all-byte parity regression |
| MediaPipe input | Allocated ImageData plus temporary RGBA storage and copied between them | At side 256: 524,288 B/inference removed, plus a 262,144-byte copy; reused pixels refresh exactly |
| Inference result | Copied an already-owned exact encoder buffer before transfer | At 1080p float output: 8,294,400 B/result removed; actual transfer tests preserve model, recurrent, and smoothing state |

Encoding ownership is explicit. Invalid encoder views throw before smoothing can mutate model output or retained history. Allocations needed for independently transferred audio results remain independently owned.

## Isolated benchmarks

Media/audio benchmark: Node 24.11.1, macOS arm64, warmup followed by eight alternating same-process rounds. No broad validation overlapped this measurement. Medians:

- FFT: 0.06120 to 0.05851 ms/hop, 4.4% lower. Allocation reduction is stronger evidence than elapsed time.
- Complete audio feature calculation: 0.01556 to 0.009534 ms/frame, 38.7% lower. This is one function, not total audio or application CPU.
- MediaPipe input preparation with a stub segmenter: 0.42544 to 0.40590 ms/inference, 4.6% lower. Excludes model execution, rasterization and upload. ImageData allocations over the run: 4,100 to one.
- Isolated worker result copy at 1080p: 0.23518 ms to a buffer-reference operation. This measures the removed copy, not inference throughput.

Rendering benchmark: mock GPU, twelve loops with eight substeps, 100 warmup frames and nine rounds of 400 measured frames. Median whole simulated render: 0.56471 to 0.49243 ms, 12.8% lower. Arms ran sequentially during parallel development. Treat timing as corroboration; the operation-count regression is the reliable proof. No browser/GPU/FPS speedup or dependency-upgrade attribution follows from it.

Reproduce and inspect raw rounds:

```bash
node --import ./src/tooling/alias-hooks.ts scratchpad/perf-realtime-2026-10-02/media-audio-benchmark.mjs
node --import ./src/tooling/alias-hooks.ts scratchpad/perf-realtime-2026-10-02/render-rebind-bench.mjs
```

Raw results: `media-audio-results.json` and `render-rebind-results.json` in the same scratch directory. Scratch artifacts are local and Git-ignored; this report retains conclusions and limitations.

## Migration failures found and fixed

Strict `0.5.0` validation exposed real contract mismatches:

- Dispatch frame updates broadcast optional keys into smaller kernel structs. The backend now selects fields declared by each pass's initial uniform contract. Authored unknown keys still throw.
- LaserParams declares `absTimeSeconds` and `deltaSeconds`, but initial laser values omitted both. Initialize both at the source. The catalogue uniform gate now rejects missing initial fields for every node.
- Point-splat previews received an `eye` value declared only by shaded previews. Orbit publication now supplies each declared field; point splats retain matrix updates, shaded previews retain eye updates.
- Backend retained rejected uniform values before upstream validation completed. Commit retained values only after acceptance. A red/green regression proves later renders recover after rejection.
- Point kernels accepted fractional and out-of-range seed parameters, then passed them straight into a u32 uniform. Basic, advanced and spawn-hook emitters now apply unsigned conversion before publication, preserving the previous typed-array truncation/wrap semantics. The original bus-fuzz GPU failure passes without changing its input.

Texture uploads now declare `kind: "2d"`; output reads select `.color` with explicit mip zero and full region. Source descriptors, project files, output precision and resolution are preserved.

## Audited paths and next measurements

Camera source IDs already advance on decoded frames (`src/app/media-sources.ts:197`); `currentFrame` preserves the same ID until another decoded frame arrives. No duplicate camera-ID patch was needed.

Inference already rejects in-flight, held and rate-limited work before readback (`src/runtime/execution/inference-sources.ts:465`, `:580`, `:608`). That CPU guard does not gate the preprocessing GPU dispatch emitted by wired depth, matte and pose nodes (`depth.ts:623`, `matte.ts:741`, `pose.ts:156`). GPU preprocessing during a skipped inference is a credible next measurement, not an established millisecond saving. Skipping it needs freshness, offline execution and ownership proof.

## Validation tooling cost

Root lint traversed existing peer checkouts inside `.claude/worktrees`, including their dependency trees: 565,924 candidate JS/TS paths. The observed run exceeded sixteen minutes and reached approximately 4.5 GB of memory. Generated Python `.venv` dependencies also contributed vendored JavaScript errors. Root lint now excludes these separate checkouts and generated environments; their files remain untouched. A regression checks both exclusions while ensuring root application source remains linted. Source lint completes with zero errors and five warnings in untouched files.

## Application profile before the final library fix

Headed Chromium on the Apple/Metal-3 adapter, 1,920×1,200 viewport, current dev working tree, owned server on port 5211. All three selected fixtures completed: E24 (53 nodes), E55 (42 nodes), and a synthetic 200-node/199-edge chain. Two passes per scenario, 26 windows total; the chain intentionally runs playback and pan/zoom only. No validation or benchmark process overlapped. The peer commit at start/end was `dff46a47`; these performance edits were uncommitted. The component-library guard was added after this run. This is a current-cost profile, not a controlled before/after experiment.

Ranges below span the two passes. Busy time is main-thread occupancy per display-frame window; display intervals are separate from the application transport frame rate. Milliseconds throughout.

| Fixture | Scenario | Frames, both passes | Busy p50 | Busy p95 | Interval p50 |
| --- | --- | ---: | ---: | ---: | ---: |
| E24 | Playing, examples | 1199 | 2.44–3.04 | 8.23–9.18 | 8.31 |
| E24 | Playing, performance | 1199 | 3.00–3.43 | 8.10–8.84 | 8.31–8.34 |
| E24 | Paused | 1203 | 0.10–0.13 | 1.43–1.63 | 8.39–8.42 |
| E24 | Parameter drag | 934 | 6.64–6.93 | 25.82–27.12 | 7.88–8.23 |
| E24 | Pan/zoom | 1092 | 5.25–5.72 | 12.21–12.67 | 8.38–8.47 |
| E55 | Playing, examples | 445 | 5.57–6.03 | 18.43–22.93 | 22.14–23.09 |
| E55 | Playing, performance | 396 | 6.74–11.16 | 21.82–23.77 | 22.98–29.14 |
| E55 | Paused | 1202 | 0.11–0.12 | 1.32–1.52 | 8.41–8.43 |
| E55 | Parameter drag | 585 | 8.91–27.54 | 29.47–39.88 | 10.63–29.49 |
| E55 | Pan/zoom | 686 | 10.18–10.50 | 20.40–30.76 | 17.43–21.43 |
| chain-200 | Playing, examples | 1196 | 1.93 | 10.44–10.98 | 8.31–8.32 |
| chain-200 | Playing, performance | 1197 | 2.19–2.55 | 9.90–11.97 | 8.32–8.33 |
| chain-200 | Pan/zoom | 877 | 7.71–8.16 | 21.74–22.23 | 9.16–9.36 |

Costs still visible:

- E24 playing on the examples tab: React 0.79–0.90 ms/frame of sampled script time, backend 0.69–0.75, previews 0.14–0.19, compilation approximately 0.05. Paused backend and preview script cost falls below 0.003 ms/frame.
- E24 parameter dragging: React 3.91–4.17 ms/frame, backend 1.01–1.07, compilation 0.26–0.30. The largest React render group contains twelve pane contents and 299 performed fibers; 113/116 such commits account for 1,193/1,103 ms of reported React render duration. This identifies broad page rendering on parameter revisions as a stronger next target than compiler rewriting.
- E55 playing: approximately 22–29 ms median display intervals, with 36–46 application fps reported at sampled window ends. Main-thread sampled React cost is 2.98–3.76 ms/frame on the performance tab; native/unattributed program time is larger than backend script time. GPU top-bar snapshots in playing windows are roughly 18–26 ms. These support a GPU/backpressure investigation, but this main-thread trace does not separate GPU execution from driver waiting or establish a shader optimization.
- The 200-node chain retains approximately 8.3 ms median playing display intervals. Pan/zoom raises layout to approximately 1.3–1.4 ms/frame and React sampled script to approximately 1.7–1.8 ms/frame. This is a measured graph-interaction cost.

Measurement limits: V8 samples and timeline durations overlap and must not be added as disjoint costs. Native `program` samples remain unassigned. GPU pass spans may overlap; their sum is not exclusive GPU frame time. Idle tracing disables fiber walking and uses a separate untraced walk probe; gesture windows enable it. The injected walker can inherit React attribution, so `harness: 0` does not prove zero instrument cost. React actualDuration describes render work, while total gesture script time also contains instrumentation. The summary reports complete walks for gestures, never a false zero; no foreign-input warnings appeared. No production-build, webcam-throughput, or whole-app speedup claim follows from this run.

The first attempt stopped after one arm because the performance panel and transport both expose a Pause button. The harness now scopes Play/Pause to the Transport group. The complete replacement run passes three fixtures; the fourth, user-local file, is intentionally excluded. Failed partial measurements were discarded.

Reproduce:

```bash
PERF_FIXTURES=E24,E55,chain-200 PERF_SCENARIOS=A,B,C,E \
PERF_OUT_DIR="$PWD/scratchpad/perf-realtime-2026-10-02/profile-final" \
pnpm exec playwright test -c src/tests/e2e/perf/playwright.config.ts
node --import ./src/tooling/alias-hooks.ts src/tests/e2e/perf/summarize.ts \
  scratchpad/perf-realtime-2026-10-02/profile-final
```

Raw fixture JSON, completeness manifest, exit status and the full generated `summary.md` remain in that directory. Raw CDP traces were pruned by the existing harness after parsing.

The profile also found ComponentLibrary rendered 236 times per parameter-drag pass: every graph revision triggered catalogue/upgrades queries, and fresh answers caused another library render. This query work was fixed with the existing store selector, keyed to sorted component instance ids/types. Those are exactly what upgrades and derived instance names read; catalogue events remain independently subscribed. The previous subscription produces 122 queries over sixty separately flushed parameter commands; the new one produces two. Nine focused tests also cover real instance and definition invalidations. The much larger whole-page parameter-edit render group remains; the library fix does not claim to remove it.

## Fresh browser verification after the library fix

A fresh headed E24 run passes all eight selected windows (A/B/C, two passes), with validation stopped. Artefacts: `scratchpad/perf-realtime-2026-10-02/profile-library/`, including fixture JSON, completeness manifest, successful exit status and generated summary. The same transport selectors now work on both dock tabs. Parameter-drag fiber walks report two ComponentLibrary renders in pass one and none in pass two, versus 236 in each earlier pass; the query-count regression above remains the deterministic proof. Overall drag busy p50 is 6.20–6.89 ms and p95 24.91–27.65 ms. Those ranges confirm the broader page-rendering cost remains; sequential dev profiles do not establish an application speedup percentage.

Reproduce with the same profiling command above, setting `PERF_FIXTURES=E24`, `PERF_SCENARIOS=A,B,C`, and a distinct output directory.

## Validation

- `pnpm lint`: passes, zero errors and five warnings in untouched files.
- `pnpm typecheck`: passes, including the final library source/tests and peer changes.
- `pnpm build`: passes after the final library fix and peer changes; retains the existing large-chunk advisory.
- `pnpm test:gates`: 51 files, 3,273 tests pass after the final library fix and peer changes. Loopback access is required by the device-helper gate; the sandbox-only discovery run timed out there.
- `pnpm run test --maxWorkers=4 --minWorkers=1`: 865 files; 12,128 passed, eleven failed, three skipped and one todo. All eleven failures are the three mixed-revision preset suites described above. A fresh process then passes all 41 tests in those files, including the two affected GPU cases. This is broad coverage plus a focused fresh rerun, not an entirely green full-suite run on one immutable revision.
- `pnpm test:headless`: initial 683-file discovery run exposed the migration errors fixed above. The later full run includes all headless suites: cook oracle's 76 tests, reactor claims, inference feeds, pixel parity, device recovery, cache eviction and 36,000-frame resource stability all pass.
- `pnpm run test:e2e … --workers=1 --reporter=list --trace=on`: nine selected tests pass: component dive previews (including pointsets), preview aspect, canvas capture, real GPU presentation pixels and still-image pixels. Traces are retained in `test-results`.
- Final library regression: nine tests pass; the previous subscription was verified to fail with 122 queries.
- Additional browser media/audio validation: three tests pass, including real MediaPipe segmentation, GPU mask handling and AudioWorklet/AnalyserNode byte parity (41,984 frequency and 83,968 time-domain comparisons, zero mismatches).
- `git diff --check`: passes. No production deployment, Git commit or checkout.

Validation logs and benchmark data are under `scratchpad/perf-realtime-2026-10-02/`. The complete isolated current-app profile is recorded above.

## Follow-up: patch probes and remaining avoidable work

The user narrowed the patch audit to a few representative probes. Three paired
pristine-versus-patched 0.5.0 probes confirm buffer-region bindings, preserved MSAA
passes, and compatible target views still need the retained behavior. No unexpected
difference warrants an exhaustive capability matrix. These mock probes establish API
behavior and allocation descriptors, not hardware performance. The [patch notes](./vgpu-patch-notes.md)
state their exact limits and the remaining unmeasured MSAA/timing costs. Raw results
and a standalone reproducer are in `scratchpad/perf-realtime-2026-10-02/vgpu-patch-audit/`.

### Inference preprocessing demand

Depth, Matte and Pose preprocess their input in a GPU dispatch. Previously that dispatch
ran on every rendered frame; the CPU then decided whether an in-flight model, Hold, or
the live rate limit prohibited reading it. The actual backend and inference seam, with
the mock adapter over 60 frames at 60 Hz, give these operation counts:

| Condition | Previous dispatches | Current dispatches | Readbacks / model runs, unchanged |
| --- | ---: | ---: | ---: |
| First model run remains in flight | 60 | 1 | 1 / 1 |
| Hold after first result | 60 | 1 | 1 / 1 |
| Live cap at 2 Hz | 60 | 2 | 2 / 2 |

The backend now evaluates registered dispatch demand before starting CPU/GPU timing
spans. The inference source reserves the exact frame while encoding, and only that
reservation can authorize its later readback. Rechecking eligibility after encoding
would be incorrect: a model can finish between a skipped dispatch and the queued
observer. The paired completion-race probe records two reads, one stale, previously;
the prepared-frame path records one read and no stale read.

Unregistered compute passes keep their existing execution. Both open-frame and direct
segmented encoding keep their existing ordering and live latency. Registration disposal
is owner-safe. Retirement/reset/recompilation invalidate reservations; retiring a node
during its first pending run now also disowns that run, preventing stale results from
publishing into a recreated node. Missing resources for a demanded dispatch throw.

Browser export uses the live transport, whose frames still say `realtime`. Export
therefore acquires explicit inference ownership before replay, drains older work, and
settles each prepared frame. Its ownership suppresses automatic sampling and bypasses
live cadence while preserving Hold. Returned cleanup releases ownership after success,
failure, cancellation, or an early encoder refusal. Unready models remain explicitly
unready; this change neither downloads weights nor fabricates a ready result.

Camera duplicate-frame suppression is deferred. Static media copies can potentially
carry a content identity, but arbitrary upstream effects can animate between camera
frames; a source-only dirty flag would skip valid input changes. No quality, resolution,
precision, model or shader sample count was reduced.

Operation and race reproducers, before/after JSON and source snapshots are under
`scratchpad/perf-realtime-2026-10-02/`. Counts are not GPU milliseconds or model throughput.

### Closed UI work

PipelinePanel built its full inspection model before Radix decided whether the dialog
was mounted. The model now lives inside the dialog content. Initial mount and 60 closed
revisions previously built 61 models; now they build zero. Opening, visible edits,
closing and reopening are tested against current graph labels.

The layout menu now retains its element on the exact layout props it reads. Sixty
document revisions previously rendered its trigger 60 extra times; now they add no
trigger renders. Opening and restoring layout remain covered. Both regression tests
were checked against the previous source and failed as expected.

A fresh baseline matters because peers already changed shell memoization after the
earlier profile. At peer HEAD `26454eb4`, E24 parameter drag still produced a repeated
273-fiber group and busy p50 8.31–8.43 ms, p95 25.54–28.63 ms. This confirms remaining
whole-page work but does not attribute its entire cost to these two fixes. The paired
profile uses identical A/B/C scenarios and separate owned-server runs; raw data are in
`scratchpad/perf-realtime-followup-2026-10-02/ui-{before,after}/`.

Both runs complete all eight windows. After the UI fixes, the repeated group has 257
fibers, down from 273, but broad parameter-edit work remains. Its render totals are
1,119 / 998 ms across 114 / 117 commits, compared with 1,195 / 1,142 ms across 116 / 118
baseline commits. Busy p50 is 8.61–8.90 ms and p95 25.81–29.06 ms after, overlapping or
slightly worse than baseline. This does not demonstrate an end-to-end speedup. The
deterministic build/render count reductions above are the supported improvement.
The display interval remains about 10 ms in both runs. Dev React instrumentation and
gesture fiber walks remain enabled consistently; neither run measures production FPS.

The next measured target is the remaining group: it accounts for about 75–81% of
reported React render duration. Graph, inspector and viewer wrappers each render 118
times per drag pass. Existing node/field boundaries already reduce propagation: two
parameter controls render per edit, and `NodeView2` records 118 renders across the drag pass, below an all-nodes-per-edit
total. The `2` is part of the component name, not a thousands separator. Per-pane profiler boundaries and
function samples are needed before assigning the remaining 8.5–9.8 ms average commit
cost to a specific pane. Six closed dialog chains also render 708 times, and the empty
Controls pane still scans the graph per revision. Telemetry structure churn is smaller:
the main cost-cell group consumes 108–142 ms per drag pass. These are ranked follow-up
observations, not additional fixes or evidence of an all-node render storm.

Browser validation exposed a separate harness error: the headless Playwright lane
reused port 5173, which belonged to another repository, so all six layout tests opened
the wrong application. The lane now starts its own server on port 5189 with strict
port binding and no reuse, matching the headed lane's existing ownership policy. The
fresh rerun passes all six layout interactions without changing product behavior.

### Follow-up validation

- `pnpm run test --maxWorkers=4 --minWorkers=1`: **877 files pass; 12,341 tests pass,
  three skipped and one todo**. The complete fresh run includes the new inference,
  ownership, export, UI, GPU demand, pixel-parity and prior migration regressions.
  Peer HEAD remains `26454eb4` throughout; no mixed-revision preset failures recur.
- `pnpm test:gates`: 51 files, 3,299 tests pass.
- `pnpm lint`: zero errors, five existing warnings. `pnpm typecheck` and `pnpm build`
  pass. The existing large production-chunk advisory remains.
- `pnpm test:headless` scoped to dispatch demand, frame throws and timer retraction:
  all eight GPU tests pass across the final focused runs. The new open-frame test
  initially stalled because it mocked Dawn's readback-poll timers; it now mocks only
  the scheduler interval. Both paths verify exact buffer contents.
- `pnpm test:e2e src/tests/e2e/layout.spec.ts --project=chromium --workers=1 --reporter=list --retries=0`:
  all six browser tests pass on the owned server.
- Prepared inference sources and hook: 61 focused tests pass. Export ownership: 19
  tests pass, including release after early encoder refusal. UI regression suite:
  84 tests pass; both new regressions fail against the previous source.
- Both isolated E24 A/B/C profiles complete all eight windows. Neither overlaps
  validation. No overall drag-latency improvement is established.
- `git diff --check` passes. No commit, checkout, history change or deployment.

Follow-up logs and browser profiles: `scratchpad/perf-realtime-followup-2026-10-02/`.
Operation/race reproducers: `scratchpad/perf-realtime-2026-10-02/`.


## Remaining-hotspot pass: closed Help, Controls and telemetry

A narrow opt-in probe (`PERF_COMPONENT_TIMINGS=1`) records the installed React fiber's
inclusive `actualDuration` for selected components. Default profiling stays unchanged;
missing durations throw when this probe is enabled. Its unit tests reject stale timings
from reused, bailed-out subtrees. Nested component durations overlap and must not be
added. No profiling hooks were added to product components.

Two E24 parameter-drag windows each contain 118 App renders. Closed HelpPanel consumes
643 / 752 ms total, or 5.45 / 6.38 ms per render, before the fix. Its containing HelpHost
accounts for 37–38% of App render time, more than graph or inspector. The installed node
catalogue was already memoized: the repeated waste was eagerly constructing reference
JSX before Radix declined to mount the closed dialog.

Help now builds its reference inside Radix's mounted content. Radix retains ownership of
closing presence and animation; query, query nonce, shortcut capture and status stay in
the persistent parent. Reopening reads the current catalogue, keymap and expression
scope without clearing the search. The old implementation fails the closed-reference
regression. After, closed HelpPanel totals 18 / 9 ms, or 0.15 / 0.07 ms per App render.
All 32 Help tests and 12 profiling-walker tests pass in the focused run.

Controls previously scans nodes twice and rerenders the empty phone surface on every
node edit. One node inventory now supplies both widgets and targets; edge-only changes
reuse that inventory. The empty JSX is retained on the complete phone props. Across
initial mount plus 60 node edits, phone renders fall from 61 to one and scans from 122
to 61. Sixty additional edge-only revisions add zero scans. Active controls continue to
read the full current graph; unchanged widget references still see renamed, unbound or
rebound targets. Both old-code regression checks fail. Controls and nearby board/panel
suites pass 39 tests. Its inclusive browser cost falls from 0.25–0.30 ms to 0.01–0.02 ms
per App render in this probe; graph-node revisions still require one membership scan.

The telemetry hub now retains an equal metadata projection. Equality compares every
current field, including pass labels/owners, source hierarchy, categories, readback rows,
counts and budgets. Changed projections still reindex and retire stale measurements.
Equal projections preserve measured frame extent and dropped-frame counts, and retain
plan identity so the performance panel can reuse its structural rows. Compile timeline
marks and their existing coalesced notifications still publish; this does not eliminate
all subscriber updates or the initial projection allocation. Replacing timing sources
still resets their measurements. The old source fails both regression checks; 85 focused
hub, cost, readback and panel tests pass, including 26 metadata mutations.

The before/after browser runs have identical fixture, gestures, instrumentation and
118 App commits per window, but display cadence changes from approximately 10 ms to
30 ms. After's App render means vary between 17.38 and 7.40 ms, versus 14.93 and 16.64 ms
before; its unmodified panes also vary greatly. Busy frame p50 worsens from 8.51–9.80 ms
to 22.98–23.69 ms. Therefore these runs prove the removed component work, **not an
end-to-end FPS improvement**. They ran separately from GPU probes and validation.
Raw JSON, traces, summaries and logs are under
`scratchpad/perf-hotspots-2026-10-02/component-{before,after}/` and
`scratchpad/perf-hotspots-2026-10-02/component-summary.json`.

Independent read-only review found no Help lifecycle defect; it caught a profiler selector
named `SettingsDialog` instead of the installed `ProjectSettingsDialog`, which is corrected.
The encompassing ProjectSettingsHost measurement was valid in both runs. Camera texture
uploads remain shared upstream work: static inference-preprocess uniforms do not receive
per-frame writes when their transient binding set is empty. No speculative camera dirty
flag or shader quality reduction was introduced.

### E55 shader probe: parity-safe candidates rejected

The bounded candidate reuses a Worley cell lookup already evaluated during outer-face
classification. A second candidate also reuses the accepted bisection lookup for the
strut normal. Neither changes sample count, thresholds, precision, resolution or quality.
Only one emitted render shader changes; all 15 passes and 16 resource descriptors remain
identical after excluding source-derived signatures.

At 320×180, both candidates pass 64 whole-image comparisons across two seeds, four
frames and four configurations (shipped, deep relief, no relief, inside eye).
14,745,600 raw HDR components and 14,745,600 final components are bit-identical.
Render-target conversion still bounds this proof; it does not assert equality before
half-float quantization or for all possible uniforms.

At 1920×1080, six warmed alternating rounds measure 96 frames per arm. Whole-frame GPU
extent medians are 91.128 ms baseline, 93.094 ms face reuse, 93.127 ms face plus hit reuse.
Paired round mean savings are −1.08% and −3.02%; descriptive 95% t intervals span
[−5.58%, +3.41%] and [−8.90%, +2.86%]. There are zero timestamp drops. Register pressure
or existing native common-subexpression elimination could offset the saved lookup;
this experiment does not distinguish those explanations.

Both candidates are rejected: **no production shader or generated example changes**.
The probe's absolute extents drift between about 80 and 130 ms and are not comparable
to the earlier browser 18–26 ms shader figures. GPU extent excludes CPU compilation and
readback; fenced wall readings include copy/map and host work. The observed timestamp
quantum is 65,536 ns, not a guaranteed hardware clock resolution. Pixel-comparison records, variants,
metadata and timing records live in
`scratchpad/perf-realtime-2026-10-02/e55-shader-probe/`.

Remaining measured costs are AppShell's graph/inspector/viewer work during parameter
edits and E55's quality-sensitive haze/strut raymarch. This pass found no further proven
quality-preserving E55 win, so it stops at the bounded probe. Uniform updates and camera
content semantics stay intact. Repeated structural telemetry allocation and one Controls
node scan per node-object revision remain, but their downstream rebuild/render waste is
removed. No unresolved model preprocess upload remains behind the dispatch gate.


### Remaining-hotspot validation

Root owns Help and the optional profiling probe; UI agent owns Controls, rendering agent
owns telemetry equality, media/audio agent owns the isolated E55 experiment. Files were
claimed before edits. Independent read-only review found no remaining correctness issues.

- `pnpm lint`: zero errors, five existing warnings.
- `pnpm typecheck` and `pnpm build`: pass. Existing large-chunk advisory remains.
- `pnpm test:e2e src/tests/e2e/help.spec.ts src/tests/e2e/layout.spec.ts --project=chromium --workers=1 --reporter=list --retries=0`:
  seven browser tests pass on owned servers. Help verifies current search after reopening,
  rebinding status persistence, and Escape cancelling capture before dismissing the dialog.
- Initial gates overlap the complete suite and build; one existing device-helper test
  exceeds its 5,000 ms timeout. Fifty other gate files pass. No product change follows
  from that load-sensitive failure; an isolated rerun is required below.

- The complete regression run is **interrupted**, not reported as passing: the user
  reports 100% GPU use, so root stops the native GPU suite immediately. 149 files have
  completed with passing assertions and no recorded failures; no final suite summary
  exists. Native E55 claims and telemetry hub tests passed before interruption.
- Process inspection after stopping finds no session-owned Vitest workers, temporary
  Chromium profiles, E55 probes or listeners on owned ports 5211/5189/5199. Other
  applications and the preexisting MCP helper are left intact. GPU utilization itself
  is not measured by the CPU process listing. GPU-heavy validation stays stopped;
  remaining source/document gates and telemetry verification are CPU-only.
- Isolated `pnpm test:gates --maxWorkers=2 --minWorkers=1`: **51 files, 3,300 tests pass**.
  The earlier helper timeout does not recur. No timeout increase or fallback was added.
- CPU-only `pnpm test:headless src/runtime/telemetry/hub.test.ts --maxWorkers=1 --minWorkers=1`:
  all 55 tests pass. `git diff --check` passes. No Git history operation or deployment.

## vgpu runtime usage audit

Read-only follow-up after the user's runtime-usage question. No GPU/browser jobs restart,
no product edits, and no new execution measurements. Findings below distinguish source
mechanisms from reproduced runtime faults.

**We do benefit from vgpu.** `resources.ts` constructs vgpu targets, storage, shared
uniforms, effects, computes and draws. Render passes use `Frame.pass`; vgpu provides the
shader-module, layout, render-pipeline and bind-group caches, validation, timing, readback
and device ownership. Same-signature compile (`vgpu-backend.ts:2079`) reuses the compiled
program; structural carry preserves unchanged objects and temporal contents. The previous
warm-frame, carry/recovery, binding and pixel tests substantiate these paths. There is no
second native pipeline implementation replacing vgpu.

Loom's graph compiler, transport, resource carry and reset semantics belong above vgpu.
Raw history-array copies, media uploads and reset clears address specific adapter needs.
They do add separate submissions; using a native escape hatch alone is not evidence of
misuse. Partial frame submission on failure uses the explicit supported `Frame.submit`
contract and has existing GPU regression coverage.

**Avoidable adapter work remains:**

- Default editor pacing (`vgpu-backend.ts:621–625`) checks eligibility inside vgpu's
  `frameLoop` callback. Installed `frame.js:615–653` has already created the encoder and
  submits it after a normal return. Skipped display ticks therefore still submit empty
  command buffers. The perform-window path gates before `frame()` (`:690`), demonstrating
  the appropriate ownership boundary. `use-perform-windows.ts:201` chooses the default
  path when no visible perform window exists.
- Same-signature compile applies every populated pass's uniforms (`:2083`), even when
  only one parameter changed. `applyUniforms` (`:792`) always calls the shared block's
  `set`; installed `uniforms.js:23–28` clones, packs and writes without equality checks.
  Fresh block adoption also initializes its bytes before the later `flushUniforms`
  (`:2221`) writes them again. Pipeline reuse does not remove these uploads.
- Temporal rebinding (`:1357`, `:1407`) repeatedly calls drawable `set`. Installed
  `set-resources.js:94` creates a new texture view for a Texture; core `texture.js:47`
  directly calls native `createView`. Existing bind-group cache entries still hit, but
  view creation and subscription replacement remain. Stable whole-ring/live bindings
  also repeat normalization. The nearby “no allocation” comments are too broad.

**Execution limitation and possible correctness gap:** installed `compute.dispatch`
creates and submits its own encoder; indirect `Draw.draw` also self-submits. Render passes
wait until their frame closes. Open-frame execution deliberately accepts previous-frame
render-to-analysis latency (§V144); the direct path splits render/compute segments for
current-frame ordering. Upstream's [open vNext design issue #320](https://github.com/vercel-labs/vgpu/issues/320)
identifies this exact compute/render gap and proposes unified frame encoding. It is a
proposal, not an API available in our installed 0.5.0.

Direct segment splitting currently recognizes dispatch only (`:1299`), while indirect
render draws self-submit (`:1215`). A deferred render followed by an indirect draw could
therefore execute out of plan order. Existing fixtures cover compute-to-indirect draw,
not this dependency. This is a source-level correctness concern requiring a focused CPU
reproducer before claiming a delivered failure or fix. CPU-only swaps also conservatively
force segment splits and can add empty frames; cached segmentation removes repeated list
construction, not these submissions.

**Retirement concerns require focused lifetime reproducers:** drawable eviction
(`:3262`) clears bind groups but has no API to release binding subscriptions. Upstream
`set-core.js:73–82` subscribes to surviving targets; `draw.js:77` captures the Draw, and
`target-offscreen.js:92` retains recreation callbacks until target destruction. Retired
uniform wrappers are registered with kernel ownership (`uniforms.js:125`) without an
unregister callback; manual `destroy` (`:109`) frees their buffers but can leave wrapper
references retained until GPU disposal. These are source-supported CPU retention concerns,
not measurements of growing live GPU-buffer allocations.

The MSAA patch intentionally changes discard to store, including passes which later need
no preservation. That can add bandwidth; no isolated cost is established. Render bundles
are not an automatic replacement for this multi-target graph. More API adoption alone
would not prove a performance benefit.

Priority: reproduce indirect-draw ordering; then remove empty paced frames, redundant
uniform uploads and redundant rebinding while preserving resize, swaps and recovery.
Audit lifecycle retirement separately. None of this means vgpu was unused, and none
establishes that these overheads caused the user's reported 100% GPU load.

## Follow-up — 2026-10-03

Chrome Screen In now opens tab/window/screen sharing only from an explicit gesture and
owns cancellation, track retirement, project boundaries and backend replacement. See
[screen capture](screen-capture.md).

Media source textures retain the whole decoded image independently of output resolution.
Common offers Fit (default), Fill and Stretch. A smaller H.264 copy of the user's video
was exported without changing the original. Movie File In now monitors embedded audio
through its existing video decoder. Real Chrome exposed a repeated seek/audio-buffering
feedback loop; continuous playback now converges by bounded rate correction, retaining
exact transport discontinuities. See [media fit and audio](media-fit-and-audio-2026-10-03.md)
for source sizes, codec settings, measured seek counts and limitations.

The helper blocking manual startup was PID 8749, a Loom MCP child of the user's Claude
session, started September 30 and listening on 127.0.0.1:43919. It was stopped at the
user's request; a bounded listener check confirmed that port was free. Claude itself,
the user's development servers and other apps were left running. A stale handoff file
does not lock startup: the next helper ignores dead owners and overwrites the handoff.
Start the desired helper first; later MCP clients can proxy through that listener.

### Matte first-result regression

The new inference demand gate reconstructed `cut:preprocess`, while the compiler's actual
dispatch ID was `cut#cut:preprocess`. The backend ran preprocessing but never called that
gate, so no input reservation reached readback or inference. This regression came from
the performance changes in this worktree and affected the shared Depth/Pose/Matte hook.

The hook now finds dispatch ownership through `nodeId` and registers the exact compiled
pass ID. The same lookup restores source dimensions; slicing the namespaced ID had also
left inference's source aspect at 1×1. There is no backend/model fallback or extra loop.

A bounded real Chrome/WebGPU Solid→Matte→Output probe recorded 301 dispatches and zero
preparations before the fix. Afterward, the real MediaPipe model returned a mask and the
node left “computing first result”; 170 matching reservations were consumed during the
five-second observation. The solid-grey fixture correctly reported no person. CPU tests
exercise Depth, Pose and Matte with opaque nested IDs, actual compiled IDs, source aspect,
retracking and cleanup; they do not claim every real ONNX model was benchmarked.

Switching Matte models also falsely warned about deliberately retained `backend`,
`inputSide` and RVM settings. An explicit node definition trait declares those dormant
keys, derived from the model schemas. They remain saved for switching back, remain absent
from inappropriate controls/resolution, and unrelated unknown parameters still warn.
The command-based model-switch/undo regression passes without deleting stored pins.

Full browser artifacts and the reproducible probe remain under ignored
`scratchpad/perf-realtime-2026-10-02/`. All probe browsers and owned servers were stopped.

### Final follow-up validation

Complete CPU run excluding native GPU files: 712 files passed, 11,586 tests passed,
3 existing skips and 1 todo, clean exit. Mandatory gates: 51 files / 3,307 passed.
Typecheck, lint and production build passed; five unrelated lint warnings and the
existing bundle-size warning remain. Shared inference's focused proof passed 30 tests;
Matte schema/compiler/runtime requirements passed 49. Real MediaPipe completed in the
bounded browser probe. Final Chrome movie playback and both Screen In tests passed.
Full native GPU sweeps were avoided; three tiny image-fit pixel tests passed and disposed
their devices. Ports 43919, 5189 and 5199 were confirmed free after cleanup.


## MatteCut and input-age compensation — 2026-10-03

Added the requested reusable video masking component through the existing component
save/publish pipeline. One picture feeds Matte and Cache; Mask applies the matte to the
matching cached picture's alpha. Model, Smoothing, History, and Scale are published.
Only the new MatteCut generated file was written.

The investigation found two timing errors that simple wiring would have preserved:
delaySeconds measured completion age rather than input age, and a project frame-index
difference does not index a ring that stores actual renders. Live effect-to-compute
submission also samples an earlier texture than the issue frame. Backend input provenance
now provides cacheFrames, accounting for submitted renders and that ordering difference.
Delay includes inference time; the existing completion clock still measures inference rate.

Cache supports a current-frame tap and explicit Strict History. Missing results/history
stay transparent in MatteCut, rather than composing the wrong frame. Defaults are
24 half-scale frames with smoothing 1; increasing resolution/history has a visible memory
cost, and smoothing below 1 deliberately blends source frames.

Agents split component authoring, capture-timing tests, and bounded native pixel proofs.
Full CPU suite passed 11,606 tests; final focused checks passed 169; all 3,321 gate tests,
typecheck, lint, and build passed. Native alignment passed three tests using 13 tiny
8×8 renders, deterministic inference, and both direct/live paths. No model download or
long-running GPU instance was needed; all owned processes exited. Existing lint/bundle
warnings remain. Details and timing expressions:
[MatteCut alignment](matte-cache-alignment-2026-10-03.md).


## Channels, components, and connection drops — 2026-10-03

Follow-up fixes cover actual Common channel masks, alpha display, two-way component
parameter ownership, stable Common drag targets, and MatteCut's exposed Mask output.
Untouched channel masks add no GPU work; opted-in masking adds one pass and target per
texture output. Tests use bounded tiny native fixtures and isolated browser runs.
Research, semantics, cost, and validation:
[channels and component controls](channels-components-and-connections-2026-10-03.md).
