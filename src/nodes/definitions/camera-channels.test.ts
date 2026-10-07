import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { cameraPayloadMatrix } from "../../domain/geometry/camera.ts";
import { isValueSourceDefinition } from "../../domain/graph/liveness.ts";
import { NO_FLATTENING, nodeReferenceMembers, parameterReadOptions } from "../../domain/parameters/node-references.ts";
import { effectiveParameterSchema, resolveParameters } from "../../domain/parameters/resolve.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import { authoredGraph, type FlatGraph, type GraphDocument } from "../../domain/types/graph.ts";
import { publishesValueChannels } from "../../domain/types/node-definition.ts";
import { codeBuiltFindings } from "../../examples/checked-project.ts";
import { refusedAtCodeSave } from "../../compiler/document-findings.ts";
import { document as project, edge, expressionSlot, graph, named, settings } from "../../examples/documents/builders.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";

/**
 * §T1674b — A CAMERA'S POSE IN THE WORLD, READ BY AN EXPRESSION.
 *
 * Since §T1656b a Camera's Eye and Look At are offsets in the frame its Origin and Heading
 * make, and `op('camera_rig').par.eye` gives the offset. A Render never sees that: the
 * payload carries the composed pose. A texture pass that rebuilds a view ray reads the node
 * by expression, got the offset, and the consumer's lit air went out with nothing said.
 *
 * So the camera publishes the composed pose as channels, `op('camera_rig').chan.eyeX`, from
 * the SAME function the payload is built by. What is held here is what a reader gets back:
 * the numbers, against the matrix the Render draws through; where the read works (with no
 * channel resolver at all); what it costs a node that has it (nothing of a value node's);
 * and the finding for a reader that still reads the offset.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();
const SETTINGS = settings({ outputResolution: { width: 640, height: 360 } });
const ASPECT = 640 / 360;
const AXES = ["X", "Y", "Z"] as const;
const POSE = ["eye", "aim", "forward", "right", "up"] as const;

const frameAt = (seconds: number): FrameEvaluationInput => ({
  timeSeconds: seconds,
  deltaSeconds: 1 / 60,
  frameIndex: Math.round(seconds * 60),
  mode: "offline",
  randomSeed: 7,
});

/** A scene through `camera_rig`, and one Constant per channel reading it: `constant_eyeX`, …. */
function shot(camera: Record<string, unknown>, readers: Record<string, string> = {}): GraphDocument {
  const channels = [...POSE.flatMap((part) => AXES.map((axis) => `${part}${axis}`)), "distance", "fov"];
  return graph(
    [
      named("source", "pointGrid", [0, 0], { cols: 4, rows: 4 }),
      named("boxes", "geometry", [400, 0], { mode: "instances" }),
      named("rig", "camera", [0, 400], camera as never),
      named("shot", "render", [400, 400]),
      ...channels.map((channel, index) =>
        named(channel, "constant", [800, index * 120], { value: expressionSlot(`op('camera_rig').chan.${channel}`, -99) } as never),
      ),
      ...Object.entries(readers).map(([role, source], index) =>
        named(role, "constant", [1200, index * 120], { value: expressionSlot(source, -99) } as never),
      ),
    ],
    [
      edge("e1", ["grid_source", "out"], ["geometry_boxes", "points"]),
      edge("e2", ["geometry_boxes", "out"], ["render_shot", "scenes"]),
      edge("e3", ["camera_rig", "out"], ["render_shot", "camera"]),
    ],
  );
}

/** What `constant_<role>`'s Value resolves to, WITH NO CHANNEL RESOLVER: a structural compile's read, a panel's. */
function read(document: GraphDocument, role: string, seconds = 0): { value: unknown; said: string | null; code: string | null } {
  const node = document.nodes[`constant_${role}`];
  if (node === undefined) throw new Error(`no constant_${role}`);
  const options = parameterReadOptions({ graph: authoredGraph(document), registry, frame: frameAt(seconds), channels: undefined, flattening: NO_FLATTENING });
  const entry = resolveParameters(node, registry.get("constant"), options).get("value");
  return { value: entry?.value, said: entry?.diagnostic?.message ?? null, code: entry?.diagnostic?.code ?? null };
}

/** The matrix the Render draws through. */
function drawnThrough(document: GraphDocument, seconds = 0): number[] {
  const compiled = compileGraph({
    graph: document,
    settings: SETTINGS,
    registry,
    capabilities: TIER_B_CAPABILITIES,
    sinks: [{ nodeId: "render_shot", portId: "out", kind: "preview" as const }],
    resolution: { frame: frameAt(seconds) },
  } as never);
  expect(compiled.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  const matrix = compiled.passes
    .filter((pass) => (pass as { nodeId?: string }).nodeId === "render_shot")
    .map((pass) => (pass as { uniforms?: Record<string, unknown> }).uniforms?.["viewProjection"])
    .find((value) => value !== undefined);
  if (matrix === undefined) throw new Error("the fixture drew no view matrix");
  return Array.from(matrix as ArrayLike<number>);
}

const vector = (document: GraphDocument, part: (typeof POSE)[number], seconds = 0): [number, number, number] =>
  AXES.map((axis) => read(document, `${part}${axis}`, seconds).value as number) as [number, number, number];

/** The peer's rig: where the camera is and where it looks are expressions, on Origin and Heading. */
const RIG = {
  eye: [0, 0.5, 3],
  lookAt: [0.25, 0, 0],
  "origin.x": expressionSlot("4 * cos(time)", 4),
  "origin.y": expressionSlot("1 + 0.5 * sin(time * 2)", 1),
  "origin.z": expressionSlot("4 * sin(time)", 0),
  "heading.x": expressionSlot("0 - 4 * cos(time)", -4),
  "heading.z": expressionSlot("0 - 4 * sin(time)", 0),
  fov: 40,
  roll: 12,
};

describe("T1674b — the camera's composed pose is read by name, from the function the payload is built by", () => {
  it("⚑ the channels ARE the pose the Render draws through: rebuilt from them, its matrix is the Render's own", () => {
    const document = shot(RIG);
    for (const seconds of [0, 0.5, 1.25]) {
      const eye = vector(document, "eye", seconds);
      const aim = vector(document, "aim", seconds);
      const fromChannels = cameraPayloadMatrix(
        { eye, lookAt: aim, fovDeg: read(document, "fov", seconds).value as number, near: 0.1, far: 100, ortho: false, orthoHeight: 2, roll: 12 },
        ASPECT,
      );
      // Exact: the same numbers by the same function, not a second saying of the frame.
      expect(Array.from(fromChannels)).toEqual(drawnThrough(document, seconds));
    }
    // And they MOVE with the rig: a frozen read would pass the line above at one moment only.
    expect(vector(document, "eye", 0)).not.toEqual(vector(document, "eye", 0.5));
  });

  it("the offset is NOT the pose: what `par.eye` gives on this rig is another point", () => {
    const document = shot(RIG, { offset: "op('camera_rig').par.eye.z" });
    expect(read(document, "offset").value).toBe(3);
    // At time 0 the frame is at (4, 1, 0) facing −x: three behind is x = 7, and the offset's z of 3 is none of the eye's.
    expect(vector(document, "eye")).toEqual([7, 1.5, 0]);
  });

  it("a camera with no frame publishes its Eye and Look At unchanged", () => {
    const document = shot({ eye: [1, 2, 3], lookAt: [0.5, 0.25, -1], fov: 33 });
    expect(vector(document, "eye")).toEqual([1, 2, 3]);
    expect(vector(document, "aim")).toEqual([0.5, 0.25, -1]);
    expect(read(document, "fov").value).toBe(33);
  });

  it("forward, right and up are the picture's own basis, Roll included: unit, perpendicular, and turned by Roll", () => {
    const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    const document = shot(RIG);
    const [forward, right, up] = [vector(document, "forward"), vector(document, "right"), vector(document, "up")];
    for (const axis of [forward, right, up]) expect(dot(axis, axis)).toBeCloseTo(1, 12);
    expect(dot(forward, right)).toBeCloseTo(0, 12);
    expect(dot(forward, up)).toBeCloseTo(0, 12);
    expect(dot(right, up)).toBeCloseTo(0, 12);
    // forward is eye to aim, over the distance.
    const [eye, aim] = [vector(document, "eye"), vector(document, "aim")];
    const distance = read(document, "distance").value as number;
    AXES.forEach((_, index) => expect(forward[index]).toBeCloseTo((aim[index]! - eye[index]!) / distance, 12));
    // Roll 12°: the picture's up leans off the world's by exactly that, for this view's pitch.
    const level = shot({ ...RIG, roll: 0 });
    expect(vector(level, "up")).not.toEqual(up);
    expect(dot(vector(level, "up"), up)).toBeCloseTo(Math.cos((12 * Math.PI) / 180), 12);
  });

  it("⚑ DISTANCE is the world's, and it is the stored offsets' too: a frame is rigid, so the fly pace and the orbit's reach read true", () => {
    const document = shot(RIG);
    // Eye (0, 0.5, 3) to Look At (0.25, 0, 0), as stored.
    const stored = Math.hypot(0.25, 0.5, 3);
    for (const seconds of [0, 0.5, 1.25]) expect(read(document, "distance", seconds).value).toBeCloseTo(stored, 12);
  });
});

describe("T1674b — where the read works, and what it does not make of the camera", () => {
  it("⚑ it needs no channel resolver: a structural compile and a panel read the pose, not a retained number", () => {
    // `read` hands the reader NO resolver. A value hook's bag would answer "no channel resolver" here.
    const result = read(shot({ eye: [0, 0.5, 3], origin: [2, 0, 0] }), "eyeX");
    expect(result).toEqual({ value: 2, said: null, code: null });
  });

  it("a rig driven by a value node is read through that node: with no resolver the read says so, and is not a healthy number", () => {
    const document = graph(
      [
        named("sway", "lfo", [0, 0]),
        named("rig", "camera", [0, 400], { "origin.x": expressionSlot("op('lfo_sway').chan.value", 5) } as never),
        named("eyeX", "constant", [400, 0], { value: expressionSlot("op('camera_rig').chan.eyeX", -99) } as never),
      ],
      [],
    );
    const without = read(document, "eyeX");
    expect(without.value).toBe(-99);
    expect(without.code).toBe("parameter.channels.unavailable");
    // With the value graph running, the Constant publishes the camera's eye: the LFO's value, this frame.
    const session = createValueGraphSession(registry);
    const frame = frameAt(0.2);
    const result = session.evaluate(document as unknown as FlatGraph, frame, { flattening: NO_FLATTENING });
    expect(result.diagnostics).toEqual([]);
    const lfo = result.byName.get("lfo_sway")?.["value"];
    expect(typeof lfo).toBe("number");
    expect(lfo).not.toBe(0);
    expect(result.byName.get("constant_eyeX")?.["value"]).toBe(lfo);
  });

  it("a channel the camera does not have is refused by name, with the list", () => {
    const result = read(shot({}, { wrong: "op('camera_rig').chan.eyex" }), "wrong");
    expect(result.value).toBe(-99);
    expect(result.code).toBe("parameter.reference.unreadable");
    expect(result.said).toContain(`"camera_rig" publishes no channel "eyex"`);
  });

  it("a loop through the pose is a cycle, named, as it is through a parameter", () => {
    const document = graph(
      [
        named("rig", "camera", [0, 0], { "origin.x": expressionSlot("op('constant_back').par.value", 0) } as never),
        named("back", "constant", [400, 0], { value: expressionSlot("op('camera_rig').chan.eyeX", -99) } as never),
      ],
      [],
    );
    const result = read(document, "back");
    expect(result.value).toBe(-99);
    expect(result.said).toContain("cycle");
    const compiled = compileGraph({ graph: document, settings: SETTINGS, registry, capabilities: TIER_B_CAPABILITIES } as never);
    expect(compiled.diagnostics.map((entry) => entry.code)).toContain("parameter.referenceCycle");
  });

  it("two cameras each framed on the other's pose are a cycle too: the loop has no parameter read in it, and is still named", () => {
    // The loop above is caught at its `.par` hop. This one is channel reads all the way round.
    const document = graph(
      [
        named("rig", "camera", [0, 0], { "origin.x": expressionSlot("op('camera_other').chan.eyeX", 0) } as never),
        named("other", "camera", [400, 0], { "origin.x": expressionSlot("op('camera_rig').chan.eyeX", 0) } as never),
        named("eyeX", "constant", [800, 0], { value: expressionSlot("op('camera_rig').chan.eyeX", -99) } as never),
      ],
      [],
    );
    const result = read(document, "eyeX");
    expect(result.value).toBe(-99);
    expect(result.said).toContain("cycle");
  });

  it("the menu offers every channel with what it is, and nothing the reader refuses", () => {
    const document = shot({});
    const members = nodeReferenceMembers(
      {
        graph: document,
        schemaOf: (node) => effectiveParameterSchema(registry.get(node.type), node.parameters),
        declaredChannelsOf: (node) => registry.get(node.type)?.parameterChannels,
      },
      "camera_rig",
      ["chan"],
    );
    expect(members.map((member) => member.text)).toEqual(Object.keys(registry.get("camera")!.parameterChannels!.names));
    expect(members.find((member) => member.text === "eyeX")?.detail).toBe("Where the camera is, in the world: x");
    // Every offered name reads: a menu may not offer what the reader rejects (§V150).
    for (const member of members) {
      const one = shot({}, { one: `op('camera_rig').chan.${member.text}` });
      expect(read(one, "one").said).toBeNull();
    }
  });

  it("⚑ the camera is still a camera: not a value node, so its tile is its picture and an unused one is still reported", () => {
    const camera = registry.get("camera");
    expect(camera?.parameterChannels).toBeDefined();
    // The two predicates a value hook would have flipped: the tile becoming a plot, and never being dead.
    expect(publishesValueChannels(camera)).toBe(false);
    expect(isValueSourceDefinition(camera)).toBe(false);
    const session = createValueGraphSession(registry);
    const result = session.evaluate(shot(RIG) as unknown as FlatGraph, frameAt(0), { flattening: NO_FLATTENING });
    expect(result.byName.has("camera_rig")).toBe(false);
  });

  it("no definition declares both: channels of the parameters, or a value hook, never the two", () => {
    for (const definition of allNodeDefinitions) {
      if (definition.parameterChannels === undefined) continue;
      expect([definition.type, definition.valueEvaluate, definition.valueChannel, definition.measuredChannel]).toEqual([definition.type, undefined, undefined, undefined]);
      // Every parameter it says it reads is one it has.
      for (const key of definition.parameterChannels.reads) expect(Object.keys(effectiveParameterSchema(definition, {}))).toContain(key);
    }
  });
});

describe("T1674b — the finding: an expression that reads the offset of a camera with a frame", () => {
  const found = (document: GraphDocument): Array<{ nodeId: string | undefined; message: string; suggestion: string | undefined; severity: string }> =>
    compileGraph({ graph: document, settings: SETTINGS, registry, capabilities: TIER_B_CAPABILITIES } as never)
      .diagnostics.filter((entry) => entry.code === "parameter.reference.notComposed")
      .map((entry) => ({ nodeId: entry.nodeId, message: entry.message, suggestion: entry.suggestion, severity: entry.severity }));

  it("⚑ fires on the consumer's shape, on the reader, naming the channel to read instead", () => {
    const document = shot(RIG, { lens: "op('camera_rig').par.eye.x + op('camera_rig').par.lookAt.z" });
    expect(found(document)).toEqual([
      {
        nodeId: "constant_lens",
        severity: "warning",
        message: `"constant_lens".value reads op('camera_rig').par.eye.x, which is the offset in the frame its Origin and Heading make, not where the camera is in the world.`,
        suggestion: "Read op('camera_rig').chan.eyeX for where the camera is in the world.",
      },
      {
        nodeId: "constant_lens",
        severity: "warning",
        message: `"constant_lens".value reads op('camera_rig').par.lookAt.z, which is the offset in the frame its Origin and Heading make, not the point it looks at in the world.`,
        suggestion: "Read op('camera_rig').chan.aimZ for the point it looks at in the world.",
      },
    ]);
  });

  it("⚑ does NOT fire on a camera with no frame: every camera written before the frame existed", () => {
    const reader = { lens: "op('camera_rig').par.eye.x + op('camera_rig').par.lookAt.z" };
    expect(found(shot({ eye: [1, 2, 3], lookAt: [0, 0, 0] }, reader))).toEqual([]);
    // Origin and Heading written out at their defaults are still no frame.
    expect(found(shot({ eye: [1, 2, 3], origin: [0, 0, 0], heading: [0, 0, 0] }, reader))).toEqual([]);
  });

  it("a frame is a stored Origin or Heading that is not zero, or one that is driven at all", () => {
    const reader = { lens: "op('camera_rig').par.eye.x" };
    expect(found(shot({ origin: [0, 2, 0] }, reader))).toHaveLength(1);
    expect(found(shot({ heading: [1, 0, 0] }, reader))).toHaveLength(1);
    expect(found(shot({ "heading.z": expressionSlot("sin(time)", 0) }, reader))).toHaveLength(1);
  });

  it("is silent for the reads that are what they say: the channel, a parameter the frame does not touch, the camera's own offset", () => {
    expect(found(shot(RIG, { a: "op('camera_rig').chan.eyeX", b: "op('camera_rig').par.fov", c: "op('camera_rig').par.origin.x" }))).toEqual([]);
    // The camera's Look At reading its own Eye is an offset read by the node that owns the frame.
    expect(found(shot({ ...RIG, "lookAt.y": expressionSlot("op('camera_rig').par.eye.y", 0) }))).toEqual([]);
  });

  it("says a read once, however often one expression repeats it, and finds it inside a call", () => {
    const document = shot(RIG, { lens: "max(op('camera_rig').par.eye.x, 0) + op('camera_rig').par.eye.x" });
    expect(found(document)).toHaveLength(1);
  });
});

/**
 * §T1671b — THE CENTRE OF THE SLICE: a camera that opts into an Aimed frame changes nothing
 * on the side of whoever reads its pose. The channels come from the function the payload is
 * built by, and that function reads the Frame.
 */
describe("T1671b — the channels follow an Aimed frame, with no change on the reader's side", () => {
  // A directed shot: where the camera is on Origin, where it looks on Heading (a 3-4-5
  // climb), and Eye 0, Look At 0, 0, −5 plain. Five along (0, 0.6, −0.8) is (0, 3, −4).
  const DIRECTED = { frame: "aimed", eye: [0, 0, 0], lookAt: [0, 0, -5], origin: [2, 1, -1], heading: [0, 3, -4], fov: 40 };

  it("⚑ eye is Origin and aim is d along Heading, climb included; rebuilt from them, the matrix is the Render's own", () => {
    const document = shot(DIRECTED);
    expect(vector(document, "eye")).toEqual([2, 1, -1]);
    expect(vector(document, "aim")).toEqual([2, 4, -5]);
    expect(read(document, "distance").value).toBe(5);
    const forward = vector(document, "forward");
    [0, 0.6, -0.8].forEach((value, index) => expect(forward[index]).toBeCloseTo(value, 12));
    const fromChannels = cameraPayloadMatrix(
      { eye: vector(document, "eye"), lookAt: vector(document, "aim"), fovDeg: read(document, "fov").value as number, near: 0.1, far: 100, ortho: false, orthoHeight: 2, roll: 0 },
      ASPECT,
    );
    expect(Array.from(fromChannels)).toEqual(drawnThrough(document));
    // The premise: read Level, the same numbers are another pose (the aim does not climb).
    const level = shot({ ...DIRECTED, frame: "level" });
    expect(vector(level, "aim")).toEqual([2, 1, -6]);
    expect(drawnThrough(level)).not.toEqual(drawnThrough(document));
  });

  it("a table of directed shots, moving: at three moments the channels are the pose the Render draws through", () => {
    const document = shot({
      frame: "aimed",
      eye: [0, 0, 0],
      lookAt: [0, 0, -2],
      "origin.x": expressionSlot("4 * cos(time)", 4),
      "origin.y": expressionSlot("1 + 0.5 * sin(time * 2)", 1),
      "origin.z": expressionSlot("4 * sin(time)", 0),
      "heading.x": expressionSlot("0 - 4 * cos(time)", -4),
      "heading.y": expressionSlot("0.25 - (1 + 0.5 * sin(time * 2))", -0.75),
      "heading.z": expressionSlot("0 - 4 * sin(time)", 0),
    });
    const seen: number[][] = [];
    for (const seconds of [0, 0.5, 1.25]) {
      const eye = vector(document, "eye", seconds);
      const aim = vector(document, "aim", seconds);
      // Where the camera is IS the directed eye, and the aim is two along the directed view.
      const directed = [4 * Math.cos(seconds), 1 + 0.5 * Math.sin(seconds * 2), 4 * Math.sin(seconds)];
      directed.forEach((value, index) => expect(eye[index]).toBeCloseTo(value, 12));
      expect(read(document, "distance", seconds).value).toBeCloseTo(2, 12);
      // The directed aim is (0, 0.25, 0): the view passes through it.
      const toward = [0 - eye[0], 0.25 - eye[1], 0 - eye[2]];
      const span = Math.hypot(toward[0]!, toward[1]!, toward[2]!);
      const forward = vector(document, "forward", seconds);
      toward.forEach((value, index) => expect(forward[index]).toBeCloseTo(value / span, 12));
      const fromChannels = cameraPayloadMatrix({ eye, lookAt: aim, fovDeg: 55, near: 0.1, far: 100, ortho: false, orthoHeight: 2, roll: 0 }, ASPECT);
      expect(Array.from(fromChannels)).toEqual(drawnThrough(document, seconds));
      seen.push(Array.from(fromChannels));
    }
    expect(seen[0]).not.toEqual(seen[1]);
  });

  it("the finding is the same finding: a read of par.lookAt on an Aimed rig is the offset, and is said", () => {
    const compiled = compileGraph({ graph: shot(DIRECTED, { lens: "op('camera_rig').par.lookAt.z" }), settings: SETTINGS, registry, capabilities: TIER_B_CAPABILITIES } as never);
    const said = compiled.diagnostics.filter((entry) => entry.code === "parameter.reference.notComposed");
    expect(said.map((entry) => entry.suggestion)).toEqual(["Read op('camera_rig').chan.aimZ for the point it looks at in the world."]);
  });
});

/**
 * §B293 — THE CONSUMER'S SHAPE: a directed shot whose Look At z is the length of its own
 * Heading, so the aim is the Heading's own length straight ahead. One node, two parameters,
 * no ring; it was refused as `parameter.referenceCycle` by the checked save and the consumer
 * wrote the distance out in full. Held through the real resolve, at the compile, and at the
 * checked save; and the ring that IS one (Look At from the camera's own `chan.distance`,
 * which is composed from Look At) is still refused, by name.
 */
describe("B293 — a camera's Look At from the length of its own Heading", () => {
  const LENGTH = "0 - (op('camera_rig').par.heading.x ^ 2 + op('camera_rig').par.heading.y ^ 2 + op('camera_rig').par.heading.z ^ 2) ^ 0.5";
  // One to the frame's side, so the view DEPENDS on how far off the aim is.
  const directed = (lookAtZ: unknown) => ({ frame: "aimed", eye: [1, 0, 0], lookAt: [0, 0, -1], "lookAt.z": lookAtZ, origin: [2, 1, -1], heading: [0, 3, -4], fov: 40 });
  const cycles = (document: GraphDocument) =>
    compileGraph({ graph: document, settings: SETTINGS, registry, capabilities: TIER_B_CAPABILITIES } as never).diagnostics.filter((entry) => entry.code === "parameter.referenceCycle" && entry.message.startsWith("Parameter reference chain is circular"));
  const refusedAtSave = (document: GraphDocument): string[] =>
    codeBuiltFindings(project("b293", "B293", SETTINGS, document))
      .filter(refusedAtCodeSave)
      .map((finding) => `${finding.diagnostic.code}: ${finding.diagnostic.message}`);

  it("⚑ resolves, from the camera and from every node that reads its pose, and draws what the number written out draws", () => {
    const byExpression = shot(directed(expressionSlot(LENGTH, -1)));
    const written = shot(directed(-5));
    // Through the real resolve, read from OTHER nodes (the Constants): this is the read that failed.
    expect(read(byExpression, "aimZ")).toEqual({ value: -5, said: null, code: null });
    expect(read(byExpression, "distance").value).toBeCloseTo(Math.sqrt(26), 12);
    expect(read(byExpression, "distance").said).toBeNull();
    expect(vector(byExpression, "aim")).toEqual([2, 4, -5]);
    // The Render's own matrix, against the number written out: exact.
    expect(drawnThrough(byExpression)).toEqual(drawnThrough(written));
    // And it MOVES with Heading: a retained −1 would have been the other picture.
    expect(drawnThrough(byExpression)).not.toEqual(drawnThrough(shot(directed(-1))));
    expect(cycles(byExpression)).toEqual([]);
  });

  it("⚑ is accepted at the checked save, and by the patch that writes it", () => {
    expect(refusedAtSave(shot(directed(expressionSlot(LENGTH, -1))))).toEqual([]);
  });

  it("⚑ STILL A RING: Look At from the camera's own chan.distance, which is composed FROM Look At, says so by name everywhere", () => {
    const ringed = shot(directed(expressionSlot("0 - op('camera_rig').chan.distance", -1)));
    // The compile and the checked save: the ring, with the channel it goes through.
    expect(cycles(ringed).map((entry) => entry.message)).toEqual([
      "Parameter reference chain is circular: camera_rig.lookAt.z → camera_rig.chan.distance → camera_rig.lookAt.z.",
    ]);
    expect(refusedAtSave(ringed).filter((line) => line.startsWith("parameter.referenceCycle: Parameter reference chain is circular"))).toHaveLength(1);
    // The real resolve: a reader of the pose gets the ring's failure, never a number, and it names what composes what.
    const aim = read(ringed, "aimZ");
    expect(aim.value).toBe(-99);
    expect(aim.said).toContain("that reference is a cycle");
    expect(aim.said).toContain(`"camera_rig" composes distance from its lookAt`);
    // A parameter the pose is NOT composed from may read it: Near from the distance is no ring.
    const fine = shot({ ...directed(-5), near: expressionSlot("op('camera_rig').chan.distance / 50", 0.1) });
    expect(cycles(fine)).toEqual([]);
    expect(refusedAtSave(fine)).toEqual([]);
  });
});
