import { prepareShader } from "@vgpu/wgsl/prepare";
import type { ShaderSource } from "vgpu";

/**
 * T1705b: vgpu 0.6.0 takes a PREPARED shader, never a WGSL string. Its `draw`, `effect` and
 * `compute` throw `VGPU-SHADER-SOURCE-UNPREPARED` on a raw string, because reflection moved
 * out of the constructors and into the build. Loom has no build step for shaders: every
 * pass's WGSL is emitted at compile time from the graph, so each one is prepared here, at
 * the moment its consumer is built.
 *
 * A prepared shader is deeply frozen data tied to no device, and vgpu validates a frozen
 * artifact once and reuses the snapshot for every later consumer of that same object. So
 * one artifact is kept per source text: passes of one node type mostly emit identical WGSL
 * (across the shipped examples, 1,800 passes carry 1,113 distinct sources per file), and a
 * recompile rebuilds every pass whose structure changed even when its shader did not.
 *
 * A refusal is never kept: every pass with a broken source throws from its own build, and
 * the backend reports it on that pass's node. The label is the path `prepareShader` hashes
 * into the artifact's mangled names; a kept artifact carries its first caller's, which
 * Loom never reads.
 */
const KEPT = 128;
const kept = new Map<string, ShaderSource>();

export function preparedShader(source: string, label: string): ShaderSource {
  const known = kept.get(source);
  if (known !== undefined) {
    // Most recently used goes last, so the eviction below drops the least recent.
    kept.delete(source);
    kept.set(source, known);
    return known;
  }
  const prepared = prepareShader(source, `${label}.wgsl`);
  kept.set(source, prepared);
  if (kept.size > KEPT) kept.delete(kept.keys().next().value!);
  return prepared;
}
