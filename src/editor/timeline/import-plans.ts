import { nodeNames } from "@domain/graph/names.ts";
import { roleFromText, withKind } from "@domain/graph/node-kinds.ts";
import type { ResolumeImport } from "@domain/import/resolume/composition.ts";
import { serializeClipTrack } from "@domain/regions/model.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { LtcLabImportPlan, RangeReader } from "@domain/import/ltc-lab/index.ts";
import { CLIP_TRACK_NODE_TYPE } from "@nodes/definitions/clip-track.ts";
import { isOfflineMedia } from "./clip-edits.ts";

/**
 * VN106 — THE TIMELINE'S IMPORTERS, as patches. Pure: the dialog reads the file and calls
 * the domain importer; these turn its result into ONE `graph.applyPatch`.
 *
 *  - Resolume (`importResolumeComposition`, VN102): a Clip Track node per proposed track,
 *    named for its Resolume layer (`cliptrack_<layer>`), holding the proposal's regions
 *    and the composition's tempo. Imported media are filesystem paths no page can open,
 *    so those regions are OFFLINE until relinked (counted in the summary).
 *  - ltc-lab (`planLtcLabImport`, VN100): the plan's own operations, with the track's
 *    audio bound into the audio node's `file` the way `attach_asset` binds it (an object
 *    URL with the name in the fragment).
 */

/** Where the imported nodes go: right of everything, so they land on empty canvas. */
export function freeOrigin(graph: GraphDocument): { x: number; y: number } {
  const nodes = Object.values(graph.nodes);
  if (nodes.length === 0) return { x: 0, y: 0 };
  return { x: Math.max(...nodes.map((node) => node.position.x)) + 320, y: Math.min(...nodes.map((node) => node.position.y)) };
}

/** A composition with nothing a clip track can hold. */
export const NOTHING_TO_IMPORT = "Nothing to import: the composition has no file clips on a timeline.";

/** Vertical distance between the imported clip track nodes. */
export const IMPORTED_TRACK_SPACING = 140;

/** `cliptrack_<layer>`, unique in the graph and in this import. */
function trackName(layerName: string, deckName: string, decks: number, taken: Set<string>): string {
  const role = roleFromText(decks > 1 ? `${deckName} ${layerName}` : layerName).toLowerCase().replace(/^(\d)/, "l$1");
  const base = withKind("cliptrack", role === "" ? "layer" : role);
  let name = base;
  for (let ordinal = 2; taken.has(name); ordinal += 1) name = `${base}${ordinal}`;
  taken.add(name);
  return name;
}

/** The patch for a Resolume import: one Clip Track node per proposed track. */
export function resolumeImportOperations(graph: GraphDocument, imported: ResolumeImport, origin = freeOrigin(graph)): GraphPatchOperation[] {
  const taken = new Set(nodeNames(graph).keys());
  const decks = new Set(imported.tracks.map((proposal) => proposal.deck)).size;
  return imported.tracks.map((proposal, index) => ({
    op: "addNode",
    ref: `$clipTrack${index}`,
    type: CLIP_TRACK_NODE_TYPE,
    position: { x: origin.x, y: origin.y + index * IMPORTED_TRACK_SPACING },
    label: trackName(proposal.layerName, proposal.deckName, decks, taken),
    parameters: { track: serializeClipTrack(proposal.track), tempo: imported.tempo },
  }) as GraphPatchOperation);
}

/** What the preview says before anything is applied. */
export interface ResolumeSummary {
  readonly tracks: number;
  readonly regions: number;
  readonly offline: number;
  readonly lines: readonly string[];
  /** One line per kind of clip left behind, with a count and a few examples. */
  readonly notImported: readonly string[];
}

export function resolumeSummary(imported: ResolumeImport): ResolumeSummary {
  const regions = imported.tracks.flatMap((proposal) => proposal.track.regions);
  const offline = regions.filter((region) => isOfflineMedia(region.media)).length;
  const modes = Object.entries(imported.counts.byPlayMode).filter(([, count]) => count > 0).map(([mode, count]) => `${count} ${mode}`).join(", ");
  const byKind = new Map<string, string[]>();
  for (const entry of imported.notImported) {
    const list = byKind.get(entry.kind) ?? [];
    list.push(entry.clip);
    byKind.set(entry.kind, list);
  }
  return {
    tracks: imported.tracks.length,
    regions: regions.length,
    offline,
    lines: [
      `"${imported.name}" at ${imported.tempo} BPM: ${imported.counts.clips} clips, ${imported.counts.fileClips} from files.`,
      `${regions.length} regions on ${imported.tracks.length} tracks (${modes || "none"}; ${imported.counts.reverse} reverse, ${imported.counts.bpmSync} BPM-synced, ${imported.counts.trimmed} trimmed).`,
      ...(imported.dropped.length > 0 ? [`${imported.dropped.length} settings regions cannot carry were dropped (beat loop, paused direction, sync speed, autopilot).`] : []),
      ...(offline > 0 ? [`${offline} regions name files on disk the browser cannot open: they import OFFLINE until relinked (drop the file, or its transcoded proxy, on the region).`] : []),
    ],
    notImported: [...byKind].map(([kind, clips]) => `${clips.length} ${kind}: ${clips.slice(0, 3).join(", ")}${clips.length > 3 ? ", …" : ""}`),
  };
}

/** The ltc-lab plan's operations with its audio bound to `url` (when there is audio). */
export function ltcLabOperations(plan: LtcLabImportPlan, url: string | null): GraphPatchOperation[] {
  return plan.operations.map((op) =>
    url !== null && op.op === "addNode" && op.ref === plan.refs.audio ? { ...op, parameters: { ...op.parameters, file: url } } : op,
  );
}

/** A File read by byte ranges (`Blob.slice`), for the tar reader. */
export function fileReader(file: Blob): RangeReader {
  return {
    size: () => Promise.resolve(file.size),
    read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
  };
}

