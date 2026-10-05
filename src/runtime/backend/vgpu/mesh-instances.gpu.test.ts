import { describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import { cubePrimitive, encodeFixtureGlb } from "../../../domain/mesh/glb.fixture.ts";
import { prepareMesh } from "../../../points/mesh.ts";
import { renderHeadless } from "../../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1581b on a REAL device, exact (§V147): a Geometry in Instances mode with Shape: Mesh
 * draws the mesh on its Shape Mesh input at every point of its Points input, each instance
 * placed by `Object · T(place) · R(orient) · S(size)`, and is a surface citizen in every
 * pass — lit, shadowing and shadowed, written to the Normal, Albedo and Shadow outputs, and
 * shaded by a Material · WGSL.
 *
 * The lens is ORTHOGRAPHIC, 8 units high over 64 pixels: one unit is 8 pixels, and every
 * coordinate below is a multiple of an eighth, so every edge lands on a pixel boundary.
 * A claim about where instances are is then the WHOLE picture's coverage mask against the
 * union of the rectangles the formula gives — not a count, not a centroid. Each claim is
 * paired with the wire cut: the same scene with the map removed, the instance grouped out
 * or the object left untransformed must give a different, stated picture.
 */

const SIZE = 64;
const UNIT = 8;
const SETTINGS: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba8unorm",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const SQRT1_2 = Math.SQRT1_2;

/** A unit cube whose vertices are offset one unit along +X in its OWN data: an arm, so a turn shows. */
const armPrimitive = (material: number) => {
  const cube = cubePrimitive(material);
  return { ...cube, positions: cube.positions.map((value, index) => (index % 3 === 0 ? value + 1 : value)) };
};

/**
 * A FLAG, so a whole orientation shows from in front and not only where one axis went: a
 * unit cube one unit along its own +X, and a half-size cube one unit along its own +Y.
 */
const markerPrimitive = (material: number) => {
  const cube = cubePrimitive(material);
  return { ...cube, positions: cube.positions.map((value, index) => (index % 3 === 1 ? value * 0.5 + 1 : value * 0.5)) };
};

const GLB = encodeFixtureGlb({
  materials: [
    { name: "white", baseColor: [1, 1, 1, 1], roughness: 0.6, metallic: 0 },
    { name: "slate", baseColor: [0.2, 0.4, 0.6, 1], roughness: 0.6, metallic: 0.5 },
  ],
  nodes: [
    { name: "cube", mesh: [cubePrimitive(0)] },
    { name: "arm", mesh: [armPrimitive(0)] },
    { name: "flag", mesh: [armPrimitive(0), markerPrimitive(0)] },
    { name: "slate", mesh: [cubePrimitive(1)] },
    // Placed and turned in the file: Frame decides whether an instance inherits that.
    { name: "placed", translation: [2, 1, 0], rotation: [0, 0, SQRT1_2, SQRT1_2], mesh: [armPrimitive(0)] },
    { name: "rig", translation: [0, 2, 0], extras: { loom_part: "rig" }, children: [{ name: "link", translation: [1, 0, 0], mesh: [cubePrimitive(0)] }] },
  ],
});

type Parameters = Record<string, unknown>;
const node = (id: string, type: string, parameters: Parameters, label: string) => ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label });
const edge = (id: string, from: string, to: string, port: string) => ({ id, source: { nodeId: from, portId: "out" }, target: { nodeId: to, portId: port } });
const mapped = (attribute: string, value: unknown, channel?: string) => ({
  mode: "map",
  bindings: { static: { kind: "static", value }, map: { kind: "map", attribute, ...(channel === undefined ? {} : { channel }) } },
});

function meshNode(id: string, select: string, frame: "world" | "object" | "part" = "world") {
  const facts = prepareMesh(GLB, select, {}, "", frame)?.facts;
  if (facts === undefined) throw new Error(`fixture selection "${select}" is empty`);
  return node(id, "meshFileIn", { select, frame, vertices: facts.vertices, triangles: facts.triangles, parts: facts.parts, frameOrigin: facts.frameOrigin }, id === "mesh" ? "mesh_shape" : "mesh_small");
}

/**
 * The instance source: a point kernel that writes every attribute a test maps, as a pure
 * function of the slot index, so what is under test is the draw and not a kernel's maths.
 */
const ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "place", type: "vec3f", default: [0, 0, 0] },
  { name: "orient", type: "vec4f", qualifier: "quaternion", default: [0, 0, 0, 1] },
  { name: "size", type: "f32", default: [1] },
  { name: "tint", type: "vec4f", qualifier: "color", default: [1, 1, 1, 1] },
  { name: "keep", type: "f32", default: [1] },
]);

/** `body` assigns q.<attribute> from `i` (the slot, a u32) and `f` (the same, as f32). `head` goes above the kernel. */
const points = (capacity: number, body: string, head = "", attributes = ATTRIBUTES) =>
  node(
    "pts",
    "pointKernel",
    {
      capacity,
      seed: 1,
      group: "",
      attributes,
      kernel: `${head}fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let i = ctx.index;
  let f = f32(ctx.index);
${body}
  return q;
}`,
      value1: 0, value2: 0, value3: 0, value4: 0,
    },
    "kernel_points",
  );

/** Three instances, two units apart on a diagonal. */
const THREE = "  q.position = vec3f(f * 2.0 - 2.0, 1.0 - f, 0.0);";
const THREE_AT: Array<[number, number]> = [[-2, 1], [0, 0], [2, -1]];

interface Scene {
  readonly select?: string;
  readonly frame?: "world" | "object" | "part";
  readonly capacity?: number;
  readonly kernel?: string;
  /** The instancing geometry's own parameters. */
  readonly geometry?: Parameters;
  readonly material?: { readonly type: string; readonly parameters: Parameters };
  readonly render?: Parameters;
  readonly extra?: { readonly nodes: ReadonlyArray<ReturnType<typeof node>>; readonly edges?: ReadonlyArray<ReturnType<typeof edge>>; readonly lights?: string };
  /** Replace the instance source (a counted producer). */
  readonly source?: ReturnType<typeof node>;
}

function scene(options: Scene = {}): GraphDocument {
  const material = options.material ?? { type: "materialUnlit", parameters: { color: [1, 1, 1, 1] } };
  const nodes = [
    meshNode("mesh", options.select ?? "cube", options.frame ?? "world"),
    options.source ?? points(options.capacity ?? 3, options.kernel ?? THREE),
    node("mat", material.type, material.parameters, "material_surface"),
    node("geo", "geometry", { mode: "instances", shape: "mesh", material: "material_surface", ...options.geometry }, "geometry_instances"),
    node("cam", "camera", { eye: [0, 0, 5], lookAt: [0, 0, 0], ortho: true, orthoHeight: SIZE / UNIT, near: 0.1, far: 100 }, "camera_lens"),
    ...(options.extra?.nodes ?? []),
    node("shot", "render", { scenes: "geometry_instances", camera: "camera_lens", lights: options.extra?.lights ?? "", background: [0, 0, 0, 1], ...options.render }, "render_shot"),
    node("out", "output", {}, "output_main"),
  ];
  const edges = [
    edge("e1", "mesh", "geo", "mesh"),
    edge("e2", options.source?.id ?? "pts", "geo", "points"),
    edge("e3", "shot", "out", "input"),
    ...(options.extra?.edges ?? []),
  ];
  return { revision: 1, nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])), edges: Object.fromEntries(edges.map((entry) => [entry.id, entry])), groups: {} } as never;
}

async function render(document: GraphDocument, port = "out", frames = 2): Promise<Uint8Array> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: document,
    settings: SETTINGS,
    frames,
    fps: 60,
    outputNodeId: "shot",
    outputPortId: port,
    sinks: [{ nodeId: "shot", portId: port }],
    meshes: Object.fromEntries(Object.values(document.nodes).filter((entry) => entry.type === "meshFileIn").map((entry) => [entry.id, GLB])),
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return result.frames[0]!.bytes;
}

/** The pixel a world point falls in. */
const pixel = (x: number, y: number): [number, number] => [Math.floor(x * UNIT + SIZE / 2), Math.floor(SIZE / 2 - y * UNIT)];
const at = (bytes: Uint8Array, x: number, y: number): number[] => {
  const [column, row] = pixel(x, y);
  return Array.from(bytes.subarray((row * SIZE + column) * 4, (row * SIZE + column) * 4 + 4));
};

/** Which pixels pass `inside` on the red channel, as rows of "#" and ".". */
function mask(bytes: Uint8Array, inside: (red: number) => boolean = (red) => red > 127): string[] {
  return Array.from({ length: SIZE }, (_, y) => Array.from({ length: SIZE }, (_, x) => (inside(bytes[(y * SIZE + x) * 4] ?? 0) ? "#" : ".")).join(""));
}

/** The mask the union of axis-aligned boxes (centre x, y; width, height; world units) covers. */
function boxes(...rects: Array<[number, number, number, number]>): string[] {
  return Array.from({ length: SIZE }, (_, row) =>
    Array.from({ length: SIZE }, (_, column) => {
      const x = (column + 0.5 - SIZE / 2) / UNIT;
      const y = (SIZE / 2 - (row + 0.5)) / UNIT;
      return rects.some(([cx, cy, w, h]) => Math.abs(x - cx) < w / 2 && Math.abs(y - cy) < h / 2) ? "#" : ".";
    }).join(""),
  );
}
const cubes = (centres: ReadonlyArray<readonly [number, number]>, size = 1): string[] => boxes(...centres.map(([x, y]) => [x, y, size, size] as [number, number, number, number]));

async function requireDawn(): Promise<void> {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
}

describe("a mesh drawn at every point of a pointset (T1581b, §V147)", () => {
  it("draws the shape once per point, where the points are", async () => {
    await requireDawn();
    // Three unit cubes at the three points — at the file's own size: a mesh instance's Size defaults to 1.
    expect(mask(await render(scene()))).toEqual(cubes(THREE_AT));
    // Size is the instance's scale.
    expect(mask(await render(scene({ geometry: { scale: 0.5 } })))).toEqual(cubes(THREE_AT, 0.5));
    // Instance Translate adds to every instance's place.
    expect(mask(await render(scene({ geometry: { instanceTranslate: [0.5, -0.5, 0] } })))).toEqual(cubes(THREE_AT.map(([x, y]) => [x + 0.5, y - 0.5])));
  }, 120_000);

  it("takes each instance's place from the attribute Instance Translate maps", async () => {
    await requireDawn();
    // `position` stacks every instance at the origin; `place` spreads them along a row.
    const kernel = "  q.position = vec3f(0.0);\n  q.place = vec3f(f * 1.5 - 1.5, 2.0, 0.0);";
    const row: Array<[number, number]> = [[-1.5, 2], [0, 2], [1.5, 2]];
    expect(mask(await render(scene({ kernel, geometry: { instanceTranslate: mapped("place", [0, 0, 0]) } })))).toEqual(cubes(row));
    // The wire cut: unmapped, the place is `position`, and the three are one cube.
    expect(mask(await render(scene({ kernel })))).toEqual(cubes([[0, 0]]));
    // Mapped AND offset: the value still adds.
    expect(mask(await render(scene({ kernel, geometry: { instanceTranslate: mapped("place", [0, -1, 0]) } })))).toEqual(cubes(row.map(([x, y]) => [x, y - 1])));
  }, 120_000);

  it("turns each instance by its quaternion, right-handed", async () => {
    await requireDawn();
    // The arm reaches one unit along its own +X. Slot 0 turns +90° about +Z, slot 1 −90°.
    const kernel = `  q.position = vec3f(f * 4.0 - 2.0, 0.0, 0.0);
  q.orient = vec4f(0.0, 0.0, select(-0.70710678, 0.70710678, i == 0u), 0.70710678);`;
    // +90° carries +X to +Y: the first arm points UP from (−2, 0), the second DOWN from (2, 0).
    const turned = mask(await render(scene({ select: "arm", capacity: 2, kernel, geometry: { orient: mapped("orient", [0, 0, 0, 1]) } })));
    expect(turned).toEqual(cubes([[-2, 1], [2, -1]]));
    // The wire cut: unmapped, both arms point along +X.
    expect(mask(await render(scene({ select: "arm", capacity: 2, kernel })))).toEqual(cubes([[-1, 0], [3, 0]]));
  }, 120_000);

  it("sizes each instance by the attribute Size maps, times Size", async () => {
    await requireDawn();
    // Sizes 1, 2 and 4 under a Size of 0.5: cubes of 0.5, 1 and 2 units.
    const kernel = "  q.position = vec3f(select(select(1.5, -1.5, i == 1u), -3.0, i == 0u), 0.0, 0.0);\n  q.size = exp2(f);";
    expect(mask(await render(scene({ kernel, geometry: { scale: mapped("size", 0.5) } })))).toEqual(boxes([-3, 0, 0.5, 0.5], [-1.5, 0, 1, 1], [1.5, 0, 2, 2]));
    // The wire cut: unmapped, all three are 0.5.
    expect(mask(await render(scene({ kernel, geometry: { scale: 0.5 } })))).toEqual(cubes([[-3, 0], [-1.5, 0], [1.5, 0]], 0.5));
  }, 120_000);

  it("is carried by the object's own Transform: object × instance", async () => {
    await requireDawn();
    const kernel = "  q.position = vec3f(f + 1.0, 0.0, 0.0);"; // (1, 0) and (2, 0)
    // The object turns +90° about Z and rises one unit: the instances land at (0, 2) and (0, 3).
    expect(mask(await render(scene({ capacity: 2, kernel, geometry: { rotate: [0, 0, 90], translate: [0, 1, 0] } })))).toEqual(cubes([[0, 2], [0, 3]]));
    // About a pivot at (1, 0): the first instance turns in place, the second swings up to (1, 1).
    expect(mask(await render(scene({ capacity: 2, kernel, geometry: { rotate: [0, 0, 90], pivot: [1, 0, 0] } })))).toEqual(cubes([[1, 0], [1, 1]]));
    // The object's Scale spreads the instances AND sizes them: ×2 along X only.
    expect(mask(await render(scene({ capacity: 2, kernel: "  q.position = vec3f(f - 1.0, 0.0, 0.0);", geometry: { objectScale: [2, 1, 1] } })))).toEqual(boxes([-2, 0, 2, 1], [0, 0, 2, 1]));
    // The wire cut: with the Transform at its defaults they stand where the points are.
    expect(mask(await render(scene({ capacity: 2, kernel })))).toEqual(cubes([[1, 0], [2, 0]]));
  }, 120_000);

  it("draws the shape in the frame Mesh File In decoded it in", async () => {
    await requireDawn();
    const one = { capacity: 1, kernel: "  q.position = vec3f(-1.0, -1.0, 0.0);" };
    // The file puts `placed` at (2, 1) turned +90° about Z, so its arm points up from there.
    // Frame: World draws the instance with all of that baked in: the arm's cube at (−1 + 2, −1 + 1 + 1).
    expect(mask(await render(scene({ ...one, select: "placed", frame: "world" })))).toEqual(cubes([[1, 1]]));
    // Frame: Object is the shape itself: the arm reaching along +X from the instance's own place.
    expect(mask(await render(scene({ ...one, select: "placed", frame: "object" })))).toEqual(cubes([[0, -1]]));
    // Frame: Part puts the part's pivot on the instance: `link` sits one unit along +X inside `rig`.
    expect(mask(await render(scene({ ...one, select: "link", frame: "part" })))).toEqual(cubes([[0, -1]]));
    // … where Object puts the link's own origin there, and World adds the rig's two units of height.
    expect(mask(await render(scene({ ...one, select: "link", frame: "object" })))).toEqual(cubes([[-1, -1]]));
    expect(mask(await render(scene({ ...one, select: "link", frame: "world" })))).toEqual(cubes([[0, 1]]));
  }, 180_000);

  it("draws a shape a kernel has reshaped: the triangles and the normals ride through", async () => {
    await requireDawn();
    // Between the file and Shape Mesh, a kernel that owns `position` alone and halves the
    // cube's height. Its normals, colour and triangles pass by reference from the file's own
    // buffer, so the draw reads the shape from two producers.
    const facts = prepareMesh(GLB, "cube")!.facts;
    const squash = node(
      "squash",
      "pointKernel",
      {
        capacity: facts.vertices,
        attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
        kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  q.position = p.position * vec3f(1.0, 0.5, 1.0);\n  return q;\n}",
      },
      "kernel_squash",
    );
    const document = scene();
    const graph = document as unknown as { nodes: Record<string, unknown>; edges: Record<string, ReturnType<typeof edge>> };
    graph.nodes["squash"] = squash;
    graph.edges["e1"] = { ...edge("e1", "mesh", "squash", "in") };
    graph.edges["k1"] = edge("k1", "squash", "geo", "mesh");
    expect(mask(await render(document))).toEqual(boxes(...THREE_AT.map(([x, y]) => [x, y, 1, 0.5] as [number, number, number, number])));
  }, 120_000);

  it("draws only what the Group predicate keeps, and two geometries split one pointset", async () => {
    await requireDawn();
    // Four points in a row; `keep` is 1 on the even slots.
    const kernel = "  q.position = vec3f(f * 2.0 - 3.0, 0.0, 0.0);\n  q.keep = f32(i % 2u == 0u);";
    const row: Array<[number, number]> = [[-3, 0], [-1, 0], [1, 0], [3, 0]];
    expect(mask(await render(scene({ capacity: 4, kernel, geometry: { group: "p.keep > 0.5" } })))).toEqual(cubes([row[0]!, row[2]!]));
    expect(mask(await render(scene({ capacity: 4, kernel })))).toEqual(cubes(row));
    // Two shapes on one pointset: cubes on the even slots, half-size cubes on the odd. Each
    // geometry draws only its own, and together they are every point.
    const split = scene({
      capacity: 4,
      kernel,
      geometry: { group: "p.keep > 0.5" },
      extra: {
        nodes: [meshNode("mesh2", "cube"), node("small", "geometry", { mode: "instances", shape: "mesh", material: "material_surface", scale: 0.5, group: "p.keep < 0.5" }, "geometry_small")],
        edges: [edge("s1", "mesh2", "small", "mesh"), edge("s2", "pts", "small", "points")],
      },
      render: { scenes: "geometry_instances geometry_small" },
    });
    expect(mask(await render(split))).toEqual(boxes([-3, 0, 1, 1], [1, 0, 1, 1], [-1, 0, 0.5, 0.5], [3, 0, 0.5, 0.5]));
  }, 180_000);

  it("draws only the LIVE instances of a counted pointset", async () => {
    await requireDawn();
    // Eight slots; odd ids die on the first frame and the survivors (ids 0, 2, 4, 6) are compacted
    // into the first four slots. Each stands at its id.
    const source = node(
      "sim",
      "pointKernelAdvanced",
      {
        capacity: 8,
        seed: 1,
        kernel: `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  if (ctx.frameIndex == 0u) { q.id = ctx.index; }
  q.position = vec3f(f32(q.id) - 3.5, 0.0, 0.0);
  q.velocity = vec3f(0.0);
  if (q.id % 2u == 1u) { q.alive = 0u; }
  return q;
}`,
      },
      "kernel_sim",
    );
    const live = mask(await render(scene({ source, geometry: { scale: 0.5 } }), "out", 3));
    expect(live).toEqual(cubes([[-3.5, 0], [-1.5, 0], [0.5, 0], [2.5, 0]], 0.5));
  }, 120_000);

  it("writes the Normal, Albedo and Shadow outputs as a surface does", async () => {
    await requireDawn();
    // One slate cube turned 45° about +Y (half-angle 22.5°), tinted (1, 0.5, 1).
    const kernel = "  q.position = vec3f(0.0);\n  q.orient = vec4f(0.0, 0.38268343, 0.0, 0.92387953);\n  q.tint = vec4f(1.0, 0.5, 1.0, 1.0);";
    // No material named: the default lambert, base 0.8 and already linear.
    const turnedCube = (geometry: Parameters, render: Parameters): GraphDocument =>
      scene({ select: "slate", capacity: 1, kernel, geometry: { material: "", orient: mapped("orient", [0, 0, 0, 1]), ...geometry }, render });

    // NORMAL: right of centre the cube's +Z face, now (sin45, 0, cos45) → 218, 128, 218; left
    // its −X face, now (−sin45, 0, cos45) → 37, 128, 218; the file's roughness 0.6 → 153.
    const normal = await render(turnedCube({}, { normalOutput: true }), "normal");
    expect(at(normal, 0.3, 0)).toEqual([218, 128, 218, 153]);
    expect(at(normal, -0.3, 0)).toEqual([37, 128, 218, 153]);
    expect(at(normal, 3, 3)).toEqual([0, 0, 0, 0]);
    // The wire cut: unturned, the lens sees +Z square on.
    expect(at(await render(scene({ select: "slate", capacity: 1, kernel, geometry: { material: "" }, render: { normalOutput: true } }), "normal"), 0.3, 0)).toEqual([128, 128, 255, 153]);

    // ALBEDO: the default material's 0.8 × the file's (0.2, 0.4, 0.6) → 41, 82, 122, metallic 0.5 → 128 …
    expect(at(await render(turnedCube({}, { albedoOutput: true }), "albedo"), 0.3, 0)).toEqual([41, 82, 122, 128]);
    // … and × the instance's own tint (1, 0.5, 1) when Tint is mapped: green halves to 41.
    expect(at(await render(turnedCube({ tint: mapped("tint", [1, 1, 1, 1]) }, { albedoOutput: true }), "albedo"), 0.3, 0)).toEqual([41, 41, 122, 128]);
  }, 180_000);

  it("casts and receives shadows, from a directional and a point light", async () => {
    await requireDawn();
    /* A wall two units behind the origin (the default ±1 grid, tripled), under a 0.5 ambient.
       In shadow a lambert 0.8 surface is the ambient floor alone: 0.8 × 0.5 = 0.4 → 102. */
    const SHADOWED = 102;
    const stage = (light: Parameters, kernel: string, capacity: number, geometry: Parameters = {}, render: Parameters = {}): GraphDocument =>
      scene({
        capacity,
        kernel,
        // No material named: the default lambert, which casts (an unlit instance would not).
        geometry: { material: "", ...geometry },
        extra: {
          nodes: [
            node("grid", "pointGrid", { cols: 2, rows: 2, count: 4 }, "grid_wall"),
            node("wall", "geometry", { mode: "surface", objectScale: [3, 3, 1], translate: [0, 0, -2] }, "geometry_wall"),
            node("key", "light", { color: [1, 1, 1, 1], shadows: true, shadowSoftness: 0, ...light }, "light_key"),
          ],
          edges: [edge("w1", "grid", "wall", "points")],
          lights: "light_key",
        },
        render: { ambientColor: [1, 1, 1, 1], ambientIntensity: 0.5, scenes: "geometry_wall geometry_instances", ...render },
      });
    const red = (bytes: Uint8Array, x: number, y: number): number => at(bytes, x, y)[0]!;

    // DIRECTIONAL, travelling (−1, 0, −1): an instance at the origin shadows the wall over
    // x ∈ −3..−1. Lit wall: 0.4 + 0.8 × 0.5 × cos45 → 174.
    const sun = { kind: "directional", direction: [-1, 0, -1], intensity: 0.5, shadowExtent: 5 };
    const one = "  q.position = vec3f(f * 2.0, 0.0, 0.0);";
    const cast = await render(stage(sun, one, 1));
    expect(red(cast, -2, 0)).toBe(SHADOWED);
    expect(red(cast, 2, 0)).toBe(174);
    // The wire cut: grouped out, the instance casts nothing — the wall there is lit.
    const gone = await render(stage(sun, `${one}\n  q.keep = 0.0;`, 1, { group: "p.keep > 0.5" }));
    expect(red(gone, -2, 0)).toBe(174);
    expect(mask(gone, (value) => value === SHADOWED)).toEqual(boxes());
    // The matte says the same: 1 where the wall is shadowed, 0 where it is lit, a = 1 on a surface.
    const matte = await render(stage(sun, one, 1, {}, { shadowOutput: true }), "shadow");
    expect(at(matte, -2, 0)).toEqual([255, 0, 0, 255]);
    expect(at(matte, 2, 0)).toEqual([0, 0, 0, 255]);

    // RECEIVING: a second instance at (1, 0, 1) stands between the light and the first one's
    // front face, which is then the ambient floor; alone, that face is lit: 0.4 + 0.4 × cos45 → 174.
    const pair = "  q.position = vec3f(f, 0.0, f);";
    expect(red(await render(stage(sun, pair, 2)), 0, 0)).toBe(SHADOWED);
    expect(red(await render(stage(sun, pair, 1)), 0, 0)).toBe(174);

    // POINT, at (2, 0, 2): the ray through an instance at the origin lands on the wall at (−2, 0).
    const lamp = { kind: "point", position: [2, 0, 2], intensity: 8, shadowExtent: 12 };
    const lampCast = await render(stage(lamp, one, 1));
    expect(red(lampCast, -2, 0)).toBe(SHADOWED);
    const lampGone = await render(stage(lamp, `${one}\n  q.keep = 0.0;`, 1, { group: "p.keep > 0.5" }));
    // Unshadowed there: 0.4 + 0.8 × 8 × cosθ / (1 + d²) at the pixel's centre (−1.9375, −0.0625, −2).
    const d2 = (-1.9375 - 2) ** 2 + 0.0625 ** 2 + 16;
    expect(red(lampGone, -2, 0)).toBe(Math.round(255 * (0.4 + (6.4 * (4 / Math.sqrt(d2))) / (1 + d2))));
  }, 240_000);

  it("runs a Material · WGSL per instance: local position, instance id", async () => {
    await requireDawn();
    const painted = (expression: string) => ({
      type: "materialWgsl",
      parameters: {
        model: "unlit",
        source: `fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.albedo = ${expression};
  return o;
}`,
      },
    });
    // Slot 0 at (−2, 0) unturned; slot 1 at (2, 0) turned +90° about Z.
    const kernel = "  q.position = vec3f(f * 4.0 - 2.0, 0.0, 0.0);\n  q.orient = vec4f(0.0, 0.0, select(0.0, 0.70710678, i == 1u), select(1.0, 0.70710678, i == 1u));";
    const two = (material: ReturnType<typeof painted>) => scene({ capacity: 2, kernel, material, geometry: { orient: mapped("orient", [0, 0, 0, 1]) } });

    // Bright where the SHAPE's own x is positive: the right half of the unturned cube, and
    // the TOP half of the turned one — the pattern sticks to the part.
    const byLocal = mask(await render(two(painted("vec4f(select(0.25, 1.0, s.local.x > 0.0), 0.0, 0.0, 1.0)"))));
    expect(byLocal).toEqual(boxes([-1.75, 0, 0.5, 1], [2, 0.25, 1, 0.5]));
    // The wire cut: by s.world the split is the world's x = 0 — the left cube all dark, the right all bright.
    expect(mask(await render(two(painted("vec4f(select(0.25, 1.0, s.world.x > 0.0), 0.0, 0.0, 1.0)"))))).toEqual(cubes([[2, 0]]));

    // The instance id is the slot: 0.25 and 0.5 → 64 and 128.
    const byId = await render(two(painted("vec4f(f32(s.instanceId) * 0.25 + 0.25, 0.0, 0.0, 1.0)")));
    expect(at(byId, -2, 0)[0]).toBe(64);
    expect(at(byId, 2, 0)[0]).toBe(128);
  }, 180_000);
});

/**
 * T1581b (F9) — THE `quat` MODULE, executed. A point kernel pulls it in with `// @use quat`
 * and writes each instance's `orient` with one of its functions; what is asserted is where
 * the instance then stands, which is the only thing a kernel author wants from it.
 *
 * The shape is the FLAG at half size: its arm is a half-unit cube half a unit along where
 * the instance's +X went, its marker a quarter-unit cube half a unit along where its +Y
 * went. An axis turned onto ±Z is seen end-on, at the instance's own centre. Every turn
 * below is a quarter or a half turn, so every edge is still a pixel boundary and the claim
 * is the whole picture — the convention (right-handed, +Z carries +X toward +Y; `quatMul(a,
 * b)` is b first) is pinned by which pixels are lit, not by a sentence.
 */
type Axis = readonly [number, number];
interface Flag {
  /** What the slot's kernel line computes — the failure message's subject. */
  readonly does: string;
  /** The kernel line: assigns `q.orient` (and may move `q.position`). */
  readonly wgsl: string;
  /** Where the instance's own +X and +Y point, seen from +Z. [0, 0]: toward or away from the viewer. */
  readonly x: Axis;
  readonly y: Axis;
  /** How far the kernel line moved the instance itself. */
  readonly moved?: Axis;
}

const cell = (slot: number): Axis => [(slot % 4) * 2 - 3, 2 - Math.floor(slot / 4) * 4];
const flagBoxes = (flags: ReadonlyArray<Flag>): string[] =>
  boxes(
    ...flags.flatMap((flag, slot): Array<[number, number, number, number]> => {
      const [cx, cy] = [cell(slot)[0] + (flag.moved?.[0] ?? 0), cell(slot)[1] + (flag.moved?.[1] ?? 0)];
      return [
        [cx + flag.x[0] * 0.5, cy + flag.x[1] * 0.5, 0.5, 0.5],
        [cx + flag.y[0] * 0.5, cy + flag.y[1] * 0.5, 0.25, 0.25],
      ];
    }),
  );

function flagScene(flags: ReadonlyArray<Flag>, geometry: Parameters = { orient: mapped("orient", [0, 0, 0, 1]) }): GraphDocument {
  const body = `  q.position = vec3f(f32(i % 4u) * 2.0 - 3.0, 2.0 - f32(i / 4u) * 4.0, 0.0);
  let X = vec3f(1.0, 0.0, 0.0);
  let Y = vec3f(0.0, 1.0, 0.0);
  let Z = vec3f(0.0, 0.0, 1.0);
  let quarter = radians(90.0);
  switch i {
${flags.map((flag, slot) => `    case ${slot}u: {\n      ${flag.wgsl}\n    }`).join("\n")}
    default: {}
  }`;
  return scene({ select: "flag", source: points(flags.length, body, "// @use quat\n"), geometry: { scale: 0.5, ...geometry } });
}

/** Names the slots whose flag stands somewhere else, before the whole picture is compared. */
async function flagsStand(flags: ReadonlyArray<Flag>): Promise<void> {
  const drawn = mask(await render(flagScene(flags)));
  const expected = flagBoxes(flags);
  const wrong = flags.filter((_, slot) => {
    const [column, row] = pixel(cell(slot)[0], cell(slot)[1]);
    const around = (lines: string[]) => lines.slice(row - 16, row + 16).map((line) => line.slice(column - 8, column + 8)).join("\n");
    return around(drawn) !== around(expected);
  });
  expect(wrong.map((flag) => flag.does)).toEqual([]);
  expect(drawn).toEqual(expected);
}

describe("the quat module, in a kernel that writes orient (T1581b F9, §V147)", () => {
  const TURNS: Flag[] = [
    // A quarter turn about +Z carries +X to +Y and +Y to −X. The axis need not be unit length.
    { does: "quatAxisAngle", wgsl: "q.orient = quatAxisAngle(vec3f(0.0, 0.0, 2.0), quarter);", x: [0, 1], y: [-1, 0] },
    // b FIRST, then a: about X (+Y goes to +Z), then about Z (+X goes to +Y). The other order leaves +X on +Z.
    { does: "quatMul", wgsl: "q.orient = quatMul(quatAxisAngle(Z, quarter), quatAxisAngle(X, quarter));", x: [0, 1], y: [0, 0] },
    // The same turn applied to a vector by the kernel itself: a quarter unit along +X becomes a quarter unit UP.
    { does: "quatRotate", wgsl: "q.position += quatRotate(quatAxisAngle(Z, quarter), vec3f(0.25, 0.0, 0.0));", x: [1, 0], y: [0, 1], moved: [0, 0.25] },
    // 60° to 120° about Z the SHORT way is through 90° — though the second is written as its negative, the same turn.
    { does: "quatSlerp, the short way", wgsl: "q.orient = quatSlerp(quatAxisAngle(Z, radians(60.0)), -quatAxisAngle(Z, radians(120.0)), 0.5);", x: [0, 1], y: [-1, 0] },
    // Between a turn and itself there is no angle to divide by: it is that turn (a half turn about X).
    { does: "quatSlerp, between equals", wgsl: "q.orient = quatSlerp(quatAxisAngle(X, radians(180.0)), quatAxisAngle(X, radians(180.0)), 0.3);", x: [1, 0], y: [0, -1] },
  ];

  const FRAMES: Flag[] = [
    // The three axes an instance should end up with, as a quaternion. Trace above zero.
    { does: "quatFromFrame, a quarter turn", wgsl: "q.orient = quatFromFrame(Y, -X, Z);", x: [0, 1], y: [-1, 0] },
    // A third of a turn about the diagonal, backwards: +X to +Z, +Y to +X. Trace zero, w not zero.
    { does: "quatFromFrame, a third of a turn", wgsl: "q.orient = quatFromFrame(Z, X, Y);", x: [0, 0], y: [1, 0] },
    // 150° about X, where X is the largest diagonal entry — finished to a half turn by 30° more, so it reads exactly.
    {
      does: "quatFromFrame, most of a half turn about X",
      wgsl: "let c = cos(radians(150.0)); let s = sin(radians(150.0)); q.orient = quatMul(quatAxisAngle(X, radians(30.0)), quatFromFrame(X, vec3f(0.0, c, s), vec3f(0.0, -s, c)));",
      x: [1, 0],
      y: [0, -1],
    },
    // The same about Y.
    {
      does: "quatFromFrame, most of a half turn about Y",
      wgsl: "let c = cos(radians(150.0)); let s = sin(radians(150.0)); q.orient = quatMul(quatAxisAngle(Y, radians(30.0)), quatFromFrame(vec3f(c, 0.0, -s), Y, vec3f(s, 0.0, c)));",
      x: [-1, 0],
      y: [0, 1],
    },
    // +Z onto forward (away from the viewer), +Y as near to up as it can be: up is a hint, neither unit nor square to forward.
    { does: "quatLookAt", wgsl: "q.orient = quatLookAt(vec3f(0.0, 0.0, -3.0), vec3f(2.0, 0.0, -5.0));", x: [0, 1], y: [1, 0] },
    // Up along forward says nothing about the roll. The module picks one; what matters is that the flag is drawn, whole.
    { does: "quatLookAt, up along forward", wgsl: "q.orient = quatLookAt(Z, Z);", x: [0, -1], y: [1, 0] },
    // The shortest turn carrying one direction onto another: +X onto −Y is a quarter turn about −Z.
    { does: "quatFromTo", wgsl: "q.orient = quatFromTo(vec3f(2.0, 0.0, 0.0), vec3f(0.0, -3.0, 0.0));", x: [0, -1], y: [1, 0] },
    // Opposite directions have no shortest turn. The module picks a half turn; the arm is on −X whichever it picks.
    { does: "quatFromTo, opposite", wgsl: "q.orient = quatFromTo(X, -X);", x: [-1, 0], y: [0, -1] },
  ];

  it("composes, applies and interpolates turns: axis-angle, multiply, rotate, slerp", async () => {
    await requireDawn();
    await flagsStand(TURNS);
    // The wire cut: with Orient unmapped the kernel's quaternions reach nothing, and every
    // flag stands as the file drew it — only the one the kernel MOVED is still moved.
    const unturned = TURNS.map((flag) => ({ ...flag, x: [1, 0] as Axis, y: [0, 1] as Axis }));
    expect(mask(await render(flagScene(TURNS, {})))).toEqual(flagBoxes(unturned));
  }, 120_000);

  it("builds a turn from where it should end up: from a frame, look-at, from-to", async () => {
    await requireDawn();
    await flagsStand(FRAMES);
  }, 120_000);

  it("reaches a spawn hook that asks for it: the newborn is turned, its parent is not", async () => {
    await requireDawn();
    // One parent at (2, 0) emits one child on the first frame. The child arrives as its
    // parent's copy, and the hook swings it a quarter turn about Z: to (0, 2).
    const sim = (spawn: string) =>
      node(
        "sim",
        "pointKernelAdvanced",
        {
          capacity: 8,
          seed: 1,
          kernel: `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let first = ctx.frameIndex == 0u;
  if (first) { q.position = vec3f(2.0, 0.0, 0.0); }
  if (first && ctx.index != 0u) { q.alive = 0u; }
  q.spawnCount = select(0u, 1u, first && ctx.index == 0u);
  q.velocity = vec3f(0.0);
  return q;
}`,
          spawn,
        },
        "kernel_sim",
      );
    const hook = `// @use quat
fn spawn(child: Point, ctx: PointCtx) -> Point {
  var c = child;
  c.position = quatRotate(quatAxisAngle(vec3f(0.0, 0.0, 1.0), radians(90.0)), child.position);
  return c;
}`;
    expect(mask(await render(scene({ source: sim(hook), geometry: { scale: 0.5 } }), "out", 4))).toEqual(cubes([[2, 0], [0, 2]], 0.5));
    // The wire cut: with no hook the child is its parent's copy, and the two are one cube.
    expect(mask(await render(scene({ source: sim(""), geometry: { scale: 0.5 } }), "out", 4))).toEqual(cubes([[2, 0]], 0.5));
  }, 120_000);
});

/**
 * T1581b slice E (D9) — CUSTOM INSTANCE ATTRIBUTES. A Material · WGSL declares what it reads
 * per instance as `struct Instance`; a mesh-instancing Geometry binds each field to the
 * points' attribute of the same name. What is asserted is the colour each instance is
 * painted, which is the only place the value is for: an unlit material writes its fields
 * straight to the picture, in fifths, so every expected byte is a whole number.
 */
describe("a material's struct Instance, bound to the points by name (T1581b, §V147)", () => {
  /** red: glow. green: ring / 5. blue: shade.z. Defaults 0.4, 3 and 0.2 → 102, 153, 51. */
  const PAINT = {
    type: "materialWgsl",
    parameters: {
      model: "unlit",
      source: `struct Instance {
  glow: f32,    // @default 0.4  How hot this instance is.
  ring: u32,    // @default 3
  shade: vec3f, // @default [0, 0, 0.2]
};

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.albedo = vec4f(s.instance.glow, f32(s.instance.ring) * 0.2, s.instance.shade.z, 1.0);
  return o;
}`,
    },
  };

  const CARRIED = [
    { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
    { name: "glow", type: "f32", default: [0] },
    { name: "ring", type: "u32", default: [0] },
    { name: "shade", type: "vec3f", default: [0, 0, 0] },
    { name: "heat", type: "f32", default: [0] },
    { name: "pick", type: "vec4f", default: [0, 0, 0, 0] },
  ];
  /** Three instances; glow 0.2, 0.4, 0.6 — ring 0, 1, 2 — shade.z 1, 0.8, 0.6 — heat 1, 0.8, 0.6 — pick.z 0.8, 0.6, 0.4. */
  const WRITES = `${THREE}
  q.glow = f * 0.2 + 0.2;
  q.ring = i;
  q.shade = vec3f(0.5, 0.5, 1.0 - f * 0.2);
  q.heat = 1.0 - f * 0.2;
  q.pick = vec4f(0.0, 0.0, 0.8 - f * 0.2, 0.0);`;
  const carrying = (names: readonly string[]) => JSON.stringify(CARRIED.filter((attribute) => names.includes(attribute.name)));
  const ALL = CARRIED.map((attribute) => attribute.name);
  /** The kernel lines that write an attribute the pointset does not carry are dropped with it. */
  const source = (names: readonly string[] = ALL) =>
    points(3, WRITES.split("\n").filter((line) => !/^ {2}q\.(\w+) =/.test(line) || names.includes(/^ {2}q\.(\w+) =/.exec(line)![1]!)).join("\n"), "", carrying(names));
  const painted = (names: readonly string[] = ALL, geometry: Parameters = {}) => scene({ source: source(names), material: PAINT, geometry });
  const colours = (bytes: Uint8Array): number[][] => THREE_AT.map(([x, y]) => at(bytes, x, y).slice(0, 3));

  it("hands each instance its own values: the field takes the attribute of its name", async () => {
    await requireDawn();
    const drawn = await render(painted());
    expect(colours(drawn)).toEqual([[51, 0, 255], [102, 51, 204], [153, 102, 153]]);
    // Still three cubes where the points are: the fields changed the paint and nothing else.
    expect(mask(drawn, (red) => red > 25)).toEqual(cubes(THREE_AT));
  }, 120_000);

  it("reads a field's @default where the points carry no such attribute", async () => {
    await requireDawn();
    // The wire cut, field by field: without `glow` every instance is the declared 0.4 …
    expect(colours(await render(painted(ALL.filter((name) => name !== "glow"))))).toEqual([[102, 0, 255], [102, 51, 204], [102, 102, 153]]);
    // … without `ring` the declared 3, without `shade` the declared (0, 0, 0.2).
    expect(colours(await render(painted(["position", "glow"])))).toEqual([[51, 153, 51], [102, 153, 51], [153, 153, 51]]);
  }, 120_000);

  it("binds another attribute, or one channel of one, by a line of Instance Attributes", async () => {
    await requireDawn();
    // glow from `heat` (1, 0.8, 0.6) in place of the attribute of its own name.
    expect(colours(await render(painted(ALL, { instanceAttributes: "glow = heat" })))).toEqual([[255, 0, 255], [204, 51, 204], [153, 102, 153]]);
    // glow from the third channel of the vec4f `pick` (0.8, 0.6, 0.4).
    expect(colours(await render(painted(ALL, { instanceAttributes: "glow = pick.z" })))).toEqual([[204, 0, 255], [153, 51, 204], [102, 102, 153]]);
  }, 120_000);

  it("is the same value in the Albedo output, and the defaults on a Surface wearing the same material", async () => {
    await requireDawn();
    // The G-buffer's albedo layer runs the material too: the same three colours.
    const albedo = await render(scene({ source: source(), material: PAINT, render: { albedoOutput: true } }), "albedo");
    expect(colours(albedo)).toEqual([[51, 0, 255], [102, 51, 204], [153, 102, 153]]);
    // A Surface has no instances: every field is its default, and the one material compiles for both.
    const both = scene({
      source: source(),
      material: PAINT,
      extra: {
        nodes: [meshNode("hull", "cube"), node("skin", "geometry", { mode: "surface", material: "material_surface", translate: [-2, -2, 0] }, "geometry_hull")],
        edges: [edge("e9", "hull", "skin", "points")],
      },
      render: { scenes: "geometry_instances geometry_hull" },
    });
    const drawn = await render(both);
    expect(at(drawn, -2, -2).slice(0, 3)).toEqual([102, 153, 51]);
    expect(colours(drawn)).toEqual([[51, 0, 255], [102, 51, 204], [153, 102, 153]]);
  }, 180_000);
});
