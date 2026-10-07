import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId, Revision } from "../types/ids.ts";
import type { CommandContext, CommandOutcome, LoomBus } from "../commands/bus.ts";
import { applyGraphPatch } from "../commands/apply-patch.ts";
import { idInput } from "../commands/input-schema.ts";
import { z } from "zod";
import { nodeByName } from "../graph/names.ts";
import { parsePresetBank, serializePresetBank, type Preset } from "./bank.ts";
import { CUE_LIST_NODE_TYPE, parseCueList } from "./cue-list.ts";
import { commitPageBank, componentWriteNote, presetCatalogueOf, requireBank } from "./commands.ts";
import { isPresetsNode } from "./bank-view.ts";

/**
 * T1502b (§T1398b S7) — `preset.delete`: one preset out of a bank, as one patch.
 *
 * §T1496b landed Store and Recall and left Delete to the surfaces that need it (the
 * inspector's bank section, §T1501b, and the agent's `delete_preset`, this row). It is the
 * same kind of edit Store is: the bank's `presets` parameter rewritten without the entry,
 * through `applyGraphPatch`, so it is one revision, one undo group and one audit entry
 * under `preset.delete` and whoever asked — and one undo brings the preset back whole.
 *
 * ## What it does not touch
 *
 * Only the entry. The bank's `current` stays: it is "the preset recalled last", and the
 * values that recall wrote are still on screen. A cue or a shot that names the deleted
 * preset is ruling 4's case at the moment it fires — a GO is refused naming it
 * (`cue.preset.missing`), a shot skips it with a warning (`preset.recalls.unknown`) — so
 * nothing here rewrites another node's text.
 *
 * T1527b: but it SAYS so, now rather than mid-show. A delete that leaves a cue or a shot
 * naming the preset is still applied (the delete is what was asked for, and one undo takes
 * it back), with one warning per cue list or bank that still names it, naming each cue
 * and each shot (`stillNamedBy`).
 *
 * A name the bank does not hold is REFUSED, naming the presets it does hold: "deleted"
 * with nothing removed would be a lie in the audit log (the recall's rule, §4.4).
 *
 * In its own file, registered by one line in `createDomainBus`, because `commands.ts` was
 * being edited for the inspector's Delete at the same time. T1505b reconciled the bank
 * lookup: it is `requireBank`, so the refusals are Store's and Recall's word for word.
 *
 * ## On a look's instance (T1505b, owner's ruling)
 *
 * Delete on an instance bank is the reverse of its Store: the preset leaves the COMPONENT'S
 * page bank, for every instance, with no root undo (a component edit has none). Cues and
 * shots that name ANY instance of that component are warned about, since every one lost it.
 */

declare module "../types/commands.ts" {
  interface CommandMap {
    "preset.delete": { input: PresetDeleteInput; output: PresetDeleteOutput };
  }
}

export const PRESET_DELETE_COMMAND = "preset.delete";

export interface PresetDeleteInput {
  /** The bank node. */
  nodeId: NodeId;
  /** The preset to remove. */
  name: string;
}

/** §T1556b: THE definition; the agent's `delete_preset` extends it with `dryRun`. */
export const presetDeleteInputSchema = z.object({ nodeId: idInput, name: z.string().min(1) }).strict();

export interface PresetDeleteOutput {
  ok: boolean;
  /** The preset removed, or `null` on a refusal. */
  preset: string | null;
  /** The bank's preset names after the command, in button order; as they stood on a refusal. */
  remaining: readonly string[];
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

const quoted = (names: readonly string[]): string => names.map((name) => `"${name}"`).join(", ");

/**
 * T1527b — WHO STILL NAMES `preset` OF `bank` once it is gone: one warning per cue list
 * whose cues name it and per bank whose shots recall it, each naming the cues or shots.
 * Names resolve as GO and the recall planner resolve them (`nodeByName`), so a warning is
 * given exactly where a GO would be refused or a shot would skip it. `remaining` is the
 * bank's own presets after the delete: a shot in the same bank can recall it too.
 */
function stillNamedBy(
  graph: GraphDocument,
  bank: GraphNode,
  preset: string,
  remaining: readonly Preset[],
  holders: ReadonlySet<string> = new Set([bank.id]),
): RuntimeDiagnostic[] {
  const bankName = bank.label ?? bank.id;
  const isThisBank = (name: string): boolean => {
    const nodeId = nodeByName(graph, name);
    return nodeId !== undefined && holders.has(nodeId);
  };
  const warnings: RuntimeDiagnostic[] = [];
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId] as GraphNode;
    const where = node.label ?? node.id;
    if (node.type === CUE_LIST_NODE_TYPE) {
      const parsed = parseCueList(node.parameters["cues"]);
      const cues = parsed.ok ? parsed.list.cues.filter((cue) => cue.preset === preset && isThisBank(cue.bank)).map((cue) => cue.name) : [];
      if (cues.length === 0) continue;
      const one = cues.length === 1;
      warnings.push(
        diagnostic(
          "preset.delete.cued",
          `Cue list "${where}": ${one ? "cue" : "cues"} ${quoted(cues)} still ${one ? "names" : "name"} "${preset}" (${bankName}), which is gone; GO on ${one ? "it" : "them"} will be refused.`,
          node.id,
          "Point those cues at another preset, or undo the delete.",
          "warning",
        ),
      );
    } else if (isPresetsNode(node)) {
      const parsed = node.id === bank.id ? { ok: true as const, bank: { presets: remaining } } : parsePresetBank(node.parameters["presets"]);
      const shots = parsed.ok
        ? parsed.bank.presets
            .filter((each) => (each.recalls ?? []).some((recall) => recall.preset === preset && isThisBank(recall.bank)))
            .map((each) => each.name)
        : [];
      if (shots.length === 0) continue;
      const one = shots.length === 1;
      warnings.push(
        diagnostic(
          "preset.delete.recalled",
          `Bank "${where}": ${one ? "preset" : "presets"} ${quoted(shots)} still ${one ? "recalls" : "recall"} "${preset}" (${bankName}), which is gone; recalling ${one ? "it" : "them"} will skip it.`,
          node.id,
          "Take that entry out of their recalls, or undo the delete.",
          "warning",
        ),
      );
    }
  }
  return warnings;
}

/** A context whose `apply` always opens a fresh undo group (§V34 "unless explicitly split"). */
function splitUndoContext(context: CommandContext): CommandContext {
  return { ...context, apply: (request) => context.apply({ ...request, splitUndo: true }) };
}

function refusal(revision: Revision, diagnostics: RuntimeDiagnostic[], remaining: readonly string[] = []): CommandOutcome<PresetDeleteOutput> {
  return { status: "rejected", revision, diagnostics, output: { ok: false, preset: null, remaining } };
}

export function registerPresetDeleteCommand(bus: LoomBus): void {
  if (bus.hasCommand(PRESET_DELETE_COMMAND)) return;

  bus.registerCommand({
    name: PRESET_DELETE_COMMAND,
    inSession: "definition",
    inputSchema: presetDeleteInputSchema,
    description: "Delete one preset from a bank, as one patch and one undo step (§T1502b).",
    handler: (input, context) => {
      const revision = context.store.getRevision();
      const catalogue = presetCatalogueOf(bus);
      const found = requireBank(context.graph, input?.nodeId, catalogue);
      if (!found.ok) return refusal(revision, [found.diagnostic]);
      const { view } = found;
      const node = view.holder;
      const bankName = node.label ?? node.id;
      const parsed = { bank: found.bank };
      const names = parsed.bank.presets.map((preset) => preset.name);
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!names.includes(name)) {
        return refusal(
          revision,
          [
            diagnostic(
              "preset.delete.unknown",
              `Bank "${bankName}" has no preset "${name}"; nothing was deleted.`,
              node.id,
              names.length === 0 ? "The bank is empty." : `Its presets: ${names.join(", ")}.`,
            ),
          ],
          names,
        );
      }
      const presets = parsed.bank.presets.filter((preset) => preset.name !== name);
      if (view.kind === "instance" && catalogue !== undefined) {
        const written = commitPageBank(context, catalogue, view, presets);
        if (!written.ok) return refusal(revision, written.diagnostics, names);
        // Every instance of the component lost it: a cue naming any of them is warned about.
        const holders = new Set(Object.values(context.graph.nodes).filter((each) => each.type === node.type).map((each) => each.id));
        return {
          status: written.status,
          revision,
          diagnostics: [
            ...written.diagnostics,
            componentWriteNote(view, `Deleted "${name}" from`),
            ...stillNamedBy(context.graph, node, name, presets, holders),
          ],
          output: { ok: true, preset: name, remaining: presets.map((preset) => preset.name) },
        };
      }
      const outcome = applyGraphPatch(
        {
          baseRevision: context.graph.revision,
          label: `Delete "${name}" (${bankName})`,
          operations: [{ op: "setParameters", nodeId: node.id, parameters: { presets: serializePresetBank({ version: 1, presets }) } }],
        },
        splitUndoContext(context),
      );
      const ok = outcome.status === "applied" || outcome.status === "validated";
      return {
        status: outcome.status,
        revision: outcome.revision ?? revision,
        diagnostics: [...(outcome.diagnostics ?? []), ...(ok ? stillNamedBy(context.graph, node, name, presets) : [])],
        ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
        output: { ok, preset: ok ? name : null, remaining: ok ? presets.map((preset) => preset.name) : names },
      };
    },
    rejectionOutput: () => ({ ok: false, preset: null, remaining: [] }),
  });
}
