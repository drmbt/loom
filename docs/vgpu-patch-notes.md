# vGPU patch status

Loom pins published `vgpu` **0.6.0** and carries `patches/vgpu.patch` through pnpm.
The version-qualified `vgpu@0.6.0` patch entry is intentional: pnpm 9 did not apply the
old unqualified entry when regenerating the patch. `@vgpu/wgsl` **0.6.0** is a direct
dependency since this version, for `prepareShader` (see [Moving to 0.6.0](#moving-to-060-t1705b)).

The fork’s `main` and `canary` were fast-forwarded to their corresponding upstream
branches on October 14, 2026 (canary `8a616014`, `vgpu` 0.6.0). Every open proposal
branch has that canary merged in, without conflicts and with its history kept; each
pre-merge head is on the fork as `backup/loom/<branch>-2026-10-14`, and every branch's
own tests were re-run after the merge.

## Patch themes and source proposals

| Theme | Why Loom needs it | State on 0.6.0, and fork review |
| --- | --- | --- |
| T939: retain MSAA samples | Geometry runs and later overlays preserve color and depth across passes. Loom’s historical patch stores the samples. | Carried unchanged. [PR #1](https://github.com/laubsauger/vgpu/pull/1) makes storage opt-in with `preserveSamples`; the default still discards. Two native pixel tests prove color and depth survive. |
| T1076: packed buffer regions | Bind point attributes as actual buffer/offset/size regions. | Bare bindings, range identities and range validation are upstream in 0.6.0, so those hunks are gone and Loom’s regions no longer name an identity of their own. One hunk remains: the compute aliasing preflight accepts **disjoint writable** ranges of one allocation, which 0.6.0 rejects with `VGPU-R1-STORAGE-ALIASING`. [PR #2](https://github.com/laubsauger/vgpu/pull/2) demonstrates that case. Mixed read-only/writable access to one allocation remains invalid even for disjoint ranges. |
| T1180: live binding eviction | Release obsolete bind groups while reusing a drawable after resource replacement. | **Retired with 0.6.0.** Upstream [#487](https://github.com/vercel-labs/vgpu/pull/487) keeps bind groups per consumer in a weak, bounded cache and drops an entry when a resource it names is destroyed. The `evictBindGroups` hunks and every backend call to them are removed. `bind-group-eviction.test.ts` measures retained bind groups on unpatched behaviour and is flat for both leak shapes. [PR #3](https://github.com/laubsauger/vgpu/pull/3) is closed: nothing in it is needed on 0.6.0. |
| T1243: frame extent | Per-pass durations cannot recover earliest-start to latest-end elapsed GPU time. | Carried unchanged. [PR #4](https://github.com/laubsauger/vgpu/pull/4) reports extent and the captured opaque frame handle beside existing results. |
| T1247: compute timing | A kernel is GPU work of its frame and belongs in the per-pass column and the frame extent. | **Reduced with §T1707b.** Loom encodes every kernel into the frame through 0.6.0's `Frame.computePass` ([#449](https://github.com/vercel-labs/vgpu/pull/449)), so `Compute.dispatch(…, { timer, frame })`, `Frame.attachExternalSpan` and the `DispatchTiming` type are gone. One hunk remains: `FrameComputePassOptions.timer`, the same attachment a render pass's `timer` uses, rolled back with the pass on a throw. [PR #6](https://github.com/laubsauger/vgpu/pull/6) now implements exactly that in source (the attach context's `target` made optional for a compute pass), with mock and native tests. |
| T1295: dropped results / staging depth | Missing telemetry must be distinguishable from telemetry still in flight; Loom uses bounded nonblocking staging growth. | Carried: `onDropped` and the staging depth that doubles on demand. The span retraction (`retractSpan`) is gone with the external span (§T1707b). A render is one frame now, so an awaited export no longer drops; an export that renders back to back without yielding still does. [PR #7](https://github.com/laubsauger/vgpu/pull/7) proves silent busy drops and a free-slot selection gap. |
| T1307: compatible color views | Present stored sRGB bytes through a declared linear view without another texture/copy. | Carried unchanged. [PR #5](https://github.com/laubsauger/vgpu/pull/5) forwards `viewFormats` for resolved color allocations and resize; depth/MSAA allocations are untouched. |
| Owned-pass pipeline state | Repeated `setPipeline` calls remain after upstream draw bookkeeping has been cached. | Ported onto 0.6.0’s `encode`, which gained a uniform-capture argument; the pass state rides after it. [PR #8](https://github.com/laubsauger/vgpu/pull/8) contains the source prototype, harness and raw samples. |
| T1705b: captured bind groups kept across frames | A feedback pass alternates between the two halves of its ping-pong, one bind group each. | **New with 0.6.0.** When a frame completes, `frame-uniforms.js` `release()` evicts every bind group of the returned page that the frame did not use. The half the next frame binds is always the one this frame did not, so every feedback pass built a bind group per frame (measured on the mock: 10 to 606 over 600 frames, `phase1-exit.test.ts`). The hunk keeps an entry while either of the page's last two frames used it, so a ping-pong reader keeps both bind groups and a draw that moved or stopped drawing is still dropped, one frame later; the caps (16 captured variants per owner and group, 64 per owner) still bound the cache. [PR #9](https://github.com/laubsauger/vgpu/pull/9) is the same change in source, with a test that fails under the one-frame rule while upstream's bounded-cache test still passes. |
| T1705b: object errors on the caller’s scope | Loom builds every pass inside its own device error scope and reports each device error on that pass’s node. | **New with 0.6.0.** Upstream now creates a shader module, bind group layout and pipeline layout inside a scope of its own and hands the error to the pipeline that later names the object. Measured on Dawn: a caller's own scope around the build sees nothing, and of two consumers built from one invalid source only the first is told. The hunk makes `nativeObject` create without a scope, as through 0.5.0. [PR #10](https://github.com/laubsauger/vgpu/pull/10) reproduces both; it proposes no implementation yet. |

Every theme Loom patches is represented on the fork. #1, #4, #5, #6, #8 and #9 implement
the change in source; #2, #7 and #10 reproduce a gap and propose a direction without an
implementation.

## Moving to 0.6.0 (T1705b)

What changed in Loom, beside the patch:

- **Prepared shaders.** `draw`, `effect` and `compute` refuse a WGSL string. Loom emits
  every pass’s WGSL at compile time, so `prepared-shader.ts` calls `prepareShader` when a
  consumer is built: at a compile, for each pass not carried over, never per frame.
  Measured on this machine at about 1.9 ms for an 11 KB shader, against about 1.6 ms for
  the reflection 0.5.0 ran in the same constructors. It keeps the last 128 artifacts by
  source text, because passes of one node type emit the same WGSL and vgpu validates a
  reused frozen artifact once. Over the 80 shipped examples, 1,800 passes carry 1,113
  distinct sources per file; preparing all 1,800 took 1,007 ms in plain Node and the
  distinct ones 563 ms (E77: 145 ms to 28 ms). Reopening a project prepares nothing kept. The production
  bundle grew by 61 kB (19 kB gzip) against 0.5.0; that is the whole upgrade, not
  attributed per module.
- **Dispatch pipelines are compiled at the build.** A 0.6.0 compute builds its pipeline
  on first use; `buildResources` calls `compileSync()` inside the pass’s error scope, so
  a kernel the device refuses still fails the compile on its node.
- **A kernel on two nodes.** A compute now shares vgpu’s module and pipeline caches, so
  the device answers once for two byte-identical kernels. `askPassesSharingAFailedShader`
  asks again for a dispatch as it does for an effect.
- **Frame uniforms.** A frame captures its managed uniforms into a pooled page that
  returns to the pool when the frame completes. A loop allocates nothing once warm;
  frames encoded back to back inside one turn each take a page. The page is one more
  buffer per device (64 KiB), and the fullscreen vertex stage one more shader module,
  shared by every effect.
- **Kernels inside the frame (§T1707b).** Every dispatch is a `Frame.computePass` of its
  own, in plan order, on both render paths; `encodeSegmented` is gone and a render is one
  frame. See [the design](kernels-in-frame-design-2026-10-14.md).
- **`frame.done`** resolves a few microtasks later than before. Environment preparation
  reuse reads it; nothing else in Loom orders itself against it.
- **Errors that moved.** A storage binding smaller than the shader declares is refused
  when it is set, at the build. A name colliding with the fullscreen vertex stage is no
  longer an error: 0.6.0 builds that stage as a module of its own. A non-power-of-two
  `@align` is refused on the CPU before the device is asked; the backend then puts the
  pass to the device's compiler, so the row still names the author's line (SPEC §T1706b).

## Pipeline suppression

An internally owned `Frame.pass` keeps the last native pipeline identity. Consecutive
draws using that same pipeline avoid its redundant setter. A different pipeline is
always bound; a new pass begins empty; `executeBundles`, including an empty list,
invalidates the remembered state. Caller-owned encoders remain uncached.

Bind groups, dynamic offsets, geometry, blend/stencil state, validation and draw order
keep their existing paths. This is distinct from upstream [PR #493](https://github.com/vercel-labs/vgpu/pull/493),
which caches verification, keys and binding plans. A broader native binding-cache
prototype was rejected after its mock CPU overhead and bundle growth were measured.

See [correctness and performance evidence](performance/2026-10-09-vgpu/README.md).
Measurements cover the tested machine and workloads; they do not establish that every
browser, driver or graph improves.

## Review and contribution policy

All published proposals are drafts on `laubsauger/vgpu`, based on canary and with old
branch history retained. No proposal has been submitted to `vercel-labs/vgpu`.
The owner reviews the fork drafts and evidence before any parent-repo publication.

Upstream’s current external workflow asks for `## PR type` = `contribution`. Its
release-impact validator has not yet rolled that type out; the draft descriptions
call out that policy mismatch. They do not mislabel proposals as maintainer integration
or change package versions/changesets merely to pass the validator.
