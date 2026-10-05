import { describe, expect, it } from "vitest";

import { componentNodeType, createComponentSystem } from "../domain/components/index.ts";
import { resolveParameters } from "../domain/parameters/resolve.ts";
import { testRead } from "../domain/parameters/test-support.ts";
import type { Preset } from "../domain/presets/bank.ts";
import { serializeCueList, type Cue } from "../domain/presets/cue-list.ts";
import { easeMorph } from "../domain/presets/morph.ts";
import { presetBankNode } from "../domain/presets/test-support.ts";
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
}

function show(options: ShowOptions = {}): GraphDocument {
  const nodes = [
    node("src", "solid", "solid1", { color: [1, 1, 1, 1] }),
    node("grade", "level", "level1", { brightness: 0.2 }),
    node("out", "output", "out1"),
    node("k1", "constant", "k1", { value: 0.5 }),
    presetBankNode("looks", "looks", "level1", options.presets ?? [BRIGHT], { morph: options.morph ?? 2, curve: options.curve ?? "linear" }),
    cueList(options.cues ?? [CUE_A], options.follow ?? "timeline"),
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
      // A ROOT bank with a driven Morph that no list fires: the document is one the planner is
      // asked about, so it is the instance rule, and not the absence of any driven bank, that
      // keeps this quiet.
      presetBankNode("desk", "desk", "city", [], { morph: driven("time", 2) }),
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
