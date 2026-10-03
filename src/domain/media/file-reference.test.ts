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
