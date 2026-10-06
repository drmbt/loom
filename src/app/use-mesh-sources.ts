import { useEffect, useRef, useState } from "react";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import { isComponentInstance } from "@domain/components/instance.ts";
import { enteredThrough } from "@domain/components/addressing.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { GlbDecodeError, type MeshFrame } from "@domain/mesh/glb.ts";
import { storedStaticValue } from "@domain/parameters/slots.ts";
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
 * A mesh node inside a component is sized through its instance (VN33, `factsTarget`). A
 * file that will not decode, a selection that matches nothing, or a mesh inside a NESTED
 * component registers nothing and says why here; the node keeps publishing its degenerate
 * stand-in and draws nothing.
 *
 * HONEST LIMIT: the decode runs on the main thread. A 100 MB export takes on the order of
 * a second, once per file and selection; moving it to a worker is the follow-up if a
 * scene's reload makes that visible.
 *
 * VNB8: the two caches below live as long as ONE DOCUMENT, not as long as the app. They used
 * to outlive every load: rebuild a GLB on disk, open a project sized for the new export, and
 * the loader measured the bytes it had read hours earlier and wrote THEIR counts back over
 * the project's — a Point Kernel sized to the new mesh then refused it and the document
 * stopped compiling. Every load mints a new `documentIdentity` (`app-runtime.ts`), so a new
 * identity drops both caches and re-runs the effect: opening a project reads its files.
 */

export interface MeshWiring {
  readonly diagnostics: readonly RuntimeDiagnostic[];
}

const NO_DIAGNOSTICS: readonly RuntimeDiagnostic[] = [];

interface MeshRequest {
  readonly nodeId: NodeId;
  readonly file: string;
  readonly select: string;
  /** T1410b: the chosen clip and its bake rate ("" = none). */
  readonly clip: string;
  readonly clipRate: number;
  /** T1424b: the Lamps groups — they add the `lamp` attribute, so they are part of the decode. */
  readonly lamps: string;
  /** T1581b: the frame the vertices are decoded in. */
  readonly frame: MeshFrame;
  /** The node's stored facts, so a written measurement re-runs the effect (T1401b: joints too — a skin changes the layout, not the counts). */
  readonly sized: string;
}

function meshRequests(graph: GraphDocument): MeshRequest[] {
  const requests: MeshRequest[] = [];
  for (const node of Object.values(graph.nodes)) {
    if (node.type !== "meshFileIn") continue;
    const file = storedStaticValue(node.parameters["file"]);
    if (typeof file !== "string" || file === "") continue;
    const select = node.parameters["select"];
    const clip = node.parameters["clip"];
    const clipRate = node.parameters["clipRate"];
    const lamps = node.parameters["lamps"];
    const frame = node.parameters["frame"];
    requests.push({
      nodeId: node.id,
      file,
      select: typeof select === "string" ? select : "",
      clip: typeof clip === "string" ? clip.trim() : "",
      clipRate: typeof clipRate === "number" ? clipRate : 30,
      lamps: typeof lamps === "string" ? lamps : "",
      // T1581b: the frame the vertices are decoded in (Mesh File In's Frame).
      frame: frame === "object" || frame === "part" ? frame : "world",
      sized: `${String(node.parameters["vertices"])}/${String(node.parameters["triangles"])}/${String(node.parameters["parts"])}/${String(node.parameters["joints"])}/${String(node.parameters["clips"])}/${String(node.parameters["clipFrames"])}/${String(node.parameters["frameOrigin"])}`,
    });
  }
  return requests.sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
}

/**
 * VN33 — WHERE a mesh node's measured facts are read and written. A node at the root holds
 * them itself. A node inside a component is a flattened id (`instance/inner`) the document
 * does not hold: its facts are that INSTANCE's overrides of `inner` (`setParameters` with
 * `internalNodeId`), so each instance carries the size of the file IT loads and the shared
 * definition is not touched. "Already sized" then reads the flattened node, the definition
 * with the overrides applied, because that is what the compile sizes the node by.
 *
 * One level: an override key is `<node>/<key>`, so a node inside a NESTED instance
 * (`a/b/inner`) is refused by name, and the mesh keeps drawing nothing there.
 */
function factsTarget(
  root: GraphDocument,
  flat: GraphDocument,
  nodeId: NodeId,
): { readonly nodeId: NodeId; readonly internalNodeId?: string; readonly parameters: GraphNode["parameters"] } | { readonly refused: string } {
  const own = root.nodes[nodeId];
  if (own !== undefined) return { nodeId, parameters: own.parameters };
  const entered = enteredThrough(nodeId);
  const instance = entered === undefined ? undefined : root.nodes[entered.instance];
  const flattened = flat.nodes[nodeId];
  if (entered === undefined || instance === undefined || flattened === undefined || !isComponentInstance(instance)) {
    return { refused: "the document holds no node or component instance by that id, so its facts have nowhere to go" };
  }
  if (enteredThrough(entered.rest) !== undefined) {
    return { refused: "it sits inside a nested component, and an instance's overrides reach its own internal nodes only; set its Vertices/Triangles on the nested component's node" };
  }
  return { nodeId: instance.id, internalNodeId: entered.rest, parameters: flattened.parameters };
}

interface MeshMeasure {
  /** True when the node is already sized for the file: its buffers may be fed. */
  readonly sized: boolean;
  /** Why the node cannot be sized from here (VN33: a nested component). */
  readonly refused?: string;
}

/**
 * The loader's measure step. Answers whether the node is already sized for this file;
 * otherwise writes the facts through the bus (the write changes `sized`, which re-runs the
 * hook's effect) and answers false: registering now would offer the stand-in's one-vertex
 * buffer a whole file's bytes.
 */
function measureMesh(
  runtime: Pick<AppRuntime, "bus" | "flattened" | "invocation">,
  nodeId: NodeId,
  facts: PreparedMesh["facts"],
): MeshMeasure {
  const bus = runtime.bus;
  const target = factsTarget(bus.store.getGraph(), runtime.flattened.current().graph, nodeId);
  if ("refused" in target) return { sized: false, refused: target.refused };
  const write = (parameters: Record<string, ParameterValue>): void =>
    void bus.execute(
      "graph.applyPatch",
      {
        baseRevision: bus.store.getRevision(),
        label: "Measure mesh",
        operations: [{ op: "setParameters", nodeId: target.nodeId, parameters, ...(target.internalNodeId === undefined ? {} : { internalNodeId: target.internalNodeId }) }],
      },
      runtime.invocation,
    );
  const parameters = target.parameters;
  // An unskinned node may never have stored Joints at all: absent reads as the empty table.
  const joints = typeof parameters["joints"] === "string" ? parameters["joints"] : "";
  // T1410b: absent clip facts read as the no-clip file's ("" and 0).
  const clips = typeof parameters["clips"] === "string" ? parameters["clips"] : "";
  const clipFrames = typeof parameters["clipFrames"] === "number" ? parameters["clipFrames"] : 0;
  // T1581b: absent reads as the world frame's (empty).
  const frameOrigin = typeof parameters["frameOrigin"] === "string" ? parameters["frameOrigin"] : "";
  if (
    parameters["vertices"] === facts.vertices &&
    parameters["triangles"] === facts.triangles &&
    parameters["parts"] === facts.parts &&
    joints === facts.joints &&
    clips === facts.clips &&
    clipFrames === facts.clipFrames &&
    frameOrigin === facts.frameOrigin
  ) {
    /* T1598b: Bounds sizes NOTHING, so it is not part of "sized for this file": a document
       saved before it existed still feeds. It is written beside the facts, and on its own
       when it is all that is missing. */
    if (parameters["bounds"] !== facts.bounds) write({ bounds: facts.bounds });
    return { sized: true };
  }
  write({ vertices: facts.vertices, triangles: facts.triangles, parts: facts.parts, joints: facts.joints, clips: facts.clips, clipFrames: facts.clipFrames, frameOrigin: facts.frameOrigin, bounds: facts.bounds });
  return { sized: false };
}

export function useMeshSources(runtime: AppRuntime, backend: LoomBackend | null, graph: GraphDocument): MeshWiring {
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>(NO_DIAGNOSTICS);
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  /** File bytes by URL, so a Select edit re-prepares without re-reading the file. */
  const filesRef = useRef(new Map<string, Promise<Uint8Array>>());
  /** Prepared meshes by `file|select`: the facts write re-runs the effect, not the decode. */
  const preparedRef = useRef(new Map<string, PreparedMesh | null>());
  /** VNB8: the document those caches were filled for. */
  const cachedForRef = useRef<string | null>(null);
  const documentIdentity = runtime.documentIdentity;

  const requests = meshRequests(graph);
  // A flat string, so an unrelated recompile does not re-open every mesh.
  const key = requests.map((request) => `${request.nodeId}|${request.file}|${request.select}|${request.clip}@${request.clipRate}|${request.lamps}|${request.frame}|${request.sized}`).join("\n");

  useEffect(() => {
    if (backend === null || key === "") {
      setDiagnostics(NO_DIAGNOSTICS);
      return;
    }
    let cancelled = false;
    const unregisters: Array<() => void> = [];
    const found: RuntimeDiagnostic[] = [];
    if (cachedForRef.current !== documentIdentity) {
      cachedForRef.current = documentIdentity;
      filesRef.current.clear();
      preparedRef.current.clear();
    }

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

    void (async () => {
      for (const request of requests) {
        const preparedKey = `${request.file}|${request.select}|${request.clip}@${request.clipRate}|${request.lamps}|${request.frame}`;
        let prepared: PreparedMesh | null;
        try {
          const cached = preparedRef.current.get(preparedKey);
          prepared = cached !== undefined ? cached : prepareMesh(await readFile(request.file), request.select, request.clip === "" ? {} : { name: request.clip, rate: request.clipRate }, request.lamps, request.frame);
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
        const measured = measureMesh(runtimeRef.current, request.nodeId, prepared.facts);
        if (measured.refused !== undefined) {
          found.push({ severity: "warning", code: "mesh.unsizable", message: `Mesh "${request.nodeId}": ${measured.refused} (${prepared.facts.vertices} / ${prepared.facts.triangles}).`, nodeId: request.nodeId });
        }
        if (!measured.sized) continue;
        const ids = meshSourceIdsFor(request.nodeId);
        const points = prepared.points;
        const indices = prepared.indices;
        unregisters.push(backend.registerMediaSource(ids.points, { currentFrame: () => ({ frameId: 1, bytes: points }) }));
        unregisters.push(backend.registerMediaSource(ids.indices, { currentFrame: () => ({ frameId: 1, bytes: indices }) }));
        // T1410b: the chosen clip's baked poses.
        const pose = prepared.pose;
        if (pose !== undefined) unregisters.push(backend.registerMediaSource(ids.pose, { currentFrame: () => ({ frameId: 1, bytes: pose }) }));
      }
      if (!cancelled) setDiagnostics(found.length === 0 ? NO_DIAGNOSTICS : [...found]);
    })();

    return () => {
      cancelled = true;
      for (const unregister of unregisters) unregister();
    };
    // `requests` is derived from `key`; the key is the dependency by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, key, documentIdentity]);

  return { diagnostics };
}
