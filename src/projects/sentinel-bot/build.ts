import { mkdirSync, writeFileSync } from "node:fs";
import { serializeProjectDocument } from "../../domain/project/serialize.ts";
import { sentinelDocument } from "./document.ts";
import { loadKit } from "./load-kit.ts";

/**
 * T1561b — build the sentinel project from the kit.
 *
 *   node --import ./src/tooling/alias-hooks.ts src/projects/sentinel-bot/build.ts
 *
 * Reads public/media/sentinel-bot/sentinel.glb (gitignored: a build product of
 * tools/blender/sentinel-bot/ from a third-party FBX) and writes
 * projects/sentinel-bot/sentinel.loom.json through the real save path, pointing at it.
 * Open that file in the app.
 */
const url = "media/sentinel-bot/sentinel.glb";
const { facts } = loadKit(`public/${url}`, url);
mkdirSync("projects/sentinel-bot", { recursive: true });
writeFileSync("projects/sentinel-bot/sentinel.loom.json", serializeProjectDocument(sentinelDocument(facts)), "utf8");
console.log(`wrote projects/sentinel-bot/sentinel.loom.json; kit at public/${url}: ${facts.robot.vertices} body vertices, ${facts.sockets.length} tentacles of ${facts.ringCount} rings`);
