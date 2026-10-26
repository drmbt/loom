# loom-previz-host (VN118)

A standalone executable that renders a Loom project on the GPU for the After Effects effect
`LoomStagePreviz.plugin` (VN119). It renders with Dawn through `vgpu/node`. The contract is
PROTOCOL.md v1 (`drmbt-custom-fx-loom-ae/experiments/loom-ae/PROTOCOL.md`).

For each frame, the effect sends:
- the DS and Sides layer pixels, through POSIX shared memory;
- every parameter value;
- the comp time.

The host renders that frame of the project exactly and writes it back as RGBA16F.

The project is `projects/stage-previz/stage-previz-13.loom.json`. Spike B's report
(VN117, `loom-previz-trim/scratchpad/ae-spike-b-2026-10-13.md`) is the design this builds on.

## Layout

| path | what |
|---|---|
| `src/host.ts` | the process: CLI, Unix socket (NDJSON), one serial GPU queue, lifetime |
| `src/renderer.ts` | the Loom half: load, GLB meshes, one GPU program per output size, per-frame values, readback |
| `src/shm.ts` | the shared-memory transport, isolated so it can switch |
| `src/png.ts` | a PNG decoder on Node's zlib for still pictures (VN121): 8-bit RGB/RGBA, non-interlaced |
| `native/loom_shm.c` | `loom-shm.node`: `shm_open` + `mmap` as an N-API addon of about 90 lines (Node has neither) |
| `manifest/build-package.ts` | writes `package/` (manifest, project copy, media) from a `.loom.json` |
| `package/manifest.json` | the -13 manifest, committed (the effect reads it at PARAMS_SETUP) |
| `test-client/client.ts` | plays the effect's side and checks the result (see below) |
| `sea/build.sh` | esbuild bundle, Node SEA, ad-hoc signing |
| `tsconfig.json` | `pnpm exec tsc --noEmit -p experiments/ae-host/tsconfig.json` |

These are gitignored: `.cache/` (Node 24, postject), `dist/` (the build), `out/` (test PNGs),
`package/project.loom.json` and `package/media/`.

## Build

From the repo root.

1. Get Node 24 LTS, the official build. Check the tarball against nodejs.org's own `SHASUMS256.txt`:
   ```bash
   mkdir -p experiments/ae-host/.cache/node-dl && cd experiments/ae-host/.cache/node-dl
   curl -fsSLO https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
   curl -fsSLO https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz
   shasum -a 256 -c <(grep " node-v24.21.0-darwin-arm64.tar.gz$" SHASUMS256.txt)
   mkdir -p ../node24 && tar -xzf node-v24.21.0-darwin-arm64.tar.gz -C ../node24 --strip-components=1
   ../node24/bin/npm install --prefix ../tools postject@1.0.0-alpha.6
   ```
2. Build the package and the executable:
   ```bash
   tools/heavy.sh experiments/ae-host/sea/build.sh
   ```
   The build takes about 4 s. Output goes to `experiments/ae-host/dist/`:

   | file | size | notes |
   |---|---|---|
   | `loom-previz-host` | 118 MB | Node 24.21.0 plus the 1.6 MB bundle |
   | `dawn.node` | 8.9 MB | thinned to arm64 |
   | `loom-shm.node` | 68 KB | |
   | `package/` | 3.0 MB | includes the 44 KB FX map |

   The total is about 130 MB on disk.

To build only the package (for example after the project changes):

```bash
node experiments/ae-host/manifest/build-package.ts [--project <.loom.json>] [--media public/media] [--out <dir>]
```

## Run

```
loom-previz-host --package <dir> --socket <path> --shm-prefix /loomae.<pid>.
```

- To run without building the executable, use `node --import ./src/tooling/alias-hooks.ts experiments/ae-host/src/host.ts …` from the repo root.
- `dawn.node` and `loom-shm.node` are loaded from beside the executable. `VGPU_DAWN_BINARY` and `LOOM_SHM_ADDON` override them.
- `LOOM_HOST_SIZE_CACHE` sets how many output sizes keep a live GPU program (default 2). Each size is its own Dawn device of roughly 620 MB.
- Log lines go to stderr and are also sent to clients as `{"type":"log"}`.

## Test

```bash
tools/heavy.sh node experiments/ae-host/test-client/client.ts --frames 60                      # dev host
tools/heavy.sh node experiments/ae-host/test-client/client.ts --host <dir>/loom-previz-host    # the SEA
```

The client creates the shm slots, starts the host, connects, and runs these checks. It writes PNGs to `out/` and a summary to `out/results.json`.

- **(a) The DS layer appears on the drape.** The client renders once with a solid red DS and once with a solid green DS.
  - 798,786 px (38.5%) change, all in the drape and stage region (x 249..1919, y 222..780).
  - In that region, the mean R−G is +0.064 for the red render and −0.291 for the green render.
  - See `a-ds-red.png` and `a-ds-green.png`.
- **(b) Parameters change pixels.**
  - `slider_orbit` −3 → 30 changes 69.5% of the pixels.
  - `toggle_talent` off changes 38,837 px, on the stand-ins.
  - Returning to the defaults gives a byte-identical frame.
- **(c) A cut input renders differently.**
  - With no DS, 774,275 px differ, and the DS region's mean luminance drops from 0.271 to 0.192.
  - With no Sides, 593,839 px differ.
- **(d) Random access.** Frames at 1, 5, 20 and 33.3 s, with frame-dependent inputs, are rendered in order and then in the order 33.3, 1, 20, 5. All 4 pairs are byte-identical, and the four frames differ from each other.
- **(e) Resize.** The client requests 960×540 (the DS sent at 960×540 is resampled) and then 1920×1080 again. The first 960×540 frame takes 160–170 ms, because it includes building that size's program.
- **(f) The FX pixel map (VN121).** The client writes two package copies, one with the real PNG and one with an opaque black PNG of the same size (what the map rendered as before), and renders both with `stageFeeds.sourceFX` = 2 (the map) and LEDs and strobes at 1. 21,129 px differ, in x 211..1695, y 314..862 (the pixel lines on the drape and riser and the deck strobes), and the mean luminance there is 0.471 with the map against 0.340 without. See `f-fxmap.png` and `f-fxmap-black.png`. With still registration disabled the check fails: 0 px differ.
- **(g) Popups and dotted ids (VN122).**
  - The manifest has `stageFeeds.sourceFX` and `slider_shot` as popups, LEDs and strobes defaulting to 0, no `slider_source`, and `defaultLayer` 1 on both inputs.
  - With LEDs and strobes at 1, `stageFeeds.sourceFX` 1 (test pattern) → 2 (pixel map) changes 21,090 px in x 211..1695, y 314..862 (the pixel lines and strobes). See `g-fx-test.png` and `g-fx-map.png`.
  - At the manifest defaults (LEDs and strobes 0) the same change alters 0 px: the FX source lights nothing. See `g-leds-off.png`.
  - `slider_shot` 4 (wide) → 0 (FOH) changes every pixel. See `g-shot-foh.png`.
  - With the dotted-id write disabled, the sourceFX check and (f) fail with 0 px differing.
- **(h) Source pinned to live (VN122).** A package copy whose project is saved with Source = 1 (test) on both `slider_source` and the instance's `source` renders byte-identical to the shipped package. With the pin removed it differs.
- **Lifetime.** The host exits 0 when the client disconnects. It also exits 0 when stdin closes, which was checked separately.

These checks were red before the output-node fix. While the host read back the plan's first output (a black solid), every check (a)–(d) failed.

## Measured (Apple M5 Max, macOS 26.6, 2026-10-13)

| | dev host (node 26) | SEA (copied to a temp dir outside the repo) |
|---|---|---|
| spawn → `hello` (GPU init, compile, GLB, 1080p program) | 0.5 s warm | 1.7 s, and 3.6 s on the very first launch of a fresh binary |
| first frame | 59 ms host | 56 ms host |
| round trip at 1920×1080, 60 frames, both layers re-uploaded every frame | median 22.0 ms, p95 23.8 ms (45 fps) | median 23.1 ms, p95 27.0 ms (43 fps) |
| output | | byte-identical to the dev host's PNGs, all 9 |

The round trip is client write → socket → host render → readback → copy into the output slot → reply. It does not include the effect's ARGB conversions.

## How the host maps the protocol to Loom

- **Frame.** `round(time × fps)`, clamped at 0, evaluated exactly. The transport is a fixed frame with Δ = 1/fps. Every frame is a pure function of time and parameters (-13 has no feedback), so request order does not matter.
- **Params.** An id is a node name or `<node>.<parameter>` (VN122). The node part matches a node's name, else its id: `stageFeeds` is the id of the instance named `stagefeeds1`.
  - For a node name, the host writes `value` (slider) or `on` (toggle, ≥ 0.5) into the flattened graph.
  - For `<node>.<parameter>`, the host writes that parameter. A component instance is inlined away by flattening, so its published parameter is written to every internal parameter whose published origin is that instance and key (`stageFeeds.sourceFX` → `stageFeeds/feedFX.index`).
  - A popup's value is the chosen option's number and is written like a slider's.
  - **Pinned (VN122).** `stageFeeds.source` is always 0 (live). The AE layers are the source, whatever the project was saved with or the effect sends. The base program is compiled with the pin in place, so the layer feeds are always in it. It then runs the value graph and a values-only compile, and pushes the uniforms. If a value ever changes the plan's structure, the program is recompiled for that frame.
- **Inputs.**
  - Each input registers as `media:stageFeeds/dsFeed` or `media:stageFeeds/sidesFeed`, with a new frameId on every request.
  - Bytes are uploaded as `rgba8unorm-srgb`, the movie node's texture format, at the texture's authored size (1920×1080 for both). A layer of another size is resampled bilinearly on the CPU.
  - A missing input is black.
- **Stills (VN121).** A Movie File In on a `.png` (`movie_fxMap`, `fx-pixel-map-r2.png`) is decoded once at load by `src/png.ts` and registered as `media:<node id>` with a constant frameId, resampled to the texture's extent if it differs. The bytes are the file's own (straight alpha, display-encoded), as the app's `openStill` hands them over. Any other picture format, a 16-bit or palette PNG, or an interlaced PNG fails the load by name; `build-package.ts` fails when a still the project names is missing.
  - What stays black, and the host logs each once: `movie_testVideo` (an mp4) and `syphonin_FX`.
  - Neither black source is reachable from AE (VN122). Syphon is Source FX = 0, and the `stageFeeds.sourceFX` popup offers only 1 (test pattern, the saved value) and 2 (the pixel map above). `testVideo` is the DS picture at Source = 1 (test), and Source is pinned to 0 (live).
- **Output.** The Output node's `$target`, read back as rgba16float, display-encoded, alpha 1, at the requested size, and copied into the output slot.
- **Manifest.**
  - The params are the panel's sliders and toggle, in board order and grouped by its section labels, with the VN122 changes. That is 26 params: 23 floats, the `toggle_talent` bool, and 2 popups.
    - `slider_source` is not published; the host pins Source to live.
    - `stageFeeds.sourceFX` (label "FX source", a popup: Test pattern = 1, Pixel map = 2) takes `slider_source`'s place in "Feeds and view".
    - An integer-step slider whose caption lists its choices becomes a popup. In -13 that is only `slider_shot`: "Shot", with FOH = 0, iso = 1, wing = 2, proj = 3, wide = 4, as the caption lists them.
  - Labels are ASCII and at most 31 bytes.
  - `default` is the value the project was saved with, not the slider's reset default, so a new effect instance shows the project's look. The exceptions are `slider_leds` and `slider_strobes`, which default to 0, so a fresh effect has the LED fixtures off (VN122). The project file is unchanged.
  - Both inputs carry `"defaultLayer": 1`.
  - `durationSeconds` = (end − start + 1) / fps = 144.733.

## Shipping notes

- Signing is ad-hoc only. A third-party Mac needs the three Mach-Os signed with a Developer ID and notarised.
- With the hardened runtime, Node needs `com.apple.security.cs.allow-jit` and `allow-unsigned-executable-memory`.
- Loading `dawn.node` and `loom-shm.node` needs the same Team ID on all three, or `disable-library-validation`.
- `--build-sea` does not exist in Node 24. The build uses `--experimental-sea-config` plus postject.
- The bundle is CommonJS, which a Node 24 SEA requires.

## Upstream ask (not made; `src/` is out of this lane)

`renderer.ts` reaches into Loom internals by relative path. These include `src/app/animate-parameters.ts`, an app-layer file, and the frame driver, value graph, flatten and morph index.

A small headless session module in `src/` would let this survive upstream churn, for example
`src/runtime/headless/session.ts`:

```ts
openHeadlessSession({ document, components, media: Map<id, bytes>, size })
  -> { setParameters(byNodeName), renderFrame(index) -> rgba16f bytes, resize(w, h), dispose() }
```

That module would need a test that drives a component project with an external texture feed through it on Dawn.
