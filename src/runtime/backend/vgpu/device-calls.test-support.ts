import { vi } from "vitest";

import type { MockGpuHost } from "./mock-gpu-host.ts";

/**
 * What a backend ASKS OF THE DEVICE, counted (T1598b, T1604b): render passes begun, how
 * many of them cleared, draw calls made, pipelines built. Test support for the mock host.
 *
 * These are the numbers no picture shows. A draw that would have put nothing in its target
 * and a draw that was never encoded render the same frame; so do two hundred render passes
 * and nineteen. What differs is what the device was asked to do, and that is the cost.
 */
export interface DeviceCalls {
  renderPasses: number;
  /** Render passes whose colour attachment was cleared rather than loaded. */
  clears: number;
  draws: number;
  pipelines: number;
}

export function countDeviceCalls(host: MockGpuHost): DeviceCalls {
  const device = host.device;
  if (device === undefined) throw new Error("countDeviceCalls: the mock host has no device yet; initialize the backend first.");
  const seen: DeviceCalls = { renderPasses: 0, clears: 0, draws: 0, pipelines: 0 };
  const createEncoder = device.createCommandEncoder.bind(device);
  vi.spyOn(device, "createCommandEncoder").mockImplementation((descriptor) => {
    const encoder = createEncoder(descriptor);
    const begin = encoder.beginRenderPass.bind(encoder);
    vi.spyOn(encoder, "beginRenderPass").mockImplementation((passDescriptor) => {
      seen.renderPasses += 1;
      const first = [...passDescriptor.colorAttachments][0];
      if (first?.loadOp === "clear") seen.clears += 1;
      const pass = begin(passDescriptor);
      for (const name of ["draw", "drawIndirect"] as const) {
        const call = (pass[name] as (...args: unknown[]) => void).bind(pass);
        vi.spyOn(pass, name).mockImplementation(((...args: unknown[]) => {
          seen.draws += 1;
          call(...args);
        }) as never);
      }
      return pass;
    });
    return encoder;
  });
  const createPipeline = device.createRenderPipeline.bind(device);
  vi.spyOn(device, "createRenderPipeline").mockImplementation((descriptor) => {
    seen.pipelines += 1;
    return createPipeline(descriptor);
  });
  return seen;
}

/**
 * T1623b: what a backend BUILDS and what it WRITES, from the call on — shader modules,
 * pipelines of both kinds, and every `queue.writeBuffer` with its byte offset and its bytes.
 * A value that changes must show up in `writes` and move neither count; a second counter
 * rather than more fields on `DeviceCalls`, whose callers compare it whole.
 */
export interface DeviceBuilds {
  /** Each write as the byte offset it went to and the bytes it carried, read as f32 and as u32. */
  writes: Array<{ offset: number; floats: number[]; words: number[] }>;
  modules: number;
  /** Render and compute pipelines together. */
  pipelines: number;
  /** `queue.submit` calls: how many command buffers a frame is. */
  submits: number;
}

export function countBuildsAndWrites(host: MockGpuHost): DeviceBuilds {
  const device = host.device;
  if (device === undefined) throw new Error("countBuildsAndWrites: the mock host has no device yet; initialize the backend first.");
  const seen: DeviceBuilds = { writes: [], modules: 0, pipelines: 0, submits: 0 };
  const submit = device.queue.submit.bind(device.queue);
  vi.spyOn(device.queue, "submit").mockImplementation((buffers) => {
    seen.submits += 1;
    submit(buffers);
  });
  const write = device.queue.writeBuffer.bind(device.queue) as (...args: unknown[]) => void;
  vi.spyOn(device.queue, "writeBuffer").mockImplementation(((...args: unknown[]) => {
    const data = args[2] as ArrayBuffer | ArrayBufferView;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const copy = bytes.slice().buffer;
    seen.writes.push({ offset: args[1] as number, floats: [...new Float32Array(copy)], words: [...new Uint32Array(copy)] });
    write(...args);
  }) as never);
  for (const name of ["createShaderModule", "createComputePipeline", "createRenderPipeline"] as const) {
    const create = (device[name] as (...args: unknown[]) => unknown).bind(device);
    vi.spyOn(device, name).mockImplementation(((...args: unknown[]) => {
      if (name === "createShaderModule") seen.modules += 1;
      else seen.pipelines += 1;
      return create(...args);
    }) as never);
  }
  return seen;
}

/** What `run` asked of the device: the counters' movement across it. */
export function during(seen: DeviceCalls, run: () => void): DeviceCalls {
  const before = { ...seen };
  run();
  return { renderPasses: seen.renderPasses - before.renderPasses, clears: seen.clears - before.clears, draws: seen.draws - before.draws, pipelines: seen.pipelines - before.pipelines };
}
