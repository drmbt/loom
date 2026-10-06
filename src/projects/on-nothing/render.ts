import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { renderHeadless, type RenderedFrame } from "../../tests/headless/render-harness.ts";
import { nodeGpuHost } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { encodePng } from "../../runtime/export/png.ts";
import { toRgba8At } from "../../runtime/export/image.ts";
import { SHOTS, onNothingDocument, type Shot } from "./document.ts";
import { loadOnNothingFacts } from "./load-facts.ts";
import { readHdr, rgbmBytes } from "./hdri.ts";
import { walkTrack } from "../furnace/load-audio.ts";
import { outputPixelScale } from "../../domain/types/graph.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { stopsFinalRender } from "../../domain/diagnostics/classes.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";

/**
 * T1400b — render the On Nothing shots headless. Everything lands in the gitignored
 * `renders/on-nothing/` (stills in `stills/`, clips in `clips/`), never elsewhere.
 *
 *   node --import ./src/tooling/alias-hooks.ts src/projects/on-nothing/render.ts -- \
 *     [--glb renders/on-nothing/build/on-nothing.glb] [--shots tableau,title,quad,cyc]
 *     [--width 1920] [--at <seconds>]        a still at that time (default 2)
 *     [--clip <seconds>]                      an MP4 from t = 0 (needs ffmpeg)
 *     [--frames N]                            the clip's exact frame count (overrides --clip's length)
 *     [--from <seconds>]                      the clip starts at this shot time (earlier frames still render, unseen,
 *                                             so trails and feedback arrive warm); --audio-start stays the clip's first frame
 *     [--out <file.mp4>]                      the clip's path (default clips/<shot><tag>.mp4)
 *     [--warm N]                              frames rendered unseen before --from (default 24; the clock starts there)
 *     [--take N]                              which take of the shot (a shot may frame the same set several ways)
 *     [--crt]                                 the CRT re-scan over the finished frame
 *     [--bypass haze,lens]                    bypass nodes by id
 *     [--set grade.exposure=0.5,halo.gain=2]  parameter overrides by node id; a vector or colour in brackets,
 *                                             JSON, commas and all: --set 'grade.steel=[0.9,1,1.02],halo.gain=2'
 *     [--tag name]                            appended to the file names (compare takes)
 *     [--probe streak2]                       show that node's output instead of the finished frame
 *     [--audio <song.wav>] [--audio-start <s>]  hear the song (the streaks breathe with it); a clip is muxed with it
 *     [--final]                               finished quality: SSAA in the Render, the whole frame rendered at 2x and
 *                                             box-downsampled, and --sub 8 sub-frames averaged per output frame. Grain
 *                                             moves AFTER the accumulation (T1432b): averaged, it all but vanished
 *     [--sub N]                               sub-frames per output frame (temporal AA + motion blur; 1 = off; --final: 8)
 *     [--trail 0.5]                           echo trail: the previous frame decays by this factor and shows where brighter
 *                                             (smeared lights, the reference's ghosting; resets on a cut); --final: 0.5
 *     [--hdri <file.hdr>]                     reflections from a real HDRI (Poly Haven, CC0) instead of the procedural room
 */
const argv = process.argv.slice(2).filter((arg) => arg !== "--");
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? undefined : argv[at + 1];
};
const glbPath = flag("glb") ?? "renders/on-nothing/build/on-nothing.glb";
const width = Number(flag("width") ?? 1920);
// The reference's 2.35:1.
const height = Math.round(width / 2.347) & ~1;
const fps = 24;
const clip = flag("clip") === undefined ? (flag("frames") === undefined ? undefined : Number(flag("frames")) / fps) : Number(flag("clip"));
const from = Number(flag("from") ?? 0);
const take = Number(flag("take") ?? 0);
/** Output frames rendered unseen before a --from clip (the longest feedback/trail/lag any shot needs). */
const WARM_FRAMES = Number(flag("warm") ?? 24);
const at = Number(flag("at") ?? 2);
const crt = argv.includes("--crt");
const audioPath = flag("audio");
const audioStart = Number(flag("audio-start") ?? 0);
const track = audioPath === undefined ? undefined : walkTrack(audioPath, fps);
// the warehouse HDRI lights every shot's reflections by default (--hdri none turns it off)
const hdriArg = flag("hdri") ?? "renders/on-nothing/assets/hdri/empty_warehouse_01_2k.hdr";
const hdriPath = hdriArg === "none" || !existsSync(hdriArg) ? undefined : hdriArg;
const hdri = hdriPath === undefined ? undefined : readHdr(hdriPath);
const tag = flag("tag") === undefined ? "" : `-${flag("tag")}`;
const shots = (flag("shots") ?? SHOTS.join(",")).split(",") as Shot[];
for (const shot of shots) if (!SHOTS.includes(shot)) throw new Error(`--shots: no shot "${shot}" (known: ${SHOTS.join(", ")}).`);
/** T1430b: split `--set` on the commas OUTSIDE brackets, so `grade.steel=[0.9,1,1.02],halo.gain=2` is two entries. */
function splitOverrides(text: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "[") depth++;
    else if (char === "]") depth--;
    else if (char === "," && depth === 0) {
      entries.push(text.slice(start, i));
      start = i + 1;
    }
  }
  entries.push(text.slice(start));
  return entries.filter((entry) => entry !== "");
}
const overrides = splitOverrides(flag("set") ?? "").map((entry) => {
  const match = /^([^.=]+)\.([^=]+)=(.+)$/.exec(entry);
  if (match === null) throw new Error(`--set expects node.param=value, got "${entry}".`);
  return { nodeId: match[1]!, parameter: match[2]!, value: JSON.parse(match[3]!) as unknown };
});
const { facts, glb } = loadOnNothingFacts(glbPath, "media/on-nothing/on-nothing.glb");
const outDir = "renders/on-nothing";
mkdirSync(`${outDir}/stills`, { recursive: true });
mkdirSync(`${outDir}/clips`, { recursive: true });

const finalQuality = argv.includes("--final");
/** Supersampling factor of the whole frame, and sub-frames averaged per output frame. */
const ss = finalQuality ? 2 : 1;
const sub = Number(flag("sub") ?? (finalQuality ? 8 : 1));
const trail = Number(flag("trail") ?? (finalQuality ? 0.5 : 0));
/** The trail's highlight knee and ramp, in display levels of the previous frame's luma (see Accumulator). */
const TRAIL_KNEE = 170;
const TRAIL_SPAN = 50;

/**
 * T1432b — FILM GRAIN AFTER THE ACCUMULATION. A grade's grain is a new pattern every frame, so
 * the mean of 8 sub-frames and a 2×2 box cut it to about a quarter of its authored strength.
 * Whenever frames are accumulated, the render lifts each grade's grain out of the graph (its
 * `grain` goes to 0) and adds it here to the finished output frame instead: the grade's own
 * formula (a triangular noise in [-1, 1], heavier in the blacks: `grain * (0.35 + 0.65 * (1 -
 * luma))`, in display levels), one pattern per OUTPUT frame, in cells of the grade's
 * `grainSize` taken in pixels of the draft render, i.e. of the output.
 */
interface Grain {
  readonly amount: number;
  /** Cell size in output pixels. */
  readonly size: number;
}

/** A 32-bit integer hash of a cell and a frame, to [0, 1). */
function grainHash(x: number, y: number, frame: number, salt: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(frame + salt * 7919, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function addGrain(frame: Float32Array, w: number, h: number, grains: readonly Grain[], frameIndex: number): void {
  grains.forEach((grain, index) => {
    const size = Math.max(grain.size, 0.5);
    for (let y = 0; y < h; y++) {
      const cy = Math.floor(y / size);
      for (let x = 0; x < w; x++) {
        const cx = Math.floor(x / size);
        const n = grainHash(cx, cy, frameIndex, index * 2) + grainHash(cx, cy, frameIndex, index * 2 + 1) - 1;
        const at = (y * w + x) * 4;
        const luma = (0.2126 * frame[at]! + 0.7152 * frame[at + 1]! + 0.0722 * frame[at + 2]!) / 255;
        const add = n * grain.amount * (0.35 + 0.65 * (1 - Math.min(1, luma))) * 255;
        for (let c = 0; c < 3; c++) frame[at + c] = Math.min(255, Math.max(0, frame[at + c]! + add));
      }
    }
  });
}

/**
 * Accumulates `sub` rendered frames (each `ss`× the output size) into one output frame: the
 * mean of the sub-frames (a 360° shutter: temporal AA and motion blur, and the per-frame dither
 * of haze averages out), then a box downsample by `ss` (spatial AA), then the grain (above).
 */
class Accumulator {
  private readonly sum: Float32Array;
  private readonly w: number;
  private readonly h: number;
  private count = 0;
  private outputs = 0;
  private previous: Float32Array | undefined;
  private readonly grains: readonly Grain[];
  constructor(w: number, h: number, grains: readonly Grain[] = []) {
    this.w = w;
    this.h = h;
    this.grains = grains;
    this.sum = new Float32Array(w * ss * h * ss * 4);
  }
  add(rgba: Uint8Array | Uint8ClampedArray): Uint8Array | undefined {
    for (let i = 0; i < this.sum.length; i++) this.sum[i]! += rgba[i]!;
    this.count++;
    if (this.count < sub) return undefined;
    const out = new Uint8Array(this.w * this.h * 4);
    const W = this.w * ss;
    const norm = 1 / (this.count * ss * ss);
    const frame = new Float32Array(this.w * this.h * 4);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        for (let c = 0; c < 4; c++) {
          let acc = 0;
          for (let dy = 0; dy < ss; dy++) for (let dx = 0; dx < ss; dx++) acc += this.sum[((y * ss + dy) * W + (x * ss + dx)) * 4 + c]!;
          frame[(y * this.w + x) * 4 + c] = acc * norm;
        }
      }
    }
    // the trail: the previous output decays by `trail` and shows only where it is brighter
    // than the present (a moving light leaves a fading ghost; a still pixel is untouched,
    // max(x, x * trail) = x). A CUT resets it: a frame that differs from the last on average by
    // more than 18 levels starts a new trail, so no ghost of one shot bleeds into the next.
    // Only HIGHLIGHTS trail (the previous pixel's luma from TRAIL_KNEE up, eased over
    // TRAIL_SPAN levels): a trail of mid-grey ground drew the last frame's cyc through a
    // moving dark figure and its shadow — a ghost double (T1407b, the prism's row 26).
    if (trail > 0 && this.previous !== undefined) {
      let diff = 0;
      for (let i = 0; i < frame.length; i += 16) diff += Math.abs(frame[i]! - this.previous[i]!);
      const cut = diff / (frame.length / 16) > 18;
      if (!cut) {
        const prev = this.previous;
        for (let i = 0; i < frame.length; i += 4) {
          const luma = 0.2126 * prev[i]! + 0.7152 * prev[i + 1]! + 0.0722 * prev[i + 2]!;
          const w = Math.min(1, Math.max(0, (luma - TRAIL_KNEE) / TRAIL_SPAN)) * trail;
          if (w <= 0) continue;
          for (let c = 0; c < 3; c++) frame[i + c] = Math.max(frame[i + c]!, prev[i + c]! * w);
        }
      }
    }
    this.previous = frame;
    // the grain rides on the output only, never on the trail's memory of it
    let shown = frame;
    if (this.grains.length > 0) {
      shown = frame.slice();
      addGrain(shown, this.w, this.h, this.grains, this.outputs);
    }
    this.outputs++;
    for (let i = 0; i < shown.length; i++) out[i] = Math.min(255, Math.round(shown[i]!));
    this.sum.fill(0);
    this.count = 0;
    return out;
  }
}

const toRgba8 = (frame: RenderedFrame) =>
  toRgba8At({ ...frame, rowStride: frame.width * (frame.format === "rgba16float" ? 8 : 4) } as never, frame.width, frame.height, { space: "encoded" });

for (const shot of shots) {
  const built = onNothingDocument(facts, { shot, take, width: width * ss, height: height * ss, crt, hdri: hdri !== undefined, audio: track !== undefined });
  const nodes = { ...built.graph.nodes };
  for (const id of (flag("bypass") ?? "").split(",").filter((entry) => entry !== "")) {
    if (nodes[id] === undefined) throw new Error(`--bypass: no node "${id}".`);
    nodes[id] = { ...nodes[id]!, ui: { ...nodes[id]!.ui, bypassed: true } };
  }
  for (const { nodeId, parameter, value } of overrides) {
    const target = nodes[nodeId];
    if (target === undefined) continue;
    nodes[nodeId] = { ...target, parameters: { ...target.parameters, [parameter]: value } } as typeof target;
  }
  if (finalQuality) {
    // SSAA shades 4 samples a pixel: it also cleans the shader-thin detail MSAA leaves (chrome bars, chain links)
    // (the split's two plates prefix their Renders: car_shot, floor_shot)
    for (const id of Object.keys(nodes).filter((key) => key === "shot" || key.endsWith("_shot"))) {
      const shotNode = nodes[id]!;
      nodes[id] = { ...shotNode, parameters: { ...shotNode.parameters, antialias: "ssaa" } } as typeof shotNode;
    }
  }
  // T1432b: accumulating, the grades' grain moves after the accumulation (see Grain above)
  const grains: Grain[] = [];
  if (sub > 1 || ss > 1) {
    for (const [id, entry] of Object.entries(nodes)) {
      // the stored value, or the node's own default (a Custom WGSL grade's `@default`)
      const schema = effectiveParameterSchema(allNodeDefinitions.find((definition) => definition.type === entry.type), entry.parameters);
      const valueOf = (key: string): unknown => {
        const declared = schema[key];
        return entry.parameters[key] ?? (declared?.type === "number" ? declared.default : undefined);
      };
      const amount = valueOf("grain");
      if (typeof amount !== "number" || amount <= 0) continue;
      const size = valueOf("grainSize") ?? 1.3;
      if (typeof size !== "number") {
        console.log(`${id}: grainSize is driven, so its grain stays in the graph (averaged by --sub/--final)`);
        continue;
      }
      // grainSize is in pixels of the render (ss× the output), scaled first by the project's
      // reference width where the node declares it (the stock Film Grade, T1432b)
      const scale = entry.type === "filmGrade" ? outputPixelScale(built.settings) : 1;
      grains.push({ amount, size: (size * scale) / ss });
      nodes[id] = { ...entry, parameters: { ...entry.parameters, grain: 0 } } as typeof entry;
    }
  }
  let graphEdges = built.graph.edges;
  const probe = flag("probe");
  if (probe !== undefined) {
    if (nodes[probe] === undefined) throw new Error(`--probe: no node "${probe}".`);
    graphEdges = Object.fromEntries(Object.entries(graphEdges).map(([id, entry]) =>
      entry.target.nodeId === "out" ? [id, { ...entry, source: { ...entry.source, nodeId: probe, portId: "out" } }] : [id, entry]));
  }
  const document = { ...built, graph: { ...built.graph, nodes, edges: graphEdges } };
  const meshes: Record<string, Uint8Array> = {};
  for (const [id, entry] of Object.entries(nodes)) if (entry.type === "meshFileIn") meshes[id] = glb;
  const started = performance.now();
  const frames = flag("frames") !== undefined ? Number(flag("frames")) : clip !== undefined ? Math.round(clip * fps) : Math.round(at * fps) + 1;
  // --from: the frames before it render (feedback and trails warm up) but are not captured
  const skip = clip === undefined ? 0 : Math.round(from * fps);
  // --from: the clock starts `warm` frames before the clip (feedback, trails and lagged
  // channels arrive warm) instead of at 0, so a late part does not pay for the whole shot
  const warm = Math.min(skip, WARM_FRAMES);
  const startFrame = (skip - warm) * sub;
  const renderFrames = (frames + warm) * sub;
  const accumulator = new Accumulator(width, height, grains);
  let lastOut: Uint8Array | undefined;
  let encoder: ReturnType<typeof spawn> | undefined;
  const clipPath = flag("out") ?? `${outDir}/clips/${shot}${crt ? "-crt" : ""}${tag}.mp4`;
  if (clip !== undefined) {
    encoder = spawn("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps), "-i", "-",
      ...(audioPath === undefined ? [] : ["-ss", String(audioStart), "-t", String(frames / fps), "-i", audioPath]),
      "-c:v", "h264_videotoolbox", "-b:v", "60M", "-pix_fmt", "yuv420p", "-profile:v", "high",
      ...(audioPath === undefined ? [] : ["-c:a", "aac", "-b:a", "256k"]),
      clipPath,
    ], { stdio: ["pipe", "inherit", "inherit"] });
  }
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: document.graph,
    settings: document.settings,
    frames: renderFrames,
    startFrame,
    // every sub-frame goes through the accumulator (for a still: only the last output frame's)
    capture: clip === undefined ? Array.from({ length: sub }, (_, index) => renderFrames - sub + index) : Array.from({ length: frames * sub }, (_, index) => warm * sub + index),
    fps: fps * sub,
    // T1435b: the document reads `subframes` (and `fps` stays the film's 24)
    subframes: sub,
    outputNodeId: "out",
    animate: true,
    meshes,
    ...(track === undefined ? {} : { audio: track.seam(fps * sub, audioStart - warm / fps) }),
    ...(hdri !== undefined && nodes["hdri"] !== undefined ? { pictures: { hdri: (size: readonly [number, number]) => rgbmBytes(hdri, size) } } : {}),
    onCapture: async (frame: RenderedFrame) => {
      const out = accumulator.add(toRgba8(frame).data as Uint8Array);
      if (out === undefined) return;
      lastOut = out;
      const stdin = encoder?.stdin;
      if (stdin === undefined || stdin === null) return;
      if (!stdin.write(Buffer.from(out))) await new Promise((resolve) => stdin.once("drain", resolve));
    },
  });
  // What cannot take effect stops the render, asked by CLASS (§T1641b, `stopsFinalRender`): a
  // guard on the one code `parameter.expression` went blind when that code was split. An
  // expression that can never evaluate is an error now and stops inside `renderHeadless`, by
  // the node's name (an unknown function once froze a camera move without a word); what is
  // left to stop on here is what is still waiting, such as a read of a node not in the graph.
  // And an expression with no finite answer at a frame (`parameter.expression.value`): the
  // stored value standing in is DEGRADED to an editor and a wrong picture in a film frame.
  // T1436b: name the node — a component diagnostic's message names the key, not the node
  const line = (d: { code: string; message: string; nodeId?: string }): string => `${d.code}${d.nodeId === undefined ? "" : ` [${d.nodeId}]`}: ${d.message}`;
  const errors = [...new Set(result.diagnostics.filter((d) => stopsFinalRender(d) || d.code === "parameter.expression.value").map(line))];
  if (errors.length > 0) throw new Error(`the ${shot} graph has errors:\n${errors.join("\n")}`);
  const warnings = [...new Set(result.diagnostics.filter((d) => d.severity === "warning").map(line))];
  if (warnings.length > 0) console.log(warnings.slice(0, 10).join("\n"));
  if (encoder !== undefined) {
    encoder.stdin?.end();
    await new Promise((resolve) => encoder?.on("close", resolve));
    console.log(`${shot}: ${frames} frames → ${clipPath} in ${Math.round(performance.now() - started)} ms`);
  } else {
    if (lastOut === undefined) throw new Error("no frame");
    const path = `${outDir}/stills/${shot}${crt ? "-crt" : ""}${tag}${probe === undefined ? "" : `-probe-${probe}`}@${at}s.png`;
    writeFileSync(path, encodePng({ width, height, data: lastOut } as never).bytes);
    console.log(`${shot}: ${path} (${frames} frames, ${Math.round(performance.now() - started)} ms)`);
  }
}
