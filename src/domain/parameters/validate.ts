import type { NodeId } from "../types/ids.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type {
  ParameterDefinition,
  ParameterSchema,
  ParameterValue,
  StoredParameter,
} from "../types/parameters.ts";
import { nearestSpelling, parseExpression } from "../expressions/index.ts";
import { numericRangeOf } from "./expression-range.ts";
import { componentDefinition, componentNamesFor, isComponentKeyOf, isParameterSlot, parseComponentKey } from "./slots.ts";

/**
 * Parameter validation against a node manifest's `ParameterSchema`.
 *
 * Values arriving from an agent patch, a file load, or an inspector edit are all
 * untrusted (§V37) and are checked here before they reach the document. Failing loud
 * beats coercing: a wrong-typed parameter is a rejected command, not a silent default.
 */

function error(code: string, message: string, nodeId?: NodeId, suggestion?: string): RuntimeDiagnostic {
  return {
    severity: "error",
    code,
    message,
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(suggestion === undefined ? {} : { suggestion }),
  };
}

function isNumberArray(value: ParameterValue, size?: number): value is readonly number[] {
  if (!Array.isArray(value)) return false;
  if (size !== undefined && value.length !== size) return false;
  return value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

/**
 * T1434b — a VALID value in the shape every reader expects: an rgb colour completed to rgba
 * with alpha 1. Everything else is returned as it is (the same object), so no other value's
 * identity changes on the read path.
 */
export function completeParameterValue(definition: ParameterDefinition, value: ParameterValue): ParameterValue {
  if (definition.type === "color" && Array.isArray(value) && value.length === 3) return [...(value as readonly number[]), 1];
  return value;
}

/** Validates one value. Returns null when the value is acceptable for the definition. */
export function validateParameterValue(
  key: string,
  definition: ParameterDefinition,
  value: ParameterValue,
  nodeId?: NodeId,
): RuntimeDiagnostic | null {
  const wrongType = (expected: string): RuntimeDiagnostic =>
    error(
      "parameter.type",
      `Parameter "${key}" expects ${expected}, received ${describeValue(value)}.`,
      nodeId,
    );

  switch (definition.type) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return wrongType("a finite number");
      // §B111: only the ends the parameter DECLARES as limits reject. `min`/`max` alone
      // are the slider's travel, and a stored rotation of 725° is a valid document — it
      // is what an author who dragged past one turn, or bound `abstime * 7`, has. This is
      // the third clamp site and it had to move with the other two, or a document the
      // resolver now produces would fail to load (§V437: the property, not a site).
      const range = numericRangeOf(definition);
      if (range !== null && range.min !== null && value < range.min) {
        return error(
          "parameter.range",
          `Parameter "${key}" is ${value}, below its minimum ${range.min}.`,
          nodeId,
          `Use a value >= ${range.min}.`,
        );
      }
      if (range !== null && range.max !== null && value > range.max) {
        return error(
          "parameter.range",
          `Parameter "${key}" is ${value}, above its maximum ${range.max}.`,
          nodeId,
          `Use a value <= ${range.max}.`,
        );
      }
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : wrongType("a boolean");
    case "enum": {
      if (typeof value !== "string") return wrongType("an enum option string");
      const allowed = definition.options.map((option) => option.value);
      if (!allowed.includes(value)) {
        return error(
          "parameter.enum",
          `Parameter "${key}" got "${value}", which is not one of: ${allowed.join(", ")}.`,
          nodeId,
        );
      }
      return null;
    }
    case "color":
      // T1434b: rgb is a colour too — a shader's `vec3f` tint has no alpha to give. The
      // resolver completes it to rgba (alpha 1) before anything reads it.
      return isNumberArray(value, 4) || isNumberArray(value, 3) ? null : wrongType("3 or 4 finite numbers (rgb or rgba)");
    case "vector":
      return isNumberArray(value, definition.size)
        ? null
        : wrongType(`${definition.size} finite numbers`);
    case "string":
      return typeof value === "string" ? null : wrongType("a string");
    case "code":
      // Code travels as a string; its LANGUAGE gates highlighting, never validity —
      // a kernel that does not compile is the compiler's diagnostic, not the file's.
      return typeof value === "string" ? null : wrongType("a string of source code");
    case "asset":
      // null is the legitimate "no asset bound yet" state (§C relink flow).
      return value === null || typeof value === "string" ? null : wrongType("an asset id or null");
    case "pulse":
      // A pulse is armed or it is not, so the VALUE rule is the boolean one. What a pulse
      // may be STORED as is narrower — see `storedPulseValue` below, which is where §V124
      // lives. Keeping the two apart matters: an expression driving a pulse resolves to
      // `true` for the frame it fires on, and this function is also what checks THAT.
      return typeof value === "boolean" ? null : wrongType("a boolean trigger");
    case "stops": {
      if (!Array.isArray(value)) return wrongType("an array of {position, color} stops");
      const max = definition.maxStops;
      if (max !== undefined && value.length > max) {
        // Refused at the boundary rather than truncated on the way to the GPU: a
        // gradient silently missing its last two colours is a bug nobody can see the
        // cause of.
        return error(
          "parameter.stops.count",
          `Parameter "${key}" has ${value.length} stops; "${definition.label}" carries at most ${max}.`,
          nodeId,
        );
      }
      const ok = value.every((stop) => {
        if (typeof stop !== "object" || stop === null) return false;
        const entry = stop as { position?: unknown; color?: unknown };
        if (typeof entry.position !== "number" || !Number.isFinite(entry.position)) return false;
        return (
          Array.isArray(entry.color) &&
          entry.color.length === 4 &&
          entry.color.every((channel) => typeof channel === "number" && Number.isFinite(channel))
        );
      });
      return ok ? null : wrongType("an array of {position, color: [r,g,b,a]} stops");
    }
    case "curve": {
      if (!Array.isArray(value)) return wrongType("an array of {x, y} points");
      const ok = value.every(
        (point) =>
          typeof point === "object" &&
          point !== null &&
          typeof (point as { x?: unknown }).x === "number" &&
          typeof (point as { y?: unknown }).y === "number",
      );
      return ok ? null : wrongType("an array of {x, y} points");
    }
    default: {
      const never: never = definition;
      void never;
      return null;
    }
  }
}

function describeValue(value: ParameterValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of length ${value.length}`;
  return typeof value;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * §T1641b slice 2 — ONE ANSWER TO "DOES THIS NODE DECLARE THIS STORED KEY"
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * Two things asked it and gave two answers. The write gate refused an undeclared key as
 * `parameter.unknown`, an error, with the keys it knew. The compile, the only thing a
 * document built by code ever meets, reported the same key as `compiler/parameter-unknown`,
 * a warning, in other words and without the keys; §B264's light stayed red for a day behind
 * it. `declaresParameter` is the question and `undeclaredParameter` is the finding, for
 * both: the bus refuses a write with it, and the compile reports what is already stored
 * with it (an error the class table marks `local`, so the picture does not go black).
 */

/** Does `schema` declare `key`, as a parameter or as a part of a compound one (§V113)? */
export function declaresParameter(schema: ParameterSchema, key: string): boolean {
  return Object.hasOwn(schema, key) || isComponentKeyOf(schema, key);
}

/**
 * The stored keys the schema does not declare, sorted. `retained` are a definition's
 * `retainedParameterKeys`: variant settings kept on purpose for a later switch.
 */
export function undeclaredKeys(
  schema: ParameterSchema,
  stored: Readonly<Record<string, unknown>>,
  retained: readonly string[] = [],
): string[] {
  return Object.keys(stored)
    .sort()
    .filter((key) => !declaresParameter(schema, key) && !retained.includes(key));
}

export interface UndeclaredParameterContext {
  /**
   * A document AT REST: the node that stores the key. Absent at the write gate, whose
   * finding is a refusal of the write and names only the key.
   */
  readonly stored?: { readonly nodeId: NodeId; readonly type: string } | undefined;
  /**
   * How this node's keys come about, when its author wrote them
   * (`NodeDefinition.parameterKeysNote`): a reflecting node's naming rule, which nothing in
   * the shader shows (§B264 (2)).
   */
  readonly keysNote?: string | undefined;
}

/** How a key nothing reads leaves the document: the command, and the operation it applies. */
const REMOVE_REMEDY = "Or remove the stored value: parameter.removeUndeclared (in a patch: removeParameters).";

/** x, y, z, w and r, g, b, a name the same four places: the part that was meant is the twin. */
const PART_FAMILIES: ReadonlyArray<readonly string[]> = [
  ["x", "y", "z", "w"],
  ["r", "g", "b", "a"],
];

/** A declared key as a refusal lists it: with its parts, when it has parts. */
function listedKey(key: string, definition: ParameterDefinition): string {
  const parts = componentNamesFor(definition);
  return parts === null ? key : `${key} (${parts.map((part) => `.${part}`).join(" ")})`;
}

/**
 * THE finding for a key the node does not declare, with what to write instead: the part
 * that was meant when the key names a part its parameter does not have (`eyeColor.x` on a
 * colour: `eyeColor.r`), the nearest declared key, every declared key with its parts, and
 * the node's own naming rule when it has one.
 */
export function undeclaredParameter(
  schema: ParameterSchema,
  key: string,
  nodeId?: NodeId,
  context: UndeclaredParameterContext = {},
): RuntimeDiagnostic {
  const { stored, keysNote } = context;
  const subject = stored === undefined ? `Unknown parameter "${key}"` : `Node "${stored.nodeId}" stores a value under "${key}"`;
  const remedy: string[] = [];
  let message: string;

  const parsed = parseComponentKey(key);
  const base = parsed !== null && Object.hasOwn(schema, parsed.base) ? schema[parsed.base] : undefined;
  if (parsed !== null && base !== undefined) {
    // A part of a declared parameter, which that parameter does not have.
    const parts = componentNamesFor(base);
    const unread = stored === undefined ? "" : ", which nothing reads";
    if (parts === null) {
      message = `${subject}${unread}: "${parsed.base}" is a ${base.type} parameter and has no parts.`;
      remedy.push(`Write "${parsed.base}".`);
    } else {
      const kind = base.type === "color" ? "a colour" : "a vector";
      message = `${subject}${unread}: "${parsed.base}" is ${kind}, and its parts are ${parts.join(", ")}.`;
      const twin = PART_FAMILIES.map((family) => family.indexOf(parsed.component)).find((index) => index >= 0 && index < parts.length);
      const meant = twin === undefined ? nearestSpelling(parsed.component, parts) : parts[twin];
      if (meant !== null && meant !== undefined) remedy.push(`Write "${parsed.base}.${meant}".`);
    }
  } else {
    const declared = Object.keys(schema).sort();
    message = stored === undefined ? `${subject}.` : `${subject}, which "${stored.type}" does not declare: nothing reads it.`;
    const near = nearestSpelling(key, declared);
    if (near !== null) remedy.push(`Nearest: "${near}".`);
    if (declared.length > 0) {
      remedy.push(`Declared: ${declared.map((name) => listedKey(name, schema[name] as ParameterDefinition)).join(", ")}.`);
    }
  }
  if (keysNote !== undefined) remedy.push(keysNote);
  if (stored !== undefined) remedy.push(REMOVE_REMEDY);
  return error("parameter.unknown", message, nodeId, remedy.length === 0 ? undefined : remedy.join(" "));
}

/**
 * §V107: the parameter types an expression can drive. An expression evaluates to a NUMBER;
 * the resolver's coercion (`coerceExpressionResult`) has a case for each of these and for no
 * other, and the write gate refuses an expression on the rest (§B266: stored on a code
 * parameter it left a reflecting node with no text to read its controls from).
 */
export const EXPRESSION_DRIVEN_TYPES: ReadonlySet<ParameterDefinition["type"]> = new Set<ParameterDefinition["type"]>([
  "number",
  "boolean",
  "pulse",
  "enum",
  "string",
  "vector",
  "color",
]);

/**
 * Validates a partial or complete parameter bag against a schema.
 * Unknown keys are errors: they usually mean a stale agent patch or a renamed
 * parameter, and accepting them would let dead values accumulate in the document.
 */
export function validateParameters(
  schema: ParameterSchema,
  values: Readonly<Record<string, StoredParameter>>,
  nodeId?: NodeId,
  /** §T1641b: the node's own naming rule, for an undeclared key's refusal. */
  keysNote?: string,
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  for (const key of Object.keys(values).sort()) {
    let definition = schema[key];
    if (definition === undefined) {
      // A component key (`color.r`, §V113) validates against the derived scalar
      // definition of its channel — it is not an unknown parameter.
      const parsed = parseComponentKey(key);
      const base = parsed === null ? undefined : schema[parsed.base];
      const names = base === undefined ? null : componentNamesFor(base);
      const index = parsed === null || names === null ? -1 : names.indexOf(parsed.component);
      if (base !== undefined && index >= 0 && parsed !== null) {
        definition = componentDefinition(base, parsed.component, index);
      } else {
        diagnostics.push(undeclaredParameter(schema, key, nodeId, { keysNote }));
        continue;
      }
    }
    const value = values[key];
    if (value === undefined) {
      diagnostics.push(error("parameter.undefined", `Parameter "${key}" was set to undefined.`, nodeId));
      continue;
    }
    const diagnostic = validateStoredParameter(key, definition, value, nodeId);
    if (diagnostic !== null) diagnostics.push(diagnostic);
  }
  return diagnostics;
}

/**
 * Validates one stored parameter — a bare value or a mode envelope (T202).
 *
 * A slot is checked at WRITE time in every retained mode, not just the active one
 * (§V108): a static payload the manifest rejects, an expression that does not parse, an
 * empty bind ref — each is an authoring error the moment it is stored, and refusing it
 * here is what lets the resolver treat retained payloads as trustworthy fallbacks.
 * Whether a bind's TARGET exists is resolution's business (a sibling may arrive in the
 * same patch); whether the chain cycles is the patch gate's (`bindCycleDiagnostics`).
 */
function storedPulseValue(
  key: string,
  value: ParameterValue,
  nodeId?: NodeId,
): RuntimeDiagnostic | null {
  if (value === false) return null;
  return error(
    "parameter.pulse.stored",
    `Parameter "${key}" is a pulse: it fires, and a document cannot hold it armed.`,
    nodeId,
    "Fire it with parameter.pulse, or drive it with an expression (§V125).",
  );
}

export function validateStoredParameter(
  key: string,
  definition: ParameterDefinition,
  stored: StoredParameter,
  nodeId?: NodeId,
): RuntimeDiagnostic | null {
  if (!isParameterSlot(stored)) {
    // §V124: an ARMED pulse in the document would re-fire on every open and wipe the
    // work the project was opened to continue. Refusing it here is what makes that
    // impossible structurally, rather than a rule somebody has to remember.
    if (definition.type === "pulse") return storedPulseValue(key, stored, nodeId);
    return validateParameterValue(key, definition, stored, nodeId);
  }

  for (const mode of Object.keys(stored.bindings).sort()) {
    const binding = stored.bindings[mode as keyof typeof stored.bindings];
    if (binding === undefined) continue;
    if (binding.kind !== mode) {
      return error(
        "parameter.slot.shape",
        `Parameter "${key}" stores a ${binding.kind} payload under its ${mode} binding.`,
        nodeId,
      );
    }
    switch (binding.kind) {
      case "static": {
        const invalid =
          definition.type === "pulse"
            ? storedPulseValue(key, binding.value, nodeId)
            : validateParameterValue(key, definition, binding.value, nodeId);
        if (invalid !== null) return invalid;
        break;
      }
      case "expression": {
        const parsed = parseExpression(binding.source);
        if (!parsed.ok) {
          return error(
            "parameter.expression.syntax",
            `Parameter "${key}" expression "${binding.source}" does not parse: ${parsed.reason}`,
            nodeId,
          );
        }
        // §B266: no expression can drive a parameter of this type, whatever it evaluates to.
        // The resolver says the same of one already stored (`parameter.expression.type`).
        if (!EXPRESSION_DRIVEN_TYPES.has(definition.type)) {
          return error(
            "parameter.expression.type",
            `Parameter "${key}" expression "${binding.source}": a "${definition.type}" parameter cannot take an expression (§V107).`,
            nodeId,
            `Leave "${key}" in Constant mode.`,
          );
        }
        break;
      }
      case "bind": {
        if (binding.ref.trim().length === 0) {
          return error("parameter.bind.empty", `Parameter "${key}" has an empty bind ref.`, nodeId);
        }
        break;
      }
      case "driven": {
        if (binding.channel.trim().length === 0) {
          return error("parameter.driven.empty", `Parameter "${key}" has an empty channel name.`, nodeId);
        }
        break;
      }
      case "map": {
        // T286/§V288: STORAGE is legal on any parameter — a consumer that cannot
        // honour it fails loudly at compile. Only a malformed payload is refused here.
        if (binding.attribute.trim().length === 0) {
          return error("parameter.map.empty", `Parameter "${key}" maps an empty attribute name.`, nodeId);
        }
        break;
      }
      default: {
        const never: never = binding;
        void never;
      }
    }
  }

  if (stored.bindings[stored.mode] === undefined) {
    return error(
      "parameter.slot.empty",
      `Parameter "${key}" is in ${stored.mode} mode but carries no ${stored.mode} payload.`,
      nodeId,
      "Author the payload, or switch the mode back (§V108 keeps the old one).",
    );
  }
  return null;
}

/**
 * The manifest default for one parameter.
 *
 * Array- and object-valued defaults are COPIED: the manifest is shared by every node of
 * a type, so handing out the literal would let one node's edit mutate every other node's
 * default. An `asset` has no inline default — an unset asset is genuinely absent.
 */
export function defaultParameterValue(definition: ParameterDefinition): ParameterValue {
  switch (definition.type) {
    case "asset":
      return null;
    // A pulse is never armed by default and never stored (§V124); `false` is what the
    // resolver reports for one nobody is holding down.
    case "pulse":
      return false;
    case "color":
    case "vector":
      return [...definition.default];
    case "curve":
      return definition.default.map((point) => ({ x: point.x, y: point.y }));
    // Deep-copied like every other structured default: the manifest is shared by every
    // node of a type, so handing out the literal would let one node's edit move every
    // other node's default.
    case "stops":
      return definition.default.map((stop) => ({
        position: stop.position,
        color: [...stop.color] as [number, number, number, number],
      }));
    default:
      return definition.default;
  }
}

/**
 * The manifest defaults for a schema — the starting parameter bag of a new node.
 *
 * Pulses are OMITTED (§V124). A pulse has no value to store, so writing `false` for one
 * would put a key in every document that means nothing, survives every save, and would
 * have to be explained to every reader of the file. A node with only pulses starts with
 * an empty bag, and the resolver answers `false` for a key that is not there.
 */
export function defaultParameters(schema: ParameterSchema): Record<string, ParameterValue> {
  const result: Record<string, ParameterValue> = {};
  for (const [key, definition] of Object.entries(schema)) {
    if (definition.type === "pulse") continue;
    result[key] = defaultParameterValue(definition);
  }
  return result;
}
