export const VERTEX = `
struct VertexOut { @builtin(position) pos:vec4f, @location(0) uv:vec2f };
@vertex fn vs(@builtin(vertex_index) i:u32)->VertexOut {
  var p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  var v:VertexOut;v.pos=vec4f(p[i],0,1);v.uv=vec2f((p[i].x+1)*0.5,(1-p[i].y)*0.5);return v;
}
`;
export const COPY = `
@group(0) @binding(0) var inputTexture:texture_2d<f32>;
@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {
 return textureLoad(inputTexture,vec2i(uv*vec2f(textureDimensions(inputTexture))),0);
}`;
export const COMPUTE = `
struct Params {gain:f32,pulse:f32,timeSeconds:f32,pad:f32};
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<storage,read_write> factor:array<f32>;
@compute @workgroup_size(1) fn main() {
 factor[0]=params.gain*(1-params.pulse*(0.5-0.5*cos(params.timeSeconds*6.28318530718)));
}`;
export const DRAW = `
@group(0) @binding(0) var inputTexture:texture_2d<f32>;
@group(0) @binding(1) var<storage,read> factor:array<f32>;
@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {
 let c=textureLoad(inputTexture,vec2i(uv*vec2f(textureDimensions(inputTexture))),0);
 return vec4f(c.rgb*factor[0],c.a);
}`;
