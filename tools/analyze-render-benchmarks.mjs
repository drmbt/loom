// Paired exploratory analysis. All samples remain in headline statistics.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const median = values => quantile(values, 0.5);
function quantile(values, p) {
  const s = [...values].sort((a, b) => a - b), pos = (s.length - 1) * p;
  const i = Math.floor(pos), fraction = pos - i;
  return s[i] + fraction * ((s[i + 1] ?? s[i]) - s[i]);
}
function summarize(values) {
  const q1 = quantile(values, 0.25), q3 = quantile(values, 0.75), iqr = q3 - q1;
  const center = median(values);
  return { n: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
    median: center, min: Math.min(...values), max: Math.max(...values),
    q1, q3, mad: median(values.map(value => Math.abs(value - center))),
    tukeyOutlierIndexes: values.flatMap((value, index) => value < q1 - 1.5 * iqr || value > q3 + 1.5 * iqr ? [index] : []) };
}
function paired(reference, candidate) {
  if (reference.length !== candidate.length || reference.length < 2) throw Error('Need at least two paired trials');
  const changes = reference.map((value, i) => 100 * (candidate[i] / value - 1));
  let state = 0x12345678;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  const boot = Array.from({ length: 20000 }, () => median(Array.from({ length: changes.length }, () => changes[Math.floor(random() * changes.length)])));
  const a = summarize(reference), b = summarize(candidate), flagged = new Set([...a.tukeyOutlierIndexes, ...b.tukeyOutlierIndexes]);
  const sensitivity = changes.filter((_, i) => !flagged.has(i));
  return { reference: a, candidate: b, pairedPercentChanges: changes,
    medianPairedPercentChange: median(changes), meanPairedPercentChange: changes.reduce((x, y) => x + y, 0) / changes.length,
    exploratoryPairedBootstrap95Pct: [quantile(boot, 0.025), quantile(boot, 0.975)],
    sensitivityOnly: { flaggedPairIndexes: [...flagged], retainedPairs: sensitivity.length,
      medianPercentChange: sensitivity.length ? median(sensitivity) : null },
    caveat: `${reference.length} paired trials give an exploratory interval. Outlier flags are descriptive; no sample is removed from headline results. This does not quantify unrelated background load or prove all workloads improve.` };
}
function analyze(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data.results) return { input: path, workloads: data.results.map(result => ({ mode: result.mode, count: data.environment.count,
    totalDrawsPerFrame: result.entries[0].trials?.[0]?.drawsPerFrame, passDrawCounts: result.entries[0].trials?.[0]?.passDrawCounts,
    ...paired(result.entries[0].samples, result.entries[1].samples),
    gpuPassTimeMs: result.entries.every(entry => entry.trials?.every(trial => trial.gpuPassTiming !== undefined)) ? paired(
      result.entries[0].trials.map(trial => trial.gpuPassTiming.samples.reduce((a, b) => a + b, 0) / trial.gpuPassTiming.samples.length),
      result.entries[1].trials.map(trial => trial.gpuPassTiming.samples.reduce((a, b) => a + b, 0) / trial.gpuPassTiming.samples.length)) : undefined,
    completionTimeMs: result.entries.every(entry => entry.trials?.every(trial => trial.completionTimingMs !== undefined)) ? paired(
      result.entries[0].trials.map(trial => trial.completionTimingMs.samples.reduce((a, b) => a + b, 0) / trial.completionTimingMs.samples.length),
      result.entries[1].trials.map(trial => trial.completionTimingMs.samples.reduce((a, b) => a + b, 0) / trial.completionTimingMs.samples.length)) : undefined,
    observer: result.entries.map(entry => ({ label: entry.label,
      emptyClockIntervalUs: entry.trials ? summarize(entry.trials.map(trial => trial.clockCalibration.meanUs)) : null,
      estimatedUsPerDraw: entry.trials ? summarize(entry.trials.map(trial => trial.estimatedObserverUsPerDraw)) : null })) })) };
  if (data.scenarios) return { input: path, scenarios: Object.fromEntries(Object.entries(data.scenarios).map(([name, scenario]) => [name, {
    cpuEncodeMs: paired(scenario.results.map(trial => trial.reference.cpuEncodeMs.median), scenario.results.map(trial => trial.candidate.cpuEncodeMs.median)),
    gpuSegmentExtentMs: paired(scenario.results.map(trial => trial.reference.gpuRenderExtentMs.median), scenario.results.map(trial => trial.candidate.gpuRenderExtentMs.median)),
    caveat: 'GPU timestamp quantization and segment boundaries limit interpretation of small timing differences.' }])) };
  throw Error(`Unsupported benchmark data: ${path}`);
}
const files = process.argv.slice(2);
if (!files.length) throw Error('Pass one or more benchmark JSON files');
console.log(JSON.stringify({ analysisScriptHash: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'), method: 'Means, medians, MAD, Tukey flags, paired percentage changes, fixed-seed 20,000-resample exploratory bootstrap and outlier sensitivity. Every trial retained.', reports: files.map(analyze) }, null, 2));
