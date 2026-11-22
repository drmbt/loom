# Native FFGL export experiment

Two things live here. **Scene export** (`loom-native-2`, VN133 onward) packages a real saved scene as its own FFGL plugin and is described first. The older **static-filter proof** (`loom-native-static-1`, VN21) is kept below unchanged.

## Scene export (`loom-native-2`)

`scene.mjs` turns a saved `.loom.json` plus an export interface into a package that the native Dawn engine in `drmbt-custom-fx/experiments/loom-native/scene` runs inside Resolume, with no Loom app. The project loader and the compiler stay authoritative: the exporter selects, checks and packs what they produce.

One command builds and proves a plugin (run it from the drmbt-custom-fx checkout; it calls back into this one):

```sh
python3 experiments/loom-native/scene/build_scene.py --loom ../loom-ffgl-export \
  --project <scene>.loom.json --interface <interface>.json --plugin "Hotel Facade" --size 2000x571
```

To export only: `pnpm exec node --import ./src/tooling/alias-hooks.ts experiments/ffgl-native/scene.mjs <project> <interface> "<plugin>" <out dir> [media root]`. It needs Dawn (it renders the stills once), so run it through `tools/heavy.sh`.

### Interface (schemaVersion 2)

```json
{
  "schemaVersion": 2,
  "plugins": [{
    "name": "Hotel Facade", "kind": "source",
    "output": { "nodeId": "encode", "portId": "out" },
    "hostBpm": { "node": "slider_bpm", "default": false },
    "controls": [{ "node": "slider_master", "name": "Master", "type": "slider" }]
  }]
}
```

- `plugins`: one generated plugin per output. `name` is the FFGL name (1 to 16 printable ASCII characters). `code` is its four-character FFGL id, claimed in drmbt-custom-fx `docs/PLUGIN-IDS.md` (a plugin without one builds as the placeholder `LSX0` and must not be installed). `kind` is `source` or `effect`. `output` names the node and port whose picture the plugin shows. Pick the node that holds display-encoded pixels (ICON HOTEL: `encode`, the node that feeds Syphon), because the engine writes the target to 8 bits as it is.
- `input` is `{ "nodeId": "<node>" }` and belongs to an `effect` only (a source may not have one): the node whose picture the layer's video replaces. It must be a Movie File In (Image fit Stretch) or a Syphon In, held as `rgba16float`. Its own media pass and its still are left out of the package; the engine fills its target from the host's texture, **at the host texture's own size**, so a shader that reads `textureDimensions` sees the clip's size, not the node's saved one. The texture is read as 8-bit sRGB and its alpha is passed through as it is. With no input the scene sees an empty transparent picture.
- `checks` is optional: `[{ "label": "PanRight", "set": { "Content X": 0.5 } }]`. Each is one more capture, the defaults with those parameters (by FFGL name) moved. It must match Loom and must differ from the defaults' picture.
- `present` is `"none"` (default) or `"srgb"`. With `"srgb"` the engine applies the linear to sRGB curve at the output, so `output` can name a linear node. Use it for a plugin with transparency: Arena composites an FFGL source's alpha as straight, so show the straight-alpha linear node (ICON HOTEL IMAG: `imagNull`) and never a premultiplied one.
- `controls` is the plugin's parameter list, **in FFGL index order**. Comps, presets and MIDI maps store the index, so once a plugin is in use only append to this list. An entry is one of:
  - `{ "node": "slider_master", "name": "Master", "type": "slider", "group": "Ambient" }`: one parameter. `name` is the FFGL name (default: the control's caption); `type` is `slider`, `hue` or `integer` (default: `integer` for a slider with Step 1 and whole Min and Max, `hue` for a lone 0..1 slider whose caption or channel says hue, else `slider`; a Toggle is always a toggle).
  - `{ "color": "Pill color", "hue": "slider_pillHue", "saturation": "slider_pillSat", "dims": "slider_pillLevel", "group": "Pill" }`: Resolume's native colour picker over two 0..1 sliders of the scene. It becomes four FFGL parameters (hue, saturation, brightness, alpha). `dims` is optional and names a slider in the same list that the picker's brightness multiplies; alpha does nothing.
  - `group` is optional on both. Parameters of one group must be listed together.
  - A name over 16 characters, a name the plugin already uses (`Preset`, `Morph`, `Recall`, `Rescan`, `Snap`, `Curve`, `Next`, `Prev`, `Random`, `Host BPM`, `Fit`), two parameters with one name, a control listed twice or a split group fail the export. A control the picture reads but the list leaves out fails it too.
- `scene.mjs --controls <project> <interface> "<plugin>"` prints the list to start from: the controls that plugin's picture reads, in graph order. A top-level `controls` is a list shared by plugins that have none of their own; with neither, every Slider and Toggle is exported in graph order, which is for trying things out, not for a plugin that will be installed.
- `hostBpm` is optional. It names the scene's tempo control. The plugin then gets a `Host BPM` toggle, and while it is on the host's tempo stands in for that control.

### What the profile covers

- **Nodes:** `customWgsl`, `customWgslMulti`, `blur`, `add`, `null`, `output`, and `movieFileIn` holding a PNG still. `slider` and `toggle` become controls. `panel`, `syphonOut` and `presets` are dropped by rule and listed in the report. Any other node anywhere in the graph fails the export with its name, type and id.
- **Stills:** a Movie File In is rendered once by Loom itself, with the real PNG in its `rgba8unorm-srgb` media texture, and its output target is read back. That half-float linear image is the packaged asset, so the engine never decodes a PNG and the still is exactly what Loom's media path produces. The PNG must be 8-bit, non-interlaced, without an ICC profile, and the node's fixed resolution must be the file's size.
- **Formats and sizes:** `rgba16float` and `rgba8unorm` targets, each at the size the compiler resolved. Sizes are fixed; the host's layer size only affects the final fit.
- **Controls:** a control's value is read clamped into Min..Max. A slider with a Step snaps to multiples of it, as Loom's own slider does when dragged, so `Pattern 0-8` only ever holds whole patterns.
- **Expressions:** numbers, `+ - * /`, unary sign, parentheses and `op('<control>').chan.<channel>`. They are lowered to a small stack program that the engine runs every frame; nothing is frozen. Anything else is refused, quoting the expression.
- **Parameters to uniforms:** measured on the compiler, not assumed. The exporter recompiles with the parameter at three values and keeps the straight line it finds per uniform component. A parameter that changes the plan's shape, or reaches a uniform through a curve, is refused.
- **Uniform layout:** `f32`, `i32`, `u32`, `vec2f`, `vec3f`, `vec4f` with WGSL alignment. Other member types are refused.
- **Presets:** every `presets` node becomes entries of one alphabetical menu, prefixed by bank (`Look`, `Palette`, `Pill`, else the node's role). Only what a bank targets is written; a colour is written whole, and a preset that sets only part of a colour takes the rest from the control's default and is reported. A target the plugin does not list is left out and reported. drmbt-custom-fx turns them into Arena preset XML.
- **Refused:** feedback, rings, buffers, dispatch and draw passes, blend state, layered or history texture bindings, components, node state, bind/map parameter modes, samplers other than linear clamp.

### Package layout (ABI 4)

```
package.json     schemaVersion 2, profile "loom-native-2", abi 4
assets/<node>.<format>.deflate   raw-deflate of the still's texels, top row first
report.json      what was dropped, Loom's load warnings, controls this picture never reads
```

`package.json` holds: `name`, `kind` and `code` (the four-character FFGL id from the interface, or null); `size` and `output`; `frame` (`fps`, `randomSeed`, `resolution` for the shared frame block); `vertex`; `resources` (`target`, `asset`, `sampler`); `passes` (shader, target, bindings, the uniform block with each field's byte offset, scalar type and default value, and the name of the shared frame binding); `assets` (file, size, format, byte length, SHA-256 of the inflated texels); `controls` (node, type, channel, name, min, max, step, default); `params` (the FFGL parameters in index order: name, FFGL type, range, default, group, the control each writes, the control a brightness dims, the picker it belongs to); `hostBpm` (the control index and the toggle's default, or null); `present`; `presets` (name, bank, and parameter index and value pairs, sorted by name); `parameters` (the lowered program per driven parameter); `drives` (parameter index to pass, field and component, with scale and offset). ABI 2 added `step` and `hostBpm`, 3 `present`, 4 `params` and `presets`. ABI 5 added `input` (`resource`, `node`, `size`: the nominal size, replaced by the host texture's) and the resource kind `host`. `abi` changes whenever the engine must read the package differently, and the engine refuses any other value. The build copies the folder into the bundle's `Contents/Resources/loom/`; asset blobs never go in git.

### Checked

`compare-scene.mjs plan` writes the harness script for any package; `compare` renders the same states in Loom. A run covers:

- every declared parameter read back through the FFGL ABI: count, name, type, default and range;
- the defaults, and three sweeps that move every control at once to a random place in its range (toggles stay off, since a blackout leaves nothing to compare), two of them on two instances alive together and rendered turn by turn;
- three presets recalled through the plugin's Preset menu from the exported XML, twenty frames in: Loom is given the swept state with only that preset's parameters replaced, so a partial bank that disturbed anything else would show, and a recall that changed nothing fails;
- the host's tempo taking over: Loom is given the tempo in the scene's own control, the plugin keeps another value there and receives the tempo as FFGL beat info;
- a walk through time (frames 0 to 23 stepped one by one, compared at 0, 7 and 23);
- at each extra host size: the defaults, and one sweep in `Fill` and in `Stretch`.
- not compared with Loom, but asserted: a second live instance uploads no stills (it shares the first one's), and five open/close cycles do not grow the process. The harness also prints the footprint with one and two instances and the frame time at 1920×1080 and 3840×2160.

Results on 2026-11-21, worst channel difference of 255 in every case:

| Plugin | Captures | Control states | Host sizes | Worst |
|---|---|---|---|---|
| Scene fixture (media-free, `scene-fixture.mjs`) | 22 | 8 | 96×64, 200×120 | 1 |
| ICON HOTEL `Hotel Facade` (54 controls as 72 parameters, 9 passes, 4 stills: 122 MiB on the GPU, 7.8 MiB packed) | 26 | 8 | 3584×1024, 2000×571, 1920×1080 | 1 |
| ICON HOTEL `Hotel IMAG` (30 controls as 36 parameters, 10 passes, 3 stills: 39 MiB on the GPU, 3.3 MiB packed) | 26 | 8 | 1664×1024, 2000×571, 1920×1080 | 1 |

- The oracle is `renderHeadless` with the animator on, real stills, and control values written through `graph.applyPatch`. It does not read the package's programs or drives. It renders the scene without the dropped nodes. The comparison also fails if two sweeps come out as the same picture.
- `scene.test.mjs` (no GPU): the fixture's package, every refusal above by message, control lists and names, uniform layout, the lowered program, the PNG decoder.
- Red checks: leaving `Host BPM` off in the plan fails the tempo captures (10/255); a capture taken one frame late fails (62/255); changing one control's default inside the built bundle fails the comparison (73/255); flipping one byte of an asset fails the plugin's start; a ranged parameter declared the plain SDK way failed the default check (the SDK clamps a standard default into 0..1), which is how that was found.
- The PNG decoder was compared with macOS's own (`sips` to BMP) on `mask.png` and `passes_a.png`: no differing pixel.

### Effects (VN137)

`scenes/icon-hotel-billboard/interface.json` builds **Billboard FX** (`LHBX`) from the billboard's Source network (`loom/projects/icon-hotel/billboard/ffgl/icon-hotel-billboard-source.loom.json`): the same 20 controls, with `movie_bbPoster` as the input node, so the layer's video is the board's face and its spill light.

- The comparison gives Loom and the plugin the same test still (`testStill`, drawn again by the harness) as the input: 2048x768 in a larger host texture, then 1280x960 and 640x360 to prove the scene sees the input at its own size, then no input. 22 captures, 10 states, worst 1/255 (2026-11-22).
- A preset or a missing input may leave a dark frame; the comparison takes those, because each is separately required to differ from the lit capture it is checked against.
- Not checked: anything in Arena (the size Arena hands an effect, whether its input is premultiplied, and how it composites an effect's alpha over lower layers). The pipelined run (`async`, `lag`) has no input.

### Not checked yet

- What was and was not checked live in Arena is in drmbt-custom-fx `experiments/loom-native/scene/README.md`. In short: both sources play, pickers, groups' declarations, preset recall with morph and the straight-alpha edge were checked; save and reopen, Arena's own P. dropdown on a partial preset, and 4K were not.
- `deltaTime` and `frameIndex` in the shared frame block are filled but no scene here reads them, so their parity is unproven. `wallTime` is given the scene clock and `pointer` zeros.
- A toggle that is on (ICON HOTEL's Blackout) is not compared against Loom, because the frame is black.
- A preset morph in flight is not compared against Loom (Loom's own morph curve differs); only the settled look is.
- Effect builds (VN137).
- Scaling quality: the fit to the host size is a plain bilinear read of whole texels, chosen so the comparison can repeat it exactly. Below half size it will alias.

## Static-filter proof (`loom-native-static-1`)

This compiler-side experiment exports supported saved `.loom.json` projects into a restricted package executed by the native Dawn engine in `../drmbt-custom-fx/experiments/loom-native`. It leaves normal Loom startup and the original project file unchanged.

## Build a saved-project example

From the Loom checkout:

```sh
pnpm exec node --import ./src/tooling/alias-hooks.ts experiments/ffgl-native/project-fixture.mjs
```

This creates `.cache/ffgl-native-project/transforms.loom.json` and `interface.json`. The document uses only production nodes and can open in Loom: Checker → Tile → Mirror → Transform → Crop → Flip. Checker supplies the editor preview; the export contract explicitly replaces its output with Resolume's input texture.

From the sibling drmbt-custom-fx checkout:

```sh
python3 experiments/loom-native/build.py \
  --project ../loom/.cache/ffgl-native-project/transforms.loom.json \
  --interface ../loom/.cache/ffgl-native-project/interface.json \
  --verify-transforms
```

This builds `build-loom-native/project/LoomNativeProof.bundle` and verifies it against Loom. Requires Apple Silicon/macOS 26+, Xcode, CMake, Python, and installed Loom dependencies. The build does not install or launch Arena. The bundle uses the same experimental plugin identity as the original proof: do not install both simultaneously or distribute these builds as distinct effects.

For another supported saved project, supply its file and interface paths and omit `--verify-transforms`. That flag tests the example's exact two-control protocol, including names/defaults. A successful custom build is not a claim of tested pixel parity for that project.

## Explicit export interface

The sidecar belongs to the export operation, not Loom's persisted project schema:

```json
{
  "schemaVersion": 1,
  "input": { "nodeId": "source-id", "portId": "out" },
  "output": { "nodeId": "transform-id", "portId": "out" },
  "controls": [
    { "name": "Rotation", "nodeId": "transform-id", "parameter": "r", "min": 0, "max": 240 }
  ]
}
```

IDs are the saved document's opaque IDs. The input must select a texture source with no input ports and one `out` port; export substitutes its compilation, without mutating the saved graph. The output selects an existing supported node's `out` port before any display transform. The controls array may contain zero to two numeric controls. Currently publishable parameters are Transform `r` and Mirror `rotate`; degree ranges map to the shaders' radians. Names/defaults appear through the FFGL ABI. This explicit sidecar does not yet read component-published parameters.

Supported downstream nodes: Transform, Tile, Mirror, Crop, Flip. The profile requires RGBA8, uniform resolution, static parameters, and disabled Transform aspect correction (until native resize-dependent evaluation exists). All graph nodes are checked, including disconnected nodes. Assets, components, expression/bind/map/driven parameters, unknown features, unsupported state/format/resolution policies, invalid controls, and unknown contract fields fail explicitly. No arbitrary shader/custom-node support is promised.

`project.mjs` uses the existing project loader/migration path, production definitions, and compiler. The native validator adds execution-profile checks before embedding. `package.json` is an experimental execution format, not a stable distribution ABI.

## Validation

```sh
pnpm exec node --import ./src/tooling/alias-hooks.ts --test \
  experiments/ffgl-native/export.test.mjs experiments/ffgl-native/project.test.mjs
pnpm typecheck
```

Saved-project native comparison: 48 frames, three sizes, two instances, swept FFGL controls, maximum channel difference **1/255**. The reference edits the saved project's parameters through domain commands and recompiles each frame; it does not reuse the native control mapping as its oracle. The native ABI harness additionally exercises 98 frames of lifecycle/resize/state handling and checks exported control names/defaults.

The original compute proof remains in `export.mjs`, `shaders.mjs`, and `compare.mjs`; its 12 animated comparison frames still match exactly. Unlike the production-node example, that fixture uses experimental nodes unavailable in the normal editor.

The companion native package loader is now implemented as `LoomPackageLoader.bundle` (LNL1), using this same exported static package and native executor. See [loader usage and limits](../../../drmbt-custom-fx/experiments/loom-native/LOADER.md). Its file parameter selects compiled `package.json`, not raw `.loom.json`; two fixed normalized slots preserve host restoration order. General component interfaces, CPU animation evaluation, and live Arena save/reopen validation remain further work.
