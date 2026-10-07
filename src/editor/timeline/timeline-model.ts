import { parseAutomation, type AutomationDocument } from "@domain/automation/model.ts";
import { keyReads } from "@domain/graph/parameter-dependencies.ts";
import { isParameterSlot, storedStaticValue } from "@domain/parameters/slots.ts";
import { formatTimecode, frameToTimecode, supportsDropFrame } from "@domain/time/timecode.ts";
import { rateOf } from "@domain/time/ticks.ts";
import type { FrameRange, GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import { AUTOMATION_NODE_TYPE } from "@nodes/definitions/automation.ts";

/**
 * VN62 — WHAT THE TIMELINE SHOWS, read from the document. Pure.
 *
 * The lane list shows EVERY automation node, grouped. One of them is CURRENT: where a new
 * lane goes and whose curves the editor draws in full. The rule (VN62 plan, approved):
 * the primary graph selection when it is an automation node, else the node the timeline
 * itself last touched, else the first by name. The list header names it, so a + never
 * lands somewhere surprising.
 */

export interface AutomationNodeView {
  readonly id: NodeId;
  /** The `op('<name>')` address; null for a legacy unnamed node (nothing can reference its lanes). */
  readonly name: string | null;
  /** The parsed lanes, or why they do not parse. */
  readonly document: AutomationDocument | null;
  readonly error: string | null;
  /** The lanes parameter is static text (an expression-driven lanes text is read-only here). */
  readonly editable: boolean;
}

export function automationNodeView(node: GraphNode): AutomationNodeView {
  const stored = node.parameters["lanes"];
  const editable = !isParameterSlot(stored) || stored.mode === "static";
  const parsed = parseAutomation(storedStaticValue(stored));
  return {
    id: node.id,
    name: node.label ?? null,
    document: parsed.ok ? parsed.document : null,
    error: parsed.ok ? null : parsed.reason,
    editable,
  };
}

/** Every automation node, by name (unnamed last, by id). */
export function automationNodes(graph: GraphDocument): AutomationNodeView[] {
  return Object.values(graph.nodes)
    .filter((node) => node.type === AUTOMATION_NODE_TYPE)
    .map(automationNodeView)
    .sort((a, b) => (a.name ?? "￿" + a.id).localeCompare(b.name ?? "￿" + b.id));
}

export function currentAutomationNode(
  nodes: readonly AutomationNodeView[],
  primarySelection: NodeId | null,
  lastTouched: NodeId | null,
): AutomationNodeView | null {
  const byId = (id: NodeId | null): AutomationNodeView | undefined => (id === null ? undefined : nodes.find((node) => node.id === id));
  return byId(primarySelection) ?? byId(lastTouched) ?? nodes[0] ?? null;
}

/**
 * How many parameters read each lane, `lane name → count`: every ACTIVE expression slot in
 * the document whose `op('<node>').chan.<lane>` names it. Derived at display time from the
 * same walk the canvas and the cycle gate use; never stored (a lane keeps no consumer list).
 */
export function laneReferenceCounts(graph: GraphDocument, nodeName: string | null): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  if (nodeName === null) return counts;
  for (const node of Object.values(graph.nodes)) {
    for (const read of keyReads(node.parameters)) {
      if (read.kind !== "channel" || read.node !== nodeName) continue;
      counts.set(read.channel, (counts.get(read.channel) ?? 0) + 1);
    }
  }
  return counts;
}

/** The readout: timecode (drop-frame at 29.97 / 59.94), frame, elapsed from the in point, remaining to the out point. */
export function timelineReadout(frame: number, fps: number, range: FrameRange): { timecode: string; frame: string; elapsed: string; remaining: string } {
  const rate = rateOf(fps);
  const label = (frames: number): string => formatTimecode(frameToTimecode(Math.max(0, frames), rate, supportsDropFrame(rate)));
  return {
    timecode: label(frame),
    frame: String(frame),
    elapsed: label(frame - range.start),
    remaining: label(range.end - frame),
  };
}

/**
 * Which value-only revisions the timeline re-renders for (`LiveGraph`'s `shows`): a write
 * to an automation node (its lanes), or to a node holding an expression slot (a reference
 * to a lane may have appeared or gone, and the list's counts are derived from those).
 * Everything else, a slider drag on an unrelated node, leaves the pane alone.
 */
export function timelineShows(written: readonly NodeId[], graph: GraphDocument): boolean {
  return written.some((nodeId) => {
    const node = graph.nodes[nodeId];
    if (node === undefined) return false;
    if (node.type === AUTOMATION_NODE_TYPE) return true;
    return Object.values(node.parameters).some((stored) => isParameterSlot(stored) && stored.bindings.expression !== undefined);
  });
}

/** The stored lanes parameter with new text, keeping a static slot's retained bindings. */
export function lanesStored(stored: StoredParameter | undefined, text: string): StoredParameter {
  return isParameterSlot(stored) ? { ...stored, bindings: { ...stored.bindings, static: { kind: "static", value: text } } } : text;
}
