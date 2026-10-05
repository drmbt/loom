import { mkdirSync, writeFileSync } from "node:fs";
import { serializeProjectDocument } from "../../domain/project/serialize.ts";
import { PACK, sentinelDocument } from "./document.ts";
import { loadKit } from "./load-kit.ts";

/**
 * T1561b — build the sentinel project from the kit.
 *
 *   node --import ./src/tooling/alias-hooks.ts src/projects/sentinel-bot/build.ts [-- --robots 3]
 *
 * Reads public/media/sentinel-bot/sentinel.glb (gitignored: a build product of
 * tools/blender/sentinel-bot/ from a third-party FBX) and writes
 * projects/sentinel-bot/sentinel.loom.json through the real save path, pointing at it.
 * Open that file in the app. --robots N takes the first N of the pack (document.ts, PACK);
 * the default is the leader alone.
 */
const argv = process.argv.slice(2);
const count = argv.includes("--robots") ? Number(argv[argv.indexOf("--robots") + 1]) : 1;
if (!Number.isInteger(count) || count < 1 || count > PACK.length) throw new Error(`--robots takes 1 to ${PACK.length}.`);
const url = "media/sentinel-bot/sentinel.glb";
const { facts } = loadKit(`public/${url}`, url);
mkdirSync("projects/sentinel-bot", { recursive: true });
writeFileSync("projects/sentinel-bot/sentinel.loom.json", serializeProjectDocument(sentinelDocument(facts, { robots: PACK.slice(0, count) })), "utf8");
console.log(`wrote projects/sentinel-bot/sentinel.loom.json (${count} robot${count === 1 ? "" : "s"}); kit at public/${url}: ${facts.robot.vertices} body vertices, ${facts.sockets.length} tentacles of ${facts.ringCount} rings`);
