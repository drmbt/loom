import { EMPTY_CLIP_TRACK_JSON } from "../../domain/regions/model.ts";
import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { compileFittedMedia, MEDIA_IMAGE_FIT_PARAMETERS } from "./media.ts";

/**
 * VN101 — CLIP TRACK: REGIONS OF MEDIA ON THE TIMELINE, AS ONE TEXTURE.
 *
 * A track of regions (`src/domain/regions/`): pieces of media files placed in time, each
 * with its own in/out, play mode (loop, bounce, once and hold, once and clear), speed,
 * direction and optional BPM sync. At the playhead the node shows the region under it at the
 * source time `sourceTimeAt` derives, and is TRANSPARENT in a gap or after a once-and-clear
 * pass. Several tracks stack through the existing Layer node; this node composites nothing.
 *
 * The graph side is Movie File In's exactly: an external scratch texture keyed by
 * `mediaSourceIdFor(nodeId)` and the fitted blit (`compileFittedMedia`). What differs is what
 * the app registers behind that id — a player over a pool of media elements, one per region
 * near the playhead, the next one pre-rolled before its cut (`src/app/clip-track-player.ts`),
 * and a transparent frame in a gap. So the node is TIMELINE-ANCHORED by construction: the
 * picture is a pure function of the frame and the document (§V436), a scrub finds the same
 * frame every time, and there is no free-run mode to forget.
 *
 * The regions are ONE JSON text parameter (the `automation.lanes` and `cueList.cues`
 * precedent): an edit is one `setParameters`, so undo, autosave and the agent surface come
 * for free, and the regions editor (VN106) writes the same text.
 *
 * NOT YET RENDERED: the regions' `fadeIn` / `fadeOut`. They are stored, parsed and evaluated
 * (`regionOpacityAt`) but the blit draws every region at full opacity until a per-frame
 * opacity reaches the pass (named in the VN101 report).
 */

export const CLIP_TRACK_NODE_TYPE = "clipTrack";

export const clipTrackNode: NodeDefinition = {
  type: CLIP_TRACK_NODE_TYPE,
  version: 1,
  title: "Clip Track",
  category: "input",
  description:
    "A track of media regions on the timeline, Ableton-style: each region is a piece of a video file (its in and out) placed at a time for a length, and loops, bounces, plays once and holds, or plays once and clears to fill that length, at a speed or synced to a number of beats at Tempo, forwards or in reverse. At the playhead the node shows the region under it at the right frame and is transparent between regions. TIMELINE-ANCHORED: the picture follows the playhead, a scrub lands on the same frame every time, and a render reproduces. Stack several tracks with a Layer node.",
  tags: ["media", "video", "clip", "region", "track", "timeline", "arrangement", "loop", "resolume"],
  inputs: [],
  outputs: [{ id: "out", label: "Picture", type: RGBA_TEXTURE }],
  parameters: {
    track: {
      type: "code",
      language: "json",
      label: "Regions",
      default: EMPTY_CLIP_TRACK_JSON,
      description:
        "The track: { version: 1, id, name, regions: [{ id, media, sourceIn, sourceOut, timelineStart, length, playMode: loop|bounce|onceHold|onceClear, speed, direction: forward|reverse, bpmSync?: { beats }, fadeIn, fadeOut }] }. Times are ticks (240000 a second); sourceIn/sourceOut are in the media, timelineStart/length on the timeline. Regions are sorted and may not overlap. media is what Movie File In's File holds.",
    },
    tempo: {
      type: "number",
      label: "Tempo (BPM)",
      default: 120,
      min: 1,
      max: 999,
      range: "floor",
      description:
        "Beats per minute for regions with BPM sync: such a region plays its in..out span in exactly its number of beats at this tempo. Give it an expression to follow an audio node's declared tempo, e.g. op('audiofile_song').chan.bpm.",
    },
    ...MEDIA_IMAGE_FIT_PARAMETERS,
  },
  resolutionPolicy: { kind: "project" },
  compile: compileFittedMedia,
};
