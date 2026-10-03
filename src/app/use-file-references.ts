import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createFileReference, parseFileReference } from "@domain/media/file-reference.ts";
import { isParameterSlot, storedStaticValue } from "@domain/parameters/slots.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { AssetReference, GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { retainedFiles } from "@ui/files/retained-files.ts";

interface FileParameter {
  readonly nodeId: NodeId;
  readonly key: string;
  readonly uri: string;
  readonly reference: AssetReference | null;
  readonly invalid?: string;
}

const NO_FILES: readonly FileParameter[] = [];
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

export interface FileReferenceWiring {
  readonly graph: GraphDocument;
  readonly diagnostics: readonly RuntimeDiagnostic[];
}

/** Session-only IO view: durable identities stay in the authoring graph and saves. */
export function useFileReferences(graph: GraphDocument): FileReferenceWiring {
  const broker = useMemo(() => retainedFiles(), []);
  const files = useMemo(() => fileParameters(graph), [graph]);
  // A parameter edit must not release/reopen unchanged files. Multiple flattened nodes
  // can share one retained handle; each hook owns one lease per canonical reference.
  const signature = useMemo(() => {
    if (files.length === 0) return "";
    const unique = new Set<string>();
    for (const file of files) {
      if (file.reference !== null) unique.add(referenceKey(file.reference));
    }
    return unique.size === 0 ? "" : JSON.stringify([...unique].sort());
  }, [files]);
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
    if (files.length === 0) return { graph, diagnostics: NO_DIAGNOSTICS };
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
    return { graph: { ...graph, nodes }, diagnostics };
  }, [broker, files, graph, revision]);
}
