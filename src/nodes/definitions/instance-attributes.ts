import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { MaterialPayload } from "../../domain/types/scene.ts";
import type { PointsetAttributeRef } from "../../domain/types/node-definition.ts";
import { COMPONENT_COUNTS, type PointAttributeType } from "../../points/attributes.ts";
import { isPackedType } from "./instance-records.ts";

/**
 * T1581b — CUSTOM INSTANCE ATTRIBUTES, bound by name
 * (docs/mesh-instancing-design-2026-10-05.md, D9).
 *
 * A Material · WGSL declares what it reads per instance as `struct Instance { … }`. A
 * mesh-instancing Geometry binds each field to an attribute of its Points input:
 *
 *  - by NAME, when the points carry an attribute of the field's name and type;
 *  - by a line of the Geometry's Instance Attributes text, `field = attribute` to rename,
 *    or `field = attribute.channel` to take one component of a float vector into an f32;
 *  - else the field reads its declared `// @default`.
 *
 * Everything else refuses BY NAME (§V288), listing what there is: a line naming a field the
 * material does not declare, an attribute the points do not carry, a type that does not
 * match, and a field with no attribute and no declared default. A misspelt attribute must
 * not draw as a plausible zero.
 *
 * Numbered slots (TouchDesigner's `instanceCustomAttrib0..3`) couple two nodes by index;
 * the attributes have had names and types on the edge since T296, so the name is the bond.
 */
export const INSTANCE_ATTRIBUTE_CODE = "node.scene.instanceAttribute";

type InstanceField = NonNullable<NonNullable<MaterialPayload["custom"]>["instance"]>[number];

/** One field the geometry bound: where on the points its value is read. */
export interface BoundInstanceField {
  readonly name: string;
  /** The field's own type: what the record holds and the material reads. */
  readonly type: PointAttributeType;
  readonly source: Pick<PointsetAttributeRef, "buffer" | "half" | "offset">;
  /** The attribute's type, when a channel of it is taken. */
  readonly sourceType: PointAttributeType;
  readonly channel?: string;
}

const CHANNELS: Readonly<Record<string, number>> = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };

export function bindInstanceAttributes(
  nodeId: string,
  text: string,
  fields: ReadonlyArray<InstanceField>,
  pairs: Readonly<Record<string, PointsetAttributeRef>>,
): { readonly bound: BoundInstanceField[] } | { readonly diagnostics: RuntimeDiagnostic[] } {
  const entries = text
    .split(/[;\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (fields.length === 0 && entries.length === 0) return { bound: [] };
  const diagnostics: RuntimeDiagnostic[] = [];
  const carried = Object.entries(pairs)
    .map(([name, pair]) => `${name} (${pair.type ?? "untyped"})`)
    .sort()
    .join(", ");
  const declared = fields.map((field) => `${field.name} (${field.wgsl})`).join(", ");
  const refuse = (message: string, suggestion: string): void => {
    diagnostics.push({ severity: "error", code: INSTANCE_ATTRIBUTE_CODE, message: `Node "${nodeId}": ${message}`, nodeId, suggestion });
  };
  const byName = new Map(fields.map((field) => [field.name, field] as const));
  const picks = new Map<string, { attribute: string; channel?: string }>();
  for (const entry of entries) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z]))?$/.exec(entry);
    if (match === null) {
      refuse(`Instance Attributes line "${entry}" is not "field = attribute" or "field = attribute.channel".`, "Write one per line, e.g. `glow = heat` or `ring = ids.x`.");
      continue;
    }
    const [, field, attribute, channel] = match as unknown as [string, string, string, string | undefined];
    if (!byName.has(field)) {
      refuse(
        fields.length === 0
          ? `Instance Attributes binds "${field}", but the material declares no \`struct Instance\` to bind it to.`
          : `Instance Attributes binds "${field}", but the material's \`struct Instance\` has no such field.`,
        fields.length === 0 ? "Declare `struct Instance { … }` in the Material · WGSL's source, or clear Instance Attributes." : `The material declares: ${declared}.`,
      );
      continue;
    }
    picks.set(field, { attribute, ...(channel === undefined ? {} : { channel }) });
  }
  const bound: BoundInstanceField[] = [];
  for (const field of fields) {
    if (!isPackedType(field.wgsl)) continue; // the material refused it already, by name
    const pick = picks.get(field.name);
    const attribute = pick?.attribute ?? field.name;
    const pair = pairs[attribute];
    if (pair === undefined) {
      if (pick !== undefined) {
        refuse(`Instance Attributes binds "${field.name}" to "${attribute}", but the points carry no such attribute.`, `The points carry: ${carried}.`);
      } else if (field.default === undefined) {
        refuse(
          `the material's instance field "${field.name}" finds no attribute "${field.name}" on the points and declares no default, so it has no value.`,
          `Write the attribute in the points' kernel, bind another with \`${field.name} = <attribute>\` in Instance Attributes, or give the field a \`// @default\`. The points carry: ${carried}.`,
        );
      }
      continue;
    }
    if (!isPackedType(pair.type)) {
      refuse(`the points' attribute "${attribute}" is ${pair.type ?? "untyped"}, which an instance field cannot read.`, `The points carry: ${carried}.`);
      continue;
    }
    if (pick?.channel !== undefined) {
      const index = CHANNELS[pick.channel];
      const float = pair.type === "vec2f" || pair.type === "vec3f" || pair.type === "vec4f";
      if (field.wgsl !== "f32" || !float || index === undefined || index >= COMPONENT_COUNTS[pair.type]) {
        refuse(
          `Instance Attributes binds "${field.name}" (${field.wgsl}) to "${attribute}.${pick.channel}", but ${
            field.wgsl !== "f32" ? "a channel is one f32 and the field is not" : !float ? `"${attribute}" is ${pair.type}, not a float vector` : `"${attribute}" is ${pair.type} and has no .${pick.channel}`
          }.`,
          `A channel (x y z w, or r g b a) takes one component of a vec2f, vec3f or vec4f attribute into an f32 field. The points carry: ${carried}.`,
        );
        continue;
      }
      bound.push({ name: field.name, type: field.wgsl, source: pair, sourceType: pair.type, channel: pick.channel });
      continue;
    }
    if (pair.type !== field.wgsl) {
      refuse(
        `the material's instance field "${field.name}" is ${field.wgsl}, but the points' attribute "${attribute}" is ${pair.type}.`,
        field.wgsl === "f32" && pair.type.startsWith("vec") && pair.type.endsWith("f")
          ? `Take one component with \`${field.name} = ${attribute}.x\` in Instance Attributes, or declare the field as ${pair.type}.`
          : `Declare the field as ${pair.type}, or bind an attribute of type ${field.wgsl}. The points carry: ${carried}.`,
      );
      continue;
    }
    bound.push({ name: field.name, type: field.wgsl, source: pair, sourceType: pair.type });
  }
  return diagnostics.length > 0 ? { diagnostics } : { bound };
}
