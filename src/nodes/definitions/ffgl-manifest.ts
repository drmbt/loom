/**
 * VN85 / VN91: what an FFGL plugin's parameter table MEANS, in one place.
 *
 * A plugin describes itself through plugMain (FF_GET_PARAMETER_NAME/TYPE/DEFAULT/RANGE and the
 * option elements). Every way of bringing a plugin into Loom reads that same table: the native
 * host (VN85) from the binary, the browser WASM host (VN84) from its manifest, the parity
 * harness (VN91) from both and from Resolume. This module turns the raw table into the controls
 * a Loom node shows, and is the ONLY place that does, so two hosts cannot disagree about what
 * `Tint_saturation` is (§V349's argument for one reflector, applied to FFGL).
 *
 * It runs headless and reads nothing but its argument: a node definition (§V11, §V44) and a
 * Node script import it alike.
 *
 * The grouping rules are the FFGL SDK's own, from the quickstart's SendParams
 * (ffglquickstart/FFGLPlugin.cpp): a HUE parameter followed by SATURATION, BRIGHTNESS and ALPHA
 * is ONE colour, as Resolume shows it; RED, GREEN, BLUE in a row are one RGB colour. Option
 * values are the element VALUES the plugin reports, not their positions.
 */

/** FFGL 2.x parameter types (FFGL.h). */
export const FFGL_TYPE = {
  boolean: 0, event: 1, red: 2, green: 3, blue: 4, xpos: 5, ypos: 6, standard: 10, option: 11,
  buffer: 12, integer: 13, file: 14, text: 100, hue: 200, saturation: 201, brightness: 202, alpha: 203,
} as const;

/** One row of a plugin's own enumeration, exactly as the host read it. */
export interface FfglRawParameter {
  readonly index: number;
  readonly name: string;
  readonly type: number;
  readonly default: number | string;
  readonly range: { readonly min: number; readonly max: number };
  readonly group?: string;
  readonly visible?: boolean;
  readonly elements: ReadonlyArray<{ readonly name: string; readonly value: number }>;
}

/** A plugin's identity and table: what a document stores, so it renders the same schema anywhere. */
export interface FfglManifest {
  readonly format: 1;
  /** The FFGL 4cc (`VGNP`). */
  readonly id: string;
  /** The bundle name the plugin folders resolve (`VignettePlus`). */
  readonly name: string;
  readonly version: string;
  readonly parameters: readonly FfglRawParameter[];
}

export type FfglControl =
  | { readonly kind: "float"; readonly key: string; readonly label: string; readonly index: number; readonly default: number; readonly min: number; readonly max: number }
  | { readonly kind: "integer"; readonly key: string; readonly label: string; readonly index: number; readonly default: number; readonly min: number; readonly max: number }
  | { readonly kind: "toggle"; readonly key: string; readonly label: string; readonly index: number; readonly default: boolean }
  | { readonly kind: "pulse"; readonly key: string; readonly label: string; readonly index: number }
  | { readonly kind: "menu"; readonly key: string; readonly label: string; readonly index: number; readonly default: number;
      readonly options: ReadonlyArray<{ readonly label: string; readonly value: number }> }
  | { readonly kind: "hsba"; readonly key: string; readonly label: string; readonly indices: readonly [number, number, number, number];
      readonly default: readonly [number, number, number, number] }
  | { readonly kind: "rgb"; readonly key: string; readonly label: string; readonly indices: readonly [number, number, number];
      readonly default: readonly [number, number, number] }
  | { readonly kind: "text"; readonly key: string; readonly label: string; readonly index: number; readonly default: string }
  | { readonly kind: "unsupported"; readonly key: string; readonly label: string; readonly index: number; readonly reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Validates an untrusted manifest (a stored document value, a host's reply). Throws with the reason. */
export function parseFfglManifest(value: unknown): FfglManifest {
  if (!isRecord(value) || value["format"] !== 1) throw new Error("FFGL manifest must be an object with format 1");
  const { id, name, version, parameters } = value;
  if (typeof id !== "string" || id.length > 4) throw new Error("FFGL manifest id must be the plugin's 4cc");
  if (typeof name !== "string" || name.length === 0 || name.length > 64) throw new Error("FFGL manifest needs the plugin name");
  if (typeof version !== "string") throw new Error("FFGL manifest needs a version string");
  if (!Array.isArray(parameters) || parameters.length > 4096) throw new Error("FFGL manifest parameters must be a list");
  const parsed = parameters.map((entry, position): FfglRawParameter => {
    if (!isRecord(entry)) throw new Error(`FFGL parameter ${position} is not an object`);
    const { index, name: label, type, default: fallback, range, elements } = entry;
    if (index !== position) throw new Error(`FFGL parameter ${position} is out of order`);
    if (typeof label !== "string" || !Number.isInteger(type)) throw new Error(`FFGL parameter ${position} needs a name and a type`);
    if (typeof fallback !== "number" && typeof fallback !== "string") throw new Error(`FFGL parameter ${position} has no default`);
    if (!isRecord(range) || !Number.isFinite(range["min"]) || !Number.isFinite(range["max"])) throw new Error(`FFGL parameter ${position} has no range`);
    if (!Array.isArray(elements) || !elements.every(e => isRecord(e) && typeof e["name"] === "string" && Number.isFinite(e["value"])))
      throw new Error(`FFGL parameter ${position} has malformed elements`);
    return {
      index: position, name: label, type: type as number, default: fallback,
      range: { min: range["min"] as number, max: range["max"] as number },
      ...(typeof entry["group"] === "string" ? { group: entry["group"] } : {}),
      ...(typeof entry["visible"] === "boolean" ? { visible: entry["visible"] } : {}),
      elements: elements.map(e => ({ name: (e as Record<string, unknown>)["name"] as string, value: (e as Record<string, unknown>)["value"] as number })),
    };
  });
  return { format: 1, id, name, version, parameters: parsed };
}

/** The keys a node owns outright; a reflected control never takes one. */
export const FFGL_RESERVED_KEYS: ReadonlySet<string> = new Set(["plugin", "manifest", "input", "out"]);

/** `Tint_saturation` → `tintSaturation`; `BlackBG` → `blackBG`. Letters and digits only. */
function keyOf(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = words.map((word, i) => (i === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1))).join("");
  return /^[a-z]/.test(joined) ? joined : `p${joined}`;
}

/**
 * The controls a node shows, in the plugin's order. Keys are derived from names, made unique
 * (a second `Amount` is `amount2`) and kept off FFGL_RESERVED_KEYS.
 */
export function ffglControls(manifest: FfglManifest): FfglControl[] {
  const used = new Set<string>(FFGL_RESERVED_KEYS);
  const unique = (name: string) => {
    const base = keyOf(name);
    let key = base, n = 2;
    while (used.has(key)) key = `${base}${n++}`;
    used.add(key);
    return key;
  };
  const p = manifest.parameters;
  const numeric = (parameter: FfglRawParameter) => (typeof parameter.default === "number" ? parameter.default : 0);
  const controls: FfglControl[] = [];
  for (let i = 0; i < p.length; i++) {
    const parameter = p[i] as FfglRawParameter;
    const { type, name, index } = parameter;
    const next = (offset: number) => p[i + offset]?.type;
    if (type === FFGL_TYPE.hue && next(1) === FFGL_TYPE.saturation && next(2) === FFGL_TYPE.brightness && next(3) === FFGL_TYPE.alpha) {
      const quad = [p[i], p[i + 1], p[i + 2], p[i + 3]] as FfglRawParameter[];
      controls.push({ kind: "hsba", key: unique(name), label: name, indices: [index, index + 1, index + 2, index + 3],
        default: [numeric(quad[0]!), numeric(quad[1]!), numeric(quad[2]!), numeric(quad[3]!)] });
      i += 3; continue;
    }
    if (type === FFGL_TYPE.red && next(1) === FFGL_TYPE.green && next(2) === FFGL_TYPE.blue) {
      controls.push({ kind: "rgb", key: unique(name), label: name, indices: [index, index + 1, index + 2],
        default: [numeric(parameter), numeric(p[i + 1]!), numeric(p[i + 2]!)] });
      i += 2; continue;
    }
    const key = unique(name);
    switch (type) {
      case FFGL_TYPE.standard: case FFGL_TYPE.xpos: case FFGL_TYPE.ypos:
      case FFGL_TYPE.red: case FFGL_TYPE.green: case FFGL_TYPE.blue:
      case FFGL_TYPE.hue: case FFGL_TYPE.saturation: case FFGL_TYPE.brightness: case FFGL_TYPE.alpha:
        controls.push({ kind: "float", key, label: name, index, default: numeric(parameter), min: parameter.range.min, max: parameter.range.max });
        break;
      case FFGL_TYPE.integer:
        controls.push({ kind: "integer", key, label: name, index, default: numeric(parameter), min: parameter.range.min, max: parameter.range.max });
        break;
      case FFGL_TYPE.boolean:
        controls.push({ kind: "toggle", key, label: name, index, default: numeric(parameter) !== 0 });
        break;
      case FFGL_TYPE.event:
        controls.push({ kind: "pulse", key, label: name, index });
        break;
      case FFGL_TYPE.option:
        controls.push({ kind: "menu", key, label: name, index, default: numeric(parameter),
          options: parameter.elements.map(element => ({ label: element.name, value: element.value })) });
        break;
      case FFGL_TYPE.text: case FFGL_TYPE.file:
        controls.push({ kind: "text", key, label: name, index, default: typeof parameter.default === "string" ? parameter.default : "" });
        break;
      default:
        controls.push({ kind: "unsupported", key, label: name, index, reason: `FFGL parameter type ${type} has no Loom control` });
    }
  }
  return controls;
}

/** One difference between two tables, worded for a parity report. */
export interface FfglTableDifference { readonly index: number; readonly field: string; readonly a: unknown; readonly b: unknown }

/**
 * Parameter-map parity between two hosts' readings of the same plugin: count, then per index
 * name, type, default, range and option elements. `nameLength` compares names truncated, for a
 * host that truncates them (Resolume's API keeps 16 characters).
 */
export function diffFfglTables(a: readonly FfglRawParameter[], b: readonly FfglRawParameter[], { nameLength = Infinity } = {}): FfglTableDifference[] {
  const differences: FfglTableDifference[] = [];
  if (a.length !== b.length) differences.push({ index: -1, field: "count", a: a.length, b: b.length });
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const left = a[i]!, right = b[i]!;
    if (left.name.slice(0, nameLength) !== right.name.slice(0, nameLength)) differences.push({ index: i, field: "name", a: left.name, b: right.name });
    if (left.type !== right.type) differences.push({ index: i, field: "type", a: left.type, b: right.type });
    if (left.default !== right.default) differences.push({ index: i, field: "default", a: left.default, b: right.default });
    if (left.range.min !== right.range.min || left.range.max !== right.range.max)
      differences.push({ index: i, field: "range", a: left.range, b: right.range });
    const le = left.elements.map(e => `${e.name}=${e.value}`).join("|"), re = right.elements.map(e => `${e.name}=${e.value}`).join("|");
    if (le !== re) differences.push({ index: i, field: "elements", a: le, b: re });
  }
  return differences;
}
