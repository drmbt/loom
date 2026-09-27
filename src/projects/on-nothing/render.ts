import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
 *     [--final]                               finished quality: the Render supersampled (SSAA 2x) instead of MSAA
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
const hdriPath = flag("hdri");
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

const toRgba8 = (frame: RenderedFrame) =>
  toRgba8At({ ...frame, rowStride: frame.width * (frame.format === "rgba16float" ? 8 : 4) } as never, frame.width, frame.height, { space: "encoded" });

for (const shot of shots) {
  const built = onNothingDocument(facts, { shot, width, height, crt, hdri: hdri !== undefined, audio: track !== undefined });
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
  if (argv.includes("--final")) {
    // SSAA shades 4 samples a pixel: it also cleans the shader-thin detail MSAA leaves (chrome bars, chain links)
    const shotNode = nodes["shot"];
    if (shotNode !== undefined) nodes["shot"] = { ...shotNode, parameters: { ...shotNode.parameters, antialias: "ssaa" } } as typeof shotNode;
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
    frames,
    capture: clip === undefined ? [frames - 1] : Array.from({ length: frames }, (_, index) => index),
    fps,
    outputNodeId: "out",
    animate: true,
    meshes,
    ...(track === undefined ? {} : { audio: track.seam(fps, audioStart) }),
    ...(hdri !== undefined && nodes["hdri"] !== undefined ? { pictures: { hdri: (size: readonly [number, number]) => rgbmBytes(hdri, size) } } : {}),
    ...(encoder === undefined
      ? {}
      : {
          onCapture: async (frame: RenderedFrame) => {
            const stdin = encoder?.stdin;
            if (stdin === undefined || stdin === null) return;
            if (!stdin.write(Buffer.from(toRgba8(frame).data))) await new Promise((resolve) => stdin.once("drain", resolve));
          },
        }),
  });
  // An expression that fails to evaluate is only a warning to the app (it holds the retained
  // value); here it is an error — an unknown function once froze a camera move without a word.
  const errors = [...new Set(result.diagnostics.filter((d) => d.severity === "error" || d.code === "parameter.expression").map((d) => `${d.code}: ${d.message}`))];
  if (errors.length > 0) throw new Error(`the ${shot} graph has errors:\n${errors.join("\n")}`);
  const warnings = [...new Set(result.diagnostics.filter((d) => d.severity === "warning").map((d) => `${d.code}: ${d.message}`))];
  if (warnings.length > 0) console.log(warnings.slice(0, 10).join("\n"));
  if (encoder !== undefined) {
    encoder.stdin?.end();
    await new Promise((resolve) => encoder?.on("close", resolve));
    console.log(`${shot}: ${frames} frames → ${clipPath} in ${Math.round(performance.now() - started)} ms`);
  } else {
    const frame = result.frames.at(-1);
    if (frame === undefined) throw new Error("no frame");
    const path = `${outDir}/stills/${shot}${crt ? "-crt" : ""}${tag}${probe === undefined ? "" : `-probe-${probe}`}@${at}s.png`;
    writeFileSync(path, encodePng(toRgba8(frame)).bytes);
    console.log(`${shot}: ${path} (${frames} frames, ${Math.round(performance.now() - started)} ms)`);
  }
}
