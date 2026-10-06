# Media fit and movie audio — 2026-10-03

## Re-export

Original: `/Users/flo/Downloads/v2-edit.mp4`, 5184×2880 H.264, 30 fps, AAC audio, 178 MB. Smaller copy: `scratchpad/v2-edit-1920.mp4`, 1920×1066 H.264, 30 fps, 34 MB. AAC copied without re-encoding. Both video streams retain 5,522 frames, 184.066667 seconds, and a 9:5 display aspect ratio. Original untouched.

```bash
ffmpeg -hide_banner -nostdin -n -i /Users/flo/Downloads/v2-edit.mp4 \
  -map 0:v:0 -map '0:a?' -vf 'scale=1920:-2:flags=lanczos' \
  -c:v libx264 -preset fast -crf 20 -threads 2 -c:a copy \
  -movflags +faststart scratchpad/v2-edit-1920.mp4
```

## Cropping cause and fix

The media hook forced native source dimensions into the node output override. The compiler clamped that output to the project's maximum resolution, then allocated the external source texture at the same smaller size. `copyExternalImageToTexture` copied that smaller rectangle from origin zero. The media shader correctly sampled the texture, but the rest of the source had already been discarded. Raising the output resolution was the only way to see the whole image.

The backend now separates **decoded source extent** from **output extent**. Browser image/video/canvas textures use their intrinsic dimensions. Size changes replace and rebind source storage outside the frame guard, evict old bindings, retire the old texture, reset the upload cursor, and update physical memory accounting. Unchanged dimensions reuse storage and bindings. Byte producers retain their authored plan extent. A source beyond the device's physical texture limit emits an explicit diagnostic and is not partially copied.

Movie File In defaults to project-sized output and no longer overwrites Common when a video or still loads. Screen In also leaves Common unchanged. A Webcam retains its granted-size default when no override exists; explicit Common choices take precedence. The camera's automatic resolution update uses `node.setResolution`, including flattened component ids.

Movie File In, Webcam and Screen In expose **Image fit** in Common, separately from output **Resolution**:

- **Fit**: whole image, aspect preserved, transparent margins when necessary. Default.
- **Fill**: fill the output, crop centrally.
- **Stretch**: fill the output, change aspect.

Existing Text and native byte-source blits retain their shader behavior. There is no new CPU rasterization/readback, duplicate decoder, or scaling animation loop. Smaller output targets reduce downstream processing; the full-resolution source still costs decode and upload work. Re-exporting is useful when that source cost is too large.

## Movie audio

TouchDesigner reads a movie soundtrack with an Audio Movie CHOP referencing Movie File In TOP's transport, then routes it to audio output. Its audio controls include Play and Volume. Sources: [Audio Movie CHOP](https://docs.derivative.ca/Audio_Movie_CHOP), [Creating Audio with CHOPs](https://docs.derivative.ca/Creating_Audio_with_CHOPs).

Loom's movie browser adapter hard-muted every video. Movie File In now exposes **Audio** and **Volume** in its Audio parameter group. Enable Audio to hear the embedded soundtrack. Default off preserves existing silent projects; still-image controls explain that there is no soundtrack.

Picture and sound share the same HTMLVideoElement, transport runner, playhead, speed, cue and trim. Rejected playback reports explicitly; one owned activation listener retries from a user gesture instead of retrying every frame. Pause, held/reverse/cued playback, node retirement and unmount clear playback ownership/listeners. Offline frames are silent. Export takes a nested-safe monitor-mute lease, including exports whose evaluation mode is realtime.

This change adds speaker playback. It does not add a movie audio-analysis graph output or soundtrack muxing to exported video.

### Routing through the app's AudioContext (T1548b, 2026-10-04)

The first version used the element's own `muted` and `volume` and no AudioContext. That is reversed (owner's ruling, 2026-10-04). Movie sound now goes `createMediaElementSource(element)` → a `GainNode` per element → the destination of the app's **one** AudioContext (`src/app/app-audio-context.ts`). Audio File In / Audio In capture uses the same context. It is created on first use and never closed: a routed element belongs to its context for life, so a closed context would silence it for good. A capture that ends disconnects its own nodes and tells its analysis worklet to stop. `createMediaElementSource` runs once per element (a `WeakMap` keeps the route), and every movie open makes fresh elements. When there is no Web Audio, the element plays through its own output as before.

- **Volume and mute are the gain.** Chrome ignores `element.volume` on a routed element. The playing element's gain is the Volume while it should sound; otherwise it is 0, which covers Audio off, a black extend, a pause, a cue, offline and fixed-step frames, and an export lease. A waiting loop partner's gain is 0. The element's own `volume` stays 1.
- **Gesture rule.** A context created before the page's first user gesture starts suspended. The first pointer, key or touch resumes it, on that event's stack. An unmuted routed element nearly stops its clock while its context is suspended (measured: 0.002 s of media in 1 s of wall; muted, 0.978 s). So until the context runs, every routed element is held `muted`, and the free-run playhead runs on the frame clock without adopting the element (§V1027 is suspended, not stalled). Once the context runs, the elements are unmuted (the gain decides what is heard) and the next frame adopts the element's position. At that frame the playhead can step back by the element's start-up lag.
- **Whole-file Loop with Audio off** (in point 0, out point the duration, realtime free run): native `element.loop = true` on one decoder. No partner is opened and nothing is written at the lap. The wrap shows as `currentTime` running backwards, and the playback reports one extra window on that frame, so the runner counts it as a lap and not as a scrub.
- **Whole-file Loop with Audio on** (T1560b, owner's ruling 2026-10-04): the two-element hand-over, as for a trimmed window, because the native loop's 16 ms silence and ~16–20 ms of extra time per wrap can be heard. One difference: an element stops at the end of its file, while a trimmed one plays on past its out point. A lap taken on the next frame was therefore silence until that frame (up to 20 ms, measured). So once the playing element is within 0.25 s of the end, each frame arms a timer from the element's own `currentTime`. The timer starts the partner `END_LEAD_MS` (3 ms) before the end. The finished element plays out to the end of the file, and the first frame after that completes the hand-over. Nothing is carried, because the partner's own time is then the position. Until the partner is open and primed, the element keeps looping natively, so turning Audio on never costs a seek.
- **Toggling Audio on a playing whole-file loop.** On: the partner opens. The playing element keeps `loop = true` until the partner waits primed on 0, then gets `loop = false` (an attribute write, not a seek), and the next end of the file hands over. Off: the playing element (either one, depending on the lap) gets `loop = true` and its gain goes to 0. The one waiting is released: paused, its route disconnected, and emptied (`src` removed, `load()`), so its decoder goes at once (`networkState` 0, measured). Turning Audio on again opens a new partner. If Audio goes off in the frame between the end-of-file timer and the hand-over, the partner is already playing from 0, so it stays the playing element (and loops itself), and the finished element is released instead of being looped again, which would restart it from 0. Nothing is written on the playing element at either switch, nothing restarts, and no element is left muted.
- **Trimmed Loop** (realtime free run): the two-element hand-over. A second element on the same file opens on the first trimmed Loop frame, is routed with gain 0, and waits paused on the in point. At the lap it plays, the finished one pauses and goes back to the in point, and the picture source follows (`createVideoMediaSource().show`). The overshoot past each out point is carried, so N laps last N windows to within a frame. Unchanged by T1560b. A trimmed Loop that becomes a silent whole file releases its partner, like the Audio-off switch above.
- Under the timeline lock, offline and fixed-step nothing changes: a lap is an exact seek there (§V436, §V662), and the element's own loop is off.

Measured in headed Chromium 151 with `--mute-audio`, through the product's routing, with the audio tapped after the product's gain nodes in 5.33 ms blocks (`scratchpad/t1548/measure.spec.ts` in the T1548b worktree):

| Clip | Trimmed 0.5 s loop: lap period | Audio gap at the lap | Whole-file native loop |
| --- | --- | --- | --- |
| 320×180 H.264/AAC, 4.000 s sine | 480.8–520.1 ms, mean 500.0 ms (10 laps) | none | 4020 ms per lap, one 16 ms silent run per wrap |
| 1920×1080 H.264/AAC, 4.000 s sine | 480.2–519.8 ms, mean 502.0 ms | none | 4020 ms per lap, one 16 ms silent run per wrap |
| `v2-edit-1920.mp4` (music) | 498.9–501.1 ms, mean 500.0 ms | none | not reached (184 s file) |
| still-pixels WebM fixture (headed spec) | 499–501 ms | not measured | n/a |

Each lap is taken on a delivered frame, so one lap can run a frame long or short; the carried remainder keeps the mean on the window. Before the routing, the same hand-over measured 540–743 ms laps and the seek 578–822 ms. The native loop is not gapless: each wrap costs about 20 ms of extra time and a 16 ms silent run, and the source file has no silence at either end. That is why T1560b moves whole-file loops with Audio on to the hand-over (below). With the context suspended through `context.suspend()`, both elements went muted, the playing one kept time, and hand-overs continued. After `resume()` the elements were unmuted, laps were 491–509 ms and no gap was detected. Every measurement here ran with `--mute-audio`, so nothing was measured at the speakers of a real output device.

#### Whole-file loops with Audio on (T1560b, 2026-10-04)

These were measured the same way, in headed Chromium 151 with `--mute-audio` and the product's routing (`scratchpad/t1560/measure.spec.ts` in the T1560b worktree). The clips were generated with ffmpeg: H.264/AAC whose sound is a 440 Hz sine at 0.8 for the first 100 ms and 0.3 after, so each lap's start can be read from the audio itself. The decoded files have no silence anywhere. The tap ran at 44.1 kHz in 256-sample (5.8 ms) blocks. "Audio lap" is the time between two lap-start markers, located to the sample. "Near-silent runs" counts runs of at least 0.25 ms of samples under 0.002, found at sample level; a 5.8 ms block detector cannot see them.

| Clip | Audio lap (9 laps) | Silent 5.8 ms blocks | Near-silent runs | Writes on a playing element |
| --- | --- | --- | --- | --- |
| 320×180, 2.000 s | 1997.3–2002.7 ms | none | 5 of 2.8–3.1 ms | none |
| 320×180, 4.000 s | 3997.3–4000.2 ms | none | none | none |
| 1920×1080, 4.000 s | 3997.7–4000.6 ms | none | 5 of 0.7 ms | none |
| still-pixels WebM fixture (headed spec), 3.9595 s | 3957.4–3957.7 ms (from the `play` events) | not measured | not measured | none |

The baselines below were measured on the 4.000 s clip with the same harness:

- **Native `loop = true` with Audio on** (the T1548b behaviour): every lap was 13.3–16.0 ms long, with a 13.3–16.0 ms silence at every wrap.
- **The hand-over with no end-of-file timer** (the lap waits for the next frame): laps were 0.9–20.4 ms long, with silences of up to 20.4 ms.
- **End-of-file timer, no lead (0 ms; 1.5 ms behaved the same):** laps were 1.0–4.3 ms long, with two or three near-silent runs of 1–4.3 ms per lap. The timer fires late, and a routed `play()` takes a few milliseconds to sound.
- **3 ms lead (shipped):** laps were within -5.4 to +1.9 ms of the file across the three clips, with no silent block.

For comparison, the trimmed hand-over (T1548b, unchanged) showed two near-silent runs of 0.7–2.9 ms per lap in the same run, so the whole-file join is now at least as clean as the trimmed one. In one 4 s run the trimmed hand-over also showed one 8.7 ms run. Toggling Audio worked both ways on all three clips: Audio off released either element (the original or the partner, depending on the lap) and left one element looping natively, with no writes. Audio on again opened a third element, which took the next lap. With Audio off the movie runs on one decoder: one `<video>` is created, and after a release the released one reports `networkState` 0 with no `src`. Nothing was measured at the speakers of a real output device.

The fake-element gates live in `src/app/media-playback.test.ts` ("§T1560b"). They cover a 1.005 s file whose end falls off the 60, 45 and 30 Hz frame grids, with the routed `play()`'s start-up latency modelled. They assert five hand-overs in five laps, laps equal to the files within one frame, no silent slice of time, every finished element played to the end of the file, and nothing written on a playing element. Each assertion was red-verified against four mutations: no end-of-file timer, the remainder carried twice, the lap taken before the finished element reaches its end, and a started partner stopped on a continuous frame. `src/app/use-media-sources.test.tsx` gates the hook: Audio on opens the partner, Audio off releases it, and Audio on again opens a new one.

## Audio stutter diagnosis and fix

Real Chrome reproduced 17 destructive `currentTime` writes in three seconds, at both movie modes. A conventional 64×64 H.264/AAC fixture reproduced the same problem, with and without `captureStream` and even while muted. Detached native playback made zero writes and advanced normally after initial audio-output buffering. The project timeline advanced 180 frames in three seconds at 60 FPS, so changing project FPS could not cure this failure.

The 150 ms drift policy treated ordinary decoder startup delay as a reason to seek. Each seek restarted audio buffering, recreated about 150 ms of lag, and triggered the next seek. This was an unstable correction loop rather than an expensive shader or audio-analysis task.

The shared browser media adapter now distinguishes continuous playback from deliberate transport discontinuities. In realtime Free Run the playing element is the clock (T1542b): the playhead adopts `currentTime` and the element is left at exactly `playbackRate = speed`, with no seeks. Under Locked to Timeline the frame stays master (T1549b, option (a)): no correction while the drift is within one delivered frame; beyond that the rate moves in whole 1% steps, at most ±5%, written only when the step changes (a few writes a second at most, never one per frame); and a drift past 0.25 s gets exactly one seek, but only while that resync is armed (B242). Every seek, cue, lap, first frame, and every frame on which the element did not play (a transport resume, blocked autoplay, a start-up freeze, a decoder stall) disarms it; it re-arms once the element has played 0.5 s of media and is back within 0.125 s. So the lag a decoder builds while it starts is closed by the rate steps, not chased with seeks that restart it. A lag over 1 s once the element plays (for example after autoplay was blocked) gets one seek whether armed or not. First alignment, cues (including pulses inside the old tolerance), scrubs, laps, trim edits, speed edits under the lock, mode boundaries and held/reverse playback retain exact positioning. A positive speed change in Free Run is a `playbackRate` write and the position integrates on from where it is (SPEC B187, fixed). Hold Last stops at its out point. Movie and Audio File In use the same policy. Native audio-output startup latency remains. In Chrome it is a ~0.2 s freeze after every `play()` and every seek (longer under load), with `seeking` false and `readyState` 4 throughout; under the lock it is closed by rate steps and costs no seek (B242).

The final four-case Chrome proof (measured against the earlier ±5% proportional policy, before T1542b and T1549b) measured **zero normal seeks** in three seconds for Free Run and Timeline at both 30 and 60 FPS, using the same native video/audio decoder. Native media advanced 3.137/2.907/3.136/2.904 seconds respectively; 301 samples per case, rates stayed within 0.95–1.05 and native pitch preservation stayed enabled. A held cue made zero redundant writes over 300 ms; a cue pulse landed explicitly, and the trimmed loop wrapped three times to its in point. Pause/resume, volume and deletion cleanup passed. Baseline/control and full before/after traces are saved under ignored `scratchpad/movie-audio-2026-10-03/`.

## Verification and limits

Backend tests reproduce full 5184×2880 source upload into a smaller output, source replacement/resize, unchanged-frame reuse, output recompilation, realtime frame boundaries, physical memory accounting and device-limit errors. Three bounded 16×16 GPU frames assert actual Fit/Fill/Stretch pixels, including both outer source edges and transparent Fit margins; all three pass. Each device is disposed immediately.

Inspector tests exercise Common placement, manifest defaults/options, ordinary Resolution controls, local ids inside components and undo. Hook tests cover capture and playback ownership rather than inspecting implementation text. Screen capture browser proof uses real Chrome video streams with a stubbed native chooser; native chooser permissions remain a manual check.

Final validation:

- Complete CPU suite, excluding `*.gpu.test.ts`: **712 files, 11,586 passed**, 3 existing skips and 1 todo; clean exit. Required local loopback access was enabled. An older movie test double was updated to expose the native mute/volume fields after the first broad run caught two unhandled fixture errors.
- Mandatory gates: **51 files, 3,307 passed**.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`: passed. Lint retains five unrelated warnings; build retains its existing large-chunk warning.
- Movie transport/audio regressions: **190 passed**; final fixture/playback/hook subset **90 passed** with no unhandled errors.
- Chrome: both Screen In tests passed; final movie test passed all four normal-clock cases plus cue, trim-loop and cleanup checks. The smaller-output PNG pixel check also passed.
- Native GPU: three bounded Fit/Fill/Stretch pixel tests passed; devices disposed immediately. No full native GPU sweep was launched.

Tests mute speakers. They verify a real decoded audio track and native clock progression, rather than room audibility. Screen capture uses real tracks with a stubbed picker; the native chooser still needs a manual permission check. All owned browsers and test servers were closed.
