import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { cameraPayloadMatrix } from "../../domain/geometry/camera.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import type { ParameterSlot } from "../../domain/types/parameters.ts";
import { edge, graph, named, settings } from "../../examples/documents/builders.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";

/**
 * §T1656b — A CAMERA WITH A PARENT FRAME: ORIGIN AND HEADING.
 *
 * The owner's camera follows a robot by six expressions on Eye and Look At, so a view flown
 * by hand could only be kept by replacing the rig with numbers (§T970). With Origin and
 * Heading the rig lives THERE, and Eye and Look At are the offset a flight writes.
 *
 * What is held here is what a consumer of the camera reads: the view matrix the Render
 * draws through, and the one the camera's own tile draws through. Each case is the "cut
 * the edge" form: a camera with a frame draws EXACTLY what a plain camera placed at the
 * composed world pose draws, so the frame is nothing but that composition.
 *
 * The shipped documents are held separately, by pins taken before these two parameters
 * existed (49 documents, 53 cameras, frames 0, 37 and 240: identical after).
 */

const registry = createNodeRegistry(allNodeDefinitions).view();
const SETTINGS = settings({ outputResolution: { width: 640, height: 360 } });
const ASPECT = 640 / 360;

type Vec3 = readonly [number, number, number];

const expression = (source: string, retained: number): ParameterSlot => ({
  mode: "expression",
  bindings: { static: { kind: "static", value: retained }, expression: { kind: "expression", source } },
});

function shot(camera: Record<string, unknown>, slots: Record<string, ParameterSlot> = {}): GraphDocument {
  return graph(
    [
      named("source", "pointGrid", [0, 0], { cols: 4, rows: 4 }),
      named("boxes", "geometry", [400, 0], { mode: "instances" }),
      named("key", "light", [800, 0]),
      named("rig", "camera", [0, 400], camera as never, { parameters: slots }),
      named("shot", "render", [400, 400]),
      // A second camera nothing renders through: its tile is the stock scene through its own matrix.
      named("free", "camera", [0, 800], camera as never, { parameters: slots }),
    ],
    [
      edge("e1", ["grid_source", "out"], ["geometry_boxes", "points"]),
      edge("e2", ["geometry_boxes", "out"], ["render_shot", "scenes"]),
      edge("e3", ["camera_rig", "out"], ["render_shot", "camera"]),
      edge("e4", ["light_key", "out"], ["render_shot", "lights"]),
    ],
  );
}

const frameAt = (seconds: number): FrameEvaluationInput => ({
  timeSeconds: seconds,
  deltaSeconds: 1 / 60,
  frameIndex: Math.round(seconds * 60),
  mode: "offline",
  randomSeed: 7,
});

/** The matrix the Render draws through, and the one the free camera's tile draws through. */
function matrices(document: GraphDocument, seconds?: number): { render: number[]; tile: number[] } {
  const compiled = compileGraph({
    graph: document,
    settings: SETTINGS,
    registry,
    capabilities: TIER_B_CAPABILITIES,
    sinks: [
      { nodeId: "render_shot", portId: "out", kind: "preview" as const },
      { nodeId: "camera_free", portId: "out", kind: "preview" as const },
    ],
    ...(seconds === undefined ? {} : { resolution: { frame: frameAt(seconds) } }),
  } as never);
  expect(compiled.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  const render = compiled.passes
    .filter((pass) => (pass as { nodeId?: string }).nodeId === "render_shot")
    .map((pass) => (pass as { uniforms?: Record<string, unknown> }).uniforms?.["viewProjection"])
    .find((value) => value !== undefined);
  const tile = compiled.outputs
    .find((output) => output.nodeId === "camera_free")
    ?.synthesis?.passes.map((pass) => pass.uniforms?.["viewProjection"])
    .find((value) => value !== undefined);
  if (render === undefined || tile === undefined) throw new Error("the fixture drew no view matrix");
  return { render: Array.from(render as ArrayLike<number>), tile: Array.from(tile as ArrayLike<number>) };
}

/** Exact, with `===` so a negative zero in a composed coordinate is the zero it is. */
const same = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

const plain = (eye: Vec3, lookAt: Vec3) => matrices(shot({ eye: [...eye], lookAt: [...lookAt] }));

describe("T1656b — a camera's Eye and Look At are offsets in the frame Origin and Heading make", () => {
  it("⚑ a camera with neither draws exactly what it drew: the payload's own matrix, float for float", () => {
    const untouched = plain([4, 2, 7], [0, 1, 0]);
    const expected = Array.from(
      cameraPayloadMatrix({ eye: [4, 2, 7], lookAt: [0, 1, 0], fovDeg: 55, near: 0.1, far: 100, ortho: false, orthoHeight: 2, roll: 0 }, ASPECT),
    );
    expect(untouched.render).toEqual(expected);
    // Stated zeros are the same camera as absent ones.
    expect(matrices(shot({ eye: [4, 2, 7], lookAt: [0, 1, 0], origin: [0, 0, 0], heading: [0, 0, 0] })).render).toEqual(expected);
  });

  it("Origin moves the whole pose: the Render and the tile draw what a plain camera at Origin + offset draws", () => {
    const framed = matrices(shot({ eye: [0, 0.5, 3], lookAt: [0, 0, 0], origin: [10, 2, -4] }));
    const world = plain([10, 2.5, -1], [10, 2, -4]);
    expect(same(framed.render, world.render)).toBe(true);
    expect(same(framed.tile, world.tile)).toBe(true);
    // The premise: Origin is not a no-op.
    expect(same(framed.render, plain([0, 0.5, 3], [0, 0, 0]).render)).toBe(false);
  });

  it("Heading turns the offsets about the vertical: three behind a subject facing +x is at −x", () => {
    // The frame's forward is its −z. A subject at the origin facing +x: the default offset
    // (0, 0.5, 3) is three BEHIND it and half above, so the eye is at (−3, 0.5, 0); an
    // offset of +1 in x is to its right, which for something facing +x is +z.
    const framed = matrices(shot({ eye: [1, 0.5, 3], lookAt: [0, 0, 0], heading: [1, 0, 0] }));
    const world = plain([-3, 0.5, 1], [0, 0, 0]);
    expect(same(framed.render, world.render)).toBe(true);
    expect(same(framed.tile, world.tile)).toBe(true);
    // A heading down −z is the way the frame already faces: no turn at all.
    expect(same(matrices(shot({ eye: [1, 0.5, 3], lookAt: [0, 0, 0], heading: [0, 0, -5] })).render, plain([1, 0.5, 3], [0, 0, 0]).render)).toBe(true);
  });

  it("only the horizontal part of Heading is read: the camera rises with its subject and never tilts with it", () => {
    const level = matrices(shot({ eye: [0, 0.5, 3], lookAt: [0, 0, 0], heading: [2, 0, 0] }));
    const climbing = matrices(shot({ eye: [0, 0.5, 3], lookAt: [0, 0, 0], heading: [2, 9, 0] }));
    expect(same(climbing.render, level.render)).toBe(true);
    // Straight up has no horizontal part, so it is no heading: nothing turns.
    expect(same(matrices(shot({ eye: [0, 0.5, 3], lookAt: [0, 0, 0], heading: [0, 4, 0] })).render, plain([0, 0.5, 3], [0, 0, 0]).render)).toBe(true);
  });

  it("⚑ THE OWNER'S SHAPE: the rig on Origin and Heading, a constant offset, and the camera follows", () => {
    // Origin and Heading on expressions (a subject circling), Eye and Look At plain numbers:
    // exactly what a flight writes. At each moment the Render draws what a plain camera
    // placed by hand at Origin(t) + frame(t) · offset would.
    const rig = {
      "origin.x": expression("4 * cos(time)", 4),
      "origin.z": expression("4 * sin(time)", 0),
      "heading.x": expression("0 - sin(time)", 0),
      "heading.z": expression("cos(time)", 1),
    };
    const document = shot({ eye: [0, 1, 2], lookAt: [0, 0, 0] }, rig);
    const seen: number[][] = [];
    for (const seconds of [0, 0.5, 1.25]) {
      const origin: Vec3 = [4 * Math.cos(seconds), 0, 4 * Math.sin(seconds)];
      const heading: Vec3 = [0 - Math.sin(seconds), 0, Math.cos(seconds)];
      const span = Math.hypot(heading[0], heading[2]);
      const back: Vec3 = [-heading[0] / span, 0, -heading[2] / span];
      // Eye (0, 1, 2): one above, two behind (the frame's +z is `back`).
      const eye: Vec3 = [origin[0] + back[0] * 2, origin[1] + 1, origin[2] + back[2] * 2];
      const framed = matrices(document, seconds);
      expect(same(framed.render, matrices(shot({ eye: [...eye], lookAt: [...origin] }), seconds).render)).toBe(true);
      seen.push(framed.render);
    }
    // And it MOVES: three moments, three pictures, with Eye and Look At never written.
    expect(same(seen[0]!, seen[1]!)).toBe(false);
    expect(same(seen[1]!, seen[2]!)).toBe(false);
  });
});

/**
 * §T1671b — FRAME: AIMED. Heading read whole, so a directed shot is Origin (where the
 * camera is), Heading (where it looks) and plain offsets. The same "cut the edge" form as
 * above: what the Render draws through an aimed camera is exactly what it draws through a
 * plain camera placed at the composed pose.
 */
describe("T1671b — an aimed frame's forward is Heading, climbing and diving included", () => {
  it("Level stays the default: a climbing Heading with no Frame stated draws what it drew", () => {
    const level = matrices(shot({ eye: [0, 0.5, 3], lookAt: [0, 0, 0], heading: [0, 3, -4] }));
    // Only the horizontal part: (0, 3, −4) read level is the frame's own −z, no turn at all.
    expect(same(level.render, plain([0, 0.5, 3], [0, 0, 0]).render)).toBe(true);
    expect(same(matrices(shot({ eye: [0, 0.5, 3], lookAt: [0, 0, 0], heading: [0, 3, -4], frame: "level" })).render, level.render)).toBe(true);
  });

  it("⚑ a directed shot: Eye 0, Look At 0, 0, −d draws what a plain camera at Origin looking d along Heading draws", () => {
    // The 3-4-5 heading, climbing. Five along it from (2, 1, −1) is (2, 4, −5).
    const aimed = matrices(shot({ eye: [0, 0, 0], lookAt: [0, 0, -5], origin: [2, 1, -1], heading: [0, 3, -4], frame: "aimed" }));
    const byHand = plain([2, 1, -1], [2, 4, -5]);
    expect(same(aimed.render, byHand.render)).toBe(true);
    expect(same(aimed.tile, byHand.tile)).toBe(true);
    // The premise: read level, the same numbers are another picture.
    expect(same(aimed.render, matrices(shot({ eye: [0, 0, 0], lookAt: [0, 0, -5], origin: [2, 1, -1], heading: [0, 3, -4] })).render)).toBe(false);
  });

  it("an offset to the side and above follows the frame's own right and up", () => {
    // right (1, 0, 0), up (0, 0.8, 0.6), back (0, −0.6, 0.8): Eye (1, 2, 5) is
    // (1, 1.6 − 3, 1.2 + 4) = (1, −1.4, 5.2) from the Origin.
    const aimed = matrices(shot({ eye: [1, 2, 5], lookAt: [0, 0, 0], origin: [2, 1, -1], heading: [0, 3, -4], frame: "aimed" }));
    const frame = { right: [1, 0, 0], up: [0, 0.8, 0.6], back: [0, -0.6, 0.8] } as const;
    const eye: Vec3 = [2 + 1, 1 + frame.up[1] * 2 + frame.back[1] * 5, -1 + frame.up[2] * 2 + frame.back[2] * 5];
    const byHand = plain(eye, [2, 1, -1]);
    for (let index = 0; index < 16; index += 1) expect(aimed.render[index]).toBeCloseTo(byHand.render[index]!, 10);
  });

  it("straight down has a picture and it is the plain camera's: the pole is a rule, not a NaN", () => {
    const aimed = matrices(shot({ eye: [0, 0, 0], lookAt: [0, 0, -3], origin: [0.5, 4, 0.25], heading: [0, -1, 0], frame: "aimed" }));
    for (const value of aimed.render) expect(Number.isFinite(value)).toBe(true);
    const byHand = plain([0.5, 4, 0.25], [0.5, 1, 0.25]);
    expect(same(aimed.render, byHand.render)).toBe(true);
  });

  it("⚑ THE CONSUMER'S SHAPE: a table of directed shots on Origin and Heading, Eye and Look At plain, at three moments", () => {
    // The directed eye and aim are expressions; Heading is aim minus eye, as the peer moves the rig.
    const rig = {
      "origin.x": expression("4 * cos(time)", 4),
      "origin.y": expression("1 + 0.5 * sin(time * 2)", 1),
      "origin.z": expression("4 * sin(time)", 0),
      "heading.x": expression("0 - 4 * cos(time)", -4),
      "heading.y": expression("0.25 - (1 + 0.5 * sin(time * 2))", -0.75),
      "heading.z": expression("0 - 4 * sin(time)", 0),
    };
    const document = shot({ eye: [0, 0, 0], lookAt: [0, 0, -2], frame: "aimed" }, rig);
    const seen: number[][] = [];
    for (const seconds of [0, 0.5, 1.25]) {
      const eye: Vec3 = [4 * Math.cos(seconds), 1 + 0.5 * Math.sin(seconds * 2), 4 * Math.sin(seconds)];
      const heading: Vec3 = [0 - 4 * Math.cos(seconds), 0.25 - (1 + 0.5 * Math.sin(seconds * 2)), 0 - 4 * Math.sin(seconds)];
      const span = Math.hypot(heading[0], heading[1], heading[2]);
      // Two along the directed view from the directed eye.
      const aim: Vec3 = [eye[0] + (heading[0] / span) * 2, eye[1] + (heading[1] / span) * 2, eye[2] + (heading[2] / span) * 2];
      const framed = matrices(document, seconds);
      const byHand = matrices(shot({ eye: [...eye], lookAt: [...aim] }), seconds);
      for (let index = 0; index < 16; index += 1) expect(framed.render[index]).toBeCloseTo(byHand.render[index]!, 10);
      seen.push(framed.render);
    }
    expect(same(seen[0]!, seen[1]!)).toBe(false);
    expect(same(seen[1]!, seen[2]!)).toBe(false);
  });
});
