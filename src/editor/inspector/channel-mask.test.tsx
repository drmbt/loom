// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { Inspector } from "./inspector.tsx";

beforeAll(installDomStubs);
afterEach(cleanup);
const context = contextFor(alice);

async function mount(type: string) {
  const store = createGraphStore({ ids: createSequentialIdFactory("channels") });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() });
  const created = await bus.execute("graph.applyPatch", { baseRevision: 0, operations: [
    { op: "addNode", ref: "$node", type, position: { x: 0, y: 0 } },
  ] }, context);
  expect(created.status).toBe("applied");
  const nodeId = created.output.createdIds["$node"]!;
  render(<StrictMode><Inspector bus={bus} context={context} nodeId={nodeId}
    settings={{ outputResolution: { width: 64, height: 64 }, workingFormat: "rgba16float" }} /></StrictMode>);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Common" }), { button: 0 });
  fireEvent.click(screen.getByRole("tab", { name: "Common" }));
  return { bus, nodeId };
}

describe("Common processing channels", () => {
  it("changes persisted operator channels through the bus and undo restores every toggle", async () => {
    const { bus, nodeId } = await mount("mask");
    const common = screen.getByRole("region", { name: "Common" });
    const alpha = within(common).getByRole("button", { name: "Process A" });
    expect(alpha.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(alpha);
    await waitFor(() => expect(bus.store.getGraph().nodes[nodeId]?.channelMask)
      .toEqual({ r: true, g: true, b: true, a: false }));
    expect(alpha.getAttribute("aria-pressed")).toBe("false");
    await act(async () => { await bus.execute("graph.undo", {}, context); });
    expect(bus.store.getGraph().nodes[nodeId]?.channelMask).toBeUndefined();
    expect(alpha.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps all-off as a real setting and clears the override only when all are enabled", async () => {
    const { bus, nodeId } = await mount("solid");
    for (const channel of ["R", "G", "B", "A"]) {
      fireEvent.click(screen.getByRole("button", { name: `Process ${channel}` }));
      await waitFor(() => expect(bus.store.getGraph().nodes[nodeId]?.channelMask?.[
        channel.toLowerCase() as "r" | "g" | "b" | "a"]).toBe(false));
    }
    expect(bus.store.getGraph().nodes[nodeId]?.channelMask).toEqual({ r: false, g: false, b: false, a: false });
    for (const channel of ["R", "G", "B", "A"]) {
      fireEvent.click(screen.getByRole("button", { name: `Process ${channel}` }));
      await waitFor(() => expect(screen.getByRole("button", { name: `Process ${channel}` })
        .getAttribute("aria-pressed")).toBe("true"));
    }
    expect(bus.store.getGraph().nodes[nodeId]?.channelMask).toBeUndefined();
  });

  it.each(["valueMath", "analyze", "pointGrid"])("%s does not offer image-processing toggles", async type => {
    await mount(type);
    expect(screen.queryByRole("group", { name: "Processing channels" })).toBeNull();
  });
});
