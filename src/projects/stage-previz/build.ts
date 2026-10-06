import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { serializeCheckedProject } from "../../examples/checked-project.ts";
import { stageDocument } from "./document.ts";
import { stageFacts } from "./facts.ts";

/**
 * Stage previz — write the Loom session from the Blender GLB.
 *
 *   Blender --background --factory-startup --python tools/blender/stage-previz/build.py -- \
 *     --out renders/stage-previz/stage.glb --blend renders/stage-previz/stage.blend
 *   node --import ./src/tooling/alias-hooks.ts src/projects/stage-previz/build.ts -- [--glb renders/stage-previz/stage.glb] [--force]
 *
 * The GLB goes to public/media/stage-previz/ (local media, served at media/stage-previz/), and
 * the session to projects/stage-previz/stage-previz.loom.json through the real save path.
 * A session that already exists is the one you edited and saved (Syphon sources, your own
 * nodes), so it is NOT overwritten without --force; the GLB is always refreshed, and the
 * session picks the new geometry up on its next open.
 */
const argv = process.argv.slice(2).filter((arg) => arg !== "--");
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? undefined : argv[at + 1];
};
const glbPath = flag("glb") ?? "renders/stage-previz/stage.glb";
const glbUrl = "media/stage-previz/stage.glb";
const path = "projects/stage-previz/stage-previz.loom.json";
const force = argv.includes("--force");

const media = "public/media/stage-previz";
mkdirSync(media, { recursive: true });
copyFileSync(glbPath, `${media}/stage.glb`);
const facts = stageFacts(new Uint8Array(readFileSync(glbPath)), glbUrl);
mkdirSync("projects/stage-previz", { recursive: true });
if (existsSync(path) && !force) {
  console.log(`kept ${path} (it holds your saved edits; pass --force to regenerate it); media in ${media}/stage.glb`);
} else {
  writeFileSync(path, serializeCheckedProject(stageDocument(facts)), "utf8");
  console.log(`wrote ${path}; media in ${media}/stage.glb`);
}
for (const name of Object.keys(facts.projectors) as Array<keyof typeof facts.projectors>) {
  const rig = facts.projectors[name];
  console.log(`  proj${name}: eye ${rig.eye.map((v) => v.toFixed(2)).join(", ")} → ${rig.lookAt.map((v) => v.toFixed(2)).join(", ")}, throw ratio ${rig.throwRatio}`);
}
