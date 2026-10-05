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

/** What `run` asked of the device: the counters' movement across it. */
export function during(seen: DeviceCalls, run: () => void): DeviceCalls {
  const before = { ...seen };
  run();
  return { renderPasses: seen.renderPasses - before.renderPasses, clears: seen.clears - before.clears, draws: seen.draws - before.draws, pipelines: seen.pipelines - before.pipelines };
}
