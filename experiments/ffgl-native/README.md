# Native FFGL export experiment

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
