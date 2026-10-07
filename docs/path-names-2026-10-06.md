# Path-aware names (COMP-model stage 1, VN35)

Proposal: `docs/comp-model-2026-10-06/01-comps-as-folders.md` (laubsauger/loom#3) §2.2, §3.2, §4 stage 1, §6.4. Upstream T1701b rates these paths "low regret".

## The bug, restated

`withUniqueNames` (flatten.ts) makes every label globally unique on the flat graph and renumbers
collisions inside instances. That keeps references *inside* an instance pointing at that instance's
own nodes (B41, §V320/§V321). But an outer reference can only reach in by a bare name, and a bare
name binds whichever copy kept its spelling, which is the first one. Instance a Projector three times
and an outer Render naming `projector_beam` binds copy 1 three times, or binds copies 2 and 3 not at
all. No diagnostic is raised.

## Decisions

1. **A path segment is a node's NAME (its label), as written in the graph it lives in.**
   - For a node inside an instance, that is the label in the *definition*, never the B41-renumbered
     flat label. An author never sees the flat label.
   - The flat id (`inst/inner`, built from ids) stays the machine address. `addressing.ts` owns it.
   - A path is the human address, and it resolves to a flat id.
   - An instance with no label has no path, the same rule as any unnamed node (§V127).

2. **Syntax: relative only.**
   - `a/b`: relative to the graph the referring node lives in.
   - `../x`: one level up, to the graph that holds the referring node's instance. `..` may repeat.
   - There is no absolute form. At the root a relative path already is the absolute one.
     Inside a definition, `/a/b` would name a document the definition cannot know, and a
     rename could not tell whether it was running at the root.
   - A leading `/`, an empty segment, and a `..` after a name are malformed.
   - There is no `.` segment.
   - A token with no `/` is a bare name and keeps today's rules (see 4).

3. **Mechanism: resolve once, at flatten, in the same walk as B41.**
   - Flatten already knows every level's authored labels, every instance's label and its scope.
   - After the walk, each path reference on the flat graph is rewritten to the target's
     (unique) flat label.
   - Every downstream reader stays unchanged: source-reference synthesis, the `op()` reader,
     liveness, channels, and the dependency walk over the flat graph.
   - A path that does not resolve is left as written and hits the existing refusals:
     `sourceReference.missing` is an error that names the path, and a failed `op()` falls back
     to §V108 with its reason.
   - Parsing and resolving a path go in `addressing.ts` (`parseNodePath`, `resolveNodePath`), so
     `flat-id-joiner.test.ts` stays green and there is still only one joiner.
   - Covered: `op('…')` in expression bindings, and every `SOURCE_REFERENCE_PARAMETERS` entry
     (Render scenes/camera/lights/projectors, Light casters, Geometry material, Feedback source,
     the renderers' camera, Camera Blur, Window, Layer).

4. **Bare names: resolution unchanged, plus a deprecation warning when one reaches INTO an instance.**
   - New code `compiler/reference-cross-scope` (warning), registered in `classes.ts` and `class-reasons.ts`.
   - It fires when a bare `op()` or source-reference name lands on a node that is neither in the
     referrer's own graph nor in one of its ancestors' graphs.
   - The message gives the path to write. When the name is carried by N instances, it also says
     that only the first one binds, which is the silent mis-bind made visible.
   - Reading OUTWARD stays silent: a component reading a root node by bare name is ordinary
     lexical scope.
   - Old files keep working exactly as they do now. Nothing changes until someone writes a path.
   - Known pre-existing quirk, documented and not changed: with three nested levels, a bare name
     that the middle level shadows resolves to the root node rather than the middle one, because
     B41 rewrites only a level's own references. Under true lexical scoping it would bind the
     middle node. Changing that changes how old files behave, so it is left for stage 2.

5. **Rename (§V128).**
   - Renaming node `x` rewrites, in the same patch:
     - bare `x`, as today;
     - paths whose first segment is `x`, in the same graph (`renamedPathHead`).
   - Not rewritten:
     - a path that reaches into a definition from outside, when a node inside the definition is
       renamed (the definition is shared and does not know its users);
     - `../x` written inside a definition.
   - Both cases are exactly where bare names stand today. The dangling path is an error that names
     the path. Stage 2 (folders) closes this.
   - B41's internal renumbering will NOT rewrite paths. It keeps rewriting bare names only, so a
     path is always read in authored-label space.

6. **`/` in labels: converted at the naming door, refused at the exact doors.** This follows TD's
   `tdu.validName`, which turns illegal characters into underscores, slashes included.
   - `node.rename` already does what `validName` does: a name that does not conform goes through
     `roleFromText`, which turns every run of characters other than letters, digits and `_` into
     one `_`. So `rig/a` becomes `rig_a` there, as it did before.
   - The doors that store a label exactly (`addNode` with a label, `setNodeLabel`, and so
     `rename` with `exact: true`) store what they are given (§V324), so they refuse instead. The
     code is `node.label.separator`, and the suggestion names the `validName` form.
   - Only `/` is refused. Spaces and other characters still pass the exact doors, as they did,
     because older documents and agent patches use them.
   - No shipped document has a `/` in a label. A node already labelled `a/b` still loads, but it
     is unaddressable by name until it is renamed.

7. **`kind_role` (T1593b).**
   - Each segment is a node name and conforms on its own: `projector_left/projector_beam`.
   - A path is not a name. It has no kind and is never kind-prefixed.
   - `node-names.test.ts` is unaffected.

## Out of scope (rows that already exist or follow)

- `parent()` in expressions (VN36).
- Nested override keys (VN33's codec).
- Paths in preset targets, panel boards, cue lists and Channel In.
- The inspector's authored-graph `op()` read reaching into an instance. A bare name does not reach
  there today either, so this is not a regression. It's for stage 2 or a follow-up row.

## Gate (the PR's claim), Dawn, through the app's commands

- **Setup.** One `projector_beam` saved as component "Projector" and instanced three times. Each
  instance gets its own aim and a pure R, G or B cookie through VN33's `internalNodeId` overrides.
  The outer `render_stage` names
  `projectors: "projector_left/projector_beam projector_mid/projector_beam projector_right/projector_beam"`.
- **Claim.** Each third of the stage is lit only by its own projector's colour, which is only
  possible if three different projectors are bound.
- **Red-verify.** Against today's code the paths dangle (`sourceReference.missing`). The literal old
  bug gets a test of its own: the bare `projector_beam` lights only the left third, and now also
  raises `compiler/reference-cross-scope`.
- **Unit tests.**
  - Path parse and resolve: relative, `..`, malformed, not found, through an unlabelled instance.
  - The rename rewrite of path heads.
  - The label refusal.
  - The cross-scope warning firing for inward bare names and staying silent for outward ones.

## Measured

- **Shipped documents.** Every example and starter component, and every project under
  `projects/`.
  - Not one shipped example raises `compiler/reference-cross-scope`.
  - `projects/stage-previz/stage-previz-8.loom.json` raises 52 warnings, one per node and name.
    These are exactly the leaks proposal 01 §2.2 describes. Converting that file to paths is
    its own change.
- **Cost.** The pass adds about 0.15 ms to a flatten of stage-previz-8 (0.53 to 0.68 ms on an
  M-series Mac). Flatten runs once per document revision, not once per frame.
