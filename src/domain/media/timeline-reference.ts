import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import { kindOfType, roleOf, withKind } from "../graph/node-kinds.ts";
import { storedStaticValue } from "../parameters/slots.ts";

/**
 * VN64 — WHICH MEDIA NODE IS THE TIMELINE'S REFERENCE (the video or track the piece is
 * scored against: its waveform is drawn under the lanes, and "set project length from
 * media" reads its duration).
 *
 * MARKED BY NAME, NOT BY A FIELD (ruled 2026-10-08): the reference is the Movie File In /
 * Audio File In whose role is `reference` (`movie_reference`, `audiofile_reference`). It
 * touches no document type, it is visible on the canvas, and `op('movie_reference')` reads
 * as what it is. Renaming the node away from the role un-marks it. When no node carries the
 * role, the reference is the ONE media node locked to the timeline, if there is exactly one
 * (a fresh project with one track dropped in needs no ceremony).
 *
 * VN72 (media placed in SMPTE time) is where a real field replaces this name convention:
 * once media items carry a start timecode they are document objects of their own, and the
 * reference becomes one of them rather than a name. Until then this function is the ONE
 * place the rule lives; the timeline, the ltc-lab import and the regions lane call it
 * rather than re-derive it.
 */

export const REFERENCE_ROLE = "reference";

export type ReferenceMediaType = "movieFileIn" | "audioFileIn";

const MEDIA_TYPES: readonly ReferenceMediaType[] = ["movieFileIn", "audioFileIn"];

/** `movie_reference` / `audiofile_reference`, from the kind table, so a kind change follows. */
export function referenceNameFor(type: ReferenceMediaType): string {
  return withKind(kindOfType(type), REFERENCE_ROLE);
}

export interface TimelineReference {
  readonly nodeId: NodeId;
  readonly type: ReferenceMediaType;
  /** The node's name as stored. */
  readonly name: string;
  /** Marked by its role, or the only timeline-locked media node. */
  readonly how: "named" | "onlyLocked";
  /** Set when the choice was not unique: the sentence to show, naming the one chosen. */
  readonly warning: string | null;
}

const isMediaType = (type: string): type is ReferenceMediaType => (MEDIA_TYPES as readonly string[]).includes(type);

/** True when the node's play mode is stored as the timeline lock. The default is free run (T586). */
export function isTimelineLocked(node: Pick<GraphNode, "parameters">): boolean {
  return storedStaticValue(node.parameters["playMode"]) === "timeline";
}

/** True when this node carries the reference role for its type. */
export function isNamedReference(node: Pick<GraphNode, "type" | "label">): boolean {
  if (!isMediaType(node.type) || node.label === undefined) return false;
  return roleOf(node.label, kindOfType(node.type)) === REFERENCE_ROLE;
}

/** The timeline's reference media node, by the rule above, or null when there is none. */
export function timelineReferenceOf(graph: GraphDocument): TimelineReference | null {
  const media = Object.values(graph.nodes)
    .filter((node): node is GraphNode & { type: ReferenceMediaType } => isMediaType(node.type))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const named = media.filter(isNamedReference);
  const chosen = named[0];
  if (chosen !== undefined) {
    const others = named.slice(1).map((node) => node.label ?? node.id);
    return {
      nodeId: chosen.id,
      type: chosen.type,
      name: chosen.label ?? chosen.id,
      how: "named",
      warning: others.length === 0
        ? null
        : `${named.length} media nodes are named as the reference; the timeline uses "${chosen.label}". Rename ${others.map((name) => `"${name}"`).join(", ")} to choose one.`,
    };
  }
  const locked = media.filter(isTimelineLocked);
  if (locked.length !== 1) return null;
  const only = locked[0]!;
  return { nodeId: only.id, type: only.type, name: only.label ?? only.id, how: "onlyLocked", warning: null };
}
