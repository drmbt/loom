import { describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";
import type { ParameterSchema, PulseParameter } from "../types/parameters.ts";
import {
  PULSE_NODE_TOKEN,
  createPulseWatcher,
  isPulseArmed,
  pulseCommandInput,
  pulseParametersOf,
} from "./pulse.ts";
import { NO_FLATTENING } from "./node-references.ts";

const RESET: PulseParameter = {
  type: "pulse",
  label: "Reset",
  fires: "runtime.resetFeedback",
  input: { nodeIds: [PULSE_NODE_TOKEN], scoped: true },
};

const SCHEMA: ParameterSchema = {
  decay: { type: "number", label: "Decay", default: 0.9 },
  resetPulse: RESET,
};

const registry = {
  get: (type: string) => (type === "feedback" ? { parameters: SCHEMA } : undefined),
};

function node(expression: string | null): GraphNode {
  return {
    id: "n1",
    type: "feedback",
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters:
      expression === null
        ? {}
        : {
            resetPulse: {
              mode: "expression",
              bindings: { expression: { kind: "expression", source: expression } },
            },
          },
  };
}

function graphWith(n: GraphNode): GraphDocument {
  return { revision: 1, nodes: { [n.id]: n }, edges: {}, groups: {} };
}

function frameAt(frameIndex: number): FrameEvaluationInput {
  return {
    timeSeconds: frameIndex / 60,
    deltaSeconds: 1 / 60,
    frameIndex,
    mode: "realtime",
    randomSeed: 1,
  };
}

describe("pulse command input (§V123)", () => {
  it("substitutes the firing node id, inside arrays as well as at the top level", () => {
    expect(pulseCommandInput(RESET, "node-7")).toEqual({ nodeIds: ["node-7"], scoped: true });
  });

  it("is a copy, so two nodes firing the same manifest pulse cannot share a payload", () => {
    const first = pulseCommandInput(RESET, "a");
    const second = pulseCommandInput(RESET, "b");
    expect(first["nodeIds"]).not.toBe(second["nodeIds"]);
    expect(second).toEqual({ nodeIds: ["b"], scoped: true });
  });

  it("finds the pulses a schema declares and nothing else", () => {
    expect(pulseParametersOf(SCHEMA).map((entry) => entry.key)).toEqual(["resetPulse"]);
  });
});

describe("armed (§V125)", () => {
  it("reads an expression result as armed when it is non-zero", () => {
    expect(isPulseArmed(1)).toBe(true);
    expect(isPulseArmed(-0.5)).toBe(true);
    expect(isPulseArmed(0)).toBe(false);
    expect(isPulseArmed(true)).toBe(true);
    expect(isPulseArmed(false)).toBe(false);
  });

  it("is never armed by a value the document could hold", () => {
    // §V124 caps a stored pulse at `false`; nothing else should read as a trigger.
    expect(isPulseArmed(null)).toBe(false);
    expect(isPulseArmed("1")).toBe(false);
  });
});

describe("the watcher fires on the rising edge, not the level (§V125)", () => {
  /**
   * The distinction this suite exists for: `frame > 2` is true forever once it is true.
   * Level-triggering it would clear the feedback buffer on EVERY frame after the third —
   * a loop that never accumulates, driven by an expression that reads perfectly correct.
   */
  it("fires once when a latching expression becomes true, and never again", () => {
    const watcher = createPulseWatcher(registry);
    const graph = graphWith(node("frame - 2"));

    expect(watcher.step(graph, frameAt(0), undefined, NO_FLATTENING)).toEqual([]); // first sighting: record, do not fire
    expect(watcher.step(graph, frameAt(1), undefined, NO_FLATTENING)).toEqual([]);
    expect(watcher.step(graph, frameAt(2), undefined, NO_FLATTENING)).toEqual([]); // frame - 2 === 0, still disarmed
    expect(watcher.step(graph, frameAt(3), undefined, NO_FLATTENING).map((fire) => fire.key)).toEqual(["resetPulse"]);
    expect(watcher.step(graph, frameAt(4), undefined, NO_FLATTENING)).toEqual([]);
    expect(watcher.step(graph, frameAt(5), undefined, NO_FLATTENING)).toEqual([]);
  });

  it("fires again once the expression has fallen back to zero", () => {
    const watcher = createPulseWatcher(registry);
    const graph = graphWith(node("frame % 2"));

    watcher.step(graph, frameAt(0), undefined, NO_FLATTENING); // 0 — disarmed, first sighting
    expect(watcher.step(graph, frameAt(1), undefined, NO_FLATTENING)).toHaveLength(1);
    expect(watcher.step(graph, frameAt(2), undefined, NO_FLATTENING)).toHaveLength(0);
    expect(watcher.step(graph, frameAt(3), undefined, NO_FLATTENING)).toHaveLength(1);
  });

  it("does not fire on the first frame of a project whose expression is already true", () => {
    // §V124's "would wipe your work every open", reached by the other road: opening a
    // document must never trigger a reset just because its condition happens to hold.
    const watcher = createPulseWatcher(registry);
    const graph = graphWith(node("1"));
    expect(watcher.step(graph, frameAt(0), undefined, NO_FLATTENING)).toEqual([]);
    expect(watcher.step(graph, frameAt(1), undefined, NO_FLATTENING)).toEqual([]);
  });

  it("ignores a pulse nobody is driving — a click is not the watcher's business", () => {
    const watcher = createPulseWatcher(registry);
    const graph = graphWith(node(null));
    expect(watcher.step(graph, frameAt(0), undefined, NO_FLATTENING)).toEqual([]);
    expect(watcher.step(graph, frameAt(1), undefined, NO_FLATTENING)).toEqual([]);
  });

  it("reports the node and the definition, so the caller needs no second lookup", () => {
    const watcher = createPulseWatcher(registry);
    const graph = graphWith(node("frame - 1"));
    watcher.step(graph, frameAt(1), undefined, NO_FLATTENING); // frame - 1 === 0: disarmed, and the first sighting
    const [fire] = watcher.step(graph, frameAt(2), undefined, NO_FLATTENING);
    expect(fire?.nodeId).toBe("n1");
    expect(fire?.definition.fires).toBe("runtime.resetFeedback");
  });

  it("forgets its armed levels on reset, so a reload cannot inherit an edge", () => {
    const watcher = createPulseWatcher(registry);
    const graph = graphWith(node("frame % 2"));
    watcher.step(graph, frameAt(0), undefined, NO_FLATTENING);
    expect(watcher.step(graph, frameAt(1), undefined, NO_FLATTENING)).toHaveLength(1);
    watcher.reset();
    // First sighting again: the level is recorded, nothing fires.
    expect(watcher.step(graph, frameAt(3), undefined, NO_FLATTENING)).toHaveLength(0);
  });
});

describe("a DRIVEN pulse fires through the channel resolver (T628, T593's class)", () => {
  const drivenNode = (): GraphNode => ({
    id: "n1",
    type: "feedback",
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters: {
      resetPulse: {
        mode: "driven",
        bindings: {
          driven: { kind: "driven", channel: "lfo1" },
          static: { kind: "static", value: 0 },
        },
      },
    },
  } as never);

  it("fires on the channel's rising edge WITH the resolver, and never without it (§V461)", () => {
    // The channel: 0 on even frames, 1 on odd — an LFO wired to the reset.
    const channels = (name: string, context: { frame: FrameEvaluationInput }) =>
      name === "lfo1" ? context.frame.frameIndex % 2 : undefined;

    const wired = createPulseWatcher(registry);
    const graph = graphWith(drivenNode());
    expect(wired.step(graph, frameAt(0), channels as never, NO_FLATTENING)).toEqual([]); // first sighting
    expect(wired.step(graph, frameAt(1), channels as never, NO_FLATTENING)).toHaveLength(1);
    expect(wired.step(graph, frameAt(2), channels as never, NO_FLATTENING)).toHaveLength(0);
    expect(wired.step(graph, frameAt(3), channels as never, NO_FLATTENING)).toHaveLength(1);

    // WITHOUT the resolver the driven parameter reads its retained static forever —
    // the silent never-fires this parameter ended. Both worlds pinned: remove the
    // resolver plumbing and the wired half above is what catches it.
    const unwired = createPulseWatcher(registry);
    for (let index = 0; index < 4; index += 1) {
      expect(unwired.step(graph, frameAt(index), undefined, NO_FLATTENING)).toEqual([]);
    }
  });
});

/**
 * T1500b — A PULSE ON ANOTHER NODE'S CHANNEL OR PARAMETER FIRES.
 *
 * The `driven` mode above is the retired spelling (§T897): a channel read is an EXPRESSION
 * term now, `op('pad1').chan.note`, and it is read inside the node-reference reader. The
 * watcher resolved without one, so the idiom the design names for every live trigger — a
 * MIDI pad, a beat, a Button on a pulse — evaluated to "no reader", fell back to the
 * retained `false`, and never fired. Written as the literal bug: the expression a user
 * types, through the watcher the app steps.
 */
describe("a pulse expression that names another node fires (T1500b)", () => {
  const source: GraphNode = { id: "n2", type: "feedback", label: "pad1", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { decay: 0 } };
  const graphOf = (expression: string, decay = 0): GraphDocument => ({
    revision: 1,
    nodes: { n1: node(expression), n2: { ...source, parameters: { decay } } },
    edges: {},
    groups: {},
  });

  it("op('pad1').chan.note: one fire per rising edge of the channel, none with the wire cut (§V461)", () => {
    // The pad: down on frames 2–4 and again on frame 6.
    const down = new Set([2, 3, 4, 6]);
    const channels = (name: string, context: { frame?: FrameEvaluationInput }) =>
      name === "pad1:note" ? (down.has(context.frame?.frameIndex ?? -1) ? 1 : 0) : undefined;
    const graph = graphOf("op('pad1').chan.note");

    const wired = createPulseWatcher(registry);
    const fired = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => wired.step(graph, frameAt(index), channels as never, NO_FLATTENING).length);
    // Frame 2 and frame 6 are the two presses; HOLDING through 3 and 4 fires nothing.
    expect(fired).toEqual([0, 0, 1, 0, 0, 0, 1, 0]);

    // No channel behind the name: the same frames fire nothing.
    const unwired = createPulseWatcher(registry);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((index) => unwired.step(graph, frameAt(index), (() => undefined) as never, NO_FLATTENING).length)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("op('pad1').par.decay: another node's PARAMETER arms it too, read at the watcher's own frame", () => {
    const watcher = createPulseWatcher(registry);
    expect(watcher.step(graphOf("op('pad1').par.decay", 0), frameAt(0), undefined, NO_FLATTENING)).toEqual([]);
    expect(watcher.step(graphOf("op('pad1').par.decay", 1), frameAt(1), undefined, NO_FLATTENING).map((fire) => fire.nodeId)).toEqual(["n1"]);
    expect(watcher.step(graphOf("op('pad1').par.decay", 1), frameAt(2), undefined, NO_FLATTENING)).toEqual([]);
  });
});
