import type { GraphNode, ProjectDocument } from "../../domain/types/graph.ts";
import { PHOTO_ALIGNMENT_SHADER, PHOTO_MAPPING_SHADER } from "../../app/photo-mapping-effects.ts";
import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { wgsl } from "../../runtime/backend/wgsl.ts";
import { document, edge, graph, named, settings } from "./builders.ts";

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
  let depth = clamp(0.48 + 0.24 * columns + 0.17 * frames - 0.43 * openings
    + 0.31 * cornice + 0.16 * sill - 0.38 * portal + 0.055 * sin(uv.x * 3.14159), 0.0, 1.0);
  let mask = max(wall, cornice) * (1.0 - openings) * (1.0 - portal);
  return vec3f(depth, mask, clamp(openings + portal, 0.0, 1.0));
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

function sampleDocument(number: number, title: string, mode: 5 | 6 | 9): ProjectDocument {
  const video = mode === 9;
  const nodes: GraphNode[] = [
    named("synthetic_site", "annotate", [-1740, -360], {
      title: "Synthetic facade · no model download",
      body: "The photo, depth and mask are analytic shader fields with matching image coordinates. This is a mapping workflow demonstration, not evidence of AI depth accuracy. Window openings and the portal stay unlit.",
      color: "shader",
    }, { size: { width: 1300, height: 230 } }),
    named("alignment", "annotate", [-260, -360], {
      title: "One projection path · content or calibration",
      body: "switch_calibration index 0 shows the effect; index 1 shows the regular alignment chart. Both use mask_surface, gridwarp_surface and cornerpin_surface. output_preview compares that mapped result with the reference photo. Open window_projector explicitly to project it.",
      color: "output",
    }, { size: { width: 1320, height: 230 } }),
    named("seed", "checker", [-1680, 0], { size: [8, 6], color1: [0, 0, 0, 1], color2: [1, 1, 1, 1] }),
    named("synthetic_photo", "customWgsl", [-1360, 0], { source: REFERENCE_SHADER }),
    named("synthetic_depth", "customWgsl", [-1360, 320], { source: DEPTH_SHADER }),
    named("synthetic_mask", "customWgsl", [-1360, 640], { source: MASK_SHADER }),
    named("relief", "customWgslMulti", [-980, 0], { source: PHOTO_MAPPING_SHADER, mode,
      gain: 1.15, speed: 0.2, architectureDetail: 0.85, depthStrength: 1.3, glow: 0.35, edgeGlow: 0.85 }),
    named("calibration", "customWgsl", [-980, 640], { source: PHOTO_ALIGNMENT_SHADER }),
    named("calibration", "switch", [-620, 0], { index: 0 }),
    named("surface", "mask", [-260, 0], { channel: "red", apply: "colour" }),
    named("surface", "gridWarp", [100, 0], {}),
    named("surface", "cornerPin", [460, 0], {}),
    named("projector", "window", [820, 0], { width: 480, height: 320, fit: "stretch" }),
    named("reference", "level", [-980, 320], { brightness: 0.6 }),
    named("preview", "screen", [-620, 320], { opacity: 0.75 }),
    named("preview", "output", [-260, 320], {}),
  ];
  if (video) nodes.push(
    named("demo_video", "customWgsl", [-1680, 960], { source: DEMO_VIDEO_SHADER }),
    named("user_clip", "movieFileIn", [-1680, 1280], { file: "", playMode: "freeRun", speed: 1 }),
    named("video_content", "switch", [-1360, 960], { index: 0 }),
    named("video_content", "annotate", [-1360, 1280], { title: "Demo 0 · your video 1",
      body: "The shipped picture is animated procedural content. Assign a local clip to movie_user_clip, then set switch_video_content to 1. This is an explicit source choice: a missing clip does not select the demo automatically. The clip uses the same mask and projector alignment.",
      color: "input" }, { size: { width: 840, height: 250 } }),
  );
  const edges = [
    edge("seed-photo", ["checker_seed", "out"], ["wgsl_synthetic_photo", "input"]),
    edge("photo-depth", ["wgsl_synthetic_photo", "out"], ["wgsl_synthetic_depth", "input"]),
    edge("photo-mask", ["wgsl_synthetic_photo", "out"], ["wgsl_synthetic_mask", "input"]),
    edge("photo-pattern", ["wgsl_synthetic_photo", "out"], ["wgsl_calibration", "input"]),
    edge("source-effect", [video ? "switch_video_content" : "wgsl_synthetic_photo", "out"], ["wgsl_relief", "input"]),
    edge("depth-effect", ["wgsl_synthetic_depth", "out"], ["wgsl_relief", "more"], 0),
    edge("mask-effect", ["wgsl_synthetic_mask", "out"], ["wgsl_relief", "more"], 1),
    edge("effect-choice", ["wgsl_relief", "out"], ["switch_calibration", "inputs"], 0),
    edge("pattern-choice", ["wgsl_calibration", "out"], ["switch_calibration", "inputs"], 1),
    edge("choice-coverage", ["switch_calibration", "out"], ["mask_surface", "input"]),
    edge("mask-coverage", ["wgsl_synthetic_mask", "out"], ["mask_surface", "mask"]),
    edge("coverage-grid", ["mask_surface", "out"], ["gridwarp_surface", "input"]),
    edge("grid-corner", ["gridwarp_surface", "out"], ["cornerpin_surface", "input"]),
    edge("corner-projector", ["cornerpin_surface", "out"], ["window_projector", "input"]),
    edge("photo-reference", ["wgsl_synthetic_photo", "out"], ["level_reference", "input"]),
    edge("mapped-preview", ["cornerpin_surface", "out"], ["screen_preview", "in1"]),
    edge("reference-preview", ["level_reference", "out"], ["screen_preview", "in2"]),
    edge("preview-output", ["screen_preview", "out"], ["output_preview", "input"]),
  ];
  if (video) edges.push(
    edge("seed-demo", ["checker_seed", "out"], ["wgsl_demo_video", "input"]),
    edge("demo-video-choice", ["wgsl_demo_video", "out"], ["switch_video_content", "inputs"], 0),
    edge("clip-video-choice", ["movie_user_clip", "out"], ["switch_video_content", "inputs"], 1),
  );
  return document(`e${number}-photo-mapping-${mode === 5 ? "moonlit-stone" : mode === 6 ? "liquid-strata" : "video"}`,
    `E${number} Photo Mapping ${title}`, settings({ outputResolution: { width: 480, height: 320 }, randomSeed: number }), graph(nodes, edges));
}

export const photoMappingMoonlitStoneDocument = sampleDocument(83, "Moonlit Stone", 5);
export const photoMappingLiquidStrataDocument = sampleDocument(84, "Liquid Strata", 6);
export const photoMappingVideoDocument = sampleDocument(85, "Video", 9);
