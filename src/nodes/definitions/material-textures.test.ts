import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { hasError } from "../../compiler/diagnostics.ts";
import { diagnosticClass, leavesPlanUsable, stopsFinalRender } from "../../domain/diagnostics/classes.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { SHARED_WGSL_MODULES, resolveSharedModules } from "../shaders/shared-modules.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { MATERIAL, PLAIN_SOURCE, SHOT, TEXTURE_SETTINGS, textureScene, type TextureScene } from "./material-textures.fixture.ts";
import { materialWgslNode, reflectTextureNames } from "./material-wgsl.ts";
import { planFingerprint } from "./test-support.ts";

/**
 * T1658b at the plan level — WHAT A MATERIAL · WGSL'S TEXTURE INPUTS PUT IN A RENDER'S
 * DRAWS, and that a material which names no texture is the program it was.
 *
 * What a texture reads back as is asserted on Dawn in
 * `runtime/backend/vgpu/material-textures.gpu.test.ts`.
 */

type Pass = { id: string; kind: string; nodeId?: string; shader?: string; textures?: Array<{ binding: string; resourceId: string }>; buffers?: Array<{ binding: string }> };

const registry = createNodeRegistry(allNodeDefinitions).view();
const OUTPUTS = { normalOutput: true, albedoOutput: true, shadowOutput: true };
const PORTS = ["normal", "albedo", "shadow"];

function compiled(graph: GraphDocument, ports: ReadonlyArray<string> = PORTS) {
  return compileGraph({
    graph,
    settings: TEXTURE_SETTINGS,
    registry,
    capabilities: TIER_B_CAPABILITIES,
    sinks: ports.map((portId) => ({ nodeId: SHOT, portId, kind: "preview" as const })),
  } as never);
}
const errorsOf = (plan: ReturnType<typeof compiled>): string[] => plan.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message);
/** The Render's draws of the Geometry: the lit draw and its layers, each running the author's `surface()`. */
const surfaceDraws = (plan: ReturnType<typeof compiled>): Pass[] =>
  (plan.passes as unknown as Pass[]).filter((pass) => pass.kind === "draw" && pass.nodeId === SHOT && String(pass.shader ?? "").includes("fn surface("));

/** A casting sun and three layers, so the lit draw, the Normal and Albedo layers and the shadow matte are all in the plan. */
const full = (scene: TextureScene): GraphDocument => textureScene({ lights: "light_sun", ...scene, render: { ...OUTPUTS, ...scene.render } });

/**
 * A MATERIAL · WGSL THAT NAMES NO TEXTURE, pinned by the Render's whole plan (every pass's
 * id, text, bindings and uniforms), on each draw that can wear one. Taken on 2026-10-06 at
 * `b194894a`, BEFORE the node had an input or the generator a texture: the promise is that
 * such a material compiles to the text it had (§V309).
 *
 * RE-TAKEN ONCE, at `ddc9a1fc` (§T1623b slice 4): the sun's shadow sweep draws into a layer
 * of the Render's layered target and the bindings name that layer, so the plan's shape
 * moved (they were `1b9f9d47c300ad8e`, `9dc86227c139b818`, `5dd360d1008ce7fc`). Every
 * pass's TEXT was measured the same on both sides of that commit, for all three shapes.
 */
const UNTEXTURED: ReadonlyArray<readonly [shape: TextureScene["shape"], fingerprint: string]> = [
  ["quad", "587b29c3e464c2b3"],
  ["mesh", "fb6ba5abec0c52ca"],
  ["instances", "3e046c5b19915366"],
];

describe("T1658b: a Material · WGSL that names no texture is the program it was", () => {
  for (const [shape, fingerprint] of UNTEXTURED) {
    it(`${shape}: the lit draw, the Normal and Albedo layers and the shadow matte`, () => {
      const plan = compiled(full({ shape, source: PLAIN_SOURCE }));
      expect(errorsOf(plan)).toEqual([]);
      // The claim is about a path that runs: four draws of the Geometry carry the author's code.
      expect(surfaceDraws(plan).map((pass) => pass.id.replace(/^.*render_shot:/, "").replace(/:\d+$/, ""))).toEqual(["scene", "gbuffer", "gbuffer:albedo", "gbuffer:shadow"]);
      expect(planFingerprint({ passes: plan.passes.filter((pass) => (pass as { nodeId?: string }).nodeId === SHOT) })).toBe(fingerprint);
    });
  }
});

/** A source that names textures and reads the first. */
const reading = (...names: string[]): string => `// @use map
${names.map((name) => `// @texture ${name}`).join("\n")}
fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.albedo = mapNearest(${names[0]}, s.uv, vec2u(MAP_HOLD));
  return o;
}`;
const findings = (plan: ReturnType<typeof compiled>, code: string) => plan.diagnostics.filter((entry) => entry.code === code);

describe("T1658b: a texture the source names is declared above the code and bound in every draw that runs it", () => {
  for (const shape of ["quad", "mesh", "instances"] as const) {
    it(`${shape}: the lit draw and its three layers each declare the two names and bind the two wires, in the order named`, () => {
      const plan = compiled(full({ shape, source: reading("lens", "grain"), wires: ["ruler", "turned"] }));
      expect(errorsOf(plan)).toEqual([]);
      const draws = surfaceDraws(plan);
      expect(draws).toHaveLength(4);
      for (const draw of draws) {
        const text = String(draw.shader);
        expect(text.match(/@group\(0\) @binding\(110\) var lens: texture_2d<f32>;\n@group\(0\) @binding\(111\) var grain: texture_2d<f32>;\n/g), draw.id).toHaveLength(1);
        const bound = Object.fromEntries((draw.textures ?? []).map((texture) => [texture.binding, texture.resourceId]));
        expect([draw.id, bound["lens"], bound["grain"]]).toEqual([draw.id, "target:wgsl_ruler:out", "target:wgsl_turned:out"]);
      }
      // The wires exchanged: the names stay, what they are bound to follows the inputs.
      const exchanged = surfaceDraws(compiled(full({ shape, source: reading("lens", "grain"), wires: ["turned", "ruler"] })));
      expect(exchanged.map((draw) => (draw.textures ?? []).find((texture) => texture.binding === "lens")?.resourceId)).toEqual(Array(4).fill("target:wgsl_turned:out"));
      expect(exchanged.map((draw) => String(draw.shader))).toEqual(draws.map((draw) => String(draw.shader)));
    });
  }

  it("a depth sweep runs no surface code and binds none of it", () => {
    const plan = compiled(full({ shape: "quad", source: reading("lens"), wires: ["ruler"] }));
    const sweeps = (plan.passes as unknown as Pass[]).filter((pass) => pass.kind === "draw" && pass.nodeId === SHOT && !String(pass.shader ?? "").includes("fn surface("));
    expect(sweeps.length).toBeGreaterThan(0);
    for (const sweep of sweeps) {
      expect(String(sweep.shader)).not.toContain("var lens");
      expect((sweep.textures ?? []).map((texture) => texture.binding)).not.toContain("lens");
    }
  });

  it("the node has four optional texture inputs, and a source's names are read off its `// @texture` lines", () => {
    expect(materialWgslNode.inputs.map((input) => [input.id, input.label, input.optional, input.variadic])).toEqual([
      ["texture1", "Texture 1", true, undefined],
      ["texture2", "Texture 2", true, undefined],
      ["texture3", "Texture 3", true, undefined],
      ["texture4", "Texture 4", true, undefined],
    ]);
    expect(reflectTextureNames("// @texture lens\n  //   @texture   grain  \nfn surface() {}\n// @textures no\nlet x = 1; // @texture inline")).toEqual(["lens", "grain"]);
    expect(reflectTextureNames(PLAIN_SOURCE)).toEqual([]);
  });

  it("`// @use map` is one text, reads by `extend`'s folds, and is the same module a Custom WGSL gets", () => {
    const resolved = resolveSharedModules("// @use map\n");
    expect(resolved.missing).toEqual([]);
    expect(resolved.prelude).toContain(SHARED_WGSL_MODULES["extend"]!.source);
    expect(resolved.prelude).toContain(SHARED_WGSL_MODULES["map"]!.source);
    expect(resolved.prelude.indexOf("fn extendRepeat")).toBeLessThan(resolved.prelude.indexOf("fn mapFold"));
    expect(SHARED_WGSL_MODULES["map"]!.source).not.toContain("textureSample");
  });
});

describe("T1658b: what cannot be a texture, or is not wired, is said by name", () => {
  const refused = (source: string, wires: TextureScene["wires"] = ["ruler", "ruler", "ruler", "ruler"]) => {
    const plan = compiled(full({ shape: "quad", source, wires }));
    return plan.diagnostics.filter((entry) => entry.severity === "error").map((entry) => [entry.code, entry.message.replace(`Node "${MATERIAL}": `, ""), entry.suggestion ?? ""]);
  };

  it("a line that names no texture", () => {
    expect(refused(reading("lens").replace("// @texture lens", "// @texture my lens"))).toEqual([
      ["node.materialWgsl.texture", "`// @texture my lens` does not name a texture: a name is letters, digits and underscores, one a line.", "Write `// @texture lens`, and one line for each texture."],
    ]);
    expect(refused(reading("lens").replace("// @texture lens", "// @texture"))[0]![1]).toBe("`// @texture ` does not name a texture: a name is letters, digits and underscores, one a line.");
    expect(refused(reading("lens").replace("// @texture lens", "// @texture 2nd"))[0]![0]).toBe("node.materialWgsl.texture");
  });

  it("a name twice, and a name the shader already has", () => {
    expect(refused(reading("lens", "lens"))).toEqual([["node.materialWgsl.texture", 'the source names texture "lens" twice.', "Name each texture once; read it as often as the code needs."]]);
    // The generator's bindings and functions, a numbered family, a shared module's function, the author's own.
    for (const taken of ["params", "positions", "frameU", "surface", "surfaceDefaults", "shadowMap7", "projectorCookie2", "mapLinear", "extendRepeat"]) {
      expect(refused(`// @use map\n// @texture ${taken}\n${PLAIN_SOURCE}`), taken).toEqual([
        ["node.materialWgsl.texture", `texture "${taken}" has the name of something this shader already declares.`, `Give the texture another name, such as "${taken}Map".`],
      ]);
    }
    expect(refused(`// @texture helper\nfn helper() -> f32 { return 1.0; }\n${PLAIN_SOURCE}`)[0]![1]).toBe('texture "helper" has the name of something this shader already declares.');
  });

  it("a fifth texture, with the count", () => {
    expect(refused(reading("a", "b", "c", "d", "e"))).toEqual([
      [
        "node.materialWgsl.texture",
        "the source names 5 textures (a, b, c, d, e) and a Material · WGSL reads up to 4.",
        "Remove one, or pack two pictures into one texture upstream (a Composite side by side, read by halves of the coordinate).",
      ],
    ]);
    // Four is the count: all four declared and bound.
    const four = compiled(full({ shape: "quad", source: reading("a", "b", "c", "d"), wires: ["ruler", "turned", "ruler", "turned"] }));
    expect(errorsOf(four)).toEqual([]);
    expect(String(surfaceDraws(four)[0]!.shader)).toContain("@group(0) @binding(113) var d: texture_2d<f32>;");
  });

  it("a named texture with nothing wired: an error that names it and its input, waiting for the wire", () => {
    expect(refused(reading("lens"), [])).toEqual([
      ["node.materialWgsl.textureUnwired", 'the source names texture "lens" (Texture 1) and nothing is wired into Texture 1.', "Wire a texture into Texture 1, or remove the `// @texture lens` line."],
    ]);
    // The second of two, the first wired: its own input is named.
    expect(refused(reading("lens", "grain"), ["ruler"])).toEqual([
      ["node.materialWgsl.textureUnwired", 'the source names texture "grain" (Texture 2) and nothing is wired into Texture 2.', "Wire a texture into Texture 2, or remove the `// @texture grain` line."],
    ]);
    // A wire in the WRONG input is not the texture: Texture 2 wired, Texture 1 named.
    expect(refused(reading("lens"), [undefined, "ruler"]).map((entry) => entry[0])).toEqual(["node.materialWgsl.textureUnwired"]);
    // Its class: it takes effect the moment a wire arrives; an error, so the plan is withdrawn and a final render stops.
    expect(diagnosticClass("node.materialWgsl.textureUnwired")).toBe("notYet");
    expect(leavesPlanUsable("node.materialWgsl.textureUnwired")).toBe(false);
    expect(stopsFinalRender({ severity: "error", code: "node.materialWgsl.textureUnwired" })).toBe(true);
    expect(diagnosticClass("node.materialWgsl.texture")).toBe("never");
  });

  it("a wire into an input no line names: said by name, and the material still draws", () => {
    const plan = compiled(full({ shape: "quad", source: reading("lens"), wires: ["ruler", undefined, "turned"] }));
    expect(errorsOf(plan)).toEqual([]);
    expect(findings(plan, "node.materialWgsl.textureUnread").map((entry) => [entry.severity, entry.message, entry.suggestion])).toEqual([
      [
        "warning",
        `Node "${MATERIAL}": Texture 3 is wired and the source names 1 texture (lens): it is not read.`,
        "Add a `// @texture <name>` line to the source (the third one is Texture 3), or remove the wire.",
      ],
    ]);
    expect(hasError(plan.diagnostics)).toBe(false);
    expect(surfaceDraws(plan)).toHaveLength(4);
    expect((surfaceDraws(plan)[0]!.textures ?? []).map((texture) => texture.resourceId)).not.toContain("target:wgsl_turned:out");
    // A source that names none, with a wire: the same sentence, and the text it always had.
    const plain = compiled(full({ shape: "quad", source: PLAIN_SOURCE, wires: ["ruler"] }));
    expect(findings(plain, "node.materialWgsl.textureUnread").map((entry) => entry.message)).toEqual([`Node "${MATERIAL}": Texture 1 is wired and the source names no texture: it is not read.`]);
    expect(surfaceDraws(plain).map((draw) => String(draw.shader))).toEqual(surfaceDraws(compiled(full({ shape: "quad", source: PLAIN_SOURCE }))).map((draw) => String(draw.shader)));
    // Its class: nothing reads it, the rest is whole, and a final render stops on it.
    expect([diagnosticClass("node.materialWgsl.textureUnread"), leavesPlanUsable("node.materialWgsl.textureUnread")]).toEqual(["never", true]);
    expect(stopsFinalRender({ severity: "warning", code: "node.materialWgsl.textureUnread" })).toBe(true);
  });
});

describe("T1658b: the sixteen sampled textures of a stage", () => {
  const crowded = (casting: number) =>
    compiled(
      textureScene({
        shape: "quad",
        source: reading("a", "b", "c", "d"),
        material: { model: "pbr" },
        wires: ["ruler", "turned", "ruler", "turned"],
        casting,
        lights: ["light_sun", ...Array.from({ length: casting }, (_, index) => `light_cast_${index}`)].join(" "),
      }),
      [],
    );

  it("a draw that does not fit is said by the Render's ledger, the material's textures by their own name", () => {
    /* Four textures and thirteen casting lights: seventeen bindings in the lit draw. */
    const said = findings(crowded(12), "node.scene.textureBudget").map((entry) => entry.message);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("binds 17 sampled textures (4 Material · WGSL textures, 13 shadow maps)");
    // One light fewer fits: sixteen, and nothing is said.
    expect(findings(crowded(11), "node.scene.textureBudget")).toEqual([]);
  });
});

describe("T1658b: live media that is not there is a fact about the host, never about the document", () => {
  it("a Webcam or a Movie File In with no file wired into a texture compiles with nothing said, and binds the node's own target", () => {
    for (const wire of ["webcam", "movie"] as const) {
      const plan = compiled(textureScene({ shape: "quad", source: reading("lens"), wires: [wire] }), []);
      expect(plan.diagnostics.filter((entry) => entry.severity !== "info").map((entry) => `${entry.code}: ${entry.message}`), wire).toEqual([]);
      const bound = (surfaceDraws(plan)[0]!.textures ?? []).find((texture) => texture.binding === "lens")?.resourceId;
      expect(bound, wire).toBe(`target:${wire === "webcam" ? "webcam_live" : "movie_clip"}:out`);
    }
  });

  it("what the app says of a refused camera or a missing file is this host's, and a final render lets it through", () => {
    for (const code of ["media.unavailable", "media.connecting", "media.notLoaded", "asset.reference.missing"]) {
      expect([code, diagnosticClass(code)]).toEqual([code, "elsewhereHost"]);
      expect([code, stopsFinalRender({ severity: "warning", code })]).toEqual([code, false]);
    }
  });
});

