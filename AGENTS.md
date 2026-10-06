# AGENTS.md

## Scope

These instructions apply to the entire repository. `SPEC.md` is the authoritative product and architecture contract; read the relevant section before changing behavior.

## Non-negotiables

- Never commit, checkout, reset, rebase, or otherwise rewrite Git history.
- Preserve unrelated and uncommitted user changes. Inspect the worktree before editing.
- Fix root causes. Do not add silent catches, speculative compatibility paths, or fallback behavior for core functionality. Surface an explicit diagnostic or throw when an invariant cannot be satisfied.
- Use current stable APIs and verify time-sensitive assumptions instead of choosing legacy patterns by default.
- Use pnpm. Keep the exact package-manager version declared in `package.json` as the single source of truth.
- Do not introduce Tailwind; this project uses Radix primitives, CSS variables, and CSS Modules.
- If a shadcn component is explicitly required, install it with the official shadcn CLI. Never recreate one from memory.
- Never run `pnpm deploy` unless the user explicitly asks to deploy production.

## Architecture

- All graph and project mutations go through `src/domain/commands`; do not create a second mutation path.
- Keep direct `vgpu` access inside `src/runtime/backend`.
- Keep the local device bridge in `src/devices` (OSC, laser, Apple Vision, and the loopback transport they share). It is not an agent surface: `src/mcp` and `src/app/use-*-bridge.ts` import it, and nothing under `src/devices` may import `src/mcp`.
- The helper is one process with two doors. `pnpm helper` opens both; `pnpm helper --devices-only` opens the device door alone (no MCP server, no tool surface, no GPU) — `createDeviceHelper` in `src/mcp/serve.ts`, which builds `bridge-host` WITHOUT a `headless` surface so the agent roles cannot be served at all. The command is spelled once, in `src/devices/helper.ts`, and `helper.test.ts` fails if any other file under `src/` spells it. `mcp:serve` survives as a `package.json` alias for one release.
- Keep domain, compiler, and runtime code independent of the DOM except at an existing documented adapter boundary.
- Pass time through `FrameEvaluationInput`; do not read wall-clock time in nodes or shaders.
- Keep persisted projects versioned and validated. Use the existing serializer and migration paths.
- Treat IDs as opaque stable identifiers, never array positions.
- Treat `examples/*.loom.json` and `examples/components/*.loom.json` as generated executable specifications. Never hand-edit them. For an example, edit its TypeScript source under `src/examples/documents/`, then regenerate only that example with:

```bash
node --import ./src/tooling/alias-hooks.ts src/examples/build-examples.ts --only <Name>
```

An E-number argument (`--only E2`) matches that one example EXACTLY (T1267, after B197: it used to be a substring match, so `--only E2` also regenerated E20–E29 and swept seven sessions' in-flight documents). Any other argument is still a substring match — `--only Reaction` takes both files that carry the word. The same rule and the same flag apply to `build-thumbnails.ts`, and both scripts print the list they are about to overwrite before writing a byte; read it.

Starter components are authored in `src/examples/starter-components.ts` and regenerate through the same script and the same flag, addressed by the file name they ship under: `--only Bloom` writes `examples/components/Bloom.loom.json` — and, because that is the substring branch, also the two examples whose names carry "Bloom". One flag, one rule, both halves (T1221); the printed plan is what shows you the blast radius, and `--out <dir>` writes it somewhere harmless first. Regenerating a component no longer needs the unscoped run, which sweeps every peer's in-flight work.

## Working method

- Read nearby implementation and tests before editing; follow existing module boundaries and naming.
- Make the smallest coherent change that fully solves the problem. Avoid unrelated cleanup.
- Add or update tests for changed behavior, including the failure mode that motivated a bug fix.
- Run the narrowest relevant test while iterating, then validate the affected surface.
- Use the repository commands, not bare `tsc` or an ad hoc test configuration.

## Validation

For application or shared-library changes, run:

```bash
pnpm lint
pnpm typecheck
pnpm test        # >2 min. Prefer the ladder below.
pnpm test:gates  # ~15 s. The 59 gate files no selector can find. Not optional. Cap with `--maxWorkers=2` and no `--` before it.
pnpm test:first-import  # every domain/compiler/runtime module as the first module of a fresh node (V1028)
pnpm build
```

**Tests follow the blast radius** (owner, 2026-10-05). Never run a directory-wide vitest (`src/examples`, `src/app`, …) or an every-example file (`runner.test.ts`, `examples.gpu.test.ts`, `catalogue-dawn.gpu.test.ts`, `cook-oracle.test.ts`) without a `-t` filter; run the examples that use what you changed. Run `pnpm test:gates` only when the change adds, moves or deletes files under `src/`, or changes a node definition's shape, a command, a factory, a shipped example or its `.md`, `package.json` or eslint config, and then once; a project-only edit under `src/projects/**` does not need it. **Scope your test runs.** Run `pnpm vitest run <paths>` for what you touched, then `pnpm test:gates` (~15 s) — those 57 files walk the source tree or the document set rather than importing what they check, so nothing else selects them (§V957) and they are what catch a factory you orphaned, a command you left uncovered, or two nodes drawn on top of each other in a shipped example. The list is derived rather than remembered: `gate-list.test.ts` fails when a tree-walking test is missing from the script (T1273). Do not run the full `pnpm test` unless the owner asks for it; after a change to a shared abstraction, a registry, a domain type, a generated artefact, or a file move, widen the scoped run to the directories the change reaches. Run anything heavy (GPU/Dawn tests, Playwright, `pnpm build`, `pnpm test:gates`, project render scripts, vitest over more than about twenty files) through `tools/heavy.sh <command…>`, a machine-wide queue with two slots that every session and worktree shares. `pnpm typecheck` always. `pnpm vitest related --run <changed files>` picks the first step off the module graph; it still cannot see the gates.

Also run `pnpm test:headless` for backend, rendering, or WGSL changes and `pnpm test:e2e` for browser interaction changes when the environment supports them. Report commands that could not be run and why.

Playwright has two projects and neither opens a window (T1616b). `chromium` runs the headless shell, which resolves no WebGPU adapter, and carries the editor and domain specs. `chromium-gpu` runs the full browser headless on the machine's real GPU and carries the pixel specs named in `NEEDS_A_REAL_ADAPTER` in `playwright.config.ts`. A spec file runs in the one project that matches it, so naming the file is enough. Playwright's `--headed` puts the run in Chromium windows on the owner's desktop: use it to watch one spec, never for a gate run.

## Node names are `kind_role` (T1593b)

A node's name carries its kind as a prefix: `slider_lamp`, `light_lamp`, `blur_diffuse`, `kernel_joints`. The kind is one lowercase word per node type, declared in ONE table, `NODE_KINDS` in `src/domain/graph/node-kinds.ts` (`pointKernel` is `kernel`, `movieFileIn` is `movie`); then one underscore; then the role, which holds letters, digits and underscores only. A new node is auto-named kind plus a number (`blur1`), which already conforms. Full rule, the table and the phase 2 plan: `docs/node-naming-2026-10-05.md`.

- `conformsToKind(name, kind)` is the one answer to whether a name conforms. Do not write a second regex.
- A component instance is named for its COMPONENT: an instance of Bloom is `bloom1`, then `bloom_glow`. Its kind is the component's own name, lowercased, letters only, and it is not in the type string (a component's id is minted), so ask `kindOf(definition)`; `kindOfType(type)` refuses an instance type. A new instance is auto-named (from the library, an import or an `addNode`; the one a saved selection becomes follows with the phase 2 sweep, because it changes the shipped starter component files). Renaming a component renames no node.
- In a document source, `named(role, type, …)` (`src/examples/documents/builders.ts`) writes the name from the role alone, and `namedInstance(role, componentName, type, …)` does it for a component instance. New examples, projects, tests and fixtures use `kind_role`.
- A new node type needs a row in `NODE_KINDS`; sharing a kind with another type needs an entry in `KIND_FAMILIES`.
- `node.rename` puts the kind in front of a name that lacks it and says so; `exact: true` stores a name as given. A `label` inside a patch (`addNode`, `setNodeLabel`) is always stored exactly: write it in full. The agent tool `apply_graph_patch` stores it and WARNS when it lacks its kind (`data.unconformingLabels` gives the conforming form).
- Through the MCP tools: `add_node` with a `label` and `rename_node` add the kind when it is missing, and `data.name` in the result is the name that was stored. Write `op('…')` from that, not from the label you asked for. `list_node_definitions` gives each type's `kind`.
- Stored names never move. Changing a kind renames nothing in any document.
- `src/examples/node-names.test.ts` (on `test:gates`) fails a shipped node whose name lacks its kind. Files written before the rule are in its `NOT_YET_RENAMED` ledger with the exact count each still owes; the count must match, so it can only go down. A component's In and Out are exempt: their name is the socket's label.
- A surface with room for one word (a Panel board, the Layers list, the phone) captions a Presets bank, a Layer, a Cue List and an untitled Panel by the ROLE of the name: `presets_looks` reads `looks`. Use `surfaceNameOf(node, catalogue)` (`src/nodes/definitions/controls.ts`); it is a caption, never an address, and a name that does not carry its kind is shown whole.
- Below 70 % zoom every node carries a label, its kind and then the rest of its name, that does not shrink with the canvas (T1597b, `src/editor/nodes/kind-label.ts`). The canvas writes the zoom on each label element; never put it on an ancestor of the nodes as an inherited custom property (measured: twelve times the cost).
