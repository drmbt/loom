import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphComponentDefinition } from "../types/components.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId, Revision } from "../types/ids.ts";
import type { StoredParameter } from "../types/parameters.ts";
import type { GraphPatchOperation } from "../types/patch.ts";
import type { CommandContext, CommandOutcome, LoomBus } from "../commands/bus.ts";
import { applyGraphPatch } from "../commands/apply-patch.ts";
import { idInput } from "../commands/input-schema.ts";
import { z } from "zod";
import { nodeByName, rewriteNodeNameReferences, uniqueNodeName } from "../graph/names.ts";
import { parseComponentNodeType } from "../components/component-type.ts";
import { PRESETS_NODE_TYPE, parsePresetBank, parsePresetTargets, serializePresetBank, type Preset } from "./bank.ts";
import { CUE_LIST_NODE_TYPE } from "./cue-list.ts";
import { parseMorphRecords, renameRecordsNode, serializeMorphRecords } from "./morph.ts";
import { PAGE_TARGET, PRESET_CURRENT_KEY, PRESET_MORPHS_KEY, isPageBank, isPresetsNode, pageBankOf, withPageBankPresets } from "./bank-view.ts";
import { presetCatalogueOf } from "./commands.ts";

/**
 * T1505b §1.2 Q8 — `preset.moveIntoComponent`: a bank BESIDE a look's instance becomes the
 * look's own page bank, explicitly. Ruling 8's bank beside the instance stays a first-class
 * choice (owner's ruling: no automatic migration); this is the one command that moves it.
 *
 * ## When it applies
 *
 * Every target and every preset value of the bank names ONE component instance and nothing
 * else — no `on`, no `recalls`, no other node. Anything else is refused, naming what stays
 * beside: a bank spanning several looks is exactly what a bank beside them is for.
 *
 * ## What it writes: one definition write and ONE root patch
 *
 *  - The DEFINITION: the presets, keyed `parent`, go into the component's page bank — a
 *    new Presets node targeting `parent` (or `parent.<key>`), or merged by name into the
 *    page bank it already has, where a name both hold is refused rather than guessed.
 *    Like every component edit it has no root undo.
 *  - The ROOT patch: the bank is removed, its `current` and fades are copied onto the
 *    instance (`presetCurrent`, `presetMorphs`), and every cue, shot and Panel item that
 *    named the bank names the instance. One revision, one undo group. Undoing it brings
 *    the bank back; the component keeps its copy of the presets, which does no harm.
 */

declare module "../types/commands.ts" {
  interface CommandMap {
    "preset.moveIntoComponent": { input: PresetMoveInput; output: PresetMoveOutput };
  }
}

export const PRESET_MOVE_INTO_COMPONENT_COMMAND = "preset.moveIntoComponent";

export interface PresetMoveInput {
  /** The bank beside the instance. */
  nodeId: NodeId;
}

export interface PresetMoveOutput {
  ok: boolean;
  /** The instance that is now the bank, by id. */
  instance: NodeId | null;
  /** The presets that moved, in bank order. */
  moved: readonly string[];
}

function refusalDiagnostic(code: string, message: string, nodeId?: NodeId, suggestion?: string): RuntimeDiagnostic {
  return { severity: "error", code, message, ...(nodeId === undefined ? {} : { nodeId }), ...(suggestion === undefined ? {} : { suggestion }) };
}

function refusal(revision: Revision, diagnostics: RuntimeDiagnostic[]): CommandOutcome<PresetMoveOutput> {
  return { status: "rejected", revision, diagnostics, output: { ok: false, instance: null, moved: [] } };
}

const quoted = (names: readonly string[]): string => names.map((name) => `"${name}"`).join(", ");

/** The one instance a bank's targets and values name, or the names that are not it. */
function soleInstance(graph: GraphDocument, bank: GraphNode, presets: readonly Preset[]): { instance: GraphNode } | { stays: string[] } | { none: true } {
  const names = new Set<string>();
  const stays: string[] = [];
  for (const target of parsePresetTargets(bank.parameters["targets"])) names.add(target.node);
  for (const preset of presets) {
    for (const name of Object.keys(preset.values)) names.add(name);
    for (const layer of Object.keys(preset.on ?? {})) stays.push(`${preset.name}: on ${layer}`);
    for (const recall of preset.recalls ?? []) stays.push(`${preset.name}: recalls ${recall.bank}.${recall.preset}`);
  }
  const instances = [...names].filter((name) => {
    const nodeId = nodeByName(graph, name);
    const node = nodeId === undefined ? undefined : graph.nodes[nodeId];
    return node !== undefined && parseComponentNodeType(node.type) !== null;
  });
  if (instances.length === 0 && stays.length === 0) return { none: true };
  stays.push(...[...names].filter((name) => !instances.includes(name) || instances.length > 1));
  if (instances.length !== 1 || stays.length > 0) return { stays: [...new Set(stays)] };
  const instanceId = nodeByName(graph, instances[0] as string) as NodeId;
  return { instance: graph.nodes[instanceId] as GraphNode };
}

/** A preset with its instance's name read as `parent`, as a page bank holds it. */
const toParent = (preset: Preset, instance: string): Preset => ({
  ...preset,
  values: Object.fromEntries(Object.entries(preset.values).map(([name, keys]) => [name === instance ? PAGE_TARGET : name, keys])),
});

/** The definition with the moved presets in its page bank: merged into the one it has, or a new one. */
function definitionWithBank(
  definition: GraphComponentDefinition,
  bank: GraphNode,
  presets: readonly Preset[],
  instance: string,
  newId: string,
): { ok: true; next: GraphComponentDefinition } | { ok: false; clash: string[] } {
  const targets = parsePresetTargets(bank.parameters["targets"])
    .map((target) => (target.key === undefined ? PAGE_TARGET : `${PAGE_TARGET}.${target.key}`))
    .join(" ");
  const moved = presets.map((preset) => toParent(preset, instance));
  const existing = pageBankOf(definition);
  if (existing !== undefined) {
    const parsed = parsePresetBank(existing.parameters["presets"]);
    const held = parsed.ok ? parsed.bank.presets : [];
    const clash = moved.filter((preset) => held.some((each) => each.name === preset.name)).map((preset) => preset.name);
    if (clash.length > 0) return { ok: false, clash };
    return { ok: true, next: withPageBankPresets(definition, existing, serializePresetBank({ version: 1, presets: [...held, ...moved] })) };
  }
  const nodes = Object.values(definition.graph.nodes);
  const below = nodes.reduce((bottom, each) => Math.max(bottom, each.position.y), Number.NEGATIVE_INFINITY);
  const left = nodes.reduce((edge, each) => Math.min(edge, each.position.x), Number.POSITIVE_INFINITY);
  // The bank's own settings travel with it; its per-instance state does not (it goes onto the instance).
  const settings: Record<string, StoredParameter> = {};
  for (const key of ["select", "morph", "curve"]) {
    const stored = bank.parameters[key];
    if (stored !== undefined) settings[key] = stored;
  }
  const node: GraphNode = {
    id: newId,
    type: PRESETS_NODE_TYPE,
    label: uniqueNodeName(definition.graph, "presets"),
    definitionVersion: 1,
    position: { x: Number.isFinite(left) ? left : 0, y: Number.isFinite(below) ? below + 200 : 0 },
    parameters: { ...settings, targets, presets: serializePresetBank({ version: 1, presets: moved }) },
  };
  return { ok: true, next: { ...definition, graph: { ...definition.graph, nodes: { ...definition.graph.nodes, [newId]: node } } } };
}

/**
 * The operations that point every cue, shot and Panel item naming `from` at `to` — the
 * rename clauses' own rewrite (`names.ts`), applied to a copy and kept only for the three
 * kinds that name a BANK (a cue list's cues, a bank's shots, a Panel's board).
 */
function retarget(graph: GraphDocument, from: string, to: string, skip: NodeId): GraphPatchOperation[] {
  const copy = structuredClone(graph) as GraphDocument;
  rewriteNodeNameReferences(copy, from, to);
  const keyOf: Readonly<Record<string, string>> = { [CUE_LIST_NODE_TYPE]: "cues", [PRESETS_NODE_TYPE]: "presets", panel: "board" };
  const operations: GraphPatchOperation[] = [];
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const before = graph.nodes[nodeId];
    const after = copy.nodes[nodeId];
    const key = before === undefined ? undefined : keyOf[before.type];
    if (nodeId === skip || before === undefined || after === undefined || key === undefined) continue;
    if (JSON.stringify(before.parameters[key]) === JSON.stringify(after.parameters[key])) continue;
    operations.push({ op: "setParameters", nodeId, parameters: { [key]: after.parameters[key] as StoredParameter } });
  }
  return operations;
}

export function registerPresetMoveCommand(bus: LoomBus): void {
  if (bus.hasCommand(PRESET_MOVE_INTO_COMPONENT_COMMAND)) return;

  bus.registerCommand({
    name: PRESET_MOVE_INTO_COMPONENT_COMMAND,
    inputSchema: z.object({ nodeId: idInput }).strict(),
    description:
      "Move a Presets bank that targets one component instance INTO that component: its presets become the component's own (for every instance, travelling with it), and the instance becomes the bank its cues and Panels name (§T1505b).",
    handler: (input, context: CommandContext) => {
      const revision = context.store.getRevision();
      const catalogue = presetCatalogueOf(bus);
      const nodeId: unknown = input?.nodeId;
      const bank = typeof nodeId === "string" ? context.graph.nodes[nodeId] : undefined;
      if (bank === undefined) return refusal(revision, [refusalDiagnostic("preset.bank.missing", typeof nodeId === "string" ? `No node "${nodeId}".` : "No bank node was named.")]);
      const bankName = bank.label ?? bank.id;
      if (!isPresetsNode(bank) || isPageBank(bank)) {
        return refusal(revision, [refusalDiagnostic("preset.bank.type", `"${bankName}" is not a Presets bank beside a component instance.`, bank.id)]);
      }
      if (catalogue === undefined) {
        return refusal(revision, [
          refusalDiagnostic("preset.bank.noCatalogue", `Moving "${bankName}" writes a component, and this surface has no component catalogue; nothing was changed.`, bank.id),
        ]);
      }
      const parsed = parsePresetBank(bank.parameters["presets"]);
      if (!parsed.ok) return refusal(revision, [refusalDiagnostic("preset.bank.malformed", `Bank "${bankName}": ${parsed.reason}.`, bank.id)]);
      const presets = parsed.bank.presets;
      const sole = soleInstance(context.graph, bank, presets);
      if ("none" in sole) {
        return refusal(revision, [
          refusalDiagnostic("preset.move.noInstance", `Bank "${bankName}" names no component instance, so there is no component to move it into.`, bank.id),
        ]);
      }
      if ("stays" in sole) {
        return refusal(revision, [
          refusalDiagnostic(
            "preset.move.notOneLook",
            `Bank "${bankName}" reaches more than one look's page: ${quoted(sole.stays)} would stay beside, so nothing was moved.`,
            bank.id,
            "A bank that spans several looks is the right tool beside them; move one only when it targets a single instance.",
          ),
        ]);
      }
      const { instance } = sole;
      const instanceName = instance.label as string;
      const ref = parseComponentNodeType(instance.type);
      const definition = ref === null ? undefined : catalogue.components.get(ref.componentId, ref.version);
      if (definition === undefined) {
        return refusal(revision, [refusalDiagnostic("preset.bank.notInstalled", `"${instanceName}" is an instance of a component that is not installed; nothing was moved.`, instance.id)]);
      }
      const planned = definitionWithBank(definition, bank, presets, instanceName, context.ids.node());
      if (!planned.ok) {
        return refusal(revision, [
          refusalDiagnostic(
            "preset.move.clash",
            `Component "${definition.name}" already holds ${quoted(planned.clash)}; nothing was moved.`,
            bank.id,
            "Rename those presets in the bank first.",
          ),
        ]);
      }
      const problems = catalogue.components.validate(planned.next);
      if (problems.some((each) => each.severity === "error")) return refusal(revision, problems);

      // The instance carries the bank's state, keyed `parent` as an instance holds it.
      const morphs = renameRecordsNode(parseMorphRecords(bank.parameters["morphs"]), instanceName, PAGE_TARGET);
      const current = bank.parameters["current"];
      const operations: GraphPatchOperation[] = [
        ...retarget(context.graph, bankName, instanceName, bank.id),
        { op: "removeNodes", nodeIds: [bank.id] },
      ];
      // Validated against the manifest the moved bank gives the instance, so register first
      // (a dry run checks against the definition as planned and registers nothing).
      const previous = definition;
      if (!context.dryRun) catalogue.components.register(planned.next);
      operations.push({
        op: "setParameters",
        nodeId: instance.id,
        parameters: {
          [PRESET_CURRENT_KEY]: typeof current === "string" ? current : "",
          [PRESET_MORPHS_KEY]: serializeMorphRecords(morphs),
        },
      });
      const outcome = context.dryRun
        ? { status: "validated" as const, revision, diagnostics: [] as RuntimeDiagnostic[] }
        : applyGraphPatch(
            { baseRevision: context.graph.revision, label: `Move "${bankName}" into "${definition.name}"`, operations },
            { ...context, apply: (request) => context.apply({ ...request, splitUndo: true }) },
          );
      const ok = outcome.status === "applied" || outcome.status === "validated";
      // The document refused: the component goes back to what it was, so nothing half-moved.
      if (!ok && !context.dryRun) catalogue.components.register(previous);
      return {
        status: outcome.status,
        revision: outcome.revision ?? revision,
        diagnostics: [
          ...problems,
          ...(outcome.diagnostics ?? []),
          ...(ok
            ? [
                {
                  severity: "info" as const,
                  code: "preset.component.written",
                  message: `Moved ${String(presets.length)} preset(s) of "${bankName}" into component "${definition.name}": every instance has them, and "${instanceName}" is the bank its cues and Panels name. Undo brings "${bankName}" back; the component keeps its copy.`,
                  nodeId: instance.id,
                },
              ]
            : []),
        ],
        ...("undoGroupId" in outcome && outcome.undoGroupId !== undefined ? { undoGroupId: outcome.undoGroupId } : {}),
        output: { ok, instance: ok ? instance.id : null, moved: ok ? presets.map((preset) => preset.name) : [] },
      };
    },
    rejectionOutput: () => ({ ok: false, instance: null, moved: [] }),
  });
}
