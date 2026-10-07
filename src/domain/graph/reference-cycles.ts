import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import { nodeNames } from "./names.ts";
import { dependenciesFrom, keyReads } from "./parameter-dependencies.ts";

/**
 * Authoring-time `op()` reference cycles (T331, §V152, §V244).
 *
 * `bindCycleDiagnostics` refuses a loop of `bind` refs on ONE node. A cross-node
 * reference — `op('a').par.x` — closes a loop that is invisible to it and to a texture
 * topo sort alike: no edge exists between the two nodes at all, so nothing in the graph
 * layer had an opinion about `a` reading `b` while `b` reads `a`.
 *
 * There has been a runtime guard for it since T316 (`node-references.ts` carries a
 * visited set and NAMES the loop instead of overflowing the stack). §V244 is the reason
 * that is not the end of the story: a mitigation which makes a bug survivable removes the
 * pressure to prevent it, and §V152 asks for the cycle to be REFUSED when it is written,
 * with the path named. A named runtime failure still means the user authored something
 * the document should never have held, and every reader downstream — the compiler, the
 * inspector, a `.loom.json` opened tomorrow — has to cope with it forever.
 *
 * ## The unit of the cycle is the PARAMETER: a ring over (node, key) (§B293)
 *
 * This gate used to be keyed by NODE, on purpose: the reader resolved the target's WHOLE
 * schema, so `a.x → b.y` beside `b.z → a.w` really did recurse, and a gate finer than the
 * reader would have accepted documents the reader then refused one hop down. The price was
 * that a parameter could not read another parameter of its own node: a camera's Look At
 * from the length of its own Heading was "a cycle", and so were two nodes that read each
 * other's unrelated parameters. Both halves moved together, as that note asked: the reader
 * resolves the ONE parameter it is asked for (`node-references.ts`), its guard is keyed by
 * (node, key), and so is this.
 *
 * The key is the BASE key. A compound resolves whole (§V113), so `lookAt.z` reading
 * `lookAt.x` is `lookAt` reading itself, exactly as a bind between the two is refused.
 *
 * A read of a CHANNEL depends on whatever the named node composes it from, and the node's
 * definition says what that is (`ChannelDependencies`): a camera's `chan.distance` is
 * composed from its Eye and Look At, so its Look At reading `chan.distance` is a ring and
 * is named as one; a value node's bag is made from all of its parameters.
 *
 * A BIND to a sibling is an edge of the same graph, so a ring that is part bind and part
 * `op()` is seen. A ring of binds alone is `bindCycleDiagnostics`' and is not said twice.
 *
 * ## Why a dangling reference is not a cycle
 *
 * `op('ghost')` names nothing, so it contributes no edge. It is already reported where it
 * belongs — at resolution, on the parameter that carries it — and refusing a patch for it
 * would make an expression unwritable until the node it names exists, which is backwards
 * from how people build a network.
 */

/**
 * What a read of `op('node').chan.<c>` depends on, of that node's own parameters: the keys
 * its definition composes its channels from (`parameterChannels.reads`), `"all"` for a
 * value node (its bag is made from every parameter it has), or null for a channel that is
 * no function of the node's parameters this frame (a measurement, a device).
 */
export type ChannelDependencies = (node: GraphNode) => readonly string[] | "all" | null;

/** The one reading of a definition for `ChannelDependencies`. Structural: this layer names no registry. */
export function channelDependenciesOf(
  definition: { readonly parameterChannels?: { readonly reads: readonly string[] } | undefined; readonly valueChannel?: unknown; readonly valueEvaluate?: unknown } | undefined,
): readonly string[] | "all" | null {
  if (definition === undefined) return null;
  if (definition.parameterChannels !== undefined) return definition.parameterChannels.reads;
  return definition.valueChannel !== undefined || definition.valueEvaluate !== undefined ? "all" : null;
}

const NO_CHANNELS: ChannelDependencies = () => null;

/** A vertex: one parameter of one node, by its base key. */
type Vertex = string;
const vertexOf = (nodeId: NodeId, key: string): Vertex => `${nodeId}\u0000${key}`;
const nodeOf = (vertex: Vertex): NodeId => vertex.slice(0, vertex.indexOf("\u0000"));

interface Edge {
  readonly from: Vertex;
  readonly to: Vertex;
  /** An `op()` read (a ring needs one to be this gate's), or a bind to a sibling. */
  readonly reference: boolean;
  /** How the hop reads: `a.gain`, and `a.chan.distance` after it when it went through a channel. */
  readonly said: readonly string[];
}

/**
 * The (node, key) graph. `driven` slots are not in it, as before: a driven channel resolves
 * through the value graph, which has its own order and its own cycle rejection (§V179).
 */
function keyEdges(graph: GraphDocument, channels: ChannelDependencies): Map<Vertex, Edge[]> {
  const byName = nodeNames(graph);
  const edges = new Map<Vertex, Edge[]>();
  const slotKeys = new Map<NodeId, readonly string[]>();
  const keysOf = (nodeId: NodeId): readonly string[] => {
    const known = slotKeys.get(nodeId);
    if (known !== undefined) return known;
    const keys = [...new Set(keyReads(graph.nodes[nodeId]?.parameters ?? {}).map((read) => read.from))];
    slotKeys.set(nodeId, keys);
    return keys;
  };
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    if (node === undefined) continue;
    const name = node.label ?? nodeId;
    for (const read of keyReads(node.parameters)) {
      const from = vertexOf(nodeId, read.from);
      const add = (to: Vertex, reference: boolean, said: readonly string[]): void => {
        const list = edges.get(from);
        const edge = { from, to, reference, said };
        if (list === undefined) edges.set(from, [edge]);
        else list.push(edge);
      };
      const here = `${name}.${read.stored}`;
      if (read.kind === "parameter") {
        const target = read.node === null ? nodeId : byName.get(read.node);
        if (target !== undefined) add(vertexOf(target, read.key), read.node !== null, [here]);
        continue;
      }
      const target = byName.get(read.node);
      const targetNode = target === undefined ? undefined : graph.nodes[target];
      if (target === undefined || targetNode === undefined) continue;
      const composed = channels(targetNode);
      if (composed === null) continue;
      const through = `${targetNode.label ?? target}.chan.${read.channel}`;
      // Only a key that READS something can carry a ring on; the others have no way out.
      for (const key of composed === "all" ? keysOf(target) : composed) add(vertexOf(target, key), true, [here, through]);
    }
  }
  return edges;
}

/**
 * Every ring, as the edges round it. Tarjan's components, so the whole document is one
 * linear pass however many expressions it holds; a ring is named from the first vertex of
 * its component, and only a component with an `op()` read inside it is this gate's.
 */
function rings(edges: ReadonlyMap<Vertex, Edge[]>, startAt?: NodeId): Edge[][] {
  const index = new Map<Vertex, number>();
  const low = new Map<Vertex, number>();
  const onStack = new Set<Vertex>();
  const stack: Vertex[] = [];
  const components: Vertex[][] = [];
  let next = 0;
  const visit = (vertex: Vertex): void => {
    index.set(vertex, next);
    low.set(vertex, next);
    next += 1;
    stack.push(vertex);
    onStack.add(vertex);
    for (const edge of edges.get(vertex) ?? []) {
      if (!index.has(edge.to)) {
        visit(edge.to);
        low.set(vertex, Math.min(low.get(vertex)!, low.get(edge.to)!));
      } else if (onStack.has(edge.to)) {
        low.set(vertex, Math.min(low.get(vertex)!, index.get(edge.to)!));
      }
    }
    if (low.get(vertex) !== index.get(vertex)) return;
    const component: Vertex[] = [];
    for (;;) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === vertex) break;
    }
    components.push(component);
  };
  for (const vertex of [...edges.keys()].sort()) if (!index.has(vertex)) visit(vertex);

  const found: Edge[][] = [];
  for (const component of components) {
    const members = new Set(component);
    const inside = (vertex: Vertex): Edge[] => (edges.get(vertex) ?? []).filter((edge) => members.has(edge.to));
    // A ring to name: from an `op()` read inside the component, back to where it started.
    // Named from the node the caller asked about, when it is on the ring: the one just written.
    const reads = component.sort().flatMap(inside).filter((edge) => edge.reference);
    const first = reads.find((edge) => nodeOf(edge.from) === startAt) ?? reads[0];
    if (first === undefined) continue;
    if (first.to === first.from) {
      found.push([first]);
      continue;
    }
    if (component.length === 1) continue;
    const seen = new Set<Vertex>([first.to]);
    const path: Edge[] = [first];
    const back = (vertex: Vertex): boolean => {
      for (const edge of inside(vertex)) {
        path.push(edge);
        if (edge.to === first.from) return true;
        if (!seen.has(edge.to)) {
          seen.add(edge.to);
          if (back(edge.to)) return true;
        }
        path.pop();
      }
      return false;
    };
    if (back(first.to)) found.push(path);
  }
  return found;
}

/** `a.gain → b.gain → a.gain`: every parameter on the ring, and back to the first. */
function cycleDiagnostic(ring: readonly Edge[]): RuntimeDiagnostic {
  const hops = ring.flatMap((edge) => edge.said);
  return {
    severity: "error",
    code: "parameter.referenceCycle",
    message: `Parameter reference chain is circular: ${[...hops, hops[0]].join(" → ")}.`,
    nodeId: nodeOf(ring[0]!.from),
    suggestion: "Break the loop: one of these expressions must stop reading the other (§V152).",
  };
}

/**
 * Every `op()` reference ring in the document, one diagnostic each.
 *
 * The whole-document form, for a graph that arrived from a FILE rather than through the
 * command bus — the compiler calls it, exactly as it calls `bindCycleDiagnostics`, so a
 * project someone hand-edited or an older export still reports in the problems tab
 * instead of only misbehaving at resolution.
 */
export function referenceCycleDiagnostics(graph: GraphDocument, channels: ChannelDependencies = NO_CHANNELS): RuntimeDiagnostic[] {
  return rings(keyEdges(graph, channels)).map(cycleDiagnostic);
}

/**
 * The rings that pass through ONE node — the patch gate's question (§V152).
 *
 * Scoped to the node the patch wrote, and not to the whole document, because a
 * document can arrive carrying a cycle and refusing every unrelated edit until it is
 * fixed would make the file harder to repair than to abandon. A `setParameters` touches
 * one node, so any ring the patch CREATED runs through a parameter of that node; a ring
 * elsewhere is the compiler's report, not this patch's rejection.
 *
 * Checked on the MERGED draft, like `bindCycleDiagnostics`: the ring may close through a
 * parameter this patch never touched, and the draft is discarded whole, so a document
 * that went through the bus can never hold one.
 */
export function referenceCyclesThrough(graph: GraphDocument, nodeId: NodeId, channels: ChannelDependencies = NO_CHANNELS): RuntimeDiagnostic[] {
  const node = graph.nodes[nodeId];
  if (node === undefined) return [];
  /*
   * A ring through this node leaves it by an `op()` read, so that is checked first: one
   * node's parameters parsed instead of the whole document's. Not a micro-optimisation:
   * this runs on every `addNode`, and a node from the palette, or fifty pasted, carry no
   * reference at all.
   */
  if (!dependenciesFrom(graph, node, nodeId).some((dependency) => dependency.kind === "reference")) return [];
  return rings(keyEdges(graph, channels), nodeId)
    .filter((ring) => ring.some((edge) => nodeOf(edge.from) === nodeId))
    .map(cycleDiagnostic);
}
