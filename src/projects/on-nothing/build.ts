import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { serializeCheckedProject } from "../../examples/checked-project.ts";
import { encodePng } from "../../runtime/export/png.ts";
import { SHOTS, onNothingDocument, type Shot } from "./document.ts";
import { loadOnNothingFacts } from "./load-facts.ts";
import { readHdr, rgbmBytes } from "./hdri.ts";

/**
 * T1400b — write the On Nothing shots as loom projects, openable in the app.
 *
 *   node --import ./src/tooling/alias-hooks.ts src/projects/on-nothing/build.ts -- \
 *     [--glb renders/on-nothing/build/on-nothing.glb] [--shots tableau,title]
 *     [--audio renders/on-nothing/reference/audio.wav] [--hdri renders/on-nothing/assets/hdri/empty_warehouse_01_2k.hdr]
 *
 * Media the documents load go to public/media/on-nothing/ (gitignored build products): the GLB,
 * the song (Audio File In, timeline), the HDRI packed RGBM as a PNG (Movie File In). Each shot
 * becomes projects/on-nothing/<shot>.loom.json through the real save path, CHECKED (§T1641b):
 * a shot that holds something which can never take effect is refused by name, and not written.
 */
const argv = process.argv.slice(2).filter((arg) => arg !== "--");
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? undefined : argv[at + 1];
};
const glbPath = flag("glb") ?? "renders/on-nothing/build/on-nothing.glb";
const audioPath = flag("audio") ?? "renders/on-nothing/reference/audio.wav";
const hdriPath = flag("hdri") ?? "renders/on-nothing/assets/hdri/empty_warehouse_01_2k.hdr";
const shots = (flag("shots") ?? SHOTS.join(",")).split(",") as Shot[];
for (const shot of shots) if (!SHOTS.includes(shot)) throw new Error(`--shots: no shot "${shot}" (known: ${SHOTS.join(", ")}).`);

const media = "public/media/on-nothing";
mkdirSync(media, { recursive: true });
copyFileSync(glbPath, `${media}/on-nothing.glb`);
const audio = existsSync(audioPath);
if (audio) copyFileSync(audioPath, `${media}/song.wav`);
const hdri = existsSync(hdriPath);
if (hdri) {
  const size = [2048, 1024] as const;
  writeFileSync(`${media}/hdri.png`, encodePng({ width: size[0], height: size[1], data: rgbmBytes(readHdr(hdriPath), size) } as never).bytes);
}
const { facts } = loadOnNothingFacts(glbPath, "media/on-nothing/on-nothing.glb");
mkdirSync("projects/on-nothing", { recursive: true });
for (const shot of shots) {
  const document = onNothingDocument(facts, { shot, audio, hdri });
  const path = `projects/on-nothing/${shot}.loom.json`;
  writeFileSync(path, serializeCheckedProject(document), "utf8");
  console.log(`wrote ${path}`);
}
console.log(`media in ${media}/: on-nothing.glb${audio ? ", song.wav" : ""}${hdri ? ", hdri.png" : ""}`);
