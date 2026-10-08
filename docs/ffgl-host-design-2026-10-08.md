# Native FFGL host — design (VN85, 2026-10-08)

Loom's desktop build (Electron, Apple Silicon macOS) runs Resolume FFGL plugins (`.bundle`) as an
`ffgl` node. This note covers what the host does, why, and what it leaves for later. The parity and
cost study it feeds is [`ffgl-study-2026-10-08.md`](ffgl-study-2026-10-08.md).

## Pieces

| Piece | File | Role |
|---|---|---|
| Native addon | `src/devices/native/ffgl-host.mm` (built by `ffgl-build.mjs`) | dlopen, plugMain lifecycle, one CGL 4.1 core context per instance, IOSurface in and out, the plugin clock |
| Plugin folders | `src/desktop/ffgl-plugins.cjs` | `resolveFfglPlugins(folders)`: the ONE place a bundle is found (VN90 supplies the list) |
| Main adapter | `src/desktop/native-ffgl.cjs` | IPC (`list`, `describe`, `open`, `prepare`, `frame`, `status`, `close`), hidden capture window, shared-texture import back to the page |
| Preload | `src/desktop/preload.cjs` (`loomDesktop.ffgl`, only with `--loom-ffgl`) | the page's bridge |
| Page client | `src/devices/native-ffgl.ts` | presents the node's input copy, prepares a frame, receives the result |
| Tracker | `src/app/native-ffgl-sources.ts`, composed in `use-vision-bridge.ts` | per-frame writes, time, events, manifest probing, offline settle |
| Node | `src/nodes/definitions/ffgl.ts`, `ffgl-manifest.ts` | schema reflected from the stored table, compile |

## The frame

```
graph input ──copy pass──▶ ffgl node's sRGB scratch target (ffglInput)
     present (sizing "source", raw sRGB bytes) ──▶ OffscreenCanvas ──ImageBitmap──▶ capture window (inference.html)
     OSR paint (BGRA IOSurface) ──▶ main: ffgl-host.process()
          rect texture ◀─ CGLTexImageIOSurface2D(input)
          row-flip blit ─▶ GL_TEXTURE_2D (what a plugin samples)            hop 1
          FF_SET_PARAMETER… FF_SET_TIME (if declared) FF_SET_BEATINFO FF_PROCESS_OPENGL
          plugin renders into an FBO on an addon-owned output IOSurface    hop 2
          glFinish (the page's GPU reads it next)
     importSharedTexture ─▶ sendSharedTexture ─▶ page VideoFrame (bottom row first, flipY)
graph ◀──blit pass── external texture (ffglResult, rgba8unorm-srgb)
```

This is the person-mask native path's shape (`native-inference.cjs`), reused, not reinvented.

- **Orientation.** A Chromium capture is top row first; a plugin is an OpenGL program and must see
  its input bottom row first, as in Resolume. The input blit flips rows; the output surface is
  therefore bottom row first, Syphon's layout (VNB13), and `nativeMediaFrame("ffgl", …)` imports it
  with `flipY` (`BOTTOM_UP_TRANSPORTS` gained the `ffgl` origin).
- **Colour.** The input copy is `rgba8unorm-srgb`, whose presentation hands the raw bytes over
  (T1307), and the result returns as `rgba8unorm-srgb`: the plugin sees and writes display-encoded
  bytes, as every FFGL host expects.
- **Alpha.** The presentation surface is opaque, so **alpha is not carried into the plugin** (as
  with Syphon Out). Follow-up row filed. None of the reference effects depends on input alpha.
- **Threading.** Every GL and plugMain call runs on a libuv worker under one mutex; a context is
  current only for one job; Electron's main thread never blocks on GL.
- **Leases.** Two output surfaces per instance. A surface is leased to the page until the page's
  `VideoFrame` and import release it; a third frame with both leased is refused, never overwritten
  under a reader. Closing with a lease out keeps the surface alive until it is released.

## The plugin clock

FFGL passes host time through `FF_SET_TIME`, and the SDK stores it and nothing reads it: the
quickstart's `UpdateAudioAndTime()` takes `timeNow` from `std::chrono::high_resolution_clock`
(FFGLPlugin.cpp:113), and every drmbt effect forwards that to its shader. Every built bundle imports
`std::chrono::steady_clock::now`, `rand` and `std::random_device`.

So after dlopen the host **rewrites that one image's own symbol pointers** for those three
symbols (fishhook's technique: the bundle's `__got`/`__la_symbol_ptr` entries, found through its
indirect symbol table, nothing else in the process touched). Inside a plugMain call they answer:

- `steady_clock::now` → a fixed base + the instance's plugin clock;
- `rand`, `random_device::operator()` → a per-instance splitmix64 sequence from the open's seed.

Outside a plugMain call (a plugin's own thread) they answer what the originals would.
`LOOM_FFGL_CLOCK=wallclock` skips the rebind: the study's control arm, the binary exactly as it
runs in Resolume. When the rebind fails, the instance reports `clock: "wallclock"`.

drmbt's simulations and feedback effects integrate `dt` on a free clock (Vincent, 2026-10-08), so
the clock the host presents behaves like one, driven by the caller's time `t` with interval `i`:

| Step `d = t − t_prev` | Plugin clock |
|---|---|
| first frame after open, or `reset` (a render take restarting) | `max(0, t)` |
| `0 < d ≤ 8·i` (normal play, dropped frames included) | `+= d` |
| `d = 0` (the same frame cooked again) | unchanged — a re-cook is deterministic |
| `d < 0` (backward seek) or `d > 8·i` (forward jump) | `+= i` — one interval, never a negative or exploding `dt` |

So the frame after any seek is exactly the frame a normal one-interval step would give, which the
gate proves on glitch_mosher and LiquidWake: a 12-frame run with a backward seek, and one with a
+998 s jump, give the same bytes as a straight run, every frame.

The node feeds the clock the frame's **abs time** (`absTimeSecondsOf`), with `interval =
deltaSeconds`, and `reset` at frame 0 of a non-realtime take — so a live simulation keeps running
while the transport is paused, and an offline take starts clean.

`FF_SET_TIME` is sent **only to a plugin that declares `FF_CAP_SET_TIME`**, as Resolume does. The
SDK's `CFFGLPluginManager` defaults `m_timeSupported` to true, so every drmbt build declares it.
Arena's `hostTime` is not in seconds (measured: FigletText's Speed moves within 0.57 s in Arena at
a rate seconds cannot explain) — VN95 measures the unit.

**BPM** is sent through `FF_SET_BEATINFO` from the node's `bpm` parameter (no tempo is on
`FrameEvaluationInput`; bind it to the audio tempo claim). No drmbt effect reads BPM, by design:
Arena's per-parameter animation drives any parameter in sync, and cyclic animation is a Phase
parameter.

## The node

- `plugin` (compile-time string): the bundle NAME (`VignettePlus`), resolved by the desktop through
  the plugin folders. Portable across machines, and the key VN84's WASM manifest uses.
- `manifest` (compile-time string): the plugin's own table, as the host read it, stored WITH the
  document. `parametersFor` derives the schema from it synchronously and headless, so a machine
  without the plugin still opens the document and keeps every value. The tracker probes the plugin
  and writes a new table (graph.applyPatch, the runtime's invocation, as Mesh File In writes its
  facts) when the stored one does not describe it.
- `bpm` (number).
- The plugin's controls (`ffgl-manifest.ts`, the one normaliser, shared with the study harness), in
  the plugin's order: STANDARD/XPOS/YPOS numbers with the declared range, INTEGER whole numbers,
  BOOLEAN toggles, OPTION menus of element values, each HUE/SATURATION/BRIGHTNESS/ALPHA run as ONE
  display colour (the SDK's HSB→RGB), RGB runs likewise, TEXT strings, and EVENT pulses firing
  `runtime.ffglEvent { nodeIds: ["$node"], event: <parameter index> }` (an index, because an
  instance command's strings must be node addresses, §T1695b). A pulse raises the event for one
  frame, the host drops it to 0 the next, as Resolume does.
- **Phase parameters** are plain 0..1 numbers: drive them by expression (`fract(time * rate)`), a
  lane, or later BPM. Never smooth one: a slewed phase crosses the wrap the long way round. Anything
  in Loom that interpolates a parameter (a preset morph, a Lag) breaks a wrapping phase — a study
  finding, not fixed here.
- Requires `["desktop", "macos"]`; reproducibility `async-cached`, settled by export; side effects
  `none`.

## Limits, stated

- **One frame late, always (VN96).** The plugin processes frame N's input copy after frame N's
  blit has read the previous result, live and offline. The desktop gate asserts it so a fix is a
  deliberate test change. A two-phase frame (plugin before blit) is the fix.
- **Opaque input** (above).
- **In-process.** A plugin that crashes crashes Electron's main process. What is catchable is
  reported: a failed instantiate, a C++ exception out of plugMain, a GL error, a bad parameter
  index, a pulse on a non-event, a size mismatch. Process isolation (utilityProcess + mach-port
  IOSurface) is a follow-up row.
- **Effects only, one input.** A source plugin (FF_SOURCE, e.g. FigletText) runs with a transparent
  input; mixers (two inputs) are not wired.
- **Fixed size per instance.** A size change re-opens the instance (the tracker does this).

## Gates

| Gate | Command | What it proves |
|---|---|---|
| Native addon, real bundles | `tools/heavy.sh pnpm desktop:ffgl-test` | VignettePlus table; identity out == in, every byte; dark corners 0 and centre == in; the clock rebind; the free-clock rule (exact sequence; seek equivalence on glitch_mosher and LiquidWake); FigletText Phase wrap and SetTime; errors not crashes; leases |
| Harness, native backend | `tools/heavy.sh pnpm desktop:ffgl-study` | all 8 reference cases meet their claims and repeat byte for byte on fresh instances |
| Main adapter, preload, startup | `pnpm desktop:check` | IPC ownership, prepare-before-frame, input released only after the native job, bottom-up metadata, the `--loom-ffgl` gate |
| Node, tracker | `pnpm vitest run src/nodes/definitions/ffgl.test.ts src/app/native-ffgl-sources.test.ts` | reflected schema, compile shape, writes and events, offline settle |
| Whole desktop path | `LOOM_DESKTOP_FFGL_TEST=1 tools/heavy.sh pnpm desktop:test` | a document with an ffgl node, rendered in the real page, pixels read back |

Every gate was red-verified (see the commit messages). The desktop gate's result on 2026-10-08:
identity 0 differing components over 640x360, upright, dark corners exactly 0 and centre exact, and
the one-frame lag observed (the dark frame's corners carried the identity picture until it settled).

Two bugs the desktop gate found and the unit tests could not: the page held the result
`VideoFrame`, which held the shared-texture import, so main never freed the output surface and the
second frame deadlocked (the frame is now closed after upload, as native Vision's is); and an
instance command may carry only node addresses as strings (§T1695b), so an event is a parameter
index.
