# Continuous offline rendering: bounded performance probes

Measured on 2026-09-17 after the offline audio seek and duplicate readback-copy fixes.
The initial short runs did not reproduce progressive slowdown. A subsequent 1,200-frame
4K run did show increasing frame time, concentrated in GPU rendering/readback waits.
None of these runs covers a minutes-long timeline.

## Production encoder and disk storage

A muted Chromium instance encoded 480 identical synthetic 960×540 frames at 30 fps
through `createWebCodecsEncoder` and the production OPFS spool. No scene or destination
download was involved. Measurements were grouped into eight 60-frame windows.

| Measurement | Result |
| --- | ---: |
| First window | 0.777 ms per frame |
| Last window | 0.555 ms per frame |
| Maximum native encoder queue | 32 frames |
| Temporary media payload | 1,073,976 bytes |
| Completed MP4 | 1,077,492 bytes |
| Finalization | 16.5 ms |
| JavaScript heap, start / peak | 3.56 / 6.41 MB |

Written payload grew approximately linearly. Only sample-index metadata stays in memory;
the encoded payload is written to disk. Constant frames compress well, so this probe
isolates orchestration and queue behavior rather than worst-case media bitrate.

## E75 through the actual app

Separate muted, headed Chromium instances opened E75 from Examples, then used the render
dialog. The probes cancelled after 300 output frames at 960×540 and 180 at 2160×3840.
Both used the inherited 60 fps timeline/output rate and half-float working format.
Neither saved a destination video. Both completed cancellation with no page errors and
an empty temporary-storage directory.

Progress timestamps measure wall time per completed output frame. GPU constructors,
destruction, and readback completion were instrumented before app startup. These hooks
add measurement overhead. JavaScript heap readings include the app, decoded source
audio, and transient allocations; they are not retained-heap measurements after forced GC.

| Measurement | 960×540 | 2160×3840 |
| --- | ---: | ---: |
| Output frames | 300 | 180 |
| Measured capture interval | 17.91 s | 55.88 s |
| First batch, ms/frame | 66.95 | 376.74 |
| Last batch, ms/frame | 40.40 | 275.06 |
| Batch size | 50 | 30 |
| Maximum live GPU buffers during capture | 223 | 223 |
| Maximum live GPU textures during capture | 135 | 135 |
| Live buffer allocation at last sample | 385.30 MiB | 445.09 MiB |
| JavaScript heap, minimum / peak / final | 194.58 / 735.27 / 258.22 MiB | 265.74 / 727.00 / 285.13 MiB |
| Mean full-frame map wait | 51.44 ms | 262.42 ms |

Resource counts did not grow with frame count. Heap usage repeatedly fell, rather than
retaining a new image for every captured frame. The 4K batch times were 376.74, 324.48,
313.39, 290.96, 282.02, and 275.06 ms/frame. The lower late values are observations,
not a controlled before/after speedup claim: scene state and runtime warm-up change.

The map wait includes preceding GPU work and readback; it does **not** measure transfer
alone. It accounts for most of the observed frame interval, so the next optimization
investigation belongs at GPU rendering/readback rather than MP4 stitching. No working
format, resolution, simulation step, or frame was reduced or skipped by these probes.

## Preview work during export

Inspection found that node thumbnails, graph backgrounds, and synthesized viewers
continued submitting GPU work while the export owned the timeline. Advancing export
frames defeated the thumbnails' existing idle check. These three preview loops now
read the root export controller's live busy state and suspend updates during the take.
Device/document invalidation still runs; preview resources and sink registrations remain
intact, and updates resume on the next tick after export. Component dives use the root bus.

Focused tests cover suspension after mounting, advancing backend frame counters,
resumption without recreating hosts, retained sinks, and device invalidation while paused.
A fresh muted app probe captured 60 portrait 4K frames and cancelled successfully, with
no page errors or leftover temporary files. Its two 30-frame batches measured 203.82 and
184.54 ms/frame, versus 376.74 and 324.48 in the earlier run. This is an encouraging
observation, not a controlled speedup guarantee: the runs were sequential, warm-up can
vary, and validation processes were launched around the follow-up probe. No scene
resolution, working format, or simulation cadence changed.

## Extended 1,200-frame capture

A subsequent fresh muted Chromium run completed **1,200 output frames** at 2160×3840,
60 fps, with preview suspension enabled. This represents 20 seconds of timeline and
245.09 seconds of capture wall time. The configured out point was 1201; the probe
cancelled at 1200 completed frames before finalization or destination saving. No builds
or test suites were launched during this measurement. Cancellation completed with no
page errors and no remaining temporary files.

| Completed frames | Mean frame interval | Mean full-frame map wait |
| --- | ---: | ---: |
| 0–120 | 185.27 ms | 139.86 ms |
| 120–240 | 181.31 ms | 138.84 ms |
| 240–360 | 190.25 ms | 145.22 ms |
| 360–480 | 193.78 ms | 148.23 ms |
| 480–600 | 198.49 ms | 152.65 ms |
| 600–720 | 198.74 ms | 152.87 ms |
| 720–840 | 199.35 ms | 153.69 ms |
| 840–960 | 201.47 ms | 156.68 ms |
| 960–1080 | 240.69 ms | 196.13 ms |
| 1080–1200 | 253.02 ms | 209.31 ms |

This **does reproduce slower throughput later in one take**: approximately 5.40 to
3.95 output frames/s, or a 37% increase in frame interval. The extra time is concentrated
in the full-frame map wait, which includes queued GPU rendering and transfer. Time
outside that wait remains around 42–46 ms/frame. This does not isolate GPU shader time
from transfer latency or system contention.

Live resource counts stayed at 223 buffers and 135 textures at every 120-frame boundary
after startup. Buffer allocation remained 445.09 MiB. JavaScript heap ranged from 261.23
to 684.11 MiB, repeatedly fell, and ended at 506.65 MiB. These observations do not support
retaining a new raw frame or GPU resource on every capture.

A read-only audit found constant per-frame orchestration in the recorder, encoder,
and spool. Retained video metadata grows one small record per output frame; offline
audio retains one transport state per project frame. AAC encoding and MP4 sample-table
construction happen after frame collection. Encoded packet writes have bounded
backpressure. None of those paths walks the entire preceding take on every frame.

Remaining distinction: elapsed runtime versus changing scene cost. E75 changes projection
families and visibility over time, and its fog/shaft work depends on geometry and ray
coverage. Its default panel sequence also changes at about 17.14 timeline seconds, near
the larger late increase; timing coincidence is not proof. A fixed-scene control and
per-pass GPU timestamps are needed before attributing this to renderer accumulation,
thermal behavior, or a specific shader. No speculative performance patch was made.

## Limits and follow-up

At 60 fps the initial probes cover five and three seconds, and the extended probe covers
20 seconds of timeline content. They test
short sustained capture and resource ownership, not the full music envelope or extended
thermal behavior. A continuing long-take slowdown needs recent frame throughput and
stage timing from that take; a cumulative average can conceal it. The dialog now shows
total elapsed time and recent throughput from the last 32 completed output frames.
Preparation time is excluded from throughput, and throughput disappears during encoding
and saving rather than suggesting frames are still being rendered. The extended run localizes the increase to GPU rendering/readback waits; its underlying
cause remains unresolved.

Local raw artifacts:

- `/tmp/shaderloom-export-pipeline-probe.json`
- `/tmp/continuous-resonance-profile.json`
- `/tmp/continuous-resonance-4k-profile.json`
- `/tmp/continuous-resonance-4k-paused-previews.json`
- `/tmp/continuous-resonance-4k-1200-profile.json`

The actual-app harnesses are `/tmp/profile-continuous-resonance.mjs` and
`/tmp/profile-continuous-resonance-4k.mjs`. They use the isolated development server on
port 5198, mute Chromium, and cancel before saving.

The extended harness is `/tmp/profile-continuous-resonance-4k-1200.mjs`.
