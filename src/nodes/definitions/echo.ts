import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readNumber } from "./parameter-readers.ts";
import { CACHE_BLIT_WGSL } from "../shaders/cache.wgsl.ts";
import { ECHO_WGSL } from "../shaders/echo.wgsl.ts";

/**
 * Echo — the picture laid over its own past, a trail that fades a step at a time (T1402b).
 *
 * The On Nothing project built this as a Custom WGSL pass with a Feedback node wired back
 * into it (T1400b). This node OWNS its history instead, as Cache and Slit Scan do: a ring
 * (§V226) it writes its own output into, so nothing has to be wired back and the loop cannot
 * be wired wrong. Two passes: the echo reads the input and the ring's tap `delay` frames
 * back and writes the output; the record pass archives that output into the ring. Because
 * what is archived is the OUTPUT, the trail is recursive — every echo carries the ones
 * before it, each `amount` fainter.
 *
 * THE DELAY IS A VALUE, the depth is the allocation — Cache's split, for Cache's reason
 * (T1204): `delay` is a per-frame uniform and can be driven; `frames` is compile-time
 * because it is the size of the ring. A delay of d reads the echo from d frames ago, so the
 * copies sit d frames apart. Memory: width × height × bytes × `frames`, plus the write
 * target — 2 frames at 1080p rgba16float is ~47 MiB with it.
 *
 * FRAME 0 (§V229): with nothing archived yet the past is the present, so the first frame
 * after a load or a reset is the input unchanged, never black.
 */

/** Node-local key for the ring; the compiler namespaces it per node. */
export const ECHO_RING_KEY = "history";

/** The smallest ring that holds a one-frame echo. */
export const ECHO_DEFAULT_FRAMES = 2;

export const echoNode: NodeDefinition = {
  type: "echo",
  version: 1,
  title: "Echo",
  category: "temporal",
  description:
    "Lays the picture over its own past output, so moving things leave a fading trail; owns its history, no Feedback wiring needed.",
  tags: ["temporal", "echo", "trails", "delay", "feedback", "history", "ghost"],
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    amount: {
      type: "number",
      label: "Amount",
      default: 0.5,
      min: 0,
      max: 1,
      range: "bounded",
      description: "How much of the past stays in each frame: the length of the trail.",
    },
    darken: {
      type: "number",
      label: "Darken",
      default: 0,
      min: 0,
      max: 1,
      range: "bounded",
      description: "0 blends the trail; 1 keeps only what is darker than now, a dark smear across a light ground.",
    },
    delay: {
      type: "number",
      label: "Delay",
      default: 1,
      min: 1,
      max: 63,
      range: "bounded",
      step: 1,
      description: "Frames between echoes. Drivable; reaches at most Frames − 1.",
    },
    frames: {
      type: "number",
      label: "Frames",
      default: ECHO_DEFAULT_FRAMES,
      min: 2,
      max: 64,
      range: "bounded",
      step: 1,
      // Structural: it is the size of the allocation (§V8), exactly as on Cache.
      compileTime: true,
      description: "History held, which caps Delay. Each frame costs a full texture.",
    },
    resetPulse: {
      type: "pulse",
      label: "Reset Pulse",
      // §V123/§V126: scoped to THIS node's ring, the same wiring as Cache's.
      fires: "runtime.resetFeedback",
      input: { nodeIds: ["$node"] },
      description: "Clears the trail.",
    },
  },
  resolutionPolicy: { kind: "inherit", input: "input" },
  formatPolicy: { kind: "inherit", input: "input" },
  // §V46: its state is a pure function of the frames rendered, so a replay from frame 0
  // reproduces it; a seek cannot, which `randomAccess: false` says.
  stateful: { reset: true, deterministicReplay: true, checkpoint: false, randomAccess: false },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    const source = inputs["input"];
    if (target === undefined || source === undefined) {
      const what = target === undefined ? 'output port "out"' : 'input port "input"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }

    const frames = Math.max(2, Math.round(readNumber(parameters, "frames", ECHO_DEFAULT_FRAMES)));
    const requested = Math.max(1, Math.round(readNumber(parameters, "delay", 1)));
    // Cache's rule: a ring of N holds N-1 readable frames, and a deeper static tap is
    // clamped AND said, because "my 4-frame echo looks like a 1-frame one" is otherwise
    // indistinguishable from the node not working.
    const delay = Math.min(requested, frames - 1);
    const diagnostics =
      requested === delay
        ? []
        : [
            {
              severity: "warning" as const,
              code: "node.compile.tapClamped",
              message: `Node "${nodeId}" echoes ${requested} frames back from a ${frames}-frame history; the deepest it holds is ${frames - 1}.`,
              nodeId,
              suggestion: `Raise Frames above ${requested}, or lower Delay to ${frames - 1}.`,
            },
          ];

    const ring = scratchResourceId(nodeId, ECHO_RING_KEY);
    const echo: EffectPassDescriptor = {
      kind: "effect",
      // The id must NOT carry the delay: it is in the structure key, and the delay is a value.
      id: `${nodeId}:echo`,
      shader: ECHO_WGSL,
      target,
      textures: [
        { binding: "inputTexture", resourceId: source.resource },
        // The whole history as ONE array view; the tap is resolved in the shader (T425).
        { binding: "ringTexture", resourceId: ring, array: true },
      ],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      // The ring head trio is reserved at zero; the backend writes all three every frame
      // from the ring's own counters, by name, as it does for Cache.
      uniforms: {
        amount: readNumber(parameters, "amount", 0.5),
        darken: readNumber(parameters, "darken", 0),
        tap: delay,
        ringLatest: 0,
        ringWritten: 0,
        ringFrames: frames,
      },
      nodeId,
      label: "Echo",
    };
    // The record half is Cache's write verbatim, fed by this node's own OUTPUT: what is
    // archived is the echo, so the next frame's past already carries this frame's trail.
    const record: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:echo-record`,
      shader: CACHE_BLIT_WGSL,
      target: ring,
      textures: [{ binding: "inputTexture", resourceId: target }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      nodeId,
      label: "Echo Record",
    };
    return {
      passes: [echo, record],
      scratch: [{ key: ECHO_RING_KEY, kind: "ring", frames }],
      ...(diagnostics.length === 0 ? {} : { diagnostics }),
    };
  },
};
