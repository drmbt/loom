import { mkdirSync, writeFileSync } from "node:fs";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { nodeGpuHost } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { encodePng } from "../../runtime/export/png.ts";
import { toRgba8At } from "../../runtime/export/image.ts";
import { furnaceDocument } from "./document.ts";
import { loadFurnaceFacts } from "./load-facts.ts";

/**
 * T1354b — render furnace stills headless, through the same mesh feed the app uses.
 *
 *   node --import ./src/tooling/alias-hooks.ts src/projects/furnace/render.ts -- <furnace.glb> <out dir> [shot,shot] [seconds] [width]
 *
 * `seconds` is the absolute time of the still (the rig, sparks and smoke all run on absTime);
 * the audio is silent here, so every lane sits at its retained value.
 */
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const [glbPath, outDir, shotList, secondsArg, widthArg] = args;
if (glbPath === undefined || outDir === undefined) throw new Error("usage: render.ts -- <furnace.glb> <out dir> [shots] [seconds] [width]");
const width = Number(widthArg ?? 1280);
const height = Math.round((width * 9) / 16);
const fps = 30;
const frames = Math.max(2, Math.round(Number(secondsArg ?? 4) * fps));
const { facts, glb } = loadFurnaceFacts(glbPath, "media/furnace/furnace.glb");
mkdirSync(outDir, { recursive: true });
for (const shot of (shotList ?? "shot.hero_low_furnace").split(",")) {
  const document = furnaceDocument(facts, { shot, width, height });
  const started = performance.now();
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: document.graph,
    settings: document.settings,
    frames,
    capture: [frames - 1],
    fps,
    outputNodeId: "out",
    meshes: { plant: glb, machines: glb },
  });
  const problems = result.diagnostics.filter((d) => d.severity !== "info").map((d) => `${d.severity} ${d.code}: ${d.message}`);
  if (problems.length > 0) console.log(problems.slice(0, 10).join("\n"));
  const frame = result.frames.at(-1);
  if (frame === undefined) throw new Error("no frame");
  const image = toRgba8At({ ...frame, rowStride: frame.width * (frame.format === "rgba16float" ? 8 : 4) } as never, frame.width, frame.height, { space: "encoded" });
  writeFileSync(`${outDir}/${shot}.png`, encodePng(image).bytes);
  console.log(`${shot}: ${frames} frames in ${Math.round(performance.now() - started)} ms`);
}
