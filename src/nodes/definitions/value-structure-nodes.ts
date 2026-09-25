import type { CompiledNodeDescription, NodeDefinition, StatefulDeclaration } from "../../domain/types/node-definition.ts";
import { VALUE_PORT } from "./common-ports.ts";
import { evaluateExpression, parseExpression, scopeFromFrame } from "../../domain/expressions/evaluate.ts";
import { readCompileInputs } from "./compile-context.ts";

/**
 * T1370b — the STRUCTURE nodes: what a track is doing over seconds, not over a frame.
 *
 * The value family could smooth, rank, gate and shape a signal, and nothing in it could
 * answer "is this building?", "how busy is it?", "did the section just change?" or "how long
 * since the last cut?". These are the pieces a director is made of, each generic — none of
 * them knows it is looking at audio:
 *
 *  - Trend    the fitted rise of each channel across a window (least squares) — a build-up
 *             is a sustained positive trend of energy and brightness;
 *  - Rate     each channel's sum across a window ÷ the window — a per-frame count channel
 *             (onsetCount, kickCount) becomes events per second, i.e. density;
 *  - Novelty  how far the recent mean of ALL channels has moved from the stretch before it —
 *             fed the spectrum bands, it spikes at section changes;
 *  - Count    rising crossings of a threshold, with a hold-off, and the seconds since the
 *             last one — a cut counter and a shot clock;
 *  - Delay    each channel as it was N frames ago — the previous camera for motion blur
 *             once the camera is driven by the music rather than by the clock alone;
 *  - Expression  new channels computed from the WIRED channels by named expressions — the
 *             logic between them (a cut gate, a shot pick), because a value node's own
 *             parameters resolve without channels (value-graph.ts): wiring, not references.
 *
 * All are DELTA-DRIVEN (§V436): they keep their own clock by summing the frame step, so a
 * timeline loop passes through them intact, and they reset with the transport (§V181).
 */

const noPasses = (): CompiledNodeDescription => ({ passes: [] });

const STRUCTURE_STATEFUL: StatefulDeclaration = {
  reset: true,
  deterministicReplay: true,
  checkpoint: false,
  randomAccess: false,
};

const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** The node's own clock: the sum of the frame steps it has seen. */
function advance(state: Record<string, unknown>, delta: number): number {
  const clock = num(state["clock"], 0) + Math.max(0, delta);
  state["clock"] = clock;
  return clock;
}

interface Sample {
  readonly t: number;
  readonly v: number;
}

/** Per-channel history, trimmed to the `window` seconds ending at `now`. */
function remember(state: Record<string, unknown>, name: string, now: number, value: number, window: number, delta: number): Sample[] {
  const histories = (state["histories"] ??= {}) as Record<string, Sample[]>;
  const samples = (histories[name] ??= []);
  // A frame with no elapsed time adds no sample: it occupies no interval of the window.
  if (delta > 0 || samples.length === 0) samples.push({ t: now, v: value });
  // The window is (now − window, now]: exactly window × fps samples at a steady rate.
  while (samples.length > 0 && samples[0]!.t <= now - window + 1e-9) samples.shift();
  return samples;
}

const WINDOW = (label: string, fallback: number, description: string) =>
  ({
    type: "number" as const,
    label,
    default: fallback,
    min: 0.005,
    max: 120,
    step: 0.005,
    range: "floor" as const,
    unit: "seconds" as const,
    description,
  });

export const valueTrendNode: NodeDefinition = {
  type: "valueTrend",
  version: 1,
  title: "Trend",
  category: "value",
  description:
    "Fits a straight line through each channel's last Window seconds (least squares) and publishes how much it RISES across that window — positive while a signal climbs, negative while it falls, near zero while it holds, however noisy. Fed a smoothed energy or brightness, a sustained positive trend is a build-up. DELTA-DRIVEN (§V436).",
  tags: ["value", "trend", "slope", "regression", "build-up", "structure"],
  inputs: [{ id: "in", label: "In", type: VALUE_PORT }],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    window: WINDOW("Window", 8, "Seconds of history the line is fitted through. Longer is steadier and later; a build-up of eight bars wants several seconds."),
  },
  stateful: STRUCTURE_STATEFUL,
  valueEvaluate: ({ inputs, values, frame, state }) => {
    const window = Math.max(0.005, num(values["window"], 8));
    const now = advance(state, frame.deltaSeconds);
    const out: Record<string, number> = {};
    for (const [name, value] of Object.entries(inputs["in"] ?? {})) {
      const samples = remember(state, name, now, value, window, frame.deltaSeconds);
      if (samples.length < 2) {
        out[name] = 0;
        continue;
      }
      let meanT = 0;
      let meanV = 0;
      for (const sample of samples) {
        meanT += sample.t;
        meanV += sample.v;
      }
      meanT /= samples.length;
      meanV /= samples.length;
      let covariance = 0;
      let variance = 0;
      for (const sample of samples) {
        covariance += (sample.t - meanT) * (sample.v - meanV);
        variance += (sample.t - meanT) * (sample.t - meanT);
      }
      // The fitted slope × the window: the rise the line makes across the whole window.
      out[name] = variance > 0 ? (covariance / variance) * window : 0;
    }
    return out;
  },
  compile: noPasses,
};

export const valueRateNode: NodeDefinition = {
  type: "valueRate",
  version: 1,
  title: "Rate",
  category: "value",
  description:
    "Each channel's sum over the last Window seconds, divided by the window: a per-frame COUNT channel (onsetCount, kickCount — 1 on the frame of a hit, 0 otherwise) becomes events per second. How busy the music is, as a number that does not flicker with every hit. DELTA-DRIVEN (§V436).",
  tags: ["value", "rate", "density", "per second", "events", "structure"],
  inputs: [{ id: "in", label: "In", type: VALUE_PORT }],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    window: WINDOW("Window", 4, "Seconds counted over. Two bars is a good density; shorter reacts faster and flickers more."),
  },
  stateful: STRUCTURE_STATEFUL,
  valueEvaluate: ({ inputs, values, frame, state }) => {
    const window = Math.max(0.005, num(values["window"], 4));
    const now = advance(state, frame.deltaSeconds);
    const out: Record<string, number> = {};
    for (const [name, value] of Object.entries(inputs["in"] ?? {})) {
      const samples = remember(state, name, now, value, window, frame.deltaSeconds);
      let sum = 0;
      for (const sample of samples) sum += sample.v;
      out[name] = sum / window;
    }
    return out;
  },
  compile: noPasses,
};

export const valueNoveltyNode: NodeDefinition = {
  type: "valueNovelty",
  version: 1,
  title: "Novelty",
  category: "value",
  description:
    "Compares the mean of ALL input channels over the last Recent seconds with their mean over the Reference seconds before that, and publishes one channel, novelty: the relative distance between the two (0 = the same sound, towards 1 = a different one). Fed the spectrum bands, it spikes where a section changes. DELTA-DRIVEN (§V436).",
  tags: ["value", "novelty", "section", "change", "segmentation", "structure"],
  inputs: [{ id: "in", label: "In", type: VALUE_PORT }],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    recent: WINDOW("Recent", 2, "Seconds that stand for 'now'."),
    reference: WINDOW("Reference", 8, "Seconds before 'now' that stand for 'what it was'."),
  },
  stateful: STRUCTURE_STATEFUL,
  valueEvaluate: ({ inputs, values, frame, state }) => {
    const recent = Math.max(0.005, num(values["recent"], 2));
    const reference = Math.max(0.005, num(values["reference"], 8));
    const now = advance(state, frame.deltaSeconds);
    let distance = 0;
    let magnitude = 0;
    for (const [name, value] of Object.entries(inputs["in"] ?? {})) {
      const samples = remember(state, name, now, value, recent + reference, frame.deltaSeconds);
      let recentSum = 0;
      let recentCount = 0;
      let referenceSum = 0;
      let referenceCount = 0;
      for (const sample of samples) {
        if (sample.t > now - recent + 1e-9) {
          recentSum += sample.v;
          recentCount += 1;
        } else {
          referenceSum += sample.v;
          referenceCount += 1;
        }
      }
      if (recentCount === 0 || referenceCount === 0) continue;
      const a = recentSum / recentCount;
      const b = referenceSum / referenceCount;
      distance += Math.abs(a - b);
      magnitude += Math.abs(a) + Math.abs(b);
    }
    return { novelty: magnitude > 0 ? distance / magnitude : 0 };
  },
  valueChannelMeta: { novelty: { kind: "bounded", low: 0, high: 1 } },
  compile: noPasses,
};

export const valueCountNode: NodeDefinition = {
  type: "valueCount",
  version: 1,
  title: "Count",
  category: "value",
  description:
    "Counts each channel's upward crossings of Threshold, ignoring any that come within Hold-off seconds of the last, and publishes <name> (the count) and <name>Since (seconds since the last one). A cut counter and a shot clock in one. DELTA-DRIVEN (§V436).",
  tags: ["value", "count", "counter", "since", "clock", "cut", "structure"],
  inputs: [{ id: "in", label: "In", type: VALUE_PORT }],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    threshold: { type: "number", label: "Threshold", default: 0.5, description: "A crossing from below to at-or-above this counts." },
    holdoff: { ...WINDOW("Hold-off", 0.25, "Seconds after a count during which no other counts — the minimum spacing."), min: 0 },
  },
  stateful: STRUCTURE_STATEFUL,
  valueEvaluate: ({ inputs, values, frame, state }) => {
    const threshold = num(values["threshold"], 0.5);
    const holdoff = Math.max(0, num(values["holdoff"], 0.25));
    const now = advance(state, frame.deltaSeconds);
    const counters = (state["counters"] ??= {}) as Record<string, { count: number; last: number; below: boolean }>;
    const out: Record<string, number> = {};
    for (const [name, value] of Object.entries(inputs["in"] ?? {})) {
      const counter = (counters[name] ??= { count: 0, last: -Infinity, below: true });
      if (value >= threshold) {
        // The clock is a float sum of frame steps: a hold-off of exactly n frames must pass.
        if (counter.below && now - counter.last >= holdoff - 1e-9) {
          counter.count += 1;
          counter.last = now;
        }
        counter.below = false;
      } else {
        counter.below = true;
      }
      out[name] = counter.count;
      out[`${name}Since`] = Number.isFinite(counter.last) ? now - counter.last : now;
    }
    return out;
  },
  compile: noPasses,
};

export const valueDelayNode: NodeDefinition = {
  type: "valueDelay",
  version: 1,
  title: "Delay",
  category: "value",
  description:
    "Publishes each channel as it was Frames frames ago (the earliest value until that much history exists). One frame back is the PREVIOUS value of anything — a camera driven by the music, for a motion blur that needs where it just was.",
  tags: ["value", "delay", "previous", "history", "frames"],
  inputs: [{ id: "in", label: "In", type: VALUE_PORT }],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    frames: { type: "number", label: "Frames", default: 1, min: 1, max: 600, step: 1, range: "bounded", description: "How many frames back." },
  },
  stateful: STRUCTURE_STATEFUL,
  valueEvaluate: ({ inputs, values, state }) => {
    const frames = Math.max(1, Math.round(num(values["frames"], 1)));
    const histories = (state["delays"] ??= {}) as Record<string, number[]>;
    const out: Record<string, number> = {};
    for (const [name, value] of Object.entries(inputs["in"] ?? {})) {
      const history = (histories[name] ??= []);
      history.push(value);
      while (history.length > frames + 1) history.shift();
      // The oldest held value: exactly `frames` back once the history is full, the first
      // value seen until then.
      out[name] = history[0]!;
    }
    return out;
  },
  compile: noPasses,
};

/** `name = expr; name2 = expr2` → [name, expr] pairs, in order. Blank statements are skipped. */
export function parseExpressionStatements(source: string): Array<{ name: string; expression: string } | { error: string }> {
  return source
    .split(/[;\n]/)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "")
    .map((statement) => {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*(.+)$/.exec(statement);
      if (match === null) return { error: `"${statement}" is not \`name = expression\`` };
      const parsed = parseExpression(match[2]!);
      if (!parsed.ok) return { error: `${match[1]}: ${parsed.reason}` };
      return { name: match[1]!, expression: match[2]! };
    });
}

export const valueExpressionNode: NodeDefinition = {
  type: "valueExpression",
  version: 1,
  title: "Expression",
  category: "value",
  description:
    "New channels computed from the channels wired into In, one per statement: `cut = (beatCount % 16 == 0) * (beatCountSince < 0.04); pool = level > 0.5`. Every incoming channel is a name the expressions can read (bags from several wires merge), beside the clocks (time, abstime, delta, frame). The logic BETWEEN value nodes — a gate, a pick, a blend — which a value node's own parameters cannot express, because they resolve without channels. A statement that fails this frame (an unknown name) publishes nothing.",
  tags: ["value", "expression", "math", "logic", "gate", "chop"],
  inputs: [{ id: "in", label: "In", type: VALUE_PORT, optional: true, variadic: true }],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    expressions: {
      type: "string",
      label: "Expressions",
      default: "value = 0",
      description: "Statements `name = expression`, separated by `;` or new lines. Each name becomes an output channel, in order.",
    },
    defaults: {
      type: "string",
      label: "Defaults",
      default: "",
      description:
        "Statements `name = expression` giving a name its value when no wire carries it: a channel that does not exist yet (a counter before its first event, a tempo the analysis could not claim) reads this instead of failing the statements that use it. A wired channel of the same name always wins.",
    },
  },
  valueEvaluate: ({ inputs, values, frame }) => {
    const source = typeof values["expressions"] === "string" ? (values["expressions"] as string) : "";
    // Defaults first, so every wired channel of the same name overrides its default.
    const fallback: Record<string, number> = {};
    const defaults = typeof values["defaults"] === "string" ? (values["defaults"] as string) : "";
    for (const statement of parseExpressionStatements(defaults)) {
      if ("error" in statement) continue;
      const result = evaluateExpression(statement.expression, scopeFromFrame(frame, fallback));
      if (result.ok && Number.isFinite(result.value)) fallback[statement.name] = result.value;
    }
    const channels: Record<string, number> = { ...fallback, ...(inputs["in"] ?? {}) };
    const out: Record<string, number> = {};
    for (const statement of parseExpressionStatements(source)) {
      if ("error" in statement) continue;
      // Earlier statements are readable by later ones, like lines of a small program.
      const result = evaluateExpression(statement.expression, scopeFromFrame(frame, { ...channels, ...out }));
      if (result.ok && Number.isFinite(result.value)) out[statement.name] = result.value;
    }
    return out;
  },
  compile(context): CompiledNodeDescription {
    const { nodeId, parameters } = readCompileInputs(context as Parameters<typeof readCompileInputs>[0]);
    const source = typeof parameters["expressions"] === "string" ? (parameters["expressions"] as string) : "";
    const defaults = typeof parameters["defaults"] === "string" ? (parameters["defaults"] as string) : "";
    const errors = [...parseExpressionStatements(source), ...parseExpressionStatements(defaults)].flatMap((statement) => ("error" in statement ? [statement.error] : []));
    return {
      passes: [],
      ...(errors.length === 0
        ? {}
        : {
            diagnostics: errors.map((error) => ({
              severity: "error" as const,
              code: "node.valueExpression.syntax",
              message: `Node "${nodeId}": ${error}.`,
              nodeId,
            })),
          }),
    };
  },
};

export const valueStructureNodeDefinitions: readonly NodeDefinition[] = [
  valueTrendNode,
  valueRateNode,
  valueNoveltyNode,
  valueCountNode,
  valueDelayNode,
  valueExpressionNode,
];
