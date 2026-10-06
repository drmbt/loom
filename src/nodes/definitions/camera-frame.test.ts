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
