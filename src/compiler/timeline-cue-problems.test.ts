import { describe, expect, it } from "vitest";

import { componentNodeType, createComponentSystem } from "../domain/components/index.ts";
import { resolveParameters } from "../domain/parameters/resolve.ts";
import { testRead } from "../domain/parameters/test-support.ts";
import type { Preset } from "../domain/presets/bank.ts";
import { serializeCueList, type Cue } from "../domain/presets/cue-list.ts";
import { easeMorph } from "../domain/presets/morph.ts";
import { presetBankNode } from "../domain/presets/test-support.ts";
import { timelineCueWarnings } from "../domain/presets/timeline-cues.ts";
import type { GraphComponentDefinition } from "../domain/types/components.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { FrameEvaluationInput } from "../domain/types/frame.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";
import type { ParameterValue, StoredParameter } from "../domain/types/parameters.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { compileGraph } from "./compile.ts";
import { flattenComponents } from "./flatten.ts";
import { testCapabilities, testSettings } from "./test-support.ts";
import type { CompiledGraph, CompileRequest } from "./types.ts";

/**
 * §T1559b (2), owner ruling 2026-10-05 — A TIMED CUE READS ITS BANK'S MORPH AS STORED, AND SAYS
 * SO WHEN THE MORPH IS DRIVEN.
 *
 * A timed cue writes nothing: its fade is recomputed at every playhead, which is what makes
 * playback, a cold seek and an export agree (§T1508b), and a live Morph has no moment to be
 * read at that keeps that. So the fade stays on what the document says, and the person who
 * put an expression on the bank's Morph is told — in the compile's diagnostics, which is the
 * Problems list in both composition roots — that the timed cues do not follow it.
 *
 * Everything here is read off `compileGraph`: the diagnostic the Problems list shows, and
 * the uniform the GPU reads at a playhead, against the STORED seconds and not the driver's.
 * The other door — GO reads the same Morph LIVE — is `cue-commands.test.ts`, "§T1557b — GO
 * on a bank whose Morph is op('k1').chan.value"; it is not repeated here.
 *
 * THE SHOW: white Solid → Level (brightness 0.2) → Output; bank `looks` takes it to 0.8,
 * Curve linear; cue A at 1.0 s carries no morph, so the bank's Morph is its fade. The driver
 * reads a Constant holding 0.5, and the slot's stored value is 2 — a 2 s fade and a 0.5 s fade.
 *
 * AND (lead's ruling, same day) EVERY `cue.timeline.*` WARNING REACHES THE COMPILE: a timed
 * list that cannot fire as written is a problem to see without opening the list's
 * inspector. The last two blocks hold each of the six older warnings in the compile's
 * diagnostics, with the node and the sentence the list's own surfaces show, once.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();
const FPS = 30;
const DRIVEN = "cue.timeline.drivenMorph";

/** The resolver's blend, verbatim (`resolve.ts`), so an expected value is the same double. */
const mix = (a: number, b: number, t: number): number => a * (1 - t) + b * t;

const node = (id: string, type: string, label: string, parameters: Record<string, StoredParameter> = {}): GraphNode => ({
  id,
  type,
  label,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
});

const edge = (id: string, from: readonly [string, string], to: readonly [string, string]) => ({
  id,
  source: { nodeId: from[0], portId: from[1] },
  target: { nodeId: to[0], portId: to[1] },
});

/** A slot in expression mode over a retained static: what the document stores, and what drives it. */
const driven = (source: string, stored: ParameterValue): StoredParameter => ({
  mode: "expression",
  bindings: { static: { kind: "static", value: stored }, expression: { kind: "expression", source } },
});

const BRIGHT: Preset = { name: "bright", values: { level1: { brightness: 0.8 } } };
const CUE_A: Cue = { name: "A", bank: "looks", preset: "bright", at: 1 };

const cueList = (cues: readonly Cue[], follow: "live" | "timeline"): GraphNode =>
  node("show", "cueList", "show", { follow, cues: serializeCueList({ version: 1, cues }) });

interface ShowOptions {
  readonly morph?: StoredParameter;
  readonly curve?: StoredParameter;
  readonly presets?: readonly Preset[];
  readonly cues?: readonly Cue[];
  readonly follow?: "live" | "timeline";
  /** The cue list nodes, in place of the one list `show` (which `cues` and `follow` describe). */
  readonly lists?: readonly GraphNode[];
}

function show(options: ShowOptions = {}): GraphDocument {
  const nodes = [
    node("src", "solid", "solid1", { color: [1, 1, 1, 1] }),
    node("grade", "level", "level1", { brightness: 0.2 }),
    node("out", "output", "out1"),
    node("k1", "constant", "k1", { value: 0.5 }),
    presetBankNode("looks", "looks", "level1", options.presets ?? [BRIGHT], { morph: options.morph ?? 2, curve: options.curve ?? "linear" }),
    ...(options.lists ?? [cueList(options.cues ?? [CUE_A], options.follow ?? "timeline")]),
  ];
  return {
    revision: 1,
    groups: {},
    nodes: Object.fromEntries(nodes.map((each) => [each.id, each])),
    edges: {
      e0: edge("e0", ["src", "out"], ["grade", "input"]),
      e1: edge("e1", ["grade", "out"], ["out", "input"]),
    },
  };
}

/** Frame `n` of a 30 fps timeline: `timeSeconds` divided, as both transports do. */
const frame = (n: number): FrameEvaluationInput => ({
  timeSeconds: n / FPS,
  deltaSeconds: 1 / FPS,
  frameIndex: n,
  mode: "offline",
  randomSeed: 0,
  fps: FPS,
  subframes: 1,
});

const requestFor = (graph: GraphDocument, extra: Partial<CompileRequest> = {}): CompileRequest => ({
  graph,
  settings: testSettings(),
  registry,
  capabilities: testCapabilities(),
  ...extra,
});

/** Every cue diagnostic the compile carries — what the Problems list shows of the cue lists. */
const cueProblems = (plan: CompiledGraph): RuntimeDiagnostic[] => plan.diagnostics.filter((each) => each.code.startsWith("cue."));

/** The Level's brightness in its pass's uniform block at frame `n` — the value the GPU reads. */
function brightnessAt(graph: GraphDocument, n: number): unknown {
  const plan = compileGraph(requestFor(graph, { resolution: { frame: frame(n) } }));
  const pass = plan.passes.find((each) => "nodeId" in each && each.nodeId === "grade" && "uniforms" in each);
  if (pass === undefined || !("uniforms" in pass)) throw new Error("no uniform pass for the Level");
  return pass.uniforms?.["brightness"];
}

/** The bank's own setting as a LIVE read sees it at frame `n` — the read GO makes. */
function liveSetting(graph: GraphDocument, key: string, n: number): unknown {
  const bank = graph.nodes["looks"] as GraphNode;
  return resolveParameters(bank, registry.get(bank.type), testRead({ graph, registry, frame: frame(n) })).values[key];
}

describe("§T1559b (2) — a timed cue list on a bank whose Morph is driven", () => {
  it("is said once, on the bank, naming the list, the bank, the parameter and the stored seconds — and the fade runs for the stored 2 s, not the driver's 0.5 s", () => {
    const graph = show({ morph: driven("op('k1').par.value", 2) });
    // The driver is real: a live read of the bank's Morph (GO's read) says 0.5 s.
    expect(liveSetting(graph, "morph", 45)).toBe(0.5);

    const said = cueProblems(compileGraph(requestFor(graph)));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ severity: "warning", code: DRIVEN, nodeId: "looks" });
    const message = said[0]?.message ?? "";
    expect(message).toContain('Cue list "show"');
    expect(message).toContain('bank "looks"');
    expect(message).toContain("Morph is driven (expression)");
    expect(message).toContain("the stored value, 2 s");
    expect(message).toContain("GO on a live list and a direct Recall read the driven value");

    // Cue A is reached at frame 30. Half a second in, a 2 s linear fade is a quarter done;
    // a 0.5 s fade — the driver's — would already have arrived at 0.8.
    expect(brightnessAt(graph, 30)).toBe(0.2);
    expect(brightnessAt(graph, 45)).toBe(mix(0.2, 0.8, 0.25));
    expect(brightnessAt(graph, 60)).toBe(0.5);
    expect(brightnessAt(graph, 90)).toBe(0.8);
  });

  it("the warning is the same at every playhead and in a segment's compile — it is a fact of the document", () => {
    const graph = show({ morph: driven("op('k1').par.value", 2) });
    const settled = cueProblems(compileGraph(requestFor(graph)));
    expect(settled.map((each) => each.code)).toEqual([DRIVEN]);
    expect(cueProblems(compileGraph(requestFor(graph, { resolution: { frame: frame(45) } })))).toEqual(settled);
    const flattened = flattenComponents({ graph, registry, components: createComponentSystem(registry, []).components.view() });
    expect(cueProblems(compileGraph(requestFor(graph, { flattened })))).toEqual(settled);
  });

  it("a driven Curve is said the same way, and the fade is paced by the stored curve", () => {
    // The driver picks option 0 (Linear); the slot stores Smooth.
    const graph = show({ curve: driven("op('k1').par.value", "smooth") });
    expect(liveSetting(graph, "curve", 45)).toBe("linear");

    const said = cueProblems(compileGraph(requestFor(graph)));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ severity: "warning", code: DRIVEN, nodeId: "looks" });
    expect(said[0]?.message).toContain("Curve is driven (expression)");
    expect(said[0]?.message).toContain("the stored value, smooth");

    expect(brightnessAt(graph, 45)).toBe(mix(0.2, 0.8, easeMorph("smooth", 0.25)));
    expect(brightnessAt(graph, 45)).not.toBe(mix(0.2, 0.8, 0.25));
  });

  it("two timed cues on one bank say it once", () => {
    const graph = show({
      morph: driven("op('k1').par.value", 2),
      presets: [BRIGHT, { name: "mid", values: { level1: { brightness: 0.4 } } }],
      cues: [CUE_A, { name: "B", bank: "looks", preset: "mid", at: 4 }],
    });
    expect(cueProblems(compileGraph(requestFor(graph))).map((each) => each.code)).toEqual([DRIVEN]);
  });
});

describe("§T1559b (2) — what the warning must not swallow", () => {
  it("a static Morph says nothing, as a bare number and as a static slot — and fades over it", () => {
    for (const morph of [2, { mode: "static", bindings: { static: { kind: "static", value: 2 } } }] as StoredParameter[]) {
      const graph = show({ morph });
      expect(cueProblems(compileGraph(requestFor(graph)))).toEqual([]);
      expect(brightnessAt(graph, 45)).toBe(mix(0.2, 0.8, 0.25));
    }
  });

  it("a driven Morph on a bank that only a LIVE list fires says nothing: GO reads the driver", () => {
    const graph = show({ morph: driven("op('k1').par.value", 2), follow: "live" });
    expect(cueProblems(compileGraph(requestFor(graph)))).toEqual([]);
  });

  it("a driven Morph no timed cue reads says nothing: the cue, or its preset, carries its own morph", () => {
    const own = show({ morph: driven("op('k1').par.value", 2), cues: [{ ...CUE_A, morph: { seconds: 1, curve: "linear" } }] });
    expect(cueProblems(compileGraph(requestFor(own)))).toEqual([]);
    expect(brightnessAt(own, 45)).toBe(0.5);

    const presetOwn = show({ morph: driven("op('k1').par.value", 2), presets: [{ ...BRIGHT, morph: { seconds: 1, curve: "linear" } }] });
    expect(cueProblems(compileGraph(requestFor(presetOwn)))).toEqual([]);
    expect(brightnessAt(presetOwn, 45)).toBe(0.5);
  });

  it("an INSTANCE bank says nothing: its Morph is its definition's page bank's, which GO reads stored too", () => {
    /** A look publishing `gain`, holding a page bank whose Morph is driven. */
    const look = {
      componentId: "look",
      version: 1,
      name: "Look",
      graph: {
        revision: 1,
        groups: {},
        nodes: {
          src: node("src", "solid", "src", { color: [1, 1, 1, 1] }),
          grade: node("grade", "level", "grade", { brightness: 1 }),
          looks: presetBankNode("looks", "looks", "parent", [{ name: "bright", values: { parent: { gain: 0.8 } } }], {
            morph: driven("time", 2),
            curve: "linear",
          }),
        },
        edges: { e0: edge("e0", ["src", "out"], ["grade", "input"]) },
      },
      inputs: [],
      outputs: [{ externalId: "out", label: "Out", nodeId: "grade", portId: "out" }],
      parameters: [
        {
          key: "gain",
          definition: { type: "number", label: "Gain", default: 1, min: 0, max: 8, range: "floor" },
          targets: [{ nodeId: "grade", key: "brightness" }],
        },
      ],
    } as unknown as GraphComponentDefinition;
    const system = createComponentSystem(registry, [look]);
    const components = system.components.view();
    const nodes = [
      node("city", componentNodeType("look", 1), "city", { gain: 0.2 }),
      node("out", "output", "out1"),
      node("show", "cueList", "show", {
        follow: "timeline",
        cues: serializeCueList({ version: 1, cues: [{ name: "A", bank: "city", preset: "bright", at: 1 }] }),
      }),
    ];
    const graph: GraphDocument = {
      revision: 1,
      groups: {},
      nodes: Object.fromEntries(nodes.map((each) => [each.id, each])),
      edges: { e1: edge("e1", ["city", "out"], ["out", "input"]) },
    };
    const flattened = flattenComponents({ graph, registry: system.nodes, components });
    const request: CompileRequest = { ...requestFor(graph), registry: system.nodes, components, flattened };
    expect(cueProblems(compileGraph(request))).toEqual([]);
    // The cue does play, on the page bank's stored Morph (`time` at the zero frame: a cut).
    const plan = compileGraph({ ...request, resolution: { frame: frame(30) } });
    const pass = plan.passes.find((each) => "nodeId" in each && each.nodeId === "city/grade" && "uniforms" in each);
    expect(pass !== undefined && "uniforms" in pass ? pass.uniforms?.["brightness"] : undefined).toBe(0.8);
  });
});

/**
 * The cue problems of a compile, by every way a compile comes by them: asked for itself (no
 * catalogue), off the flattening it makes (a catalogue), off a flattening it is handed (the
 * app's, one per revision), and off that flattening at a playhead. The same list each time —
 * so nothing is said twice where the flattening's diagnostics and the compile's own meet.
 */
function said(graph: GraphDocument): RuntimeDiagnostic[] {
  const system = createComponentSystem(registry, []);
  const components = system.components.view();
  const bare = cueProblems(compileGraph(requestFor(graph)));
  const catalogued = requestFor(graph, { registry: system.nodes, components });
  expect(cueProblems(compileGraph(catalogued))).toEqual(bare);
  const flattened = flattenComponents({ graph, registry: system.nodes, components });
  expect(cueProblems(compileGraph({ ...catalogued, flattened }))).toEqual(bare);
  expect(cueProblems(compileGraph({ ...catalogued, flattened, resolution: { frame: frame(45) } }))).toEqual(bare);
  return bare;
}

describe("§T1559b (2) — every cue.timeline warning of a following list is in the compile's diagnostics", () => {
  it("untimed: a cue with no At, on the list, in the list's own words — and the timed cue still plays", () => {
    const graph = show({ cues: [CUE_A, { name: "C", bank: "looks", preset: "bright" }] });
    expect(said(graph)).toEqual([
      {
        severity: "warning",
        code: "cue.timeline.untimed",
        message: 'Cue "C" (show) has no At time, so the timeline skips it.',
        nodeId: "show",
        suggestion: "Give it a time, or run it from a second list that stays Live.",
      },
    ]);
    expect(brightnessAt(graph, 45)).toBe(mix(0.2, 0.8, 0.25));
  });

  it("bank: a cue naming a bank that is not there", () => {
    expect(said(show({ cues: [{ name: "A", bank: "nope", preset: "bright", at: 1 }] }))).toEqual([
      {
        severity: "warning",
        code: "cue.timeline.bank",
        message: 'Cue "A" (show): "nope" is not a Presets bank in this document; the timeline skips it.',
        nodeId: "show",
      },
    ]);
  });

  it("preset: a cue naming a preset its bank does not hold", () => {
    expect(said(show({ cues: [{ name: "A", bank: "looks", preset: "gone", at: 1 }] }))).toEqual([
      {
        severity: "warning",
        code: "cue.timeline.preset",
        message: 'Cue "A" (show): bank "looks" has no preset "gone" it can read; the timeline skips it.',
        nodeId: "show",
      },
    ]);
  });

  it("malformed: a following list whose Cues cannot be read", () => {
    const broken = node("show", "cueList", "show", { follow: "timeline", cues: "not a cue list" });
    const problems = said(show({ lists: [broken] }));
    expect(problems.map((each) => [each.severity, each.code, each.nodeId, each.suggestion])).toEqual([
      ["warning", "cue.timeline.malformed", "show", "Fix the Cues field."],
    ]);
    expect(problems[0]?.message).toMatch(/^Cue list "show" follows the timeline, but .+; it drives nothing\.$/);
  });

  it("overlap: two following lists on one key, said on each of them", () => {
    const first = node("la", "cueList", "a", { follow: "timeline", cues: serializeCueList({ version: 1, cues: [{ ...CUE_A, name: "1" }] }) });
    const second = node("lb", "cueList", "b", { follow: "timeline", cues: serializeCueList({ version: 1, cues: [{ ...CUE_A, name: "2", at: 4 }] }) });
    const overlap = {
      severity: "warning",
      code: "cue.timeline.overlap",
      message: 'Cue lists "a" and "b" both follow the timeline and both set "level1.brightness"; their cues run as one sequence, in time order.',
      suggestion: "Let one list set each value, or switch one of them to Live.",
    };
    // One row per list, each selecting its own list: the plan says it on both, and so does the compile.
    expect(said(show({ lists: [first, second] }))).toEqual([
      { ...overlap, nodeId: "la" },
      { ...overlap, nodeId: "lb" },
    ]);
  });

  /** A Layer inside a component, its Blend published as `mode` — a compile-time key on the instance's page. */
  const stack = {
    componentId: "stack",
    version: 1,
    name: "Stack",
    graph: {
      revision: 1,
      groups: {},
      nodes: {
        solid: node("solid", "solid", "solid", { color: [1, 0, 0, 1] }),
        layer: node("layer", "layer", "layer", { opacity: 0.5, blend: "over", picture: "solid" }),
      },
      edges: {},
    },
    inputs: [{ externalId: "below", label: "Below", nodeId: "layer", portId: "below" }],
    outputs: [{ externalId: "out", label: "Out", nodeId: "layer", portId: "out" }],
    parameters: [
      {
        key: "mode",
        definition: {
          type: "enum",
          label: "Mode",
          default: "over",
          options: [
            { value: "over", label: "Over" },
            { value: "add", label: "Add" },
          ],
          compileTime: true,
        },
        targets: [{ nodeId: "layer", key: "blend" }],
      },
    ],
  } as unknown as GraphComponentDefinition;

  it("a document the flattening INLINES (a component instance in it) carries them the same way, once", () => {
    const system = createComponentSystem(registry, [stack]);
    const components = system.components.view();
    const base = show({ cues: [CUE_A, { name: "C", bank: "looks", preset: "bright" }] });
    const graph: GraphDocument = { ...base, nodes: { ...base.nodes, inst: node("inst", componentNodeType("stack", 1), "stack1", { mode: "over" }) } };
    const flattened = flattenComponents({ graph, registry: system.nodes, components });
    // The inlining walk, not the identity fast path the instance-free documents above take.
    expect(flattened.changed).toBe(true);
    const request = requestFor(graph, { registry: system.nodes, components });
    for (const plan of [compileGraph(request), compileGraph({ ...request, flattened }), compileGraph({ ...request, flattened, resolution: { frame: frame(45) } })]) {
      expect(cueProblems(plan).map((each) => [each.code, each.nodeId, each.message])).toEqual([
        ["cue.timeline.untimed", "show", 'Cue "C" (show) has no At time, so the timeline skips it.'],
      ]);
    }
  });

  it("structural: a key that changes what is compiled inside a component this compile cannot read", () => {
    const system = createComponentSystem(registry, [stack]);
    const nodes = [
      node("inst", componentNodeType("stack", 1), "stack1", { mode: "over" }),
      presetBankNode("stage", "stage", "stack1", [{ name: "add", values: { stack1: { mode: "add" } } }]),
      node("show", "cueList", "show", {
        follow: "timeline",
        cues: serializeCueList({ version: 1, cues: [{ name: "swap", bank: "stage", preset: "add", at: 1 }] }),
      }),
    ];
    const graph: GraphDocument = { revision: 1, groups: {}, nodes: Object.fromEntries(nodes.map((each) => [each.id, each])), edges: {} };
    // The component-AWARE registry and NO catalogue: the instance's page says the key is
    // structural, and there is no definition to follow its fan-out through.
    expect(cueProblems(compileGraph(requestFor(graph, { registry: system.nodes })))).toEqual([
      {
        severity: "warning",
        code: "cue.timeline.structural",
        message:
          'Cue "swap" (show) sets "stack1.mode", which changes what is compiled inside a component whose definition cannot be read here; the timeline cannot follow its published parameter, so it is skipped.',
        nodeId: "show",
        suggestion: "Set it in the document, or change it from a live list.",
      },
    ]);
    // With the catalogue the fan-out is followed (§T1544b), and there is nothing to say.
    expect(cueProblems(compileGraph(requestFor(graph, { registry: system.nodes, components: system.components.view() })))).toEqual([]);
  });

  it("with the driven Morph beside them: one list of problems, each once, in the plan's order", () => {
    const graph = show({ morph: driven("op('k1').par.value", 2), cues: [CUE_A, { name: "C", bank: "looks", preset: "bright" }] });
    expect(said(graph).map((each) => [each.code, each.nodeId])).toEqual([
      [DRIVEN, "looks"],
      ["cue.timeline.untimed", "show"],
    ]);
  });
});

describe("§T1559b (2) — what carrying them must not do", () => {
  it("a LIVE list is not planned at all: no At on any cue and a bank that is gone say nothing (E82's shape)", () => {
    const graph = show({
      follow: "live",
      cues: [
        { name: "A", bank: "looks", preset: "bright" },
        { name: "B", bank: "nope", preset: "gone" },
      ],
    });
    expect(said(graph)).toEqual([]);
  });

  it("never fails the compile: a cue whose shot recalls itself is skipped by the timeline, and the picture still compiles", () => {
    const loop: Preset = { name: "loop", values: { level1: { brightness: 0.8 } }, recalls: [{ bank: "looks", preset: "loop" }] };
    const graph = show({ presets: [loop], cues: [{ name: "A", bank: "looks", preset: "loop", at: 1 }] });
    // The recall planner refuses it with an ERROR, which the list's own surfaces show…
    const planned = timelineCueWarnings(graph, registry, "show").map((warning) => [warning.diagnostic.severity, warning.diagnostic.code]);
    expect(planned).toEqual([["error", "preset.recall.cycle"]]);
    // …and which is NOT a compile error: an error among the compile's diagnostics holds the
    // picture on the previous plan (§V9), where the timeline only skips the cue.
    const plan = compileGraph(requestFor(graph, { resolution: { frame: frame(45) } }));
    expect(plan.ok).toBe(true);
    expect(plan.diagnostics.filter((each) => each.severity === "error")).toEqual([]);
    expect(said(graph)).toEqual([]);
    expect(brightnessAt(graph, 45)).toBe(0.2);
  });
});
