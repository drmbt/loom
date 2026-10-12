import type { ProjectDocument } from "../../domain/types/graph.ts";
import type { GraphPatchOperation, NodeRef, TempId } from "../../domain/types/patch.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { createDomainBus } from "../../domain/commands/index.ts";
import { createSequentialIdFactory } from "../../domain/graph/ids.ts";
import { createGraphStore } from "../../domain/graph/store.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { PHOTO_ALIGNMENT_SHADER } from "../../app/photo-mapping-effects.ts";
import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { wgsl } from "../../runtime/backend/wgsl.ts";
import { document, EXAMPLE_TIMESTAMP, settings } from "./builders.ts";

// One analytic site produces all three registered fields. This is synthetic
// geometry for an executable mapping example, never a model-quality reference.
const ARCHITECTURE = wgsl`
fn rectangle(uv: vec2f, center: vec2f, halfSize: vec2f) -> f32 {
  let distance = abs(uv - center) - halfSize;
  let aa = max(fwidth(uv), vec2f(0.001));
  return (1.0 - smoothstep(-aa.x, aa.x, distance.x)) * (1.0 - smoothstep(-aa.y, aa.y, distance.y));
}
fn site(uv: vec2f) -> vec3f {
  let wall = rectangle(uv, vec2f(0.5, 0.53), vec2f(0.42, 0.42));
  let cell = fract((uv - vec2f(0.10, 0.13)) * vec2f(6.25, 3.85));
  let openings = rectangle(cell, vec2f(0.5, 0.47), vec2f(0.24, 0.27))
    * rectangle(uv, vec2f(0.5, 0.42), vec2f(0.37, 0.28));
  let frames = rectangle(cell, vec2f(0.5, 0.47), vec2f(0.30, 0.33))
    * rectangle(uv, vec2f(0.5, 0.42), vec2f(0.38, 0.30));
  let portal = rectangle(uv, vec2f(0.5, 0.82), vec2f(0.075, 0.13));
  let columns = 1.0 - smoothstep(0.010, 0.022, abs(fract((uv.x - 0.08) * 6.25) - 0.05));
  let cornice = rectangle(uv, vec2f(0.5, 0.11), vec2f(0.43, 0.025));
  let sill = rectangle(uv, vec2f(0.5, 0.70), vec2f(0.425, 0.012));
  let rosePosition = (uv - vec2f(0.5, 0.31)) * vec2f(1.5, 1.0);
  let roseRadius = length(rosePosition);
  let roseRim = 1.0 - smoothstep(0.005, 0.013, abs(roseRadius - 0.078));
  let spokes = pow(0.5 + 0.5 * cos(atan2(rosePosition.y, rosePosition.x) * 12.0), 12.0);
  let roseDisc = 1.0 - smoothstep(0.063, 0.067, roseRadius);
  let roseOpening = roseDisc * (1.0 - spokes);
  let relief = clamp(0.48 + 0.24 * columns + 0.17 * frames - 0.43 * openings
    + 0.31 * cornice + 0.16 * sill - 0.38 * portal + 0.25 * roseRim
    + 0.2 * roseDisc * spokes - 0.3 * roseOpening + 0.055 * sin(uv.x * 3.14159), 0.0, 1.0);
  let excluded = clamp(openings * (1.0 - roseRim) + portal + roseOpening, 0.0, 1.0);
  let mask = max(wall, cornice) * (1.0 - excluded);
  // Working normalized depth is near-bright, matching inverse-depth unprojection.
  return vec3f(relief, mask, excluded);
}`;

const INPUT = wgsl`@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
`;

const REFERENCE_SHADER = wgsl`${INPUT}${ARCHITECTURE}
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let geometry = site(uv);
  let wall = rectangle(uv, vec2f(0.5, 0.53), vec2f(0.42, 0.42));
  let stone = 0.48 + 0.12 * sin(uv.x * 131.0) * sin(uv.y * 97.0);
  let mortar = 1.0 - smoothstep(0.015, 0.035, min(fract(uv.x * 36.0), fract(uv.y * 32.0)));
  let face = vec3f(stone * 0.92, stone * 0.96, stone) * (0.55 + geometry.x * 0.7) - mortar * 0.025;
  let sky = mix(vec3f(0.035, 0.055, 0.105), vec3f(0.07, 0.095, 0.14), uv.y);
  var colour = mix(sky, face, max(wall, geometry.y));
  colour = mix(colour, vec3f(0.015, 0.022, 0.035), geometry.z);
  return vec4f(max(colour, vec3f(0.0)), 1.0);
}`;

const DEPTH_SHADER = wgsl`${INPUT}${ARCHITECTURE}
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let depth = site(uv).x;
  return vec4f(depth, depth, depth, 1.0);
}`;

const MASK_SHADER = wgsl`${INPUT}${ARCHITECTURE}
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let coverage = site(uv).y;
  return vec4f(coverage, coverage, coverage, 1.0);
}`;

const DEMO_VIDEO_SHADER = wgsl`${INPUT}${SHARED_UNIFORMS_WGSL}
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let time = frameU.absTime * 0.22;
  let river = uv.y + sin(uv.x * 8.0 + time) * 0.09 + sin(uv.x * 17.0 - time * 0.7) * 0.03;
  let stripes = 0.5 + 0.5 * cos((river * 10.0 - time) * 6.283185);
  let glints = pow(max(0.0, cos((uv.x * 3.0 + river * 5.0 + time) * 6.283185)), 12.0);
  let colour = mix(vec3f(0.035, 0.14, 0.35), vec3f(0.08, 0.75, 0.9), stripes)
    + vec3f(0.8, 0.45, 0.14) * glints * 0.8;
  return vec4f(colour, 1.0);
}`;

const PASSTHROUGH_SHADER = wgsl`${INPUT}
struct Params { mode: f32, };
@group(0) @binding(3) var<uniform> params: Params;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(inputTexture, inputSampler, uv);
}`;

type CloudMotion = "current" | "falling" | "ribbons";

// One inspectable attribute carries the animation's strength into a separate colour
// stage. Upstream reconstruction is evaluated each frame: these are reversible,
// analytic deformations, not a persistent particle or rigid-body simulation.
const CLOUD_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
  { name: "depthN", type: "f32", default: [0] },
  { name: "motion", type: "vec4f", default: [0, 0, 0, 0] },
]);

const MOTION_HEADER = `struct Params {
  amount: f32, // @default 1
  speed: f32, // @default 1
}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let uv = vec2f(f32(ctx.dim.i) / f32(max(ctx.dim.cols - 1u, 1u)),
                 f32(ctx.dim.j) / f32(max(ctx.dim.rows - 1u, 1u)));
  let t = ctx.absTime * ctx.params.speed;
  let amount = ctx.params.amount;
`;

const CLOUD_MOTION: Record<CloudMotion, string> = {
  current: MOTION_HEADER + `
  // Travelling curls follow relief: deeper samples move farther and at a different phase.
  let phase = uv.x * 13.0 - uv.y * 9.0 + p.depthN * 5.0 - t * 1.7;
  let crest = pow(0.5 + 0.5 * sin(phase), 4.0);
  let depthWeight = 0.25 + p.depthN * 0.75;
  q.position += amount * depthWeight * vec3f(
    0.16 * sin(phase * 0.7 + t * 0.5),
    0.12 * cos(phase * 0.6 - t * 0.3),
    0.38 * sin(phase));
  // x: crest strength; y: depth; zw: original photographic coordinates.
  q.motion = vec4f(crest * abs(amount), p.depthN, uv);
  return q;
}`,
  falling: MOTION_HEADER + `
  // Cohorts share a tile id, release time and spin: this breaks a wall into sections,
  // rather than making every photographic sample fall independently like sand.
  let tile = floor(uv * vec2f(10.0, 7.0));
  let id = tile.x + tile.y * 10.0;
  let seed = fract(sin(id * 17.13 + 3.7) * 43758.5453);
  let phase = fract((t + 1.6) / 12.0) * 12.0;
  let release = (6.0 - tile.y) * 0.34 + seed * 0.6 + 1.2;
  let age = min(max(phase - release, 0.0), 3.0);
  // The final phase reforms the wall; the release wave keeps some architecture visible.
  let reform = 1.0 - smoothstep(7.5, 12.0, phase);
  let falling = smoothstep(0.0, 0.6, age) * reform * amount;
  let center = ((tile + vec2f(0.5)) / vec2f(10.0, 7.0) * 2.0 - 1.0) * vec2f(1.7, 1.15);
  let local = p.position.xy - center;
  let angle = (seed - 0.5) * age * 1.7 * falling;
  let c = cos(angle);
  let sn = sin(angle);
  let spun = center + vec2f(c * local.x - sn * local.y, sn * local.x + c * local.y);
  q.position = vec3f(spun, p.position.z);
  q.position += falling * vec3f((seed - 0.5) * age * 0.34, -0.55 * age * age, age * 0.23);
  // x: release energy; y: deterministic tile id; z: cohort seed; w: local falling age.
  q.motion = vec4f(falling, id, seed, age);
  return q;
}`,
  ribbons: MOTION_HEADER + `
  // Horizontal bands lift off in a travelling wave. Depth changes each band's bend.
  let ribbon = floor(uv.y * 22.0);
  let phase = ribbon * 0.31 - t * 1.25;
  let bend = sin(phase) * (0.3 + 0.7 * p.depthN) * amount;
  let arc = sin(uv.x * 3.14159265);
  q.position.z += arc * bend * 0.85;
  q.position.x += (1.0 - cos(bend * 0.8)) * (uv.x - 0.5) * 0.35;
  q.position.y += sin(uv.x * 6.2831853 + phase) * 0.055 * amount;
  // x: bend energy; y: ribbon id; z: depth; w: original horizontal coordinate.
  q.motion = vec4f(abs(bend), ribbon, p.depthN, uv.x);
  return q;
}`,
};

const ATTRIBUTE_LIGHT = `struct Params {
  strength: f32, // @default 0.65
  warm: f32, // @default 0
}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  // The previous kernel's custom attribute drives this stage, not another time wave.
  let energy = clamp(p.motion.x, 0.0, 1.0);
  let cold = vec3f(0.045, 0.65, 0.82);
  let hot = vec3f(0.95, 0.32, 0.07);
  let light = mix(cold, hot, clamp(ctx.params.warm, 0.0, 1.0));
  let amount = energy * ctx.params.strength;
  q.tint = vec4f(p.tint.rgb * (1.0 + amount) + light * amount * p.tint.a, p.tint.a);
  return q;
}`;

/** Use the application's factory, then replace its external assets with registered synthetic fields. */
async function sampleDocument(number: number, title: string, mode: 10 | 11 | 9 | 13, motion: CloudMotion = "current"): Promise<ProjectDocument> {
  const slug = `e${number}-photo-mapping-${title.toLowerCase().replaceAll(" ", "-")}`;
  const projectSettings = settings({ outputResolution: { width: 480, height: 320 }, randomSeed: number });
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const store = createGraphStore({ ids: createSequentialIdFactory(slug), initialSettings: projectSettings,
    now: () => EXAMPLE_TIMESTAMP });
  const { bus } = createDomainBus({ store, registry });
  const context = { actor: { kind: "human" as const, id: "example-author" }, projectId: slug, capabilities: [] };
  const created = await bus.execute("photoMapping.create", { photo: "synthetic-reference", depth: "synthetic-depth",
    mask: "synthetic-mask", width: 480, height: 320, shader: PASSTHROUGH_SHADER, effect: mode,
    patternShader: PHOTO_ALIGNMENT_SHADER, previewOpacity: mode === 13 ? 1 : 0.7 }, context);
  if (created.status !== "applied") throw new Error(`Photo mapping example factory failed: ${JSON.stringify(created.diagnostics)}`);
  const ids = created.output.createdIds;
  const current = store.view.getGraph();
  const video = mode === 9;
  const replaced = new Map<string, TempId>([[ids.$photo!, "$syntheticPhoto"], [ids.$mask!, "$syntheticMask"]]);
  if (!video) replaced.set(ids.$depth!, "$syntheticDepth");
  if (video) {
    replaced.set(ids.$effect!, "$videoGrade");
    replaced.set(ids.$video!, "$videoChoice");
  }
  const removed = new Set([...replaced.keys(), ...(video ? [ids.$depth!] : [])]);
  const operations: GraphPatchOperation[] = [{ op: "removeNodes", nodeIds: [...removed] }];
  const members: NodeRef[] = Object.keys(current.nodes).filter(id => !removed.has(id));
  const connect = (source: NodeRef, target: NodeRef, portId: string, order?: number): void => {
    operations.push({ op: "connect", source: { nodeId: source, portId: "out" }, target: { nodeId: target, portId },
      ...(order === undefined ? {} : { order }) });
  };
  const add = (ref: TempId, type: string, label: string, x: number, y: number,
    parameters: Record<string, StoredParameter>, scalar = false, size = { width: 220, height: 220 }): void => {
    operations.push({ op: "addNode", ref, type, label, position: { x, y }, parameters },
      { op: "setNodeSize", nodeId: ref, size });
    if (type !== "annotate") operations.push({ op: "setNodeResolution", nodeId: ref,
      resolution: { mode: "fixed", width: 480, height: 320 } });
    if (scalar) operations.push({ op: "setNodeFormat", nodeId: ref, format: { mode: "fixed", format: "r32float" } });
    members.push(ref);
  };
  add("$seed", "checker", "checker_seed", -340, 0, { size: [8, 6] });
  add("$syntheticPhoto", "customWgsl", "wgsl_synthetic_photo", 0, 0, { source: REFERENCE_SHADER });
  add("$syntheticMask", "customWgsl", "wgsl_synthetic_mask", 0, 600, { source: MASK_SHADER }, true);
  if (!video) add("$syntheticDepth", "customWgsl", "wgsl_synthetic_depth", 0, 300, { source: DEPTH_SHADER }, true);
  connect("$seed", "$syntheticPhoto", "input");
  connect("$syntheticPhoto", "$syntheticMask", "input");
  if (!video) connect("$syntheticPhoto", "$syntheticDepth", "input");

  if (video) {
    add("$demo", "customWgsl", "wgsl_demo_video", -340, 900, { source: DEMO_VIDEO_SHADER });
    add("$clip", "movieFileIn", "movie_user_clip", -340, 1200, { file: "", playMode: "freeRun", speed: 1 });
    add("$videoChoice", "switch", "switch_video_content", 0, 900, { index: 0 });
    const effect = current.nodes[ids.$effect!]!;
    add("$videoGrade", "level", "level_video_grade", effect.position.x, effect.position.y, { brightness: 1, contrast: 1 });
    connect("$seed", "$demo", "input");
    connect("$demo", "$videoChoice", "inputs", 0);
    connect("$clip", "$videoChoice", "inputs", 1);
    connect("$videoChoice", "$videoGrade", "input");
  }
  // Restore every external outgoing edge. Internal placeholder edges disappear with their nodes.
  for (const wire of Object.values(current.edges)) {
    const source = replaced.get(wire.source.nodeId);
    if (source !== undefined && !removed.has(wire.target.nodeId)) {
      connect(source, wire.target.nodeId, wire.target.portId, wire.order);
    }
  }
  // The point-cloud viewer inspects 3D geometry; its projector branch still clips and warps.
  // Other looks preview their calibrated image branch directly.
  const previewWire = Object.values(current.edges).find(wire => wire.target.nodeId === ids.$previz && wire.target.portId === "in1");
  if (previewWire === undefined) throw new Error("Photo mapping example is missing its preview overlay.");
  operations.push({ op: "disconnect", edgeIds: [previewWire.id] });
  connect(mode === 13 ? ids.$testSwitch! : ids.$corner!, ids.$previz!, "in1");
  if (mode === 13) operations.push(
    { op: "setParameters", nodeId: ids.$reference!, parameters: { brightness: 0 } },
    { op: "setParameters", nodeId: ids.$motion!, parameters: { offset: 1.2, amplitude: 0.4 } },
    { op: "setParameters", nodeId: ids.$camera!, parameters: { "eye.y": 0.15, "eye.z": 3.1, fov: 55 } },
  );

  if (mode === 13) {
    // Insert authoring nodes through the same command bus as the factory; retain the
    // reconstruct/paint stages and their coverage semantics, then animate the result.
    const cloudWire = Object.values(current.edges).find(wire => wire.target.nodeId === ids.$cloudGeometry && wire.target.portId === "points");
    if (cloudWire === undefined) throw new Error("Photo point cloud is missing its geometry input.");
    operations.push({ op: "disconnect", edgeIds: [cloudWire.id] });
    for (const node of Object.values(current.nodes)) {
      if (node.position.x >= 1040) operations.push({ op: "moveNodes", positions: { [node.id]: { x: node.position.x + 520, y: node.position.y } } });
    }
    for (const [ref, label, x, kernel, parameters] of [
      ["$motionKernel", `kernel_${motion}`, 1040, CLOUD_MOTION[motion], { amount: 1, speed: 1 }],
      ["$attributeLight", "kernel_attribute_light", 1300, ATTRIBUTE_LIGHT, { strength: motion === "falling" ? 0.5 : 0.65, warm: motion === "falling" ? 1 : 0 }],
    ] as const) {
      operations.push({ op: "addNode", ref, type: "pointKernel", label, position: { x, y: 0 },
        parameters: { capacity: 768 * 512, seed: number, attributes: CLOUD_ATTRIBUTES, kernel, ...parameters } },
        { op: "setNodeSize", nodeId: ref, size: { width: 220, height: 220 } });
      members.push(ref);
    }
    connect(ids.$paint!, "$motionKernel", "in");
    connect("$motionKernel", "$attributeLight", "in");
    connect("$attributeLight", ids.$cloudGeometry!, "points");
    if (motion === "falling") operations.push({ op: "setParameters", nodeId: ids.$reference!, parameters: { brightness: 0.12 } });
    // A quieter camera makes movement of the points the subject of these samples.
    operations.push({ op: "setParameters", nodeId: ids.$motion!, parameters: { offset: 0, amplitude: 0.08 } });
  }

  add("$sourceNote", "annotate", "note_synthetic_site", -340, -320, {
    title: "Synthetic facade · registered RGB, depth and mask",
    body: video
      ? "The stone photograph and surface mask share one analytic facade with window recesses, portal, pilasters and a carved rosette. This executable workflow is synthetic, not a demonstration of AI depth quality. Coverage stays an r32float data texture. Replace these two source nodes with your registered photograph and mask for a real facade."
      : "The stone photograph and scalar fields share one analytic facade with window recesses, portal, pilasters and a carved rosette. This executable workflow is synthetic, not a demonstration of AI depth quality. Depth and coverage stay r32float data textures. Replace these three source nodes with your saved photograph and maps for a real facade.",
    color: "shader" }, false, { width: 1000, height: 220 });
  add("$alignmentNote", "annotate", "note_alignment", mode === 13 ? 1760 : 760, -320, {
    title: "Shared calibration and projector path",
    body: mode === 13
      ? "switch_calibration1: 0 content, 1 regular test chart. Window Out clips with mask_surface1 and follows gridwarp_surface1 and cornerpin_surface1. The inspection preview shows the 3D cloud before the image-space clip. Open window_projector1 explicitly to project it. Every stage remains editable."
      : "switch_calibration1: 0 content, 1 regular test chart. Both pass through mask_surface1, gridwarp_surface1 and cornerpin_surface1. The preview shows that same warped branch over the reference photograph. Open window_projector1 explicitly to project it. Every stage remains editable.",
    color: "output" }, false, { width: 900, height: 220 });
  const explanation = mode === 10 ? "Ivory grazing light: depth_range → grazing_light → Multiply with projection_tint → Level. Change the light direction, relief and shadow inside the small shader, animate direction with lfo_photo_motion1, and grade intensity outside the shader. The depth field drives light across actual relief; it is not a rainbow depth display."
    : mode === 11 ? "Contour engraving: depth_range → contours → Multiply with projection_tint → Level. Edit contour spacing and line width in wgsl_contours1, motion in lfo_photo_motion1, and colour/intensity in Solid and Level. The scalar depth creates lines through the carved relief instead of flat screen-space stripes."
    : mode === 13 ? `Real point geometry: pointGrid → relative_depth → photo_colour → Geometry → Render and Camera. The 768 × 512 grid holds 393,216 photo-coloured points. Coverage scales excluded points to zero area; keep heat=0 for photographic colour. After reconstruction, kernel_${motion} deforms positions and writes motion, and kernel_attribute_light reads that custom attribute to colour the active parts. Amount zero disables deformation and its colour cue. These are reversible animated deformations, not a persistent physical simulation. Density, point size, gain and camera pose are separate editable nodes. Near/far and FOV are assumed display geometry, not metric measurements. level_reference1 controls the source photograph underlay.`
    : "Explicit video sources: switch_video_content 0 plays the animated procedural demo; 1 plays movie_user_clip after you assign a local clip. Nothing chooses the demo when a clip fails. Content goes through ordinary Level, then the shared surface mask, calibration switch and projector warps. The photograph remains the registration reference; this recipe does not use depth.";
  add("$recipeNote", "annotate", "note_editable_recipe", 0, 1260, { title: title + " · editable stages", body: explanation,
    color: "shader" }, false, { width: 1500, height: 250 });
  const group = current.groups[ids.$group!]!;
  operations.push({ op: "setGroup", groupId: group.id, members,
    bounds: { x: -380, y: -360, width: Math.max(group.bounds.width + (mode === 13 ? 900 : 380), 2100), height: 1910 } });
  const adapted = await bus.execute("graph.applyPatch", { baseRevision: current.revision,
    label: "Use synthetic registered example assets", operations }, context);
  if (adapted.status !== "applied") throw new Error(`Photo mapping example adaptation failed: ${JSON.stringify(adapted.diagnostics)}`);
  return document(slug, `E${number} Photo Mapping ${title}`, projectSettings, store.view.getGraph());
}

export const photoMappingMoonlitStoneDocument = await sampleDocument(83, "Moonlit Stone", 10);
export const photoMappingContourEngravingDocument = await sampleDocument(84, "Contour Engraving", 11);
export const photoMappingVideoDocument = await sampleDocument(85, "Video", 9);
export const photoMappingPointCloudDocument = await sampleDocument(86, "Point Cloud", 13);

export const photoMappingFallingFacadeDocument = await sampleDocument(87, "Falling Facade", 13, "falling");
export const photoMappingRibbonPeelDocument = await sampleDocument(88, "Ribbon Peel", 13, "ribbons");
