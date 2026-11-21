import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId, Revision } from "../types/ids.ts";
import type { GraphPatchOperation } from "../types/patch.ts";
import type { StoredParameter } from "../types/parameters.ts";
import type { CommandContext, CommandOutcome, LoomBus } from "../commands/bus.ts";
import { applyGraphPatch } from "../commands/apply-patch.ts";
import { idInput } from "../commands/input-schema.ts";
import { z } from "zod";
import { nodeByName } from "../graph/names.ts";
import { isPresetName, parsePresetBank, serializePresetBank, type Preset } from "./bank.ts";
import { CUE_LIST_NODE_TYPE, parseCueList, serializeCueList } from "./cue-list.ts";
import { parseMorphRecords, serializeMorphRecords } from "./morph.ts";
import { presetCatalogueOf, requireBank } from "./commands.ts";
import { isPresetsNode } from "./bank-view.ts";

/**
 * VN152 (upstream §T1648b) — `preset.rename`: one preset of a bank renamed, as ONE patch.
 *
 * A preset's name is an ADDRESS: a cue names it (`cue.bank` + `cue.preset`), a shot names it
 * (`recalls[].preset`), the bank's Select names it for the Recall pulse, and the bank's
 * `current` and its fades in flight name it for the strip's lit button and its "fading in"
 * mark. Delete (§T1527b) leaves those alone and WARNS, because after a delete there is no
 * right answer to rewrite them to. A rename has one: the new name. So rename REWRITES every
 * reference it can resolve, in the same patch as the bank, and one undo puts all of it back.
 * The result lists each rewrite in an `info` diagnostic (`preset.rename.rewrote`), so nothing
 * moved silently.
 *
 * What it can resolve is what GO and the recall planner resolve: a cue or a shot whose bank
 * NAME (`nodeByName`) is this bank, in the root graph — the scope §T1527b's warnings walk.
 * Select and `current` are rewritten only when they hold the old name as a plain string; a
 * Select driven by an expression is the author's text, and nothing here edits text.
 *
 * ## Refused, by name
 *
 * - the old name is not in the bank (`preset.rename.unknown`, naming what it holds);
 * - the new name is not an identifier (`preset.name`, Store's rule and Store's sentence);
 * - the new name is the old one (`preset.rename.same`), or another preset's
 *   (`preset.rename.taken`) — a rename never merges two presets;
 * - the bank is a look's instance (`preset.rename.instance`). Its presets live in the
 *   COMPONENT, and a component edit has no root undo (§T1505b), while the instances' `current`
 *   and the cues that name them are root state with one. Half the rename undoable and half
 *   not is the worst of both, so the rename is done where the presets are: inside the
 *   component, on its page bank, where it is an ordinary undoable rename.
 */

declare module "../types/commands.ts" {
  interface CommandMap {
    "preset.rename": { input: PresetRenameInput; output: PresetRenameOutput };
  }
}

export const PRESET_RENAME_COMMAND = "preset.rename";

export interface PresetRenameInput {
  /** The bank node. */
  nodeId: NodeId;
  /** The preset to rename. */
  name: string;
  /** Its new name: an identifier no other preset of the bank holds. */
  to: string;
}

/** THE definition; the agent's `rename_preset` extends it with `dryRun`. */
export const presetRenameInputSchema = z.object({ nodeId: idInput, name: z.string().min(1), to: z.string().min(1) }).strict();

export interface PresetRenameOutput {
  ok: boolean;
  /** The preset's name after the command: the new one, or `null` on a refusal. */
  preset: string | null;
  /** The bank's preset names after the command, in button order; as they stood on a refusal. */
  presets: readonly string[];
  /** Every reference rewritten, as `<node>.<what>` (`set.cue c1`, `looks.select`, `shots.preset night`). */
  rewrote: readonly string[];
}

function diagnostic(
  code: string,
  message: string,
  nodeId?: NodeId,
  suggestion?: string,
  severity: RuntimeDiagnostic["severity"] = "error",
): RuntimeDiagnostic {
  return {
    severity,
    code,
    message,
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(suggestion === undefined ? {} : { suggestion }),
  };
}

const plain = (stored: unknown): string | null => (typeof stored === "string" ? stored.trim() : null);

/** A context whose `apply` always opens a fresh undo group (§V34 "unless explicitly split"). */
function splitUndoContext(context: CommandContext): CommandContext {
  return { ...context, apply: (request) => context.apply({ ...request, splitUndo: true }) };
}

function refusal(revision: Revision, diagnostics: RuntimeDiagnostic[], presets: readonly string[] = []): CommandOutcome<PresetRenameOutput> {
  return { status: "rejected", revision, diagnostics, output: { ok: false, preset: null, presets, rewrote: [] } };
}

/** A shot's recalls with `from` of this bank renamed; `null` when it names none. */
function renamedShot(preset: Preset, isThisBank: (name: string) => boolean, from: string, to: string): Preset | null {
  const recalls = preset.recalls;
  if (recalls === undefined || !recalls.some((recall) => recall.preset === from && isThisBank(recall.bank))) return null;
  return { ...preset, recalls: recalls.map((recall) => (recall.preset === from && isThisBank(recall.bank) ? { ...recall, preset: to } : recall)) };
}

/**
 * The patch: the bank's own presets (the entry, and its own shots that recall it), its Select,
 * `current` and fades, then every other bank's shots and every cue list's cues that name it.
 */
function renameOperations(
  graph: GraphDocument,
  bank: GraphNode,
  presets: readonly Preset[],
  from: string,
  to: string,
): { operations: GraphPatchOperation[]; rewrote: string[] } {
  const bankName = bank.label ?? bank.id;
  const isThisBank = (name: string): boolean => nodeByName(graph, name) === bank.id;
  const rewrote: string[] = [];

  const own = presets.map((preset) => {
    const named = preset.name === from ? { ...preset, name: to } : preset;
    const shot = renamedShot(named, isThisBank, from, to);
    if (shot !== null) rewrote.push(`${bankName}.preset ${named.name}`);
    return shot ?? named;
  });
  const parameters: Record<string, StoredParameter> = { presets: serializePresetBank({ version: 1, presets: own }) };
  for (const key of ["select", "current"] as const) {
    if (plain(bank.parameters[key]) === from) {
      parameters[key] = to;
      rewrote.push(`${bankName}.${key}`);
    }
  }
  const morphs = parseMorphRecords(bank.parameters["morphs"]);
  if (morphs.some((record) => record.preset === from)) {
    parameters["morphs"] = serializeMorphRecords(morphs.map((record) => (record.preset === from ? { ...record, preset: to } : record)));
  }
  const operations: GraphPatchOperation[] = [{ op: "setParameters", nodeId: bank.id, parameters }];

  for (const nodeId of Object.keys(graph.nodes).sort()) {
    if (nodeId === bank.id) continue;
    const node = graph.nodes[nodeId] as GraphNode;
    const where = node.label ?? node.id;
    if (node.type === CUE_LIST_NODE_TYPE) {
      const parsed = parseCueList(node.parameters["cues"]);
      if (!parsed.ok) continue;
      const named = (cue: { bank: string; preset: string }): boolean => cue.preset === from && isThisBank(cue.bank);
      const cues = parsed.list.cues.filter(named).map((cue) => cue.name);
      if (cues.length === 0) continue;
      const list = { ...parsed.list, cues: parsed.list.cues.map((cue) => (named(cue) ? { ...cue, preset: to } : cue)) };
      operations.push({ op: "setParameters", nodeId, parameters: { cues: serializeCueList(list) } });
      rewrote.push(...cues.map((cue) => `${where}.cue ${cue}`));
    } else if (isPresetsNode(node)) {
      const parsed = parsePresetBank(node.parameters["presets"]);
      if (!parsed.ok) continue;
      let changed = false;
      const next = parsed.bank.presets.map((preset) => {
        const shot = renamedShot(preset, isThisBank, from, to);
        if (shot === null) return preset;
        changed = true;
        rewrote.push(`${where}.preset ${preset.name}`);
        return shot;
      });
      if (changed) operations.push({ op: "setParameters", nodeId, parameters: { presets: serializePresetBank({ ...parsed.bank, presets: next }) } });
    }
  }
  return { operations, rewrote };
}

/**
 * Whether a rename would be refused, and why — the command's own checks, for a surface that
 * greys a row or validates a field before it dispatches. `null`: it would go ahead.
 */
export function presetRenameRefusal(
  graph: GraphDocument,
  input: { nodeId: unknown; name: unknown; to: unknown },
  catalogue?: Parameters<typeof requireBank>[2],
): RuntimeDiagnostic | null {
  const found = requireBank(graph, input.nodeId, catalogue);
  if (!found.ok) return found.diagnostic;
  const node = found.view.holder;
  const bankName = node.label ?? node.id;
  if (found.view.kind === "instance") {
    return diagnostic(
      "preset.rename.instance",
      `Bank "${bankName}" is a look's instance; its presets are its component's, and a component edit has no undo. Nothing was renamed.`,
      node.id,
      "Rename the preset inside the component, on its page bank.",
    );
  }
  const names = found.bank.presets.map((preset) => preset.name);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!names.includes(name)) {
    return diagnostic(
      "preset.rename.unknown",
      `Bank "${bankName}" has no preset "${name}"; nothing was renamed.`,
      node.id,
      names.length === 0 ? "The bank is empty." : `Its presets: ${names.join(", ")}.`,
    );
  }
  const to = typeof input.to === "string" ? input.to.trim() : "";
  if (!isPresetName(to)) {
    return diagnostic("preset.name", "A preset name must be an identifier: letters, digits and _, not starting with a digit.", node.id);
  }
  if (to === name) return diagnostic("preset.rename.same", `"${name}" is already called that; nothing was renamed.`, node.id);
  if (names.includes(to)) {
    return diagnostic("preset.rename.taken", `Bank "${bankName}" already has a preset "${to}"; nothing was renamed.`, node.id, "Pick a name no other preset of the bank holds, or delete that one first.");
  }
  return null;
}

export function registerPresetRenameCommand(bus: LoomBus): void {
  if (bus.hasCommand(PRESET_RENAME_COMMAND)) return;

  bus.registerCommand({
    name: PRESET_RENAME_COMMAND,
    inSession: "definition",
    inputSchema: presetRenameInputSchema,
    description:
      "Rename one preset of a bank, and every cue, shot, Select and lit button that names it, as one patch and one undo step (VN152, §T1648b).",
    handler: (input, context) => {
      const revision = context.store.getRevision();
      const catalogue = presetCatalogueOf(bus);
      const refused = presetRenameRefusal(context.graph, input, catalogue);
      const found = requireBank(context.graph, input?.nodeId, catalogue);
      const names = found.ok ? found.bank.presets.map((preset) => preset.name) : [];
      if (refused !== null || !found.ok) return refusal(revision, refused === null ? [] : [refused], names);
      const node = found.view.holder;
      const from = input.name.trim();
      const to = input.to.trim();
      const { operations, rewrote } = renameOperations(context.graph, node, found.bank.presets, from, to);
      const outcome = applyGraphPatch(
        { baseRevision: context.graph.revision, label: `Rename "${from}" to "${to}" (${node.label ?? node.id})`, operations },
        splitUndoContext(context),
      );
      const ok = outcome.status === "applied" || outcome.status === "validated";
      const after = names.map((name) => (name === from ? to : name));
      return {
        status: outcome.status,
        revision: outcome.revision ?? revision,
        diagnostics: [
          ...(outcome.diagnostics ?? []),
          ...(ok && rewrote.length > 0
            ? [diagnostic("preset.rename.rewrote", `Renamed "${from}" to "${to}" in: ${rewrote.join(", ")}.`, node.id, undefined, "info")]
            : []),
        ],
        ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
        output: { ok, preset: ok ? to : null, presets: ok ? after : names, rewrote: ok ? rewrote : [] },
      };
    },
    rejectionOutput: () => ({ ok: false, preset: null, presets: [], rewrote: [] }),
  });
}
