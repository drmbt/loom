import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { STAGE_GLB_PATH, upgradedSession } from "./session.ts";

/**
 * Stage previz — bring a session you SAVED up to the current Blender export, in place.
 *
 *   node --import ./src/tooling/alias-hooks.ts src/projects/stage-previz/upgrade.ts -- \
 *     projects/stage-previz/stage-previz-7.loom.json [--glb renders/stage-previz/stage.glb] [--reset sideTilt,sideThrow]
 *
 * build.ts writes the generated session and nothing else; this is how one you saved catches
 * up. It loads the file through the real loader, applies the projector rig (rig.ts: faders,
 * moving bodies, projectors driven through them; your fader values kept), refreshes every
 * measured mesh size, the deck height and the shot cameras from the GLB, and writes it back
 * through the real save path (`upgradedSession`, session.ts).
 * Everything else in the file — Syphon sources, your own nodes and values — is untouched, and
 * a session that is already up to date is written back byte for byte.
 * `--reset` names faders to put back to the export's values instead (a re-derived aim, say).
 *
 * `--glb public/media/stage-previz/stage.glb` upgrades against the committed GLB: it is read
 * where it is, and neither it nor the pixel map beside it is written.
 */
const argv = process.argv.slice(2).filter((arg) => arg !== "--");
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? undefined : argv[at + 1];
};
const path = argv.find((arg, index) => !arg.startsWith("--") && argv[index - 1] !== "--glb" && argv[index - 1] !== "--reset");
const reset = (flag("reset") ?? "").split(",").map((name) => name.trim()).filter(Boolean);
if (path === undefined) throw new Error("usage: upgrade.ts -- <session.loom.json> [--glb renders/stage-previz/stage.glb]");
const glbPath = flag("glb") ?? "renders/stage-previz/stage.glb";
/** A file is never copied onto itself (the committed GLB, given as `--glb`). */
const copy = (from: string, to: string): void => {
  if (resolve(from) !== resolve(to)) copyFileSync(from, to);
};

// The session first: refused (`DocumentRefused`) while the upgraded session holds anything a
// code save refuses (T1641b), and then no file is touched, the media included.
const upgraded = upgradedSession(readFileSync(path, "utf8"), new Uint8Array(readFileSync(glbPath)), { reset });

mkdirSync(dirname(STAGE_GLB_PATH), { recursive: true });
copy(glbPath, STAGE_GLB_PATH);
// The FX pixel map the build writes beside the GLB (build.py --fxmap): the PNG is the FX feed's
// grid test in the session, and all three go beside the session for Resolume.
const maps = ["fx-pixel-map.png", "fx-pixel-map.svg", "fx-pixel-map.csv"].map((name) => join(dirname(glbPath), name));
if (existsSync(maps[0]!)) {
  copy(maps[0]!, join(dirname(STAGE_GLB_PATH), "fx-pixel-map.png"));
  for (const map of maps) if (existsSync(map)) copy(map, join(dirname(path), map.split("/").pop()!));
}
writeFileSync(path, upgraded, "utf8");
console.log(`upgraded ${path}${reset.length === 0 ? "" : ` (reset: ${reset.join(", ")})`}; media in ${STAGE_GLB_PATH}`);
