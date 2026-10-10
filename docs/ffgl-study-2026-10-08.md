# FFGL in Loom: parity, cost and when to port — first pass (VN91, 2026-10-08)

This is the study VN91 asks for, filled in for the two paths that exist today: **(a) the Resolume
oracle** and **(b) Loom's native FFGL host** (VN85). The browser WASM host (VN84), a clean port to a
Loom component (VN86) and the GLSL/ISF code node (VN87) plug into the same harness when they land.
Host design: [`ffgl-host-design-2026-10-08.md`](ffgl-host-design-2026-10-08.md).

All numbers are from this machine (Apple Silicon, macOS 26), Arena 7.28.0, drmbt-custom-fx builds
of 2026-10-08 (installed copies hash-equal to the build for every plugin used).

## The harness

`src/desktop/testing/ffgl-study/`. A backend implements `FfglStudyBackend` (`types.ts`):
`available()`, `load(plugin, size)` → `{ manifest?, controls, loadMs, capabilities, render(run),
dispose }`. The harness owns everything else, so every path is measured the same way:

- **Inputs**: integer test cards, deliberately asymmetric (a white top-left block, ramps, an 8 px
  checker) so a flipped or mirrored path cannot pass.
- **Runs**: steps of `{ time, bpm, barPhase, params (by FFGL name, wire values 0..1), pulses }`.
- **Claims**: exact statements derived from each plugin's shader (`cases.ts`).
- **Determinism**: every case twice, on fresh instances, byte for byte.
- **Parity**: parameter maps (raw FFGL table where a host exposes it, otherwise the controls it
  presents, by name) and pixels (`pixel-compare.ts`'s `compareFrames`, a stated per-channel bound,
  over the captured regions only).
- **Cost**: 60 steady frames after 5 warm-up, at 1920x1080 and 3840x2160.
- **Report**: `report.json`, `report.md` and PNGs per frame.

```
node --import ./src/tooling/alias-hooks.ts src/desktop/testing/ffgl-study/cli.ts \
  [--backends native,resolume] [--cases id,…] [--size 1280x720] [--cost] [--out dir]
tools/heavy.sh pnpm desktop:ffgl-study      # the regression gate: native, all cases, twice
```

Backends (c)–(e) register in `cli.ts`'s `backendsFor` as `wasm`, `port`, `glsl`.

## The reference set

| Case | Plugin | Why it is in the set | Exact claims |
|---|---|---|---|
| vignette-identity | VignettePlus | stateless, single pass, no time | Size 1, Roundness 0, Ratio 1: every pixel is 0.4 inside the SDF, f = 1: out == in |
| vignette-dark | VignettePlus | same, at the other extreme | Size 0, Softness 0: corners (0,0,0,0), centre == in |
| vignette-default | VignettePlus | the frame a user sees on drop-in | parity only |
| grain-still | StylizedGrain | time-animated (`floor(time·Speed·48)`), plus an HSBA tint | Speed 0: t=1 == t=2 |
| grain-animated | StylizedGrain | the same, moving | frame 0 != frame 5 at 60 fps; fresh runs repeat |
| figlet-phase | FigletText | Phase-driven (Arena's Tunnel/Recolor pattern), a TEXT parameter, three HSBA quads, an FF_SOURCE | Phase 1 == Phase 0 (wrap); Phase 0.25 differs; no hidden state |
| mosher-sequence | glitch_mosher | multi-pass feedback (ping-pong FBOs, previous input and output), a Keyframe event | keyframe frame == its input; frame 11 carries history |
| toxic-palette | ToxicCRT | two HSBA quads, a sticky event (PaletteFlip), an option | at a fixed time: flip changes the frame; the next frame == the flipped one |

NeonSilhouette was considered for the Phase case and left out: it depends on a Vision matte, and
its sweep phase is internal, not a parameter.

## Findings

### F1. The plugins read the wall clock, so the host had to give them one

FFGL hands time over through `FF_SET_TIME`; the SDK stores it and the quickstart ignores it,
reading `std::chrono` instead (FFGLPlugin.cpp:113), and every drmbt effect animates from that. An
unmodified binary therefore cannot be told what time it is. The native host rewrites the plugin
image's own pointers for `steady_clock::now`, `rand` and `random_device` (design doc). Measured:

- with the rebind, the same host time gives the same bytes and different times differ
  (StylizedGrain), on every case, on fresh instances;
- without it (`LOOM_FFGL_CLOCK=wallclock`, the binary as Resolume runs it), two different host
  times give IDENTICAL bytes: the plugin follows its own clock, and no render is reproducible.

The clean fix belongs in the SDK (`UpdateAudioAndTime` preferring host time), in drmbt-custom-fx;
the rebind is how Loom runs the binaries that exist.

### F2. No plugin reads BPM, by design

None of the 55 effects reads `bpm` or `barPhase`. Arena's per-parameter animation (BPM Sync and
the rest) drives any parameter in sync, and cyclic animation is a Phase parameter. The host still
sends beat info; nothing should rely on it.

### F3. The clock must behave like Arena's free clock

Simulations and feedback effects integrate `dt`. The host's rule (monotonic; one interval across a
seek; fresh on a take reset) makes the frame after a seek byte-identical to a normal step, proven on
glitch_mosher and LiquidWake. Without it a backward seek and a far jump each change the output.

### F4. FF_SET_TIME: every drmbt build declares it, and Arena's unit is not seconds

`CFFGLPluginManager` defaults `m_timeSupported` to true, so every drmbt plugin answers
`FF_CAP_SET_TIME`. Live in Arena, FigletText's Speed (hostTime-driven) does move: at Speed 1 the
frame changed within 0.57 s; at Speed 0 and 0.1 it did not. The rate is far faster than seconds
can explain, consistent with milliseconds, and it appears to loop. Loom sends seconds, so a
hostTime-driven plugin runs much slower in Loom than in Arena. VN95 measures the unit with a phase
sweep.

### F5. Parameter maps: identical

| Plugin | Native vs Arena |
|---|---|
| VignettePlus | identical: labels, kinds, ranges (Morph 0..10), option counts |
| StylizedGrain | identical (the HSBA quad is one colour in both) |
| FigletText | identical: ranges -1..1, 1..16, 8..2048; 37 fonts, the text parameter |

Arena lists a clip's parameters alphabetically and cuts names to 16 characters, so the comparison
is by name, on the controls a host presents. Arena takes values in the plugin's declared range
(Figlet Speed -1..1), not the FFGL wire value (0..1): the oracle backend converts.

### F6. Pixels: exact where the maths allows; the residual is stated, with what is known of its cause

Oracle run at 3840x2160 (Arena's study comp "1920 empty", which is 3840x2160), nine native-pixel
crops of 200x112 per frame (corners, edge midpoints, centre: 604,800 components).

Two facts about Arena's path had to be measured first:

- **Arena re-encodes a still image on import, lossily** (8 px checker edges ring 200→167, values
  inside flat areas off by ~2: a block-compression signature). No plugin in Arena sees a still's
  exact bytes. The harness captures what Arena feeds the plugin (the effect bypassed) and re-runs
  native on exactly that.
- **Arena's composition capture shows the plugin's premultiplied output UN-premultiplied and
  opaque** (native 93,0,156 at alpha 195 reads 122,0,203 = 93·255/195). Native is compared as
  rgb·255/a; where native alpha is 0 the colour is undefined and is excluded.

| Case | Compared | Exact | ≤ 1/255 | Mean | Max | Verdict |
|---|---|---|---|---|---|---|
| vignette-identity | 604,800 | **100 %** | 100 % | 0 | 0 | **EXACT** |
| vignette-default | 201,600 (134,400 px a = 0 excluded) | 78.4 % | 93.7 % | 0.32 | 10 | bounded; residual at the soft edge |
| vignette-dark | 25,008 (193,264 px a = 0 excluded) | 66.9 % | 76.0 % | 1.62 | 85 | residual where alpha is tiny |
| figlet-phase | 56,016 per frame | 56.5 % | 91.9 % | 0.79 | 38 | bounded; glyph edges and colour |
| grain-still | 604,800 | 11.4 % | 21.3 % | 8.03 | 118 | **DIFFERS** |

Bound stated for a comparison against Arena: **one 8-bit quantum where alpha is 255; 1 + 128/a
where alpha a is lower**, because native's premultiplied value is rounded to 8 bits before the
division Arena's capture effectively performs. vignette-identity meets it everywhere. The soft
vignette edge meets it on 93.7 % (default) and 78 % (dark) of components; the excess is not
explained by rounding alone, and **its cause is not established** (candidates: Arena running
effects in a 16-bit float pipeline, its own un-premultiply, sampling at the soft edge).

grain-still diverges well beyond any rounding bound. Ruled out by measurement: colour
quantisation (Arena stores the HSBA Tint as 8-bit RGB `#e60da6`, exactly the SDK's HSB→RGB of the
default quad rounded to bytes; re-running native with that quad changes nothing). Open candidates:
precision of the grain hash inputs in Arena's pipeline, or a parameter Arena initialises
differently. Next step: run StylizedGrain with Grain 0 in both hosts (isolating the tint/crush from
the hash).

In both hosts, Figlet's Phase wrap and Speed-stopped stillness hold: Arena's frames at Phase 0, 1
and 0 again are identical to each other, as native's are.

### F7. Cost (native, this machine)

60 steady frames after warm-up. CPU is the host-side wall time per frame including the row-flip
blit, the plugin and `glFinish`; GPU is `GL_TIME_ELAPSED`, which Apple's OpenGL-on-Metal reports
as 0 for a batched frame more often than not — **use the CPU figure as the cost**.

| Plugin | 1080p CPU median / p95 ms | 4K CPU median / p95 ms | 4K GPU median ms |
|---|---|---|---|
| VignettePlus | 0.83 / 1.89 | 1.52 / 3.02 | 0.11 |
| StylizedGrain | 0.66 / 1.79 | 1.80 / 3.61 | 0.28 |
| FigletText | 0.75 / 2.00 | 1.59 / 3.89 | 0.16 |
| glitch_mosher | 1.23 / 4.16 | 3.18 / 6.07 | 1.71 |
| ToxicCRT | 0.78 / 2.86 | 1.73 / 4.14 | 0.35 |

Load: probe (dlopen + FF_INITIALISE_V2 + table) ~80 ms the first time; instantiate ~4–10 ms; the
first frame pays ~100 ms of GL shader compile. Process max RSS after all cost runs: 724 MiB (the
whole harness process, five plugins at 4K).

Hops per frame on the native path: (1) the page's input copy to an IOSurface through the
offscreen capture window, (2) the row-flip blit into a GL_TEXTURE_2D, (3) the plugin into the
output IOSurface, (4) the shared-texture import back into WebGPU. The harness measures (2)+(3); the
desktop gate exercises all four, and they are lossless: an ffgl node running VignettePlus at
identity settings returns its input with **0 differing components** over a 640x360 frame, through
the real page, compiler, backend, capture window, native host and import
(`LOOM_DESKTOP_FFGL_TEST=1 tools/heavy.sh pnpm desktop:test`).

### F8. Limits of the native path

- **One frame late (VN96)**, live and offline — the plugin processes frame N after frame N's blit
  read the previous result. Asserted by the desktop gate.
- **No input alpha**: the capture surface is opaque (as Syphon Out). None of the reference effects
  needs input alpha; VignettePlus and FigletText PRODUCE alpha, which survives.
- **In-process**: a crashing plugin crashes Electron's main process (isolation is a follow-up row).
- **Phase parameters must not be smoothed** anywhere in Loom (a preset morph or a Lag crosses the
  wrap the long way round). Not fixed here.

## When to run the FFGL binary, and when to port (first pass)

What (a) vs (b) shows so far:

- **Run the binary (native host)** when the effect is stateless or phase-driven and you need it
  now, as-is, with its presets and its exact maths: VignettePlus matched Arena exactly; Phase-driven
  effects compare exactly with Speed stopped. Cost is ~1–3 ms a frame at 4K for these effects. You
  accept: desktop-only, one frame of latency, opaque input, a crash domain shared with the app, and
  a clock Loom has to impose (F1).
- **Port** (VN86) when the effect must run in the browser, must sit inside a component's published
  parameters, must take alpha in, must not lag a frame, or must be inspectable and versioned with
  the document. A port also fixes F1 by construction (Loom's own time) and removes the IOSurface
  hops.
- **Not decided yet**: noise and grain effects (F6's StylizedGrain divergence) — parity with Arena
  is not established for them on either path until its cause is found. VN84's WASM host (WebGL2,
  no rebind possible) and VN86's port each get compared here against (a) and (b) when they land.

## Re-running the Resolume oracle

Opt-in only: it needs Arena, and it never runs in the default suite.

1. In Arena, open an empty composition at the size you will compare (the study used
   "1920 empty", which is 3840x2160). The backend refuses to write into any other composition
   (`LOOM_FFGL_ORACLE_COMPOSITION`, default "1920 empty"). It never saves, opens or creates one.
2. The plugins must be installed in `~/Documents/Resolume Arena/Extra Effects/` (hash-check them
   against the build); Arena scans at launch only.
3. Run:
   ```
   LOOM_FFGL_ORACLE=1 tools/heavy.sh node --import ./src/tooling/alias-hooks.ts \
     src/desktop/testing/ffgl-study/cli.ts --backends native,resolume \
     --cases vignette-identity,vignette-dark,vignette-default,grain-still,figlet-phase \
     --size 3840x2160 --out .cache/ffgl-study/oracle
   ```
   Only clock-free cases are compared against Arena (it runs its own clock). The backend drives
   Arena through its own MCP server over stdio, layer 1 column 1, and clears the clip afterwards.
4. Put Arena back the way you found it (the study session saved the show as
   `TINASHE POPSTAR 2026 v1_ffgl-study_20261008-1730.avc` before switching; the original file was
   never written).
