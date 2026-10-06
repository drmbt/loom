import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { serializeCheckedProject } from "../../examples/checked-project.ts";
import { furnaceDocument } from "./document.ts";
import { loadFurnaceFacts } from "./load-facts.ts";

/**
 * T1354b — build the furnace project from a GLB export.
 *
 *   node --import ./src/tooling/alias-hooks.ts src/projects/furnace/build.ts -- <furnace.glb> [shot.name] [track.wav]
 *
 * Copies the GLB to public/media/furnace/furnace.glb (gitignored — it is a build product of
 * tools/blender/furnace/) and writes projects/furnace/furnace.loom.json through the real
 * save path, CHECKED (§T1641b: a document that holds something which can never take effect
 * is refused by name, and not written), pointing at it. A track given as the third argument is copied to
 * public/media/furnace/clankz3.wav, the path the document plays. Open the file in the app.
 */
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const source = args[0];
if (source === undefined) throw new Error("usage: build.ts -- <furnace.glb> [shot.name]");
// No shot: the director cuts (the default); a shot name holds that framing instead.
const shot = args[1] === undefined || args[1] === "cut" ? undefined : args[1];
const url = "media/furnace/furnace.glb";
const target = `public/${url}`;
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
const track = args[2];
if (track !== undefined) copyFileSync(track, "public/media/furnace/clankz3.wav");
const { facts } = loadFurnaceFacts(target, url);
const document = furnaceDocument(facts, shot === undefined ? {} : { shot });
mkdirSync("projects/furnace", { recursive: true });
writeFileSync("projects/furnace/furnace.loom.json", serializeCheckedProject(document), "utf8");
console.log(`wrote projects/furnace/furnace.loom.json (${shot ?? "directed cut"}); GLB at ${target}: plant ${facts.plant.vertices} + machines ${facts.machines.vertices} vertices`);
