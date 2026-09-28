import type { ParameterDefinition, ParameterValue } from "../domain/types/parameters.ts";

/**
 * T1432b — pixel-sized parameters, scaled to the render (see `ProjectSettings.referenceWidth`).
 *
 * A node compiles against the values this returns, never the stored ones: every parameter
 * whose definition declares `scalesWithOutput` is multiplied by `scale`, everything else
 * passes through. Both compile paths call it — the full compile when it builds a node's
 * context, and the per-frame values-only compile when it re-resolves an animated node — so
 * an animated blur radius scales exactly as a still one does.
 *
 * `scale === 1` returns the SAME object: a project without a reference compiles exactly the
 * uniforms it always did, not merely equal ones.
 */
export function scaleOutputPixels(
  values: Readonly<Record<string, ParameterValue>>,
  schema: Readonly<Record<string, ParameterDefinition>>,
  scale: number,
): Readonly<Record<string, ParameterValue>> {
  if (scale === 1) return values;
  let scaled: Record<string, ParameterValue> | undefined;
  for (const [key, definition] of Object.entries(schema)) {
    if (definition.type !== "number" || definition.scalesWithOutput !== true) continue;
    const value = values[key];
    if (typeof value !== "number") continue;
    scaled ??= { ...values };
    scaled[key] = value * scale;
  }
  return scaled ?? values;
}
