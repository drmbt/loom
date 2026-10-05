import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { serializeProjectDocument } from "../../domain/project/serialize.ts";
import { PACK, sentinelDocument, type SentinelTrack } from "./document.ts";
import { loadKit } from "./load-kit.ts";

/**
 * T1561b — build the sentinel project from the kit.
 *
 *   node --import ./src/tooling/alias-hooks.ts src/projects/sentinel-bot/build.ts [-- --robots 3]
 *     [--track media/sentinel-bot/song.m4a --bpm 134 [--offset 0] [--beats 4] --out projects/sentinel-bot/local/song.loom.json]
 *
 * Reads public/media/sentinel-bot/sentinel.glb (gitignored: a build product of
 * tools/blender/sentinel-bot/ from a third-party FBX) and writes
 * projects/sentinel-bot/sentinel.loom.json through the real save path, pointing at it.
 * Open that file in the app. --robots N takes the first N of the pack (document.ts, PACK);
 * the default is the leader alone.
 *
 * --track builds the same piece to another track: a file the app can fetch (a path under
 * public/) with its tempo declared. Such a file is somebody's music, so it lives in the
 * gitignored public/media/sentinel-bot/ and the project built to it is written to --out,
 * which must not be the committed file: projects/sentinel-bot/local/ is gitignored for it.
 */
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
const count = Number(flag("robots") ?? 1);
if (!Number.isInteger(count) || count < 1 || count > PACK.length) throw new Error(`--robots takes 1 to ${PACK.length}.`);
const SHIPPED = "projects/sentinel-bot/sentinel.loom.json";
const file = flag("track");
const out = flag("out") ?? SHIPPED;
if (file !== undefined && out === SHIPPED) throw new Error("--track needs --out: the committed project plays the shipped beat. projects/sentinel-bot/local/ is gitignored for this.");
if (file !== undefined && flag("bpm") === undefined) throw new Error("--track needs --bpm: the camera cuts on the track's bars and the lights step on its beats.");
const track: SentinelTrack | undefined = file === undefined ? undefined : { file, bpm: Number(flag("bpm")), beatsPerBar: Number(flag("beats") ?? 4), beatOffset: Number(flag("offset") ?? 0) };
const url = "media/sentinel-bot/sentinel.glb";
const { facts } = loadKit(`public/${url}`, url);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, serializeProjectDocument(sentinelDocument(facts, { robots: PACK.slice(0, count), ...(track === undefined ? {} : { track }) })), "utf8");
console.log(`wrote ${out} (${count} robot${count === 1 ? "" : "s"}${track === undefined ? "" : `, to ${track.file} at ${track.bpm} bpm`}); kit at public/${url}: ${facts.robot.vertices} body vertices, ${facts.sockets.length} tentacles of ${facts.ringCount} rings`);
