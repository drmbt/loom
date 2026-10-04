// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { componentNodeType } from "@domain/components/index.ts";
import { serializePresetBank } from "@domain/presets/bank.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import {
  ANIMATED_COMPONENT_ID,
  PULSE_CROSSES_AT_SECONDS,
  animatedComponentDefinition,
} from "../tests/fixtures/animated-component.ts";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { usePulseFiring } from "./pulse-firing.ts";
import { renderRangeHolderFor } from "./render-range.ts";

/**
 * Expression-fired pulses reach a node INSIDE a component (T615, T214, §V125).
 *
 * `usePulseFiring` had no test at all, which is how it stayed on the raw document: on a
 * root-level graph the raw and flattened documents are the same nodes with the same ids,
 * so nothing could tell. Inside a component the watcher saw no pulse to watch, and
 * TouchDesigner's whole reset idiom stopped working the moment a Feedback was packaged.
 *
 * Both halves are asserted here because the second is the one a text scan cannot reach:
 * the watcher must SEE the pulse (flattening), and `parameter.pulse` must be able to
 * DISPATCH it (the flat id is not a document node, so the bus needs the flattening too).
 * Two instances, so a fire scoped to the wrong one is a failure rather than a coincidence.
 */

afterEach(cleanup);

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

const frameAt = (frameIndex: number): FrameEvaluationInput => ({
  timeSeconds: frameIndex / 60,
  deltaSeconds: 1 / 60,
  frameIndex,
  mode: "offline",
  randomSeed: 1,
});

describe("usePulseFiring — a pulse inside a component fires, and lands on ITS instance", () => {
  it("fires once per instance, scoped to that instance's own flat node", async () => {
    const runtime = newRuntime();
    runtime.components.register(animatedComponentDefinition());

    // The command the fixture's pulse declares. Registered here rather than mocked, so the
    // whole dispatch path — `parameter.pulse` resolving the node, substituting `$node`,
    // executing the target — is the one the app runs.
    const cleared: string[][] = [];
    runtime.bus.registerCommand({
      name: "runtime.resetFeedback",
      description: "Test double for the feedback reset a pulse fires.",
      handler: (input) => {
        cleared.push([...(input.nodeIds ?? [])]);
        return { status: "applied", output: { cleared: 1 }, diagnostics: [] };
      },
      rejectionOutput: () => ({ cleared: 0 }),
    });

    let one = "";
    let two = "";
    await act(async () => {
      const result = await seed(runtime, [
        {
          op: "addNode",
          ref: "$one",
          type: componentNodeType(ANIMATED_COMPONENT_ID, 1),
          position: { x: 0, y: 0 },
          parameters: { rate: 0.5 },
        },
        {
          op: "addNode",
          ref: "$two",
          type: componentNodeType(ANIMATED_COMPONENT_ID, 1),
          position: { x: 240, y: 0 },
          parameters: { rate: 2 },
        },
      ]);
      expect(result.status).toBe("applied");
      one = result.output.createdIds["$one"] ?? "";
      two = result.output.createdIds["$two"] ?? "";
    });

    // The bus needs the flattening to resolve a flat id; in the app `useGraphCompile`
    // attaches it. Attached directly here so this file tests the pulse path and not the
    // compile hook.
    runtime.bus.attachFlattenedGraph(() => runtime.flattened.current());

    const { result } = renderHook(() => usePulseFiring(runtime, runtime.invocation));
    await act(async () => {
      for (let frameIndex = 0; frameIndex < 40; frameIndex += 1) {
        result.current.observe(frameAt(frameIndex));
      }
      // The dispatch is a promise; let it settle before asserting.
      await Promise.resolve();
    });

    // TWO fires, each naming its OWN instance. One fire would mean the two instances
    // shared an armed state — the failure a single-instance fixture cannot see (§V461).
    expect(cleared.map((entry) => entry.join(",")).sort()).toEqual([`${one}/fb`, `${two}/fb`]);
    expect(PULSE_CROSSES_AT_SECONDS).toBeGreaterThan(0);
    runtime.dispose();
  });
});

/**
 * T1497b — A RENDER DOES NOT FIRE A PULSE THAT EDITS THE DOCUMENT (the design doc §5.4).
 *
 * `renderFrameRange` steps the live transport, so this observer runs once per exported
 * frame. A preset bank's `recall` pulse on a beat expression would therefore recall —
 * i.e. REWRITE THE PROJECT — in the middle of its own export, and the second export of
 * the same file would start from a different document than the first. The take is marked
 * the way the app marks it: the render holder's `busy()`, which `use-render-range.ts`
 * sets before the take's first step.
 *
 * Three assertions, because the guard has two ways to be wrong: it must withhold the
 * recall, it must NOT withhold a pulse that is part of the picture (a Feedback's reset
 * fires during a take exactly as it does in playback), and it must not leave a stale
 * edge behind to fire on the first live frame after the take.
 */
describe("usePulseFiring — a take fires no command that edits the document (T1497b)", () => {
  /** A Level at 0.2 and a bank whose Recall pulse arms a quarter-second in, on preset `bright`. */
  async function stage(): Promise<{ runtime: AppRuntime; level: string; bank: string }> {
    const runtime = newRuntime();
    let level = "";
    let bank = "";
    await act(async () => {
      const first = await seed(runtime, [
        { op: "addNode", ref: "$level", type: "level", position: { x: 0, y: 0 }, parameters: { brightness: 0.2 } },
      ]);
      expect(first.status).toBe("applied");
      level = first.output.createdIds["$level"] ?? "";
      const name = runtime.bus.store.getGraph().nodes[level]?.label ?? "";
      expect(name).not.toBe("");
      const second = await seed(runtime, [
        {
          op: "addNode",
          ref: "$bank",
          type: "presets",
          position: { x: 0, y: 200 },
          parameters: {
            targets: name,
            select: "bright",
            presets: serializePresetBank({ version: 1, presets: [{ name: "bright", values: { [name]: { brightness: 0.8 } } }] }),
            recall: {
              mode: "expression",
              bindings: {
                static: { kind: "static", value: false },
                expression: { kind: "expression", source: `max(0, sign(time - ${String(PULSE_CROSSES_AT_SECONDS)}))` },
              },
            },
          },
        },
      ]);
      expect(second.status, JSON.stringify(second.diagnostics)).toBe("applied");
      bank = second.output.createdIds["$bank"] ?? "";
    });
    runtime.bus.attachFlattenedGraph(() => runtime.flattened.current());
    return { runtime, level, bank };
  }

  const brightness = (runtime: AppRuntime, level: string): unknown => runtime.bus.store.getGraph().nodes[level]?.parameters["brightness"];
  const commandsSince = (runtime: AppRuntime, from: number): string[] =>
    runtime.bus.store
      .getAudit()
      .slice(from)
      .map((entry) => entry.command);

  it("live, the beat recalls: the document changes (the wire the take must cut)", async () => {
    const { runtime, level } = await stage();
    const auditBefore = runtime.bus.store.getAudit().length;
    const { result } = renderHook(() => usePulseFiring(runtime, runtime.invocation));
    await act(async () => {
      for (let frameIndex = 0; frameIndex < 40; frameIndex += 1) result.current.observe(frameAt(frameIndex));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(brightness(runtime, level)).toBe(0.8);
    expect(commandsSince(runtime, auditBefore)).toContain("preset.recall");
    runtime.dispose();
  });

  it("during a take the same frames fire nothing, and the edge is not left to fire afterwards", async () => {
    const { runtime, level } = await stage();
    let taking = true;
    renderRangeHolderFor(runtime.bus).current = {
      busy: () => taking,
      render: async () => ({ kind: "rendered", frames: 0, fileName: null }),
    };
    const revision = runtime.bus.store.getRevision();
    const auditBefore = runtime.bus.store.getAudit().length;
    const { result } = renderHook(() => usePulseFiring(runtime, runtime.invocation));
    await act(async () => {
      for (let frameIndex = 0; frameIndex < 40; frameIndex += 1) result.current.observe(frameAt(frameIndex));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // No command at all: not the recall, and not a rejected `parameter.pulse` either.
    expect(commandsSince(runtime, auditBefore)).toEqual([]);
    expect(runtime.bus.store.getRevision()).toBe(revision);
    expect(brightness(runtime, level)).toBe(0.2);

    // The take ends with the expression still armed. That is a LEVEL, not a new edge.
    taking = false;
    await act(async () => {
      for (let frameIndex = 40; frameIndex < 50; frameIndex += 1) result.current.observe(frameAt(frameIndex));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(commandsSince(runtime, auditBefore)).toEqual([]);
    expect(brightness(runtime, level)).toBe(0.2);
    renderRangeHolderFor(runtime.bus).current = null;
    runtime.dispose();
  });

  it("a pulse that is part of the PICTURE still fires during a take: a Feedback's reset", async () => {
    const runtime = newRuntime();
    runtime.components.register(animatedComponentDefinition());
    const cleared: string[][] = [];
    runtime.bus.registerCommand({
      name: "runtime.resetFeedback",
      description: "Test double for the feedback reset a pulse fires.",
      handler: (input) => {
        cleared.push([...(input.nodeIds ?? [])]);
        return { status: "applied", output: { cleared: 1 }, diagnostics: [] };
      },
      rejectionOutput: () => ({ cleared: 0 }),
    });
    let one = "";
    await act(async () => {
      const seeded = await seed(runtime, [
        { op: "addNode", ref: "$one", type: componentNodeType(ANIMATED_COMPONENT_ID, 1), position: { x: 0, y: 0 }, parameters: { rate: 0.5 } },
      ]);
      expect(seeded.status).toBe("applied");
      one = seeded.output.createdIds["$one"] ?? "";
    });
    runtime.bus.attachFlattenedGraph(() => runtime.flattened.current());
    renderRangeHolderFor(runtime.bus).current = {
      busy: () => true,
      render: async () => ({ kind: "rendered", frames: 0, fileName: null }),
    };
    const { result } = renderHook(() => usePulseFiring(runtime, runtime.invocation));
    await act(async () => {
      for (let frameIndex = 0; frameIndex < 40; frameIndex += 1) result.current.observe(frameAt(frameIndex));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(cleared.map((entry) => entry.join(","))).toEqual([`${one}/fb`]);
    renderRangeHolderFor(runtime.bus).current = null;
    runtime.dispose();
  });
});

/**
 * T1525b — A PULSE EXPRESSION READING A FADING PARAMETER CROSSES WHEN THE PICTURE DOES.
 *
 * A pulse never fades, but its expression can read a parameter a bank is fading. A recall
 * with a morph commits the DESTINATION at once, so a watcher resolving without the morph
 * index reads the end value from the recall frame on: here 0.8 against a 0.555 threshold —
 * armed at first sight, which is a level, so the reset never fires at all. With the index
 * the Level reads 0.2 + 0.01·n at frame n of the 1 s linear fade, and the reset fires once,
 * on frame 36, the first frame past 0.555.
 *
 * The recall is the real command on the real bus with a frame clock attached; the index
 * is the one the runtime's flattening builds; what is asserted is the command the pulse
 * dispatched, and on which frame.
 */
describe("usePulseFiring — a pulse reading a morphing parameter fires mid-fade (T1525b)", () => {
  const EPOCH = "session-1";
  const liveFrame = (frameIndex: number): FrameEvaluationInput => ({
    timeSeconds: frameIndex / 60,
    deltaSeconds: 1 / 60,
    frameIndex,
    mode: "realtime",
    randomSeed: 1,
    absFrameIndex: frameIndex,
    absTimeSeconds: frameIndex / 60,
    absEpoch: EPOCH,
  });

  it("fires on the frame the fade crosses the threshold, once — not never, as the destination would", async () => {
    const runtime = newRuntime();
    const fired: number[] = [];
    let at = -1;
    runtime.bus.registerCommand({
      name: "runtime.resetFeedback",
      description: "Test double for the feedback reset a pulse fires.",
      handler: () => {
        fired.push(at);
        return { status: "applied", output: { cleared: 1 }, diagnostics: [] };
      },
      rejectionOutput: () => ({ cleared: 0 }),
    });
    let bank = "";
    let level = "";
    await act(async () => {
      const first = await seed(runtime, [
        { op: "addNode", ref: "$level", type: "level", position: { x: 0, y: 0 }, parameters: { brightness: 0.2 } },
      ]);
      expect(first.status).toBe("applied");
      level = first.output.createdIds["$level"] ?? "";
      const name = runtime.bus.store.getGraph().nodes[level]?.label ?? "";
      expect(name).not.toBe("");
      const second = await seed(runtime, [
        {
          op: "addNode",
          ref: "$bank",
          type: "presets",
          position: { x: 0, y: 200 },
          parameters: {
            targets: name,
            presets: serializePresetBank({ version: 1, presets: [{ name: "bright", values: { [name]: { brightness: 0.8 } } }] }),
          },
        },
        {
          op: "addNode",
          ref: "$fb",
          type: "feedback",
          position: { x: 200, y: 0 },
          parameters: {
            resetPulse: {
              mode: "expression",
              bindings: {
                static: { kind: "static", value: false },
                expression: { kind: "expression", source: `op('${name}').par.brightness > 0.555` },
              },
            },
          },
        },
      ]);
      expect(second.status, JSON.stringify(second.diagnostics)).toBe("applied");
      bank = second.output.createdIds["$bank"] ?? "";
      runtime.bus.attachFrameClock(() => ({ epoch: EPOCH, absTimeSeconds: 0 }));
      const recalled = await runtime.bus.execute(
        "preset.recall",
        { nodeId: bank, name: "bright", morph: { seconds: 1, curve: "linear" } },
        runtime.invocation,
      );
      expect(recalled.status, JSON.stringify(recalled.diagnostics)).toBe("applied");
    });
    // The document holds the destination from the recall on; only the frames are on their way.
    expect(runtime.bus.store.getGraph().nodes[level]?.parameters["brightness"]).toBe(0.8);

    const { result } = renderHook(() => usePulseFiring(runtime, runtime.invocation));
    for (let frameIndex = 0; frameIndex <= 70; frameIndex += 1) {
      await act(async () => {
        at = frameIndex;
        result.current.observe(liveFrame(frameIndex));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(fired).toEqual([36]);
    runtime.dispose();
  });
});

/**
 * T1541b — A RECALL PULSE FIRED FROM INSIDE A LOOK (the design doc §1.2 Q4; the gap §T1500b
 * handed to §T1505b). The look's page bank `looks` has its Recall driven by an expression
 * INSIDE the component, and its Select published as the instance's `look` knob, so each
 * instance picks its own preset. The watcher sees the pulse on the flattened document and
 * fires `preset.recall` with the flat id `cityA/looks`; that is the instance's own recall —
 * one patch on cityA, its `presetCurrent` set, exactly as a press on its strip. A look
 * nested inside another component stays refused by name (`preset.bank.nested`).
 */
describe("usePulseFiring — a look's Recall pulse fires from inside its component (T1541b)", () => {
  const recallAtQuarterSecond = {
    mode: "expression",
    bindings: {
      static: { kind: "static", value: false },
      expression: { kind: "expression", source: `max(0, sign(time - ${String(PULSE_CROSSES_AT_SECONDS)}))` },
    },
  };

  function lookDefinition() {
    const presets = serializePresetBank({
      version: 1,
      presets: [
        { name: "calm", values: { parent: { glow: 2 } } },
        { name: "wide", values: { parent: { glow: 40 } } },
      ],
    });
    return {
      componentId: "look",
      version: 1,
      name: "Look",
      graph: {
        revision: 0,
        nodes: {
          blur: { id: "blur", type: "blur", label: "blur", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { size: 4 } },
          looks: {
            id: "looks",
            type: "presets",
            label: "looks",
            definitionVersion: 1,
            position: { x: 0, y: 200 },
            parameters: { targets: "parent", select: "calm", presets, recall: recallAtQuarterSecond },
          },
        },
        edges: {},
        groups: {},
      },
      inputs: [],
      outputs: [{ externalId: "out", label: "Out", nodeId: "blur", portId: "out" }],
      parameters: [
        { key: "glow", definition: { type: "number", label: "Glow", default: 4, min: 0, max: 64 }, targets: [{ nodeId: "blur", key: "size" }] },
        { key: "look", definition: { type: "string", label: "Look", default: "calm" }, targets: [{ nodeId: "looks", key: "select" }] },
      ],
    } as never;
  }

  /** The look nested one level down: `outer`'s internals hold an instance of it. */
  function outerDefinition() {
    return {
      componentId: "outer",
      version: 1,
      name: "Outer",
      graph: {
        revision: 0,
        nodes: { inner: { id: "inner", type: componentNodeType("look", 1), label: "inner", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { glow: 9 } } },
        edges: {},
        groups: {},
      },
      inputs: [],
      outputs: [{ externalId: "out", label: "Out", nodeId: "inner", portId: "out" }],
      parameters: [],
    } as never;
  }

  const auditSince = (runtime: AppRuntime, from: number, command: string): string[] =>
    runtime.bus.store
      .getAudit()
      .slice(from)
      .filter((entry) => entry.command === command)
      .map((entry) => entry.status);

  it("recalls on each instance its own Select names — one patch each — and a nested look is refused by name", async () => {
    const runtime = newRuntime();
    runtime.components.register(lookDefinition());
    runtime.components.register(outerDefinition());
    let ids: Record<string, string> = {};
    await act(async () => {
      const result = await seed(runtime, [
        { op: "addNode", ref: "$a", type: componentNodeType("look", 1), position: { x: 0, y: 0 }, label: "cityA", parameters: { glow: 10, look: "calm" } },
        { op: "addNode", ref: "$b", type: componentNodeType("look", 1), position: { x: 0, y: 300 }, label: "cityB", parameters: { glow: 10, look: "wide" } },
        { op: "addNode", ref: "$o", type: componentNodeType("outer", 1), position: { x: 400, y: 0 }, label: "outer1", parameters: {} },
      ]);
      expect(result.status, JSON.stringify(result.diagnostics)).toBe("applied");
      ids = result.output.createdIds as Record<string, string>;
    });
    runtime.bus.attachFlattenedGraph(() => runtime.flattened.current());
    const nodeOf = (ref: string) => runtime.bus.store.getGraph().nodes[ids[ref] ?? ""];
    const outerBefore = JSON.stringify(nodeOf("$o"));
    const auditBefore = runtime.bus.store.getAudit().length;

    const { result } = renderHook(() => usePulseFiring(runtime, runtime.invocation));
    await act(async () => {
      for (let frameIndex = 0; frameIndex < 40; frameIndex += 1) result.current.observe(frameAt(frameIndex));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(nodeOf("$a")?.parameters["glow"]).toBe(2);
    expect(nodeOf("$a")?.parameters["presetCurrent"]).toBe("calm");
    expect(nodeOf("$b")?.parameters["glow"]).toBe(40);
    expect(nodeOf("$b")?.parameters["presetCurrent"]).toBe("wide");
    // The nested look: its pulse fired too, and the recall it asked for was refused — by
    // name (below) — so nothing it could have written moved.
    expect(JSON.stringify(nodeOf("$o"))).toBe(outerBefore);
    expect(auditSince(runtime, auditBefore, "preset.recall").sort()).toEqual(["applied", "applied", "rejected"]);
    const nested = await runtime.bus.execute("preset.recall", { nodeId: `${ids["$o"] ?? ""}/inner/looks` }, runtime.invocation);
    expect(nested.diagnostics.map((each) => each.code)).toEqual(["preset.bank.nested"]);
    // One recall patch per instance: one undo puts exactly one of them back.
    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    });
    expect([nodeOf("$a")?.parameters["glow"], nodeOf("$b")?.parameters["glow"]].filter((glow) => glow === 10)).toHaveLength(1);
    runtime.dispose();
  });
});
