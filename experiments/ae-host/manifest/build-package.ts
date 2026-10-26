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
// was saved with, so a fresh effect reproduces the project's look, except where DEFAULTS
// below says otherwise (VN122).
//
// VN122 (Vincent's decisions, 2026-10-13):
//   - the AE layer IS the source: `slider_source` is not published, and the host pins
//     Source to live (renderer.ts PINNED);
//   - the FX source is published as `stageFeeds.sourceFX`, a popup (test pattern / pixel
//     map; Syphon renders black headless, so it is not offered), in the slot `slider_source`
//     held on the panel;
//   - LEDs and strobes default to off in a fresh effect (the project file is unchanged);
//   - an integer-step slider whose caption lists its choices (`Shot: FOH · iso · …`) is a popup;
//   - both inputs default to comp layer 1.
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
const LABELS: Record<string, string> = {};
/** VN122: panel members that are not published (the host pins them, renderer.ts PINNED). */
const EXCLUDE = new Set(["slider_source"]);
/** VN122: manifest defaults that differ from the saved project (a fresh effect shows these). */
const DEFAULTS: Record<string, number | boolean> = { slider_leds: 0, slider_strobes: 0 };
/**
 * VN122: params that are not panel members, published at the board position of a panel
 * member (`at`), which they replace when that member is excluded. `id` is `<node>.<parameter>`
 * (PROTOCOL.md: the host writes that parameter of the node, here a component instance's
 * published parameter); `default` is read from the saved project.
 */
const EXTRA: { at: string; id: string; label: string; options: { label: string; value: number }[] }[] = [
  { at: "slider_source", id: "stageFeeds.sourceFX", label: "FX source",
    options: [{ label: "Test pattern", value: 1 }, { label: "Pixel map", value: 2 }] },
];
function asciiLabel(caption: string): string {
  return caption.replace(/°/g, "deg").replace(/·/g, "/").replace(/→/g, "->").replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim();
}

const INPUTS = [
  { id: "ds", label: "DS Layer", mediaKey: "media:stageFeeds/dsFeed", defaultLayer: 1 },
  { id: "sides", label: "Sides Layer", mediaKey: "media:stageFeeds/sidesFeed", defaultLayer: 1 },
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
/** A saved parameter's static value: a bare value, or the `static` binding of a mode envelope. */
function savedValue(v: unknown): unknown {
  if (v !== null && typeof v === "object" && "bindings" in v) {
    const env = v as { mode?: string; bindings: Record<string, { value?: unknown }> };
    if (env.mode !== "static") throw new Error(`saved parameter is in ${env.mode} mode, not a static value`);
    return env.bindings["static"]?.value;
  }
  return v;
}
/** `<node>.<parameter>`: the node by name, else by id (a component instance's id is its component's name). */
function dottedDefault(id: string): number {
  const dot = id.indexOf(".");
  const name = id.slice(0, dot), key = id.slice(dot + 1);
  const node = byLabel.get(name) ?? nodes.find((n) => n.id === name);
  if (node === undefined) throw new Error(`param ${id}: no node "${name}"`);
  const v = savedValue(node.parameters[key]);
  if (typeof v !== "number") throw new Error(`param ${id}: saved value ${JSON.stringify(v)} is not a number`);
  return v;
}
/** `Shot: FOH · iso · wing · proj · wide` on a 0..4 step-1 slider -> its five choices, else undefined. */
function choicesOf(caption: string, min: number, max: number, step: number): { label: string; choices: string[] } | undefined {
  const m = /^([^:]+):\s*(.+)$/.exec(caption);
  if (m === null || step !== 1 || !Number.isInteger(min) || !Number.isInteger(max)) return undefined;
  const choices = m[2]!.split("·").map((c) => asciiLabel(c));
  return choices.length >= 2 && choices.length === max - min + 1 ? { label: asciiLabel(m[1]!), choices } : undefined;
}
const panels = nodes.filter((n) => n.type === "panel");
if (panels.length !== 1) throw new Error(`expected one panel, found ${panels.length}`);
const board = JSON.parse(String(panels[0]!.parameters.board)) as { items: BoardItem[] };
const items = [...board.items].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);

const params: Record<string, unknown>[] = [];
let group: string | undefined;
for (const item of items) {
  if (item.label !== undefined && item.member === undefined) { group = item.label; continue; }
  const g = group ? { group } : {};
  for (const extra of EXTRA.filter((e) => e.at === item.member)) {
    const value = dottedDefault(extra.id);
    if (!extra.options.some((o) => o.value === value)) throw new Error(`param ${extra.id}: saved value ${value} is not one of its options`);
    params.push({ id: extra.id, label: extra.label, type: "popup", default: value, options: extra.options, ...g });
  }
  if (item.member !== undefined && EXCLUDE.has(item.member)) continue;
  const node = item.member === undefined ? undefined : byLabel.get(item.member);
  if (node === undefined || (node.type !== "slider" && node.type !== "toggle")) continue;
  const p = node.parameters;
  const caption = String(p.caption ?? node.label);
  const popup = node.type === "slider" ? choicesOf(caption, p.min ?? 0, p.max ?? 1, p.step ?? 0) : undefined;
  const label = LABELS[node.label] ?? popup?.label ?? asciiLabel(caption);
  if (Buffer.byteLength(label) > 31) throw new Error(`label "${label}" for ${node.label} is over 31 bytes; add it to LABELS`);
  const saved = DEFAULTS[node.label];
  if (popup !== undefined) {
    params.push({ id: node.label, label, type: "popup", default: saved ?? p.value ?? p.defaultValue,
      options: popup.choices.map((c, i) => ({ label: c, value: (p.min ?? 0) + i })), ...g });
  } else {
    params.push(node.type === "slider"
      ? { id: node.label, label, type: "float", min: p.min, max: p.max, default: saved ?? p.value ?? p.defaultValue, step: p.step ?? 0, ...g }
      : { id: node.label, label, type: "bool", default: saved ?? (p.on ?? p.defaultOn) === true, ...g });
  }
}
for (const id of [...Object.keys(DEFAULTS), ...EXTRA.map((e) => e.id)]) {
  if (!params.some((p) => p.id === id)) throw new Error(`${id} is named in DEFAULTS/EXTRA but was not published`);
}
// Sliders and toggles the panel does not show are left out on purpose: the panel IS the desk.
const missed = nodes.filter((n) => (n.type === "slider" || n.type === "toggle") && !params.some((p) => p.id === n.label) && !EXCLUDE.has(n.label));
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
// Components' media too: the FX pixel map (movie_fxMap inside stageFeeds) is a still the
// host decodes (VN121), so a missing one is an error here, not a black node at render time.
const lib = JSON.stringify(project.componentLibrary ?? {});
for (const m of lib.matchAll(/"file":\s*"([^"]+\.(?:glb|gltf|png|jpe?g))"/gi)) {
  const f = m[1]!;
  const src = join(mediaRoot, f.replace(/^media\//, ""));
  if (!existsSync(src)) throw new Error(`component media missing: ${src}`);
  copyFileSync(src, join(out, "media", basename(f)));
  files.add(f);
}
mkdirSync(dirname(out), { recursive: true });
console.log(`${manifest.name}: ${params.length} params, ${manifest.fps} fps, ${manifest.durationSeconds} s; media: ${[...files].map((f) => basename(f)).join(", ")} -> ${out}`);
