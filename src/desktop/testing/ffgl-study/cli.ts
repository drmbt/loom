/**
 * VN91 harness runner. Renders the reference set through every requested backend, compares
 * them, measures cost, and writes report.json + report.md + PNGs into --out.
 *
 *   node --import ./src/tooling/alias-hooks.ts src/desktop/testing/ffgl-study/cli.ts \
 *     [--backends native,resolume] [--cases id,id] [--size 1280x720] [--cost] [--out dir]
 *
 * Backend (a) "resolume" runs only with LOOM_FFGL_ORACLE=1 (it needs Arena; see
 * docs/ffgl-study-2026-10-08.md, "Re-running the Resolume oracle").
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REFERENCE_CASES } from "./cases.ts";
import { encodePng } from "./images.ts";
import { createNativeBackend, loadStudyAddon } from "./native-backend.ts";
import { measureCost, pixelParity, runCase, tableParity, type CaseRecord, type CostRecord, type ParityRecord, type PixelParity } from "./study.ts";
import type { FfglStudyBackend, StudyImage } from "./types.ts";

export interface OracleBound { readonly tolerance: number; readonly reason: string }

async function backendsFor(ids: readonly string[]): Promise<FfglStudyBackend[]> {
  const backends: FfglStudyBackend[] = [];
  for (const id of ids) {
    if (id === "native") backends.push(createNativeBackend());
    else if (id === "resolume") {
      if (process.env["LOOM_FFGL_ORACLE"] !== "1") throw new Error("The Resolume oracle runs only with LOOM_FFGL_ORACLE=1");
      const { createResolumeBackend } = await import("./resolume-backend.ts");
      backends.push(createResolumeBackend());
    } else throw new Error(`No study backend "${id}" yet (VN84 wasm, VN86 port and VN87 glsl plug in here)`);
  }
  return backends;
}

const fmt = (n: number | undefined, digits = 2) => (n === undefined || !Number.isFinite(n) ? "—" : n.toFixed(digits));

export function markdown(report: StudyReport): string {
  const lines: string[] = [`# FFGL study run ${report.startedAt}`, "", `Backends: ${report.backends.join(", ")}. Size: ${report.size}.`, ""];
  lines.push("## Cases", "", "| case | backend | clock | deterministic | claims | load ms | cpu ms (median) | gpu ms (median) |", "|---|---|---|---|---|---|---|---|");
  for (const record of report.cases) {
    const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const claims = record.claims.length ? record.claims.map(c => `${c.ok ? "PASS" : "FAIL"} ${c.claim}`).join("<br>") : "(parity only)";
    lines.push(`| ${record.caseId} | ${record.backend} | ${record.clock} | ${record.deterministic ? "yes" : "NO"} | ${claims} | ${fmt(record.loadMs, 1)} | ${fmt(median(record.cpuMs))} | ${fmt(median(record.gpuMs), 3)} |`);
  }
  if (report.tables.length) {
    lines.push("", "## Parameter-map parity", "");
    for (const table of report.tables)
      lines.push(`- ${table.plugin}, ${table.a} vs ${table.b}: ${table.differences.length === 0 ? "identical" : table.differences.map(d => `[${d.index}] ${d.field}: ${JSON.stringify(d.a)} vs ${JSON.stringify(d.b)}`).join("; ")}`);
  }
  if (report.pixels.length) {
    lines.push("", "## Pixel parity", "", "| case | a vs b | bound | max abs | mean abs | failing | verdict |", "|---|---|---|---|---|---|---|");
    for (const pixel of report.pixels) {
      const worst = pixel.frames.reduce((a, b) => (b.maxAbsolute > a.maxAbsolute ? b : a), pixel.frames[0]!);
      lines.push(`| ${pixel.caseId} | ${pixel.a} vs ${pixel.b} | ${fmt(pixel.tolerance * 255, 1)}/255 (${pixel.reason}) | ${fmt(worst.maxAbsolute * 255, 1)}/255 | ${fmt(worst.meanAbsolute * 255, 3)}/255 | ${worst.failingComponents}/${worst.totalComponents} | ${pixel.matches ? "match" : "DIFFER"} |`);
    }
  }
  if (report.costs.length) {
    lines.push("", "## Cost per frame", "", "| plugin | backend | size | load ms | cpu ms median / p95 | gpu ms median / p95 | hops |", "|---|---|---|---|---|---|---|");
    for (const cost of report.costs)
      lines.push(`| ${cost.plugin} | ${cost.backend} | ${cost.size} | ${fmt(cost.loadMs, 1)} | ${fmt(cost.cpuMs.median)} / ${fmt(cost.cpuMs.p95)} | ${fmt(cost.gpuMs?.median, 3)} / ${fmt(cost.gpuMs?.p95, 3)} | ${cost.hops.join(" → ")} |`);
    if (report.rssBytes !== undefined) lines.push("", `Process max RSS after the cost runs: ${(report.rssBytes / 2 ** 20).toFixed(0)} MiB.`);
  }
  return `${lines.join("\n")}\n`;
}

export interface StudyReport {
  readonly startedAt: string; readonly size: string; readonly backends: readonly string[];
  readonly cases: readonly CaseRecord[]; readonly tables: readonly ParityRecord[]; readonly pixels: readonly PixelParity[];
  readonly costs: readonly CostRecord[]; readonly rssBytes?: number; readonly unavailable: readonly { id: string; reason: string }[];
}

/** Bounds for comparing a backend against native, per backend id. Exact unless a reason says otherwise. */
export const PIXEL_BOUNDS: Readonly<Record<string, OracleBound>> = {
  resolume: { tolerance: 1 / 255, reason: "Arena composites through its own GL pipeline and Syphon; one 8-bit quantum is the smallest disagreement rgba8 can show (TOLERANCE_CROSS_GPU)" },
};

export async function runStudy(options: { backends: readonly string[]; cases?: readonly string[]; size: { width: number; height: number }; cost: boolean }): Promise<StudyReport> {
  const startedAt = new Date().toISOString();
  const requested = await backendsFor(options.backends);
  const backends: FfglStudyBackend[] = [], unavailable: { id: string; reason: string }[] = [];
  for (const backend of requested) {
    const status = await backend.available();
    if (status.ok) backends.push(backend); else unavailable.push({ id: backend.id, reason: status.reason });
  }
  const cases = REFERENCE_CASES.filter(study => !options.cases || options.cases.includes(study.id));
  const records: CaseRecord[] = [];
  for (const study of cases) for (const backend of backends) {
    // Arena runs its own clock: a case that depends on time cannot be reproduced there.
    if (backend.id === "resolume" && !study.clockFree) continue;
    records.push(await runCase(backend, study, options.size, backend.id === "resolume" ? 1 : 2));
  }
  const tables: ParityRecord[] = [], pixels: PixelParity[] = [];
  const native = backends.find(backend => backend.id === "native");
  if (native) {
    for (const other of backends.filter(backend => backend !== native)) {
      for (const plugin of new Set(cases.map(study => study.plugin))) {
        const [a, b] = [await native.load(plugin, options.size), await other.load(plugin, options.size)];
        tables.push(tableParity(plugin, { id: native.id, effect: a }, { id: other.id, effect: b }, other.id === "resolume" ? 16 : Infinity));
        await a.dispose(); await b.dispose();
      }
      for (const study of cases) {
        const a = records.find(r => r.caseId === study.id && r.backend === "native"), b = records.find(r => r.caseId === study.id && r.backend === other.id);
        const bound = PIXEL_BOUNDS[other.id] ?? { tolerance: 0, reason: "same maths, exact" };
        // Arena shows the plugin's premultiplied output composited over its black composition.
        const overBlack = other.id === "resolume"
          ? (image: StudyImage) => { const rgba = image.rgba.slice(); for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255; return { ...image, rgba }; }
          : undefined;
        if (a && b) pixels.push(pixelParity(a, b, bound.tolerance, bound.reason, overBlack));
      }
    }
  }
  const costs: CostRecord[] = [];
  let rssBytes: number | undefined;
  if (options.cost) {
    for (const backend of backends) for (const plugin of new Set(cases.map(study => study.plugin)))
      for (const size of [{ width: 1920, height: 1080 }, { width: 3840, height: 2160 }]) costs.push(await measureCost(backend, plugin, size));
    if (native) rssBytes = (await loadStudyAddon()).diagnostics().maxRssBytes;
  }
  for (const backend of backends) await backend.dispose();
  return { startedAt, size: `${options.size.width}x${options.size.height}`, backends: backends.map(b => b.id), cases: records, tables, pixels, costs,
    ...(rssBytes === undefined ? {} : { rssBytes }), unavailable };
}

export function writeReport(report: StudyReport, directory: string): void {
  mkdirSync(directory, { recursive: true });
  for (const record of report.cases)
    record.frames.forEach((frame, i) => writeFileSync(join(directory, `${record.caseId}.${record.backend}.${i}.png`), encodePng(frame)));
  const serialisable = { ...report, cases: report.cases.map(({ frames: _frames, ...rest }) => rest) };
  writeFileSync(join(directory, "report.json"), `${JSON.stringify(serialisable, null, 2)}\n`);
  writeFileSync(join(directory, "report.md"), markdown(report));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const [width, height] = (value("--size") ?? "1280x720").split("x").map(Number);
  const out = resolve(value("--out") ?? join(".cache", "ffgl-study", `report-${Date.now()}`));
  const report = await runStudy({ backends: (value("--backends") ?? "native").split(","), ...(value("--cases") ? { cases: value("--cases")!.split(",") } : {}),
    size: { width: width!, height: height! }, cost: args.includes("--cost") });
  writeReport(report, out);
  process.stdout.write(markdown(report));
  process.stdout.write(`\nwritten to ${out}\n`);
  if (report.cases.some(record => !record.deterministic || record.claims.some(c => !c.ok))) process.exitCode = 1;
}
