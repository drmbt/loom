import { describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import { cameraPayloadMatrix, transformPoint } from "../../../domain/geometry/camera.ts";
import { cubePrimitive, encodeFixtureGlb, type FixturePrimitive } from "../../../domain/mesh/glb.fixture.ts";
import { prepareMesh } from "../../../points/mesh.ts";
import { renderHeadless } from "../../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1401b on a REAL device, exact to the byte (§V147): a SKINNED GLB goes through the
 * loader's path (`prepareMesh`), Mesh File In publishes `joints`/`weights` beside the six
 * unskinned attributes, and a Point Kernel that turns ONE joint about its rest head (read
 * from the decoded joint table) moves exactly the vertices weighted to that joint.
 *
 * The scene: two unit cubes in one skinned primitive pair. The "anchor" cube at x = −2 is
 * weighted wholly to joint 0 (root, at the origin); the "arm" cube at x = 2 wholly to joint
 * 1 (head (0.5, 0, 0)). Turning joint 1 by +90° about Z carries the arm cube's centre from
 * (2, 0, 0) round (0.5, 0, 0) to (0.5, 1.5, 0). Every probed texel is a cube's front face
 * (normal +Z, which a turn about Z keeps), lit head-on, so lit = 0.8 × (0.12 + 1) and empty
 * is black — both derived, never read back.
 */

const SIZE = 64;
const SETTINGS: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

type Vec3 = readonly [number, number, number];
const EYE: Vec3 = [0, 0, 6];

const node = (id: string, type: string, parameters: Record<string, unknown>, label?: string) => ({
  id,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
  ...(label === undefined ? {} : { label }),
});

/** A unit cube centred at (dx, 0, 0), every vertex weighted wholly to skin-local joint `joint`. */
function boundCube(dx: number, joint: number): FixturePrimitive {
  const cube = cubePrimitive(0);
  const count = cube.positions.length / 3;
  return {
    ...cube,
    positions: cube.positions.map((value, index) => (index % 3 === 0 ? value + dx : value)),
    joints: Array.from({ length: count }, () => [joint, 0, 0, 0]).flat(),
    weights: Array.from({ length: count }, () => [1, 0, 0, 0]).flat(),
  };
}

const GLB = encodeFixtureGlb({
  materials: [{ name: "grey", baseColor: [1, 1, 1, 1] }],
  skins: [{ joints: ["root", "arm"], inverseBindMatrices: [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0.5, 0, 0, 1]] }],
  nodes: [
    { name: "root", children: [{ name: "arm", translation: [0.5, 0, 0] }] },
    { name: "body", skin: 0, mesh: [boundCube(-2, 0), boundCube(2, 1)] },
  ],
});

/**
 * Linear-blend skinning over four influences with one joint turned: the kernel a stock
 * skin node would generate (T1402b), written out. `head` comes from the decoded table.
 */
function turnKernel(joint: number, head: Vec3, radians: number): string {
  return `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let head = vec3f(${head.map((x) => x.toFixed(6)).join(", ")});
  let c = ${Math.cos(radians).toFixed(9)};
  let s = ${Math.sin(radians).toFixed(9)};
  let turn = mat3x3f(vec3f(c, s, 0.0), vec3f(-s, c, 0.0), vec3f(0.0, 0.0, 1.0));
  var position = vec3f(0.0);
  var normal = vec3f(0.0);
  var total = 0.0;
  for (var k = 0u; k < 4u; k = k + 1u) {
    let w = p.weights[k];
    if (w <= 0.0) { continue; }
    total = total + w;
    if (u32(p.joints[k] + 0.5) == ${joint}u) {
      position = position + w * (turn * (p.position - head) + head);
      normal = normal + w * (turn * p.normal);
    } else {
      position = position + w * p.position;
      normal = normal + w * p.normal;
    }
  }
  if (total > 0.0) {
    q.position = position;
    q.normal = normalize(normal);
  }
  return q;
}`;
}

function graph(kernel: string, glb: Uint8Array = GLB): GraphDocument {
  const prepared = prepareMesh(glb, "");
  if (prepared === null) throw new Error("fixture mesh is empty");
  const { facts } = prepared;
  const nodes = [
    node("mesh", "meshFileIn", { vertices: facts.vertices, triangles: facts.triangles, parts: facts.parts, joints: facts.joints }, "mesh1"),
    node("pose", "pointKernel", {
      capacity: facts.vertices,
      attributes: JSON.stringify([
        { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
        { name: "normal", type: "vec3f", qualifier: "direction", default: [0, 1, 0] },
        { name: "joints", type: "vec4f", default: [0, 0, 0, 0] },
        { name: "weights", type: "vec4f", default: [0, 0, 0, 0] },
      ]),
      kernel,
    }),
    node("geo", "geometry", { mode: "surface" }, "geo1"),
    node("cam", "camera", { eye: [...EYE], lookAt: [0, 0, 0] }, "cam1"),
    node("sun", "light", { kind: "directional", direction: [0, 0, -1], intensity: 1 }, "sun1"),
    node("shot", "render", { scenes: "geo1", camera: "cam1", lights: "sun1", ambientColor: [1, 1, 1, 1], ambientIntensity: 0.12 }, "shot1"),
    node("out", "output", {}, "out1"),
  ];
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: {
      e1: { id: "e1", source: { nodeId: "mesh", portId: "out" }, target: { nodeId: "pose", portId: "in" } },
      e2: { id: "e2", source: { nodeId: "pose", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
      e3: { id: "e3", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

async function render(kernel: string, glb: Uint8Array = GLB): Promise<Uint8Array> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(kernel, glb),
    settings: SETTINGS,
    frames: 2,
    outputNodeId: "shot",
    outputPortId: "out",
    meshes: { mesh: glb },
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const frame = result.frames[result.frames.length - 1];
  if (frame === undefined) throw new Error("no frame captured");
  return frame.bytes;
}

function texelOf(world: Vec3): number {
  const matrix = cameraPayloadMatrix({ eye: EYE, lookAt: [0, 0, 0], fovDeg: 60, near: 0.1, far: 100, ortho: false, orthoHeight: 2 }, 1);
  const clip = transformPoint(matrix, world);
  const x = Math.floor(((clip[0] / clip[3]) * 0.5 + 0.5) * SIZE);
  const y = Math.floor((0.5 - (clip[1] / clip[3]) * 0.5) * SIZE);
  return (y * SIZE + x) * 4;
}

const rgb = (bytes: Uint8Array, at: number): number[] => [bytes[at] ?? -1, bytes[at + 1] ?? -1, bytes[at + 2] ?? -1];
const LIT = Math.round(0.8 * 1.12 * 255);

describe("a skinned GLB posed by a Point Kernel on Dawn (T1401b, §V147)", () => {
  it("turning joint 1 about its rest head moves the arm cube and only the arm cube", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const skin = prepareMesh(GLB, "")?.mesh.skin;
    if (skin === undefined) throw new Error("fixture is not skinned");
    // The table the kernel reads its pivot from: root at the origin, arm at (0.5, 0, 0).
    expect(skin.joints.map((joint) => [joint.name, joint.parent, ...joint.head])).toEqual([["root", -1, 0, 0, 0], ["arm", 0, 0.5, 0, 0]]);
    const head = skin.joints[1]!.head;

    const anchor = texelOf([-2, 0, 0.5]);
    const armAtRest = texelOf([2, 0, 0.5]);
    const armTurned = texelOf([0.5, 1.5, 0.5]);

    const rest = await render(turnKernel(1, head, 0));
    expect(rgb(rest, anchor)).toEqual([LIT, LIT, LIT]);
    expect(rgb(rest, armAtRest)).toEqual([LIT, LIT, LIT]);
    expect(rgb(rest, armTurned)).toEqual([0, 0, 0]);

    const turned = await render(turnKernel(1, head, Math.PI / 2));
    // The anchor is weighted to joint 0: it does not move.
    expect(rgb(turned, anchor)).toEqual([LIT, LIT, LIT]);
    // The arm cube left its rest place and arrived where the turn about (0.5, 0, 0) puts it,
    // front face still +Z (the turned normal), so exactly as bright.
    expect(rgb(turned, armAtRest)).toEqual([0, 0, 0]);
    expect(rgb(turned, armTurned)).toEqual([LIT, LIT, LIT]);

    // Turning joint 0's index instead moves the anchor cube round (0.5, 0, 0) and leaves the
    // arm — the kernel is reading each vertex's OWN joint indices, not a constant.
    const other = await render(turnKernel(0, head, Math.PI / 2));
    expect(rgb(other, armAtRest)).toEqual([LIT, LIT, LIT]);
    expect(rgb(other, anchor)).toEqual([0, 0, 0]);
  }, 60_000);

  it("T1440b: a prop parented to a bone (unskinned, a child of the joint node) rides that bone", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    // The body skins only the anchor cube; the "glasses" are a plain cube node under the arm
    // joint, 1.5 m out from its head: at rest (2, 0, 0), where the arm cube was above.
    const glb = encodeFixtureGlb({
      materials: [{ name: "grey", baseColor: [1, 1, 1, 1] }],
      skins: [{ joints: ["root", "arm"], inverseBindMatrices: [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0.5, 0, 0, 1]] }],
      nodes: [
        { name: "root", children: [{ name: "arm", translation: [0.5, 0, 0], children: [{ name: "glasses", translation: [1.5, 0, 0], mesh: [cubePrimitive(0)] }] }] },
        { name: "body", skin: 0, mesh: [boundCube(-2, 0)] },
      ],
    });
    const head = prepareMesh(glb, "")!.mesh.skin!.joints[1]!.head;
    const anchor = texelOf([-2, 0, 0.5]);
    const propAtRest = texelOf([2, 0, 0.5]);
    const propTurned = texelOf([0.5, 1.5, 0.5]);
    const rest = await render(turnKernel(1, head, 0), glb);
    expect([anchor, propAtRest, propTurned].map((at) => rgb(rest, at))).toEqual([[LIT, LIT, LIT], [LIT, LIT, LIT], [0, 0, 0]]);
    // The arm turns 90 degrees about its head: the glasses go with it, the anchor stays.
    const turned = await render(turnKernel(1, head, Math.PI / 2), glb);
    expect([anchor, propAtRest, propTurned].map((at) => rgb(turned, at))).toEqual([[LIT, LIT, LIT], [0, 0, 0], [LIT, LIT, LIT]]);
  }, 60_000);

  it("T1410b: a glTF clip plays on Mesh File In alone — the arm turns about its head at the frame clock, no kernel", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    // The file's own performance: the arm joint turns 0 -> 90 degrees about +Z over one second (LINEAR = slerp).
    const glb = encodeFixtureGlb({
      materials: [{ name: "grey", baseColor: [1, 1, 1, 1] }],
      skins: [{ joints: ["root", "arm"], inverseBindMatrices: [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0.5, 0, 0, 1]] }],
      nodes: [
        { name: "root", children: [{ name: "arm", translation: [0.5, 0, 0] }] },
        { name: "body", skin: 0, mesh: [boundCube(-2, 0), boundCube(2, 1)] },
      ],
      animations: [{ name: "wave", channels: [{ node: "arm", path: "rotation", times: [0, 1], values: [0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2] }] }],
    });
    const clipGraph = (clip: Record<string, unknown>): GraphDocument => {
      const facts = prepareMesh(glb, "")!.facts;
      const nodes = [
        node("mesh", "meshFileIn", { vertices: facts.vertices, triangles: facts.triangles, parts: facts.parts, joints: facts.joints, ...clip }, "mesh1"),
        node("geo", "geometry", { mode: "surface" }, "geo1"),
        node("cam", "camera", { eye: [...EYE], lookAt: [0, 0, 0] }, "cam1"),
        node("sun", "light", { kind: "directional", direction: [0, 0, -1], intensity: 1 }, "sun1"),
        node("shot", "render", { scenes: "geo1", camera: "cam1", lights: "sun1", ambientColor: [1, 1, 1, 1], ambientIntensity: 0.12 }, "shot1"),
        node("out", "output", {}, "out1"),
      ];
      return {
        revision: 1,
        nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
        edges: {
          e1: { id: "e1", source: { nodeId: "mesh", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
          e2: { id: "e2", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
        },
        groups: {},
      } as never;
    };
    /** The frames at absTime = index / 30 (the harness's clock at 30 fps). */
    const at = async (clip: Record<string, unknown>, capture: number[]): Promise<Uint8Array[]> => {
      const result = await renderHeadless({ host: nodeGpuHost(), graph: clipGraph(clip), settings: SETTINGS, frames: Math.max(...capture) + 1, capture, fps: 30, outputNodeId: "shot", outputPortId: "out", meshes: { mesh: glb } });
      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      return result.frames.map((frame) => frame.bytes);
    };
    const anchor = texelOf([-2, 0, 0.5]);
    const armAtRest = texelOf([2, 0, 0.5]);
    // Half time, 45 degrees: the arm cube's centre at (0.5 + 1.5 cos 45, 1.5 sin 45).
    const armHalf = texelOf([0.5 + 1.5 * Math.SQRT1_2, 1.5 * Math.SQRT1_2, 0.5]);
    const armTurned = texelOf([0.5, 1.5, 0.5]);
    const [start, half] = await at({ clip: "wave" }, [0, 15]);
    expect([anchor, armAtRest, armHalf, armTurned].map((texel) => rgb(start!, texel))).toEqual([[LIT, LIT, LIT], [LIT, LIT, LIT], [0, 0, 0], [0, 0, 0]]);
    expect([anchor, armAtRest, armHalf, armTurned].map((texel) => rgb(half!, texel))).toEqual([[LIT, LIT, LIT], [0, 0, 0], [LIT, LIT, LIT], [0, 0, 0]]);
    // Past the end with Loop off the last pose holds: the full quarter turn.
    const [held] = await at({ clip: "wave", clipLoop: false }, [45]);
    expect([anchor, armAtRest, armTurned].map((texel) => rgb(held!, texel))).toEqual([[LIT, LIT, LIT], [0, 0, 0], [LIT, LIT, LIT]]);
    // Without a clip the node is the rest pose at any time.
    const [still] = await at({}, [15]);
    expect([armAtRest, armHalf].map((texel) => rgb(still!, texel))).toEqual([[LIT, LIT, LIT], [0, 0, 0]]);
  }, 60_000);
});
