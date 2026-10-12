# vGPU patch status

Loom pins published `vgpu` **0.5.0** and carries `patches/vgpu.patch` through pnpm.
The version-qualified `vgpu@0.5.0` patch entry is intentional: pnpm 9 did not apply the
old unqualified entry when regenerating the patch. Dependency versions are unchanged.

The fork’s `main` and `canary` were fast-forwarded to their corresponding upstream
branches on October 9, 2026. Source proposals now target canary `9c23f6c0`
(`0.6.0-rc.2`). This does not upgrade Loom to a release candidate.

## Patch themes and source proposals

| Theme | Why Loom 0.5.0 needs it | Current canary / fork review |
| --- | --- | --- |
| T939: retain MSAA samples | Geometry runs and later overlays preserve color and depth across passes. Loom’s historical patch stores the samples. | [PR #1](https://github.com/laubsauger/vgpu/pull/1) makes storage opt-in with `preserveSamples`; the default still discards. Two native pixel tests prove color and depth survive. |
| T1076: packed buffer regions | Bind point attributes as actual buffer/offset/size regions. | Bare bindings and range cache keys are already upstream. [PR #2](https://github.com/laubsauger/vgpu/pull/2) now demonstrates the remaining legal **disjoint writable** compute case. Mixed read-only/writable access to one allocation remains invalid even for disjoint ranges. |
| T1180: live binding eviction | Release obsolete bind groups while reusing a drawable after resource replacement. | Upstream [#487](https://github.com/vercel-labs/vgpu/pull/487) solves abandoned-owner retention with weak, bounded caches and disposal. [PR #3](https://github.com/laubsauger/vgpu/pull/3) documents only optional live-consumer trimming, not an unbounded leak. |
| T1243: frame extent | Per-pass durations cannot recover earliest-start to latest-end elapsed GPU time. | [PR #4](https://github.com/laubsauger/vgpu/pull/4) reports extent and the captured opaque frame handle beside existing results. |
| T1247: compute / indirect timing | Stable 0.5.0’s standalone dispatch and indirect draw otherwise escape frame telemetry. | Canary [#449](https://github.com/vercel-labs/vgpu/pull/449) adds frame compute dispatch. Inline indirect draws already support render-pass timers. [PR #6](https://github.com/laubsauger/vgpu/pull/6) reproduces the remaining compute-pass timer gap; no duplicate external-span API is proposed. |
| T1295: dropped results / staging depth | Missing telemetry must be distinguishable from telemetry still in flight; Loom uses bounded nonblocking staging growth. | [PR #7](https://github.com/laubsauger/vgpu/pull/7) proves silent busy drops and a free-slot selection gap. Evaluate available-slot selection before choosing an adaptive policy. |
| T1307: compatible color views | Present stored sRGB bytes through a declared linear view without another texture/copy. | [PR #5](https://github.com/laubsauger/vgpu/pull/5) forwards `viewFormats` for resolved color allocations and resize; depth/MSAA allocations are untouched. |
| Owned-pass pipeline state | Repeated `setPipeline` calls remain after upstream draw bookkeeping has been cached. | Pipeline-only suppression is backported to the stable patch. [PR #8](https://github.com/laubsauger/vgpu/pull/8) contains the source prototype, harness and raw samples. |

Every existing patch theme remains represented by a source proposal or identified
upstream work. The buffer, live-trim, compute-timing and staging drafts contain focused
reproductions; they do not claim to implement the desired API on canary.

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
