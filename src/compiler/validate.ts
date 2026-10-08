import type { NodeId, PortId } from "../domain/types/ids.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { FlatOrAuthoredGraph, GraphNode } from "../domain/types/graph.ts";
import type { NodeDefinition } from "../domain/types/node-definition.ts";
import type { ParameterSchema, ParameterValue } from "../domain/types/parameters.ts";
import type { PortDefinition } from "../domain/types/ports.ts";
import { arePortsCompatible, describePortType } from "../domain/graph/port-compat.ts";
import { resolveParameterSchema, effectiveParameterSchema, type ParameterMapBinding } from "../domain/parameters/resolve.ts";
import {
  NO_INSTANCES,
  NO_PAGES,
  parameterReadOptions,
  type FlatteningReads,
  type InstanceChannelSources,
  type InstancePages,
} from "../domain/parameters/node-references.ts";
import { NO_MORPHS } from "../domain/presets/morph-index.ts";
import type { ParameterReadOptions, ResolveParametersOptions } from "../domain/parameters/resolve.ts";
import { bindCycleDiagnostics } from "../domain/parameters/bind-cycles.ts";
import { channelDependenciesOf, referenceCycleDiagnostics, referenceGraphWithPages } from "../domain/graph/reference-cycles.ts";
import { composedParameterReadDiagnostics } from "../domain/graph/composed-parameter-reads.ts";
import { undeclaredKeys, undeclaredParameter } from "../domain/parameters/validate.ts";
import type { ResolvedParameters } from "../domain/parameters/resolve.ts";
import type { NodeRegistryView } from "../nodes/registry/registry.ts";
import { CompilerDiagnosticCode, compilerDiagnostic } from "./diagnostics.ts";
import type { CompileEdge } from "./types.ts";

/**
 * Definition resolution, parameter validation and connection validation (T24, §V13, §V14).
 *
 * Everything here is a rejection with a diagnostic, never a throw: a project with one bad
 * edge still compiles the rest of itself, and the user gets told exactly which edge.
 */

/**
 * What a resolution needs to know about the moment it is resolving AT (T259, §V163).
 *
 * Empty for a structural compile, which is the common case and resolves every animated
 * parameter at its zero-frame value. A per-frame values-only pass supplies both: the
 * frame an expression reads `time` from, and the channel resolver a `driven` parameter
 * reads its LFO through. Nothing else about the compile changes — same graph, same
 * topology, same resources — so the resulting plan differs only in its uniform VALUES,
 * which is what makes the update path `updateUniforms` rather than a recompile (§V5).
 */
export type ParameterResolution = Pick<ResolveParametersOptions, "frame" | "channels" | "morphs"> & {
  /**
   * T1485b: the component instances `op('<instance>').chan.<c>` can name — the flattening's
   * `instanceChannels`, carried beside `morphs` for the same reason: the reader is built
   * here, so a `compileGraph` caller cannot forget it.
   */
  readonly instances?: InstanceChannelSources | undefined;
  /** VN36: and the instance pages `op('<instance>').par.<key>` reads, by the same rule. */
  readonly instancePages?: InstancePages | undefined;
};

/**
 * §T1551b — the flattening a compile reads `op()` through, off the resolution that carries
 * it. `compileGraphRetaining` fills both from the flattening it compiled; a resolution
 * without them is a document with no flattening behind it (a direct `validateGraph`), and
 * reads nothing fading and no instance — said here, once, for the three compiler readers.
 */
export function flatteningReadsOf(resolution: ParameterResolution): FlatteningReads {
  return {
    morphs: resolution.morphs ?? NO_MORPHS,
    instanceChannels: resolution.instances ?? NO_INSTANCES,
    instancePages: resolution.instancePages ?? NO_PAGES,
  };
}

export interface ResolvedNode {
  readonly node: GraphNode;
  readonly definition: NodeDefinition;
  /**
   * The values EVALUATION consumes: defaults filled in, invalid values replaced by the
   * default and reported, and a `space: "display"` colour decoded to linear (§V56, B8).
   * This is `ResolvedParameters.values` from the §V61 resolver, unaltered — the compiler
   * no longer has an opinion of its own about what a parameter is worth.
   */
  readonly parameters: Readonly<Record<string, ParameterValue>>;
  /** T286 (§V287): parameters whose active mode is `map` — the consumer compiles from this. */
  readonly parameterMaps: Readonly<Record<string, ParameterMapBinding>>;
  /**
   * T1652b: what resolving THIS node's parameters reported, in the order it was pushed
   * onto the compilation's list. Kept per node so a values-only revision can ask whether
   * a node says something different about its new value (`rebaseOnValues`).
   */
  readonly said: ReadonlyArray<RuntimeDiagnostic>;
}

export interface ValidatedGraph {
  /** Nodes whose type resolved, keyed by id. Insertion order is sorted by id. */
  readonly nodes: ReadonlyMap<NodeId, ResolvedNode>;
  /** Edges that passed endpoint, type (§V13) and arity (§V14) validation, sorted by edge id. */
  readonly edges: ReadonlyArray<CompileEdge>;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
}

function findPort(ports: ReadonlyArray<PortDefinition>, portId: PortId): PortDefinition | undefined {
  return ports.find((port) => port.id === portId);
}

/** True when the definition declares this output as carrying previous-frame data (§V4). */
export function isTemporalOutput(definition: NodeDefinition, portId: PortId): boolean {
  return definition.temporal?.outputs.includes(portId) === true;
}

/** §T1641b slice 2: what `resolveNodeParameters` is told about the keys a node may store. */
export interface StoredKeyRules {
  /**
   * Keys the document may hold beside the schema: a definition's `retainedParameterKeys`,
   * or what an instance's manifest declares beside its published page.
   */
  readonly retained?: readonly string[] | undefined;
  /** `NodeDefinition.parameterKeysNote`: the node's own naming rule, said beside a refusal. */
  readonly note?: string | undefined;
  /**
   * The node was saved against ANOTHER version of its definition than this build has. A key
   * this build does not declare may be that version's: a newer build's, or an older one's
   * that the node's migration would rewrite (a document that went through `loadProject` is
   * never in that state). Either way it is not a key of nothing, and "remove it" would be
   * the wrong remedy: the version mismatch is what is said (`compiler/definition-version`).
   */
  readonly otherVersion?: boolean | undefined;
}

/**
 * One node's parameters, resolved through THE parameter read path (§V61, T168).
 *
 * The compiler used to carry its own copy of this resolution, and the copies drifted:
 * the display→linear colour decode reached the inspector's copy and not this one, so a
 * mid-grey swatch rendered near-black (B8). There is now one implementation, in
 * `src/domain/parameters/resolve.ts`, and this function is the compiler's call site into
 * it — schema resolution plus the two things that are genuinely the COMPILER's business:
 *
 *  - forwarding the resolver's own rejections into the compilation's diagnostics. The
 *    validation itself belongs to the shared resolver, because validating is what picks
 *    the value (reject → default, accept → stored); a caller that validated on its own
 *    would resolve differently, which is B8 wearing another parameter type.
 *  - the finding for a stored key OUTSIDE the schema, which nothing reads. §T1641b slice 2:
 *    it is the write gate's own finding (`undeclaredParameter`, `parameter.unknown`), asked
 *    of what the document already holds. It used to be this function's own loop, under its
 *    own code and severity, with its own words (§B264).
 *
 * Takes a bare schema rather than a `NodeDefinition` because a component instance's
 * parameter page is the component's PUBLISHED definitions, which exist before any node
 * manifest does (§V80) — and one resolver is the point. `typeLabel` is only for that
 * finding's message.
 */
export function resolveNodeParameters(
  node: GraphNode,
  parameters: ParameterSchema,
  typeLabel: string,
  diagnostics: RuntimeDiagnostic[],
  /**
   * §T1557b: REQUIRED. `parameterReadOptions(…)` for a read at a moment (`validateGraph`,
   * the time probe, the per-frame compile), or `STORED_READ` for a read of the document
   * itself (flattening's published page, a requirement classification).
   */
  read: ParameterReadOptions,
  keys: StoredKeyRules = {},
): ResolvedParameters {
  const resolved = resolveParameterSchema(node, parameters, read);

  // §V110 belt-and-braces: the patch gate refuses cycles at write time, but a document
  // can arrive from a file. Surfacing them here keeps compile the second line, and the
  // resolver's visited-set guard the last.
  diagnostics.push(...bindCycleDiagnostics(node, parameters));

  // Sorted by key, not manifest order: a diagnostic list is read by a human scanning for
  // a parameter name, and the order must not change when a manifest is reordered.
  for (const entry of [...resolved.entries].sort((a, b) => a.key.localeCompare(b.key))) {
    if (entry.diagnostic !== null) diagnostics.push(entry.diagnostic);
    // §B231: a compound's per-component slots (`place.x`, `tint.r`, §V113) carry their OWN
    // verdicts. Reading only the bare key's dropped them, so an unknown function in
    // `place.x` held the retained value with nothing said — on the problems pane and on
    // every headless render alike — while the same typo on a scalar knob was reported.
    for (const component of entry.components ?? []) {
      if (component.diagnostic !== null) diagnostics.push(component.diagnostic);
    }
  }

  // Variant settings stay in the document for a later switch, without becoming active
  // parameters: only an explicit declaration exempts a key. `color.r` addresses a component
  // of a declared compound (§V113), not an undeclared key; `undeclaredKeys` knows both.
  if (keys.otherVersion !== true) {
    for (const key of undeclaredKeys(parameters, node.parameters, keys.retained)) {
      diagnostics.push(
        undeclaredParameter(parameters, key, node.id, { stored: { nodeId: node.id, type: typeLabel }, keysNote: keys.note }),
      );
    }
  }

  return resolved;
}

/**
 * The values evaluation consumes — `space: "display"` colours decoded to linear (§V56).
 *
 * This is what feeds `NodeDefinition.compile` and therefore the plan's uniforms. A
 * caller that needs the STORED-space values instead (flattening bakes published values
 * back onto `GraphNode.parameters`, where a second decode would be wrong) reads
 * `resolveNodeParameters(...).entries` directly.
 */
export function resolveParameterValues(
  node: GraphNode,
  parameters: ParameterSchema,
  typeLabel: string,
  diagnostics: RuntimeDiagnostic[],
  read: ParameterReadOptions,
): Record<string, ParameterValue> {
  return { ...resolveNodeParameters(node, parameters, typeLabel, diagnostics, read).values };
}

/**
 * Resolves definitions and validates every node and edge in the document.
 *
 * Runs over the WHOLE document rather than the pruned subgraph: a miswired branch that
 * nothing renders is still a mistake worth surfacing in the problems tab.
 *
 * §T1552b: either side, said by the caller — the compile validates its flattening,
 * `project.validate` the document as authored (`authoredGraph(…)`), and `op()` names
 * resolve in whichever it was handed.
 */
export function validateGraph(
  graph: FlatOrAuthoredGraph,
  registry: NodeRegistryView,
  options: ParameterResolution = {},
): ValidatedGraph {
  const diagnostics: RuntimeDiagnostic[] = [];
  const nodes = new Map<NodeId, ResolvedNode>();

  /**
   * §V152 belt-and-braces, the cross-node half. The patch gate refuses an `op()` cycle at
   * write time (`referenceCyclesThrough`), but a document can arrive from a file — and a
   * cycle spans NODES, so unlike a bind cycle it has no per-node home in
   * `resolveNodeParameters`. Reported once for the graph, before any resolution runs.
   */
  const referenceGraph = referenceGraphWithPages(graph, [...(options.instancePages ?? NO_PAGES).values()].map(page => page.node));
  diagnostics.push(...referenceCycleDiagnostics(referenceGraph, (node) => channelDependenciesOf(registry.get(node.type))));
  // §T1674b: a read of a parameter that is not what its name says (a framed camera's Eye).
  diagnostics.push(...composedParameterReadDiagnostics(graph, (node) => registry.get(node.type)?.parameterChannels));

  /**
   * T316/§V148 — the cross-node read path, supplied HERE rather than by each caller.
   *
   * `op('noise1').par.gain` resolves against the graph being compiled, and this function
   * is the one place that has it: every compiler entry point comes through here, so
   * building the reader once means the plan's uniforms carry referenced values without a
   * single `compileGraph` caller having to know the seam exists. §T1557b: a caller can no
   * longer pass a reader of its own (`ParameterResolution` has no `nodes`): the flattener
   * that once did reads its published page with `STORED_READ`, and every other reader is
   * this one, built from the one factory.
   *
   * §V61 in one line: the compiler and the inspector read through the same resolver with
   * the same reader, so a reference cannot mean one thing on screen and another on the
   * GPU. That divergence is B8, and it cost this project a day.
   */
  // T1129/§V837: the reader and its base come from the one factory, not from a `base`
  // spelled out here. T1497b: and the preset morphs in flight, for the same reason — a
  // reference to a fading parameter must read the fading value.
  const read = parameterReadOptions({ graph, registry, frame: options.frame, channels: options.channels, flattening: flatteningReadsOf(options) });

  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    if (node === undefined) continue;
    const definition = registry.get(node.type);
    if (definition === undefined) {
      // §V10: an unknown type is preserved in the document as a placeholder, so this is a
      // report about this compilation, not a reason to drop the node from the project.
      diagnostics.push(
        compilerDiagnostic(
          "error",
          CompilerDiagnosticCode.unknownNodeType,
          `Node "${nodeId}" has unknown type "${node.type}".`,
          { nodeId, suggestion: "Install the node package that provides this type, or delete the node." },
        ),
      );
      continue;
    }
    if (node.definitionVersion !== definition.version) {
      diagnostics.push(
        compilerDiagnostic(
          "warning",
          CompilerDiagnosticCode.definitionVersion,
          `Node "${nodeId}" was saved against "${node.type}" v${node.definitionVersion}; the registry has v${definition.version}.`,
          { nodeId, suggestion: "Run the node's migration before relying on this compilation." },
        ),
      );
    }
    const saidFrom = diagnostics.length;
    const resolvedParameters = resolveNodeParameters(
      node,
      // T880: the node's EFFECTIVE schema — a customWgsl reflects its own shader's struct, so
      // a control it declares (orbitSpeed, lightColor) resolves and reaches the kernel. Every
      // other node returns its static schema unchanged.
      effectiveParameterSchema(definition, node.parameters),
      definition.type,
      diagnostics,
      read,
      {
        retained: definition.retainedParameterKeys,
        note: definition.parameterKeysNote,
        otherVersion: node.definitionVersion !== definition.version,
      },
    );
    nodes.set(nodeId, {
      node,
      definition,
      parameters: { ...resolvedParameters.values },
      parameterMaps: resolvedParameters.maps,
      said: diagnostics.slice(saidFrom),
    });
  }

  const edges: CompileEdge[] = [];
  /** target node/port -> edges already accepted there, for the §V14 arity check. */
  const occupancy = new Map<string, number>();

  for (const edgeId of Object.keys(graph.edges).sort()) {
    const edge = graph.edges[edgeId];
    if (edge === undefined) continue;

    const source = nodes.get(edge.source.nodeId);
    const target = nodes.get(edge.target.nodeId);
    if (source === undefined || target === undefined) {
      diagnostics.push(
        compilerDiagnostic(
          "error",
          CompilerDiagnosticCode.edgeEndpointMissing,
          `Edge "${edgeId}" connects "${edge.source.nodeId}" to "${edge.target.nodeId}"; at least one of them is missing or unknown.`,
        ),
      );
      continue;
    }

    const sourcePort = findPort(source.definition.outputs, edge.source.portId);
    if (sourcePort === undefined) {
      diagnostics.push(
        compilerDiagnostic(
          "error",
          CompilerDiagnosticCode.portMissing,
          `"${source.definition.type}" has no output port "${edge.source.portId}".`,
          { nodeId: source.node.id, portId: edge.source.portId },
        ),
      );
      continue;
    }
    const targetPort = findPort(target.definition.inputs, edge.target.portId);
    if (targetPort === undefined) {
      diagnostics.push(
        compilerDiagnostic(
          "error",
          CompilerDiagnosticCode.portMissing,
          `"${target.definition.type}" has no input port "${edge.target.portId}".`,
          { nodeId: target.node.id, portId: edge.target.portId },
        ),
      );
      continue;
    }

    // §V13: exact type match. A near miss is a missing conversion node, not a cast.
    if (!arePortsCompatible(sourcePort.type, targetPort.type)) {
      diagnostics.push(
        compilerDiagnostic(
          "error",
          CompilerDiagnosticCode.portIncompatible,
          `Edge "${edgeId}" connects ${describePortType(sourcePort.type)} to ${describePortType(targetPort.type)}.`,
          {
            nodeId: target.node.id,
            portId: targetPort.id,
            suggestion: "Insert an explicit conversion node; there is no implicit conversion (§V13).",
          },
        ),
      );
      continue;
    }

    // §V14: one incoming edge per input unless the port declares itself variadic.
    const slot = `${target.node.id}:${targetPort.id}`;
    const used = occupancy.get(slot) ?? 0;
    if (targetPort.variadic !== true && used > 0) {
      diagnostics.push(
        compilerDiagnostic(
          "error",
          CompilerDiagnosticCode.portOccupied,
          `Input "${targetPort.id}" on "${target.node.id}" already has an incoming edge; "${edgeId}" is ignored.`,
          {
            nodeId: target.node.id,
            portId: targetPort.id,
            suggestion: "Disconnect the existing edge, or declare the port variadic.",
          },
        ),
      );
      continue;
    }
    occupancy.set(slot, used + 1);

    edges.push({
      id: edgeId,
      source: { nodeId: edge.source.nodeId, portId: edge.source.portId },
      target: { nodeId: edge.target.nodeId, portId: edge.target.portId },
      temporal: isTemporalOutput(source.definition, edge.source.portId),
      // T225/§V131: the variadic input order rides along, or the compiler would fold a
      // Composite's layers in whatever order their ids happened to sort in.
      ...(edge.order === undefined ? {} : { order: edge.order }),
    });
  }

  return { nodes, edges, diagnostics };
}

/**
 * §V14 completeness, checked only for nodes that actually run: a required input with no
 * incoming edge cannot be rendered, and saying so late (at encode time) would be a blank
 * frame with no explanation.
 */
export function validateRequiredInputs(
  nodes: ReadonlyMap<NodeId, ResolvedNode>,
  edges: ReadonlyArray<CompileEdge>,
  kept: ReadonlySet<NodeId>,
): RuntimeDiagnostic[] {
  const connected = new Set<string>();
  for (const edge of edges) connected.add(`${edge.target.nodeId}:${edge.target.portId}`);

  const diagnostics: RuntimeDiagnostic[] = [];
  for (const nodeId of [...kept].sort()) {
    const resolved = nodes.get(nodeId);
    if (resolved === undefined) continue;
    for (const port of resolved.definition.inputs) {
      if (port.optional === true) continue;
      if (connected.has(`${nodeId}:${port.id}`)) continue;
      diagnostics.push(
        compilerDiagnostic(
          "error",
          CompilerDiagnosticCode.inputMissing,
          `Input "${port.id}" on "${nodeId}" (${resolved.definition.type}) is required but nothing is connected to it.`,
          { nodeId, portId: port.id },
        ),
      );
    }
  }
  return diagnostics;
}
