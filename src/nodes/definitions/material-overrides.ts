import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { MaterialPayload } from "../../domain/types/scene.ts";

/**
 * T1415b — per-object MATERIAL OVERRIDES: a Geometry changes some of the values of the
 * material it wears, for itself only, without a second material node.
 *
 * The need, from On Nothing: one shot's sedan wants the stock surface with black paint, a
 * close-up wants the jewellery rougher. Forking the material (a second Material · WGSL with a
 * copied, patched source) duplicates the code and drifts from it. A geometry already carries
 * its own copy of the material's VALUES (the payload, per draw), so an override is a change to
 * that copy: the draw's uniforms, never the shader, never the other geometries wearing it.
 *
 * Text, one entry per line or `;`: `name = value`, the value one number or a vector's
 * components (spaces or commas). Names: `roughness` and `metallic` (every model), and any
 * field of a Material · WGSL's `struct Params`. An unknown name or a wrong component count
 * refuses BY NAME (§V288), listing what the material does have: a typo must not render the
 * un-overridden material as if it were the override.
 */
export const MATERIAL_OVERRIDE_CODE = "node.scene.override";

const STOCK = ["roughness", "metallic"] as const;

/** The component count a reflected WGSL field takes (f32 → 1, vecNf → N). */
function componentsOf(wgsl: string): number {
  const match = /^vec([234])/.exec(wgsl);
  return match === null ? 1 : Number(match[1]);
}

export function applyMaterialOverrides(
  nodeId: string,
  text: string,
  material: MaterialPayload,
): { readonly material: MaterialPayload } | { readonly diagnostics: RuntimeDiagnostic[] } {
  const entries = text
    .split(/[;\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) return { material };
  const fields = new Map((material.custom?.fields ?? []).map((field) => [field.name, componentsOf(field.wgsl)] as const));
  const known = [...STOCK, ...fields.keys()];
  const diagnostics: RuntimeDiagnostic[] = [];
  const refuse = (message: string): void => {
    diagnostics.push({
      severity: "error",
      code: MATERIAL_OVERRIDE_CODE,
      message: `Node "${nodeId}": ${message}`,
      nodeId,
      suggestion: `Write one "name = value" per line. This material overrides: ${known.join(", ")}.`,
    });
  };
  let roughness = material.roughness;
  let metallic = material.metallic;
  const uniforms: Record<string, number | readonly number[]> = { ...(material.custom?.uniforms ?? {}) };
  for (const entry of entries) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(entry);
    if (match === null) {
      refuse(`material override "${entry}" is not "name = value".`);
      continue;
    }
    const name = match[1]!;
    const values = match[2]!.split(/[\s,()]+/).filter((part) => part !== "").map(Number);
    if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
      refuse(`material override "${name}" has a value that is not numbers: "${match[2]}".`);
      continue;
    }
    const count = name === "roughness" || name === "metallic" ? 1 : fields.get(name);
    if (count === undefined) {
      refuse(`the material has no "${name}" to override.`);
      continue;
    }
    if (values.length !== count) {
      refuse(`material override "${name}" takes ${count} number${count === 1 ? "" : "s"}, got ${values.length}.`);
      continue;
    }
    if (name === "roughness") roughness = values[0]!;
    else if (name === "metallic") metallic = values[0]!;
    else uniforms[name] = count === 1 ? values[0]! : values;
  }
  if (diagnostics.length > 0) return { diagnostics };
  return {
    material: {
      ...material,
      roughness,
      metallic,
      ...(material.custom === undefined ? {} : { custom: { ...material.custom, uniforms } }),
    },
  };
}
