import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stageFacts } from "./facts.ts";
import { STAGE_GLB_PATH, STAGE_GLB_URL, STAGE_SESSION_PATH, builtSession } from "./session.ts";

/**
 * Stage previz — write the Loom session from the Blender GLB.
 *
 *   Blender --background --factory-startup --python tools/blender/stage-previz/build.py -- \
 *     --out renders/stage-previz/stage.glb --blend renders/stage-previz/stage.blend
 *   node --import ./src/tooling/alias-hooks.ts src/projects/stage-previz/build.ts -- [--glb renders/stage-previz/stage.glb] [--force]
 *
 * The GLB goes to public/media/stage-previz/ (local media, served at media/stage-previz/), and
 * the session to projects/stage-previz/stage-previz.loom.json through the real save path.
 *
 * THAT SESSION IS THE GENERATED ONE: `session.test.ts` holds the committed file to what this
 * writes from the committed GLB, byte for byte. So it is not the place for your own edits
 * (save those under another name, and bring them along with upgrade.ts), and a file that is
 * already there is NOT overwritten without --force. After a change to the source, or a new
 * export, regenerate it:
 *
 *   node --import ./src/tooling/alias-hooks.ts src/projects/stage-previz/build.ts -- --glb public/media/stage-previz/stage.glb --force
 *
 * Given the committed GLB itself, as there, the GLB is read where it is and not written.
 */
const argv = process.argv.slice(2).filter((arg) => arg !== "--");
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? undefined : argv[at + 1];
};
const glbPath = flag("glb") ?? "renders/stage-previz/stage.glb";
const force = argv.includes("--force");

const glb = new Uint8Array(readFileSync(glbPath));
mkdirSync(dirname(STAGE_GLB_PATH), { recursive: true });
if (resolve(glbPath) !== resolve(STAGE_GLB_PATH)) copyFileSync(glbPath, STAGE_GLB_PATH);
mkdirSync(dirname(STAGE_SESSION_PATH), { recursive: true });
if (existsSync(STAGE_SESSION_PATH) && !force) {
  console.log(`kept ${STAGE_SESSION_PATH} (pass --force to regenerate it); media in ${STAGE_GLB_PATH}`);
} else {
  writeFileSync(STAGE_SESSION_PATH, builtSession(glb), "utf8");
  console.log(`wrote ${STAGE_SESSION_PATH}; media in ${STAGE_GLB_PATH}`);
}
const facts = stageFacts(glb, STAGE_GLB_URL);
for (const name of Object.keys(facts.projectors) as Array<keyof typeof facts.projectors>) {
  const rig = facts.projectors[name];
  console.log(`  proj${name}: eye ${rig.eye.map((v) => v.toFixed(2)).join(", ")} → ${rig.lookAt.map((v) => v.toFixed(2)).join(", ")}, throw ratio ${rig.throwRatio}`);
}
