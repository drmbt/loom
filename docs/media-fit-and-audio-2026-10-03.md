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

Picture and sound share the same HTMLVideoElement, transport runner, playhead, speed, cue and trim. Native mute/volume controls change speaker monitoring without adding an AudioContext or another decoder. Rejected playback reports explicitly; one owned activation listener retries from a user gesture instead of retrying every frame. Pause, held/reverse/cued playback, node retirement and unmount clear playback ownership/listeners. Offline frames are silent. Export takes a nested-safe monitor-mute lease, including exports whose evaluation mode is realtime.

This change adds speaker playback. It does not add a movie audio-analysis graph output or soundtrack muxing to exported video.

## Audio stutter diagnosis and fix

Real Chrome reproduced 17 destructive `currentTime` writes in three seconds, at both movie modes. A conventional 64×64 H.264/AAC fixture reproduced the same problem, with and without `captureStream` and even while muted. Detached native playback made zero writes and advanced normally after initial audio-output buffering. The project timeline advanced 180 frames in three seconds at 60 FPS, so changing project FPS could not cure this failure.

The 150 ms drift policy treated ordinary decoder startup delay as a reason to seek. Each seek restarted audio buffering, recreated about 150 ms of lag, and triggered the next seek. This was an unstable correction loop rather than an expensive shader or audio-analysis task.

The shared browser media adapter now distinguishes continuous playback from deliberate transport discontinuities. In realtime Free Run the playing element is the clock (T1542b): the playhead adopts `currentTime` and the element is left at exactly `playbackRate = speed`, with no seeks. Under Locked to Timeline the frame stays master (T1549b, option (a)): no correction while the drift is within one delivered frame; beyond that the rate moves in whole 1% steps, at most ±5%, written only when the step changes (a few writes a second at most, never one per frame); and a drift past 0.25 s gets exactly one seek, not repeated while the decoder re-buffers after it. First alignment, cues (including pulses inside the old tolerance), scrubs, laps, trim edits, speed edits under the lock, mode boundaries and held/reverse playback retain exact positioning. A positive speed change in Free Run is a `playbackRate` write and the position integrates on from where it is (SPEC B187, fixed). Hold Last stops at its out point. Movie and Audio File In use the same policy. Native audio-output startup latency remains; under the lock a startup lag over 0.25 s now costs one seek.

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
