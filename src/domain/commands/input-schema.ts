import { z } from "zod";

import type { CommandInput, CommandName } from "../types/commands.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";

/**
 * §T1556b — EVERY COMMAND SAYS WHAT INPUT IT TAKES, AND THE BUS CHECKS IT.
 *
 * `bus.execute` used to parse nothing. The agent surface validated its tool input with zod
 * and the phone door vetted its writes, while the menu, the keymap, the palette and every
 * other adapter handed input straight through — so the same malformed input was refused on
 * one door and taken on another (seam audit 2026-10-04, finding 6; history B87, B91, B92,
 * B100). Now a registration carries its schema (`CommandRegistration.inputSchema`, a
 * REQUIRED field, so a command cannot be registered without one) and `execute` parses it
 * before the handler runs: every door gets one refusal, in one sentence.
 *
 * The schema is a GATE, not a transform: the handler receives the input the caller sent,
 * once it has passed. A schema written a little looser than the TypeScript type (a key it
 * forgot to list on an object that is not `.strict()`) can therefore never change what a
 * handler sees, only what it refuses.
 */

/**
 * zod's `.optional()` outputs `T | undefined` under the key, and `exactOptionalPropertyTypes`
 * does not let that stand for `key?: T`. This lets an OPTIONAL key also carry `undefined`
 * (deeply) so a schema's output can be compared with the command's declared input; a
 * REQUIRED key is compared as declared.
 */
type Widened<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly Widened<U>[]
    : T extends object
      ? { [K in keyof T]: Partial<Pick<T, K>> extends Pick<T, K> ? Widened<T[K]> | undefined : Widened<T[K]> }
      : T;

/**
 * A schema whose parsed output is a valid input for `TName`: a schema that forgets a
 * required key, or types one differently from the command's `CommandMap` entry, does not
 * compile.
 */
export type CommandInputSchema<TName extends CommandName> = z.ZodType<
  Widened<CommandInput<TName>>,
  z.ZodTypeDef,
  unknown
>;

/**
 * The other direction, checked where a registration is written (`registerCommand`'s `S`):
 * every key the command's input declares must be one its schema names. Assignability
 * cannot see this — a strict schema that forgot an optional key still has an output the
 * input type accepts — and at runtime that forgotten key is a refusal of a legal call. A
 * schema that misses one fails to compile with the missing keys named.
 *
 * `Record<string, never>` (the input of a command that takes nothing) has no keys to name.
 */
export type InputKeysCovered<TName extends CommandName, S> =
  S extends z.ZodType<infer O, z.ZodTypeDef, unknown>
    ? string extends keyof CommandInput<TName>
      ? unknown
      : [Exclude<keyof CommandInput<TName>, keyof O>] extends [never]
        ? unknown
        : { readonly inputSchemaMissesKeys: Exclude<keyof CommandInput<TName>, keyof O> }
    : unknown;

/**
 * The named escape: a command whose input the bus genuinely cannot describe, with the
 * reason in words. Grep `ANY_INPUT(` for every command that takes it; each one is a door
 * that refuses only what its own handler refuses.
 */
export interface AnyInput {
  readonly anyInput: true;
  readonly reason: string;
}

export function ANY_INPUT(reason: string): AnyInput {
  if (reason.trim() === "") throw new Error("ANY_INPUT needs a reason.");
  return { anyInput: true, reason };
}

export function isAnyInput(schema: unknown): schema is AnyInput {
  return typeof schema === "object" && schema !== null && (schema as { anyInput?: unknown }).anyInput === true;
}

/** The input of a command that takes nothing (`Record<string, never>`): an empty object. */
export const NO_INPUT = z.object({}).strict();

/** An entity id (a node, an edge, a transaction): any non-empty string. */
export const idInput = z.string().min(1);

/** §V66: a non-finite number serializes to `null` and makes a document unloadable. */
export const finiteInput = z.number().finite();

/** A canvas position or offset. */
export const pointInput = z.object({ x: finiteInput, y: finiteInput }).strict();

/**
 * §T1695b — WHICH STRINGS OF AN INPUT ARE NODE ADDRESSES.
 *
 * `idInput` is one schema for every kind of id, so a schema built from it cannot say which
 * of its strings name a node, and `NodeId` is a plain `string`, so the types cannot either.
 * A command that is inherited by a component session (`InSession` in `bus.ts`) has its node
 * addresses rewritten onto the instance in view, and that rewrite is DERIVED from the schema
 * rather than written per command. So a node address is declared with one of these two:
 *
 *  - `nodeIdInput`: a node of a document. On an `instance` command it is rewritten.
 *  - `canvasNodeIdInput`: a node as the canvas in front of the user shows it. Never
 *    rewritten: the command is answered by whichever canvas is mounted.
 *
 * The mark is the schema INSTANCE (a `WeakSet`), not a name or a description: `.optional()`,
 * `z.array(…)` and `.extend(…)` wrap or carry the same instance and keep it, and a
 * refinement that mints a new one (`nodeIdInput.max(8)`) loses it, which the gate in
 * `session-commands.test.tsx` reports as an unmarked string on an inherited command.
 */
const NODE_ADDRESSES = new WeakSet<z.ZodTypeAny>();
const CANVAS_NODES = new WeakSet<z.ZodTypeAny>();

/** A node of a document, by id. */
export const nodeIdInput = z.string().min(1);
NODE_ADDRESSES.add(nodeIdInput);

/** A node as the canvas shows it: an id of the graph in view, whichever graph that is. */
export const canvasNodeIdInput = z.string().min(1);
CANVAS_NODES.add(canvasNodeIdInput);

/** A selection: the node ids a command acts on. */
export const nodeIdsInput = z.array(nodeIdInput);

/** A selection on the canvas: ids of the graph in view. */
export const canvasNodeIdsInput = z.array(canvasNodeIdInput);

export type StringLeafKind = "node" | "canvas" | "unmarked";

export interface StringLeaf {
  /** Dotted, with `[]` for an array's elements: `nodeIds[]`, `targets[].nodeId`. */
  readonly path: string;
  readonly kind: StringLeafKind;
}

/** What a schema wraps, one level down; an empty list for a leaf. Shared by the two walks below. */
function childrenOf(schema: z.ZodTypeAny): ReadonlyArray<{ readonly step: string; readonly schema: z.ZodTypeAny }> {
  if (schema instanceof z.ZodObject) {
    return Object.entries(schema.shape as Record<string, z.ZodTypeAny>).map(([key, child]) => ({ step: `.${key}`, schema: child }));
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return [{ step: "", schema: schema.unwrap() as z.ZodTypeAny }];
  if (schema instanceof z.ZodDefault) return [{ step: "", schema: schema.removeDefault() as z.ZodTypeAny }];
  if (schema instanceof z.ZodEffects) return [{ step: "", schema: schema.innerType() as z.ZodTypeAny }];
  if (schema instanceof z.ZodArray) return [{ step: "[]", schema: schema.element as z.ZodTypeAny }];
  if (schema instanceof z.ZodRecord) return [{ step: "{}", schema: schema.valueSchema as z.ZodTypeAny }];
  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
    return ([...schema.options] as z.ZodTypeAny[]).map((option) => ({ step: "", schema: option }));
  }
  return [];
}

/** Every string a schema can hold, and whether it is declared a node address. For the gates. */
export function stringLeavesOf(schema: z.ZodTypeAny, path = ""): StringLeaf[] {
  if (schema instanceof z.ZodString) {
    const kind: StringLeafKind = NODE_ADDRESSES.has(schema) ? "node" : CANVAS_NODES.has(schema) ? "canvas" : "unmarked";
    return [{ path: path.startsWith(".") ? path.slice(1) : path || "(root)", kind }];
  }
  return childrenOf(schema).flatMap((child) => stringLeavesOf(child.schema, `${path}${child.step}`));
}

/**
 * `input` with every `nodeIdInput` string passed through `map`, and nothing else touched.
 * Guided by the schema, never by key names. It does not validate: a value the schema would
 * refuse comes back as it was, and whoever executes the result refuses it in the usual words.
 */
export function rewriteNodeAddresses(schema: z.ZodTypeAny, input: unknown, map: (nodeId: string) => string): unknown {
  if (schema instanceof z.ZodString) return NODE_ADDRESSES.has(schema) && typeof input === "string" ? map(input) : input;
  if (input === undefined || input === null) return input;
  if (schema instanceof z.ZodObject) {
    if (typeof input !== "object" || Array.isArray(input)) return input;
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
    for (const [key, child] of Object.entries(shape)) {
      if (key in out) out[key] = rewriteNodeAddresses(child, out[key], map);
    }
    return out;
  }
  if (schema instanceof z.ZodArray) {
    return Array.isArray(input) ? input.map((entry) => rewriteNodeAddresses(schema.element as z.ZodTypeAny, entry, map)) : input;
  }
  if (schema instanceof z.ZodRecord) {
    if (typeof input !== "object" || Array.isArray(input)) return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([key, value]) => [key, rewriteNodeAddresses(schema.valueSchema as z.ZodTypeAny, value, map)]),
    );
  }
  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
    // The option this input IS, by the schema's own parse; none, and it is not ours to rewrite.
    const option = ([...schema.options] as z.ZodTypeAny[]).find((candidate) => candidate.safeParse(input).success);
    return option === undefined ? input : rewriteNodeAddresses(option, input, map);
  }
  const [inner] = childrenOf(schema);
  return inner === undefined ? input : rewriteNodeAddresses(inner.schema, input, map);
}

/**
 * One refusal sentence for one schema issue, naming who refused (a command, or an agent
 * tool) and the field. The agent surface and the bus both speak through this, so a field a
 * caller got wrong reads the same on every door.
 */
export function describeInputIssue(subject: string, issue: z.ZodIssue): string {
  return `Input to "${subject}" is invalid at ${issue.path.join(".") || "(root)"} (${issue.code}): ${issue.message}`;
}

/** As many issues as a refusal lists; a 10 000-operation patch can carry one per operation. */
const LISTED_ISSUES = 10;

/** The bus's refusal of input a command's schema did not accept: one diagnostic per issue. */
export function inputRefusal(command: string, issues: readonly z.ZodIssue[]): RuntimeDiagnostic[] {
  const diagnostics = issues.slice(0, LISTED_ISSUES).map<RuntimeDiagnostic>((issue) => ({
    severity: "error",
    code: "command.input",
    message: describeInputIssue(command, issue),
  }));
  if (issues.length > LISTED_ISSUES) {
    diagnostics.push({
      severity: "error",
      code: "command.input",
      message: `Input to "${command}" has ${issues.length - LISTED_ISSUES} further problem(s), not listed.`,
    });
  }
  return diagnostics;
}
