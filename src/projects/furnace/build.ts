import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { serializeProjectDocument } from "../../domain/project/serialize.ts";
import { furnaceDocument } from "./document.ts";
import { loadFurnaceFacts } from "./load-facts.ts";

/**
 * T1354b — build the furnace project from a GLB export.
 *
 *   node --import ./src/tooling/alias-hooks.ts src/projects/furnace/build.ts -- <furnace.glb> [shot.name] [track.wav]
 *
 * Copies the GLB to public/media/furnace/furnace.glb (gitignored — it is a build product of
 * tools/blender/furnace/) and writes projects/furnace/furnace.loom.json through the real
 * save path, pointing at it. A track given as the third argument is copied to
 * public/media/furnace/clankz3.wav, the path the document plays. Open the file in the app.
 */
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const source = args[0];
if (source === undefined) throw new Error("usage: build.ts -- <furnace.glb> [shot.name]");
const shot = args[1] ?? "shot.hero_low_furnace";
const url = "media/furnace/furnace.glb";
const target = `public/${url}`;
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
const track = args[2];
if (track !== undefined) copyFileSync(track, "public/media/furnace/clankz3.wav");
const { facts } = loadFurnaceFacts(target, url);
const document = furnaceDocument(facts, { shot });
mkdirSync("projects/furnace", { recursive: true });
writeFileSync("projects/furnace/furnace.loom.json", serializeProjectDocument(document), "utf8");
console.log(`wrote projects/furnace/furnace.loom.json (${shot}); GLB at ${target}: plant ${facts.plant.vertices} + machines ${facts.machines.vertices} vertices`);
