import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId, Revision } from "../types/ids.ts";
import { parameterReadOptions, type ParameterReadContext } from "../parameters/node-references.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import type { CommandContext, CommandOutcome, LoomBus } from "../commands/bus.ts";
import { applyGraphPatch } from "../commands/apply-patch.ts";
import { nodeByName } from "../graph/names.ts";
import { resolveParameters } from "../parameters/resolve.ts";
import { parsePresetBank, type MorphCurve, type MorphSpec, type Preset } from "./bank.ts";
import { bankLookupRefusal, bankSettings, planPresetRecall, presetCatalogueOf, presetMorph } from "./commands.ts";
import { bankViewOf, bankOf, type BankView, type PresetCatalogue } from "./bank-view.ts";
import {
  CUE_BACK_COMMAND,
  CUE_FOLLOW_LIVE,
  CUE_FOLLOW_TIMELINE,
  CUE_GO_COMMAND,
  CUE_LIST_NODE_TYPE,
  cueAfter,
  cueNamed,
  nextCueName,
  parseCueList,
  previousCue,
  standbyCue,
  type Cue,
  type CueFollow,
  type CueList,
  type CuePick,
  type CuePosition,
} from "./cue-list.ts";
import { morphProgress, morphRunning, parseMorphRecords } from "./morph.ts";
import { followsTimeline, timelineCuePosition, timelineCueWarnings, timelineStructuralSettings } from "./timeline-cues.ts";

/**
 * T1500b (§T1398b S5, ruling 15) — `cue.go`, `cue.back`, `cue.fire`, `cue.setStandby` and
 * the `cue.list` query: a cue list's GO is ONE recall, and the list moves in the same
 * patch.
 *
 * ## GO is one recall (the design doc §8.2)
 *
 * A cue names a bank and one of its presets. Firing it runs THE recall planner
 * (`planPresetRecall`, the one `preset.recall` runs) with the cue's morph on its rung of
 * §5.1's ladder, and appends the list's own `current = fired` and `standby = the cue after
 * it` to the planner's operations. ONE `GraphPatch`, so a GO is one revision, one undo
 * group (`GO 2 "drop" (set)`) and one audit entry `cue.go` under whoever pressed it — and
 * one undo takes back the targets, the bank's `current`, its morph record AND the list's
 * position together, so the next GO fires the same cue again. Two patches would be a list
 * that says "cue 3" over a picture showing cue 2 after the first undo.
 *
 * A pad and a cue cannot disagree about a preset because there is one planner; neither
 * writes the other's state. A pad recall does not move the list, and a GO sets the bank's
 * `current` only because it recalled that bank.
 *
 * ## A refused GO leaves the standby where it is
 *
 * GO past the end with `wrap` off, a cue whose bank or preset is gone, a cue that leaves
 * nothing to apply (ruling 4), a shot the planner refuses (a cycle, or nested too deep,
 * §T1499b), a standby naming a cue that is no longer in the list: each
 * is REFUSED with a diagnostic that names it, and the document is not touched — the
 * operator reads why and moves the standby. Advancing past a cue that did not fire would
 * make the list lie about what is on screen.
 *
 * ## BACK fires (owner's ruling)
 *
 * `cue.back` fires the cue before `current`, with that cue's own morph — the live way to
 * go back a look without reaching for undo. Moving the standby without firing is
 * `cue.setStandby`. After any fire — GO, BACK or `cue.fire` — the standby is the cue after
 * the one that fired, so there is one rule for where GO goes next.
 *
 * ## Which list a bare GO means
 *
 * The keys (`mod+alt+g`, `mod+alt+b`) carry no node. Without a `nodeId` the command acts
 * on the ONE cue list whose `keys` switch is on; with none or several it is refused,
 * naming the lists, rather than guessing which show the operator is running.
 *
 * The handlers read NO clock (§V44): the morph is stamped from `context.frameClock`, which
 * the planner takes as given. A live GO is not re-performed by a render, and the list's
 * `go` / `back` pulses are among the commands a take does not fire
 * (`RENDER_BLOCKED_PULSE_COMMANDS`). What an export DOES reproduce is a list that follows
 * the timeline (§T1508b, `timeline-cues.ts`): GO, BACK and fire refuse it (`cue.timeline`).
 */

declare module "../types/commands.ts" {
  interface CommandMap {
    "cue.go": { input: CueStepInput; output: CueFireOutput };
    "cue.back": { input: CueStepInput; output: CueFireOutput };
    "cue.fire": { input: CueFireInput; output: CueFireOutput };
    "cue.setStandby": { input: CueSetStandbyInput; output: CueSetStandbyOutput };
  }
  interface QueryMap {
    "cue.list": { input: CueListQueryInput; output: CueListQueryOutput };
  }
}

export { CUE_BACK_COMMAND, CUE_GO_COMMAND };
export const CUE_FIRE_COMMAND = "cue.fire";
export const CUE_SET_STANDBY_COMMAND = "cue.setStandby";
export const CUE_LIST_QUERY = "cue.list";

export interface CueStepInput {
  /** The cue list node. Absent: the one cue list whose Keys switch is on. */
  nodeId?: NodeId;
}

export interface CueFireInput {
  /** The cue list node. */
  nodeId: NodeId;
  /** The cue to fire, by name. */
  cue: string;
}

export interface CueSetStandbyInput {
  /** The cue list node. */
  nodeId: NodeId;
  /** The cue GO fires next, by name. */
  cue: string;
}

export interface CueFireOutput {
  ok: boolean;
  /** The cue that fired, or — on a refusal — the cue that would have, when one was picked. */
  cue: string | null;
  /** The bank and preset that cue recalls. */
  bank: string | null;
  preset: string | null;
  /** The list's position AFTER the command: moved on success, as it stood on a refusal. */
  current: string;
  standby: string;
  /** `node.key` for every value written. */
  applied: readonly string[];
  /** `node` or `node.key` for every entry skipped, each with a warning in `diagnostics`. */
  skipped: readonly string[];
  /** The morph the screen is now doing, or `null` when the cue was a cut. */
  morph: MorphSpec | null;
}

export interface CueSetStandbyOutput {
  ok: boolean;
  current: string;
  standby: string;
}

export interface CueListQueryInput {
  /** One cue list. Absent: every cue list in the document. */
  nodeId?: NodeId;
}

/** A fade one of the list's banks is running, as the surfaces show "morphing" (§5.5). */
export interface CueMorphReport {
  /** The bank node's name. */
  readonly bank: string;
  readonly preset: string;
  readonly start: number;
  readonly seconds: number;
  readonly curve: MorphCurve;
  /** 0..1 on the app's frame clock at the moment of the query. */
  readonly progress: number;
}

export interface CueListReport {
  readonly nodeId: NodeId;
  /** The list node's name. */
  readonly name: string;
  /** Why the Cues field does not parse, or `null`. A malformed list reports no cues. */
  readonly malformed: string | null;
  readonly cues: readonly Cue[];
  readonly current: string;
  readonly standby: string;
  /** The cue a GO would fire now (derived, §8.2), or `null` when GO would be refused. */
  readonly next: string | null;
  readonly wrap: boolean;
  readonly keys: boolean;
  /** Empty with no frame clock attached (headless): there is no transport to fade on. */
  readonly morphs: readonly CueMorphReport[];
  /** T1508b: `live` (GO / BACK) or `timeline` (the cues follow the playhead by their `at`). */
  readonly follow: CueFollow;
  /**
   * T1508b: while it follows the timeline, the newest timed cue the playhead has reached at
   * the app's frame clock, and the next one. `null` when none, when the list is live, or
   * with no frame clock attached (headless): `current` / `standby` are not written by a
   * timed list.
   */
  readonly timelineCurrent: string | null;
  readonly timelineNext: string | null;
  /** T1508b: what the timeline skips on this list and why — untimed cues, structural keys, overlaps. */
  readonly warnings: readonly string[];
  /**
   * §T1544b: what a following list SWITCHES IN THE COMPILED STRUCTURE at its cue times, as
   * `node.key` (a Layer's switch as `node.on`), sorted — the inspector's "switches structure"
   * line. Empty for a live list. The document keeps its stored settings; the timeline
   * overrides them while it follows.
   */
  readonly structure: readonly string[];
}

export interface CueListQueryOutput {
  readonly lists: readonly CueListReport[];
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

/** The name a node goes by in a message: its label, else its id. */
function nameOf(node: GraphNode): string {
  return node.label ?? node.id;
}

/**
 * A node's own parameters at this moment, through the one read path (§V61) and the read
 * scope. §T1557b: this used to be `{ channels }` alone, so an `op('x').chan.y` on a cue
 * list's Keys or position read its static (§B181's shape).
 */
function resolvedValues(
  node: GraphNode,
  registry: NodeRegistryView,
  scope: ParameterReadContext,
): Readonly<Record<string, unknown>> {
  return resolveParameters(node, registry.get(node.type), parameterReadOptions(scope)).values;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function positionOf(values: Readonly<Record<string, unknown>>): CuePosition {
  return { current: text(values["current"]), standby: text(values["standby"]), wrap: values["wrap"] === true };
}

/** Every cue list node, in id order. */
function cueListNodes(graph: GraphDocument): GraphNode[] {
  return Object.keys(graph.nodes)
    .sort()
    .map((nodeId) => graph.nodes[nodeId])
    .filter((node): node is GraphNode => node !== undefined && node.type === CUE_LIST_NODE_TYPE);
}

const quoted = (nodes: readonly GraphNode[]): string => nodes.map((node) => `"${nameOf(node)}"`).join(", ");

type Found<T> = ({ ok: true } & T) | { ok: false; diagnostic: RuntimeDiagnostic };

/**
 * The list node a command means: the one named, or — for the keys, which carry no node —
 * the ONE list whose Keys switch is on. None or several is refused, naming the lists.
 */
function requireListNode(context: CommandContext, nodeId: unknown, keyed: boolean): Found<{ node: GraphNode }> {
  if (nodeId !== undefined) {
    if (typeof nodeId !== "string") {
      return { ok: false, diagnostic: diagnostic("error", "cue.list.missing", "No cue list was named.") };
    }
    const node = context.graph.nodes[nodeId];
    if (node === undefined) return { ok: false, diagnostic: diagnostic("error", "cue.list.missing", `No node "${nodeId}".`) };
    if (node.type !== CUE_LIST_NODE_TYPE) {
      return {
        ok: false,
        diagnostic: diagnostic("error", "cue.list.type", `"${nameOf(node)}" is a ${node.type} node, not a Cue List.`, node.id),
      };
    }
    return { ok: true, node };
  }
  if (!keyed) return { ok: false, diagnostic: diagnostic("error", "cue.list.missing", "No cue list was named.") };

  const lists = cueListNodes(context.graph);
  const answering = lists.filter((node) => resolvedValues(node, context.registry, context.readScope())["keys"] === true);
  if (answering.length === 1) return { ok: true, node: answering[0] as GraphNode };
  if (answering.length === 0) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "error",
        "cue.list.none",
        lists.length === 0
          ? "This document has no cue list, so GO and BACK have nothing to fire."
          : `No cue list answers GO and BACK: Keys is off on ${quoted(lists)}.`,
        undefined,
        lists.length === 0 ? "Add a Cue List node." : "Turn Keys on for the list you are running.",
      ),
    };
  }
  return {
    ok: false,
    diagnostic: diagnostic(
      "error",
      "cue.list.ambiguous",
      `${String(answering.length)} cue lists answer GO and BACK — ${quoted(answering)} — so nothing was fired.`,
      undefined,
      "Turn Keys off on all but the list you are running.",
    ),
  };
}

/** The list node with its cues parsed, or the refusal that says why it cannot be read. */
function requireList(context: CommandContext, nodeId: unknown, keyed: boolean): Found<{ node: GraphNode; list: CueList; position: CuePosition }> {
  const found = requireListNode(context, nodeId, keyed);
  if (!found.ok) return found;
  const { node } = found;
  const parsed = parseCueList(node.parameters["cues"]);
  if (!parsed.ok) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "error",
        "cue.list.malformed",
        `Cue list "${nameOf(node)}": ${parsed.reason}.`,
        node.id,
        "Fix the Cues field in the inspector; nothing was changed.",
      ),
    };
  }
  return { ok: true, node, list: parsed.list, position: positionOf(resolvedValues(node, context.registry, context.readScope())) };
}

/** The bank a cue names and the preset it recalls, or the refusal naming what is missing. */
function requireCueTarget(
  context: CommandContext,
  listNode: GraphNode,
  cue: Cue,
  catalogue: PresetCatalogue | undefined,
): Found<{ bank: BankView; preset: Preset }> {
  const where = `Cue "${cue.name}" (${nameOf(listNode)})`;
  const bankId = nodeByName(context.graph, cue.bank);
  const bankNode = bankId === undefined ? undefined : context.graph.nodes[bankId];
  if (bankNode === undefined) {
    return {
      ok: false,
      diagnostic: diagnostic("error", "cue.bank.missing", `${where}: no node is named "${cue.bank}"; nothing was fired.`, listNode.id, "Name a Presets node in the cue's bank field."),
    };
  }
  // T1505b: a cue may name a look's instance — the instance IS the bank from outside.
  const lookup = bankOf(bankNode, catalogue?.components);
  if (!lookup.ok) {
    if (lookup.why === "notBank") {
      return {
        ok: false,
        diagnostic: diagnostic("error", "cue.bank.type", `${where}: "${cue.bank}" is a ${bankNode.type} node, not a Presets bank; nothing was fired.`, listNode.id),
      };
    }
    return { ok: false, diagnostic: bankLookupRefusal(lookup, bankNode, `${where}: "${cue.bank}"`) };
  }
  const parsed = parsePresetBank(lookup.view.bank.parameters["presets"]);
  if (!parsed.ok) {
    return {
      ok: false,
      diagnostic: diagnostic("error", "cue.bank.malformed", `${where}: bank "${cue.bank}": ${parsed.reason}; nothing was fired.`, bankNode.id, "Fix that bank's Presets field."),
    };
  }
  const preset = parsed.bank.presets.find((candidate) => candidate.name === cue.preset);
  if (preset === undefined) {
    const known = parsed.bank.presets.map((candidate) => candidate.name).join(", ");
    return {
      ok: false,
      diagnostic: diagnostic(
        "error",
        "cue.preset.missing",
        `${where}: bank "${cue.bank}" has no preset "${cue.preset}"; nothing was fired.`,
        listNode.id,
        known === "" ? "That bank is empty; Store a preset first." : `Its presets: ${known}.`,
      ),
    };
  }
  return { ok: true, bank: lookup.view, preset };
}

/** A context whose `apply` always opens a fresh undo group (§V34 "unless explicitly split"). */
function splitUndoContext(context: CommandContext): CommandContext {
  return { ...context, apply: (request) => context.apply({ ...request, splitUndo: true }) };
}

function fireRefusal(
  revision: Revision,
  diagnostics: RuntimeDiagnostic[],
  position: CuePosition | null = null,
  cue: Cue | null = null,
  skipped: readonly string[] = [],
): CommandOutcome<CueFireOutput> {
  return {
    status: "rejected",
    revision,
    diagnostics,
    output: {
      ok: false,
      cue: cue?.name ?? null,
      bank: cue?.bank ?? null,
      preset: cue?.preset ?? null,
      current: position?.current ?? "",
      standby: position?.standby ?? "",
      applied: [],
      skipped,
      morph: null,
    },
  };
}

/** The verb an undo entry and a refusal open with. */
type CueVerb = "GO" | "BACK" | "Fire";

/**
 * Fires one cue: the recall's operations and the list's advance, as ONE patch. `pick`
 * says which cue — the standby, the previous one, or a named one — and is the only thing
 * the three commands differ in.
 */
function fireCue(
  context: CommandContext,
  nodeId: unknown,
  keyed: boolean,
  verb: CueVerb,
  pick: (list: CueList, position: CuePosition) => CuePick,
  catalogue: PresetCatalogue | undefined,
): CommandOutcome<CueFireOutput> {
  const revision = context.store.getRevision();
  const found = requireList(context, nodeId, keyed);
  if (!found.ok) return fireRefusal(revision, [found.diagnostic]);
  const { node, list, position } = found;
  // T1508b (owner ruling 3): a list that follows the timeline is all-timed. GO cannot move
  // the playhead, and firing would write values the timeline outranks on screen anyway.
  if (followsTimeline(node)) {
    return fireRefusal(
      revision,
      [
        diagnostic(
          "error",
          "cue.timeline",
          `Cue list "${nameOf(node)}" follows the timeline; move the playhead. Nothing was fired.`,
          node.id,
          "Switch its Follow to Live to fire cues by hand, or run manual cues from a second, live list.",
        ),
      ],
      position,
    );
  }

  const picked = pick(list, position);
  if (!picked.ok) {
    return fireRefusal(
      revision,
      [diagnostic("error", picked.code, `Cue list "${nameOf(node)}": ${picked.reason}; nothing was fired.`, node.id, picked.suggestion)],
      position,
    );
  }
  const { cue, index } = picked;
  const target = requireCueTarget(context, node, cue, catalogue);
  if (!target.ok) return fireRefusal(revision, [target.diagnostic], position, cue);
  const { bank, preset } = target;

  const plan = planPresetRecall(context.graph, context.registry, bank, preset, {
    // §5.1: the cue's morph sits where a recall's own would, above the preset's and the bank's.
    morph: presetMorph(cue.morph, preset, bankSettings(bank, context.registry, context.readScope())),
    clock: context.frameClock,
    catalogue,
  });
  // T1499b: a shot whose `recalls` go round in a circle, or nest too deep, is refused by
  // the planner in its own words. Nothing is added: "nothing left to apply" is not why.
  if (plan.refused) return fireRefusal(revision, [...plan.diagnostics], position, cue, plan.skipped);
  if (plan.applied.length === 0) {
    // Ruling 4: refused only when NOTHING is left — and then the list stays where it is.
    return fireRefusal(
      revision,
      [
        ...plan.diagnostics,
        diagnostic(
          "error",
          "cue.fire.nothing",
          `Cue "${cue.name}" (${nameOf(node)}): preset "${cue.preset}" (${cue.bank}) has nothing left to apply; nothing was fired.`,
          node.id,
          "Move the standby past it, or fix the preset.",
        ),
      ],
      position,
      cue,
      plan.skipped,
    );
  }

  const standby = cueAfter(list, index, position.wrap)?.name ?? "";
  const outcome = applyGraphPatch(
    {
      baseRevision: context.graph.revision,
      label: `${verb} ${cue.name} "${cue.preset}" (${nameOf(node)})`,
      // The list's own write goes LAST: a preset that targets this list (its `wrap`, say)
      // must not be able to move `current` / `standby` out from under the GO that fired it.
      operations: [...plan.operations, { op: "setParameters", nodeId: node.id, parameters: { current: cue.name, standby } }],
    },
    splitUndoContext(context),
  );
  const diagnostics = [...plan.diagnostics, ...(outcome.diagnostics ?? [])];
  const ok = outcome.status === "applied" || outcome.status === "validated";
  return {
    status: outcome.status,
    revision: outcome.revision ?? revision,
    diagnostics,
    ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
    output: {
      ok,
      cue: cue.name,
      bank: cue.bank,
      preset: cue.preset,
      current: ok ? cue.name : position.current,
      standby: ok ? standby : position.standby,
      applied: ok ? plan.applied : [],
      skipped: plan.skipped,
      morph: ok ? plan.morph : null,
    },
  };
}

const emptyFireOutput = (): CueFireOutput => ({
  ok: false,
  cue: null,
  bank: null,
  preset: null,
  current: "",
  standby: "",
  applied: [],
  skipped: [],
  morph: null,
});

/** One list as `cue.list` reports it. */
function reportList(bus: LoomBus, graph: GraphDocument, node: GraphNode): CueListReport {
  const values = resolvedValues(node, bus.registry, { ...bus.readScope(), graph });
  const position = positionOf(values);
  const parsed = parseCueList(node.parameters["cues"]);
  const list: CueList = parsed.ok ? parsed.list : { version: 1, cues: [] };

  const clock = bus.frameClock();
  const morphs: CueMorphReport[] = [];
  if (clock !== undefined) {
    for (const bank of [...new Set(list.cues.map((cue) => cue.bank))]) {
      const bankId = nodeByName(graph, bank);
      // T1505b: a look's instance reports the fades it holds itself.
      const view = bankViewOf(bankId === undefined ? undefined : graph.nodes[bankId], presetCatalogueOf(bus)?.components);
      if (view === undefined) continue;
      for (const record of parseMorphRecords(view.holder.parameters[view.morphsKey])) {
        if (!morphRunning(record, clock)) continue;
        morphs.push({
          bank,
          preset: record.preset,
          start: record.start,
          seconds: record.seconds,
          curve: record.curve,
          progress: morphProgress(record, clock.absTimeSeconds),
        });
      }
    }
  }
  const following = followsTimeline(node);
  const timeline =
    following && clock?.timeSeconds !== undefined && clock.timelineRate !== undefined
      ? timelineCuePosition(list, clock.timeSeconds, clock.timelineRate)
      : { current: null, next: null };
  return {
    nodeId: node.id,
    name: nameOf(node),
    malformed: parsed.ok ? null : parsed.reason,
    cues: list.cues,
    current: position.current,
    standby: position.standby,
    // A timed list refuses GO, so there is no cue GO "would fire".
    next: parsed.ok && !following ? nextCueName(list, position) : null,
    wrap: position.wrap,
    keys: values["keys"] === true,
    morphs,
    follow: following ? CUE_FOLLOW_TIMELINE : CUE_FOLLOW_LIVE,
    timelineCurrent: timeline.current,
    timelineNext: timeline.next,
    warnings: timelineCueWarnings(graph, bus.registry, node.id, presetCatalogueOf(bus)?.components).map((warning) => warning.diagnostic.message),
    structure: timelineStructuralSettings(graph, bus.registry, node.id, presetCatalogueOf(bus)?.components),
  };
}

export function registerCueCommands(bus: LoomBus): void {
  if (bus.hasCommand(CUE_GO_COMMAND)) return;

  bus.registerCommand({
    name: CUE_GO_COMMAND,
    description:
      "GO: fire a cue list's standby cue — its preset recalled and the list advanced as one patch, one undo step (§T1500b). Without a nodeId, the one cue list whose Keys switch is on.",
    handler: (input, context) => fireCue(context, input?.nodeId, true, "GO", standbyCue, presetCatalogueOf(bus)),
    rejectionOutput: emptyFireOutput,
  });

  bus.registerCommand({
    name: CUE_BACK_COMMAND,
    description:
      "BACK: fire the cue before a cue list's current one, with that cue's own morph (§T1500b). Without a nodeId, the one cue list whose Keys switch is on.",
    handler: (input, context) => fireCue(context, input?.nodeId, true, "BACK", previousCue, presetCatalogueOf(bus)),
    rejectionOutput: emptyFireOutput,
  });

  bus.registerCommand({
    name: CUE_FIRE_COMMAND,
    description: "Fire a named cue of a cue list directly; the standby becomes the cue after it (§T1500b).",
    handler: (input, context) => {
      const name = typeof input?.cue === "string" ? input.cue.trim() : "";
      return fireCue(context, input?.nodeId, false, "Fire", (list) => cueNamed(list, name), presetCatalogueOf(bus));
    },
    rejectionOutput: emptyFireOutput,
  });

  bus.registerCommand({
    name: CUE_SET_STANDBY_COMMAND,
    description: "Move a cue list's standby — the cue GO fires next — without firing anything (§T1500b).",
    handler: (input, context) => {
      const revision = context.store.getRevision();
      const refusal = (diagnostics: RuntimeDiagnostic[], position: CuePosition | null = null): CommandOutcome<CueSetStandbyOutput> => ({
        status: "rejected",
        revision,
        diagnostics,
        output: { ok: false, current: position?.current ?? "", standby: position?.standby ?? "" },
      });
      const found = requireList(context, input?.nodeId, false);
      if (!found.ok) return refusal([found.diagnostic]);
      const { node, list, position } = found;
      const picked = cueNamed(list, typeof input.cue === "string" ? input.cue.trim() : "");
      if (!picked.ok) {
        return refusal(
          [diagnostic("error", picked.code, `Cue list "${nameOf(node)}": ${picked.reason}; the standby was not moved.`, node.id, picked.suggestion)],
          position,
        );
      }
      const outcome = applyGraphPatch(
        {
          baseRevision: context.graph.revision,
          label: `Standby ${picked.cue.name} (${nameOf(node)})`,
          operations: [{ op: "setParameters", nodeId: node.id, parameters: { standby: picked.cue.name } }],
        },
        splitUndoContext(context),
      );
      const ok = outcome.status === "applied" || outcome.status === "validated";
      return {
        status: outcome.status,
        revision: outcome.revision ?? revision,
        diagnostics: outcome.diagnostics ?? [],
        ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
        output: { ok, current: position.current, standby: ok ? picked.cue.name : position.standby },
      };
    },
    rejectionOutput: () => ({ ok: false, current: "", standby: "" }),
  });

  bus.registerQuery({
    name: CUE_LIST_QUERY,
    description: "A cue list's cues, current, standby, derived next and running morphs; without a nodeId, every cue list (§T1500b).",
    handler: (input, context): CueListQueryOutput => {
      const nodes =
        input?.nodeId === undefined ? cueListNodes(context.graph) : cueListNodes(context.graph).filter((node) => node.id === input.nodeId);
      return { lists: nodes.map((node) => reportList(bus, context.graph, node)) };
    },
  });
}
