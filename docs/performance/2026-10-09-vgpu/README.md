# Rendering measurements — October 9, 2026

The two implemented changes are unchanged-environment reuse in Loom and native
pipeline-binding suppression in the vGPU patch. All measurements below are from an
Apple M3 Max on macOS 26.3.1. They establish behavior and cost for these workloads;
they do not prove that every browser, driver or graph improves.

## Loom environment preparation

The fixture renders the same rough PBR floor through two Render nodes, using a
512 × 256 HDR lamp environment and `rgba16float`. The reference uses the same compiled
shaders and resources with preparation metadata removed. Both backends cook every
frame; whole-plan idle skipping is disabled.

Each scenario has seven alternating reference/candidate trials, 30 warm-up frames
and 120 measured frames per trial. A one-pixel readback waits for completion outside
the measured CPU interval; final full images are compared byte-for-byte. A reference
repeat follows each scenario. No other benchmark or build ran during this final run.

| Scenario | Reference CPU encode | Optimized CPU encode | GPU trial median range, reference → optimized | Preparation spans/frame |
| --- | ---: | ---: | --- | ---: |
| Static HDRI, moving material | 0.608 ms | 0.415 ms (−31.7%) | 2.097–2.163 → 0.131–0.393 ms | 12 → 0 |
| HDRI changes every frame | 0.592 ms | 0.541 ms (−8.6%) | 2.097 → 1.114–1.704 ms | 12 → 7 |

CPU figures are medians across the seven trial medians. All 14 trial pairs match both
outputs exactly, and no timing results were dropped. The seven preparation spans in
the changing-source case are six real filter passes plus one exact atlas copy.

GPU timestamps are visibly quantized. The extent sums timed segments of one logical
render, excluding inter-segment gaps, readback and untimed work. Run order affects
some GPU figures, so a precise GPU percentage would overstate the evidence.

Raw data, baseline repeats, capabilities, output hashes and source hashes:
[environment.json](environment.json). Reproduce with
`tools/heavy.sh node --import ./src/tooling/alias-hooks.ts tools/bench-environment-preparation.ts`.
The script requires real timestamp-query support and fails if results or pixel parity
are missing.

## vGPU owned-pass pipeline state

The [complete comparison table](all-measurements.md) keeps every prior CPU result in median µs/draw, alongside ms/frame. The quiet 5k/10k Node/browser rerun is complete.

This source prototype targets canary `9c23f6c0`, after upstream #493. It suppresses
only repeated native `setPipeline` calls. Groups, offsets, geometry, validation and
other draw state keep their original paths.

The original seven-trial results remain in [pipeline-native.json](pipeline-native.json) and [pipeline-mock.json](pipeline-mock.json). The follow-up
uses 15 paired process trials per workload, alternating reference/candidate order,
at 50, 250 and 2,000 draws per pass. Multi-draw frames contain three passes. A separate
single-draw control has one pass per frame. Every sample is retained.

## Native results

The percent column is the median of the 15 paired percentage changes. The time column
is the median paired CPU encoding time saved for the complete three-pass frame. These
are different statistics; neither is calculated by dividing independent column medians.

| Draws/pass | Workload | Paired CPU change | Exploratory 95% interval | CPU saved/frame |
| ---: | --- | ---: | --- | ---: |
| 50 | Different drawables, same pipeline | -6.8% | -7.6% to -6.3% | +0.041 ms |
| 50 | Same drawable, same pipeline | -8.7% | -10.0% to -7.6% | +0.044 ms |
| 50 | Alternating pipelines | +0.8% | -0.7% to +1.3% | -0.004 ms |
| 250 | Different drawables, same pipeline | -9.7% | -10.2% to -8.8% | +0.235 ms |
| 250 | Same drawable, same pipeline | -10.6% | -11.2% to -10.2% | +0.217 ms |
| 250 | Alternating pipelines | +0.7% | -3.3% to +3.2% | -0.017 ms |
| 2000 | Different drawables, same pipeline | -6.9% | -10.2% to -4.7% | +1.743 ms |
| 2000 | Same drawable, same pipeline | -11.0% | -11.8% to -9.2% | +1.841 ms |
| 2000 | Alternating pipelines | +0.7% | -0.1% to +3.1% | -0.124 ms |

The same-pipeline reductions persist across all tested counts. Alternating-pipeline
intervals include zero; this does not establish zero overhead. The single-draw native
control is inconclusive (paired median −1.6%, interval −7.5% to +9.1%).

Mock results isolate JavaScript bookkeeping from native driver-call savings. Some costs
increase: repeated-draw medians are +4.8%, +0.2% and +1.9% at 50/250/2,000 draws;
alternating-pipeline medians are +4.7%, +3.3% and +1.2%. Several intervals exclude zero.
These increases should not be dismissed as machine contention. They support a small
JavaScript tradeoff when native setters offer little or no savings.

## Repetition, outliers and uncertainty

Each process warms up before measuring. A multi-draw trial averages 60 timed frames;
a single-draw trial averages 1,000. Headline comparisons use process-trial medians,
not one run or an average across all frames from every process.

`statistics.json` reports means, medians, MAD, quartiles, per-trial paired percentage
changes and Tukey 1.5-IQR outlier flags. All flagged samples remain in the results.
A separate sensitivity field removes a pair when either member is flagged; it is not
used to select the headline. The analysis uses 20,000 fixed-seed paired bootstrap
resamples. These exploratory intervals are coarse at 15 pairs, are not adjusted for
multiple comparisons, and cannot establish platform-wide guarantees. Outlier checks
apply to process-trial averages; individual timed-frame samples were not retained.

## Measurement overhead

The harness reads `performance.now()` twice around the complete frame. There is no
per-draw timing probe. Each trial also calibrates 20,000 empty intervals after encoding.
Their average is usually about 35–43 ns per frame (single-draw trials about 35–47 ns).
That is approximately 0.23–0.29 ns/draw at 150 draws/frame, or 0.006–0.007 ns/draw at
6,000 draws/frame. It cannot explain a several-nanosecond per-draw JavaScript increase.

Raw trials include the empty-interval distribution summary, estimated observer cost
per draw and an estimated clock-adjusted value. The headline remains unadjusted: the
calibration cannot remove JIT, GC, scheduling, tracing or GPU timestamp overhead.
The paired reference/candidate measurements use the same boundary probes, so this
small fixed cost largely cancels. CPU timing excludes initialization, queue completion
and pixel readback. These are not GPU-throughput or end-to-end frame-rate results.

## Practical scope

Exact repeated-drawable rendering is a favorable stress case. The more representative
opportunity is consecutive different objects sharing a native pipeline: compatible
meshes/materials, sprites or UI quads, and batched shadow draws. Instancing already
reduces many objects to one draw. Fullscreen effects in separate passes have no repeated
pipeline binding to remove. Pipeline switching also removes this optimization’s benefit.

Loom groups compatible geometry and shadow draws, so it can use the different-drawable
case. Its ordinary one-draw post-processing passes do not benefit. Upstream #489 gives
one concrete many-draw workload; it does not establish how frequent this pattern is
across vGPU consumers. No representative application population or frame-rate change
was measured here.


The complete harness, source hashes and raw data are on [fork PR #8](https://github.com/laubsauger/vgpu/pull/8). [Statistics](statistics.json) also analyze the Loom environment trials: the paired CPU intervals remain below zero for both scenarios. GPU timestamp quantization still limits the GPU figures.

The source prototype still passes all hard client bundle budgets. Four tooling entries retain allowed warnings already present in pristine canary. A broader native state-cache prototype was rejected after mock overhead and bundle growth were measured.

## Correctness and checks

- 126 focused backend/plan/pipeline mock tests pass.
- 38 focused Dawn checks pass, including actual HDRI image parity, MSAA, presentation,
  compile failures, submission failures and timer retraction.
- All 61 gate files pass: 2,186 checks. The initial run found a hand-built fixture clock;
  it was changed to `frameFromClock`, and the final gate run passes.
- Fresh-process imports pass: 309 checks.
- Typecheck, lint and production build pass. Lint retains four existing warnings;
  the build retains its large-chunk warning.
- The full test suite and browser interaction suite were not run. No browser interaction
  changed; validation followed the backend and dependency-patch blast radius.

[Commands](commands.txt) lists the scoped checks. Separate vGPU prototype results and
limits are documented in each fork PR. Tests demonstrating a current gap are
reproductions, not claims that the proposed API has been implemented.

## Fork review

Both fork base branches match their upstream counterparts. Existing PRs #1–#4 were
refreshed without rewriting their old branch history. All eight PRs are drafts against
fork canary; verified heads and exact file counts are in [fork-prs.json](fork-prs.json).

| PR | Review scope |
| --- | --- |
| [#1](https://github.com/laubsauger/vgpu/pull/1) | Opt-in MSAA preservation prototype and native proof |
| [#2](https://github.com/laubsauger/vgpu/pull/2) | Legal disjoint writable ranges; overlap and mixed-access controls |
| [#3](https://github.com/laubsauger/vgpu/pull/3) | Bounded live-consumer cache retention and optional trim use case |
| [#4](https://github.com/laubsauger/vgpu/pull/4) | Frame extent and asynchronous frame attribution prototype |
| [#5](https://github.com/laubsauger/vgpu/pull/5) | Compatible resolved-color view formats, including resize |
| [#6](https://github.com/laubsauger/vgpu/pull/6) | Reproduction of compute-pass timing gap |
| [#7](https://github.com/laubsauger/vgpu/pull/7) | Reproduction of silent timing drops and missed free staging slots |
| [#8](https://github.com/laubsauger/vgpu/pull/8) | Pipeline suppression prototype, benchmark harness and raw data |

No issue or PR has been published to the parent repo. Parent publication requires
owner review. Upstream’s external policy uses draft `contribution` proposals; its
release-impact validator has not yet rolled out that type. The descriptions explain
that mismatch rather than changing the type or release metadata to pass it.

## Quiet high-count browser and Node follow-up

The complete [comparison table](all-measurements.md) includes all earlier runs and the quiet rerun at exactly 5,000, 6,000 and 10,000 total draws per frame. Every CPU row uses median µs/draw with the corresponding ms/frame. GPU pass durations have their own ms/frame table. The rerun reserved both heavy-work slots after the owner confirmed video playback had stopped.

The substantial gains are measured on vGPU’s existing `vgpu/node` backend, which uses Dawn; this work does not introduce that backend. These gains may be specific to Node/Dawn. They can help CPU-bound headless rendering or batch exports with many compatible draws, including consumers such as Loom, but whole-scene performance was not measured. Node/Dawn savings approximately double from 5k to 10k. For different drawables sharing a pipeline, the displayed median savings are 1.774 and 3.682 ms/frame; for a repeated drawable, 1.448 and 3.008 ms/frame. This is consistent with roughly linear savings over the tested range. It does not establish a global complexity curve.

Full headless Chromium 151.0.7922.34 used a real Apple Metal adapter (`isFallbackAdapter: false`) with timestamp queries. CPU gains are smaller: different-drawable median savings are 0.068 and 0.043 ms/frame at 5k/10k, while the repeated-draw case saves 0.115 and 0.135 ms/frame. These small browser results do not establish linear savings. Alternating-pipeline controls can incur a small cost. GPU pass timing remains variable and supports no general GPU-throughput claim.

Each workload has 15 paired trials. The [analysis](high-counts/statistics.json) retains all samples, outlier flags and exploratory paired intervals. [Browser binding audit](high-counts/browser-binding-audit.json) verifies exact color strips from four different transforms/material buffers: both paths draw four times, with four baseline pipeline bindings versus one optimized binding.

The earlier video-contended batch remains excluded. Fork PR #8 has been reduced to five files by commit `f2511ef7c1f07c85c27b7b6dbc89024d247a36cf`: three implementation files, one focused test file and one standalone Node/mock benchmark. Its description includes the complete prior/new tables and explicitly limits the substantial measured gains to Node/Dawn. Browser harnesses, raw samples and statistical detail remain local supporting evidence outside the vGPU code diff.
