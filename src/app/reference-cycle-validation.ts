import { flattenComponents } from "../compiler/flatten.ts";
import type { ReferenceCycleValidator } from "../domain/commands/bus.ts";
import { isComponentInstance, readComponentInstance } from "../domain/components/instance.ts";
import { isWithinInstance, toInstance } from "../domain/components/addressing.ts";
import type { ComponentRegistryView } from "../domain/components/registry.ts";
import { keyReads } from "../domain/graph/parameter-dependencies.ts";
import { channelDependenciesOf, referenceCyclesThrough } from "../domain/graph/reference-cycles.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import type { NodeRegistryView } from "../nodes/registry/registry.ts";

/** Validates hypothetical edits with the compiler's projection, without changing the catalogue. */
export function createReferenceCycleValidator(input: {
  readonly registry: NodeRegistryView;
  readonly components: () => ComponentRegistryView;
  readonly root: () => GraphDocument;
}): ReferenceCycleValidator {
  const channels = (node: GraphDocument["nodes"][string]) => channelDependenciesOf(input.registry.get(node.type));
  return (draft, nodeId, host) => {
    const edited = draft.nodes[nodeId];
    if (edited === undefined) return [];
    const authoredCycles = referenceCyclesThrough(draft, nodeId, channels);
    if (authoredCycles.length > 0) return authoredCycles;
    if (host === undefined && !Object.values(draft.nodes).some(isComponentInstance)) return [];
    if (host === undefined && !isComponentInstance(edited) && !keyReads(edited.parameters).some(read => read.node !== null)) return [];
    const components = input.components();
    let graph = draft;
    let projected = components;
    if (host !== undefined) {
      const definition = components.get(host.componentId, host.version);
      if (definition === undefined) throw new Error(`Reference validation cannot find component ${host.componentId}@${host.version}`);
      const replacement = { ...definition, graph: draft };
      projected = { ...components,
        get: (id, version) => id === host.componentId && version === host.version ? replacement : components.get(id, version),
        graphOf: (id, version) => id === host.componentId && version === host.version ? draft : components.graphOf(id, version),
      };
      graph = input.root();
    }
    let flat = flattenComponents({ graph, registry: input.registry, components: projected });
    const focuses: string[] = [];
    if (host === undefined) focuses.push(nodeId);
    else for (const [id, node] of flat.instanceNodes) {
      const instance = readComponentInstance(node);
      if (instance?.componentId === host.componentId && instance.version === host.version) focuses.push(toInstance([id], nodeId));
    }
    // A library definition with no live instances is validated as its own authored graph.
    if (host !== undefined && focuses.length === 0) {
      flat = flattenComponents({ graph: draft, registry: input.registry, components: projected });
      focuses.push(nodeId);
    }
    const found = new Map<string, ReturnType<ReferenceCycleValidator>[number]>();
    for (const id of Object.keys(flat.graph.nodes)) {
      if (!focuses.some(focus => isWithinInstance(id, focus))) continue;
      for (const diagnostic of referenceCyclesThrough(flat.graph, id, channels)) found.set(diagnostic.message, diagnostic);
    }
    return [...found.values()];
  };
}
