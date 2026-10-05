import { describe, expect, it } from "vitest";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { createValueGraphSession } from "../channels/value-graph.ts";
import { flatDocument } from "../../compiler/test-support.ts";
import type { GraphDocument } from "../types/graph.ts";
import { migrateProjectDocument } from "./document-migrations.ts";
import type { RawDocument } from "./types.ts";

/**
 * 3 → 4 (§T1390b, §V1026): a wire that carried ONE channel of its source's bag becomes
 * the whole bag into a Select naming that channel.
 *
 * The claim that matters is behavioural — the migrated document delivers what the old
 * wire delivered — so it is asserted through the real value graph, not only as a shape.
 * The old narrowing (`value-graph.ts` before §T1390b) handed a target `{ [channel]: v }`;
 * a Select at that channel publishes exactly that.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();
const frame = { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "realtime", randomSeed: 7 } as const;
const pointer = { x: 0.25, y: 0.75, buttons: 1 };

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, x = 0) => ({
  id,
  type,
  definitionVersion: 1,
  position: { x, y: 0 },
  parameters,
  label: id,
});

function v3(edges: Record<string, unknown>, extra: RawDocument = {}): RawDocument {
  return {
    schemaVersion: 3,
    name: "old",
    graph: {
      revision: 1,
      nodes: {
        m: node("m", "mouse"),
        a: node("a", "valueSelect", { channels: "*" }, 400),
        b: node("b", "valueSelect", { channels: "*" }, 400),
      },
      edges,
      groups: {},
    },
    ...extra,
  };
}

function migrated(document: RawDocument): RawDocument {
  // The 3 → 4 step on its own (the ladder has gone on to 5 since, §T1433b).
  const result = migrateProjectDocument(document, { targetVersion: 4 });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  expect(result.document["schemaVersion"]).toBe(4);
  return result.document;
}

const graphOf = (document: RawDocument) => document["graph"] as unknown as GraphDocument;

describe("3 → 4: a channel wire becomes a Select", () => {
  it("delivers exactly what the channel wire delivered, through the real value graph", () => {
    const after = graphOf(
      migrated(v3({ e1: { id: "e1", source: { nodeId: "m", portId: "out" }, target: { nodeId: "a", portId: "in" }, channel: "y" } })),
    );
    const result = createValueGraphSession(registry).evaluate(flatDocument(after), frame, { pointer });
    expect(result.diagnostics).toEqual([]);
    expect(result.byName.get("a")).toEqual({ y: 0.75 });
    // And no edge anywhere still names a channel.
    for (const edge of Object.values(after.edges)) expect("channel" in edge).toBe(false);
  });

  it("shares ONE Select between every wire that picked the same channel, and keeps order", () => {
    const after = graphOf(
      migrated(
        v3({
          e1: { id: "e1", source: { nodeId: "m", portId: "out" }, target: { nodeId: "a", portId: "in" }, channel: "x" },
          e2: { id: "e2", source: { nodeId: "m", portId: "out" }, target: { nodeId: "b", portId: "in" }, channel: "x", order: 0 },
        }),
      ),
    );
    const selects = Object.values(after.nodes).filter((entry) => entry.type === "valueSelect" && entry.id !== "a" && entry.id !== "b");
    expect(selects.map((entry) => entry.parameters["channels"])).toEqual(["x"]);
    const select = selects[0]!.id;
    expect(after.edges["e1"]?.source).toEqual({ nodeId: select, portId: "out" });
    expect(after.edges["e2"]).toEqual({ id: "e2", source: { nodeId: select, portId: "out" }, target: { nodeId: "b", portId: "in" }, order: 0 });
    const feeds = Object.values(after.edges).filter((edge) => edge.target.nodeId === select);
    expect(feeds.map((edge) => edge.source)).toEqual([{ nodeId: "m", portId: "out" }]);
  });

  it("leaves a whole-bag wire exactly as it was", () => {
    const edge = { id: "e1", source: { nodeId: "m", portId: "out" }, target: { nodeId: "a", portId: "in" } };
    const after = graphOf(migrated(v3({ e1: edge })));
    expect(after.edges).toEqual({ e1: edge });
    expect(Object.keys(after.nodes)).toEqual(["m", "a", "b"]);
  });

  it("gives an embedded component's published channel list the input that feeds its Select", () => {
    const component = {
      componentId: "audioAnalysis",
      name: "AudioAnalysis",
      version: 1,
      inputs: [{ externalId: "audio", label: "audio", nodeId: "in_audio", portId: "in" }],
      outputs: [],
      graph: {
        revision: 1,
        nodes: { in_audio: node("in_audio", "componentInValue"), pickLevels: node("pickLevels", "valueSelect") },
        edges: { e: { id: "e", source: { nodeId: "in_audio", portId: "out" }, target: { nodeId: "pickLevels", portId: "in" } } },
        groups: {},
      },
      parameters: [
        { key: "levels", definition: { type: "string", label: "Levels", default: "level" }, targets: [{ nodeId: "pickLevels", key: "channels" }] },
        { key: "name", definition: { type: "string", label: "Name", default: "" }, targets: [{ nodeId: "pickLevels", key: "label" }] },
      ],
    };
    const after = migrated(v3({}, { componentLibrary: { schemaVersion: 1, components: [component] } }));
    const published = ((after["componentLibrary"] as { components: Array<{ parameters: Array<{ definition: Record<string, unknown> }> }> }).components[0]!).parameters;
    expect(published[0]?.definition["channelsFrom"]).toBe("audio");
    expect("channelsFrom" in (published[1]?.definition ?? {})).toBe(false);
  });
});
