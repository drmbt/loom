import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { NodeId, Revision } from "../types/ids.ts";
import type { CommandContext, CommandOutcome, LoomBus } from "../commands/bus.ts";
import { applyGraphPatch } from "../commands/apply-patch.ts";
import { PRESETS_NODE_TYPE, parsePresetBank, serializePresetBank } from "./bank.ts";

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
 * A name the bank does not hold is REFUSED, naming the presets it does hold: "deleted"
 * with nothing removed would be a lie in the audit log (the recall's rule, §4.4).
 *
 * In its own file, registered by one line in `createDomainBus`, because `commands.ts` was
 * being edited for the inspector's Delete at the same time; the bank lookup below repeats
 * `requireBank`'s three refusals word for word and should become that function when the
 * two are reconciled.
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

export interface PresetDeleteOutput {
  ok: boolean;
  /** The preset removed, or `null` on a refusal. */
  preset: string | null;
  /** The bank's preset names after the command, in button order; as they stood on a refusal. */
  remaining: readonly string[];
}

function diagnostic(code: string, message: string, nodeId?: NodeId, suggestion?: string): RuntimeDiagnostic {
  return {
    severity: "error",
    code,
    message,
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(suggestion === undefined ? {} : { suggestion }),
  };
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
    description: "Delete one preset from a bank, as one patch and one undo step (§T1502b).",
    handler: (input, context) => {
      const revision = context.store.getRevision();
      const nodeId: unknown = input?.nodeId;
      if (typeof nodeId !== "string") return refusal(revision, [diagnostic("preset.bank.missing", "No bank node was named.")]);
      const node = context.graph.nodes[nodeId];
      if (node === undefined) return refusal(revision, [diagnostic("preset.bank.missing", `No node "${nodeId}".`)]);
      const bankName = node.label ?? node.id;
      if (node.type !== PRESETS_NODE_TYPE) {
        return refusal(revision, [diagnostic("preset.bank.type", `"${bankName}" is a ${node.type} node, not a Presets bank.`, node.id)]);
      }
      const parsed = parsePresetBank(node.parameters["presets"]);
      if (!parsed.ok) {
        return refusal(revision, [
          diagnostic(
            "preset.bank.malformed",
            `Bank "${bankName}": ${parsed.reason}.`,
            node.id,
            "Fix the Presets field in the inspector; nothing was changed.",
          ),
        ]);
      }
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
        diagnostics: outcome.diagnostics ?? [],
        ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
        output: { ok, preset: ok ? name : null, remaining: ok ? presets.map((preset) => preset.name) : names },
      };
    },
    rejectionOutput: () => ({ ok: false, preset: null, remaining: [] }),
  });
}
