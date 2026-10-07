import { parseExpression, type ExpressionAst } from "../expressions/index.ts";
import { isParameterSlot } from "../parameters/slots.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { ParameterChannels } from "../types/node-definition.ts";
import { nodeNames } from "./names.ts";

/**
 * §T1674b — AN EXPRESSION THAT READS A PARAMETER WHICH IS NOT WHAT ITS NAME SAYS.
 *
 * Since §T1656b a Camera's Eye and Look At are offsets in the frame its Origin and Heading
 * make. `op('camera_rig').par.eye.x` gives the offset, exactly as stored, and a pass that
 * rebuilds a view ray from it draws the wrong picture with nothing said (sentinel-bot's lit
 * air went out). The read takes effect as written, so this is advice and refuses nothing;
 * it names the channel that says what the reader almost certainly wanted.
 *
 * WHO DECIDES is the read node's own definition (`ParameterChannels.insteadOf`), from what
 * the node STORES: a camera with no frame says null and nothing fires, which is every camera
 * in every document written before the frame existed. A node reading its OWN parameter is
 * not asked: an offset read by the node that owns the frame is an offset on purpose.
 *
 * A read that does mean the offset (a distance between two offsets) is told the same thing
 * and stays told: the app cannot tell the two apart from the text.
 */
export function composedParameterReadDiagnostics(
  graph: GraphDocument,
  channelsOf: (node: GraphNode) => ParameterChannels | undefined,
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  let names: ReadonlyMap<string, string> | null = null;
  for (const readerId of Object.keys(graph.nodes).sort()) {
    const reader = graph.nodes[readerId];
    if (reader === undefined) continue;
    for (const key of Object.keys(reader.parameters).sort()) {
      const stored = reader.parameters[key];
      if (stored === undefined || !isParameterSlot(stored)) continue;
      const binding = stored.bindings[stored.mode];
      if (binding?.kind !== "expression") continue;
      const parsed = parseExpression(binding.source);
      if (!parsed.ok) continue;
      const said = new Set<string>();
      const walk = (ast: ExpressionAst): void => {
        switch (ast.kind) {
          case "opRef": {
            const [namespace, parameter, component] = ast.path;
            if (namespace !== "par" || parameter === undefined) return;
            names ??= nodeNames(graph);
            const targetId = names.get(ast.name);
            const target = targetId === undefined ? undefined : graph.nodes[targetId];
            if (target === undefined || targetId === readerId) return;
            const instead = channelsOf(target)?.insteadOf?.(parameter, component, target.parameters);
            if (instead == null) return;
            const read = `op('${ast.name}').${ast.path.join(".")}`;
            if (said.has(read)) return;
            said.add(read);
            diagnostics.push({
              severity: "warning",
              code: "parameter.reference.notComposed",
              message: `"${reader.label ?? readerId}".${key} reads ${read}, which is ${instead.gives}, not ${instead.wants}.`,
              nodeId: readerId,
              suggestion: `Read op('${ast.name}').chan.${instead.channel} for ${instead.wants}.`,
            });
            return;
          }
          case "unary":
            walk(ast.operand);
            return;
          case "binary":
            walk(ast.left);
            walk(ast.right);
            return;
          case "call":
            for (const arg of ast.args) walk(arg);
            return;
          case "parentRef":
          case "number":
          case "variable":
            return;
        }
      };
      walk(parsed.ast);
    }
  }
  return diagnostics;
}
