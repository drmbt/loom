import { describe, expect, it } from "vitest";

import { probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { createHeadlessMcpServer } from "./serve.ts";

/**
 * T294 end to end: the HEADLESS server with a real GPU behind it. An MCP client
 * builds a graph with the same tool calls an in-tab agent would make, then asks for
 * pixels — and gets MCP image content computed on Dawn, over what is functionally
 * stdio. This is the "agents look at outputs with ease" story with nothing mocked:
 * transport shapes in, rendered bytes out.
 */

describe("headless MCP server on Dawn (T294)", () => {
  it("builds solid → output over the protocol and renders a preview with real pixels", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const sent: Array<Record<string, unknown>> = [];
    const server = createHeadlessMcpServer({ send: (message) => sent.push(message), grantExport: true });
    await server.ready;

    let nextId = 1;
    const call = async (name: string, args: Record<string, unknown>) => {
      const id = nextId++;
      await server.receive({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      });
      const reply = sent.findLast((message) => message["id"] === id) as {
        result?: { content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
      };
      return reply.result;
    };

    const createdId = (result: Awaited<ReturnType<typeof call>>): string | undefined => {
      const parsed = JSON.parse(result?.content?.[0]?.text ?? "{}") as {
        data?: { createdIds?: Record<string, string> };
      };
      return parsed.data?.createdIds?.["$node"];
    };
    const added = await call("add_node", { type: "solid", parameters: { color: [1, 0, 0, 1] } });
    const solidId = createdId(added);
    expect(solidId, "add_node must return the new node id").toBeTypeOf("string");

    const out = await call("add_node", {
      type: "output",
      placement: { relativeTo: solidId, direction: "right" },
    });
    const outId = createdId(out);
    await call("connect_ports", {
      source: { nodeId: solidId, portId: "out" },
      target: { nodeId: outId, portId: "input" },
    });

    // The revision notifications streamed while we built (quasi-realtime, T290).
    expect(sent.some((message) => message["method"] === "notifications/loom/revision")).toBe(true);

    const preview = await call("render_preview", { nodeId: solidId, maxSize: 64 });
    const image = preview?.content?.find((entry) => entry.type === "image");
    expect(image, "render_preview must return MCP image content").toBeDefined();
    expect(image?.mimeType).toBe("image/png");
    // Real pixels: a PNG of a red solid is comfortably past any header-only size.
    expect((image?.data ?? "").length).toBeGreaterThan(100);

    server.dispose();
  });

  it("refuses pixel tools without --grant-export, naming the gap (T334)", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const server = createHeadlessMcpServer({ send: (message) => sent.push(message) });
    await server.ready;
    await server.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "render_preview", arguments: { nodeId: "anything" } },
    });
    const reply = sent.findLast((message) => message["id"] === 1) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const result = JSON.parse(reply.result?.content?.[0]?.text ?? "{}") as {
      status?: string;
      diagnostics?: Array<{ code?: string }>;
    };
    expect(result.status).toBe("denied");
    expect(result.diagnostics?.[0]?.code).toBe("capability.denied");
    server.dispose();
  });
});

/**
 * §T1544b — the headless server renders (and `compile_project` reports) the timeline's
 * structure AT THE FRAME IT RENDERS. It steps one offline frame per document change at
 * 60 fps; a following cue list turns a Layer on at 0.1 s (frame 6). A blue Solid under the
 * Layer, whose picture is a red Solid with Blend `replace`: before frame 6 the output is
 * blue, from it on red — read back as numbers (`describe_output`) — and the plan carries the
 * Layer's pass and its picture's (`compile_project`). Until §T1544b both stayed in the stored structure.
 */
describe("§T1544b — the headless render applies timeline structure at the frame it renders", () => {
  it("before the cue frame: the Layer off (blue, no Layer pass); past it: on (red, two passes more)", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const sent: Array<Record<string, unknown>> = [];
    const server = createHeadlessMcpServer({ send: (message) => sent.push(message), grantExport: true });
    await server.ready;
    let nextId = 1;
    interface Reply {
      status?: string;
      data?: Record<string, unknown>;
    }
    const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
      const id = nextId++;
      await server.receive({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
      const reply = sent.findLast((message) => message["id"] === id) as { result?: { content?: Array<{ text?: string }> } };
      return JSON.parse(reply.result?.content?.[0]?.text ?? "{}") as Reply;
    };
    const revision = async (): Promise<number> => Number((await call("get_project_summary", {})).data?.["revision"] ?? 0);
    const presets = JSON.stringify({ version: 1, presets: [{ name: "on", values: {}, on: { layer1: true } }] });
    const cues = JSON.stringify({ version: 1, cues: [{ name: "in", bank: "stage", preset: "on", at: 0.1 }] });
    const built = await call("apply_graph_patch", {
      baseRevision: await revision(),
      operations: [
        { op: "addNode", ref: "$blue", type: "solid", position: { x: 0, y: 0 }, label: "blue", parameters: { color: [0, 0, 1, 1] } },
        { op: "addNode", ref: "$red", type: "solid", position: { x: 0, y: 100 }, label: "red", parameters: { color: [1, 0, 0, 1] } },
        { op: "addNode", ref: "$layer", type: "layer", position: { x: 200, y: 0 }, label: "layer1", parameters: { picture: "red", blend: "replace" } },
        { op: "addNode", ref: "$out", type: "output", position: { x: 400, y: 0 }, label: "out1" },
        { op: "addNode", ref: "$spare", type: "solid", position: { x: 0, y: 400 }, label: "spare" },
        { op: "addNode", ref: "$stage", type: "presets", position: { x: 0, y: 200 }, label: "stage", parameters: { targets: "layer1", presets } },
        { op: "addNode", ref: "$show", type: "cueList", position: { x: 0, y: 300 }, label: "show", parameters: { cues, follow: "timeline" } },
        { op: "connect", source: { nodeId: "$blue", portId: "out" }, target: { nodeId: "$layer", portId: "below" } },
        { op: "connect", source: { nodeId: "$layer", portId: "out" }, target: { nodeId: "$out", portId: "input" } },
      ],
    });
    const ids = (built.data?.["createdIds"] ?? {}) as Record<string, string>;
    expect(ids["$layer"]).toBeTypeOf("string");
    const off = await call("apply_graph_patch", {
      baseRevision: await revision(),
      operations: [{ op: "setNodeUi", nodeId: ids["$layer"], ui: { bypassed: true } }],
    });
    expect(off.status).toBe("ok");

    const lastFrame = async (): Promise<number> => Number((await call("get_runtime_metrics", {})).data?.["lastFrameIndex"] ?? -1);
    const red = async (): Promise<number> => {
      const stats = (await call("describe_output", { nodeId: ids["$layer"] })).data as { channels?: { r: { mean: number } } } | undefined;
      return stats?.channels?.r.mean ?? -1;
    };
    const passes = async (): Promise<number> => Number((await call("compile_project", {})).data?.["passCount"] ?? -1);

    expect(await lastFrame()).toBeLessThan(6);
    expect(await red()).toBe(0);
    const before = await passes();

    // Each document change renders one more frame; an unrelated Solid steps the clock past the cue.
    for (let step = 0; (await lastFrame()) < 6 && step < 20; step += 1) {
      await call("set_parameters", { nodeId: ids["$spare"], parameters: { color: [step / 20, 0, 0, 1] } });
    }
    expect(await lastFrame()).toBeGreaterThanOrEqual(6);
    expect(await red()).toBe(1);
    // The Layer's pass and its picture's: the red Solid renders only while the Layer shows it.
    expect(await passes()).toBe(before + 2);
    server.dispose();
  }, 120_000);
});
