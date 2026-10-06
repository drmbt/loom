import type { GraphComponentDefinition } from "../types/components.ts";
import type { GraphNode } from "../types/graph.ts";
import type { ParameterDefinition } from "../types/parameters.ts";
import type { ComponentRegistry } from "../components/registry.ts";
import type { ComponentHost } from "../components/commands.ts";
import { sharedForDocument, type CommandHolder } from "../commands/command-holder.ts";
import { parseComponentNodeType } from "../components/component-type.ts";
import { PRESETS_NODE_TYPE, parsePresetTargets } from "./bank.ts";
import { EMPTY_MORPH_RECORDS_JSON, parseMorphRecords, renameRecordsNode, type MorphRecord } from "./morph.ts";

/**
 * T1505b — A BANK, AS EVERYTHING OUTSIDE IT SEES ONE: a Presets node, or a component
 * instance whose definition holds a PAGE BANK (the design doc
 * `docs/presets-followups-design-2026-10-03.md` §1.2).
 *
 * ## The model in one sentence
 *
 * The preset LIST lives in the definition, so it travels with the component; the STATE
 * (`current`, the fades in flight) lives on each instance, so it is per-instance and
 * undoable; and from the outside the instance IS the bank — a cue, a shot, a Panel, the
 * phone and an agent name `city`, exactly as they name a bank today.
 *
 * ## Why one view, and why it owns the type test
 *
 * Before this row thirteen product files asked `node.type === "presets"`, and any site that
 * kept asking would silently ignore an instance bank. So the question is asked HERE, once
 * (`isPresetsNode`), and every site that needs "is this a bank, and where are its presets,
 * its settings and its state" asks `bankOf`. `bank-view.test.ts` greps the source tree for
 * a bare type test anywhere else and fails, naming the file.
 *
 * ## A page bank (§1.2 Q1, Q2)
 *
 * An ordinary `presets` node inside a definition is a page bank when EVERY token of its
 * Targets is `parent` (the enclosing instance's whole published page) or `parent.<key>`
 * (one published key) — §V81's spelling. Its presets hold `{ parent: { key: value } }`,
 * so a rename can never break them. Any other bank inside a definition is what it was: an
 * authoring tool for the internals, used in the definition session with that session's
 * undo. One page bank per definition in v1 (owner's ruling): the first by node id is used,
 * and `validateComponentDefinition` warns, naming both, when there is a second.
 */

/** The reserved word a page bank's targets and values use for the enclosing instance. */
export const PAGE_TARGET = "parent";

/** T1505b §1.2 Q3: the instance's own `current` and fades, added to its synthesized page. */
export const PRESET_CURRENT_KEY = "presetCurrent";
export const PRESET_MORPHS_KEY = "presetMorphs";
export const PRESET_STATE_KEYS: ReadonlySet<string> = new Set([PRESET_CURRENT_KEY, PRESET_MORPHS_KEY]);

/** The two parameters an instance of a definition with a page bank carries (§1.2 Q3). */
export const PRESET_STATE_PARAMETERS: Readonly<Record<string, ParameterDefinition>> = {
  [PRESET_CURRENT_KEY]: {
    type: "string",
    label: "Preset",
    default: "",
    description: "The look's preset recalled last on THIS instance. Written by Recall.",
  },
  [PRESET_MORPHS_KEY]: {
    type: "code",
    language: "json",
    label: "Preset morphs",
    default: EMPTY_MORPH_RECORDS_JSON,
    description: "The fades this instance's presets have running, keyed by parent. Written by Recall; read by the renderer.",
  },
};

/** THE type test for a bank node. Nothing else in `src/` compares a type with `PRESETS_NODE_TYPE`. */
export function isPresetsNode(node: { readonly type: string } | undefined): boolean {
  return node !== undefined && node.type === PRESETS_NODE_TYPE;
}

/** Is this bank's every target `parent` or `parent.<key>`? (§1.2 Q1.) An empty Targets is not. */
export function isPageBank(node: GraphNode | undefined): boolean {
  if (node === undefined || !isPresetsNode(node)) return false;
  const targets = parsePresetTargets(node.parameters["targets"]);
  return targets.length > 0 && targets.every((target) => target.node === PAGE_TARGET);
}

/** Every page bank in a definition's graph, by node id; the FIRST is the one used (§1.2 Q1). */
export function pageBanksOf(definition: Pick<GraphComponentDefinition, "graph">): GraphNode[] {
  return Object.keys(definition.graph.nodes)
    .sort()
    .map((nodeId) => definition.graph.nodes[nodeId])
    .filter((node): node is GraphNode => isPageBank(node));
}

/** The definition's page bank, or `undefined` when it has none. */
export function pageBankOf(definition: Pick<GraphComponentDefinition, "graph">): GraphNode | undefined {
  return pageBanksOf(definition)[0];
}

/**
 * The component catalogue as the preset commands see it, attached per bus by whoever owns
 * the catalogue (`registerComponentCommands`) — the clipboard's arrangement (§T1493b). A
 * bus with none attached (the headless MCP twin) refuses an instance bank by name.
 * `host` is the component a session bus edits, or null at the root.
 */
export interface PresetCatalogue {
  readonly components: ComponentRegistry;
  readonly host: ComponentHost | null;
}

/**
 * The per-bus holder (`command-holder.ts`, §T719), so a re-executed module keeps it.
 * §T1695b: per DOCUMENT, not per app: `host` is the component THIS bus edits, so a session's
 * holder is its own and never the root's.
 */
export function presetCatalogueHolderFor(bus: object): CommandHolder<PresetCatalogue> {
  return sharedForDocument<CommandHolder<PresetCatalogue>>(bus, "presets.catalogue", () => ({ current: null }));
}

/**
 * T1541b — the one lookup `bankOf` needs from a catalogue: a definition by id and version.
 * What the surfaces that are not command handlers (a Panel board, the layout model, the
 * morph index) hand in, from the holder or from the flattening's own registry.
 */
export type BankCatalogue = Pick<ComponentRegistry, "get">;

/** A bank as the outside sees it. */
export interface BankView {
  /** `node`: a Presets node. `instance`: a component instance whose definition has a page bank. */
  readonly kind: "node" | "instance";
  /** The node commands name, cues and Panels name, and that holds `current` and the fades. */
  readonly holder: GraphNode;
  /** Where the presets, Targets and the bank's settings (Select, Morph, Curve) are read: the bank, or the page bank. */
  readonly bank: GraphNode;
  /** The key on `holder` that says which preset was recalled last. */
  readonly currentKey: string;
  /** The key on `holder` that holds the fades in flight. */
  readonly morphsKey: string;
  /** The definition the presets live in, for an instance bank. */
  readonly definition?: GraphComponentDefinition;
}

/**
 * Why `bankOf` has no view: not a bank at all, or an instance this bus cannot see inside
 * (no catalogue attached, or a definition that is not installed), or one whose definition
 * holds no page bank.
 */
export type BankLookup =
  | { readonly ok: true; readonly view: BankView }
  | { readonly ok: false; readonly why: "notBank" | "noCatalogue" | "notInstalled" | "noPageBank" };

/**
 * T1505b — THE ONE ANSWER TO "IS THIS A BANK": the node itself when it is a Presets node,
 * the instance with its definition's page bank when it is a component instance. `catalogue`
 * is the component registry, or `undefined` on a bus that has none.
 */
export function bankOf(node: GraphNode | undefined, catalogue: Pick<ComponentRegistry, "get"> | undefined): BankLookup {
  if (node === undefined) return { ok: false, why: "notBank" };
  if (isPresetsNode(node)) return { ok: true, view: { kind: "node", holder: node, bank: node, currentKey: "current", morphsKey: "morphs" } };
  const ref = parseComponentNodeType(node.type);
  if (ref === null) return { ok: false, why: "notBank" };
  if (catalogue === undefined) return { ok: false, why: "noCatalogue" };
  const definition = catalogue.get(ref.componentId, ref.version);
  if (definition === undefined) return { ok: false, why: "notInstalled" };
  const bank = pageBankOf(definition);
  if (bank === undefined) return { ok: false, why: "noPageBank" };
  return {
    ok: true,
    view: { kind: "instance", holder: node, bank, currentKey: PRESET_CURRENT_KEY, morphsKey: PRESET_MORPHS_KEY, definition },
  };
}

/** The view, or `undefined` for anything that is not a bank this catalogue can see. */
export function bankViewOf(node: GraphNode | undefined, catalogue: Pick<ComponentRegistry, "get"> | undefined): BankView | undefined {
  const found = bankOf(node, catalogue);
  return found.ok ? found.view : undefined;
}

/**
 * The definition with its page bank's `presets` replaced — what Store and Delete on an
 * instance register (owner's ruling: the component is written, every instance gets it).
 */
export function withPageBankPresets(definition: GraphComponentDefinition, bank: GraphNode, presets: string): GraphComponentDefinition {
  return {
    ...definition,
    graph: {
      ...definition.graph,
      nodes: { ...definition.graph.nodes, [bank.id]: { ...bank, parameters: { ...bank.parameters, presets } } },
    },
  };
}

/**
 * The fades a holder keeps, under the names everything else reads them by: an instance's
 * `parent` is its own name here (the same mapping `bankMorphRecords` makes for the index).
 */
export function heldMorphRecords(view: BankView): MorphRecord[] {
  const records = parseMorphRecords(view.holder.parameters[view.morphsKey]);
  return view.kind === "instance" ? renameRecordsNode(records, PAGE_TARGET, view.holder.label ?? view.holder.id) : records;
}
