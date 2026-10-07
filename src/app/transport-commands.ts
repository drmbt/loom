import type { LoomBus } from "@domain/commands/bus.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import { projectFps } from "@domain/types/graph.ts";
import { frameRangeLimit, rangeLimitSentence } from "@domain/transport/range-limit.ts";
import { commandHolder } from "@domain/commands/command-holder.ts";
import { z } from "zod";
import { NO_INPUT } from "@domain/commands/input-schema.ts";

/**
 * Transport as a bus command (§V29, §V52, T184).
 *
 * `space` and `.` already named `transport.togglePlay` and `transport.stepFrame` in the
 * keymap defaults, and both reported unresolved: nothing registered them, correctly,
 * while no frame loop existed to act on. `useFrameLoop` is the only thing that holds a
 * `FrameDriver`, so — exactly like `graph.selectAll` and hover/selection state — the
 * owner of the state registers the command. The top bar's play/pause and step controls
 * call `bus.execute` too (never this holder directly), so the button and the hotkey
 * cannot drift into two different code paths for one action.
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /** Toggle the live frame loop. Reports the resulting play state. */
    "transport.togglePlay": { input: Record<string, never>; output: { playing: boolean } };
    /** Idempotent verbs (T292): an agent told "play" while playing must not pause. */
    "transport.play": { input: Record<string, never>; output: { playing: boolean } };
    "transport.pause": { input: Record<string, never>; output: { playing: boolean } };
    /** Render exactly `frames` (default 1) frames synchronously — across a timed structural cue, once its plan is installed (§T1544b). Reports the last frame index. */
    "transport.stepFrame": { input: { frames?: number }; output: { frameIndex: number } };
    /**
     * Jump to a frame (T265, VN71/T1687b, §V170 as amended).
     *
     * A seek RENDERS THE TARGET FRAME AND NOTHING ELSE, at any distance, and leaves temporal
     * state as it is — TouchDesigner's behaviour, by the owner's ruling (2026-10-07). It used
     * to replay from frame zero over cleared history, so a feedback graph showed its true state
     * at the target; that cost O(target) frames per seek and was why the range was capped at
     * 10 000 frames. Feedback depends on the previous frame: a graph with feedback, a Cache or
     * a point simulation that is sought carries on from what it holds, and 10 000 frames of
     * feedback are what PLAYING 10 000 frames gives. `runtime.resetFeedback` starts it over.
     *
     * A timeline that switches structure (§T1544b) still installs the target's plan before the
     * frame renders. A frame past the range cap (one day at the project rate) is refused, so a
     * typo reports rather than becoming a frame nobody meant.
     */
    "transport.seek": { input: { frameIndex: number }; output: { frameIndex: number } };
    /**
     * Loop the timeline's range (T433).
     *
     * SESSION state, not document state, and the line is the same one `playing` sits on:
     * whether the transport is currently cycling is a property of this playback, not of
     * the project. The RANGE it cycles is document state (`ProjectSettings.frameRange`),
     * because "how long is this piece" is exactly the kind of thing a `.loom.json` is for.
     *
     * A lap wraps the clock to the in point and nothing else (T464): playback across the out
     * point is continuous, so a feedback survives the wrap. It is not a seek.
     */
    "transport.toggleLoop": { input: Record<string, never>; output: { looping: boolean } };
  }
}

export interface TransportHandlers {
  isPlaying(): boolean;
  togglePlay(): void;
  stepFrame(frames: number): number;
  /**
   * Renders exactly one frame and hands back its INPUTS (T433).
   *
   * `stepFrame` reports an index, which is all a command result can carry. The offline
   * render path needs the `FrameEvaluationInput` itself: §V44 and the recorder's whole
   * contract are that a captured frame is labelled with the deterministic index the
   * render actually consumed, never one reconstructed alongside it.
   */
  stepOnce(): FrameInputs | null;
  /**
   * Jumps to `frameIndex` and renders it, leaving temporal state as it is (VN71, §V170 as
   * amended). Returns the frame it landed on.
   *
   * §T1544b: with a timeline that switches structure, the target frame renders in its own
   * segment's plan; when that plan is not installed the frame waits for it, and lands
   * asynchronously, after the command has returned the frame it will land on.
   */
  seek(frameIndex: number): number;
  /**
   * VN71 — clear ALL temporal state: the GPU's feedback pairs, rings and point buffers, and
   * the CPU's value-graph stages. A seek no longer does this, so the callers that start
   * fresh say so: a document load, and a take (a fresh performance, T467). Pair it with a
   * seek: the next frame rendered is the first frame of the new history.
   */
  resetState(): void;
  /**
   * §T1537b: resolves once the plan timeline frame `frameIndex` compiles in is the installed
   * one — a structural cue reached on that frame has switched — so a take awaits it before
   * stepping the frame. Immediate when no timeline switches structure.
   */
  prepareFrame?(frameIndex: number): Promise<void>;
  /**
   * T467: zero the ABSOLUTE clock — the render path's verb, never a live control's.
   * A take is a fresh performance; abstime inside a render counts from the take.
   *
   * VN71: `at` is the count the next frame carries (default 0). A take that starts at frame
   * `entry` (its in point, less its pre-roll) passes `entry`, so its in point carries the
   * in point's count however long the pre-roll, and the take's bytes do not depend on it.
   */
  resetAbsoluteClock(at?: number): void;
  /** T433 — is playback cycling the document's frame range? */
  isLooping(): boolean;
  /** Flips looping. Returns the resulting state. */
  toggleLoop(): void;
}

export interface TransportHolder {
  current: TransportHandlers | null;
}

export function transportHolderFor(bus: LoomBus): TransportHolder {
  return commandHolder<TransportHandlers>(bus, "transport.togglePlay");
}

/**
 * The refusal `space`, `.` and the top bar's buttons all land on when there is nothing to
 * drive (§V288, B48).
 *
 * A warning rather than info, and it names the cause rather than the symptom: "no frame
 * loop" on its own reads as a timing accident, when on a machine with no WebGPU it is the
 * permanent truth for the whole session. Silence was the old behaviour and it is what
 * made B48 look like a broken app instead of an unavailable feature.
 */
const NO_LOOP_DIAGNOSTIC = {
  severity: "warning" as const,
  code: "transport.noLoop",
  message: "No frame loop is attached, so there is nothing to play, step or seek.",
  suggestion:
    "The loop is created with the GPU device — a build with no WebGPU has no transport to run.",
};

export function registerTransportCommands(bus: LoomBus): TransportHolder {
  const holder = transportHolderFor(bus);

  if (!bus.hasCommand("transport.togglePlay")) {
    bus.registerCommand({
      name: "transport.togglePlay",
      inSession: "app",
      inputSchema: NO_INPUT,
      description: "Play or pause the live frame loop.",
      handler: (_input, context) => {
        if (holder.current === null) {
          return {
            status: "rejected",
            revision: context.store.getRevision(),
            diagnostics: [NO_LOOP_DIAGNOSTIC],
            output: { playing: false },
          };
        }
        if (!context.dryRun) holder.current.togglePlay();
        return {
          status: "applied",
          revision: context.store.getRevision(),
          output: { playing: holder.current.isPlaying() },
        };
      },
      rejectionOutput: () => ({ playing: false }),
    });
  }

  // T292: `play` and `pause` as their own verbs — the agent tools have named them since
  // T77, and "toggle" is the wrong contract for a caller that cannot see the current
  // state (an agent told "play" while playing must NOT pause).
  const registerVerb = (name: "transport.play" | "transport.pause", want: boolean): void => {
    if (bus.hasCommand(name)) return;
    bus.registerCommand<"transport.play">({
      name: name as "transport.play",
      inSession: "app",
      inputSchema: NO_INPUT,
      description: want ? "Start the frame loop (idempotent)." : "Stop the frame loop (idempotent).",
      handler: (_input, context) => {
        if (holder.current === null) {
          return {
            status: "rejected",
            revision: context.store.getRevision(),
            diagnostics: [NO_LOOP_DIAGNOSTIC],
            output: { playing: false },
          };
        }
        if (!context.dryRun && holder.current.isPlaying() !== want) holder.current.togglePlay();
        return {
          status: "applied",
          revision: context.store.getRevision(),
          output: { playing: holder.current.isPlaying() },
        };
      },
      rejectionOutput: () => ({ playing: false }),
    });
  };
  registerVerb("transport.play", true);
  registerVerb("transport.pause", false);

  if (!bus.hasCommand("transport.stepFrame")) {
    bus.registerCommand({
      name: "transport.stepFrame",
      inSession: "app",
      inputSchema: z.object({ frames: z.number().optional() }).strict(),
      description: "Render exactly one frame (or the given count) synchronously.",
      handler: (input, context) => {
        if (holder.current === null) {
          return {
            status: "rejected",
            revision: context.store.getRevision(),
            diagnostics: [NO_LOOP_DIAGNOSTIC],
            output: { frameIndex: -1 },
          };
        }
        const frames = Math.max(1, Math.trunc(input.frames ?? 1));
        const frameIndex = context.dryRun ? -1 : holder.current.stepFrame(frames);
        return { status: "applied", revision: context.store.getRevision(), output: { frameIndex } };
      },
      rejectionOutput: () => ({ frameIndex: -1 }),
    });
  }

  if (!bus.hasCommand("transport.seek")) {
    bus.registerCommand({
      name: "transport.seek",
      inSession: "app",
      inputSchema: z.object({ frameIndex: z.number() }).strict(),
      description:
        "Jump to a frame and render it. Temporal state (feedback, Cache, simulations) carries on from what it holds; runtime.resetFeedback clears it.",
      handler: (input, context) => {
        const revision = context.store.getRevision();
        if (holder.current === null) {
          return {
            status: "rejected",
            revision,
            diagnostics: [NO_LOOP_DIAGNOSTIC],
            output: { frameIndex: -1 },
          };
        }
        const target = Math.trunc(input.frameIndex);
        if (!Number.isFinite(target) || target < 0) {
          return {
            status: "rejected",
            revision,
            diagnostics: [
              {
                severity: "error" as const,
                code: "transport.seekRange",
                message: `Frame ${input.frameIndex} is not a frame.`,
              },
            ],
            output: { frameIndex: -1 },
          };
        }
        const fps = projectFps(context.store.getSettings());
        if (target > frameRangeLimit(fps)) {
          return {
            status: "rejected",
            revision,
            diagnostics: [
              {
                severity: "warning" as const,
                code: "transport.seekLimit",
                message: rangeLimitSentence(target, fps),
              },
            ],
            output: { frameIndex: -1 },
          };
        }
        const frameIndex = context.dryRun ? -1 : holder.current.seek(target);
        return { status: "applied", revision, output: { frameIndex } };
      },
      rejectionOutput: () => ({ frameIndex: -1 }),
    });
  }

  if (!bus.hasCommand("transport.toggleLoop")) {
    bus.registerCommand({
      name: "transport.toggleLoop",
      inSession: "app",
      inputSchema: NO_INPUT,
      description: "Loop playback over the timeline's in/out range.",
      handler: (_input, context) => {
        const revision = context.store.getRevision();
        if (holder.current === null) {
          return {
            status: "rejected",
            revision,
            diagnostics: [NO_LOOP_DIAGNOSTIC],
            output: { looping: false },
          };
        }
        if (!context.dryRun) holder.current.toggleLoop();
        return { status: "applied", revision, output: { looping: holder.current.isLooping() } };
      },
      rejectionOutput: () => ({ looping: false }),
    });
  }

  return holder;
}
