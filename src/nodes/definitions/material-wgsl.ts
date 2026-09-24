import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { MaterialPayload } from "../../domain/types/scene.ts";
import type { ParameterSchema } from "../../domain/types/parameters.ts";
import { SHADER_SOURCE_PARAMETER } from "../../domain/commands/apply-patch.ts";
import { codeParametersLast } from "../../domain/parameters/code.ts";
import { declaredNames, resolveSharedModules, SHARED_WGSL_MODULES } from "../shaders/shared-modules.ts";
import { SURFACE_RESERVED_NAMES } from "../shaders/scene-render.wgsl.ts";
import {
  extractParamsStruct,
  reflectParamsStruct,
  reflectedParamCollisions,
  reflectedParamSchema,
  reflectedUniforms,
  remember,
} from "./params-reflection.ts";
import { readCompileInputs } from "./compile-context.ts";
import { readColor, readNumber } from "./parameter-readers.ts";

/**
 * T1355b — MATERIAL · WGSL: a material whose SURFACE is code. TouchDesigner's GLSL MAT.
 *
 * The stock materials fix what a surface is (a colour, a roughness) and the Render fixes
 * how it is lit. This one hands the first half to the author: a `fn surface(s: SurfaceIn,
 * p: Params) -> SurfaceOut` that runs once per pixel of every surface wearing it, BEFORE
 * lighting, and returns the albedo, roughness, metallic, normal and emissive the chosen
 * lighting model then shades. Molten metal that flows, grime keyed to height and heat, a
 * scan band that glitches one material — all per pixel, all lit the same way as everything
 * else, none of it a post effect pretending to know where a surface is.
 *
 * THE CONTRACT the author writes against (the generator emits these; see
 * `sceneSurfaceWgsl`'s `custom` option):
 *   SurfaceIn  world, normal, uv, tint (vertex colour), attr (a mesh's surface row —
 *              roughness, metallic, heat, part), emissive (a mesh's own), eye, albedo,
 *              roughness, metallic (the base values, before this function), absTime.
 *   SurfaceOut albedo, roughness, metallic, normal, emissive.
 *   surfaceDefaults(s) → the SurfaceOut the stock material would have produced.
 *   `frameU` (SharedFrame) is readable for the other clocks.
 *
 * Knobs: the source's own `struct Params` is reflected into drivable controls exactly as
 * Custom WGSL and the point kernels reflect theirs (one reflector, §V349) — a uniform write,
 * never a rebuild (§V5). `// @use hash` / `grid` pull the shared modules in.
 *
 * SURFACE draws only in this build (grid or mesh). Instances, points and beams draw through
 * a different generator and refuse a WGSL material by name at the Render.
 */

export const MATERIAL_WGSL_DEFAULT_SOURCE = `// Runs once per pixel of every surface wearing this material, BEFORE lighting.
// s: what the surface is — world, normal, uv, tint, attr (a mesh's roughness, metallic,
//    heat, part), emissive, eye, albedo, roughness, metallic, absTime (seconds; keeps
//    counting across a timeline loop — frameU.time is the clock that laps).
// Return what it should be; the lighting model shades the result.
// surfaceDefaults(s) is what the stock material would have returned.
struct Params {
  heatGlow: f32, // @default 0  Emissive strength on hot surfaces (a mesh's heat, attr.z).
  heatColor: vec3f, // @default 1  Colour of that glow — white keeps the file's own emissive hue.
};

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.emissive = o.emissive + p.heatColor * s.attr.z * p.heatGlow;
  return o;
}`;

const MATERIAL_WGSL_PARAM_CODE = "node.materialWgsl.params";
const MATERIAL_WGSL_SOURCE_CODE = "node.materialWgsl.source";

/** The keys this node owns; reflection may not take them (T1059's rule). */
function ownParameters(): ParameterSchema {
  return materialWgslNode.parameters;
}

const schemasBySource = new Map<string, ParameterSchema>();

function reflectedSchema(source: string): ParameterSchema {
  const hit = schemasBySource.get(source);
  if (hit !== undefined) return hit;
  const own = ownParameters();
  return remember(
    schemasBySource,
    source,
    codeParametersLast({ ...own, ...reflectedParamSchema(reflectParamsStruct(source), new Set(Object.keys(own))) }),
  );
}

export const materialWgslNode: NodeDefinition = {
  type: "materialWgsl",
  version: 1,
  title: "Material · WGSL",
  category: "render",
  description:
    "A material whose surface is code: fn surface(s: SurfaceIn, p: Params) -> SurfaceOut runs per pixel before lighting and returns albedo, roughness, metallic, normal and emissive, which the chosen Model then lights. Color, Metallic and Roughness are the base values it receives. Its struct Params becomes drivable controls. Surface geometry only (grid or mesh).",
  tags: ["3d", "material", "wgsl", "shader", "custom", "glsl mat", "scene"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: { kind: "material", model: "custom" } }],
  parameters: codeParametersLast({
    model: {
      type: "enum",
      label: "Model",
      default: "pbr",
      options: [
        { value: "pbr", label: "PBR" },
        { value: "phong", label: "Phong" },
        { value: "lambert", label: "Lambert" },
        { value: "unlit", label: "Unlit" },
      ],
      compileTime: true,
      description: "How the surface this code returns is lit.",
    },
    color: { type: "color", label: "Base Color", default: [1, 1, 1, 1], space: "display" },
    metallic: { type: "number", label: "Metallic", default: 0, min: 0, max: 1, range: "bounded" },
    roughness: { type: "number", label: "Roughness", default: 0.5, min: 0, max: 1, range: "bounded" },
    [SHADER_SOURCE_PARAMETER]: {
      type: "code",
      language: "wgsl",
      label: "Source",
      default: MATERIAL_WGSL_DEFAULT_SOURCE,
      compileTime: true,
      description:
        "fn surface(s: SurfaceIn, p: Params) -> SurfaceOut, run per pixel before lighting. Its struct Params fields (with // @default and a describing comment) become this node's controls, read as p.<name>. `// @use hash` or `grid` pulls in shared helpers.",
    },
  }),
  parametersFor(stored) {
    const raw = stored[SHADER_SOURCE_PARAMETER];
    return reflectedSchema(typeof raw === "string" ? raw : MATERIAL_WGSL_DEFAULT_SOURCE);
  },
  compile(context): CompiledNodeDescription {
    const { nodeId, parameters } = readCompileInputs(context as Parameters<typeof readCompileInputs>[0]);
    const raw = parameters[SHADER_SOURCE_PARAMETER];
    const source = typeof raw === "string" ? raw : MATERIAL_WGSL_DEFAULT_SOURCE;
    const fields = reflectParamsStruct(source);
    const collisions = reflectedParamCollisions(nodeId, fields, new Set(Object.keys(ownParameters())), MATERIAL_WGSL_PARAM_CODE);
    if (collisions.length > 0) return { passes: [], diagnostics: collisions };

    const shared = resolveSharedModules(source);
    if (shared.missing.length > 0) {
      return {
        passes: [],
        diagnostics: shared.missing.map((name) => ({
          severity: "error" as const,
          code: MATERIAL_WGSL_SOURCE_CODE,
          message: `Node "${nodeId}": \`// @use ${name}\` names a shared WGSL module that does not exist.`,
          nodeId,
          suggestion: `Shared modules: ${Object.keys(SHARED_WGSL_MODULES).join(", ")}.`,
        })),
      };
    }
    const { declaration, rest } = extractParamsStruct(source);
    const code = `${shared.prelude}${rest}`;
    const own = declaredNames(code);
    if (!own.includes("surface")) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: MATERIAL_WGSL_SOURCE_CODE,
            message: `Node "${nodeId}": the source declares no \`fn surface(s: SurfaceIn, p: Params) -> SurfaceOut\`.`,
            nodeId,
          },
        ],
      };
    }
    /* The generator owns the names around the author's code; one declared twice is a WGSL
       error at best and a silently shadowed helper at worst, so it is named here instead. */
    const clashes = own.filter((name) => SURFACE_RESERVED_NAMES.has(name));
    if (clashes.length > 0) {
      return {
        passes: [],
        diagnostics: clashes.map((name) => ({
          severity: "error" as const,
          code: MATERIAL_WGSL_SOURCE_CODE,
          message: `Node "${nodeId}": "${name}" is declared by the surface generator this code is placed in; rename yours.`,
          nodeId,
        })),
      };
    }

    const model = parameters["model"];
    const base = readColor(parameters, "color", [1, 1, 1, 1]);
    const payload: MaterialPayload = {
      kind: "material",
      model: model === "phong" || model === "lambert" || model === "unlit" ? model : "pbr",
      baseColor: [base[0] ?? 1, base[1] ?? 1, base[2] ?? 1, base[3] ?? 1],
      specularColor: [1, 1, 1],
      shininess: 32,
      metallic: readNumber(parameters, "metallic", 0),
      roughness: readNumber(parameters, "roughness", 0.5),
      maps: {},
      custom: {
        code,
        paramsDeclaration: declaration,
        fields: fields.map((field) => ({ name: field.name, wgsl: field.wgsl })),
        uniforms: reflectedUniforms(fields, parameters),
      },
    };
    return { passes: [], scene: { out: payload } } as CompiledNodeDescription;
  },
};
