import { opReferences } from "../graph/parameter-dependencies.ts";
import { isParameterSlot, storedStaticValue } from "../parameters/slots.ts";
import type { GraphDocument } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { StoredParameter } from "../types/parameters.ts";
import type { GraphPatchOperation } from "../types/patch.ts";
import { isLaneName, parseAutomation, serializeAutomation } from "./model.ts";

/**
 * VN61 — RENAMING A LANE REWRITES EVERY `op('<node>').chan.<old>` REFERENCE, IN THE SAME
 * UNDO STEP.
 *
 * Keyframer references lanes by name and nothing rewrites them, so renaming a lane leaves
 * every expression that read it dangling. Here a rename is ONE patch: a `setParameters`
 * on the automation node's `lanes` plus one per node whose expressions read the lane,
 * returned as operations for the caller (the timeline editor, the agent) to apply in one
 * `graph.applyPatch`, which is one revision and one undo step. The patch path itself is
 * not changed; this computes what it applies.
 *
 * Which slots read the lane is decided by the EXPRESSION PARSER (`opReferences`), the
 * same walk `parameter-dependencies.ts` gives the canvas and the cycle gate, so
 * `op("x")` and `op('x')` both count and an `op(…)` spelled inside a string literal or a
 * source that does not parse does not. The parser keeps no source positions and its
 * tokenizer is private, so the TEXT is rewritten by `rewriteChannelReads` below, a scan
 * that honours quotes and matches the reference token by token; the parser then checks
 * the result (the old read gone, the new one there as many times) and the rename is
 * refused rather than half-applied if it disagrees.
 *
 * The walk mirrors §V128's node-rename clause for expressions (`names.ts`
 * `expressionClause`, not exported): every node in the graph, every slot's EXPRESSION
 * binding whether or not it is the active mode (a retained expression is still the
 * author's text, §V110).
 */

export type LaneRenamePlan =
  | { readonly ok: true; readonly operations: GraphPatchOperation[]; readonly rewritten: number }
  | { readonly ok: false; readonly reason: string };

type Token = { readonly kind: "identifier" | "string" | "dot" | "open" | "close" | "other"; readonly text: string; readonly at: number; readonly end: number };

/** The tokens a channel read is made of; anything else is "other". Quotes are honoured. */
function scan(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === "'" || char === '"') {
      const close = source.indexOf(char, index + 1);
      const end = close < 0 ? source.length : close + 1;
      tokens.push({ kind: "string", text: source.slice(index + 1, close < 0 ? end : close), at: index, end });
      index = end;
    } else if (/[A-Za-z_]/.test(char)) {
      const start = index;
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index] as string)) index += 1;
      tokens.push({ kind: "identifier", text: source.slice(start, index), at: start, end: index });
    } else if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(source[index + 1] ?? ""))) {
      // A number, exponent included, so `1.e5` or `2.5` never reads as member access.
      const start = index;
      while (index < source.length && /[0-9.eE]/.test(source[index] as string)) {
        if (/[eE]/.test(source[index] as string) && /[+-]/.test(source[index + 1] ?? "")) index += 1;
        index += 1;
      }
      tokens.push({ kind: "other", text: source.slice(start, index), at: start, end: index });
    } else {
      const kind = char === "." ? "dot" : char === "(" ? "open" : char === ")" ? "close" : "other";
      tokens.push({ kind, text: char, at: index, end: index + 1 });
      index += 1;
    }
  }
  return tokens;
}

/**
 * `source` with every `op('<nodeName>').chan.<oldLane>` read renamed to `<newLane>`, and
 * how many were renamed. Spans are rewritten right to left so earlier spans stay valid.
 */
export function rewriteChannelReads(source: string, nodeName: string, oldLane: string, newLane: string): { source: string; count: number } {
  const tokens = scan(source);
  const spans: { at: number; end: number }[] = [];
  for (let index = 0; index + 7 < tokens.length; index += 1) {
    const [op, open, name, close, dot1, chan, dot2, member] = tokens.slice(index, index + 8) as Token[];
    if (
      op!.kind === "identifier" && op!.text === "op" &&
      open!.kind === "open" &&
      name!.kind === "string" && name!.text === nodeName &&
      close!.kind === "close" &&
      dot1!.kind === "dot" &&
      chan!.kind === "identifier" && chan!.text === "chan" &&
      dot2!.kind === "dot" &&
      member!.kind === "identifier" && member!.text === oldLane
    ) {
      spans.push({ at: member!.at, end: member!.end });
    }
  }
  let rewritten = source;
  for (const span of spans.reverse()) rewritten = rewritten.slice(0, span.at) + newLane + rewritten.slice(span.end);
  return { source: rewritten, count: spans.length };
}

const readsOf = (source: string, nodeName: string, lane: string): number =>
  (opReferences(source) ?? []).filter((reference) => reference.name === nodeName && reference.path[0] === "chan" && reference.path[1] === lane).length;

/**
 * The patch operations that rename lane `laneId` of automation node `nodeId` to
 * `newName`, rewriting every expression that reads it. Refuses (with the reason) a name
 * that is not an identifier or is taken by another lane, a lanes text that does not parse
 * or is not static, and an unknown lane. A rename to the same name is an empty plan.
 */
export function laneRenameOperations(
  graph: GraphDocument,
  nodeId: NodeId,
  laneId: string,
  newName: string,
  /** The text rewrite; a parameter only so the refusal below can be tested against a scan that misses. */
  rewrite: typeof rewriteChannelReads = rewriteChannelReads,
): LaneRenamePlan {
  const node = graph.nodes[nodeId];
  if (node === undefined) return { ok: false, reason: `No node "${nodeId}".` };
  const stored = node.parameters["lanes"];
  if (isParameterSlot(stored) && stored.mode !== "static") return { ok: false, reason: "The lanes are not static text; rename a lane by editing them directly." };
  const parsed = parseAutomation(storedStaticValue(stored));
  if (!parsed.ok) return { ok: false, reason: `The lanes do not parse: ${parsed.reason}.` };
  const lane = parsed.document.lanes.find((each) => each.id === laneId);
  if (lane === undefined) return { ok: false, reason: `No lane with the id "${laneId}".` };
  if (!isLaneName(newName)) return { ok: false, reason: `"${newName}" is not a lane name: use letters, digits and _, not starting with a digit.` };
  if (lane.name === newName) return { ok: true, operations: [], rewritten: 0 };
  if (parsed.document.lanes.some((each) => each.id !== laneId && each.name === newName)) {
    return { ok: false, reason: `Another lane is already named "${newName}".` };
  }

  const text = serializeAutomation({
    ...parsed.document,
    lanes: parsed.document.lanes.map((each) => (each.id === laneId ? { ...each, name: newName } : each)),
  });
  const lanesStored: StoredParameter = isParameterSlot(stored)
    ? { ...stored, bindings: { ...stored.bindings, static: { kind: "static", value: text } } }
    : text;
  const operations: GraphPatchOperation[] = [{ op: "setParameters", nodeId, parameters: { lanes: lanesStored } }];

  const nodeName = node.label;
  let rewritten = 0;
  if (nodeName !== undefined) {
    for (const readerId of Object.keys(graph.nodes).sort()) {
      const reader = graph.nodes[readerId];
      if (reader === undefined) continue;
      const changed: Record<string, StoredParameter> = {};
      for (const key of Object.keys(reader.parameters).sort()) {
        const slot = reader.parameters[key];
        if (!isParameterSlot(slot)) continue;
        const binding = slot.bindings.expression;
        if (binding?.kind !== "expression") continue;
        const reads = readsOf(binding.source, nodeName, lane.name);
        if (reads === 0) continue;
        const result = rewrite(binding.source, nodeName, lane.name, newName);
        if (result.count !== reads || readsOf(result.source, nodeName, lane.name) !== 0 || readsOf(result.source, nodeName, newName) < reads) {
          return { ok: false, reason: `Could not rewrite the reference in "${reader.label ?? readerId}".${key}; nothing was renamed.` };
        }
        changed[key] = { ...slot, bindings: { ...slot.bindings, expression: { kind: "expression", source: result.source } } };
        rewritten += 1;
      }
      if (Object.keys(changed).length === 0) continue;
      if (readerId === nodeId) {
        // The automation node reading its own lane: one operation for the node, lanes included.
        const first = operations[0] as Extract<GraphPatchOperation, { op: "setParameters" }>;
        operations[0] = { ...first, parameters: { ...first.parameters, ...changed } };
      } else {
        operations.push({ op: "setParameters", nodeId: readerId, parameters: changed });
      }
    }
  }
  return { ok: true, operations, rewritten };
}
