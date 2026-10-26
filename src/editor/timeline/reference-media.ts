import type { FrameRange, GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { uniqueNodeName } from "@domain/graph/names.ts";
import { kindOfType } from "@domain/graph/node-kinds.ts";
import { mediaPlayhead, mediaTransportFrom } from "@domain/media/transport.ts";
import { isStillPictureFile } from "@domain/media/picture-file.ts";
import {
  isNamedReference,
  referenceNameFor,
  timelineReferenceOf,
  type ReferenceMediaType,
  type TimelineReference,
} from "@domain/media/timeline-reference.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import { storedStaticValue } from "@domain/parameters/slots.ts";
import { frameRangeLimit, rangeLimitSentence } from "@domain/transport/range-limit.ts";
import { ticksToSeconds } from "@domain/time/ticks.ts";
import { mediaNodeType, type ResolvedMedia } from "../media-drop/media-drop.ts";

/**
 * VN64 — THE TIMELINE'S REFERENCE MEDIA, as patches. Which node it is is
 * `timelineReferenceOf` (`@domain/media/timeline-reference.ts`, marked by the role
 * `reference`); this module plans the edits that make or move it, each ONE patch:
 *
 *  - a file dropped on the timeline: the reference of that type takes the new file, or a new
 *    `movie_reference` / `audiofile_reference` is made;
 *  - an existing media node adopted as the reference: renamed to the role (references to it
 *    are rewritten by the rename, §V128);
 *
 * and, either way, the reference is LOCKED TO THE TIMELINE (so it plays with the playhead
 * and a scrub finds the same frame), and a movie's own audio is switched on, so the piece is
 * heard while it is scored. A previous reference of the other kind is renamed off the role,
 * so there is one.
 */

/** What every reference holds besides its file. */
function referenceParameters(type: ReferenceMediaType): Record<string, ParameterValue> {
  return type === "movieFileIn" ? { playMode: "timeline", audio: true } : { playMode: "timeline" };
}

/** Renames every OTHER node carrying the role off it, to its kind plus a number. */
function unmarkOthers(graph: GraphDocument, keep: NodeId | null): GraphPatchOperation[] {
  const operations: GraphPatchOperation[] = [];
  let draft = graph;
  for (const node of Object.values(graph.nodes)) {
    if (node.id === keep || !isNamedReference(node)) continue;
    const label = uniqueNodeName(draft, kindOfType(node.type));
    operations.push({ op: "setNodeLabel", nodeId: node.id, label });
    // Later renames in the same patch must not mint the same number.
    draft = { ...draft, nodes: { ...draft.nodes, [node.id]: { ...node, label } } };
  }
  return operations;
}

/** The right-most node's x plus a step, so a new reference does not land on the patch. */
function besideTheGraph(graph: GraphDocument): { x: number; y: number } {
  const nodes = Object.values(graph.nodes);
  if (nodes.length === 0) return { x: 0, y: 0 };
  return { x: Math.max(...nodes.map((node) => node.position.x)) + 280, y: Math.min(...nodes.map((node) => node.position.y)) };
}

/** A media file dropped on the timeline (or picked with "Reference media…"): ONE patch. */
export function referenceDropOperations(graph: GraphDocument, media: ResolvedMedia): GraphPatchOperation[] {
  const type = mediaNodeType(media.kind);
  const current = timelineReferenceOf(graph);
  if (current !== null && current.type === type) {
    return [
      ...unmarkOthers(graph, current.nodeId),
      ...(current.how === "named" ? [] : [{ op: "setNodeLabel", nodeId: current.nodeId, label: referenceNameFor(type) } as GraphPatchOperation]),
      { op: "setParameters", nodeId: current.nodeId, parameters: { file: media.reference, ...referenceParameters(type) } },
    ];
  }
  return [
    ...unmarkOthers(graph, null),
    {
      op: "addNode",
      ref: "$reference",
      type,
      position: besideTheGraph(graph),
      label: referenceNameFor(type),
      parameters: { file: media.reference, ...referenceParameters(type) },
    },
  ];
}

/** An existing media node made the reference: ONE patch. */
export function adoptReferenceOperations(graph: GraphDocument, nodeId: NodeId): GraphPatchOperation[] {
  const node = graph.nodes[nodeId];
  if (node === undefined || (node.type !== "movieFileIn" && node.type !== "audioFileIn")) return [];
  const type = node.type;
  return [
    ...unmarkOthers(graph, nodeId),
    ...(isNamedReference(node) ? [] : [{ op: "setNodeLabel", nodeId, label: referenceNameFor(type) } as GraphPatchOperation]),
    { op: "setParameters", nodeId, parameters: referenceParameters(type) },
  ];
}

/** The media nodes the reference picker offers: every movie or audio file node holding a file that has a clock. */
export function referenceCandidates(graph: GraphDocument): Array<{ nodeId: NodeId; name: string }> {
  return Object.values(graph.nodes)
    .filter((node) => node.type === "movieFileIn" || node.type === "audioFileIn")
    .filter((node) => !isStillPictureFile(storedStaticValue(node.parameters["file"])))
    .map((node) => ({ nodeId: node.id, name: node.label ?? node.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The file the reference holds, when it holds one as a plain or static value. */
export function referenceFile(graph: GraphDocument, reference: TimelineReference | null): string | null {
  if (reference === null) return null;
  const value = storedStaticValue(graph.nodes[reference.nodeId]?.parameters["file"]);
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Timeline ticks → the reference's media second, through its own transport: the position
 * `mediaPlayhead` gives the media node for the timeline second (§V436), so trim, speed, cue
 * and the at-end behaviour move the waveform exactly as they move the sound. Null where the
 * media is not showing (before the timeline start, past an end that holds nothing).
 */
export function mediaSecondsMapper(graph: GraphDocument, reference: TimelineReference, duration: number): (ticks: number) => number | null {
  const parameters = graph.nodes[reference.nodeId]?.parameters ?? {};
  const transport = mediaTransportFrom((key) => storedStaticValue(parameters[key]));
  return (ticks) => {
    if (ticks < 0) return null;
    const head = mediaPlayhead(transport, ticksToSeconds(ticks), duration);
    return head.visible ? head.position : null;
  };
}

/**
 * "Set project length from media": the range from the current start, `round(duration × fps)`
 * frames long, up to the one-day cap (VN71). There is no demuxer, so a video's frame count is
 * its duration × fps. `notice` says when the cap shortened it.
 */
export function rangeFromMedia(durationSeconds: number, fps: number, current: FrameRange): { range: FrameRange; notice: string | null } | null {
  const frames = Math.round(durationSeconds * fps);
  if (!(frames > 0)) return null;
  const start = Math.max(0, current.start);
  const wanted = start + frames - 1;
  const limit = frameRangeLimit(fps);
  return wanted > limit
    ? { range: { start, end: limit }, notice: rangeLimitSentence(wanted, fps) }
    : { range: { start, end: wanted }, notice: null };
}
