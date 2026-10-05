import { generatedOnce, wgsl } from "../../runtime/backend/wgsl.ts";
import type { EmittedWgsl } from "../../runtime/backend/wgsl.ts";
import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { declaredNames } from "./shared-modules.ts";
import type { WgslPosition } from "../../runtime/backend/wgsl-source-map.ts";
import { advance, endOf } from "../../runtime/backend/wgsl-source-map.ts";
import { packedAccessorWgsl, packedBindingsWgsl, type InstanceRecordOffsets, type PackedRead } from "./instance-resolve.wgsl.ts";
/**
 * The scene Render shader (T377/T428): the surface mesh machinery of T301 with the
 * SHADING GENERATED per material model — the V349 fix. The legacy renderers keep their
 * byte-identical shaders; this generator serves the `render` node only.
 *
 * Mesh side (unchanged from render-surface.wgsl.ts, credited): the vertex index IS the
 * grid connectivity, normals are central differences over grid neighbours, wrapped
 * axes address modularly so the seam cell closes the ring. What T377 adds: `uv` (the
 * grid coordinate — free, and what material maps sample by), `eye` (for the view
 * vector), and a LIGHT ARRAY sized to the scene's actual referenced count — structural
 * in COUNT (adding a light recompiles), pure values in CONTENT (moving one animates),
 * which is the no-artificial-cap shape without a storage buffer: a uniform array
 * carries thousands of lights before the block limit, and B33's silent storage-budget
 * cliff never enters the picture.
 */

export interface SceneShadingOptions {
  readonly model: "unlit" | "lambert" | "phong" | "pbr";
  /** Lights the shader is compiled for. 0 is legal: ambient floor only. */
  readonly lightCount: number;
  readonly maps?: { readonly albedo?: boolean; readonly roughness?: boolean };
  /** T478: a vec4f attribute multiplies the base colour per point (the mapped tint). */
  readonly pointColor?: boolean;
  /**
   * T481: the LIGHT INDICES that cast, in casting order. Slot s of this list owns
   * `shadow{s}Matrix` (a named mat4 member, V380) and the `shadowMap{s}` texture at
   * binding 5+s. Empty or absent emits byte-identical text (§V309).
   */
  readonly shadows?: ReadonlyArray<number>;
  /**
   * T1285: the PCF kernel radius in SHADOW-MAP TEXELS, parallel to `shadows` BY SLOT —
   * the same slot-indexed shape `shadowMatrices` already has at the call site. Slot s
   * takes (2r+1)² taps; a missing entry or 0 means one tap, i.e. the pre-T1285 text
   * byte for byte (§V309), which is what the light's Shadow Softness knob at 0 buys.
   */
  readonly shadowSoftness?: ReadonlyArray<number>;
  /**
   * T1438b: an extra receiver bias in WORLD UNITS, parallel to `shadows` by slot. A missing
   * entry or 0 emits the text without it, byte for byte (§V309).
   */
  readonly shadowBias?: ReadonlyArray<number>;
  /**
   * T1362b: the shadow SLOTS (indices into `shadows`) whose light is a POINT light. Such a
   * slot owns `shadow{s}Light` (xyz position, w range) and six `shadow{s}Face{f}` matrices
   * instead of `shadow{s}Matrix`, and its map is a 3×2 atlas of cube faces holding radial
   * distance ÷ range. Absent: every slot is directional, the text unchanged (§V309).
   */
  readonly pointShadows?: ReadonlyArray<number>;
  /**
   * T482: an equirect ENVIRONMENT is wired on the render. Phong (and pbr-through-
   * phong) adds its reflection — sampled along R, scaled by (1−roughness), the
   * specular tint and (T632) a SCHLICK FRESNEL factor, per T428's preserved IBL-lite
   * plan. Lambert and unlit ignore it, STATED on the input rather than silently
   * (V349). Absent emits byte-identical text.
   */
  readonly environment?: boolean;
  /**
   * T1289 — how many taps the specular cone takes. A KNOB and not a constant, for
   * §T1285's reason: if a bright small light in an environment aliases at high roughness,
   * whoever finds it turns it up rather than editing a shader, and §T1293 gets a real
   * measurement to be gated on rather than an argument.
   */
  readonly environmentTaps?: number;
  /**
   * T1427b: read the environment through the prefiltered atlas (`environmentAtlas`, bound
   * right after `environmentMap`) instead of the tap cone and the five irradiance taps.
   * Absent or false: the text is unchanged (§V309).
   */
  readonly environmentPrefiltered?: boolean;
  /**
   * T624: an ambient-occlusion map is bound, indexed by SCREEN PIXEL, and multiplies
   * the ambient and environment terms. Not the direct lights: occlusion says how much
   * of the surroundings a point can see, and the key light arrives from one direction
   * whether or not the neighbourhood is enclosed. Absent emits byte-identical text.
   */
  readonly ambientOcclusion?: boolean;
  /**
   * T704: PROJECTORS, in reference order — each an additive LIGHT whose beam carries
   * its cookie (§V644: light contribution, never an albedo tint). Slot p owns the
   * `projector{p}…` uniform rows and its optional cookie/depth textures, numbered
   * after the AO map. Unlit materials ignore projectors exactly as they ignore
   * lights. Empty or absent emits byte-identical text (§V309).
   */
  readonly projectors?: ReadonlyArray<SceneProjectorOption>;
  /**
   * T1353b: the surface is an INDEXED MESH (a `mesh:` topology), not a grid. The vertex
   * stage reads `meshIndices[vertex_index]` and pulls that vertex's attributes; the
   * normal is the `normal` attribute, never a grid difference. Each flag says an
   * attribute is bound: `uv` feeds the maps, `surface` makes roughness/metallic (and
   * the pbr F0) PER VERTEX in place of the material's, `emissive` adds unlit radiance
   * after lighting. Absent emits the grid text byte for byte (§V309).
   */
  readonly mesh?: SceneMeshOption;
  /**
   * T1355b: a Material · WGSL's code runs per fragment BEFORE lighting — its
   * `surface(SurfaceIn, Params) -> SurfaceOut` replaces the albedo, roughness, metallic,
   * normal and emissive the lighting reads. Its `Params` fields ride this pass's uniform
   * block as `m_<name>` members (the point kernels' prefix rule, T900). Absent emits the
   * stock text byte for byte (§V309).
   */
  readonly custom?: SceneCustomSurface;
  /**
   * T1371b: the G-BUFFER variant — the same vertex stage and the same material (maps, mesh
   * rows, a WGSL material's surface code), but instead of lighting the fragment writes what
   * the screen-space passes read: the shaded world normal encoded as n·0.5+0.5 in rgb, and
   * roughness in a (floored at 0.04, so 0 means "no surface here"). Lights, shadows,
   * environment, AO and projectors are not bound.
   *
   * `"albedo"` writes the other half a deferred pass needs to LIGHT the surface: the shaded
   * base colour (after the material) in rgb, linear, and metallic in a. Where nothing drew,
   * the clear leaves zero — the Normal output's alpha is the coverage test.
   */
  readonly gbuffer?: "normal" | "albedo" | "shadow";
  /**
   * T1411b: the surface is drawn ADDITIVELY (src + dst colour, no depth write) — light
   * added over what the opaques drew. Its alpha is written as 0, so the one/one blend
   * keeps the destination's coverage: a glow over a surface does not make the pixel
   * "more opaque" than 1. Absent emits the stock text byte for byte (§V309).
   */
  readonly additive?: boolean;
  /**
   * T1581b: the surface is a MESH DRAWN ONCE PER INSTANCE (Geometry, Instances mode, Shape:
   * Mesh). Needs `mesh`. The vertex stage pulls the shape's vertex as an indexed mesh does
   * and places it by the instance's RECORD — `Object · Instance`, resolved once a frame by
   * `instanceResolveWgsl` — instead of by the `model` uniform. Everything after the vertex
   * stage is the surface's own: lighting, shadows received, the G-buffer writes, a Material ·
   * WGSL. Absent emits the non-instanced text byte for byte (§V309).
   */
  readonly instanced?: SceneInstancedOption;
}

/**
 * T1581b: where an instanced mesh draw reads from. Every buffer is bound WHOLE as
 * `packed<group>` and read by offset (the point kernels' accessors), so the draw spends one
 * storage binding per producer whatever the shape carries (§V588).
 */
export interface SceneInstancedOption {
  /** How many buffers are bound, as `packed0..` from `INSTANCED_BINDING_BASE`. */
  readonly groups: number;
  /** The shape's vertex attributes. */
  readonly position: PackedRead;
  readonly normal: PackedRead;
  readonly uv?: PackedRead;
  readonly color?: PackedRead;
  readonly surface?: PackedRead;
  readonly emissive?: PackedRead;
  /** The instance records: which bound buffer, and where its regions start. */
  readonly record: InstanceRecordOffsets & { readonly group: number };
}

/** T1581b: the first binding of an instanced draw's whole-buffer bindings — clear of every other slot. */
export const INSTANCED_BINDING_BASE = 130;
/** T1581b: the variable prefix of those bindings; a pass binds `packed0`, `packed1`, …. */
export const INSTANCED_BINDING_PREFIX = "packed";

/** T1355b: the author's surface code, placed into the lit surface generator. */
export interface SceneCustomSurface {
  /** The source minus its `struct Params` (shared-module prelude included). */
  readonly code: string;
  /** The author's `struct Params` declaration, verbatim, or "" when none. */
  readonly paramsDeclaration: string;
  readonly fields: ReadonlyArray<{ readonly name: string; readonly wgsl: string }>;
  /**
   * T1581b: the fields of the author's `struct Instance` (declared in `code`), in declared
   * order. `SurfaceIn` then carries `instance: Instance`. On an instanced draw a field the
   * geometry bound (`instanced.record.fields`) is read from the instance's record at the
   * fragment's slot; every other field, and every field on any other draw, is its
   * `default` (zero when the author declared none) — so one material compiles everywhere.
   */
  readonly instance?: ReadonlyArray<{ readonly name: string; readonly wgsl: string; readonly default?: readonly number[] }>;
}

/** T1581b: the accessor a bound `struct Instance` field is read through, by field name. */
export function instanceFieldAccessor(name: string): string {
  return `instanceField_${name}`;
}

/** A `struct Instance` field's default as a WGSL constructor of its own type. */
function instanceDefaultWgsl(type: string, values: readonly number[] | undefined): string {
  const components = type === "vec2f" ? 2 : type === "vec3f" ? 3 : type === "vec4f" || type === "vec4u" ? 4 : 1;
  const numbers = Array.from({ length: components }, (_, index) => values?.[index] ?? 0);
  const unsigned = (value: number): string => `${Math.max(0, Math.trunc(value))}u`;
  if (type === "u32") return unsigned(numbers[0] ?? 0);
  if (type === "vec4u") return `vec4u(${numbers.map(unsigned).join(", ")})`;
  if (type === "f32") return biasLiteral(numbers[0] ?? 0);
  return `${type}(${numbers.map(biasLiteral).join(", ")})`;
}

/** T1355b: the uniform member a Material · WGSL field is carried under. */
export function materialParamUniformKey(name: string): string {
  return `m_${name}`;
}

/** T1355b: the binding the shared frame block rides on a custom-material draw. */
export const CUSTOM_SURFACE_FRAME_BINDING = "frameU";

const customSurfacePrelude = (instanceMember: string): string => `struct SurfaceIn {
  world: vec3f,
  normal: vec3f,
  uv: vec2f,
  tint: vec4f,
  attr: vec4f,
  emissive: vec3f,
  eye: vec3f,
  albedo: vec4f,
  roughness: f32,
  metallic: f32,
  absTime: f32,
  // T1377b: world metres per pixel here (filter detail finer than it), and how fast the
  // normal turns per metre (convex edges and bevels high, flats zero) — both derivatives,
  // taken by the generator in uniform control flow so the author's code may branch freely.
  footprint: f32,
  curvature: f32,
  // T1588b/T1581b: the SHAPE'S OWN FRAME — the vertex and its unit normal before the object
  // transform (and, on a mesh instance, before the instance's), so detail painted by them
  // sticks to a part however it is moved. instanceId is the instance's slot, 0 on a surface.
  local: vec3f,
  localNormal: vec3f,
  instanceId: u32,
${instanceMember}};

struct SurfaceOut {
  albedo: vec4f,
  roughness: f32,
  metallic: f32,
  normal: vec3f,
  emissive: vec3f,
};

fn surfaceDefaults(s: SurfaceIn) -> SurfaceOut {
  return SurfaceOut(s.albedo, s.roughness, s.metallic, s.normal, s.emissive);
}
`;

/** T1535b: everything a custom surface's text puts in front of the author's `struct Params`. */
const customSurfaceHead = (instanceMember: string): string =>
  `${SHARED_UNIFORMS_WGSL}\n@group(0) @binding(120) var<uniform> ${CUSTOM_SURFACE_FRAME_BINDING}: SharedFrame;\n\n${customSurfacePrelude(instanceMember)}\n`;
const CUSTOM_SURFACE_HEAD = customSurfaceHead("");
/**
 * T1581b: the head for a source that declares `struct Instance`. The struct itself stays
 * where the author wrote it, in their code below: a module-scope declaration is in scope
 * for the whole module, so `SurfaceIn` may name it from above.
 */
const CUSTOM_SURFACE_HEAD_WITH_INSTANCE = customSurfaceHead(
  "  // T1581b: the material's own `struct Instance`: one value per instance on a mesh-instance\n  // draw (bound by name to the points' attributes), its declared defaults on any other.\n  instance: Instance,\n",
);

/** T1353b: which per-vertex attributes an indexed surface binds. */
export interface SceneMeshOption {
  readonly uv: boolean;
  readonly surface: boolean;
  readonly emissive: boolean;
}

/** T1371b: the G-buffer's clear — "no surface" (all zero) behind everything, depth at the far plate. */
export const GBUFFER_CLEAR_WGSL = wgsl`@vertex
fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return vec4f(corners[v], 0.9999, 1.0);
}
@fragment
fn fs() -> @location(0) vec4f { return vec4f(0.0); }`;

/** T1353b: fixed binding slots for the mesh buffers — clear of every other numbered slot. */
export const MESH_BINDINGS = { indices: 100, normals: 101, uvs: 102, surface: 103, emissive: 104 } as const;

/** T704: what is STRUCTURAL about one referenced projector — its bindings. */
export interface SceneProjectorOption {
  /** A cookie texture is wired; unwired projects plain white (a focus light). */
  readonly cookie: boolean;
  /** A depth map is bound and compared — surfaces the projector cannot see get nothing. */
  readonly occlusion: boolean;
}

/**
 * T704 — the projector uniform rows, bindings and fragment term, shared verbatim by
 * both generators (§V349: the surface and the instances cannot drift apart).
 *
 * The read side is the T481 shadow read PLUS THE W-DIVIDE: a projector's matrix is a
 * perspective frustum, so `pc.xyz / pc.w` is the step the ortho shadow read never
 * needed, and the depth it compares is the fragment-z the perspective depth sweep
 * stores (`input.position.z`, already divided by the rasterizer). Falloff is
 * inverse-square about the THROW DISTANCE — brightness is nominal AT the look-at —
 * and it is a value switch (`Color.w`), not a shader variant, so toggling it animates.
 */
function projectorBlocks(
  projectors: ReadonlyArray<SceneProjectorOption>,
  baseBinding: number,
): { fields: string; bindings: string; term: string; bindingCount: number } {
  let binding = baseBinding;
  const fields = projectors
    .map(
      (_, p) => `  projector${p}Matrix: mat4x4f,
  projector${p}Pos: vec4f,    // xyz = lens position, w = brightness (nominal at look-at)
  projector${p}Color: vec4f,  // rgb = tint, w = falloff switch (0 off, 1 inverse-square)
  projector${p}Meta: vec4f,   // x = throw distance |lookAt - eye|, yzw reserved
`,
    )
    .join("");
  const bindings = projectors
    .map((proj, p) => {
      const cookie = proj.cookie ? `@group(0) @binding(${binding++}) var projectorCookie${p}: texture_2d<f32>;\n` : "";
      const depth = proj.occlusion ? `@group(0) @binding(${binding++}) var projectorDepth${p}: texture_2d<f32>;\n` : "";
      return cookie + depth;
    })
    .join("");
  const term = projectors
    .map((proj, p) => {
      const cookieExpr = proj.cookie
        ? `textureLoad(projectorCookie${p}, vec2i(clamp(puv, vec2f(0.0), vec2f(1.0)) * (vec2f(textureDimensions(projectorCookie${p}, 0)) - vec2f(1.0))), 0).rgb`
        : "vec3f(1.0)";
      const occlusionBlock = proj.occlusion
        ? `      let ddims = vec2f(textureDimensions(projectorDepth${p}, 0));
      let stored = textureLoad(projectorDepth${p}, vec2i(puv * (ddims - vec2f(1.0))), 0).r;
      /* The T624 slope-scaled bias, reused: fragment-z on both sides of the compare. */
      let bias = 0.0015 + 0.012 * (1.0 - plambert);
      if (pndc.z - bias > stored) { beam = 0.0; }
`
        : "";
      return `  {
    let pc = params.projector${p}Matrix * vec4f(input.world, 1.0);
    /* Behind the lens (w <= 0) is outside the beam — the divide would mirror it in. */
    if (pc.w > 1e-4) {
      let pndc = pc.xyz / pc.w;
      let puv = vec2f(pndc.x * 0.5 + 0.5, 0.5 - pndc.y * 0.5);
      if (puv.x >= 0.0 && puv.x <= 1.0 && puv.y >= 0.0 && puv.y <= 1.0 && pndc.z >= 0.0 && pndc.z <= 1.0) {
        let poffset = params.projector${p}Pos.xyz - input.world;
        let pdist = max(length(poffset), 1e-4);
        /* Two-sided, like every light here (T301's rule). */
        let plambert = abs(dot(normal, poffset / pdist));
        var beam = 1.0;
${occlusionBlock}        let nominal = max(params.projector${p}Meta.x, 1e-4);
        let pfalloff = select(1.0, (nominal * nominal) / (pdist * pdist), params.projector${p}Color.w > 0.5);
        let cookie = ${cookieExpr};
        lit += albedo.rgb * cookie * params.projector${p}Color.rgb * params.projector${p}Pos.w * pfalloff * plambert * beam;
      }
    }
  }
`;
    })
    .join("");
  return { fields, bindings, term, bindingCount: binding - baseBinding };
}

/**
 * T632 — the SCHLICK FRESNEL factor on the environment reflection, shared verbatim by
 * both generators so the surface and the instances cannot drift apart.
 *
 * The gap it closes (named by E33-Obol's author): an IBL-lite reflection along R with
 * NO view-dependent term reflects the same amount head-on as at a grazing angle, and a
 * dark surface that reflects its surroundings equally in every direction is a METAL.
 * What separates oil from chrome is that a dielectric reflects ~4% head-on and rises to
 * 1.0 at grazing incidence — so the environment shows only at the silhouette and the
 * body of the object stays dark.
 *
 * F0 is a SCALAR, mix(0.04, 1.0, metallic), and the reflection's COLOUR stays
 * `params.specular.rgb`, which the compiler already sets to mix(white, baseColor,
 * metallic) for a PBR material. The product is the textbook mix(vec3(0.04), albedo,
 * metallic) at both ends of `metallic` — a dielectric's 4% white base, a metal's own
 * albedo — while a Phong material keeps its authored specular tint as the tint of the
 * reflection. Two consequences worth stating: at metallic = 1 the factor is exactly 1
 * at every angle, so METALS ARE BYTE-IDENTICAL to what shipped before this; and for
 * everything else the factor is ≤ 1, so the environment term can only DECREASE and its
 * grazing value is exactly the value the whole surface used to carry.
 *
 * `abs(dot(N, V))` rather than `max(…, 0)`: a surface has no wrong side here (T301's
 * two-sided rule, kept by the lambert and the highlight above), and clamping a back
 * face to zero would flare it to a full-strength reflection instead of a grazing one.
 * The outer `max(…, 0.0)` only guards pow() against a negative base from float slop.
 *
 * Roughness keeps its LINEAR (1 − roughness) scale, deliberately, and it multiplies
 * this factor rather than being folded into it. That factor is the crude stand-in for
 * a prefiltered environment we do not have; leaving it outside means it still caps the
 * grazing reflection at the value that material reflected before, so no rough surface
 * can develop an edge glow it did not already have, and a rough METAL keeps its
 * dimming instead of snapping back to a mirror.
 */
/**
 * T1284 — THE SPECULAR LOBE, GGX/Smith, shared verbatim by both generators (§V349).
 *
 * What this replaces, and why "replaces" is the honest word: `materialPbr` collapsed to
 * Blinn-Phong. Every `pbr` material was mapped to `phong` with its shininess PINNED AT 96
 * and `metallic` used only to tint the specular colour toward the base colour
 * (`scene.ts:1682/1888`, `compile.ts:1770`), and the node description said so rather than
 * pretending. Roughness reached the highlight only through `gloss = specular.w * (1 −
 * roughness)`, which moves a Phong exponent and is not a microfacet distribution: it has
 * no Fresnel per light, no shadowing-masking, and its energy is whatever the exponent
 * happens to integrate to.
 *
 * The three terms, each the standard one and each chosen for a reason a reader can check:
 *
 *  - D, Trowbridge-Reitz (GGX). `alpha = roughness²` is the Disney/UE4 remap, so the
 *    parameter stays perceptually even rather than crowding every visible change into the
 *    bottom of its range.
 *  - V, Smith height-correlated, returning G/(4·NoL·NoV) as ONE factor. Heitz's form,
 *    and the fused version is not a micro-optimisation: the separable one divides by
 *    NoL·NoV and then the reflectance multiplies by them, which is a 0/0 at grazing that
 *    shows up as a bright rim on a silhouette — exactly where §V571 already fights.
 *  - F, Schlick, on `VoH` (the half-vector), not on `NoV`. Per-light Fresnel is a
 *    different quantity from the environment's: `FRESNEL_WGSL` below answers "how much
 *    does this surface reflect the world at this viewing angle" and this answers "how
 *    much does this facet reflect THIS light". Both are Schlick; they are not the same
 *    number and sharing one would be wrong.
 *
 * ⚑ ENERGY: the diffuse half is scaled by (1 − F)(1 − metallic) in the pbr branch, which
 * is what finally makes `metallic` mean something per light rather than only tinting. A
 * metal has no diffuse lobe at all, and this is the line that says so. The lambert and
 * phong models keep their unscaled diffuse EXACTLY — they are not PBR and pretending they
 * are would change every non-pbr scene in the catalogue for no stated reason.
 *
 * ⚑ TWO-SIDED (T301, kept): every dot with the normal is `abs`, so a back face shades as
 * a front face rather than going black. `max(…, 1e-4)` guards the divisions, never the
 * sidedness.
 */
/**
 * T1292 — EXPORTED, and the export is the point. A third copy of this lobe in
 * `scene-preview.wgsl.ts` is §V960's defect waiting to happen (one rule spelled in six
 * places is exactly what T1284's §V288 twin came from), so the material PREVIEW tile
 * generates its highlight from this same string. The parameterisation already existed
 * for the surface/instances split — the preview is the third caller, not a third copy.
 *
 * What a caller owes it: `normal`, `viewDir`, `toLight`, `radiance` and a mutable `lit`
 * in scope, and a uniform block with `specular: vec4f` (rgb = F0 tint) and
 * `material: vec4f` (x = metallic). `PreviewParams` carries both under the same names as
 * `SceneParams`, which is why this drops in verbatim.
 */
export const ggxSpecularWgsl = (roughnessExpr: string): string => `    let halfway = normalize(toLight + viewDir);
    let NoV = max(abs(dot(normal, viewDir)), 1.0e-4);
    let NoL = max(abs(dot(normal, toLight)), 1.0e-4);
    let NoH = abs(dot(normal, halfway));
    let VoH = abs(dot(viewDir, halfway));
    let alpha = max(${roughnessExpr} * ${roughnessExpr}, 1.0e-3);
    let alpha2 = alpha * alpha;
    let denom = (NoH * NoH * (alpha2 - 1.0)) + 1.0;
    let distribution = alpha2 / (3.14159265 * denom * denom);
    let lambdaV = NoL * sqrt((NoV * NoV * (1.0 - alpha2)) + alpha2);
    let lambdaL = NoV * sqrt((NoL * NoL * (1.0 - alpha2)) + alpha2);
    let visibility = 0.5 / max(lambdaV + lambdaL, 1.0e-5);
    let specF0 = mix(vec3f(0.04), params.specular.rgb, params.material.x);
    let fresnel = specF0 + ((vec3f(1.0) - specF0) * pow(1.0 - VoH, 5.0));
    lit += radiance * distribution * visibility * fresnel * NoL;
`;

/** The models that carry a specular response, and so an environment (T1284 added pbr). */
const lit = (model: SceneShadingOptions["model"]): boolean => model === "phong" || model === "pbr";

const FRESNEL_WGSL = `  let envF0 = mix(0.04, 1.0, params.material.x);
  let envFresnel = envF0 + (1.0 - envF0) * pow(max(1.0 - abs(dot(normal, viewDir)), 0.0), 5.0);
`;

/**
 * T636 — the DIFFUSE half of the environment, shared verbatim by both generators.
 *
 * The gap the Fresnel work exposed: the IBL-lite had only the SPECULAR half, so when
 * T632 correctly removed the head-on reflection from a dielectric there was nothing
 * physical left to fill its shadows, and `environmentIntensity` had to stand in by
 * hand — E33 needed a 7× re-exposure that was a tuning constant doing a missing
 * term's job.
 *
 * The term is an irradiance lookup along N — five taps averaged over a wide cone,
 * because the equirect has no prefiltered mips to sample and five texel fetches are
 * the IBL-lite answer, an approximation stated as one — times the surface's DIFFUSE
 * reflectance (`albedo`, never the specular tint), times `(1 − F) · (1 − metallic)`:
 * energy the surface did not reflect specularly is what is available to the diffuse
 * half, and a metal has none. That factor is also what finally makes `metallic` mean
 * something for the diffuse term rather than only the specular one.
 *
 * Two properties, both deliberate and both gated:
 *  - AT GRAZING THE TERM IS ZERO. (1 − F) → 0 exactly where the specular ceiling
 *    (§V571) is doing its work, so the silhouette carries only what it carried
 *    before — this term can add no edge glow, ever.
 *  - A METAL GAINS NOTHING, at any angle: (1 − metallic) is a hard zero at
 *    metallic = 1, so every metal stays byte-identical to what shipped.
 *
 * It DOES brighten dielectric bodies facing the environment — that is its entire
 * job, it is what the hand-tuned intensity was standing in for, and it is why the
 * blast radius was measured by hashing every example's pass WGSL rather than
 * asserted (exactly the scenes that wire an environment change, nothing else).
 *
 * The sampling normal faces the viewer (`sign(dot(N, V))`) — the two-sided rule
 * (T301) applied to irradiance: a back face is lit by the hemisphere it shows the
 * camera, not by the one behind it. Roughness is deliberately absent: Lambertian
 * irradiance does not sharpen with polish, and tying it in would re-dim rough
 * dielectrics that this term exists to fill.
 */
const IRRADIANCE_WGSL = `  let envN = normal * select(-1.0, 1.0, dot(normal, viewDir) >= 0.0);
  let envUp = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(envN.y) > 0.9);
  let envTx = normalize(cross(envUp, envN));
  let envTy = cross(envN, envTx);
  let irradiance = (sampleEnvironment(envN)
    + sampleEnvironment(normalize(envN + envTx))
    + sampleEnvironment(normalize(envN - envTx))
    + sampleEnvironment(normalize(envN + envTy))
    + sampleEnvironment(normalize(envN - envTy))) / 5.0;
`;

/**
 * T1437b — a POINT light's distance falloff, shared verbatim by the surface, instances and
 * preview light blocks (§V349). It reads the `lightMeta` the block already holds:
 *
 *  - z selects the law: 0 is the shipped 1/(1 + d²), 1 is the physical 1/d² with d held at
 *    1 cm or more (a surface through the lamp must not divide by zero);
 *  - w is the range: 0 is unlimited, else the law is multiplied by the window
 *    (1 − (d/range)⁴)², clamped, which is 1 at the lamp, ~0.88 at half the range and exactly
 *    0 at it — a light that ends, rather than one that is cut.
 *
 * With z = w = 0 (every light saved before this row) the value is the pre-T1437b expression
 * to the bit: the soft arm is that expression, and the window branch is not taken.
 */
export const POINT_FALLOFF_WGSL = `      attenuation = select(1.0 / (1.0 + distance * distance), 1.0 / max(distance * distance, 1e-4), lightMeta.z > 0.5);
      if (lightMeta.w > 0.0) {
        let reach = distance / lightMeta.w;
        let reachWindow = clamp(1.0 - reach * reach * reach * reach, 0.0, 1.0);
        attenuation = attenuation * reachWindow * reachWindow;
      }
`;

/**
 * T1437b — the `light{i}Meta` row every lit draw writes, in ONE place (the render's two
 * generators and the light preview wrote it three times): x = 1 for a point light, y = the
 * intensity, z = the falloff law (1 inverse square), w = the range (0 unlimited).
 */
export function lightMetaUniform(light: {
  readonly type: "directional" | "point";
  readonly intensity: number;
  readonly falloff?: "soft" | "inverseSquare";
  readonly range?: number;
}): number[] {
  return [light.type === "point" ? 1 : 0, light.intensity, light.falloff === "inverseSquare" ? 1 : 0, Math.max(0, light.range ?? 0)];
}

/** The equirect fetch, shared by the reflection and the five irradiance taps (T636). */
const ENV_SAMPLE_WGSL = `fn sampleEnvironment(direction: vec3f) -> vec3f {
  let uv = vec2f(
    atan2(direction.x, -direction.z) / 6.2831853 + 0.5,
    acos(clamp(direction.y, -1.0, 1.0)) / 3.14159265,
  );
  let dims = vec2f(textureDimensions(environmentMap, 0));
  return textureLoad(environmentMap, vec2i(clamp(uv, vec2f(0.0), vec2f(1.0)) * (dims - vec2f(1.0))), 0).rgb;
}
`;

/**
 * T1289 — THE SPECULAR CONE: roughness BLURS the reflection instead of DIMMING it.
 *
 * What shipped before this read the environment ONCE, sharply, and multiplied by
 * `(1 − roughness)`. So a brushed surface and a mirror sampled the SAME TEXEL and differed
 * only in brightness: rough metal read DARK rather than SOFT, which is the largest single
 * gap between what this renderer shipped and what "PBR" means to somebody looking at it.
 *
 * ⚑ WHY TAPS AND NOT A PREFILTERED PYRAMID. The pyramid was the plan (§T1289 named the
 * glass chain as the reuse, and the pass shapes really are the same) until the SIZING was
 * checked: `compile.ts` sizes every scratch target as `baseSize × scale`, where `baseSize`
 * is the NODE'S OUTPUT RESOLUTION and not any input's. Glass gets away with it because its
 * source IS the render target; an environment is an arbitrary TOP with its own size, so a
 * decimating kernel that assumes "target is half of source" is simply wrong at the first
 * level, and the blur radius would track the render resolution rather than the map. Doing
 * it properly means teaching the compiler to size a scratch from an INPUT (§T1293, filed
 * and gated on this landing's measurements). These taps need no scratch at all, cost ALU
 * per covered pixel instead of extra passes, and answer the claim the row actually makes.
 *
 * THE PATTERN IS A GOLDEN-ANGLE SPIRAL, deterministic by construction (§V44/§V45): tap i
 * sits at angle `i · 2.39996` and radius `spread · sqrt((i + 0.5) / taps)`, which fills a
 * disc evenly rather than clumping at its centre the way equal radial steps do. No hash,
 * no clock, no per-frame jitter — the same pixel is the same colour on every device and
 * every replay, and a stationary rough surface does not boil.
 *
 * `spread` is GGX's own `alpha` (roughness²), so the cone widens the way the lobe does
 * rather than the way the slider does, and the two halves of this material agree about
 * what roughness means.
 *
 * ⚑ AT ROUGHNESS 0 THE FUNCTION RETURNS THE SINGLE SHARP SAMPLE, by an early return
 * rather than by the arithmetic collapsing. A mirror must be BYTE-IDENTICAL to what it was
 * before this row, and `(N copies of v summed) / N` is not reliably `v` in float — the
 * branch is what makes "a polished surface is unchanged" a fact instead of a hope.
 */
const ENV_CONE_WGSL = (taps: number): string => `fn sampleEnvironmentCone(direction: vec3f, spread: f32) -> vec3f {
  if (spread <= 0.0) {
    return sampleEnvironment(direction);
  }
  let coneUp = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(direction.y) > 0.9);
  let coneTx = normalize(cross(coneUp, direction));
  let coneTy = cross(direction, coneTx);
  var total = vec3f(0.0);
  for (var i = 0; i < ${String(taps)}; i = i + 1) {
    let t = (f32(i) + 0.5) / ${String(taps)}.0;
    let angle = f32(i) * 2.3999632;
    let radius = spread * sqrt(t);
    let offset = (coneTx * (cos(angle) * radius)) + (coneTy * (sin(angle) * radius));
    total = total + sampleEnvironment(normalize(direction + offset));
  }
  return total / ${String(taps)}.0;
}
`;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T1427b — THE PREFILTERED ENVIRONMENT (the Render's Env Filter = Prefiltered).
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The taps above read a SHARP map: 8 (or up to 32) taps across a roughness cone, and five
 * for the diffuse irradiance. A small bright source in the map — a lamp in an HDRI — falls
 * between taps for one pixel and on one for the next, so a rough surface BANDS and a matte
 * one STREAKS as it moves. More taps only move the threshold.
 *
 * So the environment is filtered ONCE per frame, before the lit draws, into roughness
 * levels, and the lit draw reads one bilinear texel per level:
 *
 *  1. BASE: a box average of the source over each base texel's own footprint, measured at
 *     runtime with textureDimensions — so this assumes NOTHING about the source's size
 *     (§T1293's objection to a decimating pyramid over an arbitrary input: a kernel that
 *     assumes "target is half of source" is simply wrong at the first level). A lamp a
 *     tenth of a base texel wide still lands in it, averaged, never missed.
 *  2. LEVELS: each level blurs the PREVIOUS one by a cone of the incremental spread
 *     √(sₖ² − sₖ₋₁²), 64 golden-spiral taps, bilinear. The tap spacing stays under the
 *     previous level's own blur, so no level aliases what the one before it already
 *     smoothed. The spreads are GGX's alpha (roughness²), the unit the taps already use.
 *  3. ATLAS: the four levels and a cosine-weighted IRRADIANCE tile (64 taps over the
 *     hemisphere of the widest level, Malley's method) packed into one 3 × 2 atlas, so a
 *     lit draw binds ONE more texture, not five (§T1406b's budget).
 *
 * Every map here is an equirect in direction space and is read by DIRECTION: its texel
 * count follows the output's aspect (scratch targets scale with the node's output), which
 * changes texel density but not what a texel means. Longitude wraps, latitude clamps.
 *
 * The lookup blends the two levels whose spreads bracket the surface's; below the first
 * it blends from the sharp source, and at roughness 0 it IS the sharp source, by the same
 * early return the cone takes — a mirror is byte-identical under either filter.
 */
export const ENV_PREFILTER_SPREADS = [0.04, 0.12, 0.35, 1.0] as const;
/** T1427b: the short side, in texels, of the base, of each level, and of the atlas. */
export const ENV_PREFILTER_SIDES = { base: 256, levels: [128, 64, 32, 32], atlas: 256 } as const;

const FULLSCREEN_VS = `@vertex
fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return vec4f(corners[v], 0.0, 1.0);
}
`;

/**
 * Direction ↔ equirect uv, the exact inverse pair of `sampleEnvironment`'s mapping. At the
 * poles atan2(0, −0) is undefined in WGSL (NaN on Metal): a floor's irradiance normal is
 * exactly +Y, so the longitude is pinned to 0 there rather than trusted.
 */
const ENV_UV_WGSL = `fn envUv(direction: vec3f) -> vec2f {
  let around = select(atan2(direction.x, -direction.z), 0.0, abs(direction.x) + abs(direction.z) < 1e-12);
  return vec2f(around / 6.2831853 + 0.5, acos(clamp(direction.y, -1.0, 1.0)) / 3.14159265);
}
fn envBilinear(tex: texture_2d<f32>, origin: vec2i, size: vec2i, uv: vec2f) -> vec3f {
  let coord = vec2f(fract(uv.x), clamp(uv.y, 0.0, 1.0)) * vec2f(size) - vec2f(0.5);
  let base = floor(coord);
  let f = coord - base;
  let x0 = ((i32(base.x) % size.x) + size.x) % size.x;
  let x1 = (x0 + 1) % size.x;
  let y0 = clamp(i32(base.y), 0, size.y - 1);
  let y1 = clamp(i32(base.y) + 1, 0, size.y - 1);
  let c00 = textureLoad(tex, origin + vec2i(x0, y0), 0).rgb;
  let c10 = textureLoad(tex, origin + vec2i(x1, y0), 0).rgb;
  let c01 = textureLoad(tex, origin + vec2i(x0, y1), 0).rgb;
  let c11 = textureLoad(tex, origin + vec2i(x1, y1), 0).rgb;
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}
`;
const ENV_DIRECTION_WGSL = `fn envDirection(uv: vec2f) -> vec3f {
  let theta = uv.y * 3.14159265;
  let phi = (uv.x - 0.5) * 6.2831853;
  return vec3f(sin(theta) * sin(phi), cos(theta), -sin(theta) * cos(phi));
}
fn envBasis(direction: vec3f) -> mat3x3f {
  let up = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(direction.y) > 0.9);
  let tx = normalize(cross(up, direction));
  return mat3x3f(tx, cross(direction, tx), direction);
}
`;
const PREFILTER_PARAMS = `struct PrefilterParams {
  dims: vec4f,   // xy = this pass's target size in texels
};
@group(0) @binding(0) var<uniform> params: PrefilterParams;
`;

/** T1427b step 1: the source box-averaged over each target texel's footprint (≤ 16 × 16 loads, strided beyond). */
export const ENV_PREFILTER_BASE_WGSL = wgsl`${PREFILTER_PARAMS}@group(0) @binding(1) var sourceTex: texture_2d<f32>;
${FULLSCREEN_VS}@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let source = vec2i(textureDimensions(sourceTex, 0));
  let cell = floor(position.xy);
  let lo = vec2i(floor(cell / params.dims.xy * vec2f(source)));
  let hi = max(lo, vec2i(ceil((cell + vec2f(1.0)) / params.dims.xy * vec2f(source))) - vec2i(1));
  let span = hi - lo + vec2i(1);
  let count = min(span, vec2i(16));
  let stride = vec2f(span) / vec2f(count);
  var sum = vec3f(0.0);
  for (var j = 0; j < count.y; j = j + 1) {
    for (var i = 0; i < count.x; i = i + 1) {
      let at = clamp(lo + vec2i(vec2f(f32(i), f32(j)) * stride), vec2i(0), source - vec2i(1));
      sum = sum + textureLoad(sourceTex, at, 0).rgb;
    }
  }
  return vec4f(sum / f32(count.x * count.y), 1.0);
}`;

/** T1427b step 2: one level — the previous level blurred by a cone of `radius` (tangent units). */
export const envPrefilterLevelWgsl = generatedOnce("envPrefilterLevelWgsl", buildEnvPrefilterLevelWgsl);
function buildEnvPrefilterLevelWgsl(radius: number): EmittedWgsl {
  return wgsl`${PREFILTER_PARAMS}@group(0) @binding(1) var sourceTex: texture_2d<f32>;
${ENV_UV_WGSL}${ENV_DIRECTION_WGSL}${FULLSCREEN_VS}@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let direction = envDirection((floor(position.xy) + vec2f(0.5)) / params.dims.xy);
  let basis = envBasis(direction);
  let size = vec2i(textureDimensions(sourceTex, 0));
  var total = vec3f(0.0);
  for (var i = 0; i < 64; i = i + 1) {
    let t = (f32(i) + 0.5) / 64.0;
    let angle = f32(i) * 2.3999632;
    let offset = (basis[0] * cos(angle) + basis[1] * sin(angle)) * (${radius.toFixed(6)} * sqrt(t));
    total = total + envBilinear(sourceTex, vec2i(0), size, envUv(normalize(direction + offset)));
  }
  return vec4f(total / 64.0, 1.0);
}`;
}

/** T1427b step 3: the levels copied into atlas tiles 0–3, the irradiance into tile 4. */
export const ENV_PREFILTER_PACK_WGSL = wgsl`${PREFILTER_PARAMS}@group(0) @binding(1) var level0: texture_2d<f32>;
@group(0) @binding(2) var level1: texture_2d<f32>;
@group(0) @binding(3) var level2: texture_2d<f32>;
@group(0) @binding(4) var level3: texture_2d<f32>;
${ENV_UV_WGSL}${ENV_DIRECTION_WGSL}${FULLSCREEN_VS}@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let p = vec2i(floor(position.xy));
  let tileSize = vec2i(params.dims.xy) / vec2i(3, 2);
  let tile = p / tileSize;
  if (tile.x > 2 || tile.y > 1) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  let uv = (vec2f(p - tile * tileSize) + vec2f(0.5)) / vec2f(tileSize);
  switch (tile.y * 3 + tile.x) {
    case 0: { return vec4f(envBilinear(level0, vec2i(0), vec2i(textureDimensions(level0, 0)), uv), 1.0); }
    case 1: { return vec4f(envBilinear(level1, vec2i(0), vec2i(textureDimensions(level1, 0)), uv), 1.0); }
    case 2: { return vec4f(envBilinear(level2, vec2i(0), vec2i(textureDimensions(level2, 0)), uv), 1.0); }
    case 3: { return vec4f(envBilinear(level3, vec2i(0), vec2i(textureDimensions(level3, 0)), uv), 1.0); }
    case 4: {
      /* Cosine-weighted over the hemisphere: an even disc lifted onto it (Malley). */
      let basis = envBasis(envDirection(uv));
      let size = vec2i(textureDimensions(level3, 0));
      var total = vec3f(0.0);
      for (var i = 0; i < 64; i = i + 1) {
        let t = (f32(i) + 0.5) / 64.0;
        let angle = f32(i) * 2.3999632;
        let r = sqrt(t);
        let d = basis[0] * (cos(angle) * r) + basis[1] * (sin(angle) * r) + basis[2] * sqrt(max(0.0, 1.0 - t));
        total = total + envBilinear(level3, vec2i(0), size, envUv(normalize(d)));
      }
      return vec4f(total / 64.0, 1.0);
    }
    default: { return vec4f(0.0, 0.0, 0.0, 1.0); }
  }
}`;

/** T1427b: the lit draw's lookup into the atlas — declared only under Env Filter = Prefiltered. */
function envPrefilteredLookupWgsl(binding: number): string {
  const s = ENV_PREFILTER_SPREADS;
  const f = (value: number): string => value.toFixed(4);
  const between = s
    .slice(1)
    .map(
      (upper, index) =>
        `  if (spread < ${f(upper)}) { return mix(envAtlasTile(${index}u, direction), envAtlasTile(${index + 1}u, direction), (spread - ${f(s[index]!)}) / ${f(upper - s[index]!)}); }\n`,
    )
    .join("");
  return `@group(0) @binding(${binding}) var environmentAtlas: texture_2d<f32>;
${ENV_UV_WGSL}fn envAtlasTile(tile: u32, direction: vec3f) -> vec3f {
  let size = vec2i(textureDimensions(environmentAtlas, 0)) / vec2i(3, 2);
  let origin = vec2i(i32(tile % 3u), i32(tile / 3u)) * size;
  return envBilinear(environmentAtlas, origin, size, envUv(direction));
}
fn sampleEnvironmentPrefiltered(direction: vec3f, spread: f32) -> vec3f {
  if (spread <= 0.0) {
    return sampleEnvironment(direction);
  }
  if (spread < ${f(s[0])}) { return mix(sampleEnvironment(direction), envAtlasTile(0u, direction), spread / ${f(s[0])}); }
${between}  return envAtlasTile(${s.length - 1}u, direction);
}
fn sampleIrradiance(direction: vec3f) -> vec3f {
  return envAtlasTile(4u, direction);
}
`;
}

/** T1427b: the diffuse half read from the irradiance tile — the same viewer-facing normal. */
const IRRADIANCE_PREFILTERED_WGSL = `  let envN = normal * select(-1.0, 1.0, dot(normal, viewDir) >= 0.0);
  let irradiance = sampleIrradiance(envN);
`;

/**
 * T659 — the BACKDROP, which until now could only ever be a flat colour.
 *
 * The gap the owner found by looking: `sampleEnvironment` appears in exactly two places
 * — the reflection vector and the five irradiance taps — and NO pass ever renders it.
 * So a wired environment was taking as LIGHT ONLY, and the visible sky behind a scene
 * was the backdrop colour, always. "Is the sky band taking, or are we using a skybox?"
 * had the answer "neither": it was taking, and it was never drawn.
 *
 * `environment: false` returns the T444 backdrop VERBATIM, which is why every scene that
 * does not opt in is byte-identical (§V461's other end, measured by hashing pass WGSL
 * across the catalogue rather than asserted).
 *
 * With it on, the same equirect fetch the reflection uses is read along a camera ray
 * through each pixel — one function, so the sky and its own reflection cannot drift
 * apart (§V349). The ray is built from a basis handed in as uniforms, `right` and `up`
 * PRE-SCALED by the frustum's half-extents, so the fragment shader does one add and one
 * normalize and the trigonometry lives on the CPU where the camera already is.
 *
 * Clip depth stays 0.999, but the render pass disables depth writes: valid distant
 * geometry can project beyond 0.999 and must still draw over this background.
 *
 * ORTHOGRAPHIC cameras get a CONSTANT direction, and that is correct rather than
 * degenerate: parallel rays see one point of an environment at infinity. Stated because
 * a flat sky under an ortho camera otherwise reads as a bug (§V403).
 */
export const backdropWgsl = generatedOnce("backdropWgsl", buildBackdropWgsl);
function buildBackdropWgsl(options: { readonly environment?: boolean } = {}): EmittedWgsl {
  if (options.environment !== true) {
    return wgsl`struct Backdrop { color: vec4f };
@group(0) @binding(0) var<uniform> backdrop: Backdrop;
@vertex
fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return vec4f(corners[v], 0.999, 1.0);
}
@fragment
fn fs() -> @location(0) vec4f { return backdrop.color; }`;
  }
  return wgsl`struct Backdrop {
  color: vec4f,       // rgb unused when the environment draws; a = the backdrop's alpha
  right: vec4f,       // camera right × tan(fovY/2) × aspect (zero under an ortho camera)
  up: vec4f,          // camera up × tan(fovY/2)             (zero under an ortho camera)
  forward: vec4f,     // unit view direction; w = environment intensity
};
@group(0) @binding(0) var<uniform> backdrop: Backdrop;
@group(0) @binding(1) var environmentMap: texture_2d<f32>;
${ENV_SAMPLE_WGSL}
struct BackdropOut {
  @builtin(position) position: vec4f,
  @location(0) ndc: vec2f,
};
@vertex
fn vs(@builtin(vertex_index) v: u32) -> BackdropOut {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  var out: BackdropOut;
  out.position = vec4f(corners[v], 0.999, 1.0);
  out.ndc = corners[v];
  return out;
}
@fragment
fn fs(input: BackdropOut) -> @location(0) vec4f {
  let direction = normalize(
    backdrop.forward.xyz + input.ndc.x * backdrop.right.xyz + input.ndc.y * backdrop.up.xyz,
  );
  return vec4f(sampleEnvironment(direction) * backdrop.forward.w, backdrop.color.a);
}`;
}

/**
 * T725 — the surface MESH chunk (grid connectivity, central-difference normals, uv,
 * tint), extracted verbatim so the lit generator and the glass generator share one
 * source (§V349). The lit template's emitted text is byte-identical to before the
 * extraction — the golden scene hashes are the proof.
 */
/**
 * T1588b — the two inter-stage members a Material · WGSL reads the SHAPE'S OWN FRAME by:
 * the vertex and its normal before any transform. Carried only when a custom surface is
 * placed, at the same locations in the grid and the mesh chunk.
 */
const LOCAL_VARYINGS = `  @location(6) local: vec3f,
  @location(7) localNormal: vec3f,
`;

function surfaceMeshWgsl(pointColor: boolean, carriesLocal = false): EmittedWgsl {
  return wgsl`struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) world: vec3f,
  @location(2) uv: vec2f,
  @location(3) tint: vec4f,
${carriesLocal ? LOCAL_VARYINGS : ""}};

fn cellCorner(v: u32) -> vec2u {
  var corners = array<vec2u, 6>(
    vec2u(0u, 0u), vec2u(1u, 0u), vec2u(0u, 1u),
    vec2u(0u, 1u), vec2u(1u, 0u), vec2u(1u, 1u),
  );
  return corners[v];
}

fn gridPosition(gx: u32, gy: u32) -> vec3f {
  let cols = u32(params.grid.x);
  let rows = u32(params.grid.y);
  let px = select(gx, gx % cols, params.grid.z > 0.5);
  let py = select(gy, gy % rows, params.grid.w > 0.5);
  return positions[py * cols + px];
}

fn nextIndex(i: u32, extent: u32, wrapped: bool) -> u32 {
  return select(min(i + 1u, extent - 1u), (i + 1u) % extent, wrapped);
}
fn previousIndex(i: u32, extent: u32, wrapped: bool) -> u32 {
  return select(max(i, 1u) - 1u, (i + extent - 1u) % extent, wrapped);
}

@vertex
fn vs(@builtin(vertex_index) vertex: u32) -> VertexOut {
  let cols = u32(params.grid.x);
  let rows = u32(params.grid.y);
  let wrapU = params.grid.z > 0.5;
  let wrapV = params.grid.w > 0.5;
  let cellsU = select(cols - 1u, cols, wrapU);
  let quad = vertex / 6u;
  let corner = cellCorner(vertex % 6u);
  let gx = (quad % cellsU) + corner.x;
  let gy = (quad / cellsU) + corner.y;

  let local = gridPosition(gx, gy);
  let du = gridPosition(nextIndex(gx, cols, wrapU), gy) -
    gridPosition(previousIndex(gx, cols, wrapU), gy);
  let dv = gridPosition(gx, nextIndex(gy, rows, wrapV)) -
    gridPosition(gx, previousIndex(gy, rows, wrapV));
  /* T1588b: the object transform. The cross product of two transformed edges is the
     cofactor of the transform applied to the cross product of the edges themselves. */
  let world = (params.model * vec4f(local, 1.0)).xyz;
  let localNormal = cross(du, dv);

  var out: VertexOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  out.normal = (params.modelNormal * vec4f(localNormal, 0.0)).xyz;
  out.world = world;${carriesLocal ? "\n  out.local = local;\n  out.localNormal = localNormal;" : ""}
  /* The grid coordinate IS the uv — free, and what material maps sample by. */
  out.uv = vec2f(f32(gx) / max(params.grid.x - 1.0, 1.0), f32(gy) / max(params.grid.y - 1.0, 1.0));
  /* Same modular indexing as the position read, so the seam vertex wears column 0's tint. */
  out.tint = ${pointColor
    ? "pointColors[select(gy, gy % rows, wrapV) * cols + select(gx, gx % cols, wrapU)]"
    : "vec4f(1.0)"};
  return out;
}`;
}

/**
 * T1353b — the INDEXED mesh chunk: the grid chunk's contract (same VertexOut fields, so
 * the fragment stage is shared) plus the two per-vertex material rows. The index list
 * is zero until the file's bytes arrive, which makes every triangle degenerate — no
 * fragments, rather than a shape made of whatever vertex 0 happens to be.
 */
function meshVertexWgsl(pointColor: boolean, mesh: SceneMeshOption, carriesLocal = false): EmittedWgsl {
  return wgsl`struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) world: vec3f,
  @location(2) uv: vec2f,
  @location(3) tint: vec4f,
  @location(4) surface: vec4f,
  @location(5) emissive: vec3f,
${carriesLocal ? LOCAL_VARYINGS : ""}};

@vertex
fn vs(@builtin(vertex_index) vertex: u32) -> VertexOut {
  let index = meshIndices[vertex];
  let local = positions[index];
  let localNormal = meshNormals[index];
  /* T1588b: the object transform; the normal takes its cofactor. */
  let world = (params.model * vec4f(local, 1.0)).xyz;
  var out: VertexOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  out.normal = (params.modelNormal * vec4f(localNormal, 0.0)).xyz;
  out.world = world;${carriesLocal ? "\n  out.local = local;\n  out.localNormal = localNormal;" : ""}
  out.uv = ${mesh.uv ? "meshUvs[index]" : "vec2f(0.0)"};
  out.tint = ${pointColor ? "pointColors[index]" : "vec4f(1.0)"};
  out.surface = ${mesh.surface ? "meshSurface[index]" : "vec4f(0.0)"};
  out.emissive = ${mesh.emissive ? "meshEmissive[index]" : "vec3f(0.0)"};
  return out;
}`;
}

/** T1353b: the mesh storage declarations, at `MESH_BINDINGS`. */
function meshBindingsWgsl(mesh: SceneMeshOption): string {
  return [
    `@group(0) @binding(${MESH_BINDINGS.indices}) var<storage, read> meshIndices: array<u32>;\n`,
    `@group(0) @binding(${MESH_BINDINGS.normals}) var<storage, read> meshNormals: array<vec3f>;\n`,
    mesh.uv ? `@group(0) @binding(${MESH_BINDINGS.uvs}) var<storage, read> meshUvs: array<vec2f>;\n` : "",
    mesh.surface ? `@group(0) @binding(${MESH_BINDINGS.surface}) var<storage, read> meshSurface: array<vec4f>;\n` : "",
    mesh.emissive ? `@group(0) @binding(${MESH_BINDINGS.emissive}) var<storage, read> meshEmissive: array<vec3f>;\n` : "",
    FACE_VIEWER_WGSL,
  ].join("");
}

/** B227: the normal of the side the viewer sees. */
const FACE_VIEWER_WGSL = "fn faceViewer(n: vec3f, toEye: vec3f) -> vec3f { return select(-n, n, dot(n, toEye) >= 0.0); }\n";

/**
 * T1581b: an instanced draw's storage — the index list, the buffers bound whole, and one
 * accessor per attribute read. `instanceSlot` is the ONE place a drawn instance index
 * becomes a record slot. For a geometry that leaves instances out (F1) it reads the
 * records' `visible` list, the slots of the instances that are drawn; the draw's count is
 * that list's length, so a rejected instance runs no vertex. For one that draws every point
 * it is the identity. Nothing else here has to know which.
 */
function instancedStorageWgsl(instanced: Pick<SceneInstancedOption, "groups" | "position" | "record"> & Partial<SceneInstancedOption>): string {
  const read = (name: string, attribute: PackedRead | undefined): string =>
    attribute === undefined ? "" : `${packedAccessorWgsl(name, INSTANCED_BINDING_PREFIX, attribute)}\n`;
  const row = (name: string, offset: number): string => read(name, { group: instanced.record.group, offset, type: "vec4f" });
  return [
    `@group(0) @binding(${MESH_BINDINGS.indices}) var<storage, read> meshIndices: array<u32>;\n`,
    packedBindingsWgsl(INSTANCED_BINDING_PREFIX, instanced.groups, INSTANCED_BINDING_BASE),
    read("meshPositionAt", instanced.position),
    read("meshNormalAt", instanced.normal),
    read("meshUvAt", instanced.uv),
    read("meshColorAt", instanced.color),
    read("meshSurfaceAt", instanced.surface),
    read("meshEmissiveAt", instanced.emissive),
    row("recordM0", instanced.record.m0),
    row("recordM1", instanced.record.m1),
    row("recordM2", instanced.record.m2),
    instanced.record.tint === undefined ? "" : row("recordTint", instanced.record.tint),
    instanced.record.visible === undefined
      ? "fn instanceSlot(drawn: u32) -> u32 { return drawn; }\n"
      : read("instanceSlot", { group: instanced.record.group, offset: instanced.record.visible, type: "u32" }),
  ].join("");
}

/** The world position of a shape-local point under the record's three rows. */
const RECORD_PLACE_WGSL = `  let slot = instanceSlot(drawn);
  /* The record is Object · Instance, resolved once this frame (instance-resolve.wgsl.ts). */
  let r0 = recordM0(slot);
  let r1 = recordM1(slot);
  let r2 = recordM2(slot);`;

/**
 * T1581b — the INSTANCED mesh chunk: the indexed chunk's fetch, placed by the instance's
 * record instead of the model uniform. Same VertexOut fields, so the fragment stage is the
 * surface's own. The tint is the shape's colour times the instance's.
 */
function meshInstancedVertexWgsl(instanced: SceneInstancedOption, carriesLocal: boolean): EmittedWgsl {
  const tint = [instanced.color === undefined ? "" : "meshColorAt(index)", instanced.record.tint === undefined ? "" : "recordTint(slot)"].filter((term) => term !== "").join(" * ");
  return wgsl`struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) world: vec3f,
  @location(2) uv: vec2f,
  @location(3) tint: vec4f,
  @location(4) surface: vec4f,
  @location(5) emissive: vec3f,
${carriesLocal ? `${LOCAL_VARYINGS}  @location(8) @interpolate(flat) slot: u32,\n` : ""}};

@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) drawn: u32) -> VertexOut {
${RECORD_PLACE_WGSL}
  let index = meshIndices[vertex];
  let local = meshPositionAt(index);
  let localNormal = meshNormalAt(index);
  let world = vec3f(dot(r0, vec4f(local, 1.0)), dot(r1, vec4f(local, 1.0)), dot(r2, vec4f(local, 1.0)));
  /* The normal takes the inverse transpose's direction: the cofactor of the record's 3x3
     (its rows are r1×r2, r2×r0, r0×r1) times the sign of its determinant, made unit HERE so
     a very small instance does not reach the fragment stage's zero-length guard. An
     instance that is not drawn has a zero record: a zero normal, on triangles with no area. */
  let c0 = cross(r1.xyz, r2.xyz);
  let c1 = cross(r2.xyz, r0.xyz);
  let c2 = cross(r0.xyz, r1.xyz);
  let turned = vec3f(dot(c0, localNormal), dot(c1, localNormal), dot(c2, localNormal)) * select(-1.0, 1.0, dot(r0.xyz, c0) >= 0.0);
  let turnedLength = length(turned);
  var out: VertexOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  out.normal = select(vec3f(0.0), turned / max(turnedLength, 1e-30), turnedLength > 0.0);
  out.world = world;${carriesLocal ? "\n  out.local = local;\n  out.localNormal = localNormal;\n  out.slot = slot;" : ""}
  out.uv = ${instanced.uv === undefined ? "vec2f(0.0)" : "meshUvAt(index)"};
  out.tint = ${tint === "" ? "vec4f(1.0)" : tint};
  out.surface = ${instanced.surface === undefined ? "vec4f(0.0)" : "meshSurfaceAt(index)"};
  out.emissive = ${instanced.emissive === undefined ? "vec3f(0.0)" : "meshEmissiveAt(index)"};
  return out;
}`;
}

/** A number as a WGSL float literal: a light's Shadow Bias in world units (T1438b), an instance field's default (T1581b). */
function biasLiteral(metres: number): string {
  const text = String(metres);
  return /[.e]/.test(text) ? text : `${text}.0`;
}

/**
 * T481/T1285 — the shadow term for one slot, SHARED VERBATIM by the surface and the
 * instances generators (§V349, the rule FRESNEL_WGSL and INSTANCE_SHAPES_WGSL already
 * live under). The two copies of this block were identical to the byte before PCF; a
 * kernel that landed in one of them would have put a soft edge on E28's floor and a
 * hard one on the three boxes standing in the middle of it.
 *
 * `radius` is the light's Shadow Softness in SHADOW-MAP TEXELS. r taps out to (2r+1)²
 * loads on the integer texel grid, box-averaged, so the penumbra a straight edge gets
 * is 2r+1 texels wide with 2r+1 distinct levels across it — a RAMP, not a dimming: the
 * fully-occluded interior still reads 0 and the fully-lit side still reads 1, which is
 * exactly what a uniformly darker shadow would not do. r = 0 emits the pre-T1285 text
 * byte for byte (§V309): turning the knob down is turning the feature OFF, not
 * approximating it with one tap of a loop.
 *
 * THE BIAS, AND WHAT PCF DID TO IT — said out loud rather than quietly retuned. T624's
 * `0.0015 + 0.012·(1−λ)` is kept EXACTLY, and at r = 0 the emitted text is that line to
 * the byte. But a wider kernel compares the receiver's OWN depth against stored depths up
 * to r texels away, and on a planar receiver those differ by r × (the depth grown over one
 * texel) — which is precisely what the slope term measures. Left unscaled it is not enough:
 * measured on `scene-shadow-pcf.gpu.test.ts`'s flat floor under a 45° key, r = 2 speckled
 * the lit floor and r = 3 darkened ALL of it by ~5%, both of them PCF self-shadowing, not
 * penumbra. So the slope term — and only it, never the constant — is multiplied by the
 * kernel's reach r+1. That is a derivation from the term's own meaning, not a fitted
 * number, and the gate holds it: the lit floor's luma is identical at r = 0, 1, 2 and 3.
 *
 * The bias stays OUTSIDE the loop: it is a property of the receiver, and every tap
 * comparing one receiver depth against a different stored depth is what makes the average
 * a coverage fraction rather than a blur.
 *
 * Outside the volume (uv or depth out of range) means UNSHADOWED: the volume is
 * explicit (V426), and beyond it the light simply shines.
 */
/**
 * T1362b — the shadow term of a POINT light's slot: pick the cube face by the dominant axis
 * of light → fragment, project with that face's own matrix (the one the sweep drew it with),
 * and compare RADIAL distance ÷ range against the atlas tile, PCF taps clamped inside the
 * tile so a kernel never reads a neighbouring face. Beyond the range the light is too faint
 * to matter and the fragment is unshadowed.
 *
 * The bias is measured in SHADOW-MAP TEXELS at the fragment, not in a share of the range: a
 * face texel covers 2·d ÷ tile metres at distance d, so the bias is one texel plus the slope
 * term over the kernel's reach, converted to the stored units (÷ range). A fixed share of
 * the range grows with it — at an 80 m range it was over a metre, thicker than a furnace
 * shell, and the arc shone through the wall it sits behind.
 */
function pointShadowFactorWgsl(slot: number, radius: number, extraBias = 0): EmittedWgsl {
  const r = Math.max(0, Math.min(4, Math.floor(radius)));
  const extra = extraBias > 0 ? ` + ${biasLiteral(extraBias)}` : "";
  const taps = (2 * r + 1) * (2 * r + 1);
  const faceCases = [1, 2, 3, 4, 5].map((face) => `        case ${face}u: { faceMatrix = params.shadow${slot}Face${face}; }`).join("\n");
  return wgsl`    var shadow = 1.0;
    {
      let lightToFragment = input.world - params.shadow${slot}Light.xyz;
      let current = length(lightToFragment) / max(params.shadow${slot}Light.w, 1e-4);
      if (current < 1.0) {
        let axes = abs(lightToFragment);
        var face = 0u;
        if (axes.x >= axes.y && axes.x >= axes.z) {
          face = select(1u, 0u, lightToFragment.x > 0.0);
        } else if (axes.y >= axes.z) {
          face = select(3u, 2u, lightToFragment.y > 0.0);
        } else {
          face = select(5u, 4u, lightToFragment.z > 0.0);
        }
        var faceMatrix = params.shadow${slot}Face0;
        switch face {
${faceCases}
          default: {}
        }
        let sc = faceMatrix * vec4f(input.world, 1.0);
        let suv = clamp(vec2f(sc.x / sc.w * 0.5 + 0.5, 0.5 - sc.y / sc.w * 0.5), vec2f(0.0), vec2f(1.0));
        let atlas = vec2f(textureDimensions(shadowMap${slot}, 0));
        let tile = floor(atlas / vec2f(3.0, 2.0));
        let origin = vec2i(vec2f(f32(face % 3u), f32(face / 3u)) * tile);
        let last = origin + vec2i(tile) - vec2i(1);
        let centre = origin + vec2i(suv * (tile - vec2f(1.0)));
        let texelWorld = 2.0 * length(lightToFragment) / max(tile.y, 1.0);
        let bias = (texelWorld * (1.0 + 2.0 * (1.0 - lambert) * ${r + 1}.0) + 1e-3${extra}) / max(params.shadow${slot}Light.w, 1e-4);
        var lit = 0.0;
        for (var oy = -${r}; oy <= ${r}; oy = oy + 1) {
          for (var ox = -${r}; ox <= ${r}; ox = ox + 1) {
            let stored = textureLoad(shadowMap${slot}, clamp(centre + vec2i(ox, oy), origin, last), 0).r;
            lit = lit + select(1.0, 0.0, current - bias > stored);
          }
        }
        shadow = lit / ${taps}.0;
      }
    }
`;
}

function shadowFactorWgsl(slot: number, radius: number, extraBias = 0): EmittedWgsl {
  const r = Math.max(0, Math.floor(radius));
  /* T1438b: metres → this map's depth units. The ortho volume's depth is linear, and the
     length of the matrix's z ROW is exactly 1 ÷ (far − near), so the conversion needs no
     new uniform and follows Shadow Extent as it animates. */
  const extra =
    extraBias > 0
      ? ` + ${biasLiteral(extraBias)} * length(vec3f(params.shadow${slot}Matrix[0].z, params.shadow${slot}Matrix[1].z, params.shadow${slot}Matrix[2].z))`
      : "";
  /* The reach factor is r+1 texels — see the docblock. It is a substitution in CODE, never
     inside the emitted comment (§V685's gate: a `${…}` hidden in a WGSL comment runs
     without showing). The note below is therefore a fixed string, chosen rather than
     interpolated. */
  const reach = r === 0 ? "" : ` * ${r + 1}.0`;
  const reachNote =
    r === 0
      ? ""
      : `        /* T1285: the SLOPE TERM — and only it — is multiplied by the kernel's REACH
           in texels. That term IS "depth grown over one texel"; a kernel that samples r
           texels out compares the receiver's own depth against stored depths r texels
           away, so the allowance has to cover r+1 of them or every planar receiver
           self-shadows. Measured, not guessed: on scene-shadow-pcf.gpu.test.ts's flat
           floor under a 45 degree key, r = 3 without this factor darkened the WHOLE lit
           floor by 5% and r = 2 speckled it; with it both are clean, and the constant
           T624 measured is untouched at r = 0. */
`;
  const bias = `${reachNote}        /* T624 look pass: a CONSTANT bias acnes at the terminator, and every curved
           object has one. Depth per shadow texel grows as 1/|N·L|, so the bias has to
           grow with it — measured on E33, where 0.002 flat put a dotted crescent across
           the lit half of a medallion and this removes it without visible peter-panning
           (the slope term only reaches its maximum where the light is already grazing
           and the surface is dark anyway). */
        let bias = 0.0015 + 0.012 * (1.0 - lambert)${reach}${extra};
`;
  const head = `    var shadow = 1.0;
    {
      let sc = params.shadow${slot}Matrix * vec4f(input.world, 1.0);
      let suv = vec2f(sc.x * 0.5 + 0.5, 0.5 - sc.y * 0.5);
      if (suv.x >= 0.0 && suv.x <= 1.0 && suv.y >= 0.0 && suv.y <= 1.0 && sc.z <= 1.0) {
        let sdims = vec2f(textureDimensions(shadowMap${slot}, 0));
`;
  if (r === 0) {
    return wgsl`${head}        let stored = textureLoad(shadowMap${slot}, vec2i(suv * (sdims - vec2f(1.0))), 0).r;
${bias}        if (sc.z - bias > stored) { shadow = 0.0; }
      }
    }
`;
  }
  const taps = (2 * r + 1) * (2 * r + 1);
  /* Clamped to the map's own edge rather than treated as out-of-volume: a receiver one
     texel inside the border would otherwise take a partly-lit average from taps that
     fell off the map, which reads as a bright fringe all the way round the volume. */
  return wgsl`${head}        let scentre = vec2i(suv * (sdims - vec2f(1.0)));
        let slast = vec2i(sdims) - vec2i(1);
${bias}        var slit = 0.0;
        for (var oy = -${r}; oy <= ${r}; oy = oy + 1) {
          for (var ox = -${r}; ox <= ${r}; ox = ox + 1) {
            let stored = textureLoad(shadowMap${slot}, clamp(scentre + vec2i(ox, oy), vec2i(0), slast), 0).r;
            slit = slit + select(1.0, 0.0, sc.z - bias > stored);
          }
        }
        shadow = slit / ${taps}.0;
      }
    }
`;
}

export function sceneSurfaceWgsl(options: SceneShadingOptions): EmittedWgsl {
  return sceneSurfaceModule(options).wgsl;
}

/**
 * T1535b: the surface module, and where a custom material's two texts start in it — its
 * `struct Params` declaration (absent when the author wrote none: the stand-in is the
 * generator's) and its `code`. Only this generator knows; the Scene node moves the
 * material's own source map there.
 */
export interface SceneSurfaceModule {
  readonly wgsl: EmittedWgsl;
  readonly placed: { readonly params?: WgslPosition; readonly code?: WgslPosition };
}

export const sceneSurfaceModule = generatedOnce("sceneSurfaceModule", buildSceneSurfaceModule);
function buildSceneSurfaceModule(options: SceneShadingOptions): SceneSurfaceModule {
  const lightCount = Math.max(0, Math.floor(options.lightCount));
  const pointColor = options.pointColor === true;
  const albedoMap = options.maps?.albedo === true;
  const roughnessMap = options.maps?.roughness === true;
  const shadows = options.shadows ?? [];
  const shadowSlotOf = (index: number): number => shadows.indexOf(index);
  const pointSlots = new Set(options.pointShadows ?? []);
  const shadowFields = shadows
    .map((_, slot) =>
      pointSlots.has(slot)
        ? `  shadow${slot}Light: vec4f,\n${[0, 1, 2, 3, 4, 5].map((face) => `  shadow${slot}Face${face}: mat4x4f,\n`).join("")}`
        : `  shadow${slot}Matrix: mat4x4f,\n`,
    )
    .join("");
  const shadowBindings = shadows
    .map((_, slot) => `@group(0) @binding(${5 + slot}) var shadowMap${slot}: texture_2d<f32>;\n`)
    .join("");
  /* T1285: the tap set is the light's own Shadow Softness, by slot. */
  const shadowFactor = (index: number): string => {
    const slot = shadowSlotOf(index);
    if (slot < 0) return "";
    return pointSlots.has(slot)
      ? pointShadowFactorWgsl(slot, options.shadowSoftness?.[slot] ?? 0, options.shadowBias?.[slot] ?? 0)
      : shadowFactorWgsl(slot, options.shadowSoftness?.[slot] ?? 0, options.shadowBias?.[slot] ?? 0);
  };
  const environment = options.environment === true && lit(options.model);
  /* T1289: the shipped default is 8 — measured enough to read as a blur at roughness 1
     without the cost of a pyramid, and cheap enough that a scene already paying for
     shadows does not notice it. Clamped because a tap count is a loop bound in generated
     WGSL: 0 would silently turn the cone back into the sharp sample this row removed. */
  const envTaps = Math.min(32, Math.max(1, Math.round(options.environmentTaps ?? 8)));
  const envBinding = 5 + shadows.length;
  /* T1427b: the atlas binds right after the sharp map, so every later binding shifts by one
     only when it is on. */
  const prefiltered = environment && options.environmentPrefiltered === true;
  const envDeclarations = environment
    ? `@group(0) @binding(${envBinding}) var environmentMap: texture_2d<f32>;\n${ENV_SAMPLE_WGSL}${prefiltered ? envPrefilteredLookupWgsl(envBinding + 1) : ENV_CONE_WGSL(envTaps)}`
    : "";
  const envField = environment ? "  environment: vec4f,   // x = intensity\n" : "";
  /* Equirect, documented exactly: u = atan2(R.x, −R.z)/2π + 0.5, v = acos(R.y)/π. */
  /* T624: bound after the environment, so a scene without AO emits the same bindings
     it always did and a scene with it needs no renumbering of the shadow slots. */
  const ambientOcclusion = options.ambientOcclusion === true && options.model !== "unlit";
  const aoBinding = envBinding + (environment ? 1 : 0) + (prefiltered ? 1 : 0);
  const aoDeclarations = ambientOcclusion
    ? `@group(0) @binding(${aoBinding}) var occlusionMap: texture_2d<f32>;\n`
    : "";
  const aoTerm = ambientOcclusion ? " * occlusion" : "";
  /* T704: projectors are LIGHTS, so an unlit material takes none (mirrors the light
     blocks, which unlit never reaches). Bound after the AO map. */
  const projectors = projectorBlocks(
    options.model === "unlit" ? [] : options.projectors ?? [],
    aoBinding + (ambientOcclusion ? 1 : 0),
  );
  const envTerm = environment
    ? `  let envColor = ${prefiltered ? "sampleEnvironmentPrefiltered" : "sampleEnvironmentCone"}(reflect(-viewDir, normal), roughness * roughness);
${FRESNEL_WGSL}  lit += envColor * params.specular.rgb * envFresnel * params.environment.x${aoTerm};
${prefiltered ? IRRADIANCE_PREFILTERED_WGSL : IRRADIANCE_WGSL}  lit += irradiance * albedo.rgb * (1.0 - envFresnel) * (1.0 - params.material.x) * params.environment.x${aoTerm};
`
    : "";


  /* Lights as GENERATED SCALAR MEMBERS — three vec4 rows per light (meta / colour /
     vector) with the index in the NAME. The count is structural anyway (a new light
     recompiles), and named members keep the uniform writer on the plainest possible
     path: vgpu writes by name, and a named vec4 is the one shape every reflector
     agrees on. */
  const lightField = Array.from({ length: lightCount }, (_, index) =>
    `  light${index}Meta: vec4f,\n  light${index}Color: vec4f,\n  light${index}Vector: vec4f,\n`,
  ).join("");

  /* Maps read with textureLoad (the T262 bridge's precedent): draw passes carry no
     sampler slot, and a texel fetch keeps unfilterable formats working on Tier B. */
  const mapBindings = [
    albedoMap ? `@group(0) @binding(3) var albedoMap: texture_2d<f32>;\n` : "",
    roughnessMap ? `@group(0) @binding(${albedoMap ? 4 : 3}) var roughnessMap: texture_2d<f32>;\n` : "",
  ].join("");

  const mapLoad = (name: string): string =>
    `textureLoad(${name}, vec2i(clamp(input.uv, vec2f(0.0), vec2f(1.0)) * (vec2f(textureDimensions(${name})) - vec2f(1.0))), 0)`;

  const albedoExpr = `${albedoMap ? `params.baseColor * ${mapLoad("albedoMap")}` : "params.baseColor"}${pointColor ? " * input.tint" : ""}`;
  /* T1353b: a mesh with a `surface` row carries its OWN roughness and metallic per
     vertex (the file's material, flattened), and the pbr F0 follows its metallic — the
     same mix(white, albedo, metallic) the CPU does per object, done per fragment. The
     generated terms below read three names; in mesh mode they are rebound to locals.
     Grid surfaces never reach this and emit their text unchanged. */
  const meshSurface = options.mesh?.surface === true;
  const custom = options.custom;
  /* T1581b: an instanced draw needs the mesh options it rides on. */
  const instanced = options.mesh === undefined ? undefined : options.instanced;
  /* Only PBR derives its specular tint from metallic (the CPU does the same per object);
     Phong's specular colour is AUTHORED, so it stays the material's own. */
  const perVertex = (text: string): string => {
    if (!meshSurface && custom === undefined) return text;
    const metallic = text.replaceAll("params.material.x", "surfaceMetallic");
    return options.model === "pbr" ? metallic.replaceAll("params.specular.rgb", "surfaceSpecular") : metallic;
  };
  const roughnessBase = meshSurface ? "clamp(input.surface.x, 0.04, 1.0)" : "params.material.y";
  const roughnessExpr = roughnessMap
    ? `clamp(${roughnessBase} * ${mapLoad("roughnessMap")}.r, 0.04, 1.0)`
    : roughnessBase;

  const lightBlock = (index: number): string => `  {
    let lightMeta = params.light${index}Meta;
    let lightColor = params.light${index}Color;
    let lightVector = params.light${index}Vector;
    var toLight: vec3f;
    var attenuation = 1.0;
    if (lightMeta.x < 0.5) {
      toLight = normalize(-lightVector.xyz);
    } else {
      let offset = lightVector.xyz - input.world;
      let distance = max(length(offset), 1e-4);
      toLight = offset / distance;
${POINT_FALLOFF_WGSL}    }
${
  options.mesh === undefined
    ? `    /* Two-sided lambert: a surface has no wrong side (T301's rule, kept). */
    let lambert = abs(dot(normal, toLight));
`
    : `    /* B227: a FILE mesh has authored sides — its normal already faces the viewer, and the
       side facing away from the light is dark (else a wall glows inside where the sun
       strikes its outside). */
    let lambert = max(dot(normal, toLight), 0.0);
`
}${shadowFactor(index)}    let radiance = lightColor.rgb * lightMeta.y * attenuation${shadowSlotOf(index) >= 0 ? " * shadow" : ""}${options.mesh === undefined ? "" : " * sign(lambert)"};
${
  options.model === "pbr"
    ? ggxSpecularWgsl("roughness") +
      /* The diffuse half, AFTER the lobe so it can read `fresnel`: energy the facets sent
         back specularly is not available to the body of the material, and a metal has no
         diffuse lobe at all. This is the line that makes `metallic` a physical quantity
         per light rather than a tint (T1284). */
      `    lit += albedo.rgb * radiance * lambert * (vec3f(1.0) - fresnel) * (1.0 - params.material.x);
`
    : `    lit += albedo.rgb * radiance * lambert;
` +
      (options.model === "phong"
        ? `    let halfway = normalize(toLight + viewDir);
    let gloss = max(2.0, params.specular.w * (1.0 - roughness));
    let highlight = pow(abs(dot(normal, halfway)), gloss);
    lit += params.specular.rgb * radiance * highlight;
`
        : "")
}  }
`;

  const needsViewDir = lightCount > 0 || environment;
  const emissiveTerm =
    custom !== undefined ? "  lit += shaded.emissive;\n" : options.mesh?.emissive === true ? "  lit += input.emissive;\n" : "";
  const aoLookup = ambientOcclusion
    ? `  let occlusion = textureLoad(occlusionMap, vec2i(input.position.xy), 0).r;\n`
    : "";
  /* T1411b: an additive draw writes alpha 0 — the one/one blend then keeps dst coverage. */
  const alphaOut = options.additive === true ? "0.0" : "albedo.a * cover";
  const shading =
    options.model === "unlit"
      ? custom !== undefined
        ? `  return vec4f((albedo.rgb + shaded.emissive) * cover, ${alphaOut});`
        : options.mesh?.emissive === true
        ? `  return vec4f((albedo.rgb + input.emissive) * cover, ${alphaOut});`
        : `  return vec4f(albedo.rgb * cover, ${alphaOut});`
      : `${aoLookup}  let ambient = params.ambientColor.rgb * params.ambientColor.a${aoTerm};
  var lit = albedo.rgb * ambient;
${
  !needsViewDir
    ? ""
    : `  let viewDir = normalize(params.eye.xyz - input.world);
${Array.from({ length: lightCount }, (_, index) => perVertex(lightBlock(index))).join("")}`
}${projectors.term}${perVertex(envTerm)}${emissiveTerm}  return vec4f(lit * cover, ${alphaOut});`;
  /* T1355b — the custom surface: its uniform members, its module text, and the fragment
     head that calls it. Without `custom` the head is the stock text, character for
     character, so every existing scene's shader is unchanged. */
  const customFields =
    custom === undefined
      ? ""
      : custom.fields.map((field) => `  ${materialParamUniformKey(field.name)}: ${field.wgsl},\n`).join("");
  const customParamsDeclaration =
    custom === undefined ? "" : custom.paramsDeclaration === "" ? "struct Params {\n  unused: f32,\n};" : custom.paramsDeclaration;
  const customHead = custom?.instance === undefined ? CUSTOM_SURFACE_HEAD : CUSTOM_SURFACE_HEAD_WITH_INSTANCE;
  const customDeclarations = custom === undefined ? "" : `${customHead}${customParamsDeclaration}\n\n${custom.code}\n`;
  /* T1581b (D9): the material's `struct Instance`, filled per fragment. A field the geometry
     bound is read from the instance's record at the slot the vertex stage passed down (one
     flat u32, so the field count is not an inter-stage budget); the rest are constants. */
  const boundFields = instanced?.record.fields ?? {};
  const instanceFields = custom?.instance ?? [];
  const instanceAccessors =
    instanced === undefined
      ? ""
      : instanceFields
          .flatMap((field) => {
            const stored = boundFields[field.name];
            return stored === undefined
              ? []
              : [`${packedAccessorWgsl(instanceFieldAccessor(field.name), INSTANCED_BINDING_PREFIX, { group: instanced.record.group, offset: stored.offset, type: stored.type })}\n`];
          })
          .join("");
  const instanceFill =
    custom?.instance === undefined
      ? ""
      : `  surfaceIn.instance = Instance(${instanceFields
          .map((field) => (instanced !== undefined && boundFields[field.name] !== undefined ? `${instanceFieldAccessor(field.name)}(input.slot)` : instanceDefaultWgsl(field.wgsl, field.default)))
          .join(", ")});\n`;
  const customParams =
    custom === undefined || custom.fields.length === 0
      ? "Params(0.0)"
      : `Params(${custom.fields.map((field) => `params.${materialParamUniformKey(field.name)}`).join(", ")})`;
  const unlitModel = options.model === "unlit";
  /* B227: a file mesh's normal turned to face the viewer, so its back side reads as the
     side it is — the one-sided lambert below then lights only what faces the light. */
  const meshFacing = (expression: string): string =>
    options.mesh === undefined ? expression : `faceViewer(${expression}, params.eye.xyz - input.world)`;
  const fragmentHead =
    custom === undefined
      ? `  let magnitude = length(input.normal);
  let normal = ${meshFacing("select(vec3f(0.0, 0.0, 1.0), input.normal / max(magnitude, 1e-6), magnitude > 1e-6)")};
  /* T917: the soft profile lives on the point primitives; a SURFACE has no across axis,
     so its coverage is the constant 1 and the shared shading tail multiplies by nothing. */
  let cover = 1.0;
  let albedo = ${albedoExpr};
${unlitModel ? "" : `  let roughness = ${roughnessExpr};\n  _ = roughness;\n`}`
      : `  let magnitude = length(input.normal);
  let geometryNormal = ${meshFacing("select(vec3f(0.0, 0.0, 1.0), input.normal / max(magnitude, 1e-6), magnitude > 1e-6)")};
  let cover = 1.0;
  var surfaceIn: SurfaceIn;
  surfaceIn.world = input.world;
  surfaceIn.normal = geometryNormal;
  surfaceIn.uv = input.uv;
  surfaceIn.tint = input.tint;
  surfaceIn.attr = ${meshSurface ? "input.surface" : "vec4f(params.material.y, params.material.x, 0.0, 0.0)"};
  surfaceIn.emissive = ${options.mesh?.emissive === true ? "input.emissive" : "vec3f(0.0)"};
  surfaceIn.eye = params.eye.xyz;
  surfaceIn.albedo = ${albedoExpr};
  surfaceIn.roughness = ${roughnessExpr};
  surfaceIn.metallic = ${meshSurface ? "clamp(input.surface.y, 0.0, 1.0)" : "params.material.x"};
  surfaceIn.absTime = ${CUSTOM_SURFACE_FRAME_BINDING}.absTime;
  surfaceIn.footprint = length(fwidth(input.world));
  surfaceIn.curvature = length(fwidth(geometryNormal)) / max(surfaceIn.footprint, 1e-5);
  let localLength = length(input.localNormal);
  surfaceIn.local = input.local;
  surfaceIn.localNormal = select(vec3f(0.0, 0.0, 1.0), input.localNormal / max(localLength, 1e-6), localLength > 1e-6);
  surfaceIn.instanceId = ${instanced === undefined ? "0u" : "input.slot"};
${instanceFill}  let shaded = surface(surfaceIn, ${customParams});
  let shadedLength = length(shaded.normal);
  let normal = select(geometryNormal, shaded.normal / max(shadedLength, 1e-6), shadedLength > 1e-6);
  _ = normal;
  let albedo = shaded.albedo;
${unlitModel ? "" : `  let roughness = clamp(shaded.roughness, 0.04, 1.0);
  _ = roughness;
  let surfaceMetallic = clamp(shaded.metallic, 0.0, 1.0);
  let surfaceSpecular = mix(vec3f(1.0), albedo.rgb, surfaceMetallic);
  _ = surfaceSpecular;
`}`;
  const surfaceLocals = meshSurface && custom === undefined && options.model !== "unlit"
    ? `  let surfaceMetallic = clamp(input.surface.y, 0.0, 1.0);
  let surfaceSpecular = mix(vec3f(1.0), albedo.rgb, surfaceMetallic);
  _ = surfaceSpecular;
`
    : "";

  /* T1414b: the SHADOW MATTE layer — for the first three casting lights, the lit block's
     own toward-light and lambert (the bias reads it) and its own shadow test, written as
     1 − shadow in r, g, b; a = 1 marks a surface. */
  const shadowMatteWrite = (): string =>
    `  var matte = vec3f(0.0);
${shadows
  .slice(0, 3)
  .map(
    (index, channel) => `  {
    let lightMeta = params.light${index}Meta;
    let lightVector = params.light${index}Vector;
    var toLight = normalize(-lightVector.xyz);
    if (lightMeta.x >= 0.5) { toLight = normalize(lightVector.xyz - input.world); }
    let lambert = ${options.mesh === undefined ? "abs(dot(normal, toLight))" : "max(dot(normal, toLight), 0.0)"};
${shadowFactor(index)}    matte.${"xyz"[channel]} = 1.0 - shadow;
  }
`,
  )
  .join("")}  return vec4f(matte, 1.0);`;
  const gbufferMetallic =
    options.model === "unlit" ? "0.0" : custom !== undefined ? "surfaceMetallic" : meshSurface ? "clamp(input.surface.y, 0.0, 1.0)" : "params.material.x";
  const gbufferWrite =
    options.gbuffer === "normal"
      ? `  return vec4f(normal * 0.5 + vec3f(0.5), ${options.model === "unlit" ? "1.0" : "max(roughness, 0.04)"});`
      : options.gbuffer === "albedo"
        ? `  return vec4f(albedo.rgb, ${gbufferMetallic});`
        : options.gbuffer === "shadow"
          ? shadowMatteWrite()
          : undefined;

  /* T1535b: split where the custom texts are pasted, byte-identical to the one template it
     was, so their start is read off the text in front of them (each piece is the `wgsl`
     tag's cached string, so the position memo hits frame after frame). */
  /* T1581b: an instanced draw is placed by its records (the object transform is already in
     them), so it declares neither the model uniforms nor the per-attribute bindings. */
  const modelFields = instanced === undefined ? "  model: mat4x4f,           // T1588b: the object transform\n  modelNormal: mat4x4f,     // its normal matrix (upper 3x3)\n" : "";
  const pointBindings =
    instanced === undefined
      ? `@group(0) @binding(1) var<storage, read> positions: array<vec3f>;\n${pointColor ? "@group(0) @binding(2) var<storage, read> pointColors: array<vec4f>;\n" : ""}`
      : "";
  const meshDeclarations =
    options.mesh === undefined ? "" : instanced === undefined ? meshBindingsWgsl(options.mesh) : `${instancedStorageWgsl(instanced)}${instanceAccessors}${FACE_VIEWER_WGSL}`;
  const vertexStage =
    options.mesh === undefined
      ? surfaceMeshWgsl(pointColor, custom !== undefined)
      : instanced === undefined
        ? meshVertexWgsl(pointColor, options.mesh, custom !== undefined)
        : meshInstancedVertexWgsl(instanced, custom !== undefined);
  const top = wgsl`struct SceneParams {
  viewProjection: mat4x4f,
${modelFields}  eye: vec4f,
  ambientColor: vec4f,      // rgb colour, a = intensity
  baseColor: vec4f,
  specular: vec4f,          // rgb specular colour, w = shininess
  material: vec4f,          // x = metallic, y = roughness, zw reserved
  grid: vec4f,              // cols, rows, wrapU, wrapV
${lightField}${shadowFields}${envField}${projectors.fields}${customFields}};

@group(0) @binding(0) var<uniform> params: SceneParams;
${pointBindings}${mapBindings}${shadowBindings}${envDeclarations}${aoDeclarations}${projectors.bindings}${meshDeclarations}`;
  const text = wgsl`${top}${customDeclarations}
${vertexStage}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
${fragmentHead}${gbufferWrite ?? `${surfaceLocals}${shading}`}
}`;
  if (custom === undefined) return { wgsl: text, placed: {} };
  const params = advance(endOf(top), customHead);
  return {
    wgsl: text,
    placed: {
      ...(custom.paramsDeclaration === "" ? {} : { params }),
      code: advance(advance(params, customParamsDeclaration), "\n\n"),
    },
  };
}

/**
 * T428(b): the INSTANCES variant — the T299 primitive mesh (quad/box/octahedron from
 * the vertex index, per-instance translate from the SoA position buffer, analytic
 * shape normals) shaded through the same generated material/light block the surface
 * uses. The legacy renderInstances shader stays byte-identical; this serves the scene
 * Render only. Maps are refused upstream for instances (no uv yet), so this generator
 * takes no map options.
 */
/**
 * T725 — the instance PRIMITIVES chunk (quad/box/octahedron from the vertex index,
 * analytic normals), extracted verbatim so the lit generator and the glass generator
 * share one source (§V349). Byte-identical to the pre-extraction inline text.
 */
/**
 * T1063 — exported: interpolated everywhere a shader draws instance shapes (this
 * file's lit/glass/shadow variants, `render-instances`, the scene-preview stock
 * box), because the copies had already diverged once (a local renamed to `sign`,
 * shadowing the WGSL builtin) and a fourth shape added to one copy would render
 * as a box in every other.
 */
export const INSTANCE_SHAPES_WGSL = wgsl`fn quadCorner(v: u32) -> vec2f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return corners[v];
}

fn shapeVertexCount(shape: u32) -> u32 {
  if (shape == 0u) { return 6u; }
  if (shape == 2u) { return 24u; }
  return 36u;
}

fn boxVertex(v: u32) -> vec3f {
  let face = v / 6u;
  let corner = quadCorner(v % 6u);
  let flip = f32(face % 2u) * 2.0 - 1.0;
  let axis = face / 2u;
  if (axis == 0u) { return vec3f(flip, corner.x * flip, corner.y); }
  if (axis == 1u) { return vec3f(corner.x, flip, corner.y * flip); }
  return vec3f(corner.x * flip, corner.y, flip);
}

fn boxNormal(v: u32) -> vec3f {
  let face = v / 6u;
  let flip = f32(face % 2u) * 2.0 - 1.0;
  let axis = face / 2u;
  if (axis == 0u) { return vec3f(flip, 0.0, 0.0); }
  if (axis == 1u) { return vec3f(0.0, flip, 0.0); }
  return vec3f(0.0, 0.0, flip);
}

fn octaVertex(v: u32) -> vec3f {
  let face = v / 3u;
  let sx = f32(face & 1u) * 2.0 - 1.0;
  let sy = f32((face >> 1u) & 1u) * 2.0 - 1.0;
  let sz = f32((face >> 2u) & 1u) * 2.0 - 1.0;
  let corner = v % 3u;
  if (corner == 0u) { return vec3f(sx, 0.0, 0.0); }
  if (corner == 1u) { return vec3f(0.0, sy, 0.0); }
  return vec3f(0.0, 0.0, sz);
}

fn shapeVertex(shape: u32, v: u32) -> vec3f {
  if (shape == 0u) { return vec3f(quadCorner(v), 0.0); }
  if (shape == 2u) { return octaVertex(v); }
  return boxVertex(v);
}

fn shapeNormal(shape: u32, v: u32) -> vec3f {
  if (shape == 0u) { return vec3f(0.0, 0.0, 1.0); }
  if (shape == 2u) {
    let face = v / 3u;
    let sx = f32(face & 1u) * 2.0 - 1.0;
    let sy = f32((face >> 1u) & 1u) * 2.0 - 1.0;
    let sz = f32((face >> 2u) & 1u) * 2.0 - 1.0;
    return normalize(vec3f(sx, sy, sz));
  }
  return boxNormal(v);
}`;

/** T642: the group option both instance generators take — the draw and its shadow. */
export interface SceneGroupOption {
  expression: string;
  binds: ReadonlyArray<{ attribute: string; type: string }>;
}

/** The per-instance gate, emitted identically into the lit draw and the depth pass. */
function groupBlocks(
  group: SceneGroupOption | undefined,
  baseBinding: number,
  gatedReturn: string,
): { bindings: string; declarations: string; gate: string } {
  if (group === undefined) return { bindings: "", declarations: "", gate: "" };
  const bindings = group.binds
    .map(
      (bind, index) =>
        `@group(0) @binding(${baseBinding + index}) var<storage, read> group_${bind.attribute}: array<${bind.type}>;\n`,
    )
    .join("");
  const declarations = `
struct GroupPoint {
${group.binds.map((bind) => `  ${bind.attribute}: ${bind.type},`).join("\n")}
};

fn groupMatch(p: GroupPoint) -> bool {
  return (${group.expression});
}
`;
  const gate = `  var gp: GroupPoint;
${group.binds.map((bind) => `  gp.${bind.attribute} = group_${bind.attribute}[instance];`).join("\n")}
  if (!groupMatch(gp)) {
    /* Excluded: every vertex lands on one clip-space point — zero area, no cost (§V219). */
${gatedReturn}
  }
`;
  return { bindings, declarations, gate };
}

export const sceneInstancesWgsl = generatedOnce("sceneInstancesWgsl", buildSceneInstancesWgsl);
function buildSceneInstancesWgsl(options: {
  model: "unlit" | "lambert" | "phong" | "pbr";
  lightCount: number;
  /** Camera visibility depth uses the identical ribbon/billboard vertices and coverage. */
  cameraDepth?: boolean;
  /** T478: a vec4f attribute multiplies the base colour per point (the geometry's mapped tint). */
  pointColor?: boolean;
  /**
   * T721: an f32 attribute — or one channel of a float vector — multiplies the instance
   * SCALE per point, exactly as `pointColor` multiplies the base colour. Absent, not one
   * byte of this shader changes (§V309).
   */
  pointScale?: { type: string; channel?: string };
  /** T481: casting light indices — see SceneShadingOptions.shadows. */
  shadows?: ReadonlyArray<number>;
  /** T1285: PCF kernel radius per slot — see SceneShadingOptions.shadowSoftness. */
  shadowSoftness?: ReadonlyArray<number>;
  /** T1438b: extra receiver bias per slot, world units — see SceneShadingOptions.shadowBias. */
  shadowBias?: ReadonlyArray<number>;
  /** T1362b: shadow slots that are point lights (see SceneShadingOptions.pointShadows). */
  pointShadows?: ReadonlyArray<number>;
  /** T482: equirect environment wired — see SceneShadingOptions.environment. */
  environment?: boolean;
  /**
   * T1289 — how many taps the specular cone takes. A KNOB and not a constant, for
   * §T1285's reason: if a bright small light in an environment aliases at high roughness,
   * whoever finds it turns it up rather than editing a shader, and §T1293 gets a real
   * measurement to be gated on rather than an argument.
   */
  environmentTaps?: number;
  /** T1427b: see SceneShadingOptions.environmentPrefiltered. */
  environmentPrefiltered?: boolean;
  /** T624: an occlusion map is bound — see SceneShadingOptions.ambientOcclusion. */
  ambientOcclusion?: boolean;
  /** T704: referenced projectors — see SceneShadingOptions.projectors. */
  projectors?: ReadonlyArray<SceneProjectorOption>;
  /**
   * T642: §V471's selection idiom through the shared camera and depth buffer. The SAME
   * {expression, binds} `resolveGroupPredicate` hands renderPoints (§V349: one
   * resolver, one concept), executed as renderPoints executes it: a per-instance
   * vertex gate that collapses every excluded instance's vertices onto one point —
   * zero area, no discard, no indirect rewrite, no fragment work (§V219). Excluded
   * instances therefore cost `shapeVertexCount` trivial vertex invocations and
   * nothing else, which is why a predicate needed no T481/T624-style pricing (§V605).
   * Each referenced attribute is one storage buffer against the BASELINE 8 per stage.
   */
  group?: SceneGroupOption;
  /**
   * T647: POINTS mode — a camera-facing billboard per point through this same
   * machinery (same lights, same environment, same group gate — §V349: a third path
   * would have been born broken). The quad expands along camera right/up handed in as
   * uniforms, its normal faces the camera (−forward), and it casts NO shadow: a
   * screen-aligned card has no light-facing geometry, so its shadow would be a lie —
   * the scene loop skips points geometries in the depth pass and says so there.
   */
  billboard?: boolean;
  /**
   * T680: BEAM mode — one quad per point, spanning `positions[i]` → `endpoints[i]`,
   * widened along the one axis the camera can see. Same lights, same environment, same
   * group gate, same depth buffer as the other two (§V349, again): the vertex stage is
   * the only thing that differs, and it differs by where the quad's LONG axis comes
   * from — the camera in billboard mode, the DATA here.
   *
   * It casts no shadow for the same reason a billboard does not (§V610): the ribbon
   * turns to face the viewer, so the silhouette a light would see is not the silhouette
   * anything has. The scene loop skips it in the depth pass and says so there.
   */
  beam?: boolean;
  /**
   * T723: a vec4f attribute holding a unit QUATERNION turns each instance. Instances
   * only — a billboard faces the camera by construction and a beam takes its axis from
   * its endpoints, so neither has a free frame to orient, and the geometry node refuses
   * both by name rather than binding a buffer nothing could read.
   *
   * The binding lands AFTER the group binds, at the very end of the numbering, because
   * T680 and T721 took the last two holes below the shadow maps. Absent, not one byte of
   * this shader changes (§V309).
   */
  pointOrient?: boolean;
  /**
   * T940b: POINTS mode only — the billboard reads as a tiny SPHERE instead of a card:
   * radial soft coverage (a round splat, not a square) and a lambert term over a sphere
   * normal lit from the azimuth the point's tint ALPHA carries (the kernel writes the
   * direction light actually arrives from — for E13's dust, the beam). Off, not one
   * byte changes (§V309).
   */
  sphericalPoints?: boolean;
}): EmittedWgsl {
  const pointColor = options.pointColor === true;
  const billboard = options.billboard === true;
  const spherical = options.sphericalPoints === true && billboard;
  const beam = options.beam === true;
  const pointOrient = options.pointOrient === true;
  /* T721: binding 4 is the other half of the hole T680 documented below — 3 took the
     beam's endpoints, 4 takes the per-point size, and the shadow maps still start at 5,
     so nothing existing moves. `scaleAt` is 1.0 when nothing is mapped, which is why an
     unmapped geometry's WGSL is unchanged to the byte. */
  const pointScale = options.pointScale;
  const scaleDeclaration =
    pointScale === undefined
      ? ""
      : `@group(0) @binding(4) var<storage, read> pointScales: array<${pointScale.type}>;\n`;
  const scaleAt =
    pointScale === undefined
      ? "params.instance.x"
      : `(params.instance.x * pointScales[instance]${pointScale.channel === undefined ? "" : `.${pointScale.channel}`})`;
  const lightCount = Math.max(0, Math.floor(options.lightCount));
  const shadows = options.shadows ?? [];
  const shadowSlotOf = (index: number): number => shadows.indexOf(index);
  const pointSlots = new Set(options.pointShadows ?? []);
  const shadowFields = shadows
    .map((_, slot) =>
      pointSlots.has(slot)
        ? `  shadow${slot}Light: vec4f,\n${[0, 1, 2, 3, 4, 5].map((face) => `  shadow${slot}Face${face}: mat4x4f,\n`).join("")}`
        : `  shadow${slot}Matrix: mat4x4f,\n`,
    )
    .join("");
  const shadowBindings = shadows
    .map((_, slot) => `@group(0) @binding(${5 + slot}) var shadowMap${slot}: texture_2d<f32>;\n`)
    .join("");
  const environment = options.environment === true && lit(options.model);
  /* T1289: the shipped default is 8 — measured enough to read as a blur at roughness 1
     without the cost of a pyramid, and cheap enough that a scene already paying for
     shadows does not notice it. Clamped because a tap count is a loop bound in generated
     WGSL: 0 would silently turn the cone back into the sharp sample this row removed. */
  const envTaps = Math.min(32, Math.max(1, Math.round(options.environmentTaps ?? 8)));
  const envBinding = 5 + shadows.length;
  /* T1427b: the atlas binds right after the sharp map, so every later binding shifts by one
     only when it is on. */
  const prefiltered = environment && options.environmentPrefiltered === true;
  const envDeclarations = environment
    ? `@group(0) @binding(${envBinding}) var environmentMap: texture_2d<f32>;\n${ENV_SAMPLE_WGSL}${prefiltered ? envPrefilteredLookupWgsl(envBinding + 1) : ENV_CONE_WGSL(envTaps)}`
    : "";
  const envField = environment ? "  environment: vec4f,   // x = intensity\n" : "";
  /* T624 — see the surface generator: bound after the environment, ambient and
     environment only, byte-identical when absent. */
  const ambientOcclusion = options.ambientOcclusion === true && options.model !== "unlit";
  const aoBinding = envBinding + (environment ? 1 : 0) + (prefiltered ? 1 : 0);
  const aoDeclarations = ambientOcclusion
    ? `@group(0) @binding(${aoBinding}) var occlusionMap: texture_2d<f32>;\n`
    : "";
  const aoTerm = ambientOcclusion ? " * occlusion" : "";
  /* T704: projector textures after the AO map — see the surface generator. */
  const projectors = projectorBlocks(
    options.model === "unlit" ? [] : options.projectors ?? [],
    aoBinding + (ambientOcclusion ? 1 : 0),
  );
  /* T642: the group binds come last in the numbering, after every optional texture. */
  const groupBinding = aoBinding + (ambientOcclusion ? 1 : 0) + projectors.bindingCount;
  const group = groupBlocks(
    options.group,
    groupBinding,
    `    var gated: VertexOut;
    gated.position = vec4f(2.0, 2.0, 2.0, 1.0);
    gated.normal = vec3f(0.0, 0.0, 1.0);
    gated.world = vec3f(0.0);
    gated.tint = vec4f(0.0);
    return gated;`,
  );
  /* T723: after the group binds, which are themselves last — the two holes below the
     shadow maps went to T680's endpoints and T721's sizes. */
  const orientDeclaration = pointOrient
    ? `@group(0) @binding(${groupBinding + (options.group?.binds.length ?? 0)}) var<storage, read> pointOrients: array<vec4f>;\n`
    : "";
  /**
   * Rotating a vector by a UNIT quaternion, Rodrigues form: two cross products, no
   * matrix and no trig. Right-handed and ACTIVE — q = (0, 0, sin45, cos45) is a +90°
   * turn about +Z and carries +X to +Y, which is the domain fact `scene-orient.gpu.test`
   * pins rather than re-deriving here (§V683: a gate that recomputes the author's own
   * arithmetic agrees with an inverted sign as happily as with a correct one).
   */
  const quaternionHelper = pointOrient
    ? `
fn qrot(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
`
    : "";
  const envTerm = environment
    ? `  let envColor = ${prefiltered ? "sampleEnvironmentPrefiltered" : "sampleEnvironmentCone"}(reflect(-viewDir, normal), params.material.y * params.material.y);
${FRESNEL_WGSL}  lit += envColor * params.specular.rgb * envFresnel * params.environment.x${aoTerm};
${prefiltered ? IRRADIANCE_PREFILTERED_WGSL : IRRADIANCE_WGSL}  lit += irradiance * albedo.rgb * (1.0 - envFresnel) * (1.0 - params.material.x) * params.environment.x${aoTerm};
`
    : "";
  /* T1285: the same text the surface generator emits, from the same function (§V349). */
  const shadowFactor = (index: number): string => {
    const slot = shadowSlotOf(index);
    if (slot < 0) return "";
    return pointSlots.has(slot)
      ? pointShadowFactorWgsl(slot, options.shadowSoftness?.[slot] ?? 0, options.shadowBias?.[slot] ?? 0)
      : shadowFactorWgsl(slot, options.shadowSoftness?.[slot] ?? 0, options.shadowBias?.[slot] ?? 0);
  };
  const lightField = Array.from({ length: lightCount }, (_, index) =>
    `  light${index}Meta: vec4f,\n  light${index}Color: vec4f,\n  light${index}Vector: vec4f,\n`,
  ).join("");
  const lightBlock = (index: number): string => `  {
    let lightMeta = params.light${index}Meta;
    let lightColor = params.light${index}Color;
    let lightVector = params.light${index}Vector;
    var toLight: vec3f;
    var attenuation = 1.0;
    if (lightMeta.x < 0.5) {
      toLight = normalize(-lightVector.xyz);
    } else {
      let offset = lightVector.xyz - input.world;
      let distance = max(length(offset), 1e-4);
      toLight = offset / distance;
${POINT_FALLOFF_WGSL}    }
    let lambert = abs(dot(normal, toLight));
${shadowFactor(index)}    let radiance = lightColor.rgb * lightMeta.y * attenuation${shadowSlotOf(index) >= 0 ? " * shadow" : ""};
${
  options.model === "pbr"
    ? ggxSpecularWgsl("params.material.y") +
      /* The diffuse half, AFTER the lobe so it can read `fresnel`: energy the facets sent
         back specularly is not available to the body of the material, and a metal has no
         diffuse lobe at all. This is the line that makes `metallic` a physical quantity
         per light rather than a tint (T1284). */
      `    lit += albedo.rgb * radiance * lambert * (vec3f(1.0) - fresnel) * (1.0 - params.material.x);
`
    : `    lit += albedo.rgb * radiance * lambert;
` +
      (options.model === "phong"
        ? `    let halfway = normalize(toLight + viewDir);
    let gloss = max(2.0, params.specular.w * (1.0 - params.material.y));
    let highlight = pow(abs(dot(normal, halfway)), gloss);
    lit += params.specular.rgb * radiance * highlight;
`
        : "")
}  }
`;
  const needsViewDir = lightCount > 0 || environment;
  const aoLookup = ambientOcclusion
    ? `  let occlusion = textureLoad(occlusionMap, vec2i(input.position.xy), 0).r;\n`
    : "";
  const shading =
    options.model === "unlit"
      ? `  return vec4f(albedo.rgb * cover, albedo.a * cover);`
      : `${aoLookup}  let ambient = params.ambientColor.rgb * params.ambientColor.a${aoTerm};
  var lit = albedo.rgb * ambient;
${
  !needsViewDir
    ? ""
    : `  let viewDir = normalize(params.eye.xyz - input.world);
${Array.from({ length: lightCount }, (_, index) => lightBlock(index)).join("")}`
}${projectors.term}${envTerm}  return vec4f(lit * cover, albedo.a * cover);`;

  return wgsl`struct SceneParams {
  viewProjection: mat4x4f,
  eye: vec4f,
  ambientColor: vec4f,
  baseColor: vec4f,
  specular: vec4f,
  material: vec4f,
  instance: vec4f,          // x = scale (beam: HALF-WIDTH), y = shape (0 quad, 1 box, 2 octahedron), z = beam taper, w = soft profile (T917)
${billboard ? "  billboardRight: vec4f,\n  billboardUp: vec4f,\n" : ""}${lightField}${shadowFields}${envField}${projectors.fields}${options.cameraDepth ? "  depthRow: vec4f,\n  depthRange: vec4f,\n" : ""}};

@group(0) @binding(0) var<uniform> params: SceneParams;
@group(0) @binding(1) var<storage, read> positions: array<vec3f>;
${pointColor ? "@group(0) @binding(2) var<storage, read> pointColors: array<vec4f>;\n" : ""}${
    /* T680: bindings 3 and 4 have always been free here — the shadow maps start at 5 and
       everything optional is numbered after them — so the beam's second position buffer
       lands in a hole rather than shifting a single existing slot. T721 took the other
       one for the per-point size. */
    beam ? "@group(0) @binding(3) var<storage, read> endpoints: array<vec3f>;\n" : ""
  }${scaleDeclaration}${shadowBindings}${envDeclarations}${aoDeclarations}${projectors.bindings}${group.bindings}${orientDeclaration}
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) world: vec3f,
  @location(2) tint: vec4f,
  /* T917: the primitive's own local coordinate — x is the ACROSS axis (−1..1, beam side /
     billboard corner), y the ALONG one. What the soft profile falls off over; solid
     shapes carry zero and are untouched. */
  @location(3) profile: vec2f,
};
${group.declarations}

${INSTANCE_SHAPES_WGSL}
${quaternionHelper}
@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
${group.gate}${
    beam
      ? `  /* T680: corner.y picks the END (−1 = origin, +1 = endpoint), corner.x the SIDE.
     The width axis is the one direction perpendicular to the beam that the camera can
     actually see — cross(axis, toEye) — so the ribbon turns with the viewer about its
     own length and never goes edge-on and vanishes. */
  let corner = quadCorner(min(vertex, 5u));
  let a = positions[instance];
  let b = endpoints[instance];
  let axis = b - a;
  let along = mix(a, b, corner.y * 0.5 + 0.5);
  let across = cross(axis, params.eye.xyz - along);
  let acrossLen = length(across);
  /* Exactly end-on, or a zero-length beam: divide by nothing and fall back to a fixed
     axis. A zero-length beam still collapses to zero AREA — both ends land on the same
     point — which is the honest reading of a ray that never travelled. */
  let side = select(across / max(acrossLen, 1e-6), vec3f(1.0, 0.0, 0.0), acrossLen < 1e-6);
  /* z = TAPER: the share of the width the beam keeps at its ORIGIN. At 1 this is a
     parallel-sided ribbon; below it the near end pinches, which is both what a divergent
     beam does and the only thing that stops N beams sharing one origin from fusing into a
     solid wedge there. */
  let widthAt = mix(params.instance.z, 1.0, corner.y * 0.5 + 0.5);
  let world = along + side * corner.x * ${scaleAt} * widthAt;
  var out: VertexOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  /* Perpendicular to the width AND to the length, which for this width axis is the
     component of the view vector across the beam: the ribbon faces the camera. */
  out.normal = normalize(cross(side, axis));
  out.world = world;
  out.tint = ${pointColor ? "pointColors[instance]" : "vec4f(1.0)"};
  out.profile = corner;
  return out;`
      : billboard
      ? `  let corner = quadCorner(min(vertex, 5u));
  let world = positions[instance]
    + (params.billboardRight.xyz * corner.x + params.billboardUp.xyz * corner.y) * ${scaleAt};
  var out: VertexOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  /* r × u = −forward for an orthonormal camera basis: the card faces the camera. */
  out.normal = normalize(cross(params.billboardRight.xyz, params.billboardUp.xyz));
  out.world = world;
  out.tint = ${pointColor ? "pointColors[instance]" : "vec4f(1.0)"};
  out.profile = corner;
  return out;`
      : `  let shape = u32(params.instance.y);
  let count = shapeVertexCount(shape);
  let v = min(vertex, count - 1u);
${
          pointOrient
            ? `  /* T723: the primitive turns, AND SO DOES ITS NORMAL. Rotating only the positions
     is the fault this generator would otherwise ship: a box turned ninety degrees would
     be shaded for the way up it no longer has — every face taking the light meant for
     another one. Invisible on a flat-lit scene, glaring under a key light, and not a
     thing a still frame of an unlit example can see. */
  let turn = pointOrients[instance];
  let local = qrot(turn, shapeVertex(shape, v) * ${scaleAt});
  let world = local + positions[instance];
  var out: VertexOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  out.normal = qrot(turn, shapeNormal(shape, v));`
            : `  let local = shapeVertex(shape, v) * ${scaleAt};
  let world = local + positions[instance];
  var out: VertexOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  out.normal = shapeNormal(shape, v);`
        }
  out.world = world;
  out.tint = ${pointColor ? "pointColors[instance]" : "vec4f(1.0)"};
  out.profile = vec2f(0.0);
  return out;`
  }
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  let normal = normalize(input.normal);
  let albedo = params.baseColor * input.tint;
  /* T917: SOFT PROFILE — §T845's AA-disc formula on the ribbon's cross axis. soft = 0 is
     coverage 1 everywhere: today's hard quad, bit-identical. Above 0 the edge falls off
     over that share of the half-width, and the COLOUR carries the coverage (premultiplied)
     so an additive draw sums light and never fringes. */
  let soft = params.instance.w;
${
    spherical
      ? `  /* T940b: a round splat with a lit and an unlit side. */
  let r2d = length(input.profile);
  var cover = select(1.0, clamp((1.0 - r2d) / max(soft, 1e-4), 0.0, 1.0), soft > 0.0);
  let sphereN = vec3f(input.profile, sqrt(max(0.0, 1.0 - dot(input.profile, input.profile))));
  /* The alpha is a NORMALIZED azimuth (0..1 = -PI..PI) — the colour pipeline clamps
     alpha to unit range, so the angle rides inside it and rescales here. */
  let litFrom = input.tint.a * 6.28318530717958647692 - 3.14159265358979323846;
  let sphereL = normalize(vec3f(cos(litFrom), sin(litFrom), 0.55));
  cover = cover * (0.25 + 0.75 * max(dot(sphereN, sphereL), 0.0));
`
      : `  let cover = select(1.0, clamp((1.0 - abs(input.profile.x)) / max(soft, 1e-4), 0.0, 1.0), soft > 0.0);
`
  }${options.cameraDepth ? `  if (cover <= 0.0) { discard; }
  let depth = clamp(dot(params.depthRow, vec4f(input.world, 1.0)) / params.depthRange.x, 0.0, 1.0);
  return vec4f(depth, 0.0, 0.0, 1.0);` : shading}
}`;
}


/**
 * T481: the SHADOW pass shaders — the scene's own analytic vertex generation with the
 * shading stripped, drawing LIGHT-SPACE CLIP DEPTH into an r32float colour target.
 * Not the depth aspect: binding one as a texture would be new resource plumbing, and
 * r32float is renderable everywhere with the float32-filterable compile gate already
 * standing (we read it with textureLoad, so even that gate never fires).
 *
 * The far plate (`SHADOW_CLEAR_WGSL`) paints depth 1.0 across the target first, the
 * same way the render's backdrop paints its background (T444): a cleared shadow map
 * must read "nothing here", and the target's own clear colour is not ours to choose.
 */
export const SHADOW_CLEAR_WGSL = wgsl`@vertex
fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return vec4f(corners[v], 0.9999, 1.0);
}
@fragment
fn fs() -> @location(0) vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }`;

/**
 * T624: the same depth-only draw serves the AO prepass. `linearDepth` swaps the stored
 * value from LIGHT-SPACE CLIP DEPTH to LINEAR VIEW DISTANCE over the far plane — one
 * extra uniform row and one changed expression, so the grid/primitive vertex arithmetic
 * has exactly one implementation rather than a shadow copy and an AO copy that drift.
 * `dot(depthRow, vec4f(world, 1))` is affine in world position, so interpolating it
 * across a triangle is exact. Absent, the emitted text is byte-identical (§V309).
 */
export interface DepthPassOptions {
  readonly linearDepth?: boolean;
  /**
   * T704: store FRAGMENT-Z (`input.position.z` — clip z ÷ w, done by the rasterizer)
   * instead of the interpolated clip z. For the ortho shadow matrices w is 1 and the
   * two are identical; a PROJECTOR's frustum is perspective, where undivided clip z is
   * not a depth at all. The read side does the matching divide (`pc.xyz / pc.w`).
   */
  readonly perspective?: boolean;
}

/** The surface mesh from the light's view — grid arithmetic identical to the lit draw. */
export const shadowSurfaceWgsl = generatedOnce("shadowSurfaceWgsl", buildShadowSurfaceWgsl);
function buildShadowSurfaceWgsl(options: DepthPassOptions = {}): EmittedWgsl {
  const linear = options.linearDepth === true;
  const depthExpr = linear
    ? `dot(params.depthRow, vec4f(world, 1.0)) / max(params.depthRange.x, 1e-6)`
    : `clip.z`;
  const linearFields = linear
    ? `  depthRow: vec4f,         // dot(depthRow, vec4f(world,1)) = linear view distance
  depthRange: vec4f,       // x = far plane
`
    : "";
  return wgsl`struct ShadowParams {
  lightViewProjection: mat4x4f,
  model: mat4x4f,           // T1588b: the object transform
  grid: vec4f,              // cols, rows, wrapU, wrapV
${linearFields}};

@group(0) @binding(0) var<uniform> params: ShadowParams;
@group(0) @binding(1) var<storage, read> positions: array<vec3f>;

fn cellCorner(v: u32) -> vec2u {
  var corners = array<vec2u, 6>(
    vec2u(0u, 0u), vec2u(1u, 0u), vec2u(0u, 1u),
    vec2u(0u, 1u), vec2u(1u, 0u), vec2u(1u, 1u),
  );
  return corners[v];
}

fn gridPosition(gx: u32, gy: u32) -> vec3f {
  let cols = u32(params.grid.x);
  let rows = u32(params.grid.y);
  let px = select(gx, gx % cols, params.grid.z > 0.5);
  let py = select(gy, gy % rows, params.grid.w > 0.5);
  return positions[py * cols + px];
}

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) depth: f32,
};

@vertex
fn vs(@builtin(vertex_index) vertex: u32) -> VertexOut {
  let cols = u32(params.grid.x);
  let wrapU = params.grid.z > 0.5;
  let cellsU = select(cols - 1u, cols, wrapU);
  let quad = vertex / 6u;
  let corner = cellCorner(vertex % 6u);
  let gx = (quad % cellsU) + corner.x;
  let gy = (quad / cellsU) + corner.y;
  let world = (params.model * vec4f(gridPosition(gx, gy), 1.0)).xyz;
  let clip = params.lightViewProjection * vec4f(world, 1.0);
  var out: VertexOut;
  out.position = clip;
  out.depth = ${depthExpr};
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  return vec4f(${options.perspective === true ? "input.position.z" : "input.depth"}, 0.0, 0.0, 1.0);
}`;
}

/**
 * T1353b — the indexed mesh from the light's (or the camera's) view: the same depth
 * contract as `shadowSurfaceWgsl`, with positions pulled through the index list. Shares
 * the MESH_BINDINGS slot for indices, so the draw's buffer list is the lit draw's prefix.
 */
export const shadowMeshWgsl = generatedOnce("shadowMeshWgsl", buildShadowMeshWgsl);
function buildShadowMeshWgsl(
  options: DepthPassOptions & {
    /**
     * T1581b: the mesh is drawn once per instance, placed by its record — the lit draw's
     * own placement, so a shadow is cast by exactly the shape that is in the picture.
     */
    readonly instanced?: Pick<SceneInstancedOption, "groups" | "position" | "record">;
  } = {},
): EmittedWgsl {
  const linear = options.linearDepth === true;
  const instanced = options.instanced;
  const depthExpr = linear ? `dot(params.depthRow, vec4f(world, 1.0)) / max(params.depthRange.x, 1e-6)` : `clip.z`;
  const linearFields = linear
    ? `  depthRow: vec4f,         // dot(depthRow, vec4f(world,1)) = linear view distance
  depthRange: vec4f,       // x = far plane
`
    : "";
  const storage =
    instanced === undefined
      ? `@group(0) @binding(1) var<storage, read> positions: array<vec3f>;\n@group(0) @binding(${MESH_BINDINGS.indices}) var<storage, read> meshIndices: array<u32>;\n`
      : instancedStorageWgsl(instanced);
  const place =
    instanced === undefined
      ? "  let world = (params.model * vec4f(positions[meshIndices[vertex]], 1.0)).xyz;"
      : `${RECORD_PLACE_WGSL}\n  let local = vec4f(meshPositionAt(meshIndices[vertex]), 1.0);\n  let world = vec3f(dot(r0, local), dot(r1, local), dot(r2, local));`;
  return wgsl`struct ShadowParams {
  lightViewProjection: mat4x4f,
${instanced === undefined ? "  model: mat4x4f,           // T1588b: the object transform\n" : ""}${linearFields}};

@group(0) @binding(0) var<uniform> params: ShadowParams;
${storage}
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) depth: f32,
};

@vertex
fn vs(@builtin(vertex_index) vertex: u32${instanced === undefined ? "" : ", @builtin(instance_index) drawn: u32"}) -> VertexOut {
${place}
  let clip = params.lightViewProjection * vec4f(world, 1.0);
  var out: VertexOut;
  out.position = clip;
  out.depth = ${depthExpr};
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  return vec4f(${options.perspective === true ? "input.position.z" : "input.depth"}, 0.0, 0.0, 1.0);
}`;
}

/** The instance primitives from the light's view — shapes identical to the lit draw. */
export const shadowInstancesWgsl = generatedOnce("shadowInstancesWgsl", buildShadowInstancesWgsl);
function buildShadowInstancesWgsl(
  options: DepthPassOptions & {
    group?: SceneGroupOption;
    pointScale?: { type: string; channel?: string };
    /**
     * T723 — AND A MAPPED ORIENTATION HAS TO REACH THE SWEEP FOR THE SAME REASON T721's
     * size did, with more force. A wrongly-sized shadow is a shadow of the right shape;
     * a wrongly-ORIENTED one is the silhouette of a thing that is not in the picture,
     * which reads as a lighting fault and is really a missing binding.
     */
    pointOrient?: boolean;
  } = {},
): EmittedWgsl {
  const linear = options.linearDepth === true;
  /* T642: an excluded instance must not cast a GHOST SHADOW — the depth pass gates on
     the same predicate, from the same shared block, or an invisible instance would
     still darken the ground beneath where it is not. Binding 2: after params(0) and
     positions(1), and this pass binds nothing else. */
  const group = groupBlocks(
    options.group,
    2,
    `    var gated: VertexOut;
    gated.position = vec4f(2.0, 2.0, 2.0, 1.0);
    gated.depth = 1.0;
    return gated;`,
  );
  /* T721 — a MAPPED SCALE HAS TO REACH THE DEPTH SWEEP OR THE SHADOW LIES. Instances
     are the one per-point mode that casts (§V610 excuses the two billboard modes), so a
     per-point size that only the lit draw knew about would paint a shadow the size of
     the AUTHORED scale under a primitive drawn at another one — a mismatch that reads
     as a lighting bug and is really a missing binding. It goes AFTER the group binds so
     an unmapped geometry's depth shader is unchanged to the byte (§V309). */
  const pointScale = options.pointScale;
  const scaleDeclaration =
    pointScale === undefined
      ? ""
      : `@group(0) @binding(${2 + (options.group?.binds.length ?? 0)}) var<storage, read> pointScales: array<${pointScale.type}>;\n`;
  const scaleAt =
    pointScale === undefined
      ? "params.instance.x"
      : `(params.instance.x * pointScales[instance]${pointScale.channel === undefined ? "" : `.${pointScale.channel}`})`;
  /* T723: after the group binds AND after T721's sizes, so a geometry that orients
     nothing keeps a byte-identical depth shader — and so does one that only sizes. */
  const pointOrient = options.pointOrient === true;
  const orientDeclaration = pointOrient
    ? `@group(0) @binding(${2 + (options.group?.binds.length ?? 0) + (pointScale === undefined ? 0 : 1)}) var<storage, read> pointOrients: array<vec4f>;\n`
    : "";
  /** The same Rodrigues rotation the lit draw uses, and it must stay the same one. */
  const quaternionHelper = pointOrient
    ? `
fn qrot(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
`
    : "";
  const depthExpr = linear
    ? `dot(params.depthRow, vec4f(world, 1.0)) / max(params.depthRange.x, 1e-6)`
    : `clip.z`;
  const linearFields = linear
    ? `  depthRow: vec4f,         // dot(depthRow, vec4f(world,1)) = linear view distance
  depthRange: vec4f,       // x = far plane
`
    : "";
  return wgsl`struct ShadowParams {
  lightViewProjection: mat4x4f,
  instance: vec4f,          // x = scale, y = shape (0 quad, 1 box, 2 octahedron)
${linearFields}};

@group(0) @binding(0) var<uniform> params: ShadowParams;
@group(0) @binding(1) var<storage, read> positions: array<vec3f>;
${group.bindings}${scaleDeclaration}${orientDeclaration}
${INSTANCE_SHAPES_WGSL}

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) depth: f32,
};
${group.declarations}${quaternionHelper}
@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
${group.gate}  let shape = u32(params.instance.y);
  let count = shapeVertexCount(shape);
  let v = min(vertex, count - 1u);
  let world = ${pointOrient ? "qrot(pointOrients[instance], shapeVertex(shape, v) * " + scaleAt + ")" : "shapeVertex(shape, v) * " + scaleAt} + positions[instance];
  let clip = params.lightViewProjection * vec4f(world, 1.0);
  var out: VertexOut;
  out.position = clip;
  out.depth = ${depthExpr};
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  return vec4f(${options.perspective === true ? "input.position.z" : "input.depth"}, 0.0, 0.0, 1.0);
}`;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T725 — SCREEN-SPACE TRANSMISSION: the glass pyramid and the glass draw.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * vgpu's own transmission example, read at the source (vercel-labs/vgpu,
 * apps/docs/examples/transmission): render the opaques, blur the frame into a
 * pyramid, and let the glass draw bend rays back into it — Snell refraction to pick
 * the sample point, roughness to pick the pyramid LEVEL (frosted glass is a coarser
 * read of the scene, never a per-fragment blur), a spectral IOR loop for chromatic
 * dispersion, Beer-Lambert absorption along the internal path, and a Schlick Fresnel
 * mix toward the environment reflection at grazing angles.
 *
 * Two deliberate departures from the reference, both stated:
 *  - NO SAMPLERS. The reference assembles a real mip texture and reads it with
 *    hardware trilinear; our pyramid is five separate scratch targets, read with
 *    textureLoad and MANUAL bilinear + a level mix (§V57's house idiom — draw passes
 *    bind no samplers anywhere in this codebase, and this feature does not get to be
 *    the reason they start).
 *  - THICKNESS MODE ONLY (v1). The reference's "double" refraction analytically
 *    traces its CUBE's exit face — meaningless for an arbitrary grid surface. Its own
 *    GUI ships the thickness-based "simple" mode; that is what every geometry gets
 *    here, and an exact box-exit trace for instances is the stated follow-up.
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T1289 — THE PREFILTERED ENVIRONMENT: roughness BLURS instead of DIMMING.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * What shipped before this: the reflection term read the environment ONCE, sharply, and
 * then multiplied the result by `(1 − roughness)`. A rough metal therefore read DARK
 * rather than SOFT — the single largest gap between what this renderer shipped and what
 * "PBR" means to somebody looking at the picture. A mirror and a brushed surface sampled
 * the same texel; only their brightness differed.
 *
 * The chain is the GLASS PYRAMID, pointed at the environment. `scene.ts` already builds a
 * separable blur pyramid for transmission — blit to level 0, then per level a horizontal
 * decimating pass into a scratch and a vertical pass into the level — and a prefiltered
 * environment is structurally that same chain with a roughness→level lookup replacing
 * glass's own. Same scratch mechanism, same pass shapes, same file.
 *
 * ⚑ BUT THE KERNELS COULD NOT BE REUSED VERBATIM, AND THE REASON IS THE EQUIRECT'S OWN
 * GEOMETRY. The glass kernels CLAMP at every edge, which is right for a frame: a screen
 * has borders. An equirect has none in longitude — its left and right columns are
 * adjacent directions in the world — so clamping there smears the seam into a visible
 * vertical bar in every reflection, at every roughness, and it gets worse as the levels
 * coarsen. These kernels WRAP in x and clamp in y.
 *
 * ⚑ AND THE POLES ARE NOT FIXED, THEY ARE BOUNDED, WHICH IS WORTH STATING RATHER THAN
 * PRETENDING. A separable blur in equirect space filters a constant angular width in
 * TEXELS, and a texel near the pole subtends far less solid angle than one at the
 * equator — so the top and bottom rows are under-blurred relative to a true spherical
 * convolution. The honest fix is a cosine-weighted or spherical prefilter, which is a
 * different and much larger piece of work. What this does instead is clamp in y, so the
 * pole rows average toward their own neighbourhood rather than wrapping onto the far
 * side of the sphere — the error is a slightly sharper pole, not a wrong direction.
 */
export const ENV_BLIT_WGSL = wgsl`@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@vertex
fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return vec4f(corners[v], 0.0, 1.0);
}
@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let dims = vec2i(textureDimensions(sourceTex, 0));
  let p = clamp(vec2i(position.xy), vec2i(0), dims - vec2i(1));
  return textureLoad(sourceTex, p, 0);
}`;

/** Longitude WRAPS: the column past the right edge is the one at the left (T1289). */
const ENV_WRAP_X = `fn envWrapX(x: i32, width: i32) -> i32 {
  return ((x % width) + width) % width;
}
`;

/** The horizontal half, decimating: [1,3,3,1]/8 across a wrapped longitude. */
export const ENV_DOWN_WGSL = wgsl`@group(0) @binding(0) var sourceTex: texture_2d<f32>;
${ENV_WRAP_X}@vertex
fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return vec4f(corners[v], 0.0, 1.0);
}
@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let dims = vec2i(textureDimensions(sourceTex, 0));
  let base = vec2i(position.xy) * 2;
  var weights = array<f32, 4>(1.0, 3.0, 3.0, 1.0);
  var sum = vec4f(0.0);
  for (var i = 0; i < 4; i = i + 1) {
    let x = envWrapX(base.x + i - 1, dims.x);
    let a = textureLoad(sourceTex, vec2i(x, clamp(base.y, 0, dims.y - 1)), 0);
    let b = textureLoad(sourceTex, vec2i(x, clamp(base.y + 1, 0, dims.y - 1)), 0);
    sum += (a + b) * 0.5 * weights[i];
  }
  return sum / 8.0;
}`;

/** The vertical half: [1,4,6,4,1]/16 at the level's own resolution, clamped at the poles. */
export const ENV_VBLUR_WGSL = wgsl`@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@vertex
fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return vec4f(corners[v], 0.0, 1.0);
}
@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let dims = vec2i(textureDimensions(sourceTex, 0));
  let p = vec2i(position.xy);
  var weights = array<f32, 5>(1.0, 4.0, 6.0, 4.0, 1.0);
  var sum = vec4f(0.0);
  for (var i = 0; i < 5; i = i + 1) {
    let y = clamp(p.y + i - 2, 0, dims.y - 1);
    sum += textureLoad(sourceTex, vec2i(clamp(p.x, 0, dims.x - 1), y), 0) * weights[i];
  }
  return sum / 16.0;
}`;

/** How many prefiltered levels the environment carries. Level k is 1/2^k of the source. */
export const ENV_PYRAMID_LEVELS = 5;

/** Pyramid depth: level k is the frame at scale 1/2^k. Five reaches 1/16 resolution. */
export const GLASS_PYRAMID_LEVELS = 5;
/** Spectral samples in the dispersion loop — the reference uses 11; 7 reads the same. */
export const GLASS_SPECTRAL_SAMPLES = 7;

/** Level 0: the rendered opaques, copied so the glass draw never reads its own target. */
/**
 * T939 — the SSAA resolve: each output pixel averages its 2x2 supersampled block. Box on
 * purpose: the samples ARE the coverage, and any wider kernel would blur detail the
 * supersampling paid to keep.
 */
export const SSAA_RESOLVE_WGSL = wgsl`@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@vertex
fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return vec4f(corners[v], 0.0, 1.0);
}
@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let base = vec2i(position.xy) * 2;
  let a = textureLoad(sourceTex, base, 0);
  let b = textureLoad(sourceTex, base + vec2i(1, 0), 0);
  let c = textureLoad(sourceTex, base + vec2i(0, 1), 0);
  let d = textureLoad(sourceTex, base + vec2i(1, 1), 0);
  return (a + b + c + d) * 0.25;
}`;

export const GLASS_BLIT_WGSL = wgsl`@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@vertex
fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return vec4f(corners[v], 0.0, 1.0);
}
@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return textureLoad(sourceTex, vec2i(position.xy), 0);
}`;

/**
 * Downsample-with-blur, horizontal: each half-res texel reads a [1,3,3,1]/8 horizontal
 * kernel centred between its two source columns, averaging the two source rows it
 * straddles — decimation and the horizontal half of the Gaussian in one pass.
 */
export const GLASS_DOWN_WGSL = wgsl`@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@vertex
fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return vec4f(corners[v], 0.0, 1.0);
}
@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let dims = vec2i(textureDimensions(sourceTex, 0));
  let base = vec2i(position.xy) * 2;
  var weights = array<f32, 4>(1.0, 3.0, 3.0, 1.0);
  var sum = vec4f(0.0);
  for (var i = 0; i < 4; i = i + 1) {
    let x = clamp(base.x + i - 1, 0, dims.x - 1);
    let a = textureLoad(sourceTex, vec2i(x, clamp(base.y, 0, dims.y - 1)), 0);
    let b = textureLoad(sourceTex, vec2i(x, clamp(base.y + 1, 0, dims.y - 1)), 0);
    sum += (a + b) * 0.5 * weights[i];
  }
  return sum / 8.0;
}`;

/** The vertical half: a [1,4,6,4,1]/16 kernel at the level's own resolution. */
export const GLASS_VBLUR_WGSL = wgsl`@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@vertex
fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return vec4f(corners[v], 0.0, 1.0);
}
@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let dims = vec2i(textureDimensions(sourceTex, 0));
  let p = vec2i(position.xy);
  var weights = array<f32, 5>(1.0, 4.0, 6.0, 4.0, 1.0);
  var sum = vec4f(0.0);
  for (var i = 0; i < 5; i = i + 1) {
    let y = clamp(p.y + i - 2, 0, dims.y - 1);
    sum += textureLoad(sourceTex, vec2i(p.x, y), 0) * weights[i];
  }
  return sum / 16.0;
}`;

export interface GlassShaderOptions {
  /** An equirect environment is wired on the render — the reflection samples it. */
  readonly environment?: boolean;
}

/** Manual bilinear per level + a level mix: textureLoad trilinear, exact at lod 0. */
function glassPyramidWgsl(): string {
  const perLevel = Array.from({ length: GLASS_PYRAMID_LEVELS }, (_, level) =>
    `fn samplePyr${level}(uv: vec2f) -> vec3f {
  let dims = vec2f(textureDimensions(pyr${level}, 0));
  let coord = clamp(uv, vec2f(0.0), vec2f(1.0)) * dims - vec2f(0.5);
  let base = floor(coord);
  let f = coord - base;
  let i0 = vec2i(clamp(base, vec2f(0.0), dims - vec2f(1.0)));
  let i1 = vec2i(clamp(base + vec2f(1.0), vec2f(0.0), dims - vec2f(1.0)));
  let c00 = textureLoad(pyr${level}, i0, 0).rgb;
  let c10 = textureLoad(pyr${level}, vec2i(i1.x, i0.y), 0).rgb;
  let c01 = textureLoad(pyr${level}, vec2i(i0.x, i1.y), 0).rgb;
  let c11 = textureLoad(pyr${level}, i1, 0).rgb;
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}
`).join("\n");
  const top = GLASS_PYRAMID_LEVELS - 1;
  const branches = Array.from({ length: top - 1 }, (_, level) =>
    `  if (l < ${(level + 1).toFixed(1)}) { return mix(samplePyr${level}(uv), samplePyr${level + 1}(uv), l - ${level.toFixed(1)}); }\n`,
  ).join("");
  return `${perLevel}
fn samplePyramid(uv: vec2f, lod: f32) -> vec3f {
  let l = clamp(lod, 0.0, ${top.toFixed(1)});
${branches}  return mix(samplePyr${top - 1}(uv), samplePyr${top}(uv), l - ${(top - 1).toFixed(1)});
}
`;
}

/**
 * The glass FRAGMENT, shared by the surface and the instances generator (§V349).
 *
 * Uniform contract (both generators declare these):
 *   glassA = [ior, roughness, thickness, dispersion]
 *   glassB = [absorption.rgb, envIntensity]
 *   fallback = [background.rgb, unused] — what a ray that leaves the frame sees when
 *     no environment is wired.
 *
 * Identity gate (§V147): at ior = 1 `refract` returns the incident ray unchanged, so
 * the extended sample point stays ON the eye ray and projects to this very fragment —
 * a polished, non-absorbing, ior-1 pane is byte-identical to the pixels behind it.
 */
function glassFragmentWgsl(options: GlassShaderOptions): EmittedWgsl {
  const reflectionExpr =
    options.environment === true
      ? "sampleEnvironment(reflected) * params.glassB.w"
      : "params.fallback.rgb";
  return wgsl`fn spectralWeight(t: f32) -> vec3f {
  return vec3f(
    exp(-pow((t - 0.05) / 0.45, 2.0)),
    exp(-pow((t - 0.50) / 0.38, 2.0)),
    exp(-pow((t - 0.95) / 0.45, 2.0)),
  );
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  let magnitude = length(input.normal);
  let geometric = select(vec3f(0.0, 0.0, 1.0), input.normal / max(magnitude, 1e-6), magnitude > 1e-6);
  let view = normalize(params.eye.xyz - input.world);
  /* Two-sided (T301): the face the camera sees is the entry face. */
  let normal = select(-geometric, geometric, dot(geometric, view) > 0.0);
  let incident = -view;
  let facing = clamp(dot(view, normal), 0.0, 1.0);

  let reflected = reflect(incident, normal);
  let reflection = ${reflectionExpr};
  let lod = pow(params.glassA.y, 0.8) * ${(GLASS_PYRAMID_LEVELS - 1).toFixed(1)} * 0.55;

  var spectrum = vec3f(0.0);
  var total = vec3f(0.0);
  for (var i = 0; i < ${GLASS_SPECTRAL_SAMPLES}; i = i + 1) {
    let t = (f32(i) + 0.5) / ${GLASS_SPECTRAL_SAMPLES}.0;
    let ior = max(1.0, params.glassA.x + (t - 0.5) * params.glassA.w);
    let inside = refract(incident, normal, 1.0 / ior);
    /* Total internal reflection or a degenerate normal: the ray never enters the
       scene — it sees the reflection, which is what TIR literally is. */
    var sampleColor = reflection;
    if (dot(inside, inside) > 1e-6) {
      /* Thickness mode: travel the assumed internal path, then well past the exit so
         the projected point reads the scene BEHIND the body, not its own surface. */
      let exitPoint = input.world + inside * (params.glassA.z + 4.0);
      let clip = params.viewProjection * vec4f(exitPoint, 1.0);
      if (clip.w > 1e-4) {
        let ndc = clip.xy / clip.w;
        let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
        /* The reference's border blend: a ray that leaves the frame fades to the
           reflection instead of smearing the clamped edge texel. */
        let edge = smoothstep(vec2f(0.0), vec2f(0.06), uv) * smoothstep(vec2f(0.0), vec2f(0.06), vec2f(1.0) - uv);
        sampleColor = mix(reflection, samplePyramid(uv, lod), edge.x * edge.y);
      }
    }
    let weight = select(vec3f(1.0), spectralWeight(t), params.glassA.w > 1e-5);
    spectrum += sampleColor * weight;
    total += weight;
  }
  var transmitted = spectrum / max(total, vec3f(1e-4));

  /* Beer-Lambert: the glass's colour, by removal only (§V644 — nothing multiplies in). */
  transmitted *= exp(-params.glassB.rgb * params.glassA.z);

  let f0 = pow((params.glassA.x - 1.0) / (params.glassA.x + 1.0), 2.0);
  let fresnel = f0 + (1.0 - f0) * pow(1.0 - facing, 5.0);
  return vec4f(mix(transmitted, reflection, fresnel), 1.0);
}`;
}

function glassBindingsWgsl(options: GlassShaderOptions): EmittedWgsl {
  const levels = Array.from(
    { length: GLASS_PYRAMID_LEVELS },
    (_, level) => `@group(0) @binding(${2 + level}) var pyr${level}: texture_2d<f32>;\n`,
  ).join("");
  const env =
    options.environment === true
      ? `@group(0) @binding(${2 + GLASS_PYRAMID_LEVELS}) var environmentMap: texture_2d<f32>;\n${ENV_SAMPLE_WGSL}`
      : "";
  return wgsl`${levels}${env}`;
}

/** The glass draw for SURFACE geometry — the lit generator's own mesh, new optics. */
export const glassSurfaceWgsl = generatedOnce("glassSurfaceWgsl", buildGlassSurfaceWgsl);
function buildGlassSurfaceWgsl(options: GlassShaderOptions = {}): EmittedWgsl {
  return wgsl`struct SceneParams {
  viewProjection: mat4x4f,
  model: mat4x4f,           // T1588b: the object transform
  modelNormal: mat4x4f,     // its normal matrix (upper 3x3)
  eye: vec4f,
  glassA: vec4f,            // ior, roughness, thickness, dispersion
  glassB: vec4f,            // absorption rgb, w = environment intensity
  fallback: vec4f,          // background rgb — the off-frame / no-env answer
  grid: vec4f,              // cols, rows, wrapU, wrapV
};

@group(0) @binding(0) var<uniform> params: SceneParams;
@group(0) @binding(1) var<storage, read> positions: array<vec3f>;
${glassBindingsWgsl(options)}${surfaceMeshWgsl(false)}

${glassPyramidWgsl()}
${glassFragmentWgsl(options)}`;
}

/**
 * T1357b — the glass draw for an INDEXED MESH: the lit mesh generator's own vertex chunk
 * (index pull, file normals) under the same optics. The fragment already picks the
 * face the camera sees as the entry face, so a file mesh's authored side needs no
 * B227 turn here.
 */
export const glassMeshWgsl = generatedOnce("glassMeshWgsl", buildGlassMeshWgsl);
function buildGlassMeshWgsl(options: GlassShaderOptions = {}): EmittedWgsl {
  const mesh = { uv: false, surface: false, emissive: false } as const;
  return wgsl`struct SceneParams {
  viewProjection: mat4x4f,
  model: mat4x4f,           // T1588b: the object transform
  modelNormal: mat4x4f,     // its normal matrix (upper 3x3)
  eye: vec4f,
  glassA: vec4f,            // ior, roughness, thickness, dispersion
  glassB: vec4f,            // absorption rgb, w = environment intensity
  fallback: vec4f,          // background rgb — the off-frame / no-env answer
};

@group(0) @binding(0) var<uniform> params: SceneParams;
@group(0) @binding(1) var<storage, read> positions: array<vec3f>;
${glassBindingsWgsl(options)}${meshBindingsWgsl(mesh)}${meshVertexWgsl(false, mesh)}

${glassPyramidWgsl()}
${glassFragmentWgsl(options)}`;
}

/** The glass draw for INSTANCES geometry — plain primitives (no group/billboard/beam). */
export const glassInstancesWgsl = generatedOnce("glassInstancesWgsl", buildGlassInstancesWgsl);
function buildGlassInstancesWgsl(options: GlassShaderOptions = {}): EmittedWgsl {
  return wgsl`struct SceneParams {
  viewProjection: mat4x4f,
  eye: vec4f,
  glassA: vec4f,            // ior, roughness, thickness, dispersion
  glassB: vec4f,            // absorption rgb, w = environment intensity
  fallback: vec4f,          // background rgb — the off-frame / no-env answer
  instance: vec4f,          // x = scale, y = shape (0 quad, 1 box, 2 octahedron)
};

@group(0) @binding(0) var<uniform> params: SceneParams;
@group(0) @binding(1) var<storage, read> positions: array<vec3f>;
${glassBindingsWgsl(options)}struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) world: vec3f,
};

${INSTANCE_SHAPES_WGSL}

@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
  let shape = u32(params.instance.y);
  let count = shapeVertexCount(shape);
  let v = min(vertex, count - 1u);
  let world = shapeVertex(shape, v) * params.instance.x + positions[instance];
  var out: VertexOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  out.normal = shapeNormal(shape, v);
  out.world = world;
  return out;
}

${glassPyramidWgsl()}
${glassFragmentWgsl(options)}`;
}

/**
 * T1355b — every name the lit surface generator declares around a Material · WGSL's code,
 * read off a generator run with EVERY feature on (so a feature's helper is never missed),
 * minus the one function the author is required to declare. A Material · WGSL refuses a
 * source that declares any of these rather than shadowing one.
 */
const ALL_SURFACE_FEATURES: SceneShadingOptions = {
  model: "pbr",
  lightCount: 1,
  maps: { albedo: true, roughness: true },
  pointColor: true,
  shadows: [0],
  shadowSoftness: [1],
  environment: true,
  environmentPrefiltered: true,
  ambientOcclusion: true,
  projectors: [{ cookie: true, occlusion: true }],
  mesh: { uv: true, surface: true, emissive: true },
  custom: { code: "fn surface(s: SurfaceIn, p: Params) -> SurfaceOut { return surfaceDefaults(s); }", paramsDeclaration: "", fields: [] },
};

/**
 * T1581b: the same run for a mesh drawn per instance, which declares other functions (the
 * accessors, `instanceSlot`).
 */
const ALL_INSTANCED_FEATURES: SceneShadingOptions = (() => {
  const read = (group: number): PackedRead => ({ group, offset: 0, type: "vec4f" });
  return {
    ...ALL_SURFACE_FEATURES,
    instanced: {
      groups: 2,
      position: { ...read(0), type: "vec3f" },
      normal: { ...read(0), type: "vec3f" },
      uv: { ...read(0), type: "vec2f" },
      color: read(0),
      surface: read(0),
      emissive: { ...read(0), type: "vec3f" },
      record: { group: 1, m0: 0, m1: 0, m2: 0, visible: 0, tint: 0 },
    },
  };
})();

export const SURFACE_RESERVED_NAMES: ReadonlySet<string> = new Set(
  [ALL_SURFACE_FEATURES, ALL_INSTANCED_FEATURES]
    .flatMap((features) => declaredNames(String(sceneSurfaceWgsl(features))))
    .filter((name) => name !== "surface"),
);

/**
 * T1362b — a depth sweep's CUBE-FACE variant, made from the directional one's own text so
 * every generator (grid surface, mesh, instances) gets it without a second copy of itself.
 * The face's clip position is squeezed into its tile of the 3×2 atlas (`cubeTile`: scale
 * xy, centre zw in NDC), a fragment that falls outside its face's frustum is discarded (it
 * belongs to a neighbouring tile), and what is stored is RADIAL distance from the light ÷
 * range (`cubeLight`), which is what the lit lookup compares. Throws if an anchor it
 * rewrites is missing, so a generator that changes shape fails here, loudly.
 */
export const cubeShadowVariant = generatedOnce("cubeShadowVariant", buildCubeShadowVariant);
function buildCubeShadowVariant(shader: EmittedWgsl): EmittedWgsl {
  let text = String(shader);
  const swap = (from: string, to: string): void => {
    if (!text.includes(from)) throw new Error(`cubeShadowVariant: depth shader lacks "${from.slice(0, 60)}"`);
    text = text.replace(from, to);
  };
  swap("  lightViewProjection: mat4x4f,\n", "  lightViewProjection: mat4x4f,\n  cubeLight: vec4f,\n  cubeTile: vec4f,\n");
  swap("  @location(0) depth: f32,\n};", "  @location(0) depth: f32,\n  @location(1) world: vec3f,\n  @location(2) faceClip: vec3f,\n};");
  swap(
    "  out.position = clip;\n",
    "  out.position = vec4f(clip.x * params.cubeTile.x + params.cubeTile.z * clip.w, clip.y * params.cubeTile.y + params.cubeTile.w * clip.w, clip.z, clip.w);\n  out.world = world;\n  out.faceClip = clip.xyw;\n",
  );
  swap(
    "return vec4f(input.depth, 0.0, 0.0, 1.0);",
    "let faceNdc = input.faceClip.xy / input.faceClip.z;\n  if (abs(faceNdc.x) > 1.0 || abs(faceNdc.y) > 1.0) { discard; }\n  return vec4f(length(input.world - params.cubeLight.xyz) / max(params.cubeLight.w, 1e-4), 0.0, 0.0, 1.0);",
  );
  return wgsl`${text}`;
}
