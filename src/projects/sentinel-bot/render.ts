import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { renderHeadless, type RenderedFrame } from "../../tests/headless/render-harness.ts";
import { nodeGpuHost } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { encodePng } from "../../runtime/export/png.ts";
import { toRgba8At } from "../../runtime/export/image.ts";
import { walkTrack } from "../furnace/load-audio.ts";
import { PACK, sentinelDocument, type SentinelTrack } from "./document.ts";
import { loadKit } from "./load-kit.ts";

/**
 * T1561b — render the sentinel headless, through the app's own mesh feed.
 *
 *   node --import ./src/tooling/alias-hooks.ts src/projects/sentinel-bot/render.ts -- \
 *     [--glb public/media/sentinel-bot/sentinel.glb] [--out renders/sentinel-bot] [--width 1280]
 *     [--at 4]                      a still at that many seconds
 *     [--strip 4,8,0.25]            8 stills from 4 s, 0.25 s apart (a motion strip)
 *     [--clip 2,20]                 an MP4 of 20 s from 2 s in (needs ffmpeg)
 *     [--audio track.wav]           the track the piece hears, muxed into a clip; without it every lane rests
 *     [--bpm 134 --offset 0 --beats 4]   that track's tempo, when it is not the shipped beat: the camera cuts on its bars
 *     [--bitrate 14M]               a clip's video bitrate (default 40M: a long clip wants less)
 *     [--set kernel_ring.crawl=0.5,slider_speed.value=6]   parameter overrides by node id
 *     [--cam=-7.5,1.1,0.6]          the chase shot, placed: metres ahead of the robot, right, up
 *     [--robots 3]                  the first N of the pack (document.ts, PACK); default the leader alone
 *     [--tier offline]              shadows and hinged claws (document.ts, tier); default live, what the app runs
 *     [--shadows on|off] [--claws hinged|rigid]   one of the tier's two decisions on its own, for measuring it
 *     [--shot 3]                    hold one of the rig's shots (camera.ts): 0 chase, 1 lead, 2 flank, 3 post, 4 circle
 *     [--tag name]                  file name prefix
 *
 * Every animated thing runs on absTime from 0. Stills go to the gitignored renders/ tree.
 */
const argv = process.argv.slice(2).filter((arg) => arg !== "--");
/** `--name value` or `--name=value` (the second form is the one that takes a value starting with a minus). */
const flag = (name: string): string | undefined => {
  const joined = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (joined !== undefined) return joined.slice(name.length + 3);
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? undefined : argv[at + 1];
};
const glbPath = flag("glb") ?? "public/media/sentinel-bot/sentinel.glb";
const outDir = flag("out") ?? "renders/sentinel-bot";
const width = Number(flag("width") ?? 1280);
const height = Math.round((width * 9) / 16) & ~1;
const fps = 30;
const strip = flag("strip")?.split(",").map(Number);
const first = strip?.[0] ?? Number(flag("at") ?? 4);
const count = strip?.[1] ?? 1;
const gap = strip?.[2] ?? 0;
const tag = flag("tag") ?? "sentinel";
const overrides = (flag("set") ?? "").split(",").filter((entry) => entry !== "").map((entry) => {
  const match = /^([^.=]+)\.([^=]+)=(.+)$/.exec(entry);
  if (match === null) throw new Error(`--set expects node.param=value, got "${entry}".`);
  return { nodeId: match[1]!, parameter: match[2]!, value: JSON.parse(match[3]!) as unknown };
});

const { facts, glb } = loadKit(glbPath, "media/sentinel-bot/sentinel.glb");
const camera = flag("cam")?.split(",").map(Number);
// A track other than the shipped beat brings its own tempo (the file's address does not matter here: a headless render hears --audio).
const tempo: SentinelTrack | undefined = flag("bpm") === undefined ? undefined : { file: "media/sentinel-bot/track", bpm: Number(flag("bpm")), beatsPerBar: Number(flag("beats") ?? 4), beatOffset: Number(flag("offset") ?? 0) };
const built = sentinelDocument(facts, { width, height, ...(tempo === undefined ? {} : { track: tempo }), robots: PACK.slice(0, Number(flag("robots") ?? 1)), tier: flag("tier") === "offline" ? "offline" : "live", ...(flag("shadows") === undefined ? {} : { shadows: flag("shadows") === "on" }), ...(flag("claws") === undefined ? {} : { hingedClaws: flag("claws") === "hinged" }) });
// The camera's place is the panel's: the chase shot held, its distance (metres behind) and its side / height pad.
if (camera !== undefined) overrides.push({ nodeId: "toggle_cuts", parameter: "on", value: false }, { nodeId: "slider_shot", parameter: "value", value: 0 }, { nodeId: "slider_distance", parameter: "value", value: -(camera[0] ?? 0) }, { nodeId: "xypad_view", parameter: "x", value: camera[1] ?? 0 }, { nodeId: "xypad_view", parameter: "y", value: camera[2] ?? 0 });
const shot = flag("shot");
if (shot !== undefined) overrides.push({ nodeId: "toggle_cuts", parameter: "on", value: false }, { nodeId: "slider_shot", parameter: "value", value: Number(shot) });
const nodes = { ...built.graph.nodes };
for (const { nodeId, parameter, value } of overrides) {
  const target = nodes[nodeId];
  if (target === undefined) throw new Error(`--set: no node "${nodeId}".`);
  nodes[nodeId] = { ...target, parameters: { ...target.parameters, [parameter]: value } } as typeof target;
}
const document = { ...built, graph: { ...built.graph, nodes } };
mkdirSync(outDir, { recursive: true });

const clip = flag("clip")?.split(",").map(Number);
const audioPath = flag("audio");
const track = audioPath === undefined ? undefined : walkTrack(audioPath, fps);
const clipStart = Math.round((clip?.[0] ?? 0) * fps);
const capture = clip === undefined ? Array.from({ length: count }, (_, index) => Math.round((first + index * gap) * fps)) : Array.from({ length: Math.round((clip[1] ?? 10) * fps) }, (_, index) => clipStart + index);
const frames = (capture.at(-1) ?? 0) + 1;
const clipPath = `${outDir}/${tag}.mp4`;
const encoder =
  clip === undefined
    ? undefined
    : spawn("ffmpeg", [
        "-y", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps), "-i", "-",
        // The track loops in the document (its clip node's At End is Loop), so it loops under the picture too.
        ...(audioPath === undefined ? [] : ["-stream_loop", "-1", "-ss", String(clipStart / fps), "-i", audioPath]),
        // The hardware encoder: x264 on the CPU competes with the renderer for the cores.
        "-c:v", "h264_videotoolbox", "-b:v", flag("bitrate") ?? "40M", "-pix_fmt", "yuv420p", "-profile:v", "high",
        ...(audioPath === undefined ? [] : ["-c:a", "aac", "-b:a", "256k", "-shortest"]),
        clipPath,
      ], { stdio: ["pipe", "inherit", "inherit"] });
const started = performance.now();
const toRgba8 = (frame: RenderedFrame) =>
  toRgba8At({ ...frame, rowStride: frame.width * (frame.format === "rgba16float" ? 8 : 4) } as never, frame.width, frame.height, { space: "encoded" });
const result = await renderHeadless({
  host: nodeGpuHost(),
  graph: document.graph,
  settings: document.settings,
  frames,
  capture,
  fps,
  outputNodeId: "output_frame",
  // The value graph and the expressions (travel, camera, lights) only run when asked.
  animate: true,
  // Every Mesh File In of the document reads the one kit.
  meshes: Object.fromEntries(Object.values(document.graph.nodes).filter((entry) => entry.type === "meshFileIn").map((entry) => [entry.id, glb])),
  ...(track === undefined ? {} : { audio: track.seam(fps, 0) }),
  ...(encoder === undefined
    ? {}
    : {
        onCapture: async (frame: RenderedFrame) => {
          const stdin = encoder.stdin;
          if (stdin === null) return;
          if (!stdin.write(Buffer.from(toRgba8(frame).data))) await new Promise((resolve) => stdin.once("drain", resolve));
        },
      }),
});
// An ERROR is a broken graph: stop loud, before reading a picture of a robot parked on its rest pose.
const errors = [...new Set(result.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`))];
if (errors.length > 0) throw new Error(`the sentinel graph has errors:\n${errors.join("\n")}`);
const warnings = [...new Set(result.diagnostics.filter((d) => d.severity === "warning").map((d) => `warning ${d.code}: ${d.message}`))];
if (warnings.length > 0) console.log(warnings.slice(0, 12).join("\n"));

if (encoder !== undefined) {
  encoder.stdin?.end();
  await new Promise((resolve) => encoder.on("close", resolve));
  console.log(clipPath);
} else {
  for (const frame of result.frames) {
    const seconds = (frame.frameIndex / fps).toFixed(2);
    const path = `${outDir}/${tag}@${seconds}s.png`;
    writeFileSync(path, encodePng(toRgba8(frame)).bytes);
    console.log(path);
  }
}
console.log(`${frames} frames stepped, ${result.frames.length} captured, ${Math.round(performance.now() - started)} ms`);
