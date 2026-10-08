import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createGraphStore } from "@domain/graph/store.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { buildProjectFile } from "@domain/project/project-file.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { document, settings } from "@/examples/documents/builders.ts";
import { APP_VIEWPORT, openApp, selectNode } from "./app.ts";

test.use({ viewport: APP_VIEWPORT });

test("Common input drops swap sources and reorder layers without losing wires", async ({ page }) => {
  const store = createGraphStore();
  const { bus } = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() });
  const created = await bus.execute("graph.applyPatch", { baseRevision: 0, operations: [
    ...["front", "red", "green", "blue"].map((name, index) => ({
      op: "addNode" as const, ref: `$${name}` as const, type: "solid",
      position: { x: 0, y: index * 220 },
    })),
    { op: "addNode", ref: "$over", type: "over", position: { x: 400, y: 220 } },
    ...["front", "red", "green", "blue"].map(name => ({
      op: "connect" as const, ref: `$edge-${name}` as const,
      source: { nodeId: `$${name}`, portId: "out" },
      target: { nodeId: "$over", portId: name === "front" ? "in1" : "in2" },
    })),
  ] }, { actor: { kind: "system", id: "connections" }, projectId: "connections", capabilities: [] });
  expect(created.status).toBe("applied");
  // Give peers readable names through the supported mutation path.
  const ids = created.output.createdIds;
  await bus.execute("graph.applyPatch", { baseRevision: store.view.getRevision(), operations:
    ["front", "red", "green", "blue"].map(name => ({
      op: "setNodeLabel" as const, nodeId: ids[`$${name}`]!, label: `${name}1`,
    })),
  }, { actor: { kind: "system", id: "connections" }, projectId: "connections", capabilities: [] });
  const project = document("connections", "Common connections", settings({
    outputResolution: { width: 64, height: 64 },
  }), store.view.getGraph());
  const file = buildProjectFile({ document: project, now: () => project.updatedAt });
  await openApp(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByTestId("project-open").click();
  await (await chooser).setFiles({ name: "connections.loom.json", mimeType: "application/json", buffer: Buffer.from(file.text) });
  await selectNode(page, ids["$over"]!);
  await page.getByRole("tab", { name: "Common", exact: true }).click();
  const connections = page.getByRole("region", { name: "Connections" });
  const blue = connections.locator(`[data-edge-id="${ids["$edge-blue"]}"]`);
  const front = connections.locator(`[data-edge-id="${ids["$edge-front"]}"]`);
  await blue.locator("button[draggable]").dragTo(front);
  await expect(connections.getByLabel("Socket for the wire from blue1")).toHaveValue("in1");
  await expect(connections.getByLabel("Socket for the wire from front1")).toHaveValue("in2#2");
  await expect(page.locator(".react-flow__edge")).toHaveCount(4);

  const red = connections.locator(`[data-edge-id="${ids["$edge-red"]}"]`);
  const last = connections.locator('[data-edge-id]').filter({ hasText: "front1" });
  await red.locator("button[draggable]").dragTo(last);
  await expect(connections.getByLabel("Socket for the wire from red1")).toHaveValue("in2#2");

  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByTestId("project-save").click();
  const savedPath = await (await downloadEvent).path();
  if (savedPath === null) throw new Error("Saved project has no local download.");
  const saved = JSON.parse(await readFile(savedPath, "utf8")) as { graph: GraphDocument };
  const sources = Object.values(saved.graph.edges);
  expect(sources).toHaveLength(4);
  expect(sources.filter(edge => edge.target.portId === "in1")
    .map(edge => saved.graph.nodes[edge.source.nodeId]?.label)).toEqual(["blue1"]);
  expect(sources.filter(edge => edge.target.portId === "in2").sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(edge => saved.graph.nodes[edge.source.nodeId]?.label)).toEqual(["green1", "front1", "red1"]);
});
