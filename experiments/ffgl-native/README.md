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
  "plugins": [{ "name": "Hotel Facade", "kind": "source", "output": { "nodeId": "encode", "portId": "out" } }],
  "controls": [{ "node": "slider_master", "name": "Master" }]
}
```

- `plugins`: one generated plugin per output. `name` is the FFGL name (1 to 16 printable ASCII characters). `kind` is `source` for now. `output` names the node and port whose picture the plugin shows. Pick the node that holds display-encoded pixels (ICON HOTEL: `encode`, the node that feeds Syphon), because the engine writes the target to 8 bits as it is.
- `controls` is optional. Absent, every Slider and Toggle is exported in graph order. Present, it fixes the order and may rename. A control the picture reads but the list leaves out fails the export.

### What the profile covers

- **Nodes:** `customWgsl`, `customWgslMulti`, `blur`, `add`, `null`, `output`, and `movieFileIn` holding a PNG still. `slider` and `toggle` become controls. `panel`, `syphonOut` and `presets` are dropped by rule and listed in the report. Any other node anywhere in the graph fails the export with its name, type and id.
- **Stills:** a Movie File In is rendered once by Loom itself, with the real PNG in its `rgba8unorm-srgb` media texture, and its output target is read back. That half-float linear image is the packaged asset, so the engine never decodes a PNG and the still is exactly what Loom's media path produces. The PNG must be 8-bit, non-interlaced, without an ICC profile, and the node's fixed resolution must be the file's size.
- **Formats and sizes:** `rgba16float` and `rgba8unorm` targets, each at the size the compiler resolved. Sizes are fixed; the host's layer size only affects the final fit.
- **Expressions:** numbers, `+ - * /`, unary sign, parentheses and `op('<control>').chan.<channel>`. They are lowered to a small stack program that the engine runs every frame; nothing is frozen. Anything else is refused, quoting the expression.
- **Parameters to uniforms:** measured on the compiler, not assumed. The exporter recompiles with the parameter at three values and keeps the straight line it finds per uniform component. A parameter that changes the plan's shape, or reaches a uniform through a curve, is refused.
- **Uniform layout:** `f32`, `i32`, `u32`, `vec2f`, `vec3f`, `vec4f` with WGSL alignment. Other member types are refused.
- **Refused:** feedback, rings, buffers, dispatch and draw passes, blend state, layered or history texture bindings, components, node state, bind/map parameter modes, samplers other than linear clamp.

### Package layout (ABI 1)

```
package.json     schemaVersion 2, profile "loom-native-2", abi 1
assets/<node>.<format>.deflate   raw-deflate of the still's texels, top row first
report.json      what was dropped, Loom's load warnings, controls this picture never reads
```

`package.json` holds: `size` and `output`; `frame` (`fps`, `randomSeed`, `resolution` for the shared frame block); `vertex`; `resources` (`target`, `asset`, `sampler`); `passes` (shader, target, bindings, the uniform block with each field's byte offset, scalar type and default value, and the name of the shared frame binding); `assets` (file, size, format, byte length, SHA-256 of the inflated texels); `controls` (node, type, channel, name, min, max, default); `parameters` (the lowered program per driven parameter); `drives` (parameter index to pass, field and component, with scale and offset). `abi` changes whenever the engine must read the package differently, and the engine refuses any other value. The build copies the folder into the bundle's `Contents/Resources/loom/`; asset blobs never go in git.

### Checked

- `scene.test.mjs` (no GPU): the fixture's package, every refusal above by message, uniform layout, the lowered program, the PNG decoder.
- `scene-fixture.mjs` writes a media-free scene that uses the whole profile, including the frame clock. Native against Loom: 9 frames at 96×64, 200×120 and 64×64, worst channel difference 1/255.
- ICON HOTEL `Hotel Facade` (scene and media stay outside git): 9 passes, 4 baked stills (122 MiB on the GPU, 7.8 MiB packed), 57 controls, 53 driven uniforms. Native against Loom at 3584×1024 (the scene's own size), 2000×571 and 1920×1080, all controls at their defaults, frames 0, 7 and 23: worst channel difference 1/255, 0.003 % of channels differ at all.
- The oracle is `renderHeadless` with the animator on, real stills, and control values written through `graph.applyPatch`. It does not read the package's programs or drives. It renders the scene without the dropped nodes.
- Red checks: changing one control's default inside the built bundle fails the comparison (73/255); flipping one byte of an asset fails the plugin's start.
- The PNG decoder was compared with macOS's own (`sips` to BMP) on `mask.png` and `passes_a.png`: no differing pixel.

### Not checked yet

- Parameters and host time through the FFGL parameter ABI (VN134): the plugin exposes no parameters yet, so only defaults are proven on ICON HOTEL. At its defaults that scene does not move, so its clock is proven only on the fixture.
- Anything live in Resolume (VN135), presets (VN136), effect builds (VN137).
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
