import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { FrameClock } from "../types/frame.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId, Revision } from "../types/ids.ts";
import type { ParameterDefinition, ParameterSchema, StoredParameter } from "../types/parameters.ts";
import type { GraphPatchOperation } from "../types/patch.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import type { CommandContext, CommandOutcome, LoomBus } from "../commands/bus.ts";
import { applyGraphPatch } from "../commands/apply-patch.ts";
import { nodeByName } from "../graph/names.ts";
import { effectiveParameterSchema, resolveParameters } from "../parameters/resolve.ts";
import {
  componentAddressedDefinition,
  componentNamesFor,
  isComponentKeyOf,
  isParameterSlot,
  parseComponentKey,
  storedStaticValue,
} from "../parameters/slots.ts";
import { defaultParameterValue, validateParameters } from "../parameters/validate.ts";
import {
  MORPH_CURVES,
  PRESETS_NODE_TYPE,
  isPresetName,
  parsePresetBank,
  parsePresetTargets,
  serializePresetBank,
  type MorphCurve,
  type MorphSpec,
  type Preset,
  type PresetBank,
  type PresetTarget,
  type PresetValues,
} from "./bank.ts";
import {
  MAX_MORPH_RECORDS,
  morphRunning,
  nextMorphRecords,
  parseMorphRecords,
  sameStored,
  serializeMorphRecords,
  type MorphRecord,
} from "./morph.ts";
import { bankMorphRecords } from "./morph-index.ts";

/**
 * T1496b (§T1398b S1) — `preset.store` and `preset.recall`: a bank's Store captures its
 * declared targets as whole slots, and its Recall writes them back as ONE patch.
 *
 * ## One recall is one patch (the design doc §4.4)
 *
 * Every target, and the bank's own `current`, go into ONE `GraphPatch` applied through
 * `applyGraphPatch` — so the recall is one revision, one undo group and one audit entry
 * under the name `preset.recall` and the invoking actor, and one undo puts every target
 * back. Per-node writes would be N undo steps and a half-recalled look after the first
 * undo. `splitUndo` keeps it its own group even inside a caller's transaction: a Panel
 * gesture's coalescing must not swallow a recall into a slider drag.
 *
 * ## Skip what is gone, refuse only when nothing is left (ruling 4)
 *
 * A bank outlives its targets: a node gets deleted, a component's page loses a key, a
 * hand-edited value stops fitting. Each such entry is SKIPPED with a warning that names
 * it (`glow`, `glow.radius`), and the rest applies. Only a recall that would change no
 * target at all is refused — "recalled" with nothing moved would be a lie in the audit
 * log. Validation is the same one `setParameters` runs (the node's EFFECTIVE schema, so a
 * component instance's published page and a customWgsl's reflected controls count, §T903),
 * checked per key BEFORE the patch is built, so one bad value cannot abort the others.
 *
 * ## The whole slot (ruling 2)
 *
 * A preset holds a key's STORED form: a bare value, or the whole slot with its mode and
 * every retained binding, so an expression comes back as that expression. A bare value
 * written over a slot would, through `setParameters`, only update the slot's retained
 * static (§B166) and leave an expression in effect — so a recall writes it as a
 * static-mode slot instead, keeping the slot's other bindings (§V108: never destructive).
 *
 * ## A morph commits the END state, and a record beside it (T1497b, the design doc §5)
 *
 * A recall with a non-zero morph writes exactly the values a cut writes — the document
 * holds the destination from that moment, so the inspector, Store, a save, the phone and
 * undo all see it — plus ONE record in the bank's `morphs` parameter, in the SAME patch:
 * where each changed key came from, the absolute clock's reading at the recall, the
 * duration and the curve. The fade is the resolver's business (`resolve.ts`, through
 * `morph-index.ts`), a pure function of the document and the frame; nothing here runs per
 * frame, and one undo takes the record away together with the values, so the screen cuts
 * back. Which morph applies is §5.1's precedence: the recall's own `morph`, else the
 * preset's, else the bank's `morph` / `curve` parameters.
 *
 * The handler reads NO clock (§V44). `context.frameClock` is the last frame the app's
 * transport produced, attached to the bus the way the channel resolver is; a bus with no
 * app has none, and a morph asked for there commits as a cut and says so
 * (`preset.recall.morphUnavailable`) — the values land either way.
 *
 * ## A shot: other banks' presets, in the same patch (T1499b, the design doc §8.1)
 *
 * A preset's `recalls` name other banks' presets. The planner EXPANDS them depth-first
 * and lays every preset's values into one map before it resolves a single name, so a shot
 * is still one patch — one revision, one undo, one audit entry — however many banks it
 * reaches, and its morph is still ONE record, in the recalled bank, over every key the
 * shot changed. What is laid later wins: a preset's recalls in the order written, then
 * the preset's OWN values over all of them (ruling 14). The same holds at every level, so
 * the shot itself always has the last word. A nested preset's own `morph` is not read:
 * the shot is the recall, and §5.1's ladder is about the recall.
 *
 * A CYCLE is refused, naming the banks on it, and so is a nesting deeper than
 * `MAX_RECALL_DEPTH`: both are mistakes in the bank's text, not targets that went away,
 * so nothing is written rather than a guess at where to stop. A recall that names a bank
 * or a preset that is NOT THERE is ruling 4's case instead — skipped with a warning that
 * names it, and the rest applies.
 *
 * Each nested bank a preset actually wrote something from gets its `current` in the same
 * patch: `current` is "the last preset recalled", and a Panel beside the shots bank would
 * otherwise go on highlighting the look the shot just replaced.
 *
 * ## Layer on/off (T1498b's seam, the design doc §4.4 step 5 and §7.2)
 *
 * A preset's `on` map is written as `setNodeUi { bypassed: !on }` on each named Layer, in
 * the same patch, so a layer's on/off is undone with the rest of the recall. Always a cut
 * — it is structural. Only a Layer: the doc's `on` is "layer on/off", and bypassing an
 * arbitrary node from a bank is not something it rules in.
 *
 * ## The seam the cue list uses
 *
 * `planPresetRecall` is THE recall planner: the cue list's GO (§T1500b) runs it with the
 * cue's morph and adds its own `current`/`standby` to the same patch.
 */

declare module "../types/commands.ts" {
  interface CommandMap {
    "preset.store": { input: PresetStoreInput; output: PresetStoreOutput };
    "preset.recall": { input: PresetRecallInput; output: PresetRecallOutput };
  }
}

export const PRESET_STORE_COMMAND = "preset.store";
export const PRESET_RECALL_COMMAND = "preset.recall";

/**
 * T1497b — THE PULSE-FIRED COMMANDS A RENDER MUST NOT FIRE (the design doc §5.4).
 *
 * A take renders the document AS SAVED. Most pulses are part of that picture: a
 * Feedback's reset on `frame % 120 == 0` is a deterministic function of the frame and
 * touches no document, so the take fires it exactly as playback does. A RECALL is not —
 * it EDITS the document, so a `recall` pulse on a beat expression would rewrite the
 * project in the middle of its own export, and the second export of the same file would
 * start from a different document than the first. A live performance is not re-performed
 * by a render (T467); timeline-placed cues, which an export WOULD reproduce, are §T1508b.
 *
 * Named here, by the commands that own the behaviour, and read by the app's pulse watcher
 * (`src/app/pulse-firing.ts`). The cue list's `cue.go` / `cue.back` (§T1500b) join it.
 */
export const RENDER_BLOCKED_PULSE_COMMANDS: ReadonlySet<string> = new Set([PRESET_RECALL_COMMAND]);

export interface PresetStoreInput {
  /** The bank node. */
  nodeId: NodeId;
  /** The preset to write. An existing name is overwritten in place, keeping its position. */
  name: string;
}

export interface PresetStoreOutput {
  ok: boolean;
  preset: string | null;
  /** How many parameter keys the preset now holds. */
  captured: number;
  /** Every target token Store could not capture (a missing node, an unknown key). */
  missing: readonly string[];
}

export interface PresetRecallInput {
  /** The bank node. */
  nodeId: NodeId;
  /** The preset to recall. Absent: the bank's resolved `select`. */
  name?: string;
  /**
   * T1497b: how THIS recall is carried out, overriding the preset's and the bank's morph
   * (the design doc §5.1). `seconds: 0` is a cut whatever the preset says.
   */
  morph?: MorphSpec;
}

export interface PresetRecallOutput {
  ok: boolean;
  preset: string | null;
  /** `node.key` for every value written, and `layer.on` for every layer switched (T1499b). */
  applied: readonly string[];
  /** `node` or `node.key` for every entry skipped, each with a warning in `diagnostics`. */
  skipped: readonly string[];
  /**
   * T1497b: the morph the screen is now doing, or `null` when the recall was a cut — asked
   * for as one, nothing left to fade, or no frame clock attached (headless), which
   * `diagnostics` then names.
   */
  morph: MorphSpec | null;
}

function diagnostic(
  severity: RuntimeDiagnostic["severity"],
  code: string,
  message: string,
  nodeId?: NodeId,
  suggestion?: string,
): RuntimeDiagnostic {
  return {
    severity,
    code,
    message,
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(suggestion === undefined ? {} : { suggestion }),
  };
}

/** The name a bank goes by in a message: its label, else its id. */
function bankName(node: GraphNode): string {
  return node.label ?? node.id;
}

/** The bank node, or the refusal that says why `nodeId` is not one. */
function requireBank(
  graph: GraphDocument,
  nodeId: unknown,
): { ok: true; node: GraphNode; bank: PresetBank } | { ok: false; diagnostic: RuntimeDiagnostic } {
  if (typeof nodeId !== "string") {
    return { ok: false, diagnostic: diagnostic("error", "preset.bank.missing", "No bank node was named.") };
  }
  const node = graph.nodes[nodeId];
  if (node === undefined) {
    return { ok: false, diagnostic: diagnostic("error", "preset.bank.missing", `No node "${nodeId}".`) };
  }
  if (node.type !== PRESETS_NODE_TYPE) {
    return {
      ok: false,
      diagnostic: diagnostic("error", "preset.bank.type", `"${bankName(node)}" is a ${node.type} node, not a Presets bank.`, node.id),
    };
  }
  const parsed = parsePresetBank(node.parameters["presets"]);
  if (!parsed.ok) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "error",
        "preset.bank.malformed",
        `Bank "${bankName(node)}": ${parsed.reason}.`,
        node.id,
        "Fix the Presets field in the inspector; nothing was changed.",
      ),
    };
  }
  return { ok: true, node, bank: parsed.bank };
}

/** A parameter's definition by key, component keys (`color.r`, §V113) included. */
function definitionFor(schema: ParameterSchema, key: string): ParameterDefinition | undefined {
  return schema[key] ?? componentAddressedDefinition(schema, key);
}

/**
 * What a key holds when nothing is stored for it — written into the preset so a recall
 * RESETS it (the design doc §4.3). A component key with nothing of its own follows its
 * compound, so it captures the compound's static component rather than the manifest's.
 */
function unstoredValue(node: GraphNode, schema: ParameterSchema, key: string, definition: ParameterDefinition): StoredParameter {
  const parsed = parseComponentKey(key);
  const base = parsed === null || schema[key] !== undefined ? undefined : schema[parsed.base];
  if (parsed !== null && base !== undefined) {
    const tuple = storedStaticValue(node.parameters[parsed.base]);
    const index = componentNamesFor(base)?.indexOf(parsed.component) ?? -1;
    const component = Array.isArray(tuple) && index >= 0 ? tuple[index] : undefined;
    if (typeof component === "number") return component;
  }
  return defaultParameterValue(definition);
}

/** A stored value, detached from the (frozen) document it was read from. */
function copied(stored: StoredParameter): StoredParameter {
  return JSON.parse(JSON.stringify(stored)) as StoredParameter;
}

export interface PresetCapture {
  readonly values: PresetValues;
  readonly captured: number;
  /** Target tokens (or `node.key`) that could not be captured. */
  readonly missing: readonly string[];
  readonly diagnostics: readonly RuntimeDiagnostic[];
}

/**
 * Store's capture (the design doc §4.3, ruling 3): every non-pulse parameter of a whole
 * target — a component instance's published page, since that IS its effective schema —
 * or just the named `node.key`, each AS STORED (a slot stays a slot, ruling 2).
 */
export function capturePresetValues(
  graph: GraphDocument,
  registry: NodeRegistryView,
  bankNodeId: NodeId,
  targets: readonly PresetTarget[],
): PresetCapture {
  const values: Record<string, Record<string, StoredParameter>> = {};
  const missing: string[] = [];
  const diagnostics: RuntimeDiagnostic[] = [];
  const skip = (name: string, code: string, message: string, nodeId?: NodeId): void => {
    missing.push(name);
    diagnostics.push(diagnostic("warning", code, message, nodeId));
  };

  for (const target of targets) {
    const nodeId = nodeByName(graph, target.node);
    const node = nodeId === undefined ? undefined : graph.nodes[nodeId];
    if (node === undefined) {
      skip(target.token, "preset.target.missing", `Target "${target.token}": no node is named "${target.node}".`);
      continue;
    }
    if (node.id === bankNodeId) {
      skip(target.token, "preset.target.self", `Target "${target.token}" is the bank itself; a bank does not store its own presets.`, node.id);
      continue;
    }
    const definition = registry.get(node.type);
    if (definition === undefined) {
      skip(target.token, "preset.target.unknownType", `Target "${target.token}" is a ${node.type} node this build does not know.`, node.id);
      continue;
    }
    const schema = effectiveParameterSchema(definition, node.parameters);
    const record = (values[target.node] ??= {});
    if (target.key !== undefined) {
      const keyDefinition = definitionFor(schema, target.key);
      if (keyDefinition === undefined || keyDefinition.type === "pulse") {
        skip(target.token, "preset.target.key", `Target "${target.token}": "${target.node}" has no storable parameter "${target.key}".`, node.id);
        continue;
      }
      const stored = node.parameters[target.key];
      record[target.key] = stored === undefined ? unstoredValue(node, schema, target.key, keyDefinition) : copied(stored);
      continue;
    }
    for (const [key, keyDefinition] of Object.entries(schema)) {
      if (keyDefinition.type === "pulse") continue;
      const stored = node.parameters[key];
      record[key] = stored === undefined ? defaultParameterValue(keyDefinition) : copied(stored);
    }
    // A compound stored per component (§V113) is part of "every parameter" too.
    for (const key of Object.keys(node.parameters).sort()) {
      const stored = node.parameters[key];
      if (stored !== undefined && schema[key] === undefined && isComponentKeyOf(schema, key)) record[key] = copied(stored);
    }
  }

  for (const name of Object.keys(values)) {
    if (Object.keys(values[name] ?? {}).length === 0) delete values[name];
  }
  const captured = Object.values(values).reduce((sum, record) => sum + Object.keys(record).length, 0);
  return { values, captured, missing, diagnostics };
}

export interface PresetRecallPlan {
  /**
   * One `setParameters` per target node, one `setNodeUi` per layer switched, then the
   * bank's `current` (with its `morphs` when they changed), then every other bank the
   * recall touched: a nested bank's `current` (T1499b), a bank whose records lost keys.
   * Empty when nothing applies.
   */
  readonly operations: readonly GraphPatchOperation[];
  /** `node.key` for every value written, and `layer.on` for every layer switched. */
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly diagnostics: readonly RuntimeDiagnostic[];
  /** T1497b: the morph a record was written for, or `null` when this recall is a cut. */
  readonly morph: MorphSpec | null;
  /**
   * T1499b: the preset's `recalls` cannot be expanded at all (a cycle, or nested too
   * deep). `operations` and `applied` are empty and `diagnostics` holds the error that
   * names why — so a caller that refuses on "nothing applied" already refuses this.
   */
  readonly refused: boolean;
}

export interface PresetRecallPlanOptions {
  /**
   * T1497b: the morph this recall is carried out with, ALREADY DECIDED by §5.1's precedence
   * (`presetMorph`). Absent, or zero seconds, is a cut.
   */
  readonly morph?: MorphSpec | undefined;
  /** The app's frame clock (`CommandContext.frameClock`). Absent = no app; a morph cuts. */
  readonly clock?: FrameClock | undefined;
}

/**
 * The value a recall writes for one key. A slot goes back verbatim; a bare value over a
 * SLOT becomes that slot in static mode, or `setParameters` would keep the slot's mode
 * and the recall would leave an expression in effect (§B166's merge, working as meant).
 */
function recallValue(existing: StoredParameter | undefined, stored: StoredParameter): StoredParameter {
  if (isParameterSlot(stored) || !isParameterSlot(existing)) return stored;
  return { mode: "static", bindings: { ...existing.bindings, static: { kind: "static", value: stored } } };
}

/**
 * T1499b — HOW DEEP A SHOT'S `recalls` MAY NEST (ruling 14: "depth 4"). The recalled
 * preset is depth 0 and each `recalls` hop is one deeper, so a shot may reach four banks
 * down a chain and a fifth hop is refused.
 */
export const MAX_RECALL_DEPTH = 4;

/** The node type a preset's `on` switches: `layerNode.type` (`src/nodes/definitions/layer.ts`). */
const LAYER_NODE_TYPE = "layer";

/** One preset on a recall's expansion, and how many `recalls` hops it sits from the recalled one. */
interface RecallStep {
  readonly bank: GraphNode;
  readonly preset: Preset;
  readonly depth: number;
}

/** A value on the merged map, and the preset that had the last word on it. */
interface Laid<T> {
  readonly value: T;
  readonly from: RecallStep;
}

/** How a message names the preset an entry came from: the recalled one bare, a nested one with its bank. */
function said(step: RecallStep): string {
  return step.depth === 0 ? `Preset "${step.preset.name}"` : `Preset "${step.preset.name}" (${bankName(step.bank)})`;
}

const quotedList = (names: readonly string[]): string =>
  names.length < 2 ? `"${names[0] ?? ""}"` : `${names.slice(0, -1).map((name) => `"${name}"`).join(", ")} and "${names.at(-1) ?? ""}"`;

/**
 * T1499b — a preset's `recalls`, expanded depth-first (the design doc §4.4 step 2) into
 * the order their values are LAID: a preset's recalls first, in the order written, then
 * the preset itself, so the recalled preset comes last and its own values win.
 *
 * A cycle or a chain deeper than `MAX_RECALL_DEPTH` returns the refusal instead. A cycle
 * is the same (bank, preset) pair met again on the path that led to it — two presets of
 * one bank on a chain is not one, and ends.
 */
function expandRecalls(
  graph: GraphDocument,
  top: RecallStep,
  skip: (name: string, code: string, message: string, nodeId?: NodeId) => void,
): { ok: true; steps: readonly RecallStep[] } | { ok: false; diagnostic: RuntimeDiagnostic } {
  const steps: RecallStep[] = [];
  const path: RecallStep[] = [];
  const spelled = (chain: readonly RecallStep[]): string => chain.map((step) => `${bankName(step.bank)}.${step.preset.name}`).join(" → ");
  const recalling = `Recalling "${top.preset.name}" (${bankName(top.bank)})`;

  const visit = (step: RecallStep): RuntimeDiagnostic | null => {
    path.push(step);
    for (const recall of step.preset.recalls ?? []) {
      const entry = `${recall.bank}.${recall.preset}`;
      const asks = `${said(step)} recalls "${recall.preset}" from "${recall.bank}"`;
      const bankId = nodeByName(graph, recall.bank);
      const bank = bankId === undefined ? undefined : graph.nodes[bankId];
      if (bank === undefined) {
        skip(entry, "preset.recalls.missing", `${asks}, and no node is named "${recall.bank}"; skipped.`, step.bank.id);
        continue;
      }
      if (bank.type !== PRESETS_NODE_TYPE) {
        skip(entry, "preset.recalls.type", `${asks}, and "${recall.bank}" is a ${bank.type} node, not a Presets bank; skipped.`, bank.id);
        continue;
      }
      const parsed = parsePresetBank(bank.parameters["presets"]);
      if (!parsed.ok) {
        skip(entry, "preset.recalls.malformed", `${asks}, and bank "${recall.bank}" cannot be read (${parsed.reason}); skipped.`, bank.id);
        continue;
      }
      const preset = parsed.bank.presets.find((candidate) => candidate.name === recall.preset);
      if (preset === undefined) {
        skip(entry, "preset.recalls.unknown", `${asks}, and bank "${recall.bank}" has no preset "${recall.preset}"; skipped.`, bank.id);
        continue;
      }
      const next: RecallStep = { bank, preset, depth: step.depth + 1 };
      const loop = path.findIndex((on) => on.bank.id === bank.id && on.preset.name === preset.name);
      if (loop >= 0) {
        const cycle = [...path.slice(loop), next];
        const banks = [...new Set(cycle.map((on) => bankName(on.bank)))];
        return diagnostic(
          "error",
          "preset.recall.cycle",
          `${recalling} goes round in a circle: ${spelled(cycle)}. ${
            banks.length === 1 ? `Bank ${quotedList(banks)} recalls itself` : `Banks ${quotedList(banks)} recall each other`
          }; nothing was changed.`,
          step.bank.id,
          "Take one of those recalls out of the Presets field.",
        );
      }
      if (next.depth > MAX_RECALL_DEPTH) {
        return diagnostic(
          "error",
          "preset.recall.depth",
          `${recalling} nests its recalls ${String(next.depth)} deep (${spelled([...path, next])}); the limit is ${String(MAX_RECALL_DEPTH)}. Nothing was changed.`,
          step.bank.id,
          "Recall the deeper presets from the shot itself.",
        );
      }
      const refusal = visit(next);
      if (refusal !== null) return refusal;
    }
    path.pop();
    steps.push(step);
    return null;
  };

  const refusal = visit(top);
  return refusal === null ? { ok: true, steps } : { ok: false, diagnostic: refusal };
}

/**
 * THE recall planner (the design doc §4.4 steps 2, 3 and 5): expands the preset's
 * `recalls`, resolves every node name in `graph` NOW, checks each key against that node's
 * effective schema, and builds the operations for the one patch. Pure — no bus, no store —
 * so the cue list's GO (§T1500b) runs exactly this and a pad recall and a cue recall
 * cannot disagree.
 */
export function planPresetRecall(
  graph: GraphDocument,
  registry: NodeRegistryView,
  bankNode: GraphNode,
  preset: Preset,
  options: PresetRecallPlanOptions = {},
): PresetRecallPlan {
  const operations: GraphPatchOperation[] = [];
  const applied: string[] = [];
  const skipped: string[] = [];
  const diagnostics: RuntimeDiagnostic[] = [];
  /** T1497b: node NAME → key → the stored form before / after, for every key written. */
  const before: Record<string, Record<string, StoredParameter>> = {};
  const after: Record<string, Record<string, StoredParameter>> = {};
  const skip = (name: string, code: string, message: string, nodeId?: NodeId): void => {
    skipped.push(name);
    diagnostics.push(diagnostic("warning", code, message, nodeId));
  };

  const expansion = expandRecalls(graph, { bank: bankNode, preset, depth: 0 }, skip);
  if (!expansion.ok) {
    return { operations: [], applied: [], skipped, diagnostics: [...diagnostics, expansion.diagnostic], morph: null, refused: true };
  }

  /*
   * T1499b: ONE map for the whole shot, laid in expansion order, so whatever is laid later
   * wins — a nested preset under the one that recalls it, the recalled preset over all.
   * Everything below reads this map, never a preset, which is why a shot is one patch and
   * its morph one record.
   */
  const values = new Map<string, Map<string, Laid<StoredParameter>>>();
  const layers = new Map<string, Laid<boolean>>();
  for (const step of expansion.steps) {
    for (const [nodeName, record] of Object.entries(step.preset.values)) {
      if (nodeByName(graph, nodeName) === step.bank.id) {
        skip(nodeName, "preset.target.self", `${said(step)} holds values for the bank itself; they were skipped.`, step.bank.id);
        continue;
      }
      const laid = values.get(nodeName) ?? new Map<string, Laid<StoredParameter>>();
      values.set(nodeName, laid);
      for (const [key, stored] of Object.entries(record)) {
        // A compound laid over ANOTHER preset's per-component slot (`color` over `color.r`,
        // §V113) takes the channel too, or the nested value would still win it.
        for (const [other, under] of laid) {
          if (under.from !== step && parseComponentKey(other)?.base === key) laid.delete(other);
        }
        laid.set(key, { value: stored, from: step });
      }
    }
    for (const [nodeName, on] of Object.entries(step.preset.on ?? {})) layers.set(nodeName, { value: on, from: step });
  }
  /** The presets something was actually written from. */
  const wrote = new Set<RecallStep>();

  for (const nodeName of [...values.keys()].sort()) {
    const record = values.get(nodeName) ?? new Map<string, Laid<StoredParameter>>();
    /** A node-level skip is said once per preset that held values for the node. */
    const skipNode = (code: string, message: (who: string) => string, nodeId?: NodeId): void => {
      skipped.push(nodeName);
      for (const from of new Set([...record.values()].map((laid) => laid.from))) {
        diagnostics.push(diagnostic("warning", code, message(said(from)), nodeId));
      }
    };
    const nodeId = nodeByName(graph, nodeName);
    const node = nodeId === undefined ? undefined : graph.nodes[nodeId];
    if (node === undefined) {
      skipNode("preset.target.missing", (who) => `${who}: no node is named "${nodeName}"; its values were skipped.`);
      continue;
    }
    const definition = registry.get(node.type);
    if (definition === undefined) {
      skipNode("preset.target.unknownType", (who) => `${who}: "${nodeName}" is a ${node.type} node this build does not know; skipped.`, node.id);
      continue;
    }
    const schema = effectiveParameterSchema(definition, node.parameters);
    const writes: Record<string, StoredParameter> = {};
    for (const [key, laid] of [...record].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const stored = laid.value;
      const who = said(laid.from);
      const name = `${nodeName}.${key}`;
      const keyDefinition = definitionFor(schema, key);
      if (keyDefinition === undefined) {
        skip(name, "preset.target.key", `${who}: "${nodeName}" has no parameter "${key}"; skipped.`, node.id);
        continue;
      }
      if (keyDefinition.type === "pulse") {
        skip(name, "preset.target.pulse", `${who}: "${name}" is a pulse, which fires rather than holds a value; skipped.`, node.id);
        continue;
      }
      const invalid = validateParameters(schema, { [key]: stored }, node.id);
      if (invalid.length > 0) {
        skip(name, "preset.value.invalid", `${who}: the value for "${name}" does not fit it (${invalid[0]?.message ?? "invalid"}); skipped.`, node.id);
        continue;
      }
      writes[key] = recallValue(node.parameters[key], stored);
      applied.push(name);
      wrote.add(laid.from);
      // What the key holds NOW, as a slot a fade can start from: nothing stored is the
      // default Store would have captured for it (`unstoredValue`).
      (before[nodeName] ??= {})[key] = node.parameters[key] ?? unstoredValue(node, schema, key, keyDefinition);
      (after[nodeName] ??= {})[key] = writes[key] as StoredParameter;
    }
    if (Object.keys(writes).length === 0) continue;
    operations.push({ op: "setParameters", nodeId: node.id, parameters: writes });

    // A component slot (`color.r`) the preset does not cover still overrides the compound
    // it just wrote. Not skipped — nothing was refused — but said, so it is not a mystery.
    for (const key of Object.keys(node.parameters).sort()) {
      const parsed = parseComponentKey(key);
      if (parsed === null || writes[key] !== undefined || writes[parsed.base] === undefined) continue;
      if (!isComponentKeyOf(schema, key)) continue;
      diagnostics.push(
        diagnostic(
          "warning",
          "preset.recall.componentOverride",
          `Preset "${preset.name}" sets "${nodeName}.${parsed.base}", and "${nodeName}.${key}" holds its own value that still overrides that channel.`,
          node.id,
        ),
      );
    }
  }

  // Layer on/off (the design doc §4.4 step 5, §7.2): the bypass flag, in the same patch.
  for (const layerName of [...layers.keys()].sort()) {
    const laid = layers.get(layerName);
    if (laid === undefined) continue;
    const name = `${layerName}.on`;
    const nodeId = nodeByName(graph, layerName);
    const node = nodeId === undefined ? undefined : graph.nodes[nodeId];
    if (node === undefined) {
      skip(name, "preset.on.missing", `${said(laid.from)}: no node is named "${layerName}"; its on/off was skipped.`);
      continue;
    }
    if (node.type !== LAYER_NODE_TYPE) {
      skip(name, "preset.on.notLayer", `${said(laid.from)}: "${layerName}" is a ${node.type} node, and on/off switches a Layer; skipped.`, node.id);
      continue;
    }
    operations.push({ op: "setNodeUi", nodeId: node.id, ui: { bypassed: !laid.value } });
    applied.push(name);
    wrote.add(laid.from);
  }

  /*
   * T1499b: every OTHER bank a preset was actually written from shows that preset as its
   * `current`. A bank reached twice shows the later one; the recalled bank's own is below.
   */
  const elsewhere = new Map<NodeId, Record<string, StoredParameter>>();
  for (const step of expansion.steps) {
    if (step.bank.id !== bankNode.id && wrote.has(step)) elsewhere.set(step.bank.id, { current: step.preset.name });
  }

  let morph: MorphSpec | null = null;
  if (operations.length > 0) {
    const { clock } = options;
    const asked = options.morph !== undefined && options.morph.seconds > 0 ? options.morph : null;
    if (asked !== null && clock === undefined) {
      // §V338: name what would make it present. The values below land regardless.
      diagnostics.push(
        diagnostic(
          "info",
          "preset.recall.morphUnavailable",
          `Preset "${preset.name}" asks for a ${String(asked.seconds)} s morph, but no frame clock is attached here, so it was recalled as a cut.`,
          bankNode.id,
          "A morph fades on the running app's transport; a headless bus has no transport, and the end state is what it commits.",
        ),
      );
    }

    const own = parseMorphRecords(bankNode.parameters["morphs"]);
    const others = new Map(
      bankMorphRecords(graph)
        .filter((bank) => bank.bankId !== bankNode.id)
        .map((bank) => [bank.bankId, bank.records] as const),
    );
    /** A key some record is still fading: it MOVES on screen even where this recall changes nothing. */
    const moving = (nodeName: string, key: string): boolean =>
      clock !== undefined &&
      [own, ...others.values()].some((records) =>
        records.some((record) => morphRunning(record, clock) && record.to[nodeName]?.[key] !== undefined),
      );

    let record: MorphRecord | null = null;
    if (asked !== null && clock !== undefined) {
      const from: Record<string, Record<string, StoredParameter>> = {};
      const to: Record<string, Record<string, StoredParameter>> = {};
      for (const [nodeName, keys] of Object.entries(after)) {
        for (const [key, written] of Object.entries(keys)) {
          const held = before[nodeName]?.[key];
          if (held === undefined || (sameStored(held, written) && !moving(nodeName, key))) continue;
          (from[nodeName] ??= {})[key] = copied(held);
          (to[nodeName] ??= {})[key] = copied(written);
        }
      }
      if (Object.keys(to).length > 0) {
        record = { epoch: clock.epoch, start: clock.absTimeSeconds, seconds: asked.seconds, curve: asked.curve, preset: preset.name, from, to };
        morph = asked;
      }
    }

    const book = nextMorphRecords({
      own,
      others,
      clock,
      applied: Object.fromEntries(Object.entries(after).map(([nodeName, keys]) => [nodeName, Object.keys(keys)])),
      record,
    });
    for (const gone of book.dropped) {
      diagnostics.push(
        diagnostic(
          "warning",
          "preset.recall.morphDropped",
          `Bank "${bankName(bankNode)}" already had ${String(MAX_MORPH_RECORDS)} morphs running, so the oldest ("${gone.preset}") was dropped; the keys only it covered jumped to their end values.`,
          bankNode.id,
        ),
      );
    }
    const morphs = serializeMorphRecords(book.own);
    operations.push({
      op: "setParameters",
      nodeId: bankNode.id,
      // Written only when the list actually changes, so a cut on a bank with nothing
      // fading is the same one-key write it was before morphs existed.
      parameters: { current: preset.name, ...(morphs === serializeMorphRecords(own) ? {} : { morphs }) },
    });
    for (const [bankId, records] of book.others) {
      elsewhere.set(bankId, { ...elsewhere.get(bankId), morphs: serializeMorphRecords(records) });
    }
    for (const bankId of [...elsewhere.keys()].sort()) {
      operations.push({ op: "setParameters", nodeId: bankId, parameters: elsewhere.get(bankId) ?? {} });
    }
  }
  return { operations, applied, skipped, diagnostics, morph, refused: false };
}

/** The bank's own parameters, through the one read path (§V61). */
function resolvedBank(node: GraphNode, context: CommandContext): Readonly<Record<string, unknown>> {
  return resolveParameters(node, context.registry.get(node.type), {
    ...(context.channels === undefined ? {} : { channels: context.channels }),
  }).values;
}

/** A `MorphSpec` off the wire, or `null` when it is not one. */
function readMorphSpec(raw: unknown): MorphSpec | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { seconds, curve } = raw as { seconds?: unknown; curve?: unknown };
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  if (!MORPH_CURVES.includes(curve as MorphCurve)) return null;
  return { seconds, curve: curve as MorphCurve };
}

/**
 * WHICH morph a recall is carried out with (the design doc §5.1): the first present of the
 * caller's own, the preset's, the bank's `morph` / `curve` parameters. The cue list
 * (§T1500b) passes its cue's morph as `own`, which is where its rung of the ladder sits.
 */
export function presetMorph(own: MorphSpec | undefined, preset: Preset, bank: Readonly<Record<string, unknown>>): MorphSpec {
  if (own !== undefined) return own;
  if (preset.morph !== undefined) return preset.morph;
  return readMorphSpec({ seconds: bank["morph"], curve: bank["curve"] }) ?? { seconds: 0, curve: "smooth" };
}

/** A context whose `apply` always opens a fresh undo group (§V34 "unless explicitly split"). */
function splitUndoContext(context: CommandContext): CommandContext {
  return { ...context, apply: (request) => context.apply({ ...request, splitUndo: true }) };
}

/** The bank's `select`. Empty when unset or not a name. */
function resolvedSelect(bank: Readonly<Record<string, unknown>>): string {
  const select = bank["select"];
  return typeof select === "string" ? select.trim() : "";
}

function storeRefusal(revision: Revision, diagnostics: RuntimeDiagnostic[], missing: readonly string[] = []): CommandOutcome<PresetStoreOutput> {
  return { status: "rejected", revision, diagnostics, output: { ok: false, preset: null, captured: 0, missing } };
}

function recallRefusal(
  revision: Revision,
  diagnostics: RuntimeDiagnostic[],
  preset: string | null = null,
  skipped: readonly string[] = [],
): CommandOutcome<PresetRecallOutput> {
  return { status: "rejected", revision, diagnostics, output: { ok: false, preset, applied: [], skipped, morph: null } };
}

export function registerPresetCommands(bus: LoomBus): void {
  if (bus.hasCommand(PRESET_STORE_COMMAND)) return;

  bus.registerCommand({
    name: PRESET_STORE_COMMAND,
    description: "Store a bank's targets, as their whole stored slots, under a preset name (§T1496b).",
    handler: (input, context) => {
      const revision = context.store.getRevision();
      const found = requireBank(context.graph, input?.nodeId);
      if (!found.ok) return storeRefusal(revision, [found.diagnostic]);
      const { node, bank } = found;
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!isPresetName(name)) {
        return storeRefusal(revision, [
          diagnostic("error", "preset.name", "A preset name must be an identifier: letters, digits and _, not starting with a digit.", node.id),
        ]);
      }
      const targets = parsePresetTargets(node.parameters["targets"]);
      if (targets.length === 0) {
        return storeRefusal(revision, [
          diagnostic("error", "preset.store.noTargets", `Bank "${bankName(node)}" declares no targets.`, node.id, "Name nodes (or node.key) in its Targets field."),
        ]);
      }
      const capture = capturePresetValues(context.graph, context.registry, node.id, targets);
      if (capture.captured === 0) {
        return storeRefusal(
          revision,
          [
            ...capture.diagnostics,
            diagnostic("error", "preset.store.nothing", `Bank "${bankName(node)}": none of its targets could be captured, so "${name}" was not stored.`, node.id),
          ],
          capture.missing,
        );
      }
      const index = bank.presets.findIndex((preset) => preset.name === name);
      const presets =
        index < 0
          ? [...bank.presets, { name, values: capture.values }]
          : bank.presets.map((preset, at) => (at === index ? { ...preset, values: capture.values } : preset));
      const outcome = applyGraphPatch(
        {
          baseRevision: context.graph.revision,
          label: `Store "${name}" (${bankName(node)})`,
          operations: [{ op: "setParameters", nodeId: node.id, parameters: { presets: serializePresetBank({ version: 1, presets }) } }],
        },
        splitUndoContext(context),
      );
      const diagnostics = [...capture.diagnostics, ...(outcome.diagnostics ?? [])];
      const ok = outcome.status === "applied" || outcome.status === "validated";
      return {
        status: outcome.status,
        revision: outcome.revision ?? revision,
        diagnostics,
        ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
        output: { ok, preset: ok ? name : null, captured: ok ? capture.captured : 0, missing: capture.missing },
      };
    },
    rejectionOutput: () => ({ ok: false, preset: null, captured: 0, missing: [] }),
  });

  bus.registerCommand({
    name: PRESET_RECALL_COMMAND,
    description:
      "Recall a bank's preset: every target it holds written back as one patch, one undo step (§T1496b); with a morph, the end state commits at once and the screen fades to it (§T1497b). A preset's recalls (other banks' presets) and its layer on/off ride in the same patch (§T1499b).",
    handler: (input, context) => {
      const revision = context.store.getRevision();
      const found = requireBank(context.graph, input?.nodeId);
      if (!found.ok) return recallRefusal(revision, [found.diagnostic]);
      const { node, bank } = found;
      const settings = resolvedBank(node, context);
      const name = typeof input.name === "string" ? input.name.trim() : resolvedSelect(settings);
      if (name === "") {
        return recallRefusal(revision, [
          diagnostic("error", "preset.recall.noName", `Bank "${bankName(node)}": no preset was named and its Select is empty.`, node.id),
        ]);
      }
      const preset = bank.presets.find((candidate) => candidate.name === name);
      if (preset === undefined) {
        const known = bank.presets.map((candidate) => candidate.name).join(", ");
        return recallRefusal(revision, [
          diagnostic(
            "error",
            "preset.recall.unknown",
            `Bank "${bankName(node)}" has no preset "${name}".`,
            node.id,
            known === "" ? "The bank is empty; Store one first." : `Its presets: ${known}.`,
          ),
        ]);
      }
      const own = input.morph === undefined ? undefined : readMorphSpec(input.morph);
      if (own === null) {
        return recallRefusal(
          revision,
          [
            diagnostic(
              "error",
              "preset.recall.morph",
              `Bank "${bankName(node)}": the morph must be { seconds ≥ 0, curve: ${MORPH_CURVES.join(" | ")} }; nothing was changed.`,
              node.id,
            ),
          ],
          name,
        );
      }
      const plan = planPresetRecall(context.graph, context.registry, node, preset, {
        morph: presetMorph(own, preset, settings),
        clock: context.frameClock,
      });
      // T1499b: a cycle or too deep a nesting is refused by the planner, which names it.
      if (plan.refused) return recallRefusal(revision, [...plan.diagnostics], name, plan.skipped);
      if (plan.applied.length === 0) {
        // Ruling 4: refused only when NOTHING is left — and then loudly, naming why.
        return recallRefusal(
          revision,
          [
            ...plan.diagnostics,
            diagnostic("error", "preset.recall.nothing", `Preset "${name}" (${bankName(node)}) has nothing left to apply; nothing was changed.`, node.id),
          ],
          name,
          plan.skipped,
        );
      }
      const outcome = applyGraphPatch(
        { baseRevision: context.graph.revision, label: `Recall "${name}" (${bankName(node)})`, operations: [...plan.operations] },
        splitUndoContext(context),
      );
      const diagnostics = [...plan.diagnostics, ...(outcome.diagnostics ?? [])];
      const ok = outcome.status === "applied" || outcome.status === "validated";
      return {
        status: outcome.status,
        revision: outcome.revision ?? revision,
        diagnostics,
        ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
        output: { ok, preset: name, applied: ok ? plan.applied : [], skipped: plan.skipped, morph: ok ? plan.morph : null },
      };
    },
    rejectionOutput: (input) => ({ ok: false, preset: typeof input?.name === "string" ? input.name : null, applied: [], skipped: [], morph: null }),
  });
}
