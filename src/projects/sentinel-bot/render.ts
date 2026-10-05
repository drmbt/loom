import { mkdirSync, writeFileSync } from "node:fs";
import { renderHeadless, type RenderedFrame } from "../../tests/headless/render-harness.ts";
import { nodeGpuHost } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { encodePng } from "../../runtime/export/png.ts";
import { toRgba8At } from "../../runtime/export/image.ts";
import { sentinelDocument } from "./document.ts";
import { loadKit } from "./load-kit.ts";

/**
 * T1561b — render the sentinel headless, through the app's own mesh feed.
 *
 *   node --import ./src/tooling/alias-hooks.ts src/projects/sentinel-bot/render.ts -- \
 *     [--glb public/media/sentinel-bot/sentinel.glb] [--out renders/sentinel-bot] [--width 1280]
 *     [--at 4]                      a still at that many seconds
 *     [--strip 4,8,0.25]            8 stills from 4 s, 0.25 s apart (a motion strip)
 *     [--set joints.crawl=0.5,speed.value=6]   parameter overrides by node id
 *     [--cam=-7.5,1.1,0.6]          where the camera rides: metres ahead of the robot, right, up
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
const built = sentinelDocument(facts, { width, height });
// The camera's place is the panel's: Camera distance (metres behind) and the Camera side / height pad.
if (camera !== undefined) overrides.push({ nodeId: "distance", parameter: "value", value: -(camera[0] ?? 0) }, { nodeId: "view", parameter: "x", value: camera[1] ?? 0 }, { nodeId: "view", parameter: "y", value: camera[2] ?? 0 });
const nodes = { ...built.graph.nodes };
for (const { nodeId, parameter, value } of overrides) {
  const target = nodes[nodeId];
  if (target === undefined) throw new Error(`--set: no node "${nodeId}".`);
  nodes[nodeId] = { ...target, parameters: { ...target.parameters, [parameter]: value } } as typeof target;
}
const document = { ...built, graph: { ...built.graph, nodes } };
mkdirSync(outDir, { recursive: true });

const capture = Array.from({ length: count }, (_, index) => Math.round((first + index * gap) * fps));
const frames = (capture.at(-1) ?? 0) + 1;
const started = performance.now();
const result = await renderHeadless({
  host: nodeGpuHost(),
  graph: document.graph,
  settings: document.settings,
  frames,
  capture,
  fps,
  outputNodeId: "out",
  // The value graph and the expressions (travel, camera, lights) only run when asked.
  animate: true,
  meshes: { robot: glb },
});
// An ERROR is a broken graph: stop loud, before reading a picture of a robot parked on its rest pose.
const errors = [...new Set(result.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`))];
if (errors.length > 0) throw new Error(`the sentinel graph has errors:\n${errors.join("\n")}`);
const warnings = [...new Set(result.diagnostics.filter((d) => d.severity === "warning").map((d) => `warning ${d.code}: ${d.message}`))];
if (warnings.length > 0) console.log(warnings.slice(0, 12).join("\n"));

const toRgba8 = (frame: RenderedFrame) =>
  toRgba8At({ ...frame, rowStride: frame.width * (frame.format === "rgba16float" ? 8 : 4) } as never, frame.width, frame.height, { space: "encoded" });
for (const frame of result.frames) {
  const seconds = (frame.frameIndex / fps).toFixed(2);
  const path = `${outDir}/${tag}@${seconds}s.png`;
  writeFileSync(path, encodePng(toRgba8(frame)).bytes);
  console.log(path);
}
console.log(`${frames} frames stepped, ${result.frames.length} captured, ${Math.round(performance.now() - started)} ms`);
