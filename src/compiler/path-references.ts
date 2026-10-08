import {
  isNodePath,
  isWithinScope,
  parseNodePath,
  pathBetween,
  resolveNodePath,
  type NameScopes,
} from "../domain/components/addressing.ts";
import { liveSourceReferenceTokens, sourceReferencesOf } from "../domain/graph/source-references.ts";
import { isParameterSlot } from "../domain/parameters/slots.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { GraphEdge, GraphNode } from "../domain/types/graph.ts";
import type { NodeId } from "../domain/types/ids.ts";
import { CompilerDiagnosticCode, compilerDiagnostic } from "./diagnostics.ts";

/**
 * VN35 — PATHS RESOLVE HERE, ONCE, AND EVERY READER DOWNSTREAM READS A NAME.
 *
 * B41's uniquing leaves every label in the flattening unique across the whole document, so
 * a bare name in it names one node. A path (`projector_left/projector_beam`) is resolved
 * against the names the author wrote, graph by graph (`addressing.ts`), and the reference
 * is rewritten to the label its target carries in the flattening. Source-reference
 * synthesis, the `op()` reader, liveness and the channels then read a name as they always
 * have, and none of them learns that paths exist. A path that does not resolve is left as
 * written: the synthesis refuses it by name (§V369), and an `op()` falls back (§V108).
 *
 * Beside that, the deprecation half of stage 1: a BARE name that lands inside an instance
 * the referring node is not in. That bind is the one B41 leaves first-wins, so of three
 * copies only the first is ever reached, and nothing said so. Reading outward (a node in
 * an instance naming a node of a graph it lies in) is lexical scope, and is not reported.
 *
 * Writes `nodes` in place: the flattener's own record, whose node objects it made. The
 * parameter records and slots inside them are replaced, never edited, since they can be
 * the definition's.
 */
export interface PathReferenceInput {
  readonly nodes: Record<NodeId, GraphNode>;
  readonly edges: Readonly<Record<string, GraphEdge>>;
  readonly scopes: NameScopes;
  /** Each flattened node's graph (its scope key). */
  readonly scopeOf: ReadonlyMap<NodeId, string>;
  /** Each flattened node's name as written in its own graph, before B41's uniquing. */
  readonly authoredOf: ReadonlyMap<NodeId, string>;
  /** Scope where each parameter value was authored, retained through publication and parent binds. */
  readonly parameterScopes: ReadonlyMap<NodeId, Readonly<Record<string, string>>>;
}

interface Crossing {
  /** The target's name in its own graph. */
  readonly authored: string;
  /** The path the referring node should write, when every instance on the way is named. */
  readonly path: string | undefined;
  /** How many nodes anywhere carry that written name. */
  readonly carried: number;
  /** The name of the instance the target lies in. */
  readonly instance: string;
}

const OP_REFERENCE = /op\(\s*(['"])([^'"]*)\1\s*\)/g;

export function resolvePathReferences(input: PathReferenceInput): RuntimeDiagnostic[] {
  const { nodes, scopes, scopeOf, authoredOf } = input;
  const diagnostics: RuntimeDiagnostic[] = [];
  let labels: Map<string, NodeId> | undefined;
  let carriers: Map<string, number> | undefined;

  /** The flattening's own label for what `written` names from `scope`, or undefined to leave it as written. */
  const resolved = (written: string, scope: string, instancePages = false): string | undefined => {
    if (!isNodePath(written)) return undefined;
    const path = parseNodePath(written);
    if (path === undefined) return undefined;
    const target = resolveNodePath(path, scope, scopes, { instancePages });
    return target.ok ? nodes[target.nodeId]?.label : undefined;
  };

  /** A bare name read from `scope` that reaches into an instance `scope` is not in. */
  const crossesInto = (written: string, scope: string): Crossing | undefined => {
    if (isNodePath(written)) return undefined;
    labels ??= flatLabels(nodes);
    const target = labels.get(written);
    const targetScope = target === undefined ? undefined : scopeOf.get(target);
    if (target === undefined || targetScope === undefined || isWithinScope(scope, targetScope, scopes)) return undefined;
    const authored = authoredOf.get(target) ?? written;
    carriers ??= countCarriers(authoredOf);
    return {
      authored,
      path: pathBetween(scope, targetScope, authored, scopes),
      carried: carriers.get(authored) ?? 1,
      instance: scopes.get(targetScope)?.label ?? targetScope,
    };
  };

  /** One warning per node and name, however many of its parameters write that name. */
  const warn = (nodeId: NodeId, written: string, crossing: Crossing, where: readonly string[]): void => {
    const others =
      crossing.carried > 1
        ? ` ${crossing.carried} nodes in the document are named "${crossing.authored}", and a bare name reaches only this one.`
        : "";
    diagnostics.push(
      compilerDiagnostic(
        "warning",
        CompilerDiagnosticCode.referenceCrossScope,
        `Node "${nodeId}" names "${written}" (in ${where.join(", ")}), which lives inside the component instance "${crossing.instance}".${others}`,
        {
          nodeId,
          suggestion:
            crossing.path === undefined
              ? "Name the instance, then write the reference as a path through it."
              : `Write the path "${crossing.path}": a bare name reaching into an instance is kept for old files only.`,
        },
      ),
    );
  };

  for (const nodeId of Object.keys(nodes).sort()) {
    const node = nodes[nodeId];
    if (node === undefined) continue;
    const scope = scopeOf.get(nodeId);
    if (scope === undefined) continue;
    let parameters: Record<string, GraphNode["parameters"][string]> | undefined;
    const crossings = new Map<string, { crossing: Crossing; where: string[] }>();
    const scopeFor = (key: string): string => input.parameterScopes.get(nodeId)?.[key] ?? scope;
    const note = (written: string, where: string): void => {
      const known = crossings.get(written);
      if (known !== undefined) {
        if (!known.where.includes(where)) known.where.push(where);
        return;
      }
      const crossing = crossesInto(written, scopeFor(where));
      if (crossing !== undefined) crossings.set(written, { crossing, where: [where] });
    };
    const write = (key: string, value: GraphNode["parameters"][string]): void => {
      parameters ??= { ...node.parameters };
      parameters[key] = value;
    };

    for (const spec of sourceReferencesOf(node.type)) {
      const stored = node.parameters[spec.parameter];
      if (typeof stored !== "string") continue;
      for (const token of liveSourceReferenceTokens(spec, node, input.edges)) {
        note(token, spec.parameter);
      }
      if (!isNodePath(stored)) continue;
      const rewritten = spec.list === true
        ? stored.split(/([\s,]+)/).map((piece) => resolved(piece.trim(), scopeFor(spec.parameter)) ?? piece).join("")
        : resolved(stored.trim(), scopeFor(spec.parameter)) ?? stored;
      if (rewritten !== stored) write(spec.parameter, rewritten);
    }

    for (const key of Object.keys(node.parameters).sort()) {
      const stored = node.parameters[key];
      if (stored === undefined || !isParameterSlot(stored)) continue;
      const binding = stored.bindings.expression;
      if (binding?.kind !== "expression") continue;
      const source = binding.source.replace(OP_REFERENCE, (match, quote: string, written: string) => {
        if (stored.mode === "expression") note(written, key);
        const label = resolved(written, scopeFor(key), true);
        return label === undefined ? match : `op(${quote}${label}${quote})`;
      });
      if (source !== binding.source) {
        write(key, { ...stored, bindings: { ...stored.bindings, expression: { kind: "expression", source } } });
      }
    }

    if (parameters !== undefined) nodes[nodeId] = { ...node, parameters };
    for (const [written, { crossing, where }] of crossings) warn(nodeId, written, crossing, where);
  }
  return diagnostics;
}

/** The flattening's label index, first-wins in id order, as `nodeNames` builds it. */
function flatLabels(nodes: Readonly<Record<NodeId, GraphNode>>): Map<string, NodeId> {
  const labels = new Map<string, NodeId>();
  for (const nodeId of Object.keys(nodes).sort()) {
    const label = nodes[nodeId]?.label;
    if (label !== undefined && !labels.has(label)) labels.set(label, nodeId);
  }
  return labels;
}

function countCarriers(authoredOf: ReadonlyMap<NodeId, string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of authoredOf.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}
