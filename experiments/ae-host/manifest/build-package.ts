// VN118: builds the host package (PROTOCOL.md v1 § manifest.json) from a Loom project.
//
//   node experiments/ae-host/manifest/build-package.ts \
//     [--project projects/stage-previz/stage-previz-13.loom.json] [--media public/media] [--out experiments/ae-host/package]
//
// Plain JSON in, plain JSON out (no Loom imports, runs on any Node >= 22). Writes
// <out>/manifest.json, <out>/project.loom.json and copies the media the project names
// (GLB, PNG) into <out>/media/. Movies and audio are skipped: the AE layers replace the
// movie feeds and the song is not rendered.
//
// Params: the panel's members in board order (top to bottom, left to right), grouped by
// the panel's section labels; sliders and toggles only. `default` is the value the project
// was saved with, so a fresh effect reproduces the project's look.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const projectPath = arg("project", "projects/stage-previz/stage-previz-13.loom.json");
const mediaRoot = arg("media", "public/media");
const out = arg("out", "experiments/ae-host/package");

// AE parameter names are at most 31 bytes; kept ASCII so no encoding question arises.
const LABELS: Record<string, string> = {
  slider_source: "Source: live/test/grid",
  slider_shot: "Shot: FOH/iso/wing/proj/wide",
};
function asciiLabel(caption: string): string {
  return caption.replace(/°/g, "deg").replace(/·/g, "/").replace(/→/g, "->").replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim();
}

const INPUTS = [
  { id: "ds", label: "DS Layer", mediaKey: "media:stageFeeds/dsFeed" },
  { id: "sides", label: "Sides Layer", mediaKey: "media:stageFeeds/sidesFeed" },
];

/** The few fields of a saved node this script reads. */
interface SavedNode {
  readonly id: string;
  readonly label: string;
  readonly type: string;
  readonly parameters: Record<string, unknown> & {
    caption?: string; min?: number; max?: number; value?: number; defaultValue?: number; step?: number;
    on?: boolean; defaultOn?: boolean; board?: string; file?: unknown;
  };
}
interface BoardItem { readonly label?: string; readonly member?: string; readonly rect: { x: number; y: number } }

const project = JSON.parse(readFileSync(projectPath, "utf8"));
const nodes = Object.values(project.graph.nodes) as SavedNode[];
const byLabel = new Map(nodes.map((n) => [n.label, n]));
const panels = nodes.filter((n) => n.type === "panel");
if (panels.length !== 1) throw new Error(`expected one panel, found ${panels.length}`);
const board = JSON.parse(String(panels[0]!.parameters.board)) as { items: BoardItem[] };
const items = [...board.items].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);

const params: Record<string, unknown>[] = [];
let group: string | undefined;
for (const item of items) {
  if (item.label !== undefined && item.member === undefined) { group = item.label; continue; }
  const node = item.member === undefined ? undefined : byLabel.get(item.member);
  if (node === undefined || (node.type !== "slider" && node.type !== "toggle")) continue;
  const p = node.parameters;
  const label = LABELS[node.label] ?? asciiLabel(String(p.caption ?? node.label));
  if (Buffer.byteLength(label) > 31) throw new Error(`label "${label}" for ${node.label} is over 31 bytes; add it to LABELS`);
  params.push(node.type === "slider"
    ? { id: node.label, label, type: "float", min: p.min, max: p.max, default: p.value ?? p.defaultValue, step: p.step ?? 0, ...(group ? { group } : {}) }
    : { id: node.label, label, type: "bool", default: (p.on ?? p.defaultOn) === true, ...(group ? { group } : {}) });
}
// Sliders and toggles the panel does not show are left out on purpose: the panel IS the desk.
const missed = nodes.filter((n) => (n.type === "slider" || n.type === "toggle") && !params.some((p) => p.id === n.label));
if (missed.length > 0) console.warn(`not on the panel, not published: ${missed.map((n) => n.label).join(", ")}`);

const settings = project.settings;
const range = settings.frameRange ?? { start: 0, end: 0 };
const manifest = {
  protocol: 1,
  name: basename(projectPath).replace(/\.loom\.json$/, ""),
  project: "project.loom.json",
  fps: settings.fps,
  durationSeconds: Math.round(((range.end - range.start + 1) / settings.fps) * 1000) / 1000,
  defaultSize: [settings.outputResolution.width, settings.outputResolution.height],
  inputs: INPUTS,
  params,
};

mkdirSync(join(out, "media"), { recursive: true });
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
copyFileSync(projectPath, join(out, "project.loom.json"));
const files = new Set<string>();
for (const n of nodes) {
  const f = n.parameters?.file;
  if (typeof f === "string" && /\.(glb|gltf|png|jpe?g)$/i.test(f)) files.add(f);
}
for (const f of files) {
  const src = join(mediaRoot, f.replace(/^media\//, ""));
  if (!existsSync(src)) throw new Error(`media missing: ${src}`);
  copyFileSync(src, join(out, "media", basename(f)));
}
// Components' media (movieFileIn inside stageFeeds) too.
const lib = JSON.stringify(project.componentLibrary ?? {});
for (const m of lib.matchAll(/"file":\s*"([^"]+\.(?:glb|gltf|png|jpe?g))"/gi)) {
  const f = m[1]!;
  const src = join(mediaRoot, f.replace(/^media\//, ""));
  if (existsSync(src)) { copyFileSync(src, join(out, "media", basename(f))); files.add(f); }
}
mkdirSync(dirname(out), { recursive: true });
console.log(`${manifest.name}: ${params.length} params, ${manifest.fps} fps, ${manifest.durationSeconds} s; media: ${[...files].map((f) => basename(f)).join(", ")} -> ${out}`);
