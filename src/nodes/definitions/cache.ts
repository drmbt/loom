import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readFlag, readNumber } from "./parameter-readers.ts";
import { CACHE_BLIT_WGSL, CACHE_READ_WGSL } from "../shaders/cache.wgsl.ts";

/**
 * Cache — holds the last N frames and reads one of them back (T237). TD's Cache TOP.
 *
 * Feedback gives you frame t-1 and nothing else. Everything past that has meant chaining
 * Feedback nodes, which costs TWO textures per frame of depth (a pair each) and one node
 * per tap. A ring costs ONE texture per frame of depth and every tap in between comes
 * free — 4 slices at 1080p rgba16float is 63 MiB against 95 MiB for three chained
 * Feedbacks that reach no further.
 *
 * THE MEMORY IS THE PARAMETER (§V228), so it is stated rather than discovered:
 *
 *   bytes = width × height × bytesPerPixel × frames
 *
 * At 1080p rgba16float a frame is 15.8 MiB. The defaults — 8 frames at half scale — cost
 * about 32 MiB, which is what dropping this node should cost. The same node at 60 frames
 * and full scale is 949 MiB, 93% of the default project budget, and the compiler's budget
 * warning will say so. Both are legitimate; only one of them should be the default.
 *
 * THE TAP IS A VALUE, and `frames` is the allocation — the two are separate on purpose
 * (T1204). Everything above this line said the opposite for four months: "the tap is
 * STRUCTURAL … animating the index needs a texture-array binding this deliberately does
 * not". T425 gave it exactly that binding — the read pass has bound the ring as ONE
 * `texture_2d_array` with the tap resolved IN the shader from a uniform ever since — and
 * nobody came back to the prose. It cost §T1149 a session and §T1153 a row; it is fixed
 * here rather than annotated.
 *
 * So `index` is an ordinary per-frame uniform (§V5): an LFO, an audio band, or an async
 * source publishing its own lag can drive it, and the picture moves without a rebuild.
 * `frames` stays `compileTime` because it is the SIZE OF THE ALLOCATION, and that is the
 * whole reason the two are different parameters — a drivable tap must not quietly make
 * anyone pay for 64 frames of texture to reach a tap of 3. Per-PIXEL offsets are still a
 * different node (slit-scan, T321); this is one offset for the whole image.
 *
 * A tap counts ARCHIVED RENDERS, not project frame numbers. Async alignment therefore
 * needs the source's age in the same history; project frames may skip or wrap while this
 * ring advances once per rendered input. Index 0 reads the current write target.
 *
 * ⚠ SIZE `frames` FOR THE DEEPEST LAG YOU EXPECT, not for the typical one. A tap beyond
 * the history normally clamps to the oldest slice, and for a STATIC tap the compiler says so
 * (`node.compile.tapClamped`, below). A DRIVEN one gets no such warning, because the
 * structural compile only ever sees the retained static and the per-frame compiles are
 * value pushes whose diagnostics nothing reads — so a 24-frame lag driving an 8-frame ring
 * is a silent 7-frame delay. Strict History preserves the requested tap and returns
 * transparent pixels when that exact archived render is unavailable instead.
 *
 * By default, an empty ring passes the current input through and a filling ring holds its
 * oldest available slice (§V229). Strict History makes an unavailable positive tap
 * transparent, including immediately after reset; tap 0 always reads the current input.
 */

/** Node-local key for the ring; the compiler namespaces it per node. */
export const CACHE_RING_KEY = "history";

/** §V228: the default depth. Eight frames is a visible echo without a visible bill. */
export const CACHE_DEFAULT_FRAMES = 8;

/** §V228: half resolution by default — a cache is read for its TIME axis, not its detail. */
export const CACHE_DEFAULT_SCALE = 0.5;

export const cacheNode: NodeDefinition = {
  type: "cache",
  version: 1,
  title: "Cache",
  category: "temporal",
  description:
    "Holds the last N frames and outputs one of them. Cost is width × height × bytes × frames — 8 half-scale frames is ~32 MB at 1080p.",
  tags: ["temporal", "delay", "trails", "history"],
  inputs: [
    {
      id: "input",
      label: "Picture",
      type: RGBA_TEXTURE,
      description: "Written into the ring every frame.",
    },
  ],
  outputs: [
    {
      id: "out",
      label: "Delayed",
      type: RGBA_TEXTURE,
      description: "The input `index` rendered frames ago. Unavailable history holds the oldest input, or is transparent with Strict History.",
    },
  ],
  parameters: {
    frames: {
      type: "number",
      label: "Frames",
      default: CACHE_DEFAULT_FRAMES,
      min: 2,
      max: 64,
      range: "bounded",
      // Structural: it is the size of the allocation. A ring that could be resized by a
      // uniform would be a ring that reallocates mid-frame (§V8).
      compileTime: true,
      description: "How many frames to hold. Each one costs a full texture — see the node's docs.",
    },
    index: {
      type: "number",
      label: "Index",
      default: 1,
      min: 0,
      max: 63,
      range: "floor",
      // T1047: frames back is a count, so the step is 1. See the note on Switch's index.
      step: 1,
      // T1204: NOT compileTime. The tap is a number in the read pass's uniform block and
      // has been since T425; driving it writes four bytes, never a pipeline (§V5). The
      // shader holds the oldest available frame by default. Strict History instead
      // returns transparent pixels for an unavailable exact tap.
      description:
        "How many rendered inputs back to read. 0 is current; 1 is previous, like Feedback. Drivable; use an age measured in the same rendered history for alignment.",
    },
    strictHistory: {
      type: "boolean",
      label: "Strict History",
      default: false,
      description: "Return transparent pixels when the requested input is not in history, instead of substituting the oldest available input.",
    },
    resetPulse: {
      type: "pulse",
      label: "Reset Pulse",
      // §V123/§V126: scoped to THIS node's ring. It reaches the ring because
      // `runtime.resetFeedback` now resolves a node's ring resources alongside its
      // feedback pairs — without that this would be a button that lies, which is why the
      // other stateful nodes are listed as gaps instead of being handed one.
      fires: "runtime.resetFeedback",
      input: { nodeIds: ["$node"] },
      description: "Clears every frame this cache is holding.",
    },
    scale: {
      type: "number",
      label: "Scale",
      default: CACHE_DEFAULT_SCALE,
      min: 0.125,
      max: 1,
      range: "bounded",
      compileTime: true,
      description: "Ring resolution as a fraction of the input. Halving it quarters the memory.",
    },
  },
  resolutionPolicy: { kind: "inherit", input: "input" },
  formatPolicy: { kind: "inherit", input: "input" },
  // §V46: it carries pixels across frames, so it declares how it behaves under reset and
  // replay. Its state is a pure function of the frames that have been rendered, so a
  // replay from frame 0 reproduces it exactly — but a SEEK cannot, which is what
  // `randomAccess: false` says out loud.
  stateful: { reset: true, deterministicReplay: true, checkpoint: false, randomAccess: false },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    const source = inputs["input"];
    if (target === undefined || source === undefined) {
      const what = target === undefined ? 'output port "out"' : 'input port "input"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }

    const frames = Math.max(2, Math.round(readNumber(parameters, "frames", CACHE_DEFAULT_FRAMES)));
    const requested = Math.max(0, Math.round(readNumber(parameters, "index", 1)));
    const strictHistory = readFlag(parameters, "strictHistory", false);
    // A ring of N holds N-1 readable frames behind the one being written. Asking deeper
    // is clamped rather than silently wrapped — and SAID, because "my 12-frame delay looks
    // like an 8-frame delay" is otherwise indistinguishable from the node not working.
    // Strict mode must retain the request so the shader can reject missing history.
    const index = strictHistory === 1 ? requested : Math.min(requested, frames - 1);
    const diagnostics =
      requested <= frames - 1
        ? []
        : [
            {
              severity: "warning" as const,
              code: strictHistory ? "node.compile.historyUnavailable" : "node.compile.tapClamped",
              message: `Node "${nodeId}" reads ${requested} frames back from a ${frames}-frame cache; the deepest it holds is ${frames - 1}.${strictHistory ? " Strict History outputs transparency until the requested frame is available." : ""}`,
              nodeId,
              suggestion: `Raise Frames above ${requested}, or lower Index to ${frames - 1}.`,
            },
          ];

    const ring = scratchResourceId(nodeId, CACHE_RING_KEY);
    const scale = readNumber(parameters, "scale", CACHE_DEFAULT_SCALE);

    // One shader, two passes, exactly like the separable blur: what differs is which
    // texture is bound and which target is written.
    const write: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:cache-write`,
      shader: CACHE_BLIT_WGSL,
      // The compiler hands the ring to the backend, which resolves "the slice this frame
      // owns" at encode time — the same way a ping-pong pass renders into its write half.
      target: ring,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      nodeId,
      label: "Cache Write",
    };
    const read: EffectPassDescriptor = {
      kind: "effect",
      // T1204: the id must NOT carry the tap. `pass.id` is in the pass structure key, so
      // an id that moved with `index` made every tap change a different plan — which is
      // what `isUniformOnlyChange` compares, so the per-frame animator would have refused
      // to push rather than writing the four bytes it now writes.
      id: `${nodeId}:cache-read`,
      shader: CACHE_READ_WGSL,
      target,
      // T425: the ring as ONE stable array view; the tap is a NUMBER in the uniform
      // block, so nothing rebinds per frame. The backend's T321 head loop merges
      // ringLatest/ringWritten/ringFrames into `cacheTap` every frame by name.
      // B160: the `live` binding is the ring's write target — what the shader reads
      // at tap 0, and while `ringWritten` is zero in the default mode (§V229).
      textures: [
        { binding: "ringTexture", resourceId: ring, array: true },
        { binding: "liveTexture", resourceId: ring, live: true },
      ],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      // The ring head trio is RESERVED here at zero — vgpu matches uniforms by name,
      // and the backend overwrites all three every frame from the ring's own counters
      // (the T367 pointer convention: present exactly when the block declares it).
      uniforms: { tap: index, ringLatest: 0, ringWritten: 0, ringFrames: frames, strictHistory },
      uniformBinding: "cacheTap",
      nodeId,
      label: "Cache Read",
    };

    return {
      passes: [write, read],
      scratch: [{ key: CACHE_RING_KEY, kind: "ring", frames, scale }],
      ...(diagnostics.length === 0 ? {} : { diagnostics }),
    };
  },
};
