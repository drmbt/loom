import type { FrameEvaluationInput } from "../types/frame.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import type { ParameterSchema, StoredParameter } from "../types/parameters.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { nodeNames } from "../graph/names.ts";
import { effectiveParameterSchema, resolveParameter, type ParameterMorphStep, type ParameterMorphs } from "../parameters/resolve.ts";
import { componentAddressedDefinition, componentNamesFor, isParameterSlot, parseComponentKey } from "../parameters/slots.ts";
import { isComponentNodeType } from "../components/component-type.ts";
import { PAGE_TARGET, PRESET_MORPHS_KEY, isPresetsNode } from "./bank-view.ts";
import { easeMorph, morphProgress, parseMorphRecords, renameRecordsNode, sameStored, type MorphRecord } from "./morph.ts";
import { buildTimelineCueIndex, withTimelineCues } from "./timeline-cues.ts";

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
 * exactly as an animated knob's slot is.
 *
 * ## An end travels as what flattening WROTE for it (T1524b)
 *
 * The fold starts from the value the internal parameter showed before the recall, so each
 * end has to be the thing flattening put there while that end was stored — and that is
 * one of two things (`publishedPage`, `flatten.ts`):
 *
 *  - the instance's own SLOT, unresolved, when it is an expression or a channel read on a
 *    published fan-out (§T1017). It means the same one level in, so it travels as it is
 *    and keeps moving through the fade;
 *  - a plain VALUE, resolved on the instance where its scope is, for everything else: a
 *    static, a `bind` (relative — the same text one level in names another knob), a
 *    compound the instance overrides per component (assembled), and every end that
 *    reaches its target through a `parent.<key>` bind, which flattening always bakes
 *    (`PublishedOrigin.baked`). `bakedEnd` resolves it the same way, through the one read
 *    path, so the fade starts on the number that was on screen.
 *
 * A COMPONENT key of the instance (`tint.r`) has no stored twin inside — the target holds
 * the assembled compound — so its chain is indexed under the target's own component key
 * (`color.r`, matched by POSITION: the published and the internal compound are authored
 * separately) and the resolver fades that channel of the assembled value.
 */

/** The root document parameter an internal (flattened) parameter took its value from. */
export interface PublishedOrigin {
  readonly nodeId: NodeId;
  readonly key: string;
  /**
   * T1524b: the value arrived through a `parent.<key>` bind (§V81), which flattening
   * RESOLVES where the scope is and writes as a plain value — so the internal parameter
   * never holds the publisher's slot, whatever its mode. Absent on §V80's fan-out, where
   * an animated knob hands its slot down (§T1017).
   */
  readonly baked?: true;
}

/** Flattened node id → key → where that value was published from. */
export type PublishedOrigins = ReadonlyMap<NodeId, Readonly<Record<string, PublishedOrigin>>>;

/** The index of a document with nothing fading. One object, so "none" is an identity check. */
export const NO_MORPHS: ParameterMorphs = {
  keysOf: () => undefined,
  stepsAt: () => undefined,
  activeAt: () => false,
};

/**
 * Every bank's records, in bank-id order. Banks with none are absent.
 *
 * T1505b: a component instance whose look holds a page bank keeps its own records in
 * `presetMorphs`, keyed by `parent` (§1.2 Q3). They are read HERE under the instance's
 * name, before anything chains them, so a shot's record on a root bank (keyed `city`) and
 * the look's own record (keyed `parent` on `city`) on one key form one chain (§5.3) — and
 * because this is `buildMorphIndex`'s one source, all three index builders agree (§B8).
 * Graph-only: an instance holds `presetMorphs` only because a recall wrote them.
 */
export function bankMorphRecords(graph: GraphDocument): Array<{ bankId: NodeId; records: readonly MorphRecord[] }> {
  const banks: Array<{ bankId: NodeId; records: readonly MorphRecord[] }> = [];
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    if (node === undefined) continue;
    let records: MorphRecord[] = [];
    if (isPresetsNode(node)) records = parseMorphRecords(node.parameters["morphs"]);
    else if (isComponentNodeType(node.type) && node.label !== undefined) {
      records = renameRecordsNode(parseMorphRecords(node.parameters[PRESET_MORPHS_KEY]), PAGE_TARGET, node.label);
    }
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

/** An end flattening hands down as its own unresolved SLOT (§T1017's hop-invariant modes). */
function travelsAsSlot(stored: StoredParameter | undefined): boolean {
  return isParameterSlot(stored) && (stored.mode === "expression" || stored.mode === "driven");
}

/**
 * T1524b — one end of a fade as flattening WROTE it for an internal parameter: `stored`
 * resolved at `key` of the instance, in stored space, with no frame — the read
 * `publishedPage` makes (`flatten.ts`), on the same node with only this key swapped. A
 * bare compound comes back ASSEMBLED over the component slots the instance holds now; a
 * component key comes back as that one channel.
 */
function bakedEnd(node: GraphNode, schema: ParameterSchema, key: string, stored: StoredParameter): StoredParameter | undefined {
  const channel = schema[key] === undefined ? parseComponentKey(key) : null;
  const base = channel === null ? key : channel.base;
  const definition = schema[base];
  if (definition === undefined) return undefined;
  const resolved = resolveParameter({ ...node, parameters: { ...node.parameters, [key]: stored } }, base, definition, { schema });
  if (channel === null) return resolved.value;
  return resolved.components?.find((each) => each.name === channel.component)?.value;
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
  readonly flattened?:
    | {
        readonly graph: GraphDocument;
        readonly publishedOrigins: PublishedOrigins;
        /**
         * T1524b: root instance id → its PUBLISHED page as a schema. The ends of a fade
         * are resolved on the instance, and its schema lives in the component catalogue;
         * `registry` answers for an instance only when it is the component-aware view.
         */
        readonly instanceSchemas?: ReadonlyMap<NodeId, ParameterSchema> | undefined;
      }
    | undefined;
}

/**
 * THE MORPH INDEX the resolver reads: the recall morphs below, and — T1508b — the cue lists
 * that follow the timeline (`timeline-cues.ts`), which outrank a recall's fade on the keys
 * they cover. One index, so the three builders (compile, flatten, the Dawn harness) get both
 * by construction and `keysOf` / `activeAt` cover both (the design doc §2.2 Q2, §2.4).
 */
export function buildMorphIndex(input: MorphIndexInput): ParameterMorphs {
  return withTimelineCues(buildRecallMorphIndex(input), buildTimelineCueIndex(input));
}

/**
 * T1508b — the internal parameters a ROOT key reaches through flattening, for the timeline
 * cues: the same rule `buildRecallMorphIndex` applies inline to a recall's chain (the
 * module note's "Inside a component" and "An end travels as what flattening WROTE"), with
 * `accepts` in place of `morphableKey` — a timed cue also CUTS keys that cannot fade.
 * Each target's `end` turns a root end into the one flattening would have written there.
 * Kept beside, not merged into, the inline copy while §T1505b reworks that loop; the two
 * are one rule and should become one function.
 */
export function publishedTargets(
  input: MorphIndexInput,
  rootNode: GraphNode,
  key: string,
  accepts: (definition: NodeDefinition | undefined, node: GraphNode, key: string) => boolean,
): Array<{ readonly nodeId: NodeId; readonly key: string; readonly node: GraphNode; readonly definition: NodeDefinition | undefined; end(stored: StoredParameter): StoredParameter | undefined }> {
  const { registry } = input;
  const graph = input.flattened?.graph ?? input.document;
  const fanOut = (address: string): Array<{ nodeId: NodeId; key: string; baked: boolean }> | undefined => {
    let found: Array<{ nodeId: NodeId; key: string; baked: boolean }> | undefined;
    for (const [flatId, keys] of input.flattened?.publishedOrigins ?? []) {
      for (const [flatKey, origin] of Object.entries(keys)) {
        if (`${origin.nodeId}\u0000${origin.key}` !== address) continue;
        (found ??= []).push({ nodeId: flatId, key: flatKey, baked: origin.baked === true });
      }
    }
    return found;
  };
  const direct = fanOut(`${rootNode.id}\u0000${key}`);
  const channel = direct === undefined ? parseComponentKey(key) : null;
  const published = channel === null ? key : channel.base;
  const targets = direct ?? (channel === null ? undefined : fanOut(`${rootNode.id}\u0000${published}`));
  if (targets === undefined) return [];
  const schema =
    input.flattened?.instanceSchemas?.get(rootNode.id) ?? effectiveParameterSchema(registry.get(rootNode.type), rootNode.parameters);
  const publishedDefinition = schema[published];
  const position =
    channel === null || publishedDefinition === undefined ? -1 : (componentNamesFor(publishedDefinition)?.indexOf(channel.component) ?? -1);
  if (channel !== null && position < 0) return [];
  const slotInside = travelsAsSlot(rootNode.parameters[published]);
  const baked = new Map<StoredParameter, StoredParameter | undefined>();
  const bake = (stored: StoredParameter): StoredParameter | undefined => {
    if (!baked.has(stored)) baked.set(stored, bakedEnd(rootNode, schema, key, stored));
    return baked.get(stored);
  };
  const found: ReturnType<typeof publishedTargets> = [];
  for (const target of targets) {
    const internal = graph.nodes[target.nodeId];
    if (internal === undefined) continue;
    const definition = registry.get(internal.type);
    let targetKey = target.key;
    if (channel !== null) {
      if (slotInside && !target.baked) continue;
      const targetDefinition = effectiveParameterSchema(definition, internal.parameters)[target.key];
      const name = targetDefinition === undefined ? undefined : componentNamesFor(targetDefinition)?.[position];
      if (name === undefined) continue;
      targetKey = `${target.key}.${name}`;
      if (internal.parameters[targetKey] !== undefined) continue;
    }
    if (!accepts(definition, internal, targetKey)) continue;
    found.push({
      nodeId: target.nodeId,
      key: targetKey,
      node: internal,
      definition,
      end: (stored) => (channel === null && !target.baked && travelsAsSlot(stored) ? stored : bake(stored)),
    });
  }
  return found;
}

/** T1497b's index of the recall morphs in the banks' `morphs` records (the module note). */
function buildRecallMorphIndex(input: MorphIndexInput): ParameterMorphs {
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
  const fanOut = new Map<string, Array<{ nodeId: NodeId; key: string; baked: boolean }>>();
  for (const [flatId, keys] of input.flattened?.publishedOrigins ?? []) {
    for (const [key, origin] of Object.entries(keys)) {
      const address = `${origin.nodeId}\u0000${origin.key}`;
      const list = fanOut.get(address) ?? [];
      fanOut.set(address, list);
      list.push({ nodeId: flatId, key, baked: origin.baked === true });
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
        // Inside a component. `key` is a published key, or one CHANNEL of a published
        // compound (`tint.r`); either way the targets are the published key's. Asked
        // before any schema is: almost every chain is on a plain node and has none.
        const direct = fanOut.get(`${nodeId}\u0000${key}`);
        const channel = direct === undefined ? parseComponentKey(key) : null;
        const published = channel === null ? key : channel.base;
        const targets = direct ?? (channel === null ? undefined : fanOut.get(`${nodeId}\u0000${published}`));
        if (targets === undefined) continue;
        const schema =
          input.flattened?.instanceSchemas?.get(nodeId) ?? effectiveParameterSchema(registry.get(rootNode.type), rootNode.parameters);
        const publishedDefinition = schema[published];
        const position =
          channel === null || publishedDefinition === undefined
            ? -1
            : (componentNamesFor(publishedDefinition)?.indexOf(channel.component) ?? -1);
        if (channel !== null && position < 0) continue;
        /** The instance's own slot rides inward on a fan-out; a `parent.` bind never carries one. */
        const slotInside = travelsAsSlot(rootNode.parameters[published]);

        /** Each end resolved on the instance ONCE, however many targets read it. */
        const baked = new Map<StoredParameter, StoredParameter | undefined>();
        const bake = (stored: StoredParameter): StoredParameter | undefined => {
          if (!baked.has(stored)) baked.set(stored, bakedEnd(rootNode, schema, key, stored));
          return baked.get(stored);
        };

        for (const target of targets) {
          const internal = graph.nodes[target.nodeId];
          if (internal === undefined) continue;
          const definition = registry.get(internal.type);
          let targetKey = target.key;
          if (channel !== null) {
            // The target holds the instance's own slot at the bare key: the channel the
            // instance overrides is not on screen inside at all, so there is nothing to fade.
            if (slotInside && !target.baked) continue;
            const targetDefinition = effectiveParameterSchema(definition, internal.parameters)[target.key];
            const name = targetDefinition === undefined ? undefined : componentNamesFor(targetDefinition)?.[position];
            if (name === undefined) continue;
            targetKey = `${target.key}.${name}`;
            // A channel the component AUTHORS on the target outranks the published one.
            if (internal.parameters[targetKey] !== undefined) continue;
          }
          if (!morphableKey(definition, internal, targetKey)) continue;
          const end = (stored: StoredParameter): StoredParameter | undefined =>
            channel === null && !target.baked && travelsAsSlot(stored) ? stored : bake(stored);
          const inward: Link[] = [];
          for (const link of links) {
            const from = end(link.from);
            const to = end(link.to);
            if (from === undefined || to === undefined) break;
            inward.push({ record: link.record, from, to });
          }
          if (inward.length === links.length) file(target.nodeId, targetKey, epoch, inward);
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
