import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createComponentSystem } from "../../domain/components/index.ts";
import { loadProject } from "../../domain/project/index.ts";
import { serializeProjectDocument } from "../../domain/project/serialize.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { stageFacts } from "./facts.ts";
import { applyRig } from "./rig.ts";

/**
 * Stage previz — bring a session you SAVED up to the current Blender export, in place.
 *
 *   node --import ./src/tooling/alias-hooks.ts src/projects/stage-previz/upgrade.ts -- \
 *     projects/stage-previz/stage-previz-7.loom.json [--glb renders/stage-previz/stage.glb] [--reset sideTilt,sideThrow]
 *
 * build.ts never overwrites a saved session; this is how one catches up instead. It loads the
 * file through the real loader, applies the projector rig (rig.ts: faders, moving bodies,
 * projectors driven through them; your fader values kept), refreshes every measured mesh
 * size and the shot cameras from the GLB, and writes it back through the real save path.
 * Everything else in the file — Syphon sources, your own nodes and values — is untouched.
 * `--reset` names faders to put back to the export's values instead (a re-derived aim, say).
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
const glbUrl = "media/stage-previz/stage.glb";

mkdirSync("public/media/stage-previz", { recursive: true });
copyFileSync(glbPath, "public/media/stage-previz/stage.glb");
// The FX pixel map the build writes beside the GLB (build.py --fxmap): the PNG is the FX feed's
// grid test in the session, and all three go beside the session for Resolume.
const maps = ["fx-pixel-map.png", "fx-pixel-map.svg", "fx-pixel-map.csv"].map((name) => join(dirname(glbPath), name));
if (existsSync(maps[0]!)) {
  copyFileSync(maps[0]!, "public/media/stage-previz/fx-pixel-map.png");
  for (const map of maps) if (existsSync(map)) copyFileSync(map, join(dirname(path), map.split("/").pop()!));
}
const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
const loaded = loadProject(readFileSync(path, "utf8"), { nodes: system.nodes });
if (!loaded.ok) throw new Error(`${path} did not load: ${loaded.reason}`);
const facts = stageFacts(new Uint8Array(readFileSync(glbPath)), glbUrl);
// The real save path writes the document; what else the file carried at its root (the app's
// component library, written from its live registry on every save) rides along untouched.
const written = JSON.parse(serializeProjectDocument(applyRig(loaded.document, facts, { reset }))) as Record<string, unknown>;
const original = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
for (const [key, value] of Object.entries(original)) if (!(key in written)) written[key] = value;
writeFileSync(path, JSON.stringify(written, null, 2), "utf8");
console.log(`upgraded ${path}${reset.length === 0 ? "" : ` (reset: ${reset.join(", ")})`}; media in public/media/stage-previz/stage.glb`);
