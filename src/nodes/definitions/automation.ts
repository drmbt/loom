import { compileAutomation, evaluateLane } from "../../domain/automation/evaluate.ts";
import { EMPTY_AUTOMATION_JSON, nodeSpan } from "../../domain/automation/model.ts";
import { framesToTicks, rateOf, samplesToTicks, secondsToTicks } from "../../domain/time/ticks.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import { DEFAULT_PROJECT_FPS } from "../../domain/types/graph.ts";
import type { CompiledNodeDescription, NodeDefinition, ValueChannels } from "../../domain/types/node-definition.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import { VALUE_PORT } from "./common-ports.ts";

/**
 * VN61 (upstream T1456b) — AUTOMATION: KEYFRAMED LANES, EACH A CHANNEL.
 *
 * A value node whose lanes are bezier/ease curves over time, stored as one JSON text
 * parameter (`src/domain/automation/model.ts` defines the shape; the `cueList.cues`
 * precedent). Each lane publishes `op('<node>').chan.<lane name>`: the index looked up
 * against its curve, mapped to the lane's min..max. A lane is a dumb, labelled value — it
 * knows nothing about who reads it, and any number of parameters reference it by that
 * expression (Vincent, 2026-10-06). The value graph needs no per-type code for this:
 * `valueEvaluate` returns the bag and `op()` reads it like any other channel.
 *
 * THE INDEX. By default the PLAYHEAD: the timeline frame (it wraps at a loop and follows a
 * scrub, as the Timer does, §V436 — automation IS position in the piece), converted to
 * ticks once, here, exactly: frame N at 29.97 is N · 8 008 ticks, no float drift, because
 * the rate is recognised as 30000/1001 (`rateOf`). The rate the frame index counts at is
 * the project fps times its sub-frames (T1435b), so an accumulated render samples the
 * curve between frames. A transport that states no fps falls back to `timeSeconds`.
 *
 * Or an EXPRESSION in `indexValue`, read in a unit (TD's Animation COMP index): frames
 * at the project rate, seconds, samples at `sampleRate`, or a 0..1 fraction of the node's
 * span — ONE span for every lane (the lanes' `range`, else earliest key to latest across
 * all lanes, `nodeSpan`), so a fraction scrubs every lane to the same moment. A slider, an
 * LFO or another lane can scrub the curves this way.
 *
 * Pure (§V44, §V143): frame + parameters in, numbers out, no clock, no state. The parsed
 * lanes are memoised by their text (`compileAutomation`), so a frame costs a lookup and
 * a curve evaluation per lane. A lanes text that does not parse publishes NO channels, so
 * every reader reports the missing channel by name rather than reading a silent zero.
 */

export const AUTOMATION_NODE_TYPE = "automation";

export const AUTOMATION_INDEX_UNITS = ["playhead", "frames", "seconds", "samples", "fraction"] as const;
export type AutomationIndexUnit = (typeof AUTOMATION_INDEX_UNITS)[number];

const num = (value: ParameterValue | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * The playhead in ticks: exact for every broadcast rate. TIMELINE-ANCHORED (§V436): it reads
 * the wrapping clock on purpose, because a lane is where you are in the piece.
 */
export function playheadTicks(frame: FrameEvaluationInput): number {
  if (frame.fps === undefined || !(frame.fps > 0)) return secondsToTicks(frame.timeSeconds);
  const subframes = frame.subframes !== undefined && frame.subframes > 0 ? frame.subframes : 1;
  return framesToTicks(frame.frameIndex, rateOf(frame.fps * subframes));
}

/** The time, in ticks, the node's lanes are evaluated at this frame. */
export function automationIndexTicks(
  values: Readonly<Record<string, ParameterValue>>,
  frame: FrameEvaluationInput,
  span: readonly [number, number] | null,
): number {
  const unit = values["index"];
  const index = num(values["indexValue"], 0);
  switch (unit) {
    case "frames":
      return framesToTicks(index, rateOf(frame.fps !== undefined && frame.fps > 0 ? frame.fps : DEFAULT_PROJECT_FPS));
    case "seconds":
      return secondsToTicks(index);
    case "samples": {
      const rate = num(values["sampleRate"], 48_000);
      return rate > 0 ? samplesToTicks(index, rate) : 0;
    }
    case "fraction":
      return span === null ? 0 : span[0] + index * (span[1] - span[0]);
    default:
      return playheadTicks(frame);
  }
}

const indexIsPlayhead = (values: Readonly<Record<string, ParameterValue>>): string | null =>
  values["index"] === "playhead" || values["index"] === undefined ? "The index is the playhead; choose another unit to read this instead." : null;

export const automationNode: NodeDefinition = {
  type: AUTOMATION_NODE_TYPE,
  version: 1,
  title: "Automation",
  category: "value",
  description:
    "Keyframed lanes over time. Each lane is a curve of keys (bezier, linear, constant, stepped or one of many eases) with its own output range, and publishes its value under its own name: read it from any parameter as op('automation_score').chan.<lane>. Any number of parameters can reference one lane. The curves follow the playhead by default. TIMELINE-ANCHORED by design, like the Timer: a lane is a position IN the piece, so it wraps at a loop and follows a scrub, and playback and a render show the same values; set Index to read them from an expression instead, in frames, seconds, samples or a 0..1 fraction of the whole node's span, to scrub them with a slider or an LFO.",
  tags: ["automation", "keyframe", "keyframes", "curve", "animation", "timeline", "lane", "envelope", "bezier", "ease", "score"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    index: {
      type: "enum",
      label: "Index",
      default: "playhead",
      options: [
        { value: "playhead", label: "Playhead" },
        { value: "frames", label: "Frames" },
        { value: "seconds", label: "Seconds" },
        { value: "samples", label: "Samples" },
        { value: "fraction", label: "Fraction (0..1)" },
      ],
      description:
        "Where on the curves the lanes are read. Playhead follows the timeline. The others read Index Value in that unit: frames at the project rate, seconds, samples at Sample Rate, or a 0..1 fraction of the span from the earliest key to the latest across every lane.",
    },
    indexValue: {
      type: "number",
      label: "Index Value",
      default: 0,
      description: "The position to read the lanes at, in the Index unit. Give it an expression to scrub the curves, e.g. op('slider_scrub').chan.value.",
      inactiveWhen: indexIsPlayhead,
    },
    sampleRate: {
      type: "number",
      label: "Sample Rate",
      default: 48_000,
      min: 1,
      range: "floor",
      unit: "hz",
      description: "Samples per second when Index is Samples.",
      inactiveWhen: (values) => (values["index"] === "samples" ? null : "Only read when Index is Samples."),
    },
    lanes: {
      type: "code",
      language: "json",
      label: "Lanes",
      default: EMPTY_AUTOMATION_JSON,
      description:
        "The lanes: { version: 1, range?: [start, end], lanes: [{ id, name, color, min, max, clamp, pre, post, stepped, mute, lock, mutedValue?, keys: [{ id, t, v, interp, power?, handle, in: [dt, dv], out: [dt, dv] }] }] }. t is in ticks (240000 a second); v is 0..1 and maps to min..max; handles are (ticks, 0..1 value) offsets. name is the channel name and must be unique. The timeline edits this for you.",
    },
  },
  valueEvaluate: ({ values, frame }): ValueChannels => {
    const compiled = compileAutomation(values["lanes"]);
    if (!compiled.ok) return {};
    const ticks = automationIndexTicks(values, frame, nodeSpan(compiled.compiled.document));
    const channels: Record<string, number> = {};
    for (const lane of compiled.compiled.lanes) channels[lane.lane.name] = evaluateLane(lane, ticks);
    return channels;
  },
  compile: (): CompiledNodeDescription => ({ passes: [] }),
};
