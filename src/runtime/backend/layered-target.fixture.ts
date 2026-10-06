import type { LogicalExecutionPlan } from "../../domain/types/backend.ts";
import { wgsl } from "./wgsl.ts";

/**
 * T1623b slice 4 — the plans the layered-target tests share (`layered-target.test.ts` reads
 * them at the plan contract and on the mock device, `vgpu/layered-target.gpu.test.ts` their
 * pixels on Dawn, so the two cannot be talking about different plans).
 *
 * `maps` is a layered target of three layers, r32float, with or without the shared depth
 * buffer. A PAINT draw fills one layer with one number at one depth; the READER draws into
 * `out`, six pixels wide, two pixels a layer, and copies what it reads from that layer's
 * first texel into red, with the texture's own layer count in green. It binds the array
 * whole; the VIEW_READER binds a layer a binding, each a plain 2D texture.
 */

/** A full-target triangle at depth `value.y` that writes `value.x`. */
export const PAINT = wgsl`struct Paint {
  value: vec4f,             // x: the number written. y: the depth it is drawn at
};
@group(0) @binding(0) var<uniform> params: Paint;

@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[index], params.value.y, 1.0);
}
@fragment fn fs() -> @location(0) vec4f {
  return vec4f(params.value.x, 0.0, 0.0, 1.0);
}`;

/** Reads every layer through ONE binding: the layer is picked by the pixel's column. */
export const READER = wgsl`@group(0) @binding(0) var maps: texture_2d_array<f32>;

@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[index], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) at: vec4f) -> @location(0) vec4f {
  let layer = u32(at.x) / 2u;
  return vec4f(textureLoad(maps, vec2i(0, 0), layer, 0).r, f32(textureNumLayers(maps)), 0.0, 1.0);
}`;

/**
 * Reads each layer through a binding of ITS OWN, a plain `texture_2d`: the shader does not know
 * they are layers of one texture. Pixel column pair k shows what binding `map{k}` holds, with that
 * texture's width in green.
 */
export const VIEW_READER = wgsl`@group(0) @binding(0) var map0: texture_2d<f32>;
@group(0) @binding(1) var map1: texture_2d<f32>;
@group(0) @binding(2) var map2: texture_2d<f32>;

@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[index], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) at: vec4f) -> @location(0) vec4f {
  let column = u32(at.x) / 2u;
  var value = textureLoad(map0, vec2i(0, 0), 0).r;
  if (column == 1u) { value = textureLoad(map1, vec2i(0, 0), 0).r; }
  if (column == 2u) { value = textureLoad(map2, vec2i(0, 0), 0).r; }
  return vec4f(value, f32(textureDimensions(map0, 0).x), 0.0, 1.0);
}`;

export const LAYERS = 3;
/** The reader's picture: two pixels a layer. */
export const OUT_SIZE = [LAYERS * 2, 2] as const;

export interface Paint {
  readonly id: string;
  readonly layer?: number;
  readonly value: number;
  readonly depth?: number;
  readonly clear?: boolean;
}

/** `maps` painted as said, then read into `out`. */
export function layeredPlan(
  paints: ReadonlyArray<Paint>,
  /** `views`: the reader binds `map0`, `map1`, `map2`, each ONE layer, these (a layer a binding, in this order). */
  options: { readonly depth?: boolean; readonly layers?: number; readonly views?: readonly [number, number, number] } = {},
): LogicalExecutionPlan {
  return {
    resources: [
      { kind: "layers", id: "maps", size: [4, 4], format: "r32float", layers: options.layers ?? LAYERS, ...(options.depth === false ? {} : { depth: true }) },
      { kind: "target", id: "out", size: OUT_SIZE, format: "rgba16float" },
    ],
    passes: [
      ...paints.map((paint) => ({
        kind: "draw",
        id: paint.id,
        nodeId: "painter",
        shader: PAINT,
        target: "maps",
        ...(paint.layer === undefined ? {} : { layer: paint.layer }),
        topology: "triangle-list",
        instances: 1,
        vertexCount: 3,
        uniforms: { value: [paint.value, paint.depth ?? 0.5, 0, 0] },
        uniformBinding: "params",
        clear: paint.clear ?? true,
      })),
      {
        kind: "draw",
        id: "reader",
        nodeId: "reader",
        shader: options.views === undefined ? READER : VIEW_READER,
        target: "out",
        topology: "triangle-list",
        instances: 1,
        vertexCount: 3,
        textures:
          options.views === undefined
            ? [{ binding: "maps", resourceId: "maps", sampled: "unfiltered", array: true }]
            : options.views.map((layer, index) => ({ binding: `map${index}`, resourceId: "maps", sampled: "unfiltered", layer })),
      },
    ],
    diagnostics: [],
  } as unknown as LogicalExecutionPlan;
}
