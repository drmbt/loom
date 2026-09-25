# Direct-canvas export prototype

This isolates a generic export improvement: capture an exact-size GPU presentation as
a `VideoFrame`, instead of reading half-float pixels into JavaScript, converting to RGBA8,
and constructing a CPU-backed frame. It uses the existing Loom backend and presentation
API. It does not modify scenes, lower working precision, change application defaults,
or add a silent fallback.

Run from the repository root with a logged-in GPU/display session:

```sh
node experiments/canvas-export/run.mjs /tmp/loom-canvas-export-result.json
```

The runner owns an isolated Vite server on port 5206 and a muted, headed Chromium
instance. Both close afterward. It never opens a user project or saves a video. For
only the small correctness checks:

```sh
PARITY_ONLY=1 node experiments/canvas-export/run.mjs /tmp/loom-canvas-export-parity.json
```

## What is measured

- A backend-generated asymmetric fixture contains dark and bright colour patches,
  neutral steps, smooth gradients, and a changing binary frame marker.
- Six pre-encoding cases cover `rgba16float`, `rgba8unorm`, and `rgba8unorm-srgb`, with
  opaque and varying alpha. RGB must match within one byte; alpha is deliberately
  opaque for the H.264 destination. Snapshots are inspected after subsequent renders.
- A 12-frame 1024×512 H.264 sequence is captured through each path, decoded, and checked
  for frame-marker order and timestamps. There is no GPU readback/fence before direct
  canvas snapshots. Each decoded path is compared with the original pixels in sRGB.
- Quality criteria are PSNR ≥35 dB, no more than 1 dB below the baseline, mean error
  no more than 0.25 code values above baseline, and p95 no more than one code above it.
  These are prototype thresholds, not a claim of lossless video or universal quality.
- Four 60-frame portrait 4K batches run in readback/canvas/canvas/readback order. Both
  use the production H.264 codec selector, bitrate policy, 64 MiB queue limit, and
  current flush-based backpressure. Compilation occurs before timing; first-frame
  lazy work and final encoder drainage are included. The baseline has no presentation
  pass. The direct path adds the required GPU blit but performs no backend readback.

This tests render/handoff/encoding, not MP4 muxing, OPFS writes, audio, or the complete
render dialog. Codec configuration and queue policy are explicitly mirrored here;
this experiment is not a second production encoder. Encoded benchmark chunks are
counted and released; only the small correctness sequence retains chunks for decoding.

## Result, 2026-09-18

The captured browser version and measurements are in
[`result-2026-09-18.json`](./result-2026-09-18.json).

| 2160×3840 handoff benchmark | First batch | Second batch |
| --- | ---: | ---: |
| CPU readback | 23.40 fps | 24.11 fps |
| OffscreenCanvas | 60.76 fps | 60.75 fps |

The isolated path is about **2.56× faster**, or roughly **25.6 ms/frame less** in this
fixture. This is not a prediction of a 2.56× improvement for a GPU-heavy scene. Both
paths still pay scene rendering cost. No claim is made that browser internals perform
zero copies; the measured direct path eliminates Loom's explicit CPU readback.

All six raw-pixel cases matched **exactly**, including RGB under alpha values 0, 0.5,
1, and 1.5. All 12 decoded frame markers matched 0–11, with matching timestamps.

| Decoded RGB versus source | Readback | Canvas |
| --- | ---: | ---: |
| Mean absolute error, 0–255 | 0.952 | 0.876 |
| p95 / p99 error | 3 / 6 | 3 / 6 |
| Maximum error | 53 | 60 |
| PSNR | 40.52 dB | 40.20 dB |

The direct path passes the stated quality criteria, but decoded files are not identical.
Both input frames report sRGB. On this Mac, Chromium reports Rec.709 for canvas-derived
H.264 and SMPTE170M/Rec.601 for the CPU-derived H.264. An initial attempt to require
near-identical decoded pixels failed; checking against source pixels is necessary
because both outputs are lossy and take different RGB-to-YUV conversion paths.
Large individual errors remain in this boundary-heavy fixture for both paths; natural
imagery and longer sequences remain necessary before product promotion.

The [WebCodecs specification](https://www.w3.org/TR/webcodecs/#videoencoderconfig)
does not expose an encoder colour-space override. Chromium's
[encoder implementation](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webcodecs/video_encoder.cc)
selects Rec.709 for the accelerated Apple texture path. No metadata relabelling or
unsupported configuration workaround is applied here.

An exploratory unattached HTMLCanvasElement comparison failed pixel parity. That variant was not used for the timing or codec checks. The prototype deliberately
uses OffscreenCanvas; it does not switch canvas types on failure.

## Promotion boundary

The initial prototype left production unchanged. The app integration now uses
`src/app/render-canvas-capture.ts` for a dedicated offscreen presentation and passes its
snapshot callback into the existing WebCodecs encoder. The recorder selects that
explicit capability without reading scene pixels. The ordinary CPU encoder path remains
available to other callers; failure of a canvas capture never selects it automatically.

`src/tests/e2e/canvas-render.spec.ts` verifies the production capture adapter, recorder,
range stepper, H.264/AAC encoder, muxer, and OPFS spool together. A feedback graph at
60 fps evaluates all 24 source frames for a 12-frame 30 fps take. Decoded frame markers
match the existing readback path's temporal result, audio and video last 0.4 seconds,
AAC stays continuous, and capture plus a cancelled second take perform zero scene
readbacks and leave no additional temporary files. Unit tests cover device loss,
invalid presentation, frame ownership, immediate capture errors, and aborting stalled
encoder backpressure. Odd H.264 dimensions are now rejected before capture instead of
being silently rounded down by the old pixel conversion path. The actual E75 dialog also started and cancelled with no page
errors, full-frame readbacks, or temporary files remaining.

These checks validate integration, not the prototype's 2.56× speedup on arbitrary
projects. Natural-image codec comparisons and sustained integrated 4K throughput are
not claimed by the small generic browser test. The captured prototype metrics above
remain a historical isolated benchmark.
