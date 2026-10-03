# Channels, component controls, and connection drops

## TouchDesigner research

TouchDesigner's Common Channel Mask selects channels an operator processes. Disabling a channel preserves its input value; it does not delete that channel or make alpha zero. Derivative's staff specifically confirms that disabling alpha preserves alpha.

- [Derivative Common Channel Mask documentation](https://derivative.ca/UserGuide/Over_TOP)
- [Derivative staff explanation of unchanged channels](https://forum.derivative.ca/t/using-tops-without-loosing-alpha/502821)
- [Derivative TOP Viewer documentation](https://docs.derivative.ca/TOP_Viewer)

The TOP viewer separately displays transparency over a checkerboard. Processing changes downstream data; display inspection changes how that data is shown.

Loom uses straight alpha. Multiplying RGB by a mask and then feeding that result into straight-alpha Over multiplies soft-edge coverage twice. The fix preserves Mask's alpha-only default and corrects its display.

## Actual Common channels

Image operators and components now offer R, G, B, and A toggles on Common. These change persisted graph state through `node.setChannelMask` and the existing patch path, including undo, validation, copying, and nested instance overrides.

Enabled channels use the processed result. Disabled channels preserve the first connected texture input, in declared port order and then variadic edge order. A generator without an input uses the explicit neutral value `(0, 0, 0, 1)` for disabled channels. All-off is a real setting. All-on clears the override.

Preserved RGB is converted between declared encoded and linear spaces when needed; data values stay numeric. Component processing happens at exposed output boundaries, so it does not alter other consumers of an internal intermediate. Feedback retains the final masked output; Cache's ring storage stays unchanged.

Untouched/all-on nodes add no GPU pass or target. An opted-in builtin adds one select pass and one processed target per materialized texture output. An opted-in component adds one boundary pass and target per exposed texture output. An existing custom shader inspection viewport also gets the equivalent mask when that operator is masked.

Default component previews follow the compiler's processed public output. Choosing an internal debug preview still shows that internal node. Drilled Common edits belong to the individual instance.

## Alpha display

Default node previews and the editor viewer show valid alpha coverage over a checkerboard, composed in linear light. Explicit RGB inspection shows raw colour. Backend presentation still defaults to raw RGB for perform/export clients; the editor explicitly requests RGBA inspection. Canvas surfaces remain opaque.

This does not insert a checkerboard into node outputs or exports. Mask's straight RGB and alpha payload remain intact. Producer alpha outside `[0,1]` is arithmetic data and displays as opaque RGB. Output's existing display transform can clamp that alpha to coverage; RGBA inspection then displays the clamped coverage. Projects that used alpha arithmetically can choose RGB for their previous display.

## Component parameter synchronization

The compiler applied parent published values while the drilled Inspector read the shared definition's stored defaults. The Inspector now reads the same instance-effective flattened values as rendering, including intermediate nested components.

Child controls write the published parameter's owner through the existing coalesced command path. Root-published controls write the root instance; private nested controls write their nearest ancestor authoring session. Defaults, active and inactive parameter bindings, fan-out, peer isolation, serialization, and owner undo are covered.

Existing limitation: global keyboard undo targets the root bus. Private definition-authoring edits have their own owner history; this work tests that history without changing keyboard routing.

## Common connection drops

Moving a wire onto an occupied input swaps both sources. Alt-drop explicitly replaces the destination. The socket picker uses the same swap policy; canvas connection creation retains its existing replacement policy.

Live HTML drag reordered the actual DOM rows, changing the target under the pointer. Drag rows now keep their original positions until release. Live permutations and the final drop use that fixed destination, including returning to the starting slot and dropping on the spare socket. Keyboard ordering still uses the existing command and undo grouping.

Real Chromium initially reproduced the wrong final slot. The same browser test passes after the fix and saves the document to verify four sources survive.

## Useful ports

MatteCut exposes a **Picture** input and **Cutout** and **Mask** outputs. Its existing `picture` and `out` addresses remain stable. Mask is the exact Matte intermediate already used internally, with no duplicate inference pass. Boundary display labels are authored by renaming boundary nodes through commands; exposing a port alone cannot override a boundary node's authoritative label. Only MatteCut was regenerated from its TypeScript authoring source.

Movie/Webcam/Screen, Matte, Depth, Cache, and Mask sockets now name Picture, Mask, Depth, Delayed, or Cutout as appropriate. Addresses remain unchanged. Existing saved component definitions retain their embedded surface. Import the regenerated `examples/components/MatteCut.loom.json` to replace an older embedded MatteCut surface explicitly.

## Verification

Focused CPU tests cover channel commands, strict persistence, undo/redo, duplication, nested overrides, compiler boundaries, viewports, parameter synchronization, preview routing, and connection gestures. Removing the component Inspector context makes eight synchronization regressions fail.

Tiny Dawn fixtures verify actual channel selection, preserved alpha, downstream Over, generator neutral values, Feedback history, and component boundaries. Exact pixel tests verify alpha `0`, `0.5`, and `1`, linear-light display, raw RGB, arithmetic producer alpha, and unchanged output payloads.

A headed Chromium test verifies actual Mask viewer and node-preview pixels. A separate Chromium test verifies swaps and layer ordering through the saved document. All test-owned devices, browsers, and isolated servers are disposed.

The broad CPU run also found two stale fixtures from earlier runtime changes. The load-reset fixture assumed concurrent backend compiles; it now proves queued supersession and reset debt after the newest plan installs. The inference-parameter fixture bypassed dispatch preparation; it now invokes the registered gate with valid source provenance and counts submitted renders. Their original reset, ratio, and smoothing assertions remain intact.

Final validation on 2026-10-03:

- `pnpm run test --exclude '**/*.gpu.test.ts' --maxWorkers=8 --minWorkers=1`: 717 files passed; 11,690 tests passed, three skipped, one todo.
- `pnpm test:gates`: 51 files and 3,332 tests passed. The helper-door test needs local loopback access; its sandbox timeout disappears with that access.
- `pnpm typecheck`, `pnpm lint`, and `pnpm build`: passed. Lint reports four existing warnings; build retains its existing bundle-size warning.
- Scoped `pnpm test:headless` fixtures: 17 checks passed across channel processing, Mask soft edges, source-alpha previews, and canvas presentation. No broad GPU sweep was needed.
- Scoped `pnpm test:e2e`: both Common input dragging and actual Mask viewer/preview pixels passed in Chromium.
- `git diff --check`: passed. The final rendering review found no concrete correctness issues.
