import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { renderHeadless, type RenderedFrame } from "../../tests/headless/render-harness.ts";
import { nodeGpuHost } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { encodePng } from "../../runtime/export/png.ts";
import { toRgba8At } from "../../runtime/export/image.ts";
import { furnaceDocument } from "./document.ts";
import { loadFurnaceFacts } from "./load-facts.ts";
import { walkTrack } from "./load-audio.ts";

/**
 * T1354b — render the furnace headless, hearing the track, through the app's own mesh feed.
 *
 *   node --import ./src/tooling/alias-hooks.ts src/projects/furnace/render.ts -- \
 *     --glb <furnace.glb> --out <dir> [--audio <track.wav>] [--shots a,b] [--width 1280]
 *     [--at <seconds>]                 stills at that point of the track (after a 3 s run-up)
 *     [--clip <start>,<seconds>]       an MP4 of that span, the track muxed in (needs ffmpeg)
 *     --shots cut:N                    holds CUT entry N (camera-path.ts), its move from t = 0
 *     [--encoder x264]                 CPU x264 instead of the hardware H.264 encoder
 *     [--portrait]                     9:16 for social; --width is the short side
 *     [--clean]                        the glitch layer bypassed, to judge the look underneath
 *     [--bypass air,lens]              bypass nodes by id (timing, isolating a look)
 *     [--set lamps.gain=0.01,grade.exposure=1]   parameter overrides by node id, for tuning
 *
 * Every animated thing runs on absTime from 0; the TRACK is offset so frame 0 hears
 * `start`. Without --audio every lane sits at its retained value.
 */
const argv = process.argv.slice(2).filter((arg) => arg !== "--");
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? undefined : argv[at + 1];
};
const glbPath = flag("glb");
const outDir = flag("out");
if (glbPath === undefined || outDir === undefined) throw new Error("usage: render.ts -- --glb <furnace.glb> --out <dir> [--audio wav] [--shots a,b] [--width n] [--at s | --clip start,seconds]");
const audioPath = flag("audio");
const width = Number(flag("width") ?? 1280);
// --portrait: 9:16 for social (T1385b); --width is then the short side.
const portrait = argv.includes("--portrait");
const [frameWidth, frameHeight] = portrait ? [width, Math.round((width * 16) / 9) & ~1] : [width, Math.round((width * 9) / 16) & ~1];
const fps = 30;
const clip = flag("clip")?.split(",").map(Number);
const at = Number(flag("at") ?? 3);
const shots = (flag("shots") ?? "shot.hero_low_furnace").split(",");
const clean = argv.includes("--clean");
const overrides = (flag("set") ?? "").split(",").filter((entry) => entry !== "").map((entry) => {
  const match = /^([^.=]+)\.([^=]+)=(.+)$/.exec(entry);
  if (match === null) throw new Error(`--set expects node.param=value, got "${entry}".`);
  return { nodeId: match[1]!, parameter: match[2]!, value: JSON.parse(match[3]!) as unknown };
});
const { facts, glb } = loadFurnaceFacts(glbPath, "media/furnace/furnace.glb");
const track = audioPath === undefined ? undefined : walkTrack(audioPath, fps);
mkdirSync(outDir, { recursive: true });

const toRgba8 = (frame: RenderedFrame) =>
  toRgba8At({ ...frame, rowStride: frame.width * (frame.format === "rgba16float" ? 8 : 4) } as never, frame.width, frame.height, { space: "encoded" });

for (const shot of shots) {
  // `cut` runs the camera path (every framing, a move each, cuts on bars) instead of one held shot.
  // `cut:N` holds CUT entry N of the camera path, its move playing from t = 0.
  const held = /^cut:(\d+)$/.exec(shot);
  const built = furnaceDocument(facts, { ...(shot === "cut" ? {} : held !== null ? { cutIndex: Number(held[1]) } : { shot }), width: frameWidth, height: frameHeight, portrait });
  const nodes = { ...built.graph.nodes };
  const bypass = [...(clean ? ["glitch"] : []), ...(flag("bypass") ?? "").split(",").filter((id) => id !== "")];
  for (const id of bypass) {
    if (nodes[id] === undefined) throw new Error(`--bypass: no node "${id}".`);
    nodes[id] = { ...nodes[id]!, ui: { ...nodes[id]!.ui, bypassed: true } };
  }
  for (const { nodeId, parameter, value } of overrides) {
    const target = nodes[nodeId];
    if (target === undefined) throw new Error(`--set: no node "${nodeId}".`);
    nodes[nodeId] = { ...target, parameters: { ...target.parameters, [parameter]: value } } as typeof target;
  }
  const document = { ...built, graph: { ...built.graph, nodes } };
  const started = performance.now();
  const runUp = 3;
  const start = clip !== undefined ? (clip[0] ?? 0) : Math.max(0, at - runUp);
  const frames = clip !== undefined ? Math.round((clip[1] ?? 10) * fps) : Math.round((at - start) * fps) + 1;
  let encoder: ReturnType<typeof spawn> | undefined;
  const clipPath = `${outDir}/${shot}${clip === undefined ? "" : `@${start}s`}.mp4`;
  if (clip !== undefined) {
    const audioArgs = audioPath === undefined ? [] : ["-ss", String(start), "-t", String(frames / fps), "-i", audioPath];
    encoder = spawn("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${frameWidth}x${frameHeight}`, "-r", String(fps), "-i", "-",
      ...audioArgs,
      // The hardware encoder by default: x264 on the CPU competed with the renderer for the
      // cores and doubled the frame time (145 → 337 ms at 1080p, measured). 80 Mbit/s H.264
      // is visually lossless at 1080p; --encoder x264 restores the CPU encoder.
      ...(flag("encoder") === "x264"
        ? ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-preset", "medium"]
        : ["-c:v", "h264_videotoolbox", "-b:v", "80M", "-pix_fmt", "yuv420p", "-profile:v", "high"]),
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
    // The value graph and the expressions (rig, lanes, camera drift) only run when asked.
    animate: true,
    meshes: { plant: glb, machines: glb, sky: glb },
    ...(track === undefined ? {} : { audio: track.seam(fps, start) }),
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
  // An ERROR is a broken graph (a statement that does not parse drops its whole node): stop
  // loud, before a 13-minute render of a camera parked on its rest pose.
  const errors = [...new Set(result.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`))];
  if (errors.length > 0) throw new Error(`the furnace graph has errors:\n${errors.join("\n")}`);
  const problems = result.diagnostics.filter((d) => d.severity === "warning").map((d) => `${d.severity} ${d.code}: ${d.message}`);
  if (problems.length > 0) console.log([...new Set(problems)].slice(0, 10).join("\n"));
  if (encoder !== undefined) {
    encoder.stdin?.end();
    await new Promise((resolve) => encoder?.on("close", resolve));
    console.log(`${shot}: ${frames} frames → ${clipPath} in ${Math.round(performance.now() - started)} ms`);
  } else {
    const frame = result.frames.at(-1);
    if (frame === undefined) throw new Error("no frame");
    const path = `${outDir}/${shot}@${at}s.png`;
    writeFileSync(path, encodePng(toRgba8(frame)).bytes);
    console.log(`${shot}: ${path} (${frames} frames, ${Math.round(performance.now() - started)} ms)`);
  }
}
