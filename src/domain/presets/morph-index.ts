import type { FrameEvaluationInput } from "../types/frame.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import type { StoredParameter } from "../types/parameters.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { nodeNames } from "../graph/names.ts";
import { effectiveParameterSchema, type ParameterMorphStep, type ParameterMorphs } from "../parameters/resolve.ts";
import { componentAddressedDefinition, isParameterSlot, parseComponentKey } from "../parameters/slots.ts";
import { PRESETS_NODE_TYPE } from "./bank.ts";
import { easeMorph, morphProgress, parseMorphRecords, sameStored, type MorphRecord } from "./morph.ts";

/**
 * T1497b (§T1398b S2) — THE MORPH INDEX: every bank's records, turned once per document
 * revision into what the resolver asks per frame (`ParameterMorphs`, `resolve.ts`).
 *
 * ## Why an index, and why it is a pure function of the document
 *
 * The fold runs per key per frame (the design doc §5.3), and everything about it except
 * the frame is document state: which records touch a key, in what order, whether the key
 * has been edited since, whether the key can fade at all. So all of that is decided HERE,
 * once, and a frame only has to compare an epoch and divide a time. Nothing is cached
 * across revisions and nothing is mutable — a recall, an undo and a manual edit are each
 * a new document and therefore a new index, which is how "undo mid-morph restores the old
 * value at the next frame" and "a slider edit wins at once" hold with no extra write.
 *
 * ## The three decisions made here
 *
 *  1. THE CHAIN on a key: the records of one epoch that touch it, oldest `start` first,
 *     across EVERY bank — a shot's morph interrupting a look's morph on the same key is
 *     one chain. Only its CONTIGUOUS tail counts: a record whose `to` is not the next
 *     record's `from` was followed by something that was not a recall (a manual edit), so
 *     what it left on screen is no longer where the next fade started from.
 *  2. THE EDIT RULE (§5.3 rule 2): if the key's stored slot is not the newest record's
 *     `to`, someone has edited it since — the edit wins and the key has no chain at all.
 *  3. WHICH KEYS FADE: numbers, vectors and colours, and never a STRUCTURAL key — one
 *     declared `compileTime`, or one a parameter resolution policy reads for the node's
 *     size. Those cut at the start, because the document already holds the end state and a
 *     structural value that moved per frame would recompile per frame (§V5). Deciding it
 *     here, from the definitions, is what makes `keysOf` (what the values-only compile
 *     re-resolves) and `stepsAt` (what the fold moves) the same set by construction;
 *     `frame-compile.test.ts` holds it against `structuralParameterKeys` for every
 *     registered node type.
 *
 * ## Inside a component (§5.3, §T1017)
 *
 * A look is usually a component instance, and flattening dissolves the instance: its
 * published value is written onto the internal parameters it drives (§V80) and no node
 * called `city` is left to resolve. `flattenComponents` therefore records, for each
 * internal parameter, the ROOT document parameter its value came from
 * (`PublishedOrigins`), and a chain on the instance's published key is indexed under
 * every internal parameter it fans out to. The ends are resolved on the internal node,
 * exactly as an animated knob's slot is, so only ends that mean the same thing one level
 * in may travel — the whitelist is §T1017's (a `bind` is relative and does not).
 */

/** The root document parameter an internal (flattened) parameter took its value from. */
export interface PublishedOrigin {
  readonly nodeId: NodeId;
  readonly key: string;
}

/** Flattened node id → key → where that value was published from. */
export type PublishedOrigins = ReadonlyMap<NodeId, Readonly<Record<string, PublishedOrigin>>>;

/** The index of a document with nothing fading. One object, so "none" is an identity check. */
export const NO_MORPHS: ParameterMorphs = {
  keysOf: () => undefined,
  stepsAt: () => undefined,
  activeAt: () => false,
};

/** Every bank's records, in bank-id order. Banks with none are absent. */
export function bankMorphRecords(graph: GraphDocument): Array<{ bankId: NodeId; records: readonly MorphRecord[] }> {
  const banks: Array<{ bankId: NodeId; records: readonly MorphRecord[] }> = [];
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    if (node === undefined || node.type !== PRESETS_NODE_TYPE) continue;
    const records = parseMorphRecords(node.parameters["morphs"]);
    if (records.length > 0) banks.push({ bankId: nodeId, records });
  }
  return banks;
}

/** Does any bank hold a record at all? The per-revision half of "does this document animate". */
export function hasMorphRecords(graph: GraphDocument): boolean {
  return bankMorphRecords(graph).length > 0;
}

/** The parameter types that have an in-between. Everything else cuts (the design doc §5.3). */
const BLENDABLE: ReadonlySet<string> = new Set(["number", "vector", "color"]);

/**
 * May this key of this node FADE, or does it cut? See decision 3 above.
 *
 * The resolution-policy check is the same structural read `compiler/resolution.ts` makes
 * (`isParameterPolicy`): the frozen `ResolutionPolicy` union has no `parameter` member, so
 * both narrow from `unknown`. The domain may not import the compiler for it.
 */
export function morphableKey(definition: NodeDefinition | undefined, node: GraphNode, key: string): boolean {
  if (definition === undefined) return false;
  const schema = effectiveParameterSchema(definition, node.parameters);
  const component = schema[key] === undefined ? parseComponentKey(key) : null;
  const root = component === null ? key : component.base;
  const rootDefinition = schema[root];
  const keyDefinition = schema[key] ?? componentAddressedDefinition(schema, key);
  if (rootDefinition === undefined || keyDefinition === undefined) return false;
  if (!BLENDABLE.has(keyDefinition.type)) return false;
  if (rootDefinition.compileTime === true) return false;
  const policy = definition.resolutionPolicy as unknown as { kind?: unknown; width?: unknown; height?: unknown } | undefined;
  if (policy?.kind === "parameter" && (policy.width === root || policy.height === root)) return false;
  return true;
}

/** An end that resolves to the same thing on an internal parameter as on the instance (§T1017). */
function travelsInward(stored: StoredParameter): boolean {
  return !isParameterSlot(stored) || stored.mode === "static" || stored.mode === "expression" || stored.mode === "driven";
}

interface Link {
  readonly record: MorphRecord;
  readonly from: StoredParameter;
  readonly to: StoredParameter;
}

export interface MorphIndexInput {
  /** The ROOT document: the banks, and the nodes their records name. */
  readonly document: GraphDocument;
  readonly registry: NodeRegistryView;
  /**
   * The flattening the frame paths resolve on, when the caller has one. Absent, the
   * document itself is what resolves and there are no published fan-outs to follow.
   */
  readonly flattened?: { readonly graph: GraphDocument; readonly publishedOrigins: PublishedOrigins } | undefined;
}

export function buildMorphIndex(input: MorphIndexInput): ParameterMorphs {
  const { document, registry } = input;
  const banks = bankMorphRecords(document);
  if (banks.length === 0) return NO_MORPHS;

  // 1. Every (root node, key, epoch) a record touches, in `start` order. The sort is
  // stable, so two recalls stamped at one frame keep bank-id then list order.
  const names = nodeNames(document);
  const chains = new Map<NodeId, Map<string, Map<string, Link[]>>>();
  for (const { records } of banks) {
    for (const record of records) {
      for (const [nodeName, keys] of Object.entries(record.to)) {
        const nodeId = names.get(nodeName);
        if (nodeId === undefined) continue;
        for (const [key, to] of Object.entries(keys)) {
          const from = record.from[nodeName]?.[key];
          if (from === undefined) continue;
          const byKey = chains.get(nodeId) ?? new Map<string, Map<string, Link[]>>();
          chains.set(nodeId, byKey);
          const byEpoch = byKey.get(key) ?? new Map<string, Link[]>();
          byKey.set(key, byEpoch);
          const links = byEpoch.get(record.epoch) ?? [];
          byEpoch.set(record.epoch, links);
          links.push({ record, from, to });
        }
      }
    }
  }

  const graph = input.flattened?.graph ?? document;
  /** `rootNodeId\u0000key` → the flattened parameters that value was fanned out onto. */
  const fanOut = new Map<string, Array<{ nodeId: NodeId; key: string }>>();
  for (const [flatId, keys] of input.flattened?.publishedOrigins ?? []) {
    for (const [key, origin] of Object.entries(keys)) {
      const address = `${origin.nodeId}\u0000${origin.key}`;
      const list = fanOut.get(address) ?? [];
      fanOut.set(address, list);
      list.push({ nodeId: flatId, key });
    }
  }

  const index = new Map<NodeId, Map<string, Map<string, readonly Link[]>>>();
  /** Epoch → the latest moment any indexed link is still fading. */
  const ends = new Map<string, number>();
  const file = (nodeId: NodeId, key: string, epoch: string, links: readonly Link[]): void => {
    const byKey = index.get(nodeId) ?? new Map<string, Map<string, readonly Link[]>>();
    index.set(nodeId, byKey);
    const byEpoch = byKey.get(key) ?? new Map<string, readonly Link[]>();
    byKey.set(key, byEpoch);
    byEpoch.set(epoch, links);
    for (const link of links) {
      ends.set(epoch, Math.max(ends.get(epoch) ?? Number.NEGATIVE_INFINITY, link.record.start + link.record.seconds));
    }
  };

  for (const [nodeId, byKey] of chains) {
    const rootNode = document.nodes[nodeId];
    if (rootNode === undefined) continue;
    for (const [key, byEpoch] of byKey) {
      for (const [epoch, unordered] of byEpoch) {
        const ordered = [...unordered].sort((a, b) => a.record.start - b.record.start);
        const newest = ordered[ordered.length - 1] as Link;
        // 2. The edit rule: the key no longer stores what the newest recall wrote.
        if (!sameStored(rootNode.parameters[key], newest.to)) continue;
        // 1b. The contiguous tail: each fade starts where the one before it was heading.
        let first = ordered.length - 1;
        while (first > 0 && sameStored((ordered[first - 1] as Link).to, (ordered[first] as Link).from)) first -= 1;
        const links = ordered.slice(first);

        const flatNode = graph.nodes[nodeId];
        if (flatNode !== undefined && flatNode.type === rootNode.type && morphableKey(registry.get(flatNode.type), flatNode, key)) {
          file(nodeId, key, epoch, links);
        }
        const targets = fanOut.get(`${nodeId}\u0000${key}`);
        if (targets === undefined) continue;
        // A compound published per component reaches its targets assembled, so a fade on
        // the bare key would blend past a channel the instance overrides; and an end that
        // is relative to the instance (a bind) means something else one level in. Both cut.
        const overridden = Object.keys(rootNode.parameters).some((stored) => stored.startsWith(`${key}.`));
        if (overridden || !links.every((link) => travelsInward(link.from) && travelsInward(link.to))) continue;
        for (const target of targets) {
          const internal = graph.nodes[target.nodeId];
          if (internal === undefined || !morphableKey(registry.get(internal.type), internal, target.key)) continue;
          file(target.nodeId, target.key, epoch, links);
        }
      }
    }
  }
  if (index.size === 0) return NO_MORPHS;

  const keys = new Map<NodeId, ReadonlySet<string>>();
  for (const [nodeId, byKey] of index) keys.set(nodeId, new Set(byKey.keys()));

  return {
    keysOf: (nodeId) => keys.get(nodeId),
    stepsAt(nodeId: string, key: string, frame: FrameEvaluationInput): readonly ParameterMorphStep[] | undefined {
      const epoch = frame.absEpoch;
      const now = frame.absTimeSeconds;
      if (epoch === undefined || now === undefined) return undefined;
      const links = index.get(nodeId)?.get(key)?.get(epoch);
      if (links === undefined) return undefined;
      // A FINISHED record ends every older one on this key (§5.3): what is still running
      // is whatever came after the newest record that has reached p = 1.
      let first = 0;
      for (let at = links.length - 1; at >= 0; at -= 1) {
        if (morphProgress((links[at] as Link).record, now) >= 1) {
          first = at + 1;
          break;
        }
      }
      if (first >= links.length) return undefined;
      return links.slice(first).map((link) => ({
        from: link.from,
        to: link.to,
        progress: easeMorph(link.record.curve, morphProgress(link.record, now)),
      }));
    },
    activeAt(frame: FrameEvaluationInput): boolean {
      if (frame.absEpoch === undefined || frame.absTimeSeconds === undefined) return false;
      const end = ends.get(frame.absEpoch);
      return end !== undefined && frame.absTimeSeconds < end;
    },
  };
}
