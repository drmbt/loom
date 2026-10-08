import { pixelOf, sameBytes, testCard } from "./images.ts";
import type { StudyImage, StudyRun, StudyStep } from "./types.ts";

/**
 * VN91's reference set: one simple stateless effect, one time-animated effect, one
 * multi-pass/feedback effect, one with HSBA colour and event parameters, all pure-GL builds
 * from drmbt-custom-fx. Each case states exact claims derived from the plugin's own shader.
 * Every claim is a statement about the PLUGIN, so every backend that runs it must meet it. A
 * cross-backend comparison is separate and carries its own stated bound.
 */
export interface StudyClaim { readonly claim: string; readonly ok: boolean; readonly detail?: string }

export interface StudyCase {
  readonly id: string;
  readonly plugin: string;
  /** Why this case is in the set and what it exercises. */
  readonly why: string;
  run(size: { width: number; height: number }): StudyRun;
  /** Exact claims about the frames `run` captures. */
  claims(input: StudyImage, frames: readonly StudyImage[]): StudyClaim[];
  /** Whether a backend on its own clock (Resolume) can be compared byte-for-byte with this case. */
  readonly clockFree: boolean;
}

const step = (time: number, extra: Partial<StudyStep> = {}): StudyStep => ({ time, bpm: 120, barPhase: 0, ...extra });
const claim = (text: string, ok: boolean, detail?: string): StudyClaim => (detail === undefined ? { claim: text, ok } : { claim: text, ok, detail });
const corners = (image: StudyImage) => [[0, 0], [image.width - 1, 0], [0, image.height - 1], [image.width - 1, image.height - 1]] as const;
function centreMatches(input: StudyImage, frame: StudyImage, half = 4): boolean {
  const cx = Math.floor(frame.width / 2), cy = Math.floor(frame.height / 2);
  for (let y = cy - half; y < cy + half; y++) for (let x = cx - half; x < cx + half; x++)
    if (pixelOf(frame, x, y).join() !== pixelOf(input, x, y).join()) return false;
  return true;
}

export const REFERENCE_CASES: readonly StudyCase[] = [
  {
    id: "vignette-identity", plugin: "VignettePlus", clockFree: true,
    why: "Stateless single pass, no time. Size=1, Roundness=0, Ratio=1 puts every pixel 0.4 inside the SDF, so f=1 exactly: the effect is the identity.",
    run: ({ width, height }) => ({ input: testCard(width, height), capture: "last", steps: [step(0, { params: { Size: 1, Softness: 0.25, Roundness: 0, Ratio: 1, BlackBG: false } })] }),
    claims: (input, [frame]) => [claim("out == in, every byte", sameBytes(input, frame!))],
  },
  {
    id: "vignette-dark", plugin: "VignettePlus", clockFree: true,
    why: "The vignette at its smallest: Size=0, Softness=0 gives corners f=0 exactly and the centre f=1 exactly.",
    run: ({ width, height }) => ({ input: testCard(width, height), capture: "last", steps: [step(0, { params: { Size: 0, Softness: 0, Roundness: 0.5, Ratio: 0.5, BlackBG: false } })] }),
    claims: (input, [frame]) => [
      claim("corners are (0,0,0,0)", corners(frame!).every(([x, y]) => pixelOf(frame!, x, y).join() === "0,0,0,0")),
      claim("centre 8x8 == in", centreMatches(input, frame!)),
    ],
  },
  {
    id: "vignette-default", plugin: "VignettePlus", clockFree: true,
    why: "The plugin's own defaults: the frame a user sees when they drop the effect on. No analytic claim; it exists for cross-backend parity.",
    run: ({ width, height }) => ({ input: testCard(width, height), capture: "last",
      steps: [step(0, { params: { Size: 0.5, Softness: 0.25, Roundness: 0.5, Ratio: 0.5, BlackBG: false } })] }),
    claims: () => [],
  },
  {
    id: "grain-still", plugin: "StylizedGrain", clockFree: true,
    why: "Time-animated: grain frame = floor(time*Speed*48). With Speed=0 the grain is frozen, so two times give the same bytes. This is the one setting an oracle on its own clock can match.",
    run: ({ width, height }) => ({ input: testCard(width, height), capture: "each",
      steps: [step(1, { params: { Speed: 0 } }), step(2, { params: { Speed: 0 } })] }),
    claims: (_input, [one, two]) => [claim("t=1 == t=2 at Speed 0", sameBytes(one!, two!))],
  },
  {
    id: "grain-animated", plugin: "StylizedGrain", clockFree: false,
    why: "Time-animated: grain frame = floor(clock*Speed*48), so at Speed=0.5 it changes every 1/24 s. Six frames at 60 fps from t=1 must change grain, and a second fresh run must repeat them byte for byte. Both hold only if the host's time IS the plugin's clock (F1).",
    run: ({ width, height }) => ({ input: testCard(width, height), capture: "each",
      steps: Array.from({ length: 6 }, (_, i) => step(1 + i / 60, i === 0 ? { params: { Speed: 0.5 } } : {})) }),
    claims: (_input, frames) => [claim("grain moves within 5 frames (frame 0 != frame 5)", !sameBytes(frames[0]!, frames[5]!))],
  },
  {
    id: "figlet-phase", plugin: "FigletText", clockFree: true,
    why: "Phase-driven (Arena's Tunnel/Recolor pattern): a 0..1 wrapping Phase plus a Speed accumulator. With Speed stopped (its -1..1 fader at 0.5) the Phase fader alone drives the frame, so two hosts on different clocks can be compared EXACTLY. Also carries a text parameter and three HSBA quads.",
    run: ({ width, height }) => ({ input: testCard(width, height), capture: "each", steps: [
      step(0, { params: { Animate: true, "Anim Mode": 1, Speed: 0.5, Phase: 0 } }),
      step(0, { params: { Phase: 1 } }), step(0, { params: { Phase: 0.25 } }), step(0, { params: { Phase: 0 } })] }),
    claims: (_input, [zero, one, quarter, again]) => [
      claim("Phase 1 == Phase 0 (periodic)", sameBytes(zero!, one!)),
      claim("Phase 0.25 != Phase 0", !sameBytes(zero!, quarter!)),
      claim("Phase 0 again == Phase 0 (no hidden state)", sameBytes(zero!, again!)),
    ],
  },
  {
    id: "mosher-sequence", plugin: "glitch_mosher", clockFree: false,
    why: "Multi-pass with feedback: block-matched drag of the previous OUTPUT along motion in the INPUT, through ping-pong FBOs. A Keyframe pulse makes that frame the input verbatim; later frames depend on the whole history.",
    run: ({ width, height }) => {
      const steps: StudyStep[] = [];
      for (let i = 0; i < 12; i++)
        steps.push(step(i / 60, { input: testCard(width, height, i / 48),
          ...(i === 0 ? { params: { Mosh: 0.7, BlockSize: 0.35, Noise: 0.2, AutoKey: 0 }, pulses: ["Keyframe"] } : {}) }));
      return { input: testCard(width, height, 0), capture: "each", steps };
    },
    claims: (input, frames) => [
      claim("keyframe frame == its input", sameBytes(input, frames[0]!)),
      claim("later frames carry history (frame 11 != its input)", !sameBytes(testCard(input.width, input.height, 11 / 48), frames[11]!)),
    ],
  },
  {
    id: "toxic-palette", plugin: "ToxicCRT", clockFree: false,
    why: "HSBA colour quads (PaletteA/B) and an event (PaletteFlip, a sticky toggle). At one fixed host time only the flip changes between frames, so: before != after, and after == the next frame.",
    run: ({ width, height }) => {
      const params = { Mix: 1, Gain: 0.6, GrainAmt: 0, TrackingErr: 0, ScanMix: 0, CensorBar: 0,
        PaletteA: 0.36641, PaletteA_saturation: 1, PaletteA_brightness: 1, PaletteA_alpha: 1,
        PaletteB: 0.7585, PaletteB_saturation: 1, PaletteB_brightness: 1, PaletteB_alpha: 1 };
      return { input: testCard(width, height), capture: "each",
        steps: [step(1, { params }), step(1, { pulses: ["PaletteFlip"] }), step(1)] };
    },
    claims: (_input, [before, after, next]) => [
      claim("PaletteFlip changes the frame", !sameBytes(before!, after!)),
      claim("the flip is sticky: next frame == flipped frame", sameBytes(after!, next!)),
    ],
  },
];
