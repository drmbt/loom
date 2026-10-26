# WebGPU rendering review — October 9, 2026

Two changes were worth implementing first: retain unchanged environment preparation in
Loom, and avoid repeating an unchanged native pipeline binding in vGPU. The rest of
this review separates capabilities we already have from work that still needs a
measured use case.

## What carries over from Three.js

Three.js r186’s WebGPU renderer provides useful reference implementations, but its
node builder depends on the renderer and scene state. Importing that stack would
change Loom’s execution model. Small WGSL algorithms, lookup tables and resource
lifetime rules are better candidates for reuse.

| Area | Loom / current vGPU | Useful next step |
| --- | --- | --- |
| Many lights | Loom already uses clustered forward lighting, deterministic cell bitmasks and GPU point-set light records. | Compare cluster construction costs on actual many-light scenes. Do not replace the existing implementation just to match Three.js. |
| PBR and environments | Loom has GGX/Smith/Schlick shading, roughness-cone prefiltering and cosine irradiance. | Measure DFG lookup-table and energy-compensation improvements separately from caching. |
| Static preparation | Environment filtering previously ran for every Render on every cooked frame. | Implemented: retain a valid atlas; share an identical recipe through one exact atlas copy to the second Render’s own storage. |
| Shader and pipeline reuse | vGPU caches modules, layouts and pipelines; Loom caches emitted WGSL and structural plans. | Keep source generation and reflection outside the frame path. Profile actual cache misses before adding another cache. |
| Repeated draws | Upstream #493 already avoids repeated verification, pipeline-key construction and binding-plan work. | Implemented prototype: suppress only redundant native `setPipeline` calls inside an owned render pass. |
| Render bundles | vGPU supports them; Loom does not currently use them. | Benchmark a static repeated scene with explicit invalidation before adopting them. |
| Attachment lifetime | Discard is right when samples are dead. Loom also has multi-pass MSAA scenes that load them again. | Fork proposal: opt-in sample preservation, retaining discard as the default. |
| Compute submission | Canary #449 adds direct/indirect dispatch inside `Frame.computePass`. Loom is still pinned to stable 0.5.0. | Evaluate a stable API migration separately; add timer support to the existing compute-pass API. |
| Area lights, IES, probes | Not interchangeable with our existing light types. | Possible later visual work: LTC area lights, photometric profiles and SH probe sampling, with native parity and image-quality comparisons. |

`vgpu/three` exports WGSL through Three.js/TSL adapters. It does not import Three.js
materials, lighting or a renderer into Loom.

## Changes in Loom

Environment preparation is explicit plan metadata, not inferred from a node name.
Reuse requires a pure source dependency chain and private preparation outputs. Source
uniforms, media frame/registration identities, native allocations and target sizes are
part of the validity check. Skipped source draws, exposed intermediate outputs,
feedback and GPU buffer producers do not qualify.

Availability persists across the submissions of one logical render, without changing
pass order. A shared result is copied to the other Render’s own atlas. Readiness for
later frames is published after submission completes. Reset, resize, source replacement,
GPU errors and device recovery invalidate or rebuild the preparation state.

Loom remains on `vgpu` 0.5.0. The native pipeline-binding optimization is backported
into its existing pnpm patch; the fork prototypes use current canary, 0.6.0-rc.2.

## Evidence

The [measurement report](performance/2026-10-09-vgpu/README.md) contains raw data,
commands and limits. The actual two-Render HDRI scene matches both output images
byte-for-byte through source changes, material motion, reset and recompile. Separate
checks cover source skip, intermediate readers, malformed plans, resize and device
recovery.

All vGPU proposals are [drafts on the fork](https://github.com/laubsauger/vgpu/pulls).
They are for owner review. No issue or PR has been published to the parent repo.
Upstream’s external-contributor workflow treats code as a proposal for triage; accepted
work is implemented separately by maintainers.

## Sources

- [Three.js r186 WebGPU backend](https://github.com/mrdoob/three.js/blob/r186/src/renderers/webgpu/WebGPUBackend.js)
- [Three.js r186 clustered lights](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/tsl/lighting/ClusteredLightsNode.js)
- [Three.js r186 PMREM generator](https://github.com/mrdoob/three.js/blob/r186/src/renderers/common/extras/PMREMGenerator.js)
- [Three.js r186 lighting nodes](https://github.com/mrdoob/three.js/tree/r186/src/nodes/lighting)
- [vGPU #493: unchanged-draw encoding](https://github.com/vercel-labs/vgpu/pull/493)
- [vGPU #487: owner caches and disposal](https://github.com/vercel-labs/vgpu/pull/487)
- [vGPU #449: frame compute passes](https://github.com/vercel-labs/vgpu/pull/449)
- [vGPU external contribution policy](https://github.com/vercel-labs/vgpu/blob/canary/.github/guides/external-contributor.md)
