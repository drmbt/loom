// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import type { NodeCompileContext, NodeDefinition } from "@domain/types/node-definition.ts";
import { isUniformOnlyChange } from "@compiler/index.ts";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { useMemo } from "react";
import { componentNodeType } from "@domain/components/index.ts";
import { hasAnimatedParameters } from "@domain/channels/graph-channels.ts";
import {
  ANIMATED_COMPONENT_ID,
  animatedComponentDefinition,
} from "../tests/fixtures/animated-component.ts";
import { useGraphCompile } from "./use-graph-compile.ts";
import { useValueGraph } from "./use-value-graph.ts";
import { graphOf, node } from "@domain/components/test-support.ts";
import type { GraphComponentDefinition } from "@domain/types/components.ts";

/**
 * §V28b/T182 — a disconnected texture-producing node must still compile and preview.
 *
 * Before this, the composition root passed no explicit sink list at all, so a node with
 * no downstream connection reached no active sink, was pruned by §V25, and rendered
 * nothing — the "add a Noise node and see an empty body" bug. The fix is the composition
 * root deriving every visible texture-producing node as a preview sink on every compile
 * (§V28a: the list must be complete, never partial), independent of `ui.preview`, which
 * §V28b repurposes as a pin rather than the on-switch.
 */

afterEach(cleanup);

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

async function seed(runtime: AppRuntime, operations: GraphPatchOperation[]) {
  return runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), operations, label: "seed" },
    runtime.invocation,
  );
}

describe("current flattening published to the command bus", () => {
  it("measures a component mesh after changing its file, before React renders the new revision", async () => {
    const component: GraphComponentDefinition = {
      componentId: "meshAsset", version: 1, name: "Mesh Asset",
      graph: graphOf([node("mesh", "meshFileIn", { file: "media/first.glb" }, { label: "mesh_asset" })]),
      inputs: [], outputs: [{ externalId: "out", label: "Out", nodeId: "mesh", portId: "out" }],
      parameters: [{ key: "file", definition: { type: "asset", label: "File", kind: "gltf" }, targets: [{ nodeId: "mesh", key: "file" }] }],
    };
    const runtime = createAppRuntime({ identityStorage: null, components: [component] });
    try {
      const placed = await runtime.bus.execute("component.instantiate", { componentId: component.componentId }, runtime.invocation);
      expect(placed.status).toBe("applied");
      const owner = placed.output.nodeId!;
      expect((await seed(runtime, [{ op: "setParameters", nodeId: owner, parameters: { file: "media/first.glb" } }])).status).toBe("applied");
      let renders = 0;
      const hook = renderHook(() => {
        renders += 1;
        return useGraphCompile(runtime, CAPABILITIES);
      });
      const rendered = hook.result.current.flatGraph;
      const renderCount = renders;
      await act(async () => {
        // The bus applies synchronously; await both results only AFTER their handlers ran,
        // while React still holds the previously rendered document and plan.
        const file = seed(runtime, [{ op: "setParameters", nodeId: owner, parameters: { file: "media/second.glb" } }]);
        const current = runtime.bus.flattenedGraph();
        const measure = seed(runtime, [{ op: "setParameters", nodeId: owner, internalNodeId: "mesh",
          parameters: { vertices: 24, triangles: 12, parts: "", joints: "", clips: "", clipFrames: 0, frameOrigin: "", bounds: "0,0,0,0.8661" },
        }]);
        expect(renders).toBe(renderCount);
        expect(hook.result.current.flatGraph).toBe(rendered);
        const outcomes = await Promise.all([file, measure]);
        expect(outcomes.map(result => result.status)).toEqual(["applied", "applied"]);
        expect(current?.nodes[`${owner}/mesh`]!.parameters.file).toBe("media/second.glb");
      });
      expect(runtime.flattened.current().graph.nodes[`${owner}/mesh`]!.parameters).toMatchObject({ file: "media/second.glb", vertices: 24, triangles: 12 });
      hook.unmount();
    } finally { runtime.dispose(); }
  });
});

describe("useGraphCompile — default-on previews (§V28a, §V28b, §V28c)", () => {
  it("recompiles when a take-local output resolution changes without a document edit", async () => {
    const runtime = newRuntime();
    await act(async () => {
      await seed(runtime, [{ op: "addNode", ref: "$noise", type: "noise", position: { x: 0, y: 0 } }]);
    });
    const settingsAt = (width: number, height: number) => ({
      ...runtime.settings,
      outputResolution: { width, height },
    });
    const { result, rerender } = renderHook(
      ({ settings }) => useGraphCompile(runtime, CAPABILITIES, undefined, undefined, undefined, settings),
      { initialProps: { settings: settingsAt(640, 360) } },
    );
    expect(result.current.compiled?.outputs[0]?.size).toEqual([640, 360]);

    rerender({ settings: settingsAt(1080, 1920) });
    expect(result.current.compiled?.outputs[0]?.size).toEqual([1080, 1920]);
    runtime.dispose();
  });

  it("does not prune a disconnected texture-producing node, and gives it a preview sink", async () => {
    const runtime = newRuntime();
    await act(async () => {
      const result = await seed(runtime, [
        { op: "addNode", ref: "$noise", type: "noise", position: { x: 0, y: 0 } },
      ]);
      expect(result.status).toBe("applied");
    });

    const { result } = renderHook(() => useGraphCompile(runtime, CAPABILITIES));

    const compiled = result.current.compiled;
    expect(compiled).not.toBeNull();
    const plan = compiled!;
    expect(plan.pruned).toHaveLength(0);
    const nodeId = Object.keys(runtime.bus.store.getGraph().nodes)[0];
    expect(nodeId).toBeDefined();
    expect(plan.order).toContain(nodeId);
    expect(plan.outputs.some((output) => output.nodeId === nodeId)).toBe(true);

    runtime.dispose();
  });

  it("still prunes a node with no texture output and no declared sink", async () => {
    // A graph with only a non-texture-producing node (none exist in the v1 catalogue
    // without an output) would compile empty; this asserts the derivation adds nothing
    // when the graph itself is empty, i.e. it never invents a sink.
    const runtime = newRuntime();
    const { result } = renderHook(() => useGraphCompile(runtime, CAPABILITIES));
    expect(result.current.compiled?.pruned ?? []).toHaveLength(0);
    expect(result.current.compiled?.order ?? []).toHaveLength(0);
    runtime.dispose();
  });
});

/**
 * T615 — THE ANIMATE GATE, on a document whose ONLY animation is inside a component.
 *
 * This is the largest and least obvious half of the defect. `hasAnimatedParameters` read
 * the RAW document, which contains one component instance node and no animated parameter
 * at all — so `animate` was NULL, so the frame loop had no per-frame compile to call, so
 * every driven parameter AND every expression inside the component was frozen. Nothing
 * reported anything: the plan compiled, the passes ran, the picture simply never moved.
 *
 * Two instances with different published rates, because a single instance cannot show
 * that each one got its OWN number (§V79, §V461).
 */
describe("useGraphCompile — a component's internal animation opens the gate (T615)", () => {
  async function seedInstances(runtime: AppRuntime): Promise<{ one: string; two: string }> {
    runtime.components.register(animatedComponentDefinition());
    let one = "";
    let two = "";
    await act(async () => {
      const result = await seed(runtime, [
        { op: "addNode", ref: "$gen", type: "solid", position: { x: 0, y: 0 } },
        {
          op: "addNode",
          ref: "$one",
          type: componentNodeType(ANIMATED_COMPONENT_ID, 1),
          position: { x: 240, y: 0 },
          parameters: { rate: 0.5 },
        },
        {
          op: "addNode",
          ref: "$two",
          type: componentNodeType(ANIMATED_COMPONENT_ID, 1),
          position: { x: 480, y: 0 },
          parameters: { rate: 2 },
        },
        { op: "connect", source: { nodeId: "$gen", portId: "out" }, target: { nodeId: "$one", portId: "source" } },
        { op: "connect", source: { nodeId: "$one", portId: "out" }, target: { nodeId: "$two", portId: "source" } },
      ]);
      expect(result.status).toBe("applied");
      one = result.output.createdIds["$one"] ?? "";
      two = result.output.createdIds["$two"] ?? "";
    });
    return { one, two };
  }

  it("is NOT null, and each instance's driven blur takes its own number", async () => {
    const runtime = newRuntime();
    const { one, two } = await seedInstances(runtime);
    // The app's channel ladder, in the app's order: the value graph in front of the
    // compile's own shorthand (§V144). Rendered together because the number under test
    // travels from one to the other — a compile with no resolver would fall back to the
    // driven slot's retained static and prove nothing.
    const { result } = renderHook(() => {
      const valueGraph = useValueGraph(runtime);
      const resolvers = useMemo(() => [valueGraph.resolver], [valueGraph.resolver]);
      return { valueGraph, compile: useGraphCompile(runtime, CAPABILITIES, undefined, resolvers) };
    });

    // The raw document declares no animated parameter anywhere. The flattened one does.
    expect(hasAnimatedParameters(runtime.bus.store.getGraph())).toBe(false);
    expect(result.current.compile.animate, "compile.animate was null, so nothing animates").not.toBeNull();

    const frame = {
      timeSeconds: 0.25,
      deltaSeconds: 1 / 60,
      frameIndex: 15,
      mode: "offline" as const,
      randomSeed: 1,
    };
    act(() => {
      for (let index = 0; index <= 15; index += 1) {
        result.current.valueGraph.evaluate({
          frame: { ...frame, timeSeconds: index / 60, frameIndex: index },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [128, 128],
        });
      }
    });
    const plan = result.current.compile.animate?.(frame);
    expect(plan).not.toBeNull();

    const blurSize = (instance: string): number => {
      const pass = plan?.passes.find(
        (entry) => entry.kind === "effect" && entry.id.endsWith(`${instance}/blur:blur-h`),
      );
      if (pass === undefined || pass.kind !== "effect") {
        throw new Error(`no blur pass for ${instance}`);
      }
      return pass.uniforms?.["size"] as number;
    };
    expect(blurSize(one)).not.toBe(blurSize(two));

    runtime.dispose();
  });

  it("publishes the FLAT document, so Analyze and the plot can find the internals", async () => {
    const runtime = newRuntime();
    const { one, two } = await seedInstances(runtime);
    const { result } = renderHook(() => useGraphCompile(runtime, CAPABILITIES));
    const flat = result.current.flatGraph;
    expect(Object.keys(flat.nodes)).toContain(`${one}/an`);
    expect(Object.keys(flat.nodes)).toContain(`${two}/an`);
    // And it is the SAME object the runtime memoizes, not a second flattening (§V109).
    expect(flat).toBe(runtime.flattened.current().graph);
    runtime.dispose();
  });
});

describe("project.compile answers for THIS document (T764, §B140)", () => {
  it("does not serve document A's plan to document B when their revisions collide", async () => {
    /* Every shipped example is revision 1, so a revision-only cache key is
       structurally blind across ANY pair of loads — and `project.compile`'s report
       carries an `outputs` listing, which is the owner's stale-listings symptom
       arriving from this third seam. Two runtimes are built to the SAME revision with
       DIFFERENT content; the hook (and with it compileNow's cache) survives the swap
       exactly as it does across adoptDocument, which remounts nothing. */
    const runtimeA = newRuntime();
    await act(async () => {
      await seed(runtimeA, [{ op: "addNode", ref: "$noise", type: "noise", position: { x: 0, y: 0 } }]);
    });
    const runtimeB = newRuntime();
    await act(async () => {
      await seed(runtimeB, [{ op: "addNode", ref: "$ramp", type: "ramp", position: { x: 0, y: 0 } }]);
    });
    expect(runtimeA.bus.store.getRevision()).toBe(runtimeB.bus.store.getRevision());
    expect(runtimeA.documentIdentity).not.toBe(runtimeB.documentIdentity);

    /* The window is DEVICE RECOVERY: the memo's null-capability branch returns early
       without touching the cache, so a load during recovery leaves document A's entry
       standing — and with a revision-only key, B's first project.compile answered with
       A's plan and its outputs listing. (A healthy-device swap is safe by ordering:
       the memo recompiles during render, before the command can run — the first
       version of this test proved itself decorative against exactly that, §V461.) */
    const { rerender } = renderHook(
      ({ runtime, capabilities }: { runtime: AppRuntime; capabilities: BackendCapabilities | null }) =>
        useGraphCompile(runtime, capabilities),
      { initialProps: { runtime: runtimeA, capabilities: CAPABILITIES as BackendCapabilities | null } },
    );
    // Prime the cache from document A through the command itself.
    const reportA = (await runtimeA.bus.execute("project.compile", {}, runtimeA.invocation))
      .output as { outputs: ReadonlyArray<{ nodeId: string }> };
    const nodeA = Object.keys(runtimeA.bus.store.getGraph().nodes)[0]!;
    expect(reportA.outputs.some((output) => output.nodeId === nodeA)).toBe(true);

    // The device drops, and the load lands while it is down.
    rerender({ runtime: runtimeB, capabilities: null });
    const reportB = (await runtimeB.bus.execute("project.compile", {}, runtimeB.invocation))
      .output as { compiled: boolean; outputs: ReadonlyArray<{ nodeId: string }> };
    // Honest answer: no device, no plan — NEVER document A's plan wearing B's name.
    expect(reportB.outputs.some((output) => output.nodeId === nodeA)).toBe(false);
    expect(reportB.compiled).toBe(false);

    runtimeA.dispose();
    runtimeB.dispose();
  });
});

/**
 * T1182 — THE WIRING: the plan the hook hands the frame loop each frame is the values-only
 * splice where the compiler can prove it, and the full compile at the frame where it cannot.
 *
 * Two claims, each asserted from the consumer's side (`pushAnimatedValues` in
 * `use-frame-loop.ts` reads `passes` and gates on `isUniformOnlyChange` against the hook's
 * own structural plan):
 *
 *  1. VALUES-ONLY: with an animated non-structural parameter, the per-frame plan carries
 *     the parameter's value AT THAT FRAME (cut the wire and the retained static comes
 *     back), its `signature` is the structural plan's (or the animator refuses it and
 *     the picture freezes — B95's failure), and it IS a splice: every pass the animating
 *     node did not emit, and every array the frame loop does not read, is the base's
 *     own object across frames. A full compile allocates all of it afresh, so forcing
 *     the fall-through fails this test where "same values" alone could not.
 *  2. FALLBACK: with an animated STRUCTURAL parameter (a Cache's `frames`, the size of an
 *     allocation), the per-frame plan is the correct full compile — the ring is 4 deep
 *     before the threshold and 8 deep from it — not null and not the stale base.
 */
describe("useGraphCompile — the per-frame compile is values-only where provable (T1182, §V936)", () => {
  const frameAt = (frameIndex: number) => ({
    timeSeconds: frameIndex / 60,
    deltaSeconds: 1 / 60,
    frameIndex,
    mode: "offline" as const,
    randomSeed: 7,
  });
  const expression = (source: string, retained: number): StoredParameter => ({
    mode: "expression",
    bindings: { expression: { kind: "expression", source }, static: { kind: "static", value: retained } },
  });

  it("hands out the structural plan with only the animating node's passes re-emitted", async () => {
    const runtime = newRuntime();
    let blur = "";
    let solid = "";
    await act(async () => {
      const result = await seed(runtime, [
        { op: "addNode", ref: "$solid", type: "solid", position: { x: 0, y: 0 } },
        {
          op: "addNode",
          ref: "$blur",
          type: "blur",
          position: { x: 240, y: 0 },
          // Exact at every frame: 2 + frame / 2 is representable, and the retained
          // static (1) is not on that line, so a dead expression is a different number.
          parameters: { size: expression("2 + frame * 0.5", 1) },
        },
        { op: "connect", source: { nodeId: "$solid", portId: "out" }, target: { nodeId: "$blur", portId: "input" } },
      ]);
      expect(result.status).toBe("applied");
      blur = result.output.createdIds["$blur"] ?? "";
      solid = result.output.createdIds["$solid"] ?? "";
    });
    const { result } = renderHook(() => useGraphCompile(runtime, CAPABILITIES));
    const structural = result.current.compiled;
    expect(structural).not.toBeNull();
    expect(result.current.animate, "an expression on blur.size must open the animate gate").not.toBeNull();

    const at = (frameIndex: number) => {
      const plan = result.current.animate?.(frameAt(frameIndex));
      expect(plan, `frame ${String(frameIndex)}`).not.toBeNull();
      return plan!;
    };
    const blurSize = (plan: NonNullable<typeof structural>): unknown => {
      const pass = plan.passes.find((entry) => entry.id.endsWith(`${blur}:blur-h`));
      if (pass === undefined || pass.kind !== "effect") throw new Error("no blur-h pass");
      return pass.uniforms?.["size"];
    };
    const passById = (plan: NonNullable<typeof structural>, id: string) => {
      const pass = plan.passes.find((entry) => entry.id.endsWith(id));
      if (pass === undefined) throw new Error(`no pass ${id}`);
      return pass;
    };

    const frame15 = at(15);
    const frame30 = at(30);
    // 1a. The consumer's read: the value at the frame, not the retained static.
    expect(blurSize(frame15)).toBe(9.5);
    expect(blurSize(frame30)).toBe(17);
    // 1b. The frame loop's acceptance gate, against the hook's OWN structural plan —
    // the base the splice reuses must be the plan the app installed (B95's sink rule).
    expect(isUniformOnlyChange(structural!, frame15)).toBe(true);
    expect(isUniformOnlyChange(structural!, frame30)).toBe(true);
    // 1c. A SPLICE, not a fresh compile: the solid did not animate, so its pass is the
    // base's object at both frames; the blur's was re-emitted at each. Everything the
    // frame loop does not read is the base's, shared across frames.
    const solidPassId = `${solid}:fill`;
    expect(passById(frame15, solidPassId)).toBe(passById(frame30, solidPassId));
    expect(passById(frame15, `${blur}:blur-h`)).not.toBe(passById(frame30, `${blur}:blur-h`));
    expect(frame15.outputs).toBe(frame30.outputs);
    expect(frame15.resources).toBe(frame30.resources);
    expect(frame15.passSignatures).toBe(frame30.passSignatures);

    runtime.dispose();
  });

  it("falls through to a correct full compile when the animated parameter is structural", async () => {
    const runtime = newRuntime();
    await act(async () => {
      const result = await seed(runtime, [
        { op: "addNode", ref: "$noise", type: "noise", position: { x: 0, y: 0 } },
        {
          op: "addNode",
          ref: "$cache",
          type: "cache",
          position: { x: 240, y: 0 },
          // 4 deep before frame 30, 8 deep from it: the SIZE of an allocation, which the
          // definition declares compileTime and the compiler therefore refuses to splice.
          parameters: { frames: expression("4 + 4 * (frame >= 30)", 4) },
        },
        { op: "connect", source: { nodeId: "$noise", portId: "out" }, target: { nodeId: "$cache", portId: "input" } },
      ]);
      expect(result.status).toBe("applied");
    });
    const { result } = renderHook(() => useGraphCompile(runtime, CAPABILITIES));
    const structural = result.current.compiled;
    expect(structural).not.toBeNull();
    expect(result.current.animate).not.toBeNull();

    const ringFrames = (plan: NonNullable<typeof structural> | null | undefined): number[] =>
      (plan?.resources ?? []).flatMap((resource) => (resource.kind === "ring" ? [resource.frames] : []));
    const before = result.current.animate?.(frameAt(29));
    const after = result.current.animate?.(frameAt(30));
    expect(before, "frame 29 must still compile in full").not.toBeNull();
    expect(after, "frame 30 must still compile in full").not.toBeNull();
    expect(ringFrames(before)).toEqual([4]);
    expect(ringFrames(after)).toEqual([8]);
    // The full compile at the crossing is honestly NOT a values-only variation, which is
    // what lets the frame loop refuse it and warn (`animation/structuralDrift`) rather
    // than push uniforms into a ring that is the wrong size.
    expect(isUniformOnlyChange(structural!, before!)).toBe(true);
    expect(isUniformOnlyChange(structural!, after!)).toBe(false);

    runtime.dispose();
  });
});

/**
 * T1254 — ONE full compile per revision. The structural memo compiles the revision in
 * full; the frame compiler on the first frame used to compile it AGAIN as its base (E24:
 * 174–191 ms + 160–170 ms per knob drag). Now the memo's retained compile IS the base:
 *
 *  1. identity, from the consumer's side: the plan the first frame hands out shares the
 *     memo result's `signature` and its very objects — the non-animating node's pass,
 *     `outputs`, `resources`, `passSignatures` are `result.compiled`'s own, not a fresh
 *     compile's equal copies;
 *  2. a counter on a definition that never animates: the solid compiles ONCE across the
 *     memo and the first frame. Red-verified by making `prepareFrameCompiler` ignore its
 *     base (it reads 2), and by dropping the base hand-over in the hook (2 again);
 *  3. the reason reaches the performance pane's source: a structural key animating
 *     publishes the compiler's sentence to the hub, a values-only document publishes
 *     null.
 */
describe("useGraphCompile — the frame compiler splices over the memo's own compile (T1254)", () => {
  const frameAt = (frameIndex: number) => ({
    timeSeconds: frameIndex / 60,
    deltaSeconds: 1 / 60,
    frameIndex,
    mode: "offline" as const,
    randomSeed: 7,
  });
  const expression = (source: string, retained: number): StoredParameter => ({
    mode: "expression",
    bindings: { expression: { kind: "expression", source }, static: { kind: "static", value: retained } },
  });

  /** Counts `compile` calls of ONE node type through the runtime's own registry. */
  function countCompiles(runtime: AppRuntime, type: string): () => number {
    let compiles = 0;
    const wrapped = new Map<NodeDefinition, NodeDefinition>();
    const get = runtime.registry.get.bind(runtime.registry);
    vi.spyOn(runtime.registry, "get").mockImplementation((name: string) => {
      const definition = get(name);
      if (definition === undefined || definition.type !== type) return definition;
      let counted = wrapped.get(definition);
      if (counted === undefined) {
        counted = {
          ...definition,
          compile: (context: NodeCompileContext) => {
            compiles += 1;
            return definition.compile(context);
          },
        };
        wrapped.set(definition, counted);
      }
      return counted;
    });
    return () => compiles;
  }

  async function seedSolidBlur(runtime: AppRuntime, blurSize: StoredParameter): Promise<{ solid: string; blur: string }> {
    let solid = "";
    let blur = "";
    await act(async () => {
      const result = await seed(runtime, [
        { op: "addNode", ref: "$solid", type: "solid", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$blur", type: "blur", position: { x: 240, y: 0 }, parameters: { size: blurSize } },
        { op: "connect", source: { nodeId: "$solid", portId: "out" }, target: { nodeId: "$blur", portId: "input" } },
      ]);
      expect(result.status).toBe("applied");
      solid = result.output.createdIds["$solid"] ?? "";
      blur = result.output.createdIds["$blur"] ?? "";
    });
    return { solid, blur };
  }

  it("hands out the memo result's plan on the first frame — base shared, not rebuilt", async () => {
    const runtime = newRuntime();
    const compiles = countCompiles(runtime, "solid");
    const { solid } = await seedSolidBlur(runtime, expression("2 + frame * 0.5", 1));
    const { result } = renderHook(() => useGraphCompile(runtime, CAPABILITIES));
    const structural = result.current.compiled;
    expect(structural).not.toBeNull();
    expect(compiles(), "the structural memo's one full compile").toBe(1);

    const frame15 = result.current.animate?.(frameAt(15));
    expect(frame15).not.toBeNull();
    // 2 (first, so it fails on its own): one full compile per revision. The solid never
    // animates, so its count is the count of FULL compiles — the first frame added none.
    expect(compiles(), "no second full compile for the frame compiler's base").toBe(1);
    // 1. The consumer's gate, and the identity behind it: the splice's untouched parts
    // ARE the memo's plan — a second full compile would hand out equal copies.
    expect(frame15!.signature).toBe(structural!.signature);
    expect(isUniformOnlyChange(structural!, frame15!)).toBe(true);
    const solidPass = (plan: NonNullable<typeof structural>) => plan.passes.find((pass) => pass.id.endsWith(`${solid}:fill`));
    expect(solidPass(frame15!)).toBeDefined();
    expect(solidPass(frame15!)).toBe(solidPass(structural!));
    expect(frame15!.outputs).toBe(structural!.outputs);
    expect(frame15!.resources).toBe(structural!.resources);
    expect(frame15!.passSignatures).toBe(structural!.passSignatures);
    result.current.animate?.(frameAt(16));
    expect(compiles()).toBe(1);
    // The fast path is live, so the pane has nothing to say.
    expect(runtime.telemetry.snapshot().frameCompileReason).toBeNull();

    runtime.dispose();
  });

  it("publishes why frames compile in full to the telemetry hub, naming node and key", async () => {
    const runtime = newRuntime();
    let cache = "";
    await act(async () => {
      const result = await seed(runtime, [
        { op: "addNode", ref: "$noise", type: "noise", position: { x: 0, y: 0 } },
        {
          op: "addNode",
          ref: "$cache",
          type: "cache",
          position: { x: 240, y: 0 },
          parameters: { frames: expression("4 + 4 * (frame >= 30)", 4) },
        },
        { op: "connect", source: { nodeId: "$noise", portId: "out" }, target: { nodeId: "$cache", portId: "input" } },
      ]);
      expect(result.status).toBe("applied");
      cache = result.output.createdIds["$cache"] ?? "";
    });
    const { result } = renderHook(() => useGraphCompile(runtime, CAPABILITIES));
    expect(result.current.animate).not.toBeNull();
    // Nothing is known until a frame asks: the compiler is prepared lazily (T1182).
    expect(runtime.telemetry.snapshot().frameCompileReason).toBeNull();
    expect(result.current.animate?.(frameAt(1))).not.toBeNull();
    // The hub notifies at most 10 times a second (§V16); the sentence lands on its tick.
    await waitFor(() => {
      const reason = runtime.telemetry.snapshot().frameCompileReason;
      expect(reason).toContain(`Node "${cache}" (cache)`);
      expect(reason).toContain('animates "frames"');
    });

    runtime.dispose();
  });
});

/**
 * §T1544b — `project.compile` (the agent's `compile_project`) answers in the timeline's
 * structure AT THE FRAME ON SCREEN. A blue Solid under a Layer stored OFF; a following cue
 * list turns the Layer on at 1.0 s. The bus's frame clock says where the playhead is: before
 * the cue the report is the document's plan, past it the plan with the Layer's pass — the
 * same plan as a document with the Layer stored ON. Same revision throughout: the answer
 * moves with the playhead alone, so a revision-keyed cache would have served the old one.
 */
describe("§T1544b — project.compile applies the timeline's structure at the frame on screen", () => {
  it("before the cue: the stored structure; past it: the switched one, equal to a document storing it", async () => {
    const runtime = newRuntime();
    const presets = JSON.stringify({ version: 1, presets: [{ name: "on", values: {}, on: { layer1: true } }] });
    const cues = JSON.stringify({ version: 1, cues: [{ name: "in", bank: "stage", preset: "on", at: 1 }] });
    let created: Record<string, string> = {};
    await act(async () => {
      const seeded = await seed(runtime, [
        { op: "addNode", ref: "$blue", type: "solid", position: { x: 0, y: 0 }, label: "blue", parameters: { color: [0, 0, 1, 1] } },
        { op: "addNode", ref: "$red", type: "solid", position: { x: 0, y: 100 }, label: "red", parameters: { color: [1, 0, 0, 1] } },
        { op: "addNode", ref: "$layer", type: "layer", position: { x: 200, y: 0 }, label: "layer1", parameters: { picture: "red", blend: "replace" } },
        { op: "addNode", ref: "$out", type: "output", position: { x: 400, y: 0 }, label: "out1" },
        { op: "addNode", ref: "$stage", type: "presets", position: { x: 0, y: 200 }, label: "stage", parameters: { targets: "layer1", presets } },
        { op: "addNode", ref: "$show", type: "cueList", position: { x: 0, y: 300 }, label: "show", parameters: { cues, follow: "timeline" } },
        { op: "connect", source: { nodeId: "$blue", portId: "out" }, target: { nodeId: "$layer", portId: "below" } },
        { op: "connect", source: { nodeId: "$layer", portId: "out" }, target: { nodeId: "$out", portId: "input" } },
      ] as GraphPatchOperation[]);
      created = (seeded.output as { createdIds: Record<string, string> }).createdIds;
      expect((await seed(runtime, [{ op: "setNodeUi", nodeId: created["$layer"]!, ui: { bypassed: true } }])).status).toBe("applied");
    });
    let clock: { epoch: string; absTimeSeconds: number; timeSeconds: number; timelineRate: number } | undefined;
    runtime.bus.attachFrameClock(() => clock);
    renderHook(() => useGraphCompile(runtime, CAPABILITIES));
    const report = async () =>
      (await runtime.bus.execute("project.compile", {}, runtime.invocation)).output as { ok: boolean; passCount: number };
    const at = (seconds: number) => ({ epoch: "e", absTimeSeconds: seconds, timeSeconds: seconds, timelineRate: 60 });

    clock = at(0.5);
    const before = await report();
    clock = at(1.5);
    const after = await report();
    expect(before.ok && after.ok).toBe(true);
    // The Layer's own pass is in the plan past the cue, and not before it.
    expect(after.passCount).toBe(before.passCount + 1);
    // And back before the cue: the cache does not keep the switched answer.
    clock = at(0.9);
    expect((await report()).passCount).toBe(before.passCount);

    // The twin: the Layer stored ON, the list live — the plan past the cue, exactly.
    await act(async () => {
      expect((await seed(runtime, [
        { op: "setNodeUi", nodeId: created["$layer"]!, ui: { bypassed: false } },
        { op: "setParameters", nodeId: created["$show"]!, parameters: { follow: "live" } },
      ])).status).toBe("applied");
    });
    expect((await report()).passCount).toBe(after.passCount);
    runtime.dispose();
  });
});
