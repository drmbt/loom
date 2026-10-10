// @vitest-environment jsdom
import { flatDocument } from "@compiler/test-support.ts";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileReference } from "@domain/media/file-reference.ts";
import { slotFromValue } from "@domain/parameters/slots.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { RetainedFileSnapshot } from "@ui/files/retained-files.ts";
import { useFileReferences } from "./use-file-references.ts";

const broker = vi.hoisted(() => {
  const states = new Map<string, RetainedFileSnapshot>();
  const listeners = new Set<() => void>();
  const releases: Array<{ key: string; release: ReturnType<typeof vi.fn> }> = [];
  const pending: RetainedFileSnapshot = { kind: "pending" };
  let version = 0;
  return {
    acquire: vi.fn((reference: string) => {
      const lease = { key: reference, release: vi.fn() };
      releases.push(lease);
      return lease;
    }),
    snapshot: vi.fn((reference: string) => states.get(reference) ?? pending),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    revision: () => version,
    publish(key: string, state: RetainedFileSnapshot) {
      states.set(key, state);
      version += 1;
      for (const listener of listeners) listener();
    },
    releases,
    listeners,
    reset() {
      states.clear();
      releases.length = 0;
      listeners.clear();
      version = 0;
      this.acquire.mockClear();
      this.snapshot.mockClear();
    },
  };
});

vi.mock("@ui/files/retained-files.ts", () => ({ retainedFiles: () => broker }));

beforeEach(() => broker.reset());
afterEach(cleanup);

const CLIP = createFileReference("clip-id", "video", "My clip.mp4");
const MESH = createFileReference("mesh-id", "gltf", "My mesh.glb");
function node(id: string, type: string, file: GraphNode["parameters"][string]): GraphNode {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { file } };
}
function graph(...nodes: GraphNode[]): GraphDocument {
  return { revision: 1, groups: {}, edges: {}, nodes: Object.fromEntries(nodes.map((node) => [node.id, node])) };
}

describe("retained file runtime projection", () => {
  it("keeps the exact graph identity and legacy URLs when no retained references exist", () => {
    const document = graph(node("movie", "movieFileIn", "https://example.test/clip.mp4"));
    const view = renderHook(({ graph }) => useFileReferences(flatDocument(graph)), { initialProps: { graph: document } });
    expect(view.result.current.graph).toBe(document);
    expect(view.result.current.diagnostics).toEqual([]);
    expect(broker.acquire).not.toHaveBeenCalled();
    view.rerender({ graph: document });
    expect(view.result.current.graph).toBe(document);
    const edited = { ...document, revision: 2 };
    view.rerender({ graph: edited });
    expect(view.result.current.graph).toBe(edited);
    expect(broker.acquire).not.toHaveBeenCalled();
  });

  it("projects readiness, permission, and relink transitions without changing stored identities", async () => {
    const document = graph({ ...node("movie", "movieFileIn", CLIP), label: "Movie 1" });
    const view = renderHook(() => useFileReferences(flatDocument(document)));
    expect(view.result.current.graph.nodes["movie"]!.parameters["file"]).toBe("");
    expect(view.result.current.diagnostics[0]).toMatchObject({ code: "asset.reference.pending", nodeId: "movie" });
    act(() => broker.publish(CLIP, { kind: "permission", message: "File permission required." }));
    expect(view.result.current.diagnostics[0]?.message).toContain('"My clip.mp4"');
    expect(view.result.current.diagnostics[0]?.message).toContain("(movie).file");
    expect(view.result.current.diagnostics[0]?.suggestion).toContain("Allow access");
    await act(async () => {
      await Promise.resolve();
      broker.publish(CLIP, { kind: "ready", url: "blob:restored" });
    });
    expect(view.result.current.graph.nodes["movie"]!.parameters["file"]).toBe("blob:restored");
    expect(view.result.current.diagnostics).toEqual([]);
    const readyView = view.result.current;
    view.rerender();
    expect(view.result.current).toBe(readyView);
    act(() => broker.publish(CLIP, { kind: "missing", message: "File is unavailable." }));
    expect(view.result.current.graph.nodes["movie"]!.parameters["file"]).toBe("");
    expect(view.result.current.diagnostics[0]?.suggestion).toContain("Relink");
    act(() => broker.publish(CLIP, { kind: "ready", url: "blob:relinked" }));
    expect(view.result.current.graph.nodes["movie"]!.parameters["file"]).toBe("blob:relinked");
    expect(document.nodes["movie"]!.parameters["file"]).toBe(CLIP);
    expect(broker.acquire).toHaveBeenCalledOnce();
  });

  it("replaces only the retained static payload and preserves inactive bindings and node traits", () => {
    const slot = { ...slotFromValue(CLIP), mode: "expression" as const, bindings: {
      ...slotFromValue(CLIP).bindings, expression: { kind: "expression" as const, source: "op('driver').par.file" },
    } };
    const document = graph({ ...node("movie", "movieFileIn", slot), resolution: { mode: "fixed", width: 320, height: 180 } },
      node("untouched", "noise", ""));
    const view = renderHook(() => useFileReferences(flatDocument(document)));
    act(() => broker.publish(CLIP, { kind: "ready", url: "blob:slot" }));
    const projected = view.result.current.graph;
    expect(projected.nodes["movie"]!.parameters["file"]).toEqual({ ...slot, bindings: {
      ...slot.bindings, static: { kind: "static", value: "blob:slot" },
    } });
    expect(document.nodes["movie"]!.parameters["file"]).toBe(slot);
    expect(projected.nodes["untouched"]).toBe(document.nodes["untouched"]);
    expect(projected.nodes["movie"]!.resolution).toBe(document.nodes["movie"]!.resolution);
    expect(projected.edges).toBe(document.edges);
    expect(projected.revision).toBe(document.revision);
  });

  it("dedupes shared nested references and releases only when the last node disappears", () => {
    const movie = node("outer/movie", "movieFileIn", CLIP);
    const audio = node("outer/inner/audio", "audioFileIn", slotFromValue(CLIP));
    const document = graph(movie, audio);
    const view = renderHook(({ graph }) => useFileReferences(flatDocument(graph)), { initialProps: { graph: document } });
    expect(broker.acquire).toHaveBeenCalledOnce();
    act(() => broker.publish(CLIP, { kind: "ready", url: "blob:shared" }));
    expect(Object.keys(view.result.current.graph.nodes)).toEqual([movie.id, audio.id]);
    expect(view.result.current.graph.nodes[movie.id]!.parameters["file"]).toBe("blob:shared");
    expect(view.result.current.graph.nodes[audio.id]!.parameters["file"]).toEqual(slotFromValue("blob:shared"));
    view.rerender({ graph: graph(audio) });
    expect(broker.acquire).toHaveBeenCalledOnce();
    expect(broker.releases[0]!.release).not.toHaveBeenCalled();
    const empty = graph();
    view.rerender({ graph: empty });
    expect(broker.releases[0]!.release).toHaveBeenCalledOnce();
    expect(view.result.current.graph).toBe(empty);
    view.unmount();
    expect(broker.releases[0]!.release).toHaveBeenCalledOnce();
    expect(broker.listeners.size).toBe(0);
  });

  it("keeps unchanged leases on graph edits, adds only new references, and releases on unmount", () => {
    const movie = node("movie", "movieFileIn", CLIP);
    const document = graph(movie);
    const view = renderHook(({ graph }) => useFileReferences(flatDocument(graph)), { initialProps: { graph: document } });
    const edited = graph({ ...movie, parameters: { ...movie.parameters, speed: 2 } });
    view.rerender({ graph: edited });
    expect(broker.acquire).toHaveBeenCalledOnce();
    expect(broker.releases[0]!.release).not.toHaveBeenCalled();
    view.rerender({ graph: graph(movie, node("mesh", "meshFileIn", MESH)) });
    expect(broker.acquire).toHaveBeenCalledTimes(2);
    expect(broker.releases[0]!.release).not.toHaveBeenCalled();
    view.unmount();
    for (const lease of broker.releases) expect(lease.release).toHaveBeenCalledOnce();
    expect(broker.listeners.size).toBe(0);
  });

  it("reacquires metadata changes under the same asset ID using the new canonical URI", () => {
    const renamed = createFileReference("clip-id", "video", "Renamed clip.mp4");
    const view = renderHook(({ graph }) => useFileReferences(flatDocument(graph)), {
      initialProps: { graph: graph(node("movie", "movieFileIn", CLIP)) },
    });
    view.rerender({ graph: graph(node("movie", "movieFileIn", renamed)) });
    expect(broker.releases[0]!.release).toHaveBeenCalledOnce();
    expect(broker.releases[1]?.key).toBe(renamed);
    act(() => broker.publish(renamed, { kind: "ready", url: "blob:renamed" }));
    expect(view.result.current.graph.nodes["movie"]!.parameters["file"]).toBe("blob:renamed");
  });

  it("reports broken retained references and broker errors on the exact field", () => {
    const broken = node("broken", "movieFileIn", "loom-file:not-a-valid-reference");
    const document = graph(broken, node("mesh", "meshFileIn", MESH));
    const view = renderHook(() => useFileReferences(flatDocument(document)));
    act(() => broker.publish(MESH, { kind: "error", message: "Reading failed." }));
    expect(view.result.current.graph.nodes[broken.id]!.parameters["file"]).toBe("");
    expect(view.result.current.graph.nodes["mesh"]!.parameters["file"]).toBe("");
    expect(view.result.current.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "asset.reference.invalid", nodeId: broken.id, severity: "error" }),
      expect.objectContaining({ code: "asset.reference.error", nodeId: "mesh", message: expect.stringContaining("Reading failed.") }),
    ]));
    expect(broker.acquire).toHaveBeenCalledOnce();
    expect(document.nodes[broken.id]!.parameters["file"]).toBe("loom-file:not-a-valid-reference");
  });
});

describe("VN106: clip track region media", () => {
  it("resolves a region's retained media through the same broker, leaving the stored track alone", async () => {
    const { newRegion, serializeClipTrack, parseClipTrack } = await import("@domain/regions/model.ts");
    const stored = serializeClipTrack({ version: 1, id: "t", name: "t", regions: [
      newRegion("r1", CLIP, { length: 240000 }),
      newRegion("r2", "https://example.test/b.mp4", { timelineStart: 240000, length: 240000 }),
    ] });
    const clip: GraphNode = { id: "clip", type: "clipTrack", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { track: stored } };
    const document = graph(clip);
    const view = renderHook(() => useFileReferences(flatDocument(document)));
    const mediaOf = () => {
      const parsed = parseClipTrack(view.result.current.graph.nodes["clip"]!.parameters["track"]);
      if (!parsed.ok) throw new Error(parsed.reason);
      return parsed.track.regions.map((region) => region.media);
    };
    expect(broker.acquire).toHaveBeenCalledWith(CLIP);
    expect(mediaOf()).toEqual(["", "https://example.test/b.mp4"]);
    expect(view.result.current.diagnostics[0]).toMatchObject({ code: "asset.reference.pending", nodeId: "clip" });
    act(() => broker.publish(CLIP, { kind: "ready", url: "blob:session-clip" } as RetainedFileSnapshot));
    expect(mediaOf()).toEqual(["blob:session-clip", "https://example.test/b.mp4"]);
    expect(view.result.current.diagnostics).toEqual([]);
    expect(document.nodes["clip"]!.parameters["track"]).toBe(stored);
  });
});
