import { describe, expect, it } from "vitest";

import { BackendDiagnosticCode } from "../runtime/backend/diagnostics.ts";
import { probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { createHeadlessMcpServer } from "./serve.ts";

/**
 * T1555b — THE HEADLESS SERVER'S `get_diagnostics` READS THE PROBLEMS REGISTRY.
 *
 * Before this row it answered from the last compile only. The backend's own verdicts went
 * out as `notifications/loom/diagnostics` and were then gone, so an agent that asked
 * "what is wrong?" heard less than a person looking at the Problems pane of the same
 * document. A shader that parses and then fails on the device is the plainest case: the
 * compile is clean, and only the backend knows.
 *
 * The broken body is custom-wgsl.gpu.test.ts's B229 fixture: a call to a function that does
 * not exist parses, so reflection passes, and it fails only at the device.
 */
const BROKEN_BODY = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return notAFunction(uv) * textureSample(inputTexture, inputSampler, uv);
}`;

interface Diagnostic {
  readonly code: string;
  readonly severity?: string;
  readonly nodeId?: string;
}

describe("T1555b — headless get_diagnostics holds what the backend reported", () => {
  it("a shader that fails on the device is in get_diagnostics, not only in a notification", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const sent: Array<Record<string, unknown>> = [];
    const server = createHeadlessMcpServer({ send: (message) => sent.push(message) });
    await server.ready;

    let nextId = 1;
    const call = async (name: string, args: Record<string, unknown>) => {
      const id = nextId++;
      await server.receive({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
      const reply = sent.findLast((message) => message["id"] === id) as {
        result?: { content?: Array<{ text?: string }> };
      };
      return JSON.parse(reply.result?.content?.[0]?.text ?? "{}") as {
        status?: string;
        data?: Record<string, unknown>;
      };
    };
    const notified = (): Diagnostic[] =>
      sent
        .filter((message) => message["method"] === "notifications/loom/diagnostics")
        .flatMap((message) => (message["params"] as { diagnostics: Diagnostic[] }).diagnostics);

    const built = await call("apply_graph_patch", {
      baseRevision: 0,
      operations: [
        { op: "addNode", ref: "$solid", type: "solid", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$broken", type: "customWgsl", position: { x: 200, y: 0 }, parameters: { source: BROKEN_BODY } },
        { op: "addNode", ref: "$out", type: "output", position: { x: 400, y: 0 } },
        { op: "connect", source: { nodeId: "$solid", portId: "out" }, target: { nodeId: "$broken", portId: "input" } },
        { op: "connect", source: { nodeId: "$broken", portId: "out" }, target: { nodeId: "$out", portId: "input" } },
      ],
    });
    expect(built.status).toBe("ok");
    const brokenId = (built.data?.["createdIds"] as Record<string, string>)["$broken"];

    // The render chain is asynchronous; the notification is the backend having spoken.
    for (let wait = 0; wait < 200 && !notified().some((d) => d.code === BackendDiagnosticCode.compileFailed); wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const failure = notified().find((d) => d.code === BackendDiagnosticCode.compileFailed);
    expect(failure?.nodeId, "the backend never reported the broken shader").toBe(brokenId);

    const listed = (await call("get_diagnostics", {})).data?.["diagnostics"] as Diagnostic[];
    expect(listed.filter((d) => d.code === BackendDiagnosticCode.compileFailed).map((d) => d.nodeId)).toEqual([brokenId]);
    // The compile has no error to report about this graph, so without the backend source
    // nothing in the list would say the shader is broken.
    expect(listed.filter((d) => d.severity === "error" && !d.code.startsWith("backend/"))).toEqual([]);
    // Registry order, as on the page: the compile's entries, then the backend's.
    const codes = listed.map((d) => d.code);
    expect(codes.slice(codes.findIndex((code) => code.startsWith("backend/")))).toEqual([BackendDiagnosticCode.compileFailed]);
    server.dispose();
  }, 60_000);
});
