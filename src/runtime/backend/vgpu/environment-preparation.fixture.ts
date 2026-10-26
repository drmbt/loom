import { frameFromClock } from "../../../domain/types/frame.ts";
import type { FrameInputs, LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import { wgsl } from "../wgsl.ts";

const SOURCE = wgsl`struct Params { color: vec4f }; @group(0) @binding(0) var<uniform> params: Params;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f { return params.color; }`;
const PREPARE = wgsl`@group(0) @binding(0) var image: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let corners = array(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return vec4f(corners[i],0,1);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f { return textureLoad(image,vec2i(p.xy),0); }`;
const OUTPUT = wgsl`struct Params { phase: f32 }; @group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: Params;
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let value = textureLoad(image,vec2i(p.xy),0); return value + vec4f(0,0,params.phase*0.01,0);
}`;

export function preparationFixture({ external = false, metadata = true, two = true } = {}): LogicalExecutionPlan {
  const resources: Record<string, unknown>[] = external ? [{ kind: "externalTexture", id: "source", sourceId: "photo", size: [8,8], format: "rgba8unorm" }]
    : [{ kind: "target", id: "source", size: [8,8], format: "rgba8unorm" }];
  const passes: Record<string, unknown>[] = external ? [] : [{ kind: "effect", id: "source", shader: SOURCE, target: "source", uniformBinding: "params", uniforms: { color: [1,0,0,1] } }];
  for (const owner of two ? ["a","b"] : ["a"]) {
    let input = "source";
    for (let step = 0; step < 6; step++) {
      const id = `${owner}:${step}`;
      resources.push({ kind: "target", id, size: [8,8], format: "rgba8unorm" });
      passes.push({ kind: "draw", id, nodeId: owner, shader: PREPARE, target: id, topology: "triangle-list", vertexCount: 3, instances: 1, clear: true,
        textures: [{ binding: "image", resourceId: input, sampled: "unfiltered" }], ...(metadata ? { preparation: { kind: "environment", source: "source" } } : {}) });
      input = id;
    }
    resources.push({ kind: "target", id: `${owner}:out`, size: [8,8], format: "rgba8unorm" });
    passes.push({ kind: "effect", id: `${owner}:out`, shader: OUTPUT, target: `${owner}:out`, textures: [{ binding: "image", resourceId: input, sampled: "unfiltered" }], uniformBinding: "params", uniforms: { phase: 0 } });
  }
  return { resources, passes, diagnostics: [] } as unknown as LogicalExecutionPlan;
}

export const PREPARATION_INPUT: FrameInputs = { frame: frameFromClock({ timeSeconds: 0, deltaSeconds: 1/60, frameIndex: 0, mode: "offline", randomSeed: 7, fps: 60 }), pointer: { x:0,y:0,buttons:0 }, resolution:[8,8] };

