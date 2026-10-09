# Loom test-suite audit — 2026-10-09

The suite contains substantial useful verification, but its case count exaggerates the
number of independent behaviors. The problem is concentrated in source-policy checks,
repeated example work and expensive collection. CSS tests are not most of the suite.

## Scope and evidence

Baseline collected test names with Vitest's `list` command, then inspected declarations,
assertions, source readers, scripts and CI. Collection does not execute test bodies, but
module imports can perform work. Counts below are registered cases, including conditional
skips; they are not coverage percentages or runtime measurements.

| Baseline inventory | Count |
| --- | ---: |
| Registered Vitest cases | 16,667 |
| Vitest files | 1,122 |
| Cases under `src/examples` | 3,095 across 119 files |
| Gate cases / files | 3,769 / 64 |
| GPU test files within the headless Vitest lane | 246 |
| Playwright spec files | 57: 42 editor/domain, 15 real GPU |
| Native Node test files | 18; `desktop:check` selects 14 |

After cleanup, collection reports **14,454 cases in 1,119 files**, including
**2,192 example cases** and **2,186 gate cases in 61 files**. Removed 2,273 registered
recipe/duplicate cases; 60 cases were added across the current shared tree, including
49 for facade preparation, depth-driven effects and its import coverage, and 11 from
concurrent node/viewer work. The net change is 2,213 fewer cases (13.3%). Case reduction
is not a measured runtime reduction.

Test source is about 318,518 lines / 15.49 MB, compared with 325,385 lines / 15.85 MB
of non-test TS/JS source in the inspected scope. This ratio alone does not establish waste.
No snapshot or screenshot-baseline assertions were found. CI runs lint, typecheck,
native desktop checks and build, but **no Vitest or Playwright tests**. There is no
configured coverage report or threshold, so a coverage claim would be unsupported.

## Styling and source policy

Twelve Vitest files read CSS source directly, about 1.1% of files. Their 1,466 registered
cases mix useful integrity checks with styling recipes. Static searches also found style
markers in 34 unit files and 15 browser files; those are candidates, not waste counts.

The clearest inflation was `tokens.test.ts`: 1,348 cases, including 1,320 instances of
one per-source-file literal-colour scan. That scan alone was 7.9% of the entire case
count and 35.0% of gate cases. It inspected unrelated TS tooling and browser specs,
and could reject a colour in a test expectation rather than in production styling.
Case share does not establish runtime share: one cached run of the token scanner took
about 146 ms, while imports, compilation, native processes and GPU work cost more.

Other brittle checks pinned exact hex values, fonts, radii, hue spacing, CSS class/import
names, `width: max-content`, dot sizes, padding source expressions and a fixed caller
count. The prose guard enforced character/sentence budgets while imported text could
bypass it. These checked recipes rather than user outcomes.

Removed the palette/typography recipes, per-file literal-colour cases, import/class-name
policing, CSS-only readout reservation tests, numeric-control CSS parsers, affordance
colour recipes, editorial copy budget, colour-picker source-site gate and example prose
keyword gate. Kept contrast, focus/reduced-motion support, undefined-variable detection,
semantic token mappings, real control gestures, refusal, keyboard navigation, text fit
and stable layout checks. A browser File-menu test now permits additional actions and
checks End navigation against the last enabled item.

Source inspection is not inherently useless. Negative type contracts, forbidden mutation
paths, fresh-process import safety and asset/source regeneration equality protect things
that ordinary output tests can miss. Some recipe checks remain, including exact geometry
source forms and fixed example gutters; they still deserve review. This pass does not
claim to have eliminated every brittle assertion.

## Example suite

The 3,095 example cases cover the shipped catalogue and starter components, not the five
photo-mapping looks. Sixteen files generated 2,447 cases (79%). The main runner's 741
cases repeated ten checks per example, performing twelve load/compile passes and four
mock backend builds per example. Its replay traces are mock execution checks, not proof
of rendered pixels.

Consolidated the runner to one comprehensive case per example plus inventory: 75 cases,
two independent load/compile passes and two replay builds. All distinct assertions remain.
Removed 74 document-only roundtrips already covered more strongly by full-library
save/reopen authorability checks, 13 weak component roundtrips, 74 duplicate thumbnail
existence cases and 76 prose keyword cases. Thumbnail readers now fail directly for a
missing file instead of returning silently.

The driven-channel file formerly performed 87 × 2,000 = 174,000 CPU frames during import,
even for filtered runs and test collection. Motion evaluation is now lazy per selected
fixture; the complete stationary-channel ledger still requests the complete sweep.
One same-example filtered comparison fell from 9.54 to 2.05 seconds, largely in collection.
This is a local observation, not a controlled whole-suite speedup claim.

Retained GPU pixel proofs, feedback/reset behavior, resource lifetimes, authorability,
reference/channel integrity and generated-file drift. Fewer registered cases here mainly
reflect consolidation and duplicate removal, not fewer independently verified outcomes.

## SPEC cleanup

Baseline `SPEC.md` was 3,189 lines, 1,910,943 bytes and about 301,899 words; very long
single-line histories made line count misleading. Existing archive content was another
1,976,321 bytes. Moved closed task rows, long historical task/contract narratives, bug
reports and the parallel-work plan into the archive with stable linked pointers.

All 511 open statuses remain unchanged. The original archive prefix is byte-identical,
and 314 new archive links retain access to full evidence and caveats. Live SPEC is now
about 1.51 MB, a 21% reduction despite current feature-contract updates. It remains about
3,000 lines and still needs evidence-based triage; old open rows were not declared complete
just because their prose sounded historical. Active amendments, exceptions and pending
work remain in the live contract or its explicit pointers.

## Remaining priorities

1. Add useful CPU/jsdom behavior checks to CI. Lack of a GPU does not explain omitting
   all Vitest tests. Choose a portable lane deliberately; the current `headless` lane also
   includes GPU files and local-device integration.
2. Separate routine validation from broad audit commands. Running `test`, gates,
   first-import and the complete headless lane together repeats many of the same checks.
3. Review remaining source recipes individually and remove expensive import-time work.
   Preserve independently checked file bytes, real compiler invariants and pixel proofs.
4. Triage open SPEC rows against current implementation before archiving more. Avoid
   replacing authoritative requirements with inferred completion.

The policy in AGENTS.md and SPEC.md now says tests should target behavior, integrity,
accessibility and measured performance constraints, rather than palette/CSS/copy recipes.

## Validation of this change

- `pnpm typecheck`: passed.
- `pnpm lint`: passed with four existing warnings; subsequent changed-file ESLint passed.
- Six preparation/model files: 159 passed, one optional external-signature-fixture skip.
  The bundled model's real browser inference was independently exercised.
- Revised float-map/effect GPU file: 16 passed, including all five modes' depth sensitivity,
  motion and exact mask-hole clipping. Actual facade renders compiled without diagnostics.
- Photo mapping and header browser specs: 12 initially passed; both remaining checks
  passed after fixing stale menu/interceptor assumptions. All 14 are verified.
- Gates: 2,185 initially passed; the sole helper socket test timed out inside the sandbox
  and passed separately with loopback binding available. No timeout was raised or test dropped.
- Fresh-first-import checks: 307 passed.
- `pnpm build`: passed; the model emits as a separate 12,099,327-byte asset.
- `git diff --check`: passed. No Git history or staging operation was performed.

The full suite was collected for inventory, not executed. No full-suite pass, coverage
percentage or whole-suite performance gain is claimed.
