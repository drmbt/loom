import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { frameFromClock } from "../../../domain/types/frame.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import { TIER_B_CAPABILITIES } from "../../../examples/runner.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { HULL_GLB, PRODUCER, SHOT, TEXTURE_SETTINGS, TEXTURE_SIZE, textureScene, type TextureScene } from "../../../nodes/definitions/material-textures.fixture.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { renderHeadless, syntheticMediaFrame } from "../../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";

/**
 * T1658b on a REAL device, exact (§V147): a Material · WGSL names the textures it reads
 * (`// @texture lens`), the node's Texture inputs feed them, and `surface()` reads one by a
 * coordinate of its own.
 *
 * Everything is 64: the picture, the texture, and the pixels a two-unit quad covers under
 * the fixture's orthographic camera. Pixel (x, y) of the picture is then the CENTRE of texel
 * (x, 63 − y), and the texture is a ruler whose texel (x, y) holds the bytes (4x, 4y, phase):
 * what a pixel must show is derived, never measured. The materials are unlit and return
 * what they read as their colour, so the Render's target holds the read itself.
 */

const SIZE = TEXTURE_SIZE;
const LAST = SIZE - 1;

interface Shot {
  readonly frames?: number;
  readonly capture?: ReadonlyArray<number>;
  readonly port?: string;
  readonly strict?: boolean;
}

async function frames(scene: TextureScene, options: Shot = {}): Promise<Uint8Array[]> {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: textureScene(scene),
    settings: TEXTURE_SETTINGS,
    frames: options.frames ?? 2,
    ...(options.capture === undefined ? {} : { capture: options.capture }),
    fps: 60,
    animate: true,
    outputNodeId: SHOT,
    outputPortId: options.port ?? "out",
    sinks: [{ nodeId: SHOT, portId: options.port ?? "out" }],
    meshes: scene.shape === "quad" ? {} : { mesh_hull: HULL_GLB },
    ...(options.strict === true ? { strict: true } : {}),
  });
  expect(result.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message)).toEqual([]);
  for (const frame of result.frames) expect([frame.width, frame.height, frame.format]).toEqual([SIZE, SIZE, "rgba8unorm"]);
  return result.frames.map((frame) => frame.bytes);
}
const picture = async (scene: TextureScene, options: Shot = {}): Promise<Uint8Array> => (await frames(scene, options))[0]!;
const at = (bytes: Uint8Array, x: number, y: number): number[] => Array.from(bytes.subarray((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 3));

/** The ruler's texel (x, y), as the bytes a pixel shows. */
const ruler = (x: number, y: number, phase = 0): number[] => [4 * x, 4 * y, phase];
/** The second texture's texel (x, y). */
const turned = (x: number, y: number): number[] => [4 * y, 4 * x, 200];

/** What a render of the scene refuses with: the errors it throws or reports, as one text. */
async function refusal(scene: TextureScene): Promise<string> {
  try {
    const result = await renderHeadless({ host: nodeGpuHost(), graph: textureScene(scene), settings: TEXTURE_SETTINGS, frames: 1, outputNodeId: SHOT, meshes: scene.shape === "quad" ? {} : { mesh_hull: HULL_GLB } });
    return result.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message).join(" | ");
  } catch (error) {
    return String(error instanceof Error ? error.message : error);
  }
}

/** A material that shows what one expression reads. `head` goes above `surface()`: the texture names, the modules. */
const showing = (head: string, expression: string, params = ""): string => `${head}
${params}
fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.albedo = ${expression};
  return o;
}`;

describe("T1658b: a Material · WGSL reads the texture wired into its input", () => {
  const READS_LENS = showing("// @use map\n// @texture lens", "mapNearest(lens, s.uv, vec2u(MAP_HOLD))");

  it("a quad that returns its texture read at s.uv shows the fed texture's own texels, pixel for texel", async () => {
    const bytes = await picture({ shape: "quad", source: READS_LENS, wires: ["ruler"] });
    // Four known pixels, and then every one of them.
    expect(at(bytes, 0, 63)).toEqual(ruler(0, 0));
    expect(at(bytes, 63, 63)).toEqual(ruler(63, 0));
    expect(at(bytes, 10, 20)).toEqual(ruler(10, 43));
    expect(at(bytes, 37, 5)).toEqual(ruler(37, 58));
    for (let y = 0; y < SIZE; y += 1) for (let x = 0; x < SIZE; x += 1) expect(at(bytes, x, y), `pixel ${x}, ${y}`).toEqual(ruler(x, LAST - y));
  }, 120_000);

  it("with the wire cut it does not draw a guess: the render is refused, naming the texture and its input", async () => {
    const said = await refusal({ shape: "quad", source: READS_LENS, wires: [] });
    expect(said).toContain('the source names texture "lens" (Texture 1) and nothing is wired into Texture 1.');
    // The same source wired renders, so the refusal is the wire's and not the source's.
    expect(await refusal({ shape: "quad", source: READS_LENS, wires: ["ruler"] })).toBe("");
  }, 120_000);

  it("the first name is Texture 1 and the second Texture 2: two textures, each where the code puts it, and the wires exchanged exchange them", async () => {
    const TWO = showing("// @use map\n// @texture lens\n// @texture grain", "select(mapNearest(grain, s.uv, vec2u(MAP_HOLD)), mapNearest(lens, s.uv, vec2u(MAP_HOLD)), s.uv.x < 0.5)");
    const first = await picture({ shape: "quad", source: TWO, wires: ["ruler", "turned"] });
    const second = await picture({ shape: "quad", source: TWO, wires: ["turned", "ruler"] });
    for (const [x, y] of [[3, 60], [20, 31], [31, 2], [32, 2], [45, 31], [60, 60]] as const) {
      const lens = x < 32;
      expect(at(first, x, y), `ruler then turned, ${x}, ${y}`).toEqual(lens ? ruler(x, LAST - y) : turned(x, LAST - y));
      expect(at(second, x, y), `turned then ruler, ${x}, ${y}`).toEqual(lens ? turned(x, LAST - y) : ruler(x, LAST - y));
    }
  }, 120_000);

  it("a texture that changes every frame is read in the frame it changes: frame N shows frame N's picture", async () => {
    /* The ruler's blue byte is ten times the frame number: a webcam's picture, a movie's. */
    const live = { shape: "quad" as const, source: READS_LENS, wires: ["ruler" as const], ruler: { phase: expressionSlot("absframe * 10", 0) } };
    const captured = [0, 1, 2, 5];
    const shown = await frames(live, { frames: 6, capture: captured });
    expect(shown).toHaveLength(4);
    captured.forEach((frame, index) => {
      for (const [x, y] of [[0, 0], [17, 40], [63, 63]] as const) expect(at(shown[index]!, x, y), `frame ${frame}, pixel ${x}, ${y}`).toEqual(ruler(x, LAST - y, frame * 10));
    });
  }, 120_000);

  it("the Albedo output, a layer drawn on its own, reads the texture too", async () => {
    const layer = await picture({ shape: "quad", source: READS_LENS, wires: ["ruler"], render: { albedoOutput: true } }, { port: "albedo" });
    for (const [x, y] of [[0, 63], [10, 20], [63, 0]] as const) expect(at(layer, x, y), `pixel ${x}, ${y}`).toEqual(ruler(x, LAST - y));
  }, 120_000);

  it("lit, under a casting light with every layer on, each draw binds it: the Normal, Albedo and Shadow outputs all render", async () => {
    const scene = { shape: "quad" as const, source: READS_LENS, material: { model: "pbr" }, wires: ["ruler" as const], lights: "light_sun", render: { normalOutput: true, albedoOutput: true, shadowOutput: true } };
    for (const port of ["out", "normal", "albedo", "shadow"]) expect((await picture(scene, { port })).length, port).toBe(SIZE * SIZE * 4);
    expect(at(await picture(scene, { port: "albedo" }), 10, 20)).toEqual(ruler(10, 43));
  }, 240_000);
});

describe("T1658b: the shared module `map` reads by a coordinate", () => {
  const head = "// @use map\n// @texture lens";
  const quad = (expression: string): TextureScene => ({ shape: "quad", source: showing(head, expression), wires: ["ruler"] });

  it("mapLinear weighs the four texels round the coordinate: a quarter of a texel across and half a texel up", async () => {
    /* At a pixel's centre the coordinate is a texel's centre and the read is that texel. A
       quarter of a texel further across it is ¾ of this texel and ¼ of the next: 4x + 1.
       Half a texel up it is half of each: 4y + 2. At the far edges Hold has no next texel. */
    const exact = await picture(quad("mapLinear(lens, s.uv, vec2u(MAP_HOLD))"));
    const moved = await picture(quad("mapLinear(lens, s.uv + vec2f(0.25, 0.5) / 64.0, vec2u(MAP_HOLD))"));
    for (let y = 0; y < SIZE; y += 7) {
      for (let x = 0; x < SIZE; x += 1) {
        const row = LAST - y;
        expect(at(exact, x, y), `at the centre, ${x}, ${y}`).toEqual(ruler(x, row));
        expect(at(moved, x, y), `moved, ${x}, ${y}`).toEqual([4 * x + (x < LAST ? 1 : 0), 4 * row + (row < LAST ? 2 : 0), 0]);
      }
    }
  }, 120_000);

  it("Repeat and Mirror fold each axis: the coordinate doubled and moved, across repeated and along mirrored", async () => {
    /* u runs −0.496 to 1.473 and v the same: outside 0..1 on both sides. A quarter of a texel
       off the texel edges, so no pixel sits on one. */
    const bytes = await picture(quad("mapNearest(lens, s.uv * 2.0 - vec2f(0.5 - 0.25 / 64.0), vec2u(MAP_REPEAT, MAP_MIRROR))"));
    const held = await picture(quad("mapNearest(lens, s.uv * 2.0 - vec2f(0.5 - 0.25 / 64.0), vec2u(MAP_HOLD))"));
    const repeat = (c: number): number => Math.min(Math.floor((c - Math.floor(c)) * SIZE), LAST);
    const mirror = (c: number): number => Math.min(Math.floor((1 - Math.abs(1 - (c - 2 * Math.floor(c / 2)))) * SIZE), LAST);
    const hold = (c: number): number => Math.min(Math.floor(Math.min(Math.max(c, 0), 1) * SIZE), LAST);
    for (let y = 0; y < SIZE; y += 3) {
      for (let x = 0; x < SIZE; x += 3) {
        const u = ((x + 0.5) / SIZE) * 2 - (0.5 - 0.25 / SIZE);
        const v = (1 - (y + 0.5) / SIZE) * 2 - (0.5 - 0.25 / SIZE);
        expect(at(bytes, x, y), `repeat and mirror, ${x}, ${y}`).toEqual(ruler(repeat(u), mirror(v)));
        expect(at(held, x, y), `held, ${x}, ${y}`).toEqual(ruler(hold(u), hold(v)));
      }
    }
    // Both folds are exercised: a pixel left of 0 reads the map's far side, one above 1 reads back down.
    expect(at(bytes, 3, 60)[0]).toBeGreaterThan(128);
    expect(at(held, 3, 60)[0]).toBe(0);
  }, 120_000);

  it("mapLinear across a tile's edge blends with the texel that is really next: the first under Repeat, itself under Mirror and Hold", async () => {
    const edge = async (extend: string): Promise<number> => at(await picture(quad(`mapLinear(lens, s.uv + vec2f(0.25, 0.0) / 64.0, vec2u(${extend}, MAP_HOLD))`)), LAST, 30)[0]!;
    // The last column is texel 63 (252). A quarter on is ¾ of it and ¼ of the next one.
    expect(await edge("MAP_REPEAT")).toBe(189);
    expect(await edge("MAP_MIRROR")).toBe(252);
    expect(await edge("MAP_HOLD")).toBe(252);
  }, 120_000);

  it("the name is a plain texture: textureLoad and textureDimensions read it by texel", async () => {
    const bytes = await picture(quad("textureLoad(lens, vec2i(vec2f(textureDimensions(lens)) * vec2f(s.uv.y, s.uv.x)), 0)"));
    for (const [x, y] of [[0, 63], [10, 20], [50, 7]] as const) expect(at(bytes, x, y), `pixel ${x}, ${y}`).toEqual(ruler(LAST - y, x));
  }, 120_000);
});

describe("T1658b: on a mesh, and on mesh instances", () => {
  /* The hull-and-lens mesh under a camera four units tall: sixteen pixels a unit. The hull
     cube's front face is columns 24 to 39 and rows 24 to 39; the lens cube's, a unit and a
     half to its right, columns 48 to 63. A face carries 0 to 1 in `uv`, so a pixel of a face
     is four texels wide and reads the third of them: 4j + 2. */
  const face = (x: number, y: number, left: number): readonly [number, number] => [4 * (x - left) + 2, 4 * (39 - y) + 2];
  const wide = { orthoHeight: 4 };

  it("a mesh Surface reads its texture at the file's own uv, on both cubes", async () => {
    const bytes = await picture({ shape: "mesh", source: showing("// @use map\n// @texture lens", "mapNearest(lens, s.uv, vec2u(MAP_HOLD))"), wires: ["ruler"], camera: wide });
    for (const [x, y] of [[24, 39], [30, 30], [39, 24]] as const) expect(at(bytes, x, y), `hull ${x}, ${y}`).toEqual(ruler(...face(x, y, 24)));
    for (const [x, y] of [[48, 39], [55, 31], [63, 24]] as const) expect(at(bytes, x, y), `lens ${x}, ${y}`).toEqual(ruler(...face(x, y, 48)));
    // Between and round them: the background.
    expect(at(bytes, 44, 31)).toEqual([0, 0, 0]);
    expect(at(bytes, 30, 10)).toEqual([0, 0, 0]);
  }, 120_000);

  /**
   * THE CONSUMER'S SHAPE (the owner's ask: a picture "projected onto the robots' eye
   * lenses", mixed by an opacity). One mesh; the lens is a ROLE its vertices carry (the part
   * a `loom_part` node gives them, `s.attr.w`); the picture shows only there, mixed with the
   * hull's own colour by a parameter.
   */
  const LENS = showing(
    "// @use map\n// @texture picture",
    "mix(vec4f(60.0, 60.0, 60.0, 255.0) / 255.0, mapNearest(picture, s.uv, vec2u(MAP_HOLD)), step(0.5, s.attr.w) * p.opacity)",
    "struct Params {\n  opacity: f32, // @default 1  How much of the picture the lens shows.\n};",
  );
  const hull = (opacity: number, phase: unknown = 100): TextureScene => ({ shape: "mesh", source: LENS, material: { opacity }, wires: ["ruler"], ruler: { phase }, camera: wide });

  it("the consumer's shape: the picture shows only where the role says, and the parameter mixes it", async () => {
    const full = await picture(hull(1));
    const half = await picture(hull(0.5));
    const none = await picture(hull(0));
    for (const [x, y] of [[48, 39], [55, 31], [63, 24]] as const) {
      const [red, green] = face(x, y, 48);
      expect(at(full, x, y), `lens, all of it, ${x}, ${y}`).toEqual([4 * red, 4 * green, 100]);
      // Half of the hull's 60 and half of the picture, a whole byte each.
      expect(at(half, x, y), `lens, half, ${x}, ${y}`).toEqual([30 + 2 * red, 30 + 2 * green, 80]);
      expect(at(none, x, y), `lens, none, ${x}, ${y}`).toEqual([60, 60, 60]);
    }
    // The hull is its own colour whatever the parameter says.
    for (const bytes of [full, half, none]) for (const [x, y] of [[24, 39], [30, 30], [39, 24]] as const) expect(at(bytes, x, y), `hull ${x}, ${y}`).toEqual([60, 60, 60]);
  }, 240_000);

  it("the consumer's test: when the fed picture changes a lens pixel changes with it, and no pixel of the hull does", async () => {
    const [before, after] = await frames(hull(1, expressionSlot("absframe * 40", 0)), { frames: 4, capture: [0, 3] });
    let lens = 0;
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const a = at(before!, x, y);
        const b = at(after!, x, y);
        if (x >= 48 && y >= 24 && y < 40) {
          // The lens's front face: the picture's blue went from 0 to 120, its red and green stayed.
          expect([b[0], b[1], b[2]! - a[2]!], `lens ${x}, ${y}`).toEqual([a[0], a[1], 120]);
          lens += 1;
        } else {
          expect(b, `not the lens, ${x}, ${y}`).toEqual(a);
        }
      }
    }
    expect(lens).toBe(16 * 16);
  }, 120_000);

  it("mesh instances: one texture, and each instance shows its own quarter of it by its slot", async () => {
    /* Three instances of the hull cube at half size, 0.625 apart, under the two-unit camera:
       sixteen pixels each, their front faces at columns 4, 24 and 44 and rows 24 to 39. The
       coordinate is the face's own, moved along by the instance's slot and divided by four,
       so pixel j of instance i is the centre of texel 16i + j. */
    const PER_INSTANCE = showing("// @use map\n// @texture lens", "mapNearest(lens, (s.uv + vec2f(f32(s.instanceId), 0.0)) / vec2f(4.0, 1.0), vec2u(MAP_HOLD))");
    const bytes = await picture({ shape: "instances", source: PER_INSTANCE, wires: ["ruler"] });
    for (const [instance, left] of [[0, 4], [1, 24], [2, 44]] as const) {
      for (const j of [0, 5, 15]) {
        for (const y of [24, 31, 39]) expect(at(bytes, left + j, y), `instance ${instance}, pixel ${j}, row ${y}`).toEqual(ruler(16 * instance + j, 4 * (39 - y) + 2));
      }
    }
    // Between two instances: the background.
    expect(at(bytes, 22, 31)).toEqual([0, 0, 0]);
    expect(at(bytes, 42, 31)).toEqual([0, 0, 0]);
  }, 120_000);

  it("mesh instances with the wire cut are refused by the same sentence", async () => {
    const said = await refusal({ shape: "instances", source: showing("// @use map\n// @texture lens", "mapNearest(lens, s.uv, vec2u(MAP_HOLD))"), wires: [] });
    expect(said).toContain('the source names texture "lens" (Texture 1) and nothing is wired into Texture 1.');
  }, 120_000);
});

/**
 * THE FIRST THING ANYONE WIRES INTO A MATERIAL IS LIVE MEDIA THAT MAY NOT BE THERE: a Webcam
 * on a machine with no camera, a Movie File In whose file is not picked. The material's
 * contract is "wired means there is a texture", so the media node has to hand a picture on
 * whatever the host has. It does, and these hold what it hands on, on the two hosts a
 * document meets:
 *
 *  - A host that registers NO source for the node. That is the app after a camera is
 *    refused, or before a first frame (`use-media-sources.test.tsx`: "reports a refused
 *    camera and registers nothing"; what it says is `media.unavailable`, class
 *    `elsewhereHost`), and any process that drives the backend itself. The node's texture is
 *    TRANSPARENT BLACK, every byte zero.
 *  - A headless render (`renderHeadless`), which stands a moving TEST CARD in for every
 *    media node (`syntheticMediaFrame`, T650) and says nothing: a `strict` render goes
 *    through.
 *
 * Neither needs the document edited, and neither is an error.
 */
describe("T1658b: a material fed by live media that is not there still has a texture", () => {
  /** The picture mixed over the surface's own grey by a parameter, as the consumer's lens does. */
  const MIXED = showing(
    "// @use map\n// @texture picture",
    "mix(vec4f(60.0, 60.0, 60.0, 255.0) / 255.0, mapNearest(picture, s.uv, vec2u(MAP_HOLD)), p.opacity)",
    "struct Params {\n  opacity: f32, // @default 1  How much of the picture shows.\n};",
  );

  /** One frame through the backend with NO media source registered: the Render's picture, and the media node's own. */
  async function unfed(wire: "webcam" | "movie", opacity: number): Promise<{ surface: Uint8Array; media: Uint8Array; said: string[] }> {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const plan = compileGraph({
      graph: textureScene({ shape: "quad", source: MIXED, material: { opacity }, wires: [wire] }),
      settings: TEXTURE_SETTINGS,
      registry: createNodeRegistry(allNodeDefinitions).view(),
      capabilities: TIER_B_CAPABILITIES,
      sinks: [SHOT, PRODUCER[wire]].map((nodeId) => ({ nodeId, portId: "out", kind: "preview" as const })),
    } as never);
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const said: string[] = plan.diagnostics.map((entry) => `${entry.severity} ${entry.code}`);
    backend.onDiagnostic((entry) => said.push(`${entry.severity} ${entry.code}`));
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      for (const frameIndex of [0, 1]) {
        backend.render(compiled, { frame: frameFromClock({ timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7, fps: 60 }), pointer: { x: 0, y: 0, buttons: 0 }, resolution: [SIZE, SIZE] });
      }
      const resource = (nodeId: string): string => plan.outputs.find((output) => output.nodeId === nodeId && output.portId === "out")!.resourceId;
      return { surface: (await backend.readOutput(resource(SHOT))).bytes, media: (await backend.readOutput(resource(PRODUCER[wire]))).bytes, said: said.filter((entry) => !entry.startsWith("info")) };
    } finally {
      backend.dispose();
    }
  }

  for (const wire of ["webcam", "movie"] as const) {
    it(`a ${wire === "webcam" ? "Webcam with no camera" : "Movie File In with no file"}, nothing registered for it: transparent black, mixed as the parameter says, and no error`, async () => {
      const shown = await unfed(wire, 1);
      // The media node's own picture: every byte zero.
      expect(shown.media.length).toBeGreaterThan(0);
      expect(shown.media.every((byte) => byte === 0)).toBe(true);
      expect(shown.said.filter((entry) => entry.startsWith("error"))).toEqual([]);
      // The surface: all of the picture is black; half of it is half the surface's own 60; none of it is 60.
      for (const [opacity, grey] of [[1, 0], [0.5, 30], [0, 60]] as const) {
        const { surface } = opacity === 1 ? shown : await unfed(wire, opacity);
        for (const [x, y] of [[0, 0], [31, 17], [63, 63]] as const) expect(at(surface, x, y), `opacity ${opacity}, pixel ${x}, ${y}`).toEqual([grey, grey, grey]);
      }
    }, 240_000);

    it(`the same document in a strict headless render: the test card stands in, and the surface shows it`, async () => {
      const scene = (opacity: number): TextureScene => ({ shape: "quad", source: MIXED, material: { opacity }, wires: [wire] });
      const [first, later] = await frames(scene(1), { frames: 6, capture: [0, 5], strict: true });
      /* The card is drawn for the node's own source, at the frame: display-encoded bytes the
         node decodes to the working space. A saturated bar's 236 is 0.84 linear, byte 214;
         its 32 is byte 4. So the surface is the card, texel for pixel, and it moves. */
      const linear = (byte: number): number => {
        const c = byte / 255;
        return Math.round((c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)) * 255);
      };
      for (const [frame, bytes] of [[0, first!], [5, later!]] as const) {
        const card = syntheticMediaFrame(`media:${PRODUCER[wire]}`, [SIZE, SIZE], frame);
        let checked = 0;
        for (let y = 0; y < SIZE; y += 5) {
          for (let x = 2; x < SIZE; x += 5) {
            const texel = ((LAST - y) * SIZE + x) * 4;
            const expected = [linear(card[texel]!), linear(card[texel + 1]!), linear(card[texel + 2]!)];
            expect(at(bytes, x, y), `frame ${frame}, pixel ${x}, ${y}`).toEqual(expected);
            checked += 1;
          }
        }
        expect(checked).toBeGreaterThan(100);
      }
      expect(Buffer.compare(first!, later!)).not.toBe(0);
      // And the parameter mixes it: none of the picture is the surface's own grey, everywhere.
      const none = await picture(scene(0), { strict: true });
      for (const [x, y] of [[0, 0], [31, 17], [63, 63]] as const) expect(at(none, x, y)).toEqual([60, 60, 60]);
    }, 240_000);
  }
});

