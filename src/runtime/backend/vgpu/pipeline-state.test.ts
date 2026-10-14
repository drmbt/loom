import { afterEach, expect, test, vi } from "vitest";
import { draw, frame, init, target } from "vgpu/mock";

import { preparedShader } from "./prepared-shader.ts";

const SHADER = `@group(0) @binding(0) var<uniform> color: vec4f;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(0, 0, 0, 1); }
@fragment fn fs() -> @location(0) vec4f { return color; }`;
afterEach(() => vi.restoreAllMocks());

async function scene() {
  const gpu = await init();
  const out = target(gpu, { size: [8, 8] });
  const color = gpu.device.createBuffer({ size: 768, usage: ["uniform", "copy_dst"] });
  const a = draw(gpu, { shader: preparedShader(SHADER, "a"), vertices: 3, set: { color: { buffer: color.gpu, offset: 0, size: 16 } } });
  const b = draw(gpu, { shader: preparedShader(SHADER.replace("return color;", "return color * 0.5;"), "b"), vertices: 3, set: { color: { buffer: color.gpu, offset: 0, size: 16 } } });
  const passes: { pipeline: { mock: { calls: unknown[][] } }; group: { mock: { calls: unknown[][] } } }[] = [];
  const original = gpu.gpu.createCommandEncoder.bind(gpu.gpu);
  vi.spyOn(gpu.gpu, "createCommandEncoder").mockImplementation(descriptor => {
    const encoder = original(descriptor);
    const begin = encoder.beginRenderPass.bind(encoder);
    encoder.beginRenderPass = descriptor => {
      const native = begin(descriptor);
      const pipeline = vi.spyOn(native, "setPipeline");
      const group = vi.spyOn(native, "setBindGroup");
      passes.push({ pipeline, group });
      return native;
    };
    return encoder;
  });
  return { gpu, out, color, a, b, passes };
}

test("same native pipeline is set once; bindings keep their validation path", async () => {
  const { gpu, out, a, passes } = await scene();
  try {
    frame(gpu, f => f.pass(out, p => { p.draw(a); p.draw(a); p.draw(a); }));
    expect(passes[0]!.pipeline).toHaveBeenCalledTimes(1);
    expect(passes[0]!.group).toHaveBeenCalledTimes(3);
  } finally { gpu.dispose(); }
});

test("pipeline A-B-A restores bindings even when the previous group identity returns", async () => {
  const { gpu, out, a, b, passes } = await scene();
  try {
    frame(gpu, f => f.pass(out, p => { p.draw(a); p.draw(b); p.draw(a); }));
    expect(passes[0]!.pipeline).toHaveBeenCalledTimes(3);
    expect(passes[0]!.group).toHaveBeenCalledTimes(3);
  } finally { gpu.dispose(); }
});

test("mutating the same dynamic-offset array changes the native binding", async () => {
  const { gpu, out, a, passes } = await scene();
  try {
    a.layout(0, { dynamicOffsets: true });
    const offsets = [0];
    frame(gpu, f => f.pass(out, p => { p.draw(a, { offsets }); offsets[0] = 256; p.draw(a, { offsets }); p.draw(a, { offsets }); }));
    expect(passes[0]!.pipeline).toHaveBeenCalledTimes(1);
    expect(passes[0]!.group).toHaveBeenCalledTimes(3);
  } finally { gpu.dispose(); }
});

test("a resource rebind emits the changed group without rebinding an unchanged pipeline", async () => {
  const { gpu, out, color, a, passes } = await scene();
  try {
    frame(gpu, f => f.pass(out, p => { p.draw(a); a.set({ color: { buffer: color.gpu, offset: 256, size: 16 } }); p.draw(a); }));
    expect(passes[0]!.pipeline).toHaveBeenCalledTimes(1);
    expect(passes[0]!.group).toHaveBeenCalledTimes(2);
  } finally { gpu.dispose(); }
});

test("separate passes bind their state independently", async () => {
  const { gpu, out, a, passes } = await scene();
  try {
    frame(gpu, f => { f.pass(out, p => { p.draw(a); p.draw(a); }); f.pass(out, p => { p.draw(a); p.draw(a); }); });
    expect(passes).toHaveLength(2);
    for (const pass of passes) { expect(pass.pipeline).toHaveBeenCalledTimes(1); expect(pass.group).toHaveBeenCalledTimes(2); }
  } finally { gpu.dispose(); }
});

test("even an empty bundle execution invalidates native binding state", async () => {
  const { gpu, out, a, passes } = await scene();
  try {
    frame(gpu, f => f.pass(out, p => { p.draw(a); p.bundles(); p.draw(a); }));
    expect(passes[0]!.pipeline).toHaveBeenCalledTimes(2);
    expect(passes[0]!.group).toHaveBeenCalledTimes(2);
  } finally { gpu.dispose(); }
});

