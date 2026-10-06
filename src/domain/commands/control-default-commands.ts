import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { GraphPatchOperation } from "../types/patch.ts";
import type { StoredParameter } from "../types/parameters.ts";
import { CONTROL_DEFAULT_KEYS, controlDefaultState, controlNameOf, panelMembers } from "../../nodes/definitions/controls.ts";
import type { CommandContext, CommandOutcome, LoomBus } from "./bus.ts";
import { applyGraphPatch } from "./apply-patch.ts";
import { z } from "zod";
import { NO_INPUT, idInput } from "./input-schema.ts";

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
 * `control.resetAll` and `control.setAllDefaults` are the whole document with NO input: the
 * doors that cannot build one (the command palette runs a command bare) need a command
 * that is complete as it stands.
 *
 * ## What it leaves alone
 *
 * A value key the document DRIVES (an expression, a MIDI learn) is not a hand's to move: it
 * is left as it is and named. Reset never changes a mode, unlike `parameter.reset` (§V149),
 * so a learned fader stays learned.
 *
 * A control that holds NO default (`controlDefaults`: nothing stored, never the type's 0.5)
 * is not reset: it is named (`control.default.missing`), and `control.setDefault` is what
 * gives it one.
 *
 * ## Nothing to do is a refusal
 *
 * A command that would change nothing is refused by name and writes nothing: "reset" with
 * nothing moved would be a lie in the audit log (the recall's rule).
 *
 * Domain commands, registered by `createDomainBus`, so the app, the headless helper and a
 * phone's vetted write all reach the same ones.
 */

declare module "../types/commands.ts" {
  interface CommandMap {
    "control.reset": { input: ControlDefaultInput; output: ControlDefaultOutput };
    "control.setDefault": { input: ControlDefaultInput; output: ControlDefaultOutput };
    "control.resetAll": { input: Record<string, never>; output: ControlDefaultOutput };
    "control.setAllDefaults": { input: Record<string, never>; output: ControlDefaultOutput };
  }
}

export const CONTROL_RESET_COMMAND = "control.reset";
export const CONTROL_SET_DEFAULT_COMMAND = "control.setDefault";
export const CONTROL_RESET_ALL_COMMAND = "control.resetAll";
export const CONTROL_SET_ALL_DEFAULTS_COMMAND = "control.setAllDefaults";

/** The controls a command acts on: the ones named (a Panel's id names its members), or every one. */
export type ControlDefaultInput = { nodeIds: NodeId[] } | { all: true };

export interface ControlDefaultOutput {
  ok: boolean;
  /** The NAME of every control written. */
  changed: readonly string[];
  /** What was named and left alone: `name.key` for a driven key, the name of a control with no default or of a node that is not a control, the id of one that is not there. */
  skipped: readonly string[];
}

export const controlDefaultInputSchema = z.union([
  z.object({ nodeIds: z.array(idInput).min(1) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

/** What the command does to a control: send it back to its default, or make its value the default. */
export type ControlDefaultVerb = "reset" | "setDefault";

const holdsDefault = (node: GraphNode): boolean => CONTROL_DEFAULT_KEYS[node.type] !== undefined;

const warning = (code: string, message: string, nodeId?: NodeId): RuntimeDiagnostic => ({
  severity: "warning",
  code,
  message,
  ...(nodeId === undefined ? {} : { nodeId }),
});

type Skip = (name: string, diagnostic: RuntimeDiagnostic) => void;

/** The controls a command reaches, each once, in the order named (a Panel's in its own order); what else was named is `skip`ped. */
function targetsOf(graph: Pick<GraphDocument, "nodes" | "edges">, input: ControlDefaultInput, skip: Skip): GraphNode[] {
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
      skip(id, warning("control.default.noNode", `No node "${id}".`));
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
function writesFor(verb: ControlDefaultVerb, node: GraphNode, skip: Skip): Record<string, StoredParameter> {
  const state = controlDefaultState(node);
  const defaultKeys = CONTROL_DEFAULT_KEYS[node.type];
  if (state === null || defaultKeys === undefined) return {};
  const name = controlNameOf(node);
  for (const key of state.driven) {
    // Said so that it reads as a refusal's reason too: a menu row greys with this sentence.
    const left = verb === "reset" ? "a reset leaves it as it is" : "it has no hand-set value to keep as a default";
    skip(`${name}.${key}`, warning("control.default.driven", `"${name}.${key}" is driven by the document (an expression or a MIDI learn), so ${left}.`, node.id));
  }
  const writes: Record<string, StoredParameter> = {};
  if (verb === "reset") {
    if (state.missing.length > 0) {
      skip(name, warning("control.default.missing", `"${name}" has no default to go back to. Set as default gives it one.`, node.id));
    }
    for (const key of state.away) writes[key] = state.defaults[key] as number | boolean;
    return writes;
  }
  for (const [key, held] of Object.entries(state.current)) {
    const defaultKey = defaultKeys[key];
    if (defaultKey !== undefined && held !== state.defaults[key]) writes[defaultKey] = held;
  }
  return writes;
}

const NOTHING: Readonly<Record<ControlDefaultVerb, { code: string; message: string }>> = {
  reset: { code: "control.reset.nothing", message: "Nothing to reset: no control named is away from a default it holds. Nothing was changed." },
  setDefault: { code: "control.setDefault.nothing", message: "Every control named already has its value as its default; nothing was changed." },
};

export interface ControlDefaultPlan {
  /** One `setParameters` per control written. Empty: the command would change nothing. */
  readonly operations: readonly GraphPatchOperation[];
  readonly changed: readonly string[];
  readonly skipped: readonly string[];
  /** One warning per thing named and left alone, in the order met. */
  readonly diagnostics: readonly RuntimeDiagnostic[];
  /** The refusal the command gives when `operations` is empty, else null. */
  readonly refusal: RuntimeDiagnostic | null;
}

/**
 * WHAT A COMMAND WOULD WRITE, pure: the one plan the commands run and a menu row asks
 * before it offers itself, so a row that could only refuse is greyed with the command's own
 * sentence instead of dispatching into it (the T1514b rows' rule).
 */
export function planControlDefaults(verb: ControlDefaultVerb, graph: Pick<GraphDocument, "nodes" | "edges">, input: ControlDefaultInput): ControlDefaultPlan {
  const skipped: string[] = [];
  const diagnostics: RuntimeDiagnostic[] = [];
  const skip: Skip = (name, diagnostic) => {
    skipped.push(name);
    diagnostics.push(diagnostic);
  };
  const operations: GraphPatchOperation[] = [];
  const changed: string[] = [];
  for (const node of targetsOf(graph, input, skip)) {
    const parameters = writesFor(verb, node, skip);
    if (Object.keys(parameters).length === 0) continue;
    operations.push({ op: "setParameters", nodeId: node.id, parameters });
    changed.push(controlNameOf(node));
  }
  return { operations, changed, skipped, diagnostics, refusal: operations.length === 0 ? { severity: "error", ...NOTHING[verb] } : null };
}

function labelOf(verb: ControlDefaultVerb, changed: readonly string[]): string {
  const one = changed.length === 1 ? changed[0] : undefined;
  if (verb === "reset") return one === undefined ? `Reset ${String(changed.length)} controls` : `Reset ${one}`;
  return one === undefined ? `Set ${String(changed.length)} defaults` : `Set default (${one})`;
}

function run(verb: ControlDefaultVerb, input: ControlDefaultInput, context: CommandContext): CommandOutcome<ControlDefaultOutput> {
  const revision = context.store.getRevision();
  const plan = planControlDefaults(verb, context.graph, input);
  if (plan.refusal !== null) {
    return { status: "rejected", revision, diagnostics: [...plan.diagnostics, plan.refusal], output: { ok: false, changed: [], skipped: plan.skipped } };
  }
  const outcome = applyGraphPatch(
    { baseRevision: context.graph.revision, label: labelOf(verb, plan.changed), operations: [...plan.operations] },
    // Its own undo step even inside a caller's transaction (the preset commands' rule).
    { ...context, apply: (request) => context.apply({ ...request, splitUndo: true }) },
  );
  const ok = outcome.status === "applied" || outcome.status === "validated";
  return {
    status: outcome.status,
    revision: outcome.revision ?? revision,
    diagnostics: [...plan.diagnostics, ...(outcome.diagnostics ?? [])],
    ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
    output: { ok, changed: ok ? plan.changed : [], skipped: plan.skipped },
  };
}

const NOT_RUN: ControlDefaultOutput = { ok: false, changed: [], skipped: [] };

export function registerControlDefaultCommands(bus: LoomBus): void {
  // The bus has no unregister and a remount calls this again; the first registration stands.
  if (bus.hasCommand(CONTROL_RESET_COMMAND)) return;
  bus.registerCommand({
    name: CONTROL_RESET_COMMAND,
    inputSchema: controlDefaultInputSchema,
    description:
      "Send Sliders, Toggles and XY Pads back to their defaults: the controls named (a Panel's id names the controls on it), or every one. One patch, one undo step (§T1619b).",
    handler: (input, context) => run("reset", input, context),
    rejectionOutput: () => NOT_RUN,
  });
  bus.registerCommand({
    name: CONTROL_SET_DEFAULT_COMMAND,
    inputSchema: controlDefaultInputSchema,
    description:
      "Make the current value of Sliders, Toggles and XY Pads their default, the value Reset returns to: the controls named (a Panel's id names the controls on it), or every one. One patch, one undo step (§T1619b).",
    handler: (input, context) => run("setDefault", input, context),
    rejectionOutput: () => NOT_RUN,
  });
  bus.registerCommand({
    name: CONTROL_RESET_ALL_COMMAND,
    inputSchema: NO_INPUT,
    description: "Send every Slider, Toggle and XY Pad in the document back to its default. One patch, one undo step (§T1619b).",
    handler: (_input, context) => run("reset", { all: true }, context),
    rejectionOutput: () => NOT_RUN,
  });
  bus.registerCommand({
    name: CONTROL_SET_ALL_DEFAULTS_COMMAND,
    inputSchema: NO_INPUT,
    description: "Make the current value of every Slider, Toggle and XY Pad in the document its default. One patch, one undo step (§T1619b).",
    handler: (_input, context) => run("setDefault", { all: true }, context),
    rejectionOutput: () => NOT_RUN,
  });
}
