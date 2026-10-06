import { Buffer } from "node:buffer";

import { beforeAll, describe, expect, it } from "vitest";
import type { GraphDocument } from "../domain/types/graph.ts";
import type { BackendCapabilities } from "../domain/types/backend.ts";
import type { StoredParameter } from "../domain/types/parameters.ts";
import { compileGraph } from "../compiler/index.ts";
import { alice, contextFor } from "../domain/commands/test-support.ts";
import { isParameterSlot } from "../domain/parameters/slots.ts";
import { parsePresetBank } from "../domain/presets/bank.ts";
import { parseCueList } from "../domain/presets/cue-list.ts";
import type { CueFireOutput } from "../domain/presets/cue-commands.ts";
import { presetSession, type PresetSession } from "../domain/presets/test-support.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { ANNOTATE_TYPE } from "../nodes/definitions/annotate.ts";
import { boardRectsOverlap, controlNameOf, panelBoard, panelMembers } from "../nodes/definitions/controls.ts";
import { DEVICE_HELPER_PHONE_COMMAND } from "../devices/helper.ts";
import { setListDocument } from "./documents/set-list.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { decodeHalf } from "../tests/headless/pixel-compare.ts";

/**
 * E82 — Set List on Dawn: THE SET PLAYS, asserted from pixels (T1504b, §T1398b S9).
 *
 * Every cue is fired the way the Show desk, the GO key and a phone fire it — `cue.go` on the
 * real bus, with a frame clock attached the way the app attaches its transport's — and then
 * the document the command left behind is rendered through the real compiler and backend.
 *
 * WHAT A CUE'S END STATE IS HELD AGAINST: a TWIN, the shipped graph with the state the `.md`
 * and the notes promise for that cue written straight onto the nodes (no bank, no recall).
 * The states are spelled out below as literals rather than read from the banks, so a bank
 * edited to say something else fails here. Twin and session are compared byte for byte at
 * the same frame of the same clock (§V147: exact), which holds every stage at once — the
 * looks, the layer blends, the glitch, the master and the Corner Pin.
 *
 * TIME is the transport's absolute clock at 60 fps: frame N is N / 60 s. A cue is stamped at
 * absolute time 0 of an epoch of its own, so its fade is over at frame `seconds × 60`, and
 * every earlier cue's fade — a record of another epoch — is finished (`morph.ts`).
 *
 * Intermediate stages are read in the working format (linear rgba16float); `step(v)` is the
 * spacing of halves at v, and every tolerance is a count of those steps, derived where used.
 */
let unavailable: string | undefined;
beforeAll(async () => {
  unavailable = (await probeDawn()).error;
}, 60_000);

const WIDTH = 160;
const HEIGHT = 90;
const PIXELS = WIDTH * HEIGHT;
const FPS = 60;
const registry = createNodeRegistry(allNodeDefinitions).view();
const settings = { ...setListDocument.settings, outputResolution: { width: WIDTH, height: HEIGHT } };

/** The spacing of rgba16float values at v (10 mantissa bits; the subnormal spacing below 2^-14). */
function step(v: number): number {
  const magnitude = Math.abs(v);
  return magnitude < 2 ** -14 ? 2 ** -24 : 2 ** (Math.floor(Math.log2(magnitude)) - 10);
}

/* ------------------------------------------------------------------------------------ */
/* The set, as the notes and the .md describe it                                         */
/* ------------------------------------------------------------------------------------ */

type Values = Readonly<Record<string, Readonly<Record<string, StoredParameter>>>>;

/** What is on the nodes: parameter values by node name, and which layers are switched off. */
interface StackState {
  readonly values: Values;
  readonly off: readonly string[];
}

const LAYERS = ["layerRings", "layerGrid", "layerFx"] as const;

const DAWN: Values = {
  ringsSrc: { period: 2.5 },
  rings: { hueoffset: 0, saturation: 0.7, value: 1 },
  grid: { r: 0, s: [1, 1] },
};
const NOON: Values = {
  ringsSrc: { period: 5 },
  rings: { hueoffset: 40, saturation: 1.2, value: 1.1 },
  grid: { r: 15, s: [1.5, 1.5] },
};
/** riot's rotation is an EXPRESSION: the whole slot comes back (ruling 2). */
const RIOT_ROTATION = "sin(abstime * 0.7) * 45";
const RIOT: Values = {
  ringsSrc: { period: 9 },
  rings: { hueoffset: 120, saturation: 1.8, value: 1.2 },
  grid: {
    r: { mode: "expression", bindings: { static: { kind: "static", value: 45 }, expression: { kind: "expression", source: RIOT_ROTATION } } },
    s: [0.6, 0.6],
  },
};
const CLEAN: Values = { shear: { weight: [0, 0] }, glitch: { hueoffset: 0, saturation: 1, value: 1 } };
const DIRTY: Values = { shear: { weight: [0.15, 0] }, glitch: { hueoffset: -30, saturation: 1.6, value: 1.1 } };

const opacities = (rings: number, grid: number, fx: number): Values => ({
  layerRings: { opacity: rings },
  layerGrid: { opacity: grid },
  layerFx: { opacity: fx },
});

/** `state` with `changes` laid over it, key by key. */
function then(state: StackState, changes: readonly Values[], off: readonly string[]): StackState {
  const values: Record<string, Record<string, StoredParameter>> = {};
  for (const layer of [state.values, ...changes]) {
    for (const [name, keys] of Object.entries(layer)) values[name] = { ...values[name], ...keys };
  }
  return { values, off };
}

interface CueClaim {
  readonly cue: string;
  readonly bank: string;
  readonly preset: string;
  /** The morph the cue is carried out with, or `null` for a cut. */
  readonly morph: { readonly seconds: number; readonly curve: string } | null;
  /** The state the stack is in once the cue has arrived. */
  readonly state: StackState;
}

const SHIPPED: StackState = { values: {}, off: [] };
const OPEN = then(SHIPPED, [DAWN, CLEAN, opacities(1, 0, 0)], ["layerGrid", "layerFx"]);
const WARM = then(OPEN, [NOON], ["layerGrid", "layerFx"]);
const CROSS = then(WARM, [{ layerGrid: { opacity: 1 } }], ["layerFx"]);
const DROP = then(CROSS, [RIOT, DIRTY, { layerFx: { opacity: 0.85 } }], ["layerRings"]);
// `out` fades the grid and the FX to 0 and leaves both layers ON (ruling 13), and recalls no
// fx preset: the glitch chain keeps `dirty`, unseen at opacity 0.
const OUT = then(DROP, [DAWN, opacities(1, 0, 0)], []);

const SET: readonly CueClaim[] = [
  { cue: "1 open", bank: "presets_shots", preset: "open", morph: { seconds: 2, curve: "smooth" }, state: OPEN },
  { cue: "2 warm", bank: "presets_looks", preset: "noon", morph: { seconds: 4, curve: "smooth" }, state: WARM },
  { cue: "3 cross", bank: "presets_shots", preset: "cross", morph: { seconds: 1, curve: "linear" }, state: CROSS },
  { cue: "4 drop", bank: "presets_shots", preset: "drop", morph: null, state: DROP },
  { cue: "5 out", bank: "presets_shots", preset: "out", morph: { seconds: 4, curve: "smooth" }, state: OUT },
];

/** The shipped graph with `state` written straight onto the nodes: no bank, no recall. */
function authored(state: StackState): GraphDocument {
  const graph = structuredClone(setListDocument.graph);
  for (const [name, keys] of Object.entries(state.values)) Object.assign(graph.nodes[name]!.parameters, structuredClone(keys));
  for (const layer of LAYERS) graph.nodes[layer]!.ui = { ...graph.nodes[layer]!.ui, bypassed: state.off.includes(layer) };
  return graph;
}

/* ------------------------------------------------------------------------------------ */
/* Firing and rendering                                                                   */
/* ------------------------------------------------------------------------------------ */

const epochOf = (index: number): string => `cue-${String(index + 1)}`;

/** GO on the real bus, stamped at absolute time 0 of `epoch`. */
async function go(session: PresetSession, epoch: string): Promise<CueFireOutput> {
  session.at({ epoch, absTimeSeconds: 0 });
  const result = await session.bus.execute("cue.go", { nodeId: "set" }, contextFor(alice));
  expect(result.status, (result.diagnostics ?? []).map((each) => each.message).join("; ")).toBe("applied");
  expect((result.diagnostics ?? []).map((each) => each.code)).toEqual([]);
  if (result.status !== "applied") throw new Error("cue.go was not applied");
  return result.output;
}

/** A session that has played the first `count` cues, each in its own epoch. */
async function played(count: number): Promise<PresetSession> {
  const session = presetSession(structuredClone(setListDocument.graph), registry);
  for (let index = 0; index < count; index += 1) await go(session, epochOf(index));
  return session;
}

interface Shot {
  readonly bytes: Buffer;
  /** rgba16float decoded, four values per pixel. */
  readonly values: Float64Array;
}

/** `nodeId`'s output on frames `capture`, rendered animated as the app renders; `epoch` absent = an export. */
async function render(graph: GraphDocument, nodeId: string, capture: readonly number[], epoch?: string): Promise<Shot[]> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings,
    fps: FPS,
    frames: Math.max(...capture) + 1,
    capture: [...capture],
    outputNodeId: nodeId,
    animate: true,
    ...(epoch === undefined ? {} : { absEpoch: epoch }),
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(result.frames.map((frame) => frame.frameIndex)).toEqual([...capture]);
  return result.frames.map((frame) => {
    expect(frame.format).toBe("rgba16float");
    const bits = new Uint16Array(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength / 2);
    return { bytes: Buffer.from(frame.bytes), values: Float64Array.from(bits, decodeHalf) };
  });
}

const shot = async (graph: GraphDocument, nodeId: string, frame: number, epoch?: string): Promise<Shot> => {
  const [only] = await render(graph, nodeId, [frame], epoch);
  if (only === undefined) throw new Error("no frame captured");
  return only;
};

/** Pixels whose rgb differ at all. */
function differing(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let count = 0;
  for (let index = 0; index < PIXELS; index += 1) {
    if ([0, 1, 2].some((channel) => a[index * 4 + channel] !== b[index * 4 + channel])) count += 1;
  }
  return count;
}

const capabilities: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};
const compile = (graph: GraphDocument) => compileGraph({ graph, settings: setListDocument.settings, registry, capabilities });

/** The nodes the plan has a pass for. */
function cooking(graph: GraphDocument): Set<string> {
  const plan = compile(graph);
  expect(plan.ok).toBe(true);
  return new Set(plan.passes.flatMap((pass) => ("nodeId" in pass && pass.nodeId !== undefined ? [String(pass.nodeId)] : [])));
}

const LOOK_RINGS = ["ringsSrc", "rings"];
const LOOK_GRID = ["gridSrc", "grid"];
const FX_CHAIN = ["tear", "shear", "glitch"];

describe("E82 Set List — every cue arrives at the state its note promises", () => {
  it("GO five times: each cue fires its preset with its own morph, and the picture ends byte-identical to that state authored by hand", async () => {
    expect(unavailable).toBeUndefined();
    const session = presetSession(structuredClone(setListDocument.graph), registry);
    const ends: Shot[] = [await shot(setListDocument.graph, "out", 0)];
    for (const [index, claim] of SET.entries()) {
      const fired = await go(session, epochOf(index));
      expect({ cue: fired.cue, bank: fired.bank, preset: fired.preset, morph: fired.morph }).toEqual({
        cue: claim.cue,
        bank: claim.bank,
        preset: claim.preset,
        morph: claim.morph,
      });
      // The list moved with the recall: this cue is current, the next stands by (Wrap is on).
      expect(fired.current).toBe(claim.cue);
      expect(fired.standby).toBe(SET[(index + 1) % SET.length]!.cue);

      // The frame the fade arrives on — frame 0 for a cut — in the cue's own epoch.
      const arrival = (claim.morph?.seconds ?? 0) * FPS;
      const live = await shot(session.graph(), "out", arrival, epochOf(index));
      const twin = await shot(authored(claim.state), "out", arrival);
      expect(Buffer.compare(live.bytes, twin.bytes), `${claim.cue}: the picture is not the state its note describes`).toBe(0);
      // Not a cue that changed nothing: most of the frame differs from the cue before it.
      const before = ends[ends.length - 1]!;
      expect(differing(live.values, before.values), `${claim.cue} looks like the cue before it`).toBeGreaterThan(PIXELS * 0.5);
      ends.push(live);
    }

    // Wrap: GO after the last cue fires the first again, and the set is back where cue 1 left it.
    const again = await go(session, "cue-6");
    expect(again.cue).toBe("1 open");
    const wrapped = await shot(session.graph(), "out", 2 * FPS, "cue-6");
    const twin = await shot(authored(then(OUT, [DAWN, CLEAN, opacities(1, 0, 0)], ["layerGrid", "layerFx"])), "out", 2 * FPS);
    expect(Buffer.compare(wrapped.bytes, twin.bytes)).toBe(0);
  }, 600_000);

  it("riot brings an EXPRESSION back: after 4 drop the grid rocks on its own, and after 5 out it holds still", async () => {
    expect(unavailable).toBeUndefined();
    const dropped = await played(4);
    const slot = dropped.graph().nodes["grid"]!.parameters["r"];
    expect(isParameterSlot(slot) && slot.mode === "expression" && slot.bindings.expression?.kind === "expression" ? slot.bindings.expression.source : slot).toBe(RIOT_ROTATION);
    const [early, late] = await render(dropped.graph(), "grid", [0, 60], epochOf(3));
    expect(differing(early!.values, late!.values)).toBeGreaterThan(PIXELS * 0.2);

    const out = await played(5);
    // 4 s after the cue the fade has arrived; a second later nothing in the look has moved.
    const [arrived, later] = await render(out.graph(), "grid", [4 * FPS, 5 * FPS], epochOf(4));
    expect(Buffer.compare(arrived!.bytes, later!.bytes)).toBe(0);
  }, 300_000);
});

describe("E82 Set List — a cue's morph is on the pixels at its analytic value", () => {
  /**
   * `3 cross` is the crossfade idiom: the shot switches `layer_grid` ON (a cut, at the start)
   * and its opacity goes 0 → 1. The cue's morph is 1 s LINEAR, so on frame 30 of 60 fps the
   * opacity the shader reads is exactly 0.5 — and a Layer's output is
   * `mix(below, blend(picture, below), opacity)`, linear in opacity, so that frame is the
   * exact average of the opacity-0 and opacity-1 pictures of the same frame.
   */
  it("3 cross, a 1 s linear morph: frame 30 is the layer at opacity 0.5 — byte-identical to that state authored by hand, and the average of both ends", async () => {
    expect(unavailable).toBeUndefined();
    const session = await played(2);
    const fired = await go(session, "show");
    // The cue's 1 s linear beat the shot's own 2 s smooth.
    expect(fired.morph).toEqual({ seconds: 1, curve: "linear" });
    const graph = session.graph();
    // The document holds the destination; only the picture is still on its way.
    expect(graph.nodes["layerGrid"]!.parameters["opacity"]).toBe(1);
    expect(graph.nodes["layerGrid"]!.ui?.bypassed).toBe(false);

    const at = (opacity: number): GraphDocument => authored(then(WARM, [{ layerGrid: { opacity } }], ["layerFx"]));
    const [start, half, end] = await render(graph, "out", [0, 30, 60], "show");
    // No jump on the frame of the cue, the midpoint at 0.5, exact arrival.
    expect(Buffer.compare(start!.bytes, (await shot(at(0), "out", 0)).bytes)).toBe(0);
    expect(Buffer.compare(half!.bytes, (await shot(at(0.5), "out", 30)).bytes)).toBe(0);
    expect(Buffer.compare(end!.bytes, (await shot(at(1), "out", 60)).bytes)).toBe(0);
    expect(differing(half!.values, start!.values)).toBeGreaterThan(PIXELS * 0.5);

    // And analytically, at the layer itself: mid = (below + blended) / 2. A stored half is
    // within ONE step of the value the shader computed, not half a step — Metal does not
    // round the write to the nearest half (E81's finding; measured here at 0.97 of a step).
    // So the stored mid is within a step of the true mid, and each stored end within a step
    // of its own true value, which the average halves.
    const mid = (await shot(graph, "layerGrid", 30, "show")).values;
    const below = (await shot(at(0), "layerGrid", 30)).values;
    const blended = (await shot(at(1), "layerGrid", 30)).values;
    let moved = 0;
    for (let index = 0; index < PIXELS * 4; index += 1) {
      const a = below[index]!;
      const b = blended[index]!;
      const m = mid[index]!;
      expect(Math.abs(m - (a + b) / 2), `value ${index}: ${m} vs (${a} + ${b}) / 2`).toBeLessThanOrEqual(step(m) + (step(a) + step(b)) / 2);
      if (Math.abs(a - b) > 4 * step(Math.max(a, b))) moved += 1;
    }
    // The two ends are different pictures over most of the frame, so the average is a claim.
    expect(moved).toBeGreaterThan(PIXELS);
  }, 300_000);
});

describe("E82 Set List — a layer that is off costs nothing", () => {
  it("ships with every layer on, and each shot's `on` takes the look behind a switched-off layer out of the plan", async () => {
    // As shipped: all three layers on, so both looks and the glitch chain cook.
    const shipped = cooking(setListDocument.graph);
    for (const id of [...LAYERS, ...LOOK_RINGS, ...LOOK_GRID, ...FX_CHAIN]) expect(shipped.has(id), `${id} as shipped`).toBe(true);

    // 1 open switches the grid and FX layers off: neither they nor their chains have a pass.
    const open = cooking((await played(1)).graph());
    for (const id of ["layerGrid", "layerFx", ...LOOK_GRID, ...FX_CHAIN]) expect(open.has(id), `${id} after 1 open`).toBe(false);
    for (const id of ["layerRings", ...LOOK_RINGS, "source", "dim", "pin", "out"]) expect(open.has(id), `${id} after 1 open`).toBe(true);

    // 3 cross switches the grid layer on: its look is back; the FX chain is still out.
    const cross = cooking((await played(3)).graph());
    for (const id of ["layerGrid", ...LOOK_GRID]) expect(cross.has(id), `${id} after 3 cross`).toBe(true);
    for (const id of ["layerFx", ...FX_CHAIN]) expect(cross.has(id), `${id} after 3 cross`).toBe(false);

    // 4 drop switches the rings off and the FX on.
    const drop = cooking((await played(4)).graph());
    for (const id of ["layerRings", ...LOOK_RINGS]) expect(drop.has(id), `${id} after 4 drop`).toBe(false);
    for (const id of ["layerFx", ...FX_CHAIN, "layerGrid", ...LOOK_GRID]) expect(drop.has(id), `${id} after 4 drop`).toBe(true);
  });
});

/** Signed distance of point p from the line a→b, positive on the left (a CCW quad's inside). */
function leftOf(a: readonly [number, number], b: readonly [number, number], p: readonly [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return (dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / Math.hypot(dx, dy);
}

/** The shipped graph with the named sliders moved — the way a hand or a phone moves them. */
function moved(sliders: Record<string, number>): GraphDocument {
  const graph = structuredClone(setListDocument.graph);
  for (const [id, value] of Object.entries(sliders)) graph.nodes[id]!.parameters["value"] = value;
  return graph;
}

describe("E82 Set List — the mapping and the desk's two sliders", () => {
  it("the Corner Pin warps: the picture covers exactly the keystoned quad, the corners outside it are transparent, and the output shows them black", async () => {
    expect(unavailable).toBeUndefined();
    const topLeft = 0; // row 0 is the top
    const bottomLeft = (HEIGHT - 1) * WIDTH;
    const covered: number[] = [];
    for (const keystone of [0, 0.12, 0.3]) {
      const pinned = (await shot(moved({ keystone }), "pin", 0)).values;
      const quad = [
        [0, 0],
        [1, 0],
        [1 - keystone, 1],
        [keystone, 1],
      ] as const;
      let inside = 0;
      let outside = 0;
      for (let y = 0; y < HEIGHT; y += 1) {
        for (let x = 0; x < WIDTH; x += 1) {
          // The node's corners are y-up.
          const point = [(x + 0.5) / WIDTH, 1 - (y + 0.5) / HEIGHT] as const;
          const distance = Math.min(...quad.map((corner, i) => leftOf(corner, quad[(i + 1) % 4]!, point)));
          // f32 in the shader and f64 here disagree only within rounding of an edge.
          if (Math.abs(distance) < 1e-4) continue;
          const alpha = pinned[(y * WIDTH + x) * 4 + 3]!;
          if (distance > 0) {
            expect(alpha, `inside ${x},${y} at keystone ${keystone}`).toBe(1);
            inside += 1;
          } else {
            expect(alpha, `outside ${x},${y} at keystone ${keystone}`).toBe(0);
            outside += 1;
          }
        }
      }
      expect(inside).toBeGreaterThan(PIXELS * 0.5);
      if (keystone > 0) expect(outside).toBeGreaterThan(PIXELS * 0.03);
      covered.push(pinned[topLeft * 4 + 3]!, pinned[bottomLeft * 4 + 3]!);
    }
    // Top-left then bottom-left, per keystone: unpinned the corner is covered; as shipped
    // (0.12) and pulled further in it is bare, and the bottom corners never move.
    expect(covered).toEqual([1, 1, 0, 1, 0, 1]);

    // At the output the bare corner is the black under the pinned picture.
    const out = (await shot(setListDocument.graph, "out", 0)).values;
    expect([...out.slice(topLeft * 4, topLeft * 4 + 4)]).toEqual([0, 0, 0, 1]);
    expect(out[bottomLeft * 4]! + out[bottomLeft * 4 + 1]! + out[bottomLeft * 4 + 2]!).toBeGreaterThan(0);
  }, 300_000);

  it("the Master slider scales the picture: at 1 every value of dim is twice its value at 0.5", async () => {
    expect(unavailable).toBeUndefined();
    const low = (await shot(moved({ master: 0.5 }), "dim", 0)).values;
    const high = (await shot(moved({ master: 1 }), "dim", 0)).values;
    let lit = 0;
    for (let index = 0; index < PIXELS; index += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        const a = low[index * 4 + channel]!;
        const b = high[index * 4 + channel]!;
        // One step each (half of rounding, half from the level shader's pow — E81's bound),
        // and a's is doubled.
        expect(Math.abs(b - 2 * a), `pixel ${index} channel ${channel}: ${b} vs 2 × ${a}`).toBeLessThanOrEqual(step(b) + 2 * step(a));
        if (a > 0.01) lit += 1;
      }
    }
    expect(lit).toBeGreaterThan(PIXELS * 0.8);
  }, 120_000);
});

describe("E82 Set List — the banks, the desk and the notes", () => {
  const graph = setListDocument.graph;
  const nodes = Object.values(graph.nodes);
  const bank = (name: string) => {
    const parsed = parsePresetBank(graph.nodes[name]!.parameters["presets"]);
    if (!parsed.ok) throw new Error(`${name}: ${parsed.reason}`);
    return parsed.bank.presets;
  };

  it("ships before the first GO: three banks, one cue list of five cues with Wrap on, nothing current", () => {
    expect(bank("looks").map((preset) => preset.name)).toEqual(["dawn", "noon", "riot"]);
    expect(bank("fx").map((preset) => preset.name)).toEqual(["clean", "dirty", "acid"]);
    expect(bank("shots").map((preset) => preset.name)).toEqual(["open", "cross", "drop", "out"]);
    // Every shot but the crossfade recalls another bank's presets; every shot switches a layer.
    for (const preset of bank("shots")) expect(Object.keys(preset.on ?? {}).length, preset.name).toBeGreaterThan(0);
    expect(bank("shots").filter((preset) => (preset.recalls ?? []).length > 0).map((preset) => preset.name)).toEqual(["open", "drop", "out"]);

    const list = parseCueList(graph.nodes["set"]!.parameters["cues"]);
    expect(list.ok && list.list.cues.map((cue) => cue.name)).toEqual(SET.map((claim) => claim.cue));
    expect(graph.nodes["set"]!.parameters["wrap"]).toBe(true);
    for (const id of ["looks", "fx", "shots", "set"]) expect(graph.nodes[id]!.parameters["current"] ?? "", id).toBe("");
  });

  /**
   * The way a user builds it: a Layer's Picture is a NAME. The canvas draws no socket for
   * that input and `connect` refuses a wire into it, so an example wired there would show a
   * graph nobody can make.
   */
  it("every layer names its picture, and nothing is wired into a Picture input", () => {
    const pictures = LAYERS.map((layer) => graph.nodes[layer]!.parameters["picture"]);
    expect(pictures).toEqual(["hsv_rings", "transform_grid", "hsv_glitch"]);
    const wired = Object.values(graph.edges).filter((edge) => edge.target.portId === "picture" && graph.nodes[edge.target.nodeId]?.type === "layer");
    expect(wired).toEqual([]);
    // Each name is a node, and it is the end of the chain the plan claim above calls that layer's.
    // (The chains are node ids; a Picture is a name. They are the same node, found by its name.)
    const named = pictures.map((picture) => nodes.find((node) => node.label === picture)?.id);
    expect(named).toEqual([LOOK_RINGS.at(-1), LOOK_GRID.at(-1), FX_CHAIN.at(-1)]);
  });

  it("has one Panel, the Show desk, published to phones: the shots, the cue list and the FX layer by name, the two sliders by wire, placed without overlap", () => {
    const panels = nodes.filter((node) => node.type === "panel");
    expect(panels).toHaveLength(1);
    const panel = panels[0]!;
    expect(panel.parameters["title"]).toBe("Show desk");
    expect(panel.parameters["remote"]).toBe(true);
    expect(panelMembers(graph, panel).map(controlNameOf)).toEqual(["slider_master", "slider_keystone"]);
    const board = panelBoard(graph, panel)!;
    const placed = board.items.flatMap((item) => (item.kind === "widget" ? [[controlNameOf(item.node), item.node.type, item.rect] as const] : []));
    expect(placed.map(([name, type]) => `${name}(${type})`).sort()).toEqual(
      ["slider_keystone(slider)", "layer_fx(layer)", "slider_master(slider)", "cuelist_set(cueList)", "presets_shots(presets)"].sort(),
    );
    expect(board.items.some((item) => item.kind === "label")).toBe(true);
    // The layer's rect is four cells wide — room for its fader beside its switch — and the
    // cue list's is two rows — room for the current and next cue above GO and BACK.
    expect(placed.find(([name]) => name === "layer_fx")![2].w).toBeGreaterThanOrEqual(4);
    expect(placed.find(([name]) => name === "cuelist_set")![2].h).toBeGreaterThanOrEqual(2);
    for (const [index, item] of board.items.entries()) {
      expect(item.rect.x + item.rect.w).toBeLessThanOrEqual(board.columns);
      for (const other of board.items.slice(index + 1)) expect(boardRectsOverlap(item.rect, other.rect), `${item.key} on ${other.key}`).toBe(false);
    }
  });

  it("tells the reader the helper command the product builds", () => {
    const bodies = nodes.filter((node) => node.type === ANNOTATE_TYPE).map((node) => String(node.parameters["body"]));
    expect(bodies.some((body) => body.includes(DEVICE_HELPER_PHONE_COMMAND))).toBe(true);
  });

  it("renders the same plan with the notes removed", () => {
    const notes = nodes.filter((node) => node.type === ANNOTATE_TYPE).map((node) => node.id);
    expect(notes).toHaveLength(7);
    const bare = structuredClone(graph);
    for (const id of notes) delete bare.nodes[id];
    const withNotes = compile(graph);
    const without = compile(bare);
    expect(withNotes.ok).toBe(true);
    expect(withNotes.signature).toBe(without.signature);
    expect(withNotes.passes).toEqual(without.passes);
    expect(withNotes.outputs).toEqual(without.outputs);
    // The notes, the desk, the banks and the cue list render nothing; everything else cooks.
    expect([...withNotes.pruned].sort()).toEqual([...notes, "desk", "looks", "fx", "shots", "set"].sort());
  });
});
