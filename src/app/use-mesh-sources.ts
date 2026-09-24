import { useEffect, useRef, useState } from "react";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { GlbDecodeError } from "@domain/mesh/glb.ts";
import { meshSourceIdsFor, prepareMesh, type PreparedMesh } from "@/points/mesh.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import type { AppRuntime } from "./app-runtime.ts";

/**
 * T1353b — Mesh File In, wired: the app half of `meshFileIn`.
 *
 * The node declares two fed buffers keyed by `meshSourceIdsFor(nodeId)` and is SIZED by
 * its Vertices/Triangles parameters. This hook is what makes both true: it reads the file
 * each node names, prepares it through `prepareMesh` (the path the headless harness takes,
 * so an offline render feeds the same bytes), registers the two sources, and — only when
 * they differ — writes the measured facts back through the bus as one `setParameters`
 * patch (§V29). The facts are compile-time, so that write is what recompiles the node at
 * the file's size; the sources are already registered by then and the upload lands on the
 * first frame of the new plan.
 *
 * A file that will not decode, a selection that matches nothing, or a mesh node inside a
 * component (whose facts live on a node this document does not hold) registers nothing
 * and says why here; the node keeps publishing its degenerate stand-in and draws nothing.
 *
 * HONEST LIMIT: the decode runs on the main thread. A 100 MB export takes on the order of
 * a second, once per file and selection; moving it to a worker is the follow-up if a
 * scene's reload makes that visible.
 */

export interface MeshWiring {
  readonly diagnostics: readonly RuntimeDiagnostic[];
}

const NO_DIAGNOSTICS: readonly RuntimeDiagnostic[] = [];

interface MeshRequest {
  readonly nodeId: NodeId;
  readonly file: string;
  readonly select: string;
  /** The node's stored facts, `vertices/triangles`, so a written measurement re-runs the effect. */
  readonly sized: string;
}

function meshRequests(graph: GraphDocument): MeshRequest[] {
  const requests: MeshRequest[] = [];
  for (const node of Object.values(graph.nodes)) {
    if (node.type !== "meshFileIn") continue;
    const file = node.parameters["file"];
    if (typeof file !== "string" || file === "") continue;
    const select = node.parameters["select"];
    requests.push({
      nodeId: node.id,
      file,
      select: typeof select === "string" ? select : "",
      sized: `${String(node.parameters["vertices"])}/${String(node.parameters["triangles"])}`,
    });
  }
  return requests.sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
}

export function useMeshSources(runtime: AppRuntime, backend: LoomBackend | null, graph: GraphDocument): MeshWiring {
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>(NO_DIAGNOSTICS);
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  /** File bytes by URL, so a Select edit re-prepares without re-reading the file. */
  const filesRef = useRef(new Map<string, Promise<Uint8Array>>());
  /** Prepared meshes by `file|select`: the facts write re-runs the effect, not the decode. */
  const preparedRef = useRef(new Map<string, PreparedMesh | null>());

  const requests = meshRequests(graph);
  // A flat string, so an unrelated recompile does not re-open every mesh.
  const key = requests.map((request) => `${request.nodeId}|${request.file}|${request.select}|${request.sized}`).join("\n");

  useEffect(() => {
    if (backend === null || key === "") {
      setDiagnostics(NO_DIAGNOSTICS);
      return;
    }
    let cancelled = false;
    const unregisters: Array<() => void> = [];
    const found: RuntimeDiagnostic[] = [];

    const readFile = (url: string): Promise<Uint8Array> => {
      const cached = filesRef.current.get(url);
      if (cached !== undefined) return cached;
      const loading = fetch(url).then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status} reading ${url}`);
        return new Uint8Array(await response.arrayBuffer());
      });
      filesRef.current.set(url, loading);
      loading.catch(() => filesRef.current.delete(url));
      return loading;
    };

    /**
     * True when the node is already sized for this file. Otherwise writes the facts (the
     * write changes `sized`, which re-runs this effect) and answers false: registering
     * now would offer the stand-in's one-vertex buffer a whole file's bytes.
     */
    const sizedFor = (nodeId: NodeId, facts: PreparedMesh["facts"]): boolean => {
      const bus = runtimeRef.current.bus;
      const stored = bus.store.getGraph().nodes[nodeId];
      if (stored === undefined) {
        found.push({
          severity: "warning",
          code: "mesh.component",
          message: `Mesh "${nodeId}" sits inside a component; its Vertices/Triangles must be set on the component's own node (${facts.vertices} / ${facts.triangles}).`,
          nodeId,
        });
        return false;
      }
      const parameters = stored.parameters;
      if (parameters["vertices"] === facts.vertices && parameters["triangles"] === facts.triangles && parameters["parts"] === facts.parts) return true;
      void bus.execute(
        "graph.applyPatch",
        {
          baseRevision: bus.store.getRevision(),
          label: "Measure mesh",
          operations: [{ op: "setParameters", nodeId, parameters: { vertices: facts.vertices, triangles: facts.triangles, parts: facts.parts } }],
        },
        runtimeRef.current.invocation,
      );
      return false;
    };

    void (async () => {
      for (const request of requests) {
        const preparedKey = `${request.file}|${request.select}`;
        let prepared: PreparedMesh | null;
        try {
          const cached = preparedRef.current.get(preparedKey);
          prepared = cached !== undefined ? cached : prepareMesh(await readFile(request.file), request.select);
          preparedRef.current.set(preparedKey, prepared);
        } catch (error) {
          found.push({
            severity: "error",
            code: error instanceof GlbDecodeError ? "mesh.decode" : "mesh.read",
            message: `Mesh "${request.nodeId}": ${error instanceof Error ? error.message : String(error)}`,
            nodeId: request.nodeId,
          });
          continue;
        }
        if (cancelled) return;
        if (prepared === null) {
          found.push({
            severity: "warning",
            code: "mesh.empty",
            message: `Mesh "${request.nodeId}": ${request.select === "" ? "the file holds no triangles" : `Select "${request.select}" matches no triangles`}.`,
            nodeId: request.nodeId,
          });
          continue;
        }
        for (const warning of prepared.mesh.warnings) {
          found.push({ severity: "info", code: "mesh.note", message: `Mesh "${request.nodeId}": ${warning}`, nodeId: request.nodeId });
        }
        if (!sizedFor(request.nodeId, prepared.facts)) continue;
        const ids = meshSourceIdsFor(request.nodeId);
        const points = prepared.points;
        const indices = prepared.indices;
        unregisters.push(backend.registerMediaSource(ids.points, { currentFrame: () => ({ frameId: 1, bytes: points }) }));
        unregisters.push(backend.registerMediaSource(ids.indices, { currentFrame: () => ({ frameId: 1, bytes: indices }) }));
      }
      if (!cancelled) setDiagnostics(found.length === 0 ? NO_DIAGNOSTICS : [...found]);
    })();

    return () => {
      cancelled = true;
      for (const unregister of unregisters) unregister();
    };
    // `requests` is derived from `key`; the key is the dependency by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, key]);

  return { diagnostics };
}
