import { describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import { cubePrimitive, encodeFixtureGlb } from "../../../domain/mesh/glb.fixture.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import { prepareMesh } from "../../../points/mesh.ts";
import { renderHeadless } from "../../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1588b on a REAL device, exact (§V147): a scene geometry's OBJECT TRANSFORM is the draw's
 * model matrix in every pass — colour, the G-buffer, the depth sweeps (shadows, the Depth
 * output) and glass.
 *
 *     Object = T(translate) · T(pivot) · R(rotate) · S(scale) · T(−pivot)
 *
 * The lens is ORTHOGRAPHIC, 4 units high over 32 pixels, so one unit is 8 pixels and every
 * edge below lands on a pixel boundary: a unit cube at the origin covers columns 12..19 and
 * rows 12..19 and nothing else. Each claim is a bounding box derived from the formula, or a
 * byte-for-byte equality with the same object AUTHORED where the transform puts it (the file
 * places `cubeX` at x = 1, and so on) — a control the transform had no hand in.
 *
 * THE TURN CONVENTION is pinned to the world, not to this file's arithmetic (§V683): a
 * positive Rotate Z carries +X toward +Y, X carries +Y toward +Z, Y carries +Z toward +X, and
 * the three apply X then Y then Z. Each is checked against the cube the file already put on
 * the axis the turn should reach, and against the opposite turn, which must land elsewhere.
 */

const SIZE = 32;
const settings = (size: number): ProjectSettings => ({
  outputResolution: { width: size, height: size },
  workingFormat: "rgba8unorm",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
});

const GLB = encodeFixtureGlb({
  materials: [{ name: "white", baseColor: [1, 1, 1, 1], roughness: 0.6, metallic: 0 }],
  nodes: [
    { name: "cube", mesh: [cubePrimitive(0)] },
    { name: "cubeX", translation: [1, 0, 0], mesh: [cubePrimitive(0)] },
    { name: "cubeY", translation: [0, 1, 0], mesh: [cubePrimitive(0)] },
    { name: "cubeZ", translation: [0, 0, 1], mesh: [cubePrimitive(0)] },
  ],
});

type Parameters = Record<string, unknown>;
const node = (id: string, type: string, parameters: Parameters, label: string) => ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label });
const edge = (id: string, from: string, to: string, port: string) => ({ id, source: { nodeId: from, portId: "out" }, target: { nodeId: to, portId: port } });

function meshNode(select: string) {
  const facts = prepareMesh(GLB, select)?.facts;
  if (facts === undefined) throw new Error(`fixture selection "${select}" is empty`);
  return node("mesh", "meshFileIn", { select, vertices: facts.vertices, triangles: facts.triangles, parts: facts.parts }, "mesh_cube");
}

const CAMERAS = {
  /** From +Z, looking down −Z: +X is screen right, +Y is screen up. */
  front: { eye: [0, 0, 5], lookAt: [0, 0, 0] },
  /** From +X, looking down −X. */
  side: { eye: [5, 0, 0], lookAt: [0, 0, 0] },
  /** From +Y, looking straight down. */
  top: { eye: [0, 5, 0], lookAt: [0, 0, 0] },
} as const;

interface Scene {
  /** Which fixture object the Mesh File In selects. */
  readonly select?: string;
  /** The geometry's own parameters: the Transform under test. */
  readonly geometry?: Parameters;
  readonly camera?: keyof typeof CAMERAS;
  readonly orthoHeight?: number;
  readonly material?: { readonly type: string; readonly parameters: Parameters };
  readonly render?: Parameters;
  /** Extra nodes and edges (a wall, a light), and the names the Render lists. */
  readonly extra?: { readonly nodes: ReadonlyArray<ReturnType<typeof node>>; readonly edges?: ReadonlyArray<ReturnType<typeof edge>>; readonly scenes?: string; readonly lights?: string };
}

function scene(options: Scene = {}): GraphDocument {
  const material = options.material ?? { type: "materialUnlit", parameters: { color: [1, 1, 1, 1] } };
  const nodes = [
    meshNode(options.select ?? "cube"),
    node("mat", material.type, material.parameters, "material_object"),
    node("geo", "geometry", { mode: "surface", material: "material_object", ...options.geometry }, "geometry_object"),
    node("cam", "camera", { ...CAMERAS[options.camera ?? "front"], ortho: true, orthoHeight: options.orthoHeight ?? 4, near: 0.1, far: 100 }, "camera_lens"),
    ...(options.extra?.nodes ?? []),
    node(
      "shot",
      "render",
      { scenes: `${options.extra?.scenes ?? ""} geometry_object`.trim(), camera: "camera_lens", lights: options.extra?.lights ?? "", background: [0, 0, 0, 1], ...options.render },
      "render_shot",
    ),
    node("out", "output", {}, "output_main"),
  ];
  const edges = [edge("e1", "mesh", "geo", "points"), edge("e2", "shot", "out", "input"), ...(options.extra?.edges ?? [])];
  return { revision: 1, nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])), edges: Object.fromEntries(edges.map((entry) => [entry.id, entry])), groups: {} } as never;
}

async function render(document: GraphDocument, port = "out", frames = 1, size = SIZE): Promise<Uint8Array> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: document,
    settings: settings(size),
    frames,
    fps: 60,
    outputNodeId: "shot",
    outputPortId: port,
    sinks: [{ nodeId: "shot", portId: port }],
    meshes: { mesh: GLB },
    ...(frames > 1 ? { animate: true } : {}),
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return result.frames[0]!.bytes;
}

const at = (bytes: Uint8Array, x: number, y: number, size = SIZE): number[] => Array.from(bytes.subarray((y * size + x) * 4, (y * size + x) * 4 + 4));

/** The inclusive pixel box of everything whose red channel passes `inside`, and how many pixels that is. */
function box(bytes: Uint8Array, inside: (red: number) => boolean = (red) => red > 127): { cols: [number, number]; rows: [number, number]; count: number } | null {
  let x0 = SIZE, x1 = -1, y0 = SIZE, y1 = -1, count = 0;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (!inside(bytes[(y * SIZE + x) * 4] ?? 0)) continue;
      count += 1;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  return count === 0 ? null : { cols: [x0, x1], rows: [y0, y1], count };
}

async function requireDawn(): Promise<void> {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
}

describe("a geometry's object transform is the draw's model matrix (T1588b, §V147)", () => {
  it("places a mesh surface by Translate, Scale and Pivot, to the pixel", async () => {
    await requireDawn();
    const control = await render(scene());
    expect(box(control)).toEqual({ cols: [12, 19], rows: [12, 19], count: 64 });

    // Translate: one unit right is 8 columns, half a unit up is 4 rows.
    expect(box(await render(scene({ geometry: { translate: [1, 0.5, 0] } })))).toEqual({ cols: [20, 27], rows: [8, 15], count: 64 });
    // … and it is the same picture as the cube the FILE put at x = 1.
    expect(Array.from(await render(scene({ geometry: { translate: [1, 0, 0] } })))).toEqual(Array.from(await render(scene({ select: "cubeX" }))));

    // Scale is per axis: twice as wide, no taller.
    expect(box(await render(scene({ geometry: { objectScale: [2, 1, 1] } })))).toEqual({ cols: [8, 23], rows: [12, 19], count: 128 });
    // The pivot is the point the scale leaves alone: the right edge (x = 0.5) stays, the left runs to −1.5.
    expect(box(await render(scene({ geometry: { objectScale: [2, 1, 1], pivot: [0.5, 0, 0] } })))).toEqual({ cols: [4, 19], rows: [12, 19], count: 128 });
    // With no turn and a scale of 1 a pivot changes nothing at all.
    expect(Array.from(await render(scene({ geometry: { pivot: [0.5, 0.25, 0] } })))).toEqual(Array.from(control));
  }, 120_000);

  it("turns right-handed about each axis, X then Y then Z", async () => {
    await requireDawn();
    const placed = async (select: string, camera: keyof typeof CAMERAS) => box(await render(scene({ select, camera })));
    const turned = async (select: string, rotate: readonly number[], camera: keyof typeof CAMERAS) => box(await render(scene({ select, camera, geometry: { rotate } })));

    // +Z carries +X toward +Y: the cube on +X lands where the file's +Y cube is — above centre.
    const onY = await placed("cubeY", "front");
    expect(onY).toEqual({ cols: [12, 19], rows: [4, 11], count: 64 });
    expect(await turned("cubeX", [0, 0, 90], "front")).toEqual(onY);
    expect(await turned("cubeX", [0, 0, -90], "front")).toEqual({ cols: [12, 19], rows: [20, 27], count: 64 });

    // +X carries +Y toward +Z, seen from the side.
    const onZ = await placed("cubeZ", "side");
    expect(await turned("cubeY", [90, 0, 0], "side")).toEqual(onZ);
    expect(await turned("cubeY", [-90, 0, 0], "side")).not.toEqual(onZ);

    // +Y carries +Z toward +X, seen from above.
    const onX = await placed("cubeX", "top");
    expect(await turned("cubeZ", [0, 90, 0], "top")).toEqual(onX);
    expect(await turned("cubeZ", [0, -90, 0], "top")).not.toEqual(onX);

    // The order: X first sends the +Y cube to +Z, where the Z turn leaves it — dead centre
    // from the front. Z first would send it to −X and the X turn would leave it there.
    expect(await turned("cubeY", [90, 0, 90], "front")).toEqual({ cols: [12, 19], rows: [12, 19], count: 64 });
  }, 180_000);

  it("moves a GRID surface the same way", async () => {
    await requireDawn();
    const grid = (geometry: Parameters): GraphDocument =>
      scene({
        extra: {
          nodes: [node("grid", "pointGrid", { cols: 2, rows: 2, count: 4 }, "grid_points"), node("sheet", "geometry", { mode: "surface", material: "material_object", ...geometry }, "geometry_sheet")],
          edges: [edge("g1", "grid", "sheet", "points")],
          scenes: "geometry_sheet",
        },
        // The cube steps aside so the sheet is the only thing in frame.
        select: "cubeZ",
        camera: "front",
        render: { scenes: "geometry_sheet" },
      });
    // The default grid spans ±1: 16 columns by 16 rows.
    expect(box(await render(grid({})))).toEqual({ cols: [8, 23], rows: [8, 23], count: 256 });
    // Halved about its own middle, then one unit right.
    expect(box(await render(grid({ objectScale: [0.5, 0.5, 1], translate: [1, 0, 0] })))).toEqual({ cols: [20, 27], rows: [12, 19], count: 64 });
  }, 120_000);

  it("turns the normals with the object: the Normal output reads the turned faces", async () => {
    await requireDawn();
    const normals = async (geometry: Parameters) => render(scene({ geometry, material: { type: "materialPbr", parameters: {} }, render: { normalOutput: true } }), "normal");
    // Facing the lens: +Z, encoded n·0.5 + 0.5, and the file's roughness 0.6 in alpha.
    expect(at(await normals({}), 16, 16)).toEqual([128, 128, 255, 153]);
    // Turned +45° about +Y the lens sees two faces. Right of centre, the old +Z face, now
    // (sin45, 0, cos45): 0.5 + 0.5·0.7071 = 0.8536 → 218. Left of centre, the old −X face, now
    // (−sin45, 0, cos45): 0.1464 → 37.
    const turned = await normals({ rotate: [0, 45, 0] });
    expect(at(turned, 19, 16)).toEqual([218, 128, 218, 153]);
    expect(at(turned, 12, 16)).toEqual([37, 128, 218, 153]);
  }, 120_000);

  it("casts its shadow from where it is, under a directional and a point light", async () => {
    await requireDawn();
    /* 64 pixels over 8 units: one unit is 8 pixels. The wall is the default ±1 grid, tripled
       and set two units behind the origin — itself placed by the transform, so a transformed
       grid is the receiver here. It wears the default lambert (0.8) under a 0.5 ambient:
       in shadow it is the ambient floor alone, 0.8 × 0.5 = 0.4 → 102. */
    const WIDE = 64;
    const SHADOWED = 102;
    /** The pixel a wall point (x, y) falls in, and that pixel's centre back in the world. */
    const pixel = (x: number, y: number): [number, number] => [Math.floor(x * 8 + WIDE / 2), Math.floor(WIDE / 2 - y * 8)];
    const centre = ([column, row]: [number, number]): [number, number] => [(column + 0.5 - WIDE / 2) / 8, (WIDE / 2 - (row + 0.5)) / 8];
    const red = (bytes: Uint8Array, x: number, y: number): number => at(bytes, ...pixel(x, y), WIDE)[0]!;
    const lit = { type: "materialPhong", parameters: { color: [1, 1, 1, 1], specular: [0, 0, 0, 1] } };
    const stage = (light: Parameters, geometry: Parameters, caster: "mesh" | "grid" = "mesh"): GraphDocument =>
      scene({
        orthoHeight: 8,
        geometry: caster === "mesh" ? geometry : {},
        material: lit, // an unlit object casts nothing
        extra: {
          nodes: [
            node("grid", "pointGrid", { cols: 2, rows: 2, count: 4 }, "grid_points"),
            node("wall", "geometry", { mode: "surface", objectScale: [3, 3, 1], translate: [0, 0, -2] }, "geometry_wall"),
            node("cardpts", "pointGrid", { cols: 2, rows: 2, count: 4 }, "grid_card"),
            node("card", "geometry", { mode: "surface", objectScale: [0.5, 0.5, 1], ...(caster === "grid" ? geometry : {}) }, "geometry_card"),
            node("key", "light", { color: [1, 1, 1, 1], shadows: true, shadowSoftness: 0, ...light }, "light_key"),
          ],
          edges: [edge("w1", "grid", "wall", "points"), edge("c1", "cardpts", "card", "points")],
          lights: "light_key",
        },
        render: { ambientColor: [1, 1, 1, 1], ambientIntensity: 0.5, scenes: caster === "mesh" ? "geometry_wall geometry_object" : "geometry_wall geometry_card" },
      });
    const shot = (light: Parameters, geometry: Parameters, caster: "mesh" | "grid" = "mesh") => render(stage(light, geometry, caster), "out", 1, WIDE);

    // DIRECTIONAL, travelling (−1, 0, −1): a shadow lands 2 units left of its caster (the wall
    // is 2 behind it). The cube's spans x ∈ −3..−1. Lit wall: 0.4 + 0.8 × 0.5 × cos45 → 174.
    const sun = { kind: "directional", direction: [-1, 0, -1], intensity: 0.5, shadowExtent: 5 };
    const still = await shot(sun, {});
    expect(red(still, -2, 0)).toBe(SHADOWED);
    expect(red(still, 2, 0)).toBe(174);
    // Two units right, its shadow spans x ∈ −1..1: the old place is lit, the centre is dark.
    const moved = await shot(sun, { translate: [2, 0, 0] });
    expect(red(moved, -2, 0)).toBe(174);
    expect(red(moved, 0, 0)).toBe(SHADOWED);

    // A transformed GRID casts from where it is too: a 1 × 1 card at the origin shadows
    // x ∈ −2.5..−1.5, and from two units right x ∈ −0.5..0.5 (the card itself now at x ∈ 1.5..2.5).
    expect(red(await shot(sun, {}, "grid"), -2, 0)).toBe(SHADOWED);
    const cardMoved = await shot(sun, { translate: [2, 0, 0] }, "grid");
    expect(red(cardMoved, -2, 0)).toBe(174);
    expect(red(cardMoved, 0, 0)).toBe(SHADOWED);

    // POINT, at (2, 0, 2), soft falloff: lit wall is 0.4 + 0.8 × 8 × cosθ / (1 + d²) at the pixel's centre.
    const lamp = { kind: "point", position: [2, 0, 2], intensity: 8, shadowExtent: 12 };
    const lampLit = (x: number, y: number): number => {
      const [cx, cy] = centre(pixel(x, y));
      const d2 = (cx - 2) ** 2 + cy ** 2 + 16;
      return Math.round(255 * (0.4 + (6.4 * (4 / Math.sqrt(d2))) / (1 + d2)));
    };
    // The cube at the origin shadows the wall around (−2, 0): the ray through its centre lands there.
    const lampStill = await shot(lamp, {});
    expect(red(lampStill, -2, 0)).toBe(SHADOWED);
    expect(red(lampStill, -2, 2)).toBe(lampLit(-2, 2));
    // One unit up, the ray through its centre lands at (−2, 2): the two places trade.
    const lampMoved = await shot(lamp, { translate: [0, 1, 0] });
    expect(red(lampMoved, -2, 2)).toBe(SHADOWED);
    expect(red(lampMoved, -2, 0)).toBe(lampLit(-2, 0));
  }, 240_000);

  it("writes the Depth output from where it is", async () => {
    await requireDawn();
    const depth = async (select: string, geometry: Parameters) => Array.from(await render(scene({ select, geometry, render: { depthOutput: true } }), "depth"));
    const nearer = await depth("cube", { translate: [0, 0, 1] });
    // A unit toward the lens is exactly the cube the file put at z = 1 …
    expect(nearer).toEqual(await depth("cubeZ", {}));
    // … and not the cube left at the origin.
    expect(nearer).not.toEqual(await depth("cube", {}));
  }, 120_000);

  it("refracts glass from where it is, mesh and grid alike", async () => {
    await requireDawn();
    const glass = { type: "materialGlass", parameters: { ior: 1, roughness: 0, thickness: 0.85, absorption: [0.9, 0, 0, 1], dispersion: 0 } };
    // A white unlit wall behind everything, so absorbed red is visible where the glass is.
    const wall = {
      nodes: [
        node("wallpts", "pointGrid", { cols: 2, rows: 2, count: 4 }, "grid_wall"),
        node("white", "materialUnlit", { color: [1, 1, 1, 1] }, "material_white"),
        node("wall", "geometry", { mode: "surface", material: "material_white", objectScale: [4, 4, 1], translate: [0, 0, -2] }, "geometry_wall"),
      ],
      edges: [edge("w1", "wallpts", "wall", "points")],
      scenes: "geometry_wall",
    };
    const dimmed = (red: number): boolean => red < 255;

    // A glass CUBE (the mesh generator): where it is, red is absorbed; moved, so is that.
    expect(box(await render(scene({ material: glass, extra: wall })), dimmed)).toEqual({ cols: [12, 19], rows: [12, 19], count: 64 });
    expect(box(await render(scene({ material: glass, extra: wall, geometry: { translate: [1, 0, 0] } })), dimmed)).toEqual({ cols: [20, 27], rows: [12, 19], count: 64 });

    // A glass PANE (the grid generator): the ±1 grid halved and moved.
    const pane = (geometry: Parameters): GraphDocument =>
      scene({
        select: "cubeZ",
        geometry: { translate: [0, 0, 50] },
        extra: {
          nodes: [...wall.nodes, node("glassmat", glass.type, glass.parameters, "material_glass"), node("panepts", "pointGrid", { cols: 2, rows: 2, count: 4 }, "grid_pane"), node("pane", "geometry", { mode: "surface", material: "material_glass", ...geometry }, "geometry_pane")],
          edges: [...wall.edges, edge("p1", "panepts", "pane", "points")],
          scenes: "geometry_wall geometry_pane",
        },
        render: { scenes: "geometry_wall geometry_pane" },
      });
    expect(box(await render(pane({ objectScale: [0.5, 0.5, 1] })), dimmed)).toEqual({ cols: [12, 19], rows: [12, 19], count: 64 });
    expect(box(await render(pane({ objectScale: [0.5, 0.5, 1], translate: [1, 0, 0] })), dimmed)).toEqual({ cols: [20, 27], rows: [12, 19], count: 64 });
  }, 180_000);

  it("hands a Material · WGSL the shape's own frame: detail painted by s.local moves with the object", async () => {
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
    const row = (bytes: Uint8Array): number[] => Array.from({ length: SIZE }, (_, x) => at(bytes, x, 16)[0]!);
    const shifted = (values: number[], by: number): number[] => values.map((_, x) => values[x - by] ?? 0);

    // Half dark, half bright, split at the cube's own x = 0.
    const byLocal = painted("vec4f(select(0.25, 1.0, s.local.x > 0.0), 0.0, 0.0, 1.0)");
    const still = row(await render(scene({ material: byLocal })));
    expect(still.slice(12, 20)).toEqual([64, 64, 64, 64, 255, 255, 255, 255]);
    // Moved one unit, the SAME pattern rides along, eight columns over.
    expect(row(await render(scene({ material: byLocal, geometry: { translate: [1, 0, 0] } })))).toEqual(shifted(still, 8));
    // The wire cut: painted by s.world the split stays at the world's x = 0, and the moved cube is all bright.
    const byWorld = painted("vec4f(select(0.25, 1.0, s.world.x > 0.0), 0.0, 0.0, 1.0)");
    expect(row(await render(scene({ material: byWorld, geometry: { translate: [1, 0, 0] } }))).slice(20, 28)).toEqual([255, 255, 255, 255, 255, 255, 255, 255]);

    // s.localNormal is the face's own normal however the object is turned: turned 45° about
    // +Y, the right face is still the cube's +Z (0.5, 0.5, 1) and the left its −X (0, 0.5, 0.5).
    const byNormal = painted("vec4f(s.localNormal * 0.5 + vec3f(0.5), 1.0)");
    const turned = await render(scene({ material: byNormal, geometry: { rotate: [0, 45, 0] } }));
    expect(at(turned, 19, 16)).toEqual([128, 128, 255, 255]);
    expect(at(turned, 12, 16)).toEqual([0, 128, 128, 255]);
    // … and it is 0 on a surface, the instance id.
    const byId = painted("vec4f(f32(s.instanceId) + 0.25, 0.0, 0.0, 1.0)");
    expect(at(await render(scene({ material: byId })), 16, 16)[0]).toBe(64);
  }, 180_000);

  it("is a value: a driven Translate moves the object frame by frame", async () => {
    await requireDawn();
    // One unit a frame at 60 fps: the captured frame is the second, a whole unit along.
    const moving = scene({ geometry: { "translate.x": expressionSlot("abstime * 60", 0) } });
    expect(box(await render(moving, "out", 2))).toEqual({ cols: [20, 27], rows: [12, 19], count: 64 });
  }, 120_000);
});
