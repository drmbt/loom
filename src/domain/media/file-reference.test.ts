import { describe, expect, it } from "vitest";
import type { GraphDocument } from "../types/graph.ts";
import { collectFileReferences, createFileReference, parseFileReference } from "./file-reference.ts";

describe("retained file identities", () => {
  it("round trips opaque identities and filenames without a session URL", () => {
    const value = createFileReference("id/one #", "video", "A clip #1.mp4");
    expect(parseFileReference(value)).toEqual({ assetId: "id/one #", kind: "video", name: "A clip #1.mp4",
      source: { kind: "fileHandle", handleId: "id/one #" } });
    expect(value).not.toContain("blob:");
  });
  it("preserves ordinary URLs and rejects malformed owned references", () => {
    expect(parseFileReference("blob:old#clip.mp4")).toBeNull();
    expect(parseFileReference("https://host/clip.mp4")).toBeNull();
    expect(parseFileReference(null)).toBeNull();
    expect(() => parseFileReference("loom-file:broken")).toThrow("Invalid retained file reference");
  });
  it("collects nested static bindings and shared references exactly once", () => {
    const file = createFileReference("clip", "video", "clip.mp4");
    const graph = { revision: 1, edges: {}, groups: {}, nodes: {
      movie: { id: "movie", type: "movieFileIn", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {
        file: { mode: "static", bindings: { static: { kind: "static", value: file } } },
      } },
      second: { id: "second", type: "movieFileIn", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { file } },
    } } as GraphDocument;
    expect(collectFileReferences([graph, graph])).toEqual([parseFileReference(file)]);
  });
});

describe("VN106: references inside a JSON-valued parameter", () => {
  const media = createFileReference("clip-a", "video", "a.mp4");
  const node = (id: string, type: string, parameters: Record<string, unknown>) =>
    ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters });
  it("lists a clip track region's retained media", () => {
    const track = JSON.stringify({ version: 1, id: "t", name: "t", regions: [{ id: "r1", media, sourceIn: 0, sourceOut: 240000, timelineStart: 0, length: 240000 }] }, null, 2);
    const graph = { nodes: { clip: node("clip", "clipTrack", { track }) } } as unknown as GraphDocument;
    expect(collectFileReferences([graph])).toEqual([parseFileReference(media)]);
  });
  it("does not turn free text that mentions a reference into an asset", () => {
    const graph = { nodes: {
      note: node("note", "annotate", { text: `drop ${media} here` }),
      expr: node("expr", "constant", { value: { mode: "expression", bindings: { expression: { kind: "expression", source: `"${media}"` } } } }),
      list: node("list", "x", { text: JSON.stringify([media]) }),
      bad: node("bad", "x", { text: '{"media": "loom-file:broken"}' }),
    } } as unknown as GraphDocument;
    expect(collectFileReferences([graph])).toEqual([]);
  });
});
