import { describe, expect, it } from "vitest";

import { flatDocument } from "@compiler/test-support.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import type { ParameterSlot, ParameterValue, StoredParameter } from "../types/parameters.ts";
import { createGraphStore, type GraphStore } from "../graph/store.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import { createDomainBus } from "../commands/index.ts";
import type { LoomBus } from "../commands/bus.ts";
import { alice, bob, contextFor, patch } from "../commands/test-support.ts";
import { createValueGraphSession } from "../channels/value-graph.ts";
import { graphChannelResolver, hasAnimatedParameters } from "../channels/graph-channels.ts";
import { NO_FLATTENING, parameterReadOptions } from "../parameters/node-references.ts";
import { resolveParameters, srgbToLinear } from "../parameters/resolve.ts";
import { liveClock } from "../transport/live-clock.ts";
import { createNodeRegistry, type NodeRegistryView } from "../../nodes/registry/registry.ts";
import { levelNode } from "../../nodes/definitions/color.ts";
import { presetsNode } from "../../nodes/definitions/presets.ts";
import { constantNode } from "../../nodes/definitions/values.ts";
import { serializePresetBank, type MorphSpec, type Preset } from "./bank.ts";
import { parseMorphRecords, type MorphRecord } from "./morph.ts";
import { buildMorphIndex } from "./morph-index.ts";
import { testRead } from "../parameters/test-support.ts";

/**
 * T1497b (§T1398b S2) — A RECALL WITH A MORPH, through the real bus, the real live clock
 * and the one parameter read path.
 *
 * Each `describe` is an acceptance line of the design doc §12 S2 (the Dawn half is
 * `src/tests/headless/preset-morph.gpu.test.ts`). What is asserted is always what a
 * consumer reads back: the DOCUMENT after the recall (it must hold the destination), and
 * the value the resolver hands evaluation AT A FRAME (it must be the fade). Expected
 * values are derived from the record and the frame, never restated as a constant that
 * happens to match — the absolute clock ACCUMULATES `1/fps`, so its thirtieth frame is not
 * the literal 0.5 and a test that pretended otherwise would be asserting a rounding.
 *
 * The session below is the app in miniature, wired the way `use-frame-loop.ts` wires it:
 * one live clock with an app-minted epoch, and the last frame it produced attached to
 * the bus as the frame clock. No command here reads a clock of its own (§V44).
 */

/** A node with one parameter of each kind a preset can hold, for what blends and what cuts. */
const knobsNode: NodeDefinition = {
  type: "test.knobs",
  version: 1,
  title: "Knobs",
  category: "test",
  inputs: [],
  outputs: [],
  parameters: {
    gain: { type: "number", label: "Gain", default: 0, min: 0, max: 10 },
    mode: {
      type: "enum",
      label: "Mode",
      default: "a",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    },
    name: { type: "string", label: "Name", default: "" },
    taps: { type: "number", label: "Taps", default: 1, min: 1, max: 64, compileTime: true },
    tint: { type: "color", label: "Tint", default: [0, 0, 0, 1], space: "display" },
    offset: { type: "vector", size: 2, label: "Offset", default: [0, 0] },
  },
  compile: () => ({ passes: [] }),
};

const registry: NodeRegistryView = createNodeRegistry([levelNode, presetsNode, constantNode, knobsNode]).view();

function node(id: NodeId, type: string, label: string, parameters: Record<string, StoredParameter> = {}): GraphNode {
  return { id, type, label, definitionVersion: 1, position: { x: 0, y: 0 }, parameters };
}

function bank(id: NodeId, label: string, presets: readonly Preset[], extra: Record<string, StoredParameter> = {}): GraphNode {
  return node(id, "presets", label, { targets: "level1", presets: serializePresetBank({ version: 1, presets }), ...extra });
}

const preset = (name: string, values: Preset["values"], morph?: MorphSpec): Preset => ({ name, values, ...(morph === undefined ? {} : { morph }) });

const LINEAR_1S: MorphSpec = { seconds: 1, curve: "linear" };

const expression = (source: string, retained: number): ParameterSlot => ({
  mode: "expression",
  bindings: { static: { kind: "static", value: retained }, expression: { kind: "expression", source } },
});

interface Session {
  readonly bus: LoomBus;
  readonly store: GraphStore;
  /** Produces `count` frames, one display tick apart. Returns the last. */
  frames(count?: number): FrameEvaluationInput;
  latest(): FrameEvaluationInput;
  /** Wall time passes with the transport stopped: no frame is produced. */
  wait(seconds: number): void;
  /** A seek's clock half: the timeline restarts, the absolute clock does not (T461). */
  seek(): void;
  /** A lap: only the timeline VALUE wraps (T464). */
  lap(): void;
  /** What a render does first: zero the absolute clock, under a new epoch (T467). */
  startTake(epoch: string): void;
  /** What evaluation reads for a key at a frame — the one read path, morphs included. */
  shown(nodeId: NodeId, key: string, frame?: FrameEvaluationInput): ParameterValue | undefined;
  records(bankId?: NodeId): MorphRecord[];
  stored(nodeId: NodeId, key: string): StoredParameter | undefined;
}

function session(nodes: GraphNode[], options: { attachClock?: boolean } = {}): Session {
  const initialGraph: GraphDocument = { revision: 0, nodes: Object.fromEntries(nodes.map((each) => [each.id, each])), edges: {}, groups: {} };
  const store = createGraphStore({ ids: createSequentialIdFactory("t"), now: () => "2026-10-02T00:00:00.000Z", initialGraph });
  const { bus } = createDomainBus({ store, registry });

  let nowMs = 0;
  let epoch = "session-1";
  const clock = liveClock({ fps: () => 60, now: () => nowMs, epoch: () => epoch });
  let last: FrameEvaluationInput | null = null;
  if (options.attachClock !== false) {
    bus.attachFrameClock(() =>
      last?.absEpoch === undefined || last.absTimeSeconds === undefined ? undefined : { epoch: last.absEpoch, absTimeSeconds: last.absTimeSeconds },
    );
  }
  const latest = (): FrameEvaluationInput => {
    if (last === null) throw new Error("no frame has been produced");
    return last;
  };

  return {
    bus,
    store,
    latest,
    frames(count = 1) {
      for (let index = 0; index < count; index += 1) {
        nowMs += 1000 / 60;
        last = clock.next();
      }
      return latest();
    },
    wait(seconds) {
      nowMs += seconds * 1000;
    },
    seek: () => clock.reset(),
    lap: () => clock.wrapTo?.(0),
    startTake(next) {
      clock.resetAbsolute();
      epoch = next;
      clock.reset();
    },
    shown(nodeId, key, frame = latest()) {
      const graph = store.view.getGraph();
      const target = graph.nodes[nodeId];
      if (target === undefined) throw new Error(`no node ${nodeId}`);
      const morphs = buildMorphIndex({ document: graph, registry });
      return resolveParameters(target, registry.get(target.type), parameterReadOptions({ graph: flatDocument(graph), registry, frame, channels: undefined, flattening: { ...NO_FLATTENING, morphs } })).values[key];
    },
    records: (bankId = "bank") => parseMorphRecords(store.view.getGraph().nodes[bankId]?.parameters["morphs"]),
    stored: (nodeId, key) => store.view.getGraph().nodes[nodeId]?.parameters[key],
  };
}

const recall = (run: Session, name: string, morph?: MorphSpec, bankId: NodeId = "bank") =>
  run.bus.execute("preset.recall", { nodeId: bankId, name, ...(morph === undefined ? {} : { morph }) }, contextFor(alice));

/** `a` toward `b` by linear progress on the record's clock — the fold's one step, restated. */
const blend = (a: number, b: number, record: MorphRecord, frame: FrameEvaluationInput): number => {
  const p = Math.min(1, Math.max(0, ((frame.absTimeSeconds ?? 0) - record.start) / record.seconds));
  return a * (1 - p) + b * p;
};

/** A Level at brightness 0.2 and a bank holding the three brightnesses the tests move between. */
const levelSet = (brightness: StoredParameter = 0.2, extra: Record<string, StoredParameter> = {}): GraphNode[] => [
  node("level", "level", "level1", { brightness }),
  bank(
    "bank",
    "looks",
    [
      preset("dim", { level1: { brightness: 0.2 } }),
      preset("mid", { level1: { brightness: 0.4 } }),
      preset("bright", { level1: { brightness: 0.8 } }),
      preset("punchy", { level1: { contrast: 2 } }),
    ],
    extra,
  ),
];

describe("a recall with a morph commits the END state in its one patch, with a record (§5.2)", () => {
  it("is one revision, one undo group, one audit entry — and the document holds the destination at once", async () => {
    const run = session(levelSet());
    const before = run.frames(5);
    const revision = run.store.view.getRevision();
    const auditBefore = run.store.view.getAudit().length;
    const undoBefore = run.store.view.getHistory(alice).undo.length;

    const result = await recall(run, "bright", LINEAR_1S);
    expect(result.status).toBe("applied");
    expect(result.output).toMatchObject({ ok: true, preset: "bright", applied: ["level1.brightness"], morph: LINEAR_1S });

    // The destination, in the document, now: what the inspector, Store, a save and undo see.
    expect(run.stored("level", "brightness")).toBe(0.8);
    expect(run.stored("bank", "current")).toBe("bright");
    // The record, stamped with the frame on screen when the command ran — not a clock of its own.
    expect(run.records()).toEqual([
      {
        epoch: "session-1",
        start: before.absTimeSeconds,
        seconds: 1,
        curve: "linear",
        preset: "bright",
        from: { level1: { brightness: 0.2 } },
        to: { level1: { brightness: 0.8 } },
      },
    ]);

    expect(run.store.view.getRevision()).toBe(revision + 1);
    expect(run.store.view.getAudit().slice(auditBefore).map((entry) => [entry.command, entry.status, entry.actor.id])).toEqual([
      ["preset.recall", "applied", "alice"],
    ]);
    expect(run.store.view.getHistory(alice).undo).toHaveLength(undoBefore + 1);

    // ONE undo: the value, the bank's `current` and the record all go back together.
    const undone = await run.bus.execute("graph.undo", {}, contextFor(alice));
    expect(undone.status).toBe("applied");
    expect(run.stored("level", "brightness")).toBe(0.2);
    expect(run.stored("bank", "current") ?? "").toBe("");
    expect(run.records()).toEqual([]);
  });

  it("counts the document as animating while a record is in it, and not before", async () => {
    const run = session(levelSet());
    run.frames(2);
    expect(hasAnimatedParameters(run.store.view.getGraph())).toBe(false);
    await recall(run, "bright", LINEAR_1S);
    // No slot mode gives a morphing key away: its stored value is a plain 0.8.
    expect(hasAnimatedParameters(run.store.view.getGraph())).toBe(true);
  });
});

describe("the screen fades on the transport's ABSOLUTE clock (§5.3, §5.4)", () => {
  it("a 1 s linear morph 0.2 → 0.8 reads the analytic 0.5 thirty frames in at 60 fps", async () => {
    const run = session(levelSet());
    run.frames(5);
    await recall(run, "bright", LINEAR_1S);
    const [record] = run.records();
    if (record === undefined) throw new Error("no record");

    // The frame the recall happened on has made no progress: no jump at the start.
    expect(run.shown("level", "brightness")).toBe(0.2);
    const half = run.frames(30);
    expect(run.shown("level", "brightness")).toBe(blend(0.2, 0.8, record, half));
    expect(run.shown("level", "brightness")).toBeCloseTo(0.5, 12);
    // And it ARRIVES, exactly, and stays. (One frame of slack: the clock accumulates
    // 1/60, so its sixtieth step may land a rounding short of a whole second.)
    run.frames(31);
    expect(run.shown("level", "brightness")).toBe(0.8);
    run.frames(200);
    expect(run.shown("level", "brightness")).toBe(0.8);
  });

  it("the curve is the record's: `in` reads p² of the way", async () => {
    const run = session(levelSet());
    run.frames(1);
    await recall(run, "bright", { seconds: 1, curve: "in" });
    const [record] = run.records();
    if (record === undefined) throw new Error("no record");
    const frame = run.frames(30);
    const p = ((frame.absTimeSeconds ?? 0) - record.start) / record.seconds;
    expect(run.shown("level", "brightness")).toBe(0.2 * (1 - p * p) + 0.8 * (p * p));
  });

  it("PAUSED: no frame is produced, the reading does not move, and a step advances one frame", async () => {
    const run = session(levelSet());
    run.frames(5);
    await recall(run, "bright", LINEAR_1S);
    const [record] = run.records();
    if (record === undefined) throw new Error("no record");
    const held = run.frames(15);
    const value = run.shown("level", "brightness");
    const stamp = run.bus.frameClock();

    // Five seconds on the wall, transport stopped: longer than the whole fade.
    run.wait(5);
    expect(run.bus.frameClock()).toEqual(stamp);
    expect(run.shown("level", "brightness", held)).toBe(value);

    // One step: one frame of the fade, not five seconds of it.
    const stepped = run.frames(1);
    expect((stepped.absTimeSeconds ?? 0) - (held.absTimeSeconds ?? 0)).toBeCloseTo(1 / 60, 12);
    expect(run.shown("level", "brightness")).toBe(blend(0.2, 0.8, record, stepped));
    expect(run.shown("level", "brightness")).toBeLessThan(0.8);
  });

  it("LOOPED: the fade carries on through the lap instead of replaying", async () => {
    const run = session(levelSet());
    run.frames(5);
    await recall(run, "bright", LINEAR_1S);
    const [record] = run.records();
    if (record === undefined) throw new Error("no record");
    const before = run.frames(20);
    run.lap();
    const lapped = run.frames(1);
    // The timeline wrapped to the in point…
    expect(lapped.frameIndex).toBe(0);
    expect(lapped.frameIndex).toBeLessThan(before.frameIndex);
    // …and the fade is twenty-one frames in, not back at its start.
    expect(run.shown("level", "brightness")).toBe(blend(0.2, 0.8, record, lapped));
    expect(run.shown("level", "brightness") as number).toBeGreaterThan(run.shown("level", "brightness", before) as number);
  });

  it("SEEK: the fade neither restarts nor skips — the frame after a seek is one step on", async () => {
    const run = session(levelSet());
    run.frames(40);
    await recall(run, "bright", LINEAR_1S);
    const [record] = run.records();
    if (record === undefined) throw new Error("no record");
    const before = run.frames(20);
    const valueBefore = run.shown("level", "brightness") as number;
    run.seek();
    const after = run.frames(1);
    expect(after.frameIndex).toBe(0);
    const step = (0.8 - 0.2) / 60;
    expect((run.shown("level", "brightness") as number) - valueBefore).toBeCloseTo(step, 12);
    expect(run.shown("level", "brightness")).toBe(blend(0.2, 0.8, record, after));
    expect(after.absTimeSeconds).toBeGreaterThan(before.absTimeSeconds ?? 0);
  });
});

describe("undo mid-morph restores the old value at the next frame", () => {
  it("cuts back: the record goes with the value, so nothing is left to fade", async () => {
    const run = session(levelSet());
    run.frames(5);
    await recall(run, "bright", LINEAR_1S);
    run.frames(30);
    expect(run.shown("level", "brightness")).toBeCloseTo(0.5, 12);

    await run.bus.execute("graph.undo", {}, contextFor(alice));
    run.frames(1);
    expect(run.shown("level", "brightness")).toBe(0.2);
    run.frames(10);
    expect(run.shown("level", "brightness")).toBe(0.2);
  });
});

describe("a second recall mid-morph continues from the ON-SCREEN value, with no jump", () => {
  it("measured at the frame of the recall, then folds through both records", async () => {
    const run = session(levelSet());
    run.frames(5);
    await recall(run, "bright", LINEAR_1S);
    const half = run.frames(30);
    const onScreen = run.shown("level", "brightness");
    expect(onScreen).toBeCloseTo(0.5, 12);

    await recall(run, "mid", LINEAR_1S);
    // Same frame, new document: the destination is 0.4 and the picture has not moved.
    expect(run.stored("level", "brightness")).toBe(0.4);
    expect(run.shown("level", "brightness", half)).toBe(onScreen);

    const [first, second] = run.records();
    if (first === undefined || second === undefined) throw new Error("expected two records");
    expect(second.from).toEqual({ level1: { brightness: 0.8 } });

    // A quarter of the second fade in: the first is still moving underneath it.
    const later = run.frames(15);
    expect(run.shown("level", "brightness")).toBe(blend(blend(0.2, 0.8, first, later), 0.4, second, later));
    expect(run.shown("level", "brightness")).toBeCloseTo(0.65 * 0.75 + 0.4 * 0.25, 12);

    // The first finishes and simply stops mattering: no step in the value across that frame.
    const finishing = run.frames(15);
    expect(run.shown("level", "brightness")).toBeCloseTo(blend(0.8, 0.4, second, finishing), 12);
    // One frame past the nominal end: the clock ACCUMULATES 1/60, so its sixtieth step can
    // land a rounding short of a whole second and the fade is exactly done a frame later.
    run.frames(31);
    expect(run.shown("level", "brightness")).toBe(0.4);
  });

  it("works across banks: a second bank's morph on the same key picks the first's fade up", async () => {
    const run = session([
      ...levelSet(),
      bank("shots", "shots", [preset("drop", { level1: { brightness: 0.4 } })]),
    ]);
    run.frames(5);
    await recall(run, "bright", LINEAR_1S);
    const half = run.frames(30);
    const onScreen = run.shown("level", "brightness");
    await recall(run, "drop", LINEAR_1S, "shots");
    expect(run.shown("level", "brightness", half)).toBe(onScreen);
    const first = run.records("bank")[0];
    const second = run.records("shots")[0];
    if (first === undefined || second === undefined) throw new Error("expected a record in each bank");
    const later = run.frames(15);
    expect(run.shown("level", "brightness")).toBe(blend(blend(0.2, 0.8, first, later), 0.4, second, later));
  });

  it("recalling the SAME preset again, faster, arrives in the new time and does not fall back", async () => {
    const run = session(levelSet());
    run.frames(5);
    await recall(run, "bright", { seconds: 10, curve: "linear" });
    const at = run.frames(120);
    const onScreen = run.shown("level", "brightness");
    expect(onScreen).toBeCloseTo(0.2 + 0.6 * 0.2, 12);

    // Nothing STORED changes — it is already 0.8 — but the key is still moving on screen.
    await recall(run, "bright", LINEAR_1S);
    expect(run.shown("level", "brightness", at)).toBe(onScreen);
    run.frames(61);
    expect(run.shown("level", "brightness")).toBe(0.8);

    // The long record is still nominally running. A recall on ANOTHER key tidies the short
    // one away — and must not hand the picture back to the long one at 32 % of the way.
    await recall(run, "punchy", LINEAR_1S);
    run.frames(1);
    expect(run.shown("level", "brightness")).toBe(0.8);
    run.frames(120);
    expect(run.shown("level", "brightness")).toBe(0.8);
  });

  it("a CUT recall of the preset a fade is heading to cuts", async () => {
    const run = session(levelSet());
    run.frames(5);
    await recall(run, "bright", { seconds: 10, curve: "linear" });
    const at = run.frames(60);
    expect(run.shown("level", "brightness")).toBeLessThan(0.8);
    const cut = await recall(run, "bright", { seconds: 0, curve: "linear" });
    expect(cut.output.morph).toBeNull();
    expect(run.shown("level", "brightness", at)).toBe(0.8);
    expect(run.records()).toEqual([]);
  });
});

describe("a manual edit of a morphing key wins at once", () => {
  it("the edited key shows the edit on the same frame; no extra write is needed", async () => {
    const run = session(levelSet());
    run.frames(5);
    await recall(run, "bright", LINEAR_1S);
    const half = run.frames(30);
    expect(run.shown("level", "brightness")).toBeCloseTo(0.5, 12);

    const revision = run.store.view.getRevision();
    await run.bus.execute(
      "graph.applyPatch",
      patch(revision, [{ op: "setParameters", nodeId: "level", parameters: { brightness: 0.6 } }]),
      contextFor(bob),
    );
    // One revision: the slider's own. The record is untouched and simply no longer applies.
    expect(run.store.view.getRevision()).toBe(revision + 1);
    expect(run.records()).toHaveLength(1);
    expect(run.shown("level", "brightness", half)).toBe(0.6);
    run.frames(10);
    expect(run.shown("level", "brightness")).toBe(0.6);
  });

  it("an edit of ANOTHER key of the same node leaves the fade running", async () => {
    const run = session(levelSet());
    run.frames(5);
    await recall(run, "bright", LINEAR_1S);
    const [record] = run.records();
    if (record === undefined) throw new Error("no record");
    run.frames(30);
    await run.bus.execute(
      "graph.applyPatch",
      patch(run.store.view.getRevision(), [{ op: "setParameters", nodeId: "level", parameters: { contrast: 1.5 } }]),
      contextFor(bob),
    );
    const frame = run.frames(1);
    expect(run.shown("level", "brightness")).toBe(blend(0.2, 0.8, record, frame));
    expect(run.shown("level", "contrast")).toBe(1.5);
  });

  it("a morph recalled after an edit starts from the edit, not from the fade it interrupted", async () => {
    const run = session(levelSet());
    run.frames(5);
    await recall(run, "bright", { seconds: 10, curve: "linear" });
    run.frames(30);
    await run.bus.execute(
      "graph.applyPatch",
      patch(run.store.view.getRevision(), [{ op: "setParameters", nodeId: "level", parameters: { brightness: 0.6 } }]),
      contextFor(bob),
    );
    const at = run.frames(1);
    await recall(run, "dim", LINEAR_1S);
    expect(run.shown("level", "brightness", at)).toBe(0.6);
    const second = run.records().at(-1);
    if (second === undefined) throw new Error("no record");
    const later = run.frames(30);
    expect(run.shown("level", "brightness")).toBe(blend(0.6, 0.2, second, later));
  });
});

describe("exports and reopened documents render the END state (§5.4)", () => {
  it("a render zeroes the clock under a new epoch: every frame of the take is the destination", async () => {
    const run = session(levelSet());
    run.frames(180);
    await recall(run, "bright", LINEAR_1S);
    const [record] = run.records();
    if (record === undefined) throw new Error("no record");
    run.frames(10);
    expect(run.shown("level", "brightness")).toBeLessThan(0.8);

    run.startTake("take-1");
    const values = new Set<ParameterValue | undefined>();
    let crossed = false;
    for (let index = 0; index < 260; index += 1) {
      const frame = run.frames(1);
      values.add(run.shown("level", "brightness"));
      // The take's clock passes straight through the moment the live recall was stamped
      // at, and through its whole fade — the readings a bare "start ≤ now" test would replay.
      if ((frame.absTimeSeconds ?? 0) > record.start && (frame.absTimeSeconds ?? 0) < record.start + record.seconds) crossed = true;
    }
    expect(crossed).toBe(true);
    expect([...values]).toEqual([0.8]);
  });

  it("a frame with no epoch at all (the offline transport) is the destination", async () => {
    const run = session(levelSet());
    run.frames(5);
    await recall(run, "bright", LINEAR_1S);
    const live = run.frames(30);
    expect(run.shown("level", "brightness", live)).toBeCloseTo(0.5, 12);
    const { absEpoch: _epoch, ...offline } = live;
    expect(run.shown("level", "brightness", offline)).toBe(0.8);
    // And frameless — a control, a validate, a structural compile — is the destination too.
    const graph = run.store.view.getGraph();
    const level = graph.nodes["level"] as GraphNode;
    expect(resolveParameters(level, registry.get("level"), testRead({ morphs: buildMorphIndex({ document: graph, registry }) })).values["brightness"]).toBe(0.8);
  });
});

describe("a headless recall with a morph commits as a cut, with a diagnostic (§5.2)", () => {
  it("lands the values, writes no record, and names the missing frame clock", async () => {
    const run = session(levelSet(), { attachClock: false });
    const result = await recall(run, "bright", LINEAR_1S);
    expect(result.status).toBe("applied");
    expect(result.output).toMatchObject({ ok: true, applied: ["level1.brightness"], morph: null });
    expect(run.stored("level", "brightness")).toBe(0.8);
    expect(run.records()).toEqual([]);
    const said = result.diagnostics.filter((each) => each.code === "preset.recall.morphUnavailable");
    expect(said).toHaveLength(1);
    expect(said[0]?.severity).toBe("info");
    expect(said[0]?.message).toContain("no frame clock");
    expect(said[0]?.message).toContain("as a cut");
  });

  it("says nothing when no morph was asked for", async () => {
    const run = session(levelSet(), { attachClock: false });
    const result = await recall(run, "bright");
    expect(result.diagnostics.filter((each) => each.code === "preset.recall.morphUnavailable")).toEqual([]);
  });
});

describe("which morph applies (§5.1): the recall's own, else the preset's, else the bank's", () => {
  const nodes = (): GraphNode[] => [
    node("level", "level", "level1", { brightness: 0.2 }),
    bank(
      "bank",
      "looks",
      [preset("plain", { level1: { brightness: 0.8 } }), preset("own", { level1: { brightness: 0.6 } }, { seconds: 4, curve: "out" })],
      { morph: 2, curve: "in" },
    ),
  ];

  it("the bank's Morph and Curve carry a preset with none of its own", async () => {
    const run = session(nodes());
    run.frames(1);
    const result = await recall(run, "plain");
    expect(result.output.morph).toEqual({ seconds: 2, curve: "in" });
    expect(run.records()[0]).toMatchObject({ seconds: 2, curve: "in" });
  });

  it("a preset's own morph outranks the bank's", async () => {
    const run = session(nodes());
    run.frames(1);
    const result = await recall(run, "own");
    expect(result.output.morph).toEqual({ seconds: 4, curve: "out" });
  });

  it("the recall's own outranks both — including a zero, which is a cut", async () => {
    const run = session(nodes());
    run.frames(1);
    expect((await recall(run, "own", LINEAR_1S)).output.morph).toEqual(LINEAR_1S);
    const cut = await recall(run, "plain", { seconds: 0, curve: "smooth" });
    expect(cut.output.morph).toBeNull();
    expect(run.stored("level", "brightness")).toBe(0.8);
    expect(run.shown("level", "brightness")).toBe(0.8);
  });

  it("refuses a morph that is not one, changing nothing", async () => {
    const run = session(nodes());
    run.frames(1);
    const revision = run.store.view.getRevision();
    const result = await run.bus.execute("preset.recall", { nodeId: "bank", name: "plain", morph: { seconds: -1, curve: "linear" } }, contextFor(alice));
    expect(result.status).toBe("rejected");
    // §T1556b: the bus refuses it against the recall's input schema (`morphSpecSchema`, the
    // one the agent's recall_preset also extends), naming the field.
    expect(result.diagnostics[0]?.code).toBe("command.input");
    expect(result.diagnostics[0]?.message).toContain("morph.seconds");
    expect(run.store.view.getRevision()).toBe(revision);
    expect(run.stored("level", "brightness")).toBe(0.2);
  });
});

describe("what blends and what cuts at the start (§5.3)", () => {
  const knobs = (): GraphNode[] => [
    node("k", "test.knobs", "knobs1", { gain: 2, mode: "a", name: "one", taps: 4, tint: [1, 0, 0, 1], offset: [0, 10] }),
    {
      ...bank("bank", "looks", [
        preset("two", { knobs1: { gain: 6, mode: "b", name: "two", taps: 16, tint: [0, 0, 1, 0], offset: [4, 20] } }),
      ]),
      parameters: {
        targets: "knobs1",
        presets: serializePresetBank({
          version: 1,
          presets: [preset("two", { knobs1: { gain: 6, mode: "b", name: "two", taps: 16, tint: [0, 0, 1, 0], offset: [4, 20] } })],
        }),
      },
    },
  ];

  it("numbers and vectors blend; a menu, a string and a structural number are at their end at once", async () => {
    const run = session(knobs());
    run.frames(1);
    await recall(run, "two", LINEAR_1S);
    const [record] = run.records();
    if (record === undefined) throw new Error("no record");
    // The record holds EVERY key the recall changed — the cut ones too.
    expect(Object.keys(record.to["knobs1"] ?? {}).sort()).toEqual(["gain", "mode", "name", "offset", "taps", "tint"]);
    // …and the index offers only the ones that can fade, so nothing structural animates.
    const index = buildMorphIndex({ document: run.store.view.getGraph(), registry });
    expect([...(index.keysOf("k") ?? [])].sort()).toEqual(["gain", "offset", "tint"]);

    const frame = run.frames(30);
    expect(run.shown("k", "gain")).toBe(blend(2, 6, record, frame));
    expect(run.shown("k", "offset")).toEqual([blend(0, 4, record, frame), blend(10, 20, record, frame)]);
    expect(run.shown("k", "mode")).toBe("b");
    expect(run.shown("k", "name")).toBe("two");
    expect(run.shown("k", "taps")).toBe(16);
  });

  it("a display colour blends in LINEAR light, alpha as coverage", async () => {
    const run = session(knobs());
    run.frames(1);
    await recall(run, "two", LINEAR_1S);
    const [record] = run.records();
    if (record === undefined) throw new Error("no record");
    const frame = run.frames(30);
    const tint = run.shown("k", "tint") as readonly number[];
    // `values` is decoded (§V56): red and blue each halfway in LIGHT, which is 0.5 — where
    // blending the picker's numbers would give srgbToLinear(0.5) ≈ 0.214, a dark band.
    expect(tint[0]).toBeCloseTo(blend(srgbToLinear(1), srgbToLinear(0), record, frame), 12);
    expect(tint[2]).toBeCloseTo(blend(srgbToLinear(0), srgbToLinear(1), record, frame), 12);
    expect(tint[0]).toBeCloseTo(0.5, 9);
    expect(tint[3]).toBe(blend(1, 0, record, frame));
  });

  it("an end that is an EXPRESSION is evaluated live, not read off its retained static", async () => {
    const run = session(levelSet(expression("0.25 * 2", 7)));
    run.frames(5);
    await recall(run, "bright", LINEAR_1S);
    const [record] = run.records();
    if (record === undefined) throw new Error("no record");
    // The slot before the recall travels whole (ruling 2), expression and all.
    expect(record.from).toEqual({ level1: { brightness: expression("0.25 * 2", 7) } });
    const frame = run.frames(30);
    expect(run.shown("level", "brightness")).toBe(blend(0.5, 0.8, record, frame));
  });
});

describe("the value graph reads the same fade (§V61)", () => {
  it("a Constant a bank recalls with a morph PUBLISHES the fading value", async () => {
    const run = session([
      node("c", "constant", "constant1", { value: 0 }),
      { ...bank("bank", "looks", [preset("full", { constant1: { value: 1 } })]), parameters: {
        targets: "constant1",
        presets: serializePresetBank({ version: 1, presets: [preset("full", { constant1: { value: 1 } })] }),
      } },
    ]);
    run.frames(3);
    await recall(run, "full", LINEAR_1S);
    const [record] = run.records();
    if (record === undefined) throw new Error("no record");
    const frame = run.frames(30);
    const graph = run.store.view.getGraph();
    const values = createValueGraphSession(registry);
    const fading = values.evaluate(flatDocument(graph), frame, { flattening: { ...NO_FLATTENING, morphs: buildMorphIndex({ document: graph, registry }) } });
    expect(fading.byName.get("constant1")?.["value"]).toBe(blend(0, 1, record, frame));
    // Cut the wire: without the index the same frame publishes the destination.
    expect(values.evaluate(flatDocument(graph), frame, { flattening: NO_FLATTENING }).byName.get("constant1")?.["value"]).toBe(1);
  });
});

describe("a rename carries a fade in flight (§V128, §V320)", () => {
  it("the record follows the node's new name and keeps fading it", async () => {
    const run = session(levelSet());
    run.frames(5);
    await recall(run, "bright", LINEAR_1S);
    run.frames(20);
    const renamed = await run.bus.execute("node.rename", { nodeId: "level", label: "grade", exact: true }, contextFor(alice));
    expect(renamed.status).toBe("applied");
    const [record] = run.records();
    if (record === undefined) throw new Error("no record");
    expect(Object.keys(record.from)).toEqual(["grade"]);
    expect(Object.keys(record.to)).toEqual(["grade"]);
    const frame = run.frames(1);
    expect(run.shown("level", "brightness")).toBe(blend(0.2, 0.8, record, frame));
    expect(run.shown("level", "brightness")).toBeLessThan(0.8);
  });
});

describe("a bank keeps at most four records (§5.2)", () => {
  it("drops the oldest and says so in the recall's result", async () => {
    const keys = ["blacklevel", "whitelevel", "invert", "contrast", "brightness"] as const;
    const run = session([
      node("level", "level", "level1", {}),
      bank("bank", "looks", keys.map((key) => preset(key, { level1: { [key]: 0.5 } }))),
    ]);
    run.frames(1);
    const slow: MorphSpec = { seconds: 60, curve: "linear" };
    for (const key of keys.slice(0, 4)) {
      const result = await recall(run, key, slow);
      expect(result.diagnostics.filter((each) => each.code === "preset.recall.morphDropped")).toEqual([]);
      run.frames(1);
    }
    const fifth = await recall(run, "brightness", slow);
    expect(run.records().map((each) => each.preset)).toEqual(["whitelevel", "invert", "contrast", "brightness"]);
    const said = fifth.diagnostics.filter((each) => each.code === "preset.recall.morphDropped");
    expect(said).toHaveLength(1);
    expect(said[0]?.message).toContain('"blacklevel"');
    // The key only the dropped record covered is at its end value.
    expect(run.shown("level", "blacklevel")).toBe(0.5);
  });
});

/**
 * §T1557b / §B181's shape — A RECALL READS ITS BANK'S MORPH AT THIS MOMENT, through the
 * command's read scope.
 *
 * `resolvedBank` used to resolve the bank with `{ channels }` and nothing else: no cross-node
 * reader, so `op('k1').chan.value` on the bank's Morph reported "no reader" and fell back to
 * its retained static (0 — a cut) while the channel said 3. The bus is wired here as the app
 * wires it: the channel resolver (`graphChannelResolver`, the backstop of the app's ladder)
 * and the frame the transport last produced.
 */
describe("§T1557b — a bank's Morph driven by op('k1').chan.value (B181's shape)", () => {
  it("fades for the channel's seconds, not the retained static", async () => {
    const run = session([
      node("level", "level", "level1", { brightness: 0.2 }),
      node("k1", "constant", "k1", { value: 3 }),
      bank("bank", "looks", [preset("bright", { level1: { brightness: 0.8 } })], { morph: expression("op('k1').chan.value", 0) }),
    ]);
    run.bus.attachChannelResolver(() => graphChannelResolver(flatDocument(run.store.view.getGraph()), registry));
    run.bus.attachFrame(() => run.latest());
    run.frames(1);

    const result = await recall(run, "bright");
    expect(result.status).toBe("applied");
    // 3 s only if the bank's Morph was read through a reader with the channels behind it.
    // The bug read the retained static: `morph: null`, a cut.
    expect(result.output.morph).toEqual({ seconds: 3, curve: "smooth" });
    expect(run.records().map((each) => each.seconds)).toEqual([3]);
  });
});
