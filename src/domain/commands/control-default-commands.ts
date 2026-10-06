import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { GraphPatchOperation } from "../types/patch.ts";
import type { StoredParameter } from "../types/parameters.ts";
import { CONTROL_DEFAULT_KEYS, controlDefaultState, controlNameOf, panelMembers } from "../../nodes/definitions/controls.ts";
import type { CommandContext, CommandOutcome, LoomBus } from "./bus.ts";
import { applyGraphPatch } from "./apply-patch.ts";
import { z } from "zod";
import { idInput } from "./input-schema.ts";

/**
 * T1619b — `control.reset` and `control.setDefault`: a Slider, a Toggle and an XY Pad go back
 * to their default, or take their current value as it (`docs/control-reset-design-2026-10-06.md`).
 *
 * ## One command is one patch
 *
 * However many controls it names, a command writes ONE `GraphPatch`: one revision, one audit
 * entry under its own name and the invoking actor, and one undo group that puts every value
 * back together. The group is split even inside a caller's transaction (the preset
 * commands' rule), so a drag's coalescing cannot swallow a reset.
 *
 * ## What it names
 *
 * `nodeIds` holds controls and Panels. A Panel stands for the controls on it
 * (`panelMembers`), so "reset this Panel" is the Panel's id. `all` is every control in the
 * document. A named node that is neither is skipped and said by name; a Button on a named
 * Panel is passed over without a word, because it holds nothing to reset.
 *
 * ## What it leaves alone
 *
 * A value key the document DRIVES (an expression, a MIDI learn) is not a hand's to move: it
 * is left as it is and named. Reset never changes a mode, unlike `parameter.reset` (§V149),
 * so a learned fader stays learned.
 *
 * ## Nothing to do is a refusal
 *
 * A command that would change nothing is refused by name and writes nothing: "reset" with
 * nothing moved would be a lie in the audit log (the recall's rule).
 *
 * Domain commands, registered by `createDomainBus`, so the app, the headless helper and a
 * phone's vetted write all reach the same two.
 */

declare module "../types/commands.ts" {
  interface CommandMap {
    "control.reset": { input: ControlDefaultInput; output: ControlDefaultOutput };
    "control.setDefault": { input: ControlDefaultInput; output: ControlDefaultOutput };
  }
}

export const CONTROL_RESET_COMMAND = "control.reset";
export const CONTROL_SET_DEFAULT_COMMAND = "control.setDefault";

/** The controls a command acts on: the ones named (a Panel's id names its members), or every one. */
export type ControlDefaultInput = { nodeIds: NodeId[] } | { all: true };

export interface ControlDefaultOutput {
  ok: boolean;
  /** The NAME of every control written. */
  changed: readonly string[];
  /** What was named and left alone: `name.key` for a driven key, the name (or id) of a node that is not a control. */
  skipped: readonly string[];
}

export const controlDefaultInputSchema = z.union([
  z.object({ nodeIds: z.array(idInput).min(1) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

type Verb = typeof CONTROL_RESET_COMMAND | typeof CONTROL_SET_DEFAULT_COMMAND;

const holdsDefault = (node: GraphNode): boolean => CONTROL_DEFAULT_KEYS[node.type] !== undefined;

const warning = (code: string, message: string, nodeId?: NodeId): RuntimeDiagnostic => ({
  severity: "warning",
  code,
  message,
  ...(nodeId === undefined ? {} : { nodeId }),
});

/** The controls a command reaches, each once, in the order named (a Panel's in its own order); what else was named is `skip`ped. */
function targetsOf(graph: GraphDocument, input: ControlDefaultInput, skip: (name: string, diagnostic: RuntimeDiagnostic) => void): GraphNode[] {
  const found = new Map<NodeId, GraphNode>();
  if ("all" in input) {
    for (const id of Object.keys(graph.nodes).sort()) {
      const node = graph.nodes[id];
      if (node !== undefined && holdsDefault(node)) found.set(node.id, node);
    }
    return [...found.values()];
  }
  for (const id of input.nodeIds) {
    const node = graph.nodes[id];
    if (node === undefined) {
      skip(id, warning("control.default.missing", `No node "${id}".`));
    } else if (node.type === "panel") {
      for (const member of panelMembers(graph, node)) if (holdsDefault(member)) found.set(member.id, member);
    } else if (holdsDefault(node)) {
      found.set(node.id, node);
    } else {
      const name = controlNameOf(node);
      skip(name, warning("control.default.notControl", `"${name}" is a ${node.type} node; a Slider, a Toggle and an XY Pad hold a default.`, node.id));
    }
  }
  return [...found.values()];
}

/** What one control is written, or nothing: its value keys to their defaults (reset), or its default keys to its values. */
function writesFor(verb: Verb, node: GraphNode, skip: (name: string, diagnostic: RuntimeDiagnostic) => void): Record<string, StoredParameter> {
  const state = controlDefaultState(node);
  const defaultKeys = CONTROL_DEFAULT_KEYS[node.type];
  if (state === null || defaultKeys === undefined) return {};
  const name = controlNameOf(node);
  for (const key of state.driven) {
    skip(`${name}.${key}`, warning("control.default.driven", `"${name}.${key}" is driven by the document, so it was left as it is.`, node.id));
  }
  const writes: Record<string, StoredParameter> = {};
  if (verb === CONTROL_RESET_COMMAND) {
    for (const key of state.away) writes[key] = state.defaults[key] as number | boolean;
    return writes;
  }
  for (const [key, held] of Object.entries(state.current)) {
    const defaultKey = defaultKeys[key];
    if (defaultKey !== undefined && held !== state.defaults[key]) writes[defaultKey] = held;
  }
  return writes;
}

const NOTHING: Readonly<Record<Verb, { code: string; message: string }>> = {
  [CONTROL_RESET_COMMAND]: { code: "control.reset.nothing", message: "Every control named is already at its default; nothing was changed." },
  [CONTROL_SET_DEFAULT_COMMAND]: { code: "control.setDefault.nothing", message: "Every control named already has its value as its default; nothing was changed." },
};

function labelOf(verb: Verb, changed: readonly string[]): string {
  const one = changed.length === 1 ? changed[0] : undefined;
  if (verb === CONTROL_RESET_COMMAND) return one === undefined ? `Reset ${String(changed.length)} controls` : `Reset ${one}`;
  return one === undefined ? `Set ${String(changed.length)} defaults` : `Set default (${one})`;
}

function run(verb: Verb, input: ControlDefaultInput, context: CommandContext): CommandOutcome<ControlDefaultOutput> {
  const revision = context.store.getRevision();
  const skipped: string[] = [];
  const diagnostics: RuntimeDiagnostic[] = [];
  const skip = (name: string, diagnostic: RuntimeDiagnostic): void => {
    skipped.push(name);
    diagnostics.push(diagnostic);
  };
  const operations: GraphPatchOperation[] = [];
  const changed: string[] = [];
  for (const node of targetsOf(context.graph, input, skip)) {
    const parameters = writesFor(verb, node, skip);
    if (Object.keys(parameters).length === 0) continue;
    operations.push({ op: "setParameters", nodeId: node.id, parameters });
    changed.push(controlNameOf(node));
  }
  if (operations.length === 0) {
    diagnostics.push({ severity: "error", ...NOTHING[verb] });
    return { status: "rejected", revision, diagnostics, output: { ok: false, changed: [], skipped } };
  }
  const outcome = applyGraphPatch(
    { baseRevision: context.graph.revision, label: labelOf(verb, changed), operations },
    // Its own undo step even inside a caller's transaction (the preset commands' rule).
    { ...context, apply: (request) => context.apply({ ...request, splitUndo: true }) },
  );
  const ok = outcome.status === "applied" || outcome.status === "validated";
  return {
    status: outcome.status,
    revision: outcome.revision ?? revision,
    diagnostics: [...diagnostics, ...(outcome.diagnostics ?? [])],
    ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
    output: { ok, changed: ok ? changed : [], skipped },
  };
}

export function registerControlDefaultCommands(bus: LoomBus): void {
  // The bus has no unregister and a remount calls this again; the first registration stands.
  if (bus.hasCommand(CONTROL_RESET_COMMAND)) return;
  bus.registerCommand({
    name: CONTROL_RESET_COMMAND,
    inputSchema: controlDefaultInputSchema,
    description:
      "Send Sliders, Toggles and XY Pads back to their defaults: the controls named (a Panel's id names the controls on it), or every one. One patch, one undo step (§T1619b).",
    handler: (input, context) => run(CONTROL_RESET_COMMAND, input, context),
    rejectionOutput: () => ({ ok: false, changed: [], skipped: [] }),
  });
  bus.registerCommand({
    name: CONTROL_SET_DEFAULT_COMMAND,
    inputSchema: controlDefaultInputSchema,
    description:
      "Make the current value of Sliders, Toggles and XY Pads their default, the value Reset returns to: the controls named (a Panel's id names the controls on it), or every one. One patch, one undo step (§T1619b).",
    handler: (input, context) => run(CONTROL_SET_DEFAULT_COMMAND, input, context),
    rejectionOutput: () => ({ ok: false, changed: [], skipped: [] }),
  });
}
