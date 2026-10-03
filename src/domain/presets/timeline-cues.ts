import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";
import { DEFAULT_PROJECT_FPS, type GraphDocument, type GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import type { ParameterSchema, StoredParameter } from "../types/parameters.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { nodeByName } from "../graph/names.ts";
import { effectiveParameterSchema, resolveParameters, type ParameterMorphStep, type ParameterMorphs } from "../parameters/resolve.ts";
import { componentAddressedDefinition, parseComponentKey, storedStaticValue } from "../parameters/slots.ts";
import { defaultParameterValue } from "../parameters/validate.ts";
import { parsePresetBank, type MorphCurve } from "./bank.ts";
import { isPresetsNode } from "./bank-view.ts";
import { presetMorph, presetRecallEnd } from "./commands.ts";
import { CUE_FOLLOW_TIMELINE, CUE_LIST_NODE_TYPE, cueReachFrame, parseCueList, type CueList } from "./cue-list.ts";
import { easeMorph } from "./morph.ts";
import { morphableKey, publishedTargets, type MorphIndexInput } from "./morph-index.ts";

/**
 * T1508b (§T1398b second ruling B) — TIMELINE-PLACED CUES THAT AN EXPORT REPRODUCES: a cue
 * list whose `follow` is `timeline` is a PURE FUNCTION OF THE PLAYHEAD. The design is
 * `docs/presets-followups-design-2026-10-03.md` Part 2; the owner's three rulings are its
 * owner questions, answered "yes" (SPEC §T1508b).
 *
 * ## Values apply as drivers, never as writes
 *
 * A timed cue writes NOTHING. Each cue's end is what its recall WOULD write — the one
 * planner's `after` map (`presetRecallEnd`), so shots expand and ruling 4's skips apply
 * exactly as at GO — computed once per revision, and the resolver folds those ends over the
 * stored slot on `timeSeconds`, inside `buildMorphIndex` (`withTimelineCues`). One index, so
 * the compile, the flattening and the Dawn harness read the same thing (§B8's shape), and an
 * export — which steps the timeline from frame 0 — renders what playback showed. The
 * document's revision is the same after an export as before it.
 *
 * ## The fold on one key (the design doc §2.2 Q2)
 *
 * The cues of every following list that cover the key, in `at` order (ties: list name,
 * then position). Before the first is reached, the key is not the timeline's at all — the
 * stored slot, or a live recall's fade, shows. From the first one on, the timeline OUTRANKS
 * the stored slot and any live morph (owner ruling 1: a fader, a GO or the phone moving a
 * covered key writes the document but does not show until the list is back to live): start
 * from the newest cue that has FINISHED (or the stored slot when none has), and blend each
 * later reached cue in, `V = lerp(V, resolve(to_i), ease_i((t − at_i) / seconds_i))`. A
 * later cue arriving mid-fade therefore continues from what is on screen. Both ends resolve
 * live, so an expression end keeps moving. A key with no in-between (an enum, a string, a
 * boolean) cuts at its cue.
 *
 * Whether a cue is REACHED is a frame index against a per-revision integer (`cueReachFrame`),
 * never `n / fps >= at` as floats. Progress is still `(timeSeconds − at) / seconds`.
 *
 * ## What a timed cue cannot do in v1 (owner ruling 2)
 *
 * Structural settings — a Layer's on/off, a key the compiler reads as structure
 * (`compileTime`, a resolution-policy input, a source reference such as a Layer's
 * `picture`) — are SKIPPED, each with a named warning on the list that names the cue. Making
 * them switch at cue times needs recompiles at the crossings: §T1537b.
 *
 * ## A timed list is all-timed (owner ruling 3)
 *
 * GO, BACK and fire are refused on a following list (`cue.timeline`, `cue-commands.ts`); a
 * cue with no `at` is skipped with a warning; manual cues run from a second, live list.
 */

/** Does this node follow the timeline? Read from the STORED value, so it is per revision. */
export function followsTimeline(node: GraphNode): boolean {
  return node.type === CUE_LIST_NODE_TYPE && storedStaticValue(node.parameters["follow"]) === CUE_FOLLOW_TIMELINE;
}

/** Does any cue list follow the timeline? The per-revision half of "does this document animate". */
export function hasTimelineCueLists(graph: GraphDocument): boolean {
  return Object.values(graph.nodes).some(followsTimeline);
}

/** Frames per TIMELINE second at a frame: the project rate times the sub-frames it is stepped at. */
export function timelineRate(frame: Pick<FrameEvaluationInput, "fps" | "subframes">): number {
  const fps = frame.fps !== undefined && Number.isFinite(frame.fps) && frame.fps > 0 ? frame.fps : DEFAULT_PROJECT_FPS;
  const subframes = frame.subframes !== undefined && Number.isFinite(frame.subframes) && frame.subframes >= 1 ? frame.subframes : 1;
  return fps * subframes;
}

/**
 * The playhead as a FRAME INDEX on the timeline: `timeSeconds` is `n / rate` divided, never
 * accumulated (both transports), so this is `n` exactly. Read off `timeSeconds` rather than
 * `frameIndex` because a live rate change rebases the clock (`live-clock.ts`) and the two
 * then disagree; the playhead is the time.
 */
export function playheadFrame(timeSeconds: number, rate: number): number {
  return Math.round(timeSeconds * rate);
}

/**
 * Is this key STRUCTURAL — something a timed cue cannot change in v1? `compileTime`, a
 * resolution-policy input, or a source reference (a Layer's `picture`, which decides which
 * chain is compiled). The first two are `morphableKey`'s structural half.
 */
export function structuralCueKey(definition: NodeDefinition | undefined, node: GraphNode, key: string): boolean {
  if (definition === undefined) return false;
  const schema = effectiveParameterSchema(definition, node.parameters);
  const component = schema[key] === undefined ? parseComponentKey(key) : null;
  const root = component === null ? key : component.base;
  if (schema[root]?.compileTime === true) return true;
  const policy = definition.resolutionPolicy as unknown as { kind?: unknown; width?: unknown; height?: unknown } | undefined;
  if (policy?.kind === "parameter" && (policy.width === root || policy.height === root)) return true;
  return (definition.sourceReferences ?? []).some((reference) => reference.parameter === root);
}

/** A warning about a following list, and the cue it is about (`null`: the list itself). */
export interface TimelineCueWarning {
  readonly list: NodeId;
  readonly cue: string | null;
  readonly diagnostic: RuntimeDiagnostic;
}

/** One timed cue on one root key: when it is reached, how it fades, and the end it applies. */
interface TimedLink {
  readonly at: number;
  readonly seconds: number;
  readonly curve: MorphCurve;
  readonly to: StoredParameter;
  readonly listName: string;
  readonly position: number;
}

export interface TimelineCuePlan {
  /** Root node id → key → the timed cues covering it, in `at` order (ties: list name, position). */
  readonly chains: ReadonlyMap<NodeId, ReadonlyMap<string, readonly TimedLink[]>>;
  readonly warnings: readonly TimelineCueWarning[];
}

const nameOf = (node: GraphNode): string => node.label ?? node.id;

/**
 * Every following list, planned: the end each timed cue applies, per root key, and every
 * warning — an untimed cue, a bank or preset that is not there, the planner's own skips, a
 * structural key or layer switch skipped, two lists on one key. Pure; per revision.
 */
export function planTimelineCues(document: GraphDocument, registry: NodeRegistryView): TimelineCuePlan {
  const warnings: TimelineCueWarning[] = [];
  /** Root node id → key → links, and which lists cover it. */
  const chains = new Map<NodeId, Map<string, TimedLink[]>>();
  /** `node.key` → the following lists that set it, name → id. */
  const coveredBy = new Map<string, Map<string, NodeId>>();

  for (const listId of Object.keys(document.nodes).sort()) {
    const listNode = document.nodes[listId];
    if (listNode === undefined || !followsTimeline(listNode)) continue;
    const listName = nameOf(listNode);
    const warn = (cue: string | null, code: string, message: string, suggestion?: string): void => {
      warnings.push({
        list: listNode.id,
        cue,
        diagnostic: { severity: "warning", code, message, nodeId: listNode.id, ...(suggestion === undefined ? {} : { suggestion }) },
      });
    };
    const parsed = parseCueList(listNode.parameters["cues"]);
    if (!parsed.ok) {
      warn(null, "cue.timeline.malformed", `Cue list "${listName}" follows the timeline, but ${parsed.reason}; it drives nothing.`, "Fix the Cues field.");
      continue;
    }
    for (const [position, cue] of parsed.list.cues.entries()) {
      const where = `Cue "${cue.name}" (${listName})`;
      if (cue.at === undefined) {
        warn(cue.name, "cue.timeline.untimed", `${where} has no At time, so the timeline skips it.`, "Give it a time, or run it from a second list that stays Live.");
        continue;
      }
      const bankId = nodeByName(document, cue.bank);
      const bankNode = bankId === undefined ? undefined : document.nodes[bankId];
      // T1505b: a look's instance named by a timed cue is skipped: this index has no component catalogue to read its presets from.
      if (bankNode === undefined || !isPresetsNode(bankNode)) {
        warn(cue.name, "cue.timeline.bank", `${where}: "${cue.bank}" is not a Presets bank in this document; the timeline skips it.`);
        continue;
      }
      const bank = parsePresetBank(bankNode.parameters["presets"]);
      const preset = bank.ok ? bank.bank.presets.find((candidate) => candidate.name === cue.preset) : undefined;
      if (preset === undefined) {
        warn(cue.name, "cue.timeline.preset", `${where}: bank "${cue.bank}" has no preset "${cue.preset}" it can read; the timeline skips it.`);
        continue;
      }
      const morph = presetMorph(cue.morph, preset, resolveParameters(bankNode, registry.get(bankNode.type)).values);
      const end = presetRecallEnd(document, registry, bankNode, preset);
      for (const said of end.diagnostics) {
        warnings.push({ list: listNode.id, cue: cue.name, diagnostic: { ...said, message: `${where}: ${said.message}`, nodeId: listNode.id } });
      }
      if (end.refused) continue;
      for (const layerId of end.layers) {
        const layer = document.nodes[layerId];
        warn(
          cue.name,
          "cue.timeline.structural",
          `${where} switches layer "${layer === undefined ? layerId : nameOf(layer)}" on or off, which a timed cue cannot do yet; that switch is skipped.`,
          "Fade the layer's Opacity instead, or switch it from a live list.",
        );
      }
      for (const [nodeName, keys] of Object.entries(end.after)) {
        const nodeId = nodeByName(document, nodeName);
        const node = nodeId === undefined ? undefined : document.nodes[nodeId];
        if (node === undefined) continue;
        const definition = registry.get(node.type);
        for (const [key, to] of Object.entries(keys)) {
          if (structuralCueKey(definition, node, key)) {
            warn(
              cue.name,
              "cue.timeline.structural",
              `${where} sets "${nodeName}.${key}", which changes what is compiled; a timed cue cannot change it yet, so it is skipped.`,
              "Set it in the document, or change it from a live list.",
            );
            continue;
          }
          const byKey = chains.get(node.id) ?? new Map<string, TimedLink[]>();
          chains.set(node.id, byKey);
          const links = byKey.get(key) ?? [];
          byKey.set(key, links);
          links.push({ at: cue.at, seconds: morph.seconds, curve: morph.curve, to, listName, position });
          const address = `${nodeName}.${key}`;
          const lists = coveredBy.get(address) ?? new Map<string, NodeId>();
          coveredBy.set(address, lists);
          lists.set(listName, listNode.id);
        }
      }
    }
  }

  for (const byKey of chains.values()) {
    for (const links of byKey.values()) {
      links.sort((a, b) => a.at - b.at || (a.listName < b.listName ? -1 : a.listName > b.listName ? 1 : 0) || a.position - b.position);
    }
  }
  // Two following lists on one key are ONE chain in time order — said on each of them.
  for (const [address, lists] of coveredBy) {
    if (lists.size < 2) continue;
    const names = [...lists.keys()].sort();
    for (const name of names) {
      const listId = lists.get(name) as NodeId;
      warnings.push({
        list: listId,
        cue: null,
        diagnostic: {
          severity: "warning",
          code: "cue.timeline.overlap",
          message: `Cue lists ${names.map((each) => `"${each}"`).join(" and ")} both follow the timeline and both set "${address}"; their cues run as one sequence, in time order.`,
          nodeId: listId,
          suggestion: "Let one list set each value, or switch one of them to Live.",
        },
      });
    }
  }
  return { chains, warnings };
}

/** The warnings about ONE list, as its surfaces (the inspector, `cue.list`) show them. */
export function timelineCueWarnings(document: GraphDocument, registry: NodeRegistryView, listId: NodeId): readonly TimelineCueWarning[] {
  const node = document.nodes[listId];
  if (node === undefined || !followsTimeline(node)) return [];
  return planTimelineCues(document, registry).warnings.filter((warning) => warning.list === listId);
}

/**
 * Where a following list IS at a playhead: the newest timed cue reached (`current`) and the
 * first not yet reached (`next`), both by frame index. A cue with no `at` is not on the
 * timeline. What `cue.list`, the inspector and the phone show in place of the stored
 * `current` / `standby`, which a timed list never writes (§V16: no document write per frame).
 */
export function timelineCuePosition(list: CueList, timeSeconds: number, rate: number): { current: string | null; next: string | null } {
  const playhead = playheadFrame(timeSeconds, rate);
  const timed = list.cues
    .map((cue, position) => ({ cue, position }))
    .filter((entry): entry is { cue: typeof entry.cue & { at: number }; position: number } => entry.cue.at !== undefined)
    .sort((a, b) => a.cue.at - b.cue.at || a.position - b.position);
  let current: string | null = null;
  let next: string | null = null;
  for (const { cue } of timed) {
    if (cueReachFrame(cue.at, rate) <= playhead) current = cue.name;
    else {
      next = cue.name;
      break;
    }
  }
  return { current, next };
}

/** One key's timeline: the slot it starts from, and its cues with their ends as THIS node holds them. */
interface FiledTimeline {
  readonly start: StoredParameter;
  readonly steps: ReadonlyArray<{ readonly at: number; readonly seconds: number; readonly curve: MorphCurve; readonly to: StoredParameter }>;
}

/**
 * The registry the planner reads at index time. The Dawn harness flattens with the PLAIN
 * node registry, which knows no component type, and the planner would then skip every key
 * of a look instance as an unknown type where the app — whose registry is component-aware —
 * applies it. The flattening's published pages (`instanceSchemas`) answer for those types,
 * so the harness and the app plan the same ends.
 */
function plannerRegistry(input: MorphIndexInput): NodeRegistryView {
  const pages = input.flattened?.instanceSchemas;
  if (pages === undefined || pages.size === 0) return input.registry;
  const byType = new Map<string, ParameterSchema>();
  for (const [nodeId, schema] of pages) {
    const node = input.document.nodes[nodeId];
    if (node !== undefined && !input.registry.has(node.type)) byType.set(node.type, schema);
  }
  if (byType.size === 0) return input.registry;
  const base = input.registry;
  const synthesized = (type: string): NodeDefinition | undefined => {
    const schema = byType.get(type);
    return schema === undefined ? undefined : ({ type, parameters: schema } as unknown as NodeDefinition);
  };
  return {
    ...base,
    has: (type) => base.has(type) || byType.has(type),
    get: (type) => base.get(type) ?? synthesized(type),
    require: (type) => base.get(type) ?? synthesized(type) ?? base.require(type),
  };
}

/** What a key that holds nothing resolves to: its declared default, as a slot a fold can start from. */
function unstored(definition: NodeDefinition | undefined, node: GraphNode, key: string): StoredParameter | undefined {
  const schema = effectiveParameterSchema(definition, node.parameters);
  const keyDefinition = schema[key] ?? componentAddressedDefinition(schema, key);
  return keyDefinition === undefined ? undefined : defaultParameterValue(keyDefinition);
}

/** The timeline half of the morph index: `null` when no list follows the timeline or none covers a key. */
export interface TimelineMorphs {
  keysOf(nodeId: string): ReadonlySet<string> | undefined;
  stepsAt(nodeId: string, key: string, frame: FrameEvaluationInput): readonly ParameterMorphStep[] | undefined;
}

/**
 * The timeline cues, FILED where they resolve: on the root node itself, and through every
 * published fan-out into a component (`publishedTargets`), each end travelling as what
 * flattening wrote. Called by `buildMorphIndex` and nowhere else.
 */
export function buildTimelineCueIndex(input: MorphIndexInput): TimelineMorphs | null {
  if (!hasTimelineCueLists(input.document)) return null;
  const registry = plannerRegistry(input);
  const plan = planTimelineCues(input.document, registry);
  if (plan.chains.size === 0) return null;
  const graph = input.flattened?.graph ?? input.document;

  const filed = new Map<NodeId, Map<string, FiledTimeline>>();
  const file = (nodeId: NodeId, key: string, timeline: FiledTimeline): void => {
    const byKey = filed.get(nodeId) ?? new Map<string, FiledTimeline>();
    filed.set(nodeId, byKey);
    byKey.set(key, timeline);
  };
  /** A key with no in-between cuts at its cue: the same links, every one of zero length. */
  const steps = (links: readonly TimedLink[], blends: boolean, to: (link: TimedLink) => StoredParameter | undefined): FiledTimeline["steps"] | null => {
    const out: Array<FiledTimeline["steps"][number]> = [];
    for (const link of links) {
      const end = to(link);
      if (end === undefined) return null;
      out.push({ at: link.at, seconds: blends ? link.seconds : 0, curve: link.curve, to: end });
    }
    return out;
  };

  for (const [nodeId, byKey] of plan.chains) {
    const rootNode = input.document.nodes[nodeId];
    if (rootNode === undefined) continue;
    const rootDefinition = registry.get(rootNode.type);
    for (const [key, links] of byKey) {
      const start = rootNode.parameters[key] ?? unstored(rootDefinition, rootNode, key);
      if (start === undefined) continue;
      const flatNode = graph.nodes[nodeId];
      if (flatNode !== undefined && flatNode.type === rootNode.type && !structuralCueKey(registry.get(flatNode.type), flatNode, key)) {
        const filedSteps = steps(links, morphableKey(registry.get(flatNode.type), flatNode, key), (link) => link.to);
        if (filedSteps !== null) file(nodeId, key, { start, steps: filedSteps });
      }
      const accepts = (definition: NodeDefinition | undefined, node: GraphNode, targetKey: string): boolean =>
        definition !== undefined && !structuralCueKey(definition, node, targetKey);
      for (const target of publishedTargets({ ...input, registry }, rootNode, key, accepts)) {
        const targetStart = target.end(start);
        if (targetStart === undefined) continue;
        const filedSteps = steps(links, morphableKey(target.definition, target.node, target.key), (link) => target.end(link.to));
        if (filedSteps !== null) file(target.nodeId, target.key, { start: targetStart, steps: filedSteps });
      }
    }
  }
  if (filed.size === 0) return null;

  const keys = new Map<NodeId, ReadonlySet<string>>();
  for (const [nodeId, byKey] of filed) keys.set(nodeId, new Set(byKey.keys()));

  return {
    keysOf: (nodeId) => keys.get(nodeId),
    stepsAt(nodeId, key, frame) {
      const timeline = filed.get(nodeId)?.get(key);
      if (timeline === undefined) return undefined;
      const rate = timelineRate(frame);
      const playhead = playheadFrame(frame.timeSeconds, rate);
      // In `at` order, so the reached cues are a prefix.
      let reached = 0;
      while (reached < timeline.steps.length && cueReachFrame((timeline.steps[reached] as FiledTimeline["steps"][number]).at, rate) <= playhead) {
        reached += 1;
      }
      // Before its first cue the key is not the timeline's: the stored slot, or a live fade.
      if (reached === 0) return undefined;
      const progress = (step: FiledTimeline["steps"][number]): number =>
        step.seconds > 0 ? Math.min(1, Math.max(0, (frame.timeSeconds - step.at) / step.seconds)) : 1;
      // The newest FINISHED cue ends every older one; the fold starts from its end.
      let finished = -1;
      for (let index = reached - 1; index >= 0; index -= 1) {
        if (progress(timeline.steps[index] as FiledTimeline["steps"][number]) >= 1) {
          finished = index;
          break;
        }
      }
      let from = finished >= 0 ? (timeline.steps[finished] as FiledTimeline["steps"][number]).to : timeline.start;
      if (finished === reached - 1) return [{ from, to: from, progress: 1, timed: true }];
      const out: ParameterMorphStep[] = [];
      for (let index = finished + 1; index < reached; index += 1) {
        const step = timeline.steps[index] as FiledTimeline["steps"][number];
        out.push({ from, to: step.to, progress: easeMorph(step.curve, progress(step)), timed: true });
        from = step.to;
      }
      return out;
    },
  };
}

/**
 * The recall morphs with the timeline on top: on a key a following list covers, from its
 * first cue on, the timeline's steps; everywhere else, the recall chain unchanged. While a
 * timeline covers anything, every frame is active — a cue's cut must render on its frame
 * even in a document that is otherwise still (idle-skip, the design doc §2.4).
 */
export function withTimelineCues(recall: ParameterMorphs, timeline: TimelineMorphs | null): ParameterMorphs {
  if (timeline === null) return recall;
  const union = new Map<string, ReadonlySet<string> | undefined>();
  return {
    keysOf(nodeId) {
      if (union.has(nodeId)) return union.get(nodeId);
      const a = recall.keysOf(nodeId);
      const b = timeline.keysOf(nodeId);
      const keys = a === undefined ? b : b === undefined ? a : new Set([...a, ...b]);
      union.set(nodeId, keys);
      return keys;
    },
    stepsAt: (nodeId, key, frame) => timeline.stepsAt(nodeId, key, frame) ?? recall.stepsAt(nodeId, key, frame),
    activeAt: () => true,
  };
}
