import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createFileReference, parseFileReference } from "@domain/media/file-reference.ts";
import { isParameterSlot, storedStaticValue } from "@domain/parameters/slots.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { AssetReference, FlatGraph, GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { retainedFiles } from "@ui/files/retained-files.ts";
import { parseClipTrack, serializeClipTrack } from "@domain/regions/model.ts";
import { CLIP_TRACK_NODE_TYPE } from "@nodes/definitions/clip-track.ts";

interface FileParameter {
  readonly nodeId: NodeId;
  readonly key: string;
  readonly uri: string;
  readonly reference: AssetReference | null;
  readonly invalid?: string;
}

/**
 * VN106 — a Clip Track's regions are ONE JSON text, so a region's retained `loom-file:`
 * media sits inside it rather than being the whole parameter. Each region holding one is
 * resolved through the same broker and leases as a movie's `file`, and the IO view's track
 * text carries the session URL in its place (or "" until it opens, which the player reads
 * as "no media yet"). The stored document is never touched.
 */
interface RegionFile {
  readonly regionId: string;
  readonly uri: string;
  readonly reference: AssetReference | null;
  readonly invalid?: string;
}
interface TrackFiles {
  readonly nodeId: NodeId;
  readonly key: string;
  readonly regions: readonly RegionFile[];
}

const NO_FILES: readonly FileParameter[] = [];
const NO_TRACKS: readonly TrackFiles[] = [];
const NO_REFERENCES: readonly string[] = [];
const NO_DIAGNOSTICS: readonly RuntimeDiagnostic[] = [];

const referenceKey = (reference: AssetReference): string =>
  createFileReference(reference.assetId, reference.kind, reference.name);

/** Scan only document-static file identities, once per graph identity. */
function fileParameters(graph: GraphDocument): readonly FileParameter[] {
  let files: FileParameter[] | undefined;
  for (const nodeId in graph.nodes) {
    const node = graph.nodes[nodeId]!;
    for (const key in node.parameters) {
      const value = storedStaticValue(node.parameters[key]);
      if (typeof value !== "string" || !value.startsWith("loom-file:")) continue;
      files ??= [];
      try {
        files.push({ nodeId: node.id, key, uri: value, reference: parseFileReference(value) });
      } catch (error) {
        files.push({ nodeId: node.id, key, uri: value, reference: null,
          invalid: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return files ?? NO_FILES;
}

/** VN106: the clip tracks whose regions hold retained references. */
function trackFiles(graph: GraphDocument): readonly TrackFiles[] {
  let tracks: TrackFiles[] | undefined;
  for (const nodeId in graph.nodes) {
    const node = graph.nodes[nodeId]!;
    if (node.type !== CLIP_TRACK_NODE_TYPE) continue;
    const text = storedStaticValue(node.parameters["track"]);
    if (typeof text !== "string" || !text.includes("loom-file:")) continue;
    const parsed = parseClipTrack(text);
    if (!parsed.ok) continue;
    const regions: RegionFile[] = [];
    for (const region of parsed.track.regions) {
      if (!region.media.startsWith("loom-file:")) continue;
      try {
        regions.push({ regionId: region.id, uri: region.media, reference: parseFileReference(region.media) });
      } catch (error) {
        regions.push({ regionId: region.id, uri: region.media, reference: null, invalid: error instanceof Error ? error.message : String(error) });
      }
    }
    if (regions.length > 0) (tracks ??= []).push({ nodeId: node.id, key: "track", regions });
  }
  return tracks ?? NO_TRACKS;
}

export interface FileReferenceWiring {
  readonly graph: FlatGraph;
  readonly diagnostics: readonly RuntimeDiagnostic[];
}

/** Session-only IO view: durable identities stay in the authoring graph and saves. */
export function useFileReferences(graph: FlatGraph): FileReferenceWiring {
  const broker = useMemo(() => retainedFiles(), []);
  const files = useMemo(() => fileParameters(graph), [graph]);
  const tracks = useMemo(() => trackFiles(graph), [graph]);
  // A parameter edit must not release/reopen unchanged files. Multiple flattened nodes
  // can share one retained handle; each hook owns one lease per canonical reference.
  const signature = useMemo(() => {
    if (files.length === 0 && tracks.length === 0) return "";
    const unique = new Set<string>();
    for (const file of files) {
      if (file.reference !== null) unique.add(referenceKey(file.reference));
    }
    for (const track of tracks) {
      for (const region of track.regions) if (region.reference !== null) unique.add(referenceKey(region.reference));
    }
    return unique.size === 0 ? "" : JSON.stringify([...unique].sort());
  }, [files, tracks]);
  const references = useMemo(() => {
    if (signature === "") return NO_REFERENCES;
    return JSON.parse(signature) as string[];
  }, [signature]);
  const leases = useRef(new Map<string, { release(): void }>());
  useEffect(() => {
    const wanted = new Set(references);
    for (const [id, lease] of leases.current) {
      if (wanted.has(id)) continue;
      lease.release();
      leases.current.delete(id);
    }
    for (const reference of references) {
      if (!leases.current.has(reference)) {
        leases.current.set(reference, broker.acquire(reference));
      }
    }
  }, [broker, references]);
  useEffect(() => {
    const owned = leases.current;
    return () => {
      for (const lease of owned.values()) lease.release();
      owned.clear();
    };
  }, [broker]);

  const subscribe = useCallback((listener: () => void) => broker.subscribe(listener), [broker]);
  const snapshot = useCallback(() => broker.revision(), [broker]);
  const revision = useSyncExternalStore(subscribe, snapshot, snapshot);

  return useMemo(() => {
    // Broker snapshots are external state; this revision invalidates the cached IO view.
    void revision;
    if (files.length === 0 && tracks.length === 0) return { graph, diagnostics: NO_DIAGNOSTICS };
    const nodes = { ...graph.nodes };
    const diagnostics: RuntimeDiagnostic[] = [];
    for (const file of files) {
      const status = file.reference === null ? null : broker.snapshot(referenceKey(file.reference));
      const url = status?.kind === "ready" ? status.url : "";
      const node = nodes[file.nodeId]!;
      const stored = node.parameters[file.key];
      const value = isParameterSlot(stored)
        ? { ...stored, bindings: { ...stored.bindings, static: { kind: "static" as const, value: url } } }
        : url;
      nodes[file.nodeId] = { ...node, parameters: { ...node.parameters, [file.key]: value } };
      if (status?.kind === "ready") continue;
      const name = file.reference?.name ?? file.uri;
      const label = graph.nodes[file.nodeId]!.label ?? file.nodeId;
      const detail = file.invalid ?? (status !== null && "message" in status ? status.message : status?.kind);
      // T1519b: a node inside a component instance (a flattened `<instance>/<node>` id)
      // relinks from the INSTANCE's inspector, which lists its unopened files.
      const field = file.nodeId.includes("/") && file.reference !== null
        ? "this file under the component instance's Component section in the Inspector"
        : "this field in the Inspector";
      diagnostics.push({
        severity: status?.kind === "pending" ? "info" : status?.kind === "error" || file.invalid !== undefined ? "error" : "warning",
        code: file.invalid !== undefined ? "asset.reference.invalid" : `asset.reference.${status!.kind}`,
        message: `File "${name}" on "${label}" (${file.nodeId}).${file.key}: ${detail}.`,
        nodeId: file.nodeId,
        suggestion: status?.kind === "pending" ? "Wait for the retained file to open."
          : status?.kind === "permission" ? `Choose Allow access or Relink for ${field}.`
            : `Choose Relink for ${field}.`,
      });
    }
    for (const track of tracks) {
      const node = nodes[track.nodeId]!;
      const stored = node.parameters[track.key];
      const parsed = parseClipTrack(storedStaticValue(stored));
      if (!parsed.ok) continue;
      const urls = new Map<string, string>();
      for (const region of track.regions) {
        const status = region.reference === null ? null : broker.snapshot(referenceKey(region.reference));
        urls.set(region.regionId, status?.kind === "ready" ? status.url : "");
        if (status?.kind === "ready") continue;
        const name = region.reference?.name ?? region.uri;
        const label = graph.nodes[track.nodeId]!.label ?? track.nodeId;
        const detail = region.invalid ?? (status !== null && "message" in status ? status.message : status?.kind);
        diagnostics.push({
          severity: status?.kind === "pending" ? "info" : status?.kind === "error" || region.invalid !== undefined ? "error" : "warning",
          code: region.invalid !== undefined ? "asset.reference.invalid" : `asset.reference.${status!.kind}`,
          message: `File "${name}" of region "${region.regionId}" on "${label}" (${track.nodeId}): ${detail}.`,
          nodeId: track.nodeId,
          suggestion: status?.kind === "pending" ? "Wait for the retained file to open." : "Drop the file on the region's clip track again.",
        });
      }
      const text = serializeClipTrack({
        ...parsed.track,
        regions: parsed.track.regions.map((region) => (urls.has(region.id) ? { ...region, media: urls.get(region.id)! } : region)),
      });
      const value = isParameterSlot(stored)
        ? { ...stored, bindings: { ...stored.bindings, static: { kind: "static" as const, value: text } } }
        : text;
      nodes[track.nodeId] = { ...node, parameters: { ...node.parameters, [track.key]: value } };
    }
    return { graph: { ...graph, nodes }, diagnostics };
  }, [broker, files, graph, revision, tracks]);
}
