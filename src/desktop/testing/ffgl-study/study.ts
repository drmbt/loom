import { compareFrames, type PixelDifference } from "../../../tests/headless/pixel-compare.ts";
import { diffFfglTables, ffglControls, type FfglManifest, type FfglTableDifference } from "../../../nodes/definitions/ffgl-manifest.ts";
import { digest, sameBytes, testCard } from "./images.ts";
import type { StudyCase, StudyClaim } from "./cases.ts";
import type { FfglStudyBackend, LoadedStudyEffect, StudyControl, StudyImage, StudyRegion, StudyStep } from "./types.ts";

/** The controls a host shows for a raw FFGL table: the SAME grouping the Loom node uses (ffgl-manifest.ts). */
export function controlsOf(manifest: FfglManifest): StudyControl[] {
  return ffglControls(manifest).map(control => {
    switch (control.kind) {
      case "float": case "integer": return { label: control.label, kind: control.kind, min: control.min, max: control.max };
      case "menu": return { label: control.label, kind: "menu", options: control.options.length };
      case "hsba": case "rgb": return { label: control.label, kind: "color" };
      case "unsupported": return { label: control.label, kind: "other" };
      default: return { label: control.label, kind: control.kind };
    }
  });
}

/** Keeps only the covered regions of an image (the rest zero), so a partial capture compares like for like. */
export function maskTo(image: StudyImage, coverage: readonly StudyRegion[] | undefined): StudyImage {
  if (!coverage) return image;
  const rgba = new Uint8Array(image.rgba.length);
  for (const region of coverage)
    for (let y = region.y; y < region.y + region.height; y++) {
      const start = (y * image.width + region.x) * 4;
      rgba.set(image.rgba.subarray(start, start + region.width * 4), start);
    }
  return { width: image.width, height: image.height, rgba };
}

/** Parameter-map parity as hosts PRESENT it: count, then per position label (truncated), kind, range and option count. */
export function controlParity(a: readonly StudyControl[], b: readonly StudyControl[], nameLength = Infinity): FfglTableDifference[] {
  const differences: FfglTableDifference[] = [];
  if (a.length !== b.length) differences.push({ index: -1, field: "count", a: a.length, b: b.length });
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const l = a[i]!, r = b[i]!;
    if (l.label.slice(0, nameLength) !== r.label.slice(0, nameLength)) differences.push({ index: i, field: "label", a: l.label, b: r.label });
    if (l.kind !== r.kind) differences.push({ index: i, field: "kind", a: l.kind, b: r.kind });
    if (l.min !== r.min || l.max !== r.max) differences.push({ index: i, field: "range", a: [l.min, l.max], b: [r.min, r.max] });
    if (l.options !== r.options) differences.push({ index: i, field: "options", a: l.options, b: r.options });
  }
  return differences;
}

/** VN91: what the harness records for one backend running one case. */
export interface CaseRecord {
  readonly backend: string;
  readonly caseId: string;
  readonly plugin: string;
  readonly size: string;
  readonly loadMs: number;
  readonly clock: string;
  readonly claims: readonly StudyClaim[];
  /** Same run, same bytes, across `repeats` runs on fresh instances. */
  readonly deterministic: boolean;
  readonly digests: readonly string[];
  readonly frames: readonly StudyImage[];
  /** Regions the backend captured, when it could not capture whole frames. */
  readonly coverage?: readonly StudyRegion[];
  readonly cpuMs: readonly number[];
  readonly gpuMs: readonly number[];
  readonly hops: readonly string[];
}

async function withEffect<T>(backend: FfglStudyBackend, plugin: string, size: { width: number; height: number }, body: (effect: LoadedStudyEffect) => Promise<T>): Promise<T> {
  const effect = await backend.load(plugin, size);
  try { return await body(effect); } finally { await effect.dispose(); }
}

/** Runs a case `repeats` times, each on a FRESH instance (so feedback state cannot leak between runs). */
export async function runCase(backend: FfglStudyBackend, study: StudyCase, size: { width: number; height: number }, repeats = 2): Promise<CaseRecord> {
  const run = study.run(size);
  const attempts: { frames: readonly StudyImage[]; coverage?: readonly StudyRegion[]; cpu: number[]; gpu: number[]; hops: readonly string[]; loadMs: number; clock: string }[] = [];
  for (let r = 0; r < repeats; r++) {
    attempts.push(await withEffect(backend, study.plugin, size, async effect => {
      const result = await effect.render(run);
      return { frames: result.frames, ...(result.coverage ? { coverage: result.coverage } : {}), cpu: result.costs.map(c => c.cpuMs), gpu: result.costs.flatMap(c => (c.gpuMs === undefined ? [] : [c.gpuMs])),
        hops: result.costs[0]?.hops ?? [], loadMs: effect.loadMs, clock: effect.capabilities.clock };
    }));
  }
  const first = attempts[0]!;
  const deterministic = attempts.every(attempt => attempt.frames.length === first.frames.length && attempt.frames.every((frame, i) => sameBytes(frame, first.frames[i]!)));
  return {
    backend: backend.id, caseId: study.id, plugin: study.plugin, size: `${size.width}x${size.height}`,
    loadMs: first.loadMs, clock: first.clock, deterministic,
    // A partial capture is judged on what it captured: the input is masked the same way.
    claims: study.claims(maskTo(run.input, first.coverage), first.frames.map(frame => maskTo(frame, first.coverage))),
    digests: first.frames.map(digest), frames: first.frames, ...(first.coverage ? { coverage: first.coverage } : {}),
    cpuMs: first.cpu, gpuMs: first.gpu, hops: first.hops,
  };
}

export interface ParityRecord { readonly plugin: string; readonly a: string; readonly b: string; readonly differences: readonly FfglTableDifference[] }
/** Raw-table parity when both hosts expose the FFGL table, otherwise parity of the controls they present. */
export function tableParity(plugin: string, a: { id: string; effect: LoadedStudyEffect }, b: { id: string; effect: LoadedStudyEffect }, nameLength = Infinity): ParityRecord {
  const differences = a.effect.manifest && b.effect.manifest
    ? diffFfglTables(a.effect.manifest.parameters, b.effect.manifest.parameters, { nameLength })
    : controlParity(a.effect.controls, b.effect.controls, nameLength);
  return { plugin, a: a.id, b: b.id, differences };
}

export interface PixelParity { readonly caseId: string; readonly a: string; readonly b: string; readonly tolerance: number; readonly reason: string; readonly frames: readonly PixelDifference[]; readonly matches: boolean }
/**
 * Pixel parity between two backends' frames for one case, with a stated per-channel bound in
 * 0..1 units (TOLERANCE_EXACT, TOLERANCE_CROSS_GPU …)
 * (pixel-compare.ts's regimes; the reason goes in the report next to the number).
 */
export function pixelParity(a: CaseRecord, b: CaseRecord, tolerance: number, reason: string, prepare: (image: StudyImage) => StudyImage = image => image): PixelParity {
  const coverage = b.coverage ?? a.coverage;
  const frames = a.frames.map((raw, i) => {
    const frame = prepare(maskTo(raw, coverage)), captured = b.frames[i], other = captured && prepare(maskTo(captured, coverage));
    const as = (image: StudyImage) => ({ frameIndex: i, width: image.width, height: image.height, format: "rgba8unorm" as const, bytes: image.rgba });
    return other ? compareFrames(as(frame), as(other), tolerance)
      : { matches: false, maxAbsolute: Infinity, meanAbsolute: Infinity, failingComponents: 0, totalComponents: 0, incompatible: "missing frame" };
  });
  return { caseId: a.caseId, a: a.backend, b: b.backend, tolerance, reason, frames, matches: frames.every(frame => frame.matches) };
}

export interface CostRecord {
  readonly backend: string; readonly plugin: string; readonly size: string; readonly frames: number; readonly loadMs: number;
  readonly cpuMs: { readonly median: number; readonly p95: number }; readonly gpuMs?: { readonly median: number; readonly p95: number };
  readonly hops: readonly string[]; readonly rssBytes?: number;
}
const quantile = (values: readonly number[], q: number) => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : NaN;
};
/** Cost per frame at one size: `frames` steady frames after `warmup`, the effect's defaults, time advancing at 60 fps. */
export async function measureCost(backend: FfglStudyBackend, plugin: string, size: { width: number; height: number }, frames = 60, warmup = 5,
  rss?: () => number): Promise<CostRecord> {
  return withEffect(backend, plugin, size, async effect => {
    const steps: StudyStep[] = [];
    for (let i = 0; i < warmup + frames; i++) steps.push({ time: i / 60, bpm: 120, barPhase: (i / 120) % 1 });
    const result = await effect.render({ input: testCard(size.width, size.height), steps, capture: "last" });
    const kept = result.costs.slice(warmup);
    const cpu = kept.map(c => c.cpuMs), gpu = kept.flatMap(c => (c.gpuMs === undefined ? [] : [c.gpuMs]));
    return {
      backend: backend.id, plugin, size: `${size.width}x${size.height}`, frames, loadMs: effect.loadMs,
      cpuMs: { median: quantile(cpu, 0.5), p95: quantile(cpu, 0.95) },
      ...(gpu.length ? { gpuMs: { median: quantile(gpu, 0.5), p95: quantile(gpu, 0.95) } } : {}),
      hops: kept[0]?.hops ?? [], ...(rss ? { rssBytes: rss() } : {}),
    };
  });
}
