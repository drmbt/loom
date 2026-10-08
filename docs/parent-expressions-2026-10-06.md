# `parent()` in expressions (VN36)

COMP-model proposal 01 §2.3 and proposal 02 (the `parent.<key>` row). Stacked on VN35
(`a5c77599`).

## What it is

```
parent().par.gain * 0.5 + op('lfo_wobble').chan.value
parent(2).par.throw            two components out
parent().par.tint.r            one component of a published compound (§V113)
```

`parent()` is `parent(1)`, and `n` is a positive integer literal. After `parent(n)` the
grammar takes `.par.<key>` with an optional `.<component>`, and nothing else. That is
checked at parse time, so `parent().chan.x` and `parent(0)` are syntax errors that say what
to write. A bare `parent` is still a variable name; only `parent(` changes meaning.

The AST gains `{ kind: "parentRef", hops, path, at, end }`. The span is a pure function of
the text, so the parse memo (T1172) still holds. The three exhaustive walks over
`ExpressionAst` handle the new node. A `parentRef` is not an `op()` dependency in the
authored document (§V81: a lexical read, never an edge). Reaching the evaluator unrewritten
means the expression is not inside a component, and it fails as `reference.unreadable` with
that reason. It never reads 0.

## How it reads: a name at flatten, a value per frame

This follows TouchDesigner. `parent()` returns the parent COMP, its `.par.Gain` evaluates
once where it lives, and readers get the number. They never get the formula.

1. **Flatten resolves a name** (`src/compiler/parent-references.ts`, called beside
   `effectiveParameters`). `parent(n).par.key` becomes
   `op('<the n-th enclosing instance>').par.key`. It runs as each node's parameters are made,
   including an instance's own page. That ordering matters for T1017: an animated page slot
   is carried INWARD onto its targets as text, and a `parent()` inside it means the component
   around the instance. Resolved here, it is carried as a name, which means the same thing
   at every depth. In VN35's end-of-walk pass it would be resolved one level too deep (a
   test pins this).
2. **The reader reads a dissolved instance's page** (`node-references.ts`). Flattening
   deletes the instance node. Its page survives as `FlattenedGraph.instancePages` (label →
   the instance as flattened, plus its published schema), and `op('<instance>').par.<key>`
   resolves there through the same `targetOf` as any node. This is T1485b's shape for
   `.chan`, applied to `.par`. So an animated knob is evaluated once per frame at its
   publisher, and an edit to it reaches every reader with the next flattening.
   `flattenComponents` stays a pure function of the document (§V529).

Same rule as §V81: the read goes through the published page (§V80) and only that. A value
set on a nested instance's page, or on a private nested page, is read exactly where it is
set. `publishedKeyOrigins` is not involved.

As a side effect, `op('comp1').par.gain` from OUTSIDE a component is readable too. That is
TD's idiom.

### What sees the page

- **`FlatteningReads.instancePages` is required** (T1551b's rule). Every reader site says it:
  the compile and the per-frame compile (beside `resolution.instances`), the value graph, the
  OSC pump, parameter commands, the controls pane, the inspector (the root flattening's
  pages while you are inside an instance), and the test harnesses.
- **Value-graph order.** The dependency walk follows `op('<instance>').par.<key>` into the
  page and on to whatever the page knob reads. A Constant inside a component that reads a
  page knob reading a root LFO therefore evaluates after the LFO in the same frame, not one
  frame late. (T1485b's `.chan` branch had been catching `.par` reads of an instance name
  too. It is now channel-only.)
- **Liveness.** `pruneToActiveSinks` adds each page as a liveness node that is never a
  candidate, so a node read only by a page knob, through `parent()`, is not reported dead.

## Diagnostics

Both are warnings, and both fall back to the slot's retained static (§V108), exactly as a
failing `parent.` bind does. One problem gives one diagnostic, and the value is never 0.
Class `never`.

| code | when |
|---|---|
| `compiler/parent-reference-no-parent` | `parent()` on a root node, `parent(n)` past the outermost component, or an enclosing instance with no name |
| `compiler/parent-reference-unknown-key` | the component publishes no `key`. Lists what it does publish, with the nearest spelling |

A component name the page lacks, or a compound read whole, is refused per frame by the
reader, like any `op()` read. At the root, `flatteningIsIdentity` treats a `parent()` read as
it treats a `parent.` bind: it takes the full walk, so the diagnostic is raised.

## Detach

`component.detach` lands the copies at the instance's own level. `parent(n ≥ 2)` loses one
hop. `parent().par.k` becomes what the page key is from that level:
- its carried `parent.` source, re-aimed as a `parent()` read;
- the instance's own expression for it, inlined (it was written at that very level);
- or its value.

A read the copies cannot make the same way is reported (`component.detach.inexact`), and
the copy holds its static. `nestedParentReads` counts `parent(n)` too.

## Unchanged

- `parent.<key>` binds keep their current behaviour. That includes the fact that a bind
  BAKES the page value, so an animated knob does not animate through a bind; only the §V80
  fan-out and now `parent()` carry it live. VN38 migrates binds.
- Reference cycles (§V152). A ring through the boundary (a page knob reads an inner node
  that reads `parent()`) is a plain `(node, key)` ring for the reader's guard, which names
  it at runtime. The authoring-time refusal does not see it yet.
- Rename (§V128). `parent()` names no node. The rewritten name is a flattening artifact and
  is never stored.

## Stage-1 bridge

`instancePages`, the value-graph look-through and the liveness entries exist because the
instance is dissolved. Once a COMP is a real node in the flat graph (proposal 01 stages 2–3),
the name index finds it and they retire together. The grammar, the rewrite to a name, and
the diagnostics are permanent.

## Tests

- Dawn (`parent-expressions.gpu.test.ts`), through the app's commands: Lamp (a Solid, red =
  `parent().par.gain`, green = `1 - parent().par.gain`), placed twice with gain 1 and 0,
  renders pure red and pure green. With the publish cut, both instances render their static
  black and raise four `unknown-key` warnings. An animated page knob (`frame % 2`) gives two
  frames and two colours.
- Integration (`parent-expressions.test.ts`): two instances; animated; cut; misspelt key;
  `parent(2)`; a nested page value; a nested page that itself reads `parent()`; a page slot
  carried inward (T1017); too deep; root; value-graph order; liveness.
- Reader (`instance-parameter-reference.test.ts`): page value, animated, a component, an
  unknown key, and the per-frame values-only compile against the full compile.
- Grammar (`parent-reads.test.ts`), detach (`detach.test.ts`).
- Every gate red-verified by editing the code and restoring it.

## Next

- VN60: delete stage-previz-8's 17 knob holders onto `parent()`.
- Preset morphs through `parent()`: the reader resolves the page node by its flat id, and
  the morph index keys a root instance's fade by that same id, so it should fade. No test
  pins it yet.
- Completion: offer `parent().par.` keys, and `op('<instance>').par.` keys (§V150 allows
  offering less than the reader accepts, and this does).
- Authoring-time refusal of a ring through the boundary is implemented at landing (see below).
- VN38 (two-way bind) and VN43 (`parent.Name` shortcuts).

## Landing on validated VN35

This change is ported onto the repaired VN35 implementation rather than restoring #4's
unchecked writer. Dissolved pages pass through the same path resolution as physical nodes,
and `op('outer/inner').par.key` can name a nested instance's published page. Page records
contain only schema-declared parameters and compound components.

The command-time validator and saved-file compiler validator share a reference graph that
includes published pages. Definition-only publication is checked before registration: a
newly executable cycle is refused, including dry runs, while an unrelated edit remains
possible in a file carrying an existing cycle. Lexer whitespace before `parent (` is
handled by the AST span walker, including tabs, newlines and multiple spaces.

The app-command lamp fixture also has a CPU compiler proof of independent red/green values.
The Dawn pixel checks remain required and fail explicitly when no adapter is available.
