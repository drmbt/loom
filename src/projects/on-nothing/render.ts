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

/**
 * T1400b — render the On Nothing shots headless. Everything lands in the gitignored
 * `renders/on-nothing/` (stills in `stills/`, clips in `clips/`), never elsewhere.
 *
 *   node --import ./src/tooling/alias-hooks.ts src/projects/on-nothing/render.ts -- \
 *     [--glb renders/on-nothing/build/on-nothing.glb] [--shots tableau,title,quad,cyc]
 *     [--width 1920] [--at <seconds>]        a still at that time (default 2)
 *     [--clip <seconds>]                      an MP4 from t = 0 (needs ffmpeg)
 *     [--crt]                                 the CRT re-scan over the finished frame
 *     [--bypass haze,lens]                    bypass nodes by id
 *     [--set grade.exposure=0.5,halo.gain=2]  parameter overrides by node id
 *     [--tag name]                            appended to the file names (compare takes)
 *     [--probe streak2]                       show that node's output instead of the finished frame
 *     [--audio <song.wav>] [--audio-start <s>]  hear the song (the streaks breathe with it); a clip is muxed with it
 *     [--final]                               finished quality: SSAA in the Render, the whole frame rendered at 2x and
 *                                             box-downsampled, and --sub 4 sub-frames averaged per output frame
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
const clip = flag("clip") === undefined ? undefined : Number(flag("clip"));
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
const overrides = (flag("set") ?? "").split(",").filter((entry) => entry !== "").map((entry) => {
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

/**
 * Accumulates `sub` rendered frames (each `ss`× the output size) into one output frame: the
 * mean of the sub-frames (a 360° shutter: temporal AA and motion blur, and the per-frame dither
 * of haze and grain averages out), then a box downsample by `ss` (spatial AA).
 */
class Accumulator {
  private readonly sum: Float32Array;
  private readonly w: number;
  private readonly h: number;
  private count = 0;
  private previous: Float32Array | undefined;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
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
    if (trail > 0 && this.previous !== undefined) {
      let diff = 0;
      for (let i = 0; i < frame.length; i += 16) diff += Math.abs(frame[i]! - this.previous[i]!);
      const cut = diff / (frame.length / 16) > 18;
      if (!cut) for (let i = 0; i < frame.length; i++) frame[i] = Math.max(frame[i]!, this.previous[i]! * trail);
    }
    this.previous = frame;
    for (let i = 0; i < frame.length; i++) out[i] = Math.min(255, Math.round(frame[i]!));
    this.sum.fill(0);
    this.count = 0;
    return out;
  }
}

const toRgba8 = (frame: RenderedFrame) =>
  toRgba8At({ ...frame, rowStride: frame.width * (frame.format === "rgba16float" ? 8 : 4) } as never, frame.width, frame.height, { space: "encoded" });

for (const shot of shots) {
  const built = onNothingDocument(facts, { shot, width: width * ss, height: height * ss, crt, hdri: hdri !== undefined, audio: track !== undefined });
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
  const frames = clip !== undefined ? Math.round(clip * fps) : Math.round(at * fps) + 1;
  const renderFrames = frames * sub;
  const accumulator = new Accumulator(width, height);
  let lastOut: Uint8Array | undefined;
  let encoder: ReturnType<typeof spawn> | undefined;
  const clipPath = `${outDir}/clips/${shot}${crt ? "-crt" : ""}${tag}.mp4`;
  if (clip !== undefined) {
    encoder = spawn("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps), "-i", "-",
      ...(audioPath === undefined ? [] : ["-ss", String(audioStart), "-t", String(frames / fps), "-i", audioPath]),
      "-c:v", "h264_videotoolbox", "-b:v", "60M", "-pix_fmt", "yuv420p", "-profile:v", "high",
      ...(audioPath === undefined ? [] : ["-c:a", "aac", "-b:a", "256k", "-shortest"]),
      clipPath,
    ], { stdio: ["pipe", "inherit", "inherit"] });
  }
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: document.graph,
    settings: document.settings,
    frames: renderFrames,
    // every sub-frame goes through the accumulator (for a still: only the last output frame's)
    capture: clip === undefined ? Array.from({ length: sub }, (_, index) => renderFrames - sub + index) : Array.from({ length: renderFrames }, (_, index) => index),
    fps: fps * sub,
    outputNodeId: "out",
    animate: true,
    meshes,
    ...(track === undefined ? {} : { audio: track.seam(fps * sub, audioStart) }),
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
  // An expression that fails to evaluate is only a warning to the app (it holds the retained
  // value); here it is an error — an unknown function once froze a camera move without a word.
  // T1436b: name the node — a component diagnostic's message names the key, not the node
  const line = (d: { code: string; message: string; nodeId?: string }): string => `${d.code}${d.nodeId === undefined ? "" : ` [${d.nodeId}]`}: ${d.message}`;
  const errors = [...new Set(result.diagnostics.filter((d) => d.severity === "error" || d.code === "parameter.expression").map(line))];
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
