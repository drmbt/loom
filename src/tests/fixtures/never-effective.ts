import { loadProject } from "../../domain/project/index.ts";
import { serializeProjectDocument } from "../../domain/project/serialize.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { document, edge, graph, named, settings } from "../../examples/documents/builders.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * §T1641b — §B262'S DOCUMENT, BUILT THE WAY IT SHIPPED: by code, never through the bus.
 *
 * The bus has always refused `pow(x, 2)` (`graph.applyPatch` validates what it writes). The
 * three lamps of §B262 were object literals handed to the save path, which checks nothing,
 * so the tests that hold the rule build their document the same way: the builders, then
 * `serializeProjectDocument`, then `loadProject` on the bytes. A document assembled by
 * patches would prove the door that was never open.
 *
 * A white Solid through a Level into the Output: `brightness` is the lamp. 8×8 and
 * rgba8unorm with no display transform, so a readback is the bytes the target holds.
 */

export const LAMP = "level_lamp";
export const LAMP_OUTPUT = "output_out";

export const NEVER_EFFECTIVE_REGISTRY = createNodeRegistry(allNodeDefinitions).view();

/** A bind slot: `ref` in effect, `retained` what §V108 keeps. */
export function boundTo(ref: string, retained: number): StoredParameter {
  return { mode: "bind", bindings: { static: { kind: "static", value: retained }, bind: { kind: "bind", ref } } };
}

/**
 * The saved bytes of the lamp document: `brightness` as given, any other nodes, and any
 * other parameters of the lamp.
 */
export function lampFile(
  brightness: StoredParameter,
  others: readonly GraphNode[] = [],
  also: Readonly<Record<string, StoredParameter>> = {},
): string {
  const white = named("white", "solid", [0, 0], { color: [1, 1, 1, 1] });
  const lamp = named("lamp", "level", [300, 0], {}, { parameters: { brightness, ...also } });
  const out = named("out", "output", [600, 0]);
  return serializeProjectDocument(
    document(
      "t1641b-lamp",
      "T1641b lamp",
      settings({
        outputResolution: { width: 8, height: 8 },
        workingFormat: "rgba8unorm",
        colorPolicy: { workingSpace: "linear", displayTransform: "none" },
        previewLongEdge: 8,
        randomSeed: 1,
      }),
      graph(
        [white, lamp, out, ...others],
        [edge("e_white", [white.id, "out"], [lamp.id, "input"]), edge("e_lamp", [lamp.id, "out"], [out.id, "input"])],
      ),
    ),
  );
}

/** The bytes through the real load: what a render script holds before it renders. */
export function openedFile(text: string): { readonly graph: GraphDocument; readonly settings: ProjectSettings } {
  const loaded = loadProject(text, { nodes: NEVER_EFFECTIVE_REGISTRY });
  if (!loaded.ok) throw new Error(`the document did not load: ${loaded.reason}`);
  return { graph: loaded.document.graph, settings: loaded.document.settings };
}
export const openedLamp = openedFile;

/**
 * §B264'S DOCUMENT: a Custom WGSL whose `struct Params` declares `eyeColor: vec3f` and
 * `eyesAt: vec3f`. A vec3f whose NAME reads as a colour is a colour parameter, so its parts
 * are r, g, b; the one beside it is a vector, with parts x, y, z. The shipped file drove
 * `eyeColor.x`, `.y` and `.z`, which are keys of nothing, and the light stayed red for a day
 * while `eyesAt.x` beside it worked.
 *
 * White Solid through the shader into the Output: the picture is `eyeColor + eyesAt`.
 */
export const HAZE = "wgsl_haze";
export const HAZE_OUTPUT = "output_out";

export const HAZE_SHADER = `${SHARED_UNIFORMS_WGSL}
struct Params {
  eyeColor: vec3f,
  eyesAt: vec3f,
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  return vec4f(color.rgb * params.eyeColor + params.eyesAt, color.a);
}`;

/** The saved bytes of the haze document: the shader, and whatever is stored beside it. */
export function hazeFile(stored: Readonly<Record<string, StoredParameter>>, source: string = HAZE_SHADER): string {
  const white = named("white", "solid", [0, 0], { color: [1, 1, 1, 1] });
  const haze = named("haze", "customWgsl", [300, 0], {}, { parameters: { source, ...stored } });
  const out = named("out", "output", [600, 0]);
  return serializeProjectDocument(
    document(
      "t1641b-haze",
      "T1641b haze",
      settings({
        outputResolution: { width: 8, height: 8 },
        workingFormat: "rgba8unorm",
        colorPolicy: { workingSpace: "linear", displayTransform: "none" },
        previewLongEdge: 8,
        randomSeed: 1,
      }),
      graph(
        [white, haze, out],
        [edge("e_white", [white.id, "out"], [haze.id, "input"]), edge("e_haze", [haze.id, "out"], [out.id, "input"])],
      ),
    ),
  );
}
