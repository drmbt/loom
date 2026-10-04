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

/** A selection: the node ids a command acts on. */
export const nodeIdsInput = z.array(idInput);

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
