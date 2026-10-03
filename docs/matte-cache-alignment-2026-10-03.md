# MatteCut and measured video alignment

## Use

Instantiate **MatteCut** from the component library. Connect Movie File In, Webcam In,
Screen In, or any picture output to its `picture` input. Its `out` carries straight
colour with the matched person matte in alpha, ready for compositing over a background.
The generated demonstration has a Movie File In beside the component; choose its file.
Acquire the selected model using the normal Matte consent/download controls.

Published controls: **Model**, **Smoothing**, **History**, **Scale**.
Defaults: MediaPipe Selfie Segmenter, smoothing 1, 24 frames, half scale. Increasing scale
to 1 preserves picture resolution and quadruples history memory. At 1920×1080 rgba16float,
the default history array alone is about 95 MiB; at 1280×720 it is about 42 MiB, plus working
and output textures. The deepest supported history is 63 prior rendered inputs.

Before the first result, output is transparent. If the matching frame is older than the
allocated history, or history was reset, strict history outputs transparency. Increase
History or reduce inference work/rate pressure when that happens. It never
substitutes an unrelated oldest frame. Smoothing 1 means each result belongs to one input;
less smoothing blends masks from several inputs and intentionally changes that guarantee.

## Reference a model node's measurements

Browser-tracked Matte, Depth, or Pose nodes exposes these ordinary expression channels:

| Expression | Meaning |
| --- | --- |
| `op('matte1').chan.ready` | 1 after a successful result, 0 before/reset |
| `op('matte1').chan.cacheFrames` | Cache tap for the next encode, counting rendered inputs |
| `op('matte1').chan.delaySeconds` | Age of captured input on the absolute clock, including inference |
| `op('matte1').chan.fps` | Measured completed inferences/second; needs two results |
| `op('matte1').chan.realtimeFactor` | Inference rate divided by measured display rate |
| `op('matte1').chan.lagFrames` | Legacy project-frame-index distance; can wrap, not a Cache tap |
| `op('matte1').chan.coverage` | Fraction claimed by Matte's current result,0..1 |

Names are normal node labels; `coverage` is Matte-specific. Before results, numeric fields
read 0 alongside ready 0. Expressions inside components are rewritten per instance, so two
MatteCut instances do not read each other's timing.

## What changed

Previously `delaySeconds` subtracted the result completion timestamp. A 400 ms model
therefore reported 0 delay when its old mask finally arrived. Input capture time is now
retained separately; completion time still measures inference rate.

Project `frameIndex` is not a history cursor: it can skip at low display rates and wrap
with a timeline loop. The new cacheFrames channel uses actual backend render ordinals.
The backend stamps sampled texture provenance after submission. Live rendering queues
an effect into an open frame while preprocessing self-submits immediately, so preprocessing
reads the preceding submitted effect. Direct/offline rendering splits those submissions
and reads the current effect. Provenance accounts for each path without a guessed offset.
Indirect draws self-submit and stamp their current input immediately. Cleared/resized
textures lose their stamp until rendered again; replacing the backend forgets old results.

Cache now supports index 0 through its completed write target. Strict History is an explicit
mode; its requested tap stays intact beyond capacity and its shader returns transparency
for missing input. The ordinary Cache default still holds the oldest available frame.
Index's upper slider value is a suggestion rather than a hard clamp, so a large measured
age reaches the strict check instead of silently becoming 63.

MatteCut is authored through component save/publish commands. Only
`examples/components/MatteCut.loom.json` was regenerated; other generated documents were
preserved. No new inference service, worker, or model download path was introduced.

## Validation

- Full CPU regression suite: 712 files, 11,606 tests passed (three existing skips,
  one existing todo); native GPU files excluded. Final focused rerun after the
  provenance reset/resize checks: seven files, 169 tests passed.
- Required source/document gates: 51 files, 3,321 tests passed.
- Typecheck, lint, and production build passed. Lint retains five unrelated warnings;
  build retains its existing large-bundle warning.
- `pnpm test:headless` against dispatch-demand and native alignment tests: 11 tests passed.
  Final native alignment rerun matches the component's alpha masking: three tests passed,
  13 total renders, 8×8 inputs/history/results, no model downloads.
- Native tests exercise deferred live and segmented direct inputs, skipped/wrapped
  project indices, delayed results, strict overflow transparency, tap 0, and ordinary
  Cache startup. CPU tests cover missing source provenance, backend replacement,
  reset/resize, captured input timestamps, and two independently renamed components.
- GPU inference in the alignment proof is deterministic. This tests frame identity and
  recomposition, not model segmentation quality. Real model acquisition/inference was
  validated separately in the preceding Matte repair.

The sandbox could not acquire Dawn's adapter. The bounded native test ran with device
access and disposed every backend in `finally`. The first sandboxed gate run timed out
in its loopback-helper test; the final run with loopback access passed. All owned test
runners exited; process/port inspection found no leftover test browser, GPU runner,
or helper on the checked ports. No new browser interaction path was added; browser
hook lifecycle is covered by the focused hook tests.


MatteCut now exposes **Cutout** (existing `out` address) and **Mask** (the same Matte
intermediate used internally). Default RGBA inspection displays alpha-only cutouts;
RGB inspection remains available. See
[channels and component controls](channels-components-and-connections-2026-10-03.md)
for actual processing masks, synchronization, and the display-only checkerboard.
