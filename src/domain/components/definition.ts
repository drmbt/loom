import type { GraphComponentDefinition, ExposedPort, PublishedParameter } from "../types/components.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument } from "../types/graph.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import type { ParameterDefinition } from "../types/parameters.ts";
import type { PortDefinition } from "../types/ports.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { effectiveParameterSchema } from "../parameters/resolve.ts";
import { componentAddressedDefinition, isParameterSlot } from "../parameters/slots.ts";
import { componentNodeType, isValidComponentId } from "./component-type.ts";
import { componentInstances, readParentBindings } from "./instance.ts";
import { parseParentReference } from "./parent-scope.ts";
import type { ComponentGraphSource } from "./recursion.ts";
import { PAGE_TARGET, PRESET_STATE_KEYS, PRESET_STATE_PARAMETERS, pageBanksOf } from "../presets/bank-view.ts";

/**
 * A component definition seen as a node manifest (§V79).
 *
 * The rest of the editor already knows how to draw, wire, validate and inspect anything
 * that has a `NodeDefinition`. A component gets one synthesized from its exposed ports
 * and its published parameter page, so an instance is an ordinary node everywhere
 * except where it is deliberately not: entering it, upgrading it, detaching it.
 *
 * The synthesized manifest is derived, never stored. Re-authoring a definition therefore
 * changes what every linked instance resolves against on the very next lookup, with
 * nothing to re-register and nothing to invalidate — which is most of §V79 for free.
 */

/** Category the library pane files components under. */
export const COMPONENT_CATEGORY = "component";

function error(code: string, message: string, suggestion?: string): RuntimeDiagnostic {
  return { severity: "error", code, message, ...(suggestion === undefined ? {} : { suggestion }) };
}

function warning(code: string, message: string, suggestion?: string): RuntimeDiagnostic {
  return { severity: "warning", code, message, ...(suggestion === undefined ? {} : { suggestion }) };
}

/** The internal port an `ExposedPort` maps to, resolved through the node registry. */
export function internalPortOf(
  graph: GraphDocument,
  exposed: ExposedPort,
  direction: "input" | "output",
  nodes: NodeRegistryView,
): PortDefinition | undefined {
  const node = graph.nodes[exposed.nodeId];
  if (node === undefined) return undefined;
  return nodes.port(node.type, exposed.portId, direction);
}

/** The internal parameter a published target points at. */
export function internalParameterOf(
  graph: GraphDocument,
  target: { nodeId: string; key: string },
  nodes: NodeRegistryView,
): ParameterDefinition | undefined {
  const node = graph.nodes[target.nodeId];
  if (node === undefined) return undefined;
  // T903: through the funnel — publishing a REFLECTED knob (a customWgsl's `orbitSpeed`) is
  // exactly what §T880 built E46-as-a-component for, and a static read would make every one
  // of those targets unresolvable, so the published parameter would be dropped as invalid.
  const schema = effectiveParameterSchema(nodes.get(node.type), node.parameters);
  // T1008/§T1019(b): a COMPOUND COMPONENT is a legal publish target — §V113 makes
  // `repeat.y` a real per-channel slot in the store, and refusing it here is why Chorus
  // shipped one Grid vec2 where the owner asked for Rows and Columns as separate knobs.
  // The derived scalar definition is the same one the command door resolves against.
  return schema[target.key] ?? componentAddressedDefinition(schema, target.key);
}

function exposedPortDefinitions(
  definition: GraphComponentDefinition,
  exposed: readonly ExposedPort[],
  direction: "input" | "output",
  nodes: NodeRegistryView,
): PortDefinition[] {
  const ports: PortDefinition[] = [];
  for (const port of exposed) {
    const internal = internalPortOf(definition.graph, port, direction, nodes);
    // An exposed port whose internal port cannot be resolved is dropped rather than
    // guessed: a port with an invented type would let §V13 pass a connection the
    // compiler must then refuse. `validateComponentDefinition` reports it.
    if (internal === undefined) continue;
    ports.push({ id: port.externalId, label: port.label, type: internal.type });
  }
  return ports;
}

/**
 * The synthesized manifest for one component version.
 *
 * `compile` returns no passes on purpose: a component does not compile as a node, it is
 * FLATTENED into the parent logical graph before node compilation happens (§V82). The
 * diagnostic is what a compiler that forgot to flatten will see, instead of an instance
 * that silently renders nothing.
 */
export function componentNodeDefinition(
  definition: GraphComponentDefinition,
  nodes: NodeRegistryView,
): NodeDefinition {
  const parameters: Record<string, ParameterDefinition> = {};
  for (const published of definition.parameters) {
    parameters[published.key] = published.definition;
  }
  // T1505b (§1.2 Q3): a definition with a page bank gives each instance its OWN `current`
  // and fades, on its page, so a recall writes them in the same patch as the values — one
  // revision, one undo, per instance — and paste and `get_node` carry them.
  if (pageBanksOf(definition).length > 0) Object.assign(parameters, PRESET_STATE_PARAMETERS);

  return {
    type: componentNodeType(definition.componentId, definition.version),
    version: definition.version,
    title: definition.name,
    category: COMPONENT_CATEGORY,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    inputs: exposedPortDefinitions(definition, definition.inputs, "input", nodes),
    outputs: exposedPortDefinitions(definition, definition.outputs, "output", nodes),
    parameters,
    ...(definition.capabilities === undefined ? {} : { capabilities: definition.capabilities }),
    compile: () => ({
      passes: [],
      diagnostics: [
        {
          severity: "error",
          code: "component.notFlattened",
          message: `Component "${definition.name}" reached node compilation without being flattened.`,
          suggestion: "Flatten component instances into the parent logical graph first (§V82).",
        },
      ],
    }),
  };
}

/**
 * B240: whether anything inside `graph` reads the published `key` through §V81's lexical
 * scope — a `parent.<key>` bind slot (on any node, a nested instance's page included) or a
 * legacy `state.parentBindings` entry, and, through each nested instance, a
 * `parent.parent.<key>` (one more `parent.` per level) inside its definition, at any depth.
 *
 * A slot counts whatever its active mode: a bind kept behind a static is one click from
 * reading the knob again, and unpublishing the knob under it would make that click find
 * nothing. Nested definitions come from `source`; a component already on the walk is not
 * entered again, so a recursive edit the catalogue is about to refuse cannot loop here.
 */
export function readsParentKey(graph: GraphDocument, key: string, source: ComponentGraphSource): boolean {
  const reads = (inner: GraphDocument, hops: number, walking: ReadonlySet<string>): boolean => {
    for (const node of Object.values(inner.nodes)) {
      const refs = Object.values(readParentBindings(node));
      for (const stored of Object.values(node.parameters)) {
        if (!isParameterSlot(stored)) continue;
        const binding = stored.bindings.bind;
        if (binding?.kind === "bind") refs.push(binding.ref);
      }
      for (const ref of refs) {
        const reference = parseParentReference(ref);
        if (reference !== null && reference.hops === hops && reference.key === key) return true;
      }
    }
    for (const { state } of componentInstances(inner)) {
      if (walking.has(state.componentId)) continue;
      const nested = source.graphOf(state.componentId, state.version);
      if (nested !== undefined && reads(nested, hops + 1, new Set([...walking, state.componentId]))) return true;
    }
    return false;
  };
  return reads(graph, 1, new Set());
}

/**
 * Drops exposures and published targets whose internal node or port no longer exists.
 *
 * Deleting an internal node that happened to be exposed must not make the whole component
 * un-saveable — the user deleted a node, they did not ask to break their file. The
 * exposure goes with it, and `validateComponentDefinition` then has nothing to complain
 * about. A published parameter that LOSES its last target to the edit is unpublished: a
 * knob wired to nothing is worse than no knob.
 *
 * B240: that is the whole of the rule, and it is narrower than it used to be. A knob is
 * unpublished only when it had targets, none of them still resolves, AND nothing inside
 * reads it as `parent.<key>` (`readsParentKey`) — such a knob still drives what reads it,
 * which §V81 allows and `validateComponentDefinition` only warns about. A knob that came in
 * with NO targets lost nothing to this edit: it was published that way on purpose, as pure
 * lexical scope, and it stays whether or not anything reads it yet — otherwise any
 * unrelated edit in the session (a move, a rename) would take it, and the very next step
 * of publishing a knob and then binding a reader to it would find it gone.
 */
export function pruneComponentDefinition(
  definition: GraphComponentDefinition,
  nodes: NodeRegistryView,
  source: ComponentGraphSource,
): GraphComponentDefinition {
  const keepPort = (direction: "input" | "output") => (port: ExposedPort) =>
    internalPortOf(definition.graph, port, direction, nodes) !== undefined;

  const parameters: PublishedParameter[] = [];
  for (const published of definition.parameters) {
    const targets = published.targets.filter(
      (target) => internalParameterOf(definition.graph, target, nodes) !== undefined,
    );
    const lostAll = published.targets.length > 0 && targets.length === 0;
    if (lostAll && !readsParentKey(definition.graph, published.key, source)) continue;
    parameters.push({ ...published, targets });
  }

  return {
    ...definition,
    inputs: definition.inputs.filter(keepPort("input")),
    outputs: definition.outputs.filter(keepPort("output")),
    parameters,
  };
}

function checkPublishedParameter(
  definition: GraphComponentDefinition,
  published: PublishedParameter,
  nodes: NodeRegistryView,
  diagnostics: RuntimeDiagnostic[],
): void {
  if (published.key.trim() === "") {
    diagnostics.push(error("component.parameter.key", "A published parameter has an empty key."));
  }
  if (published.targets.length === 0) {
    // A warning, not an error: a published parameter with no targets is still useful as
    // pure lexical scope, read by descendants as `parent.<key>` (§V81). Refusing it would
    // make the two halves of the component model contradict each other.
    diagnostics.push(
      warning(
        "component.parameter.noTargets",
        `Published parameter "${published.key}" drives no internal parameter directly.`,
        "That is fine if descendants read it as parent." + published.key + " (§V81); otherwise it does nothing.",
      ),
    );
  }
  for (const target of published.targets) {
    const internal = internalParameterOf(definition.graph, target, nodes);
    if (internal === undefined) {
      diagnostics.push(
        error(
          "component.parameter.missingTarget",
          `Published parameter "${published.key}" targets "${target.nodeId}.${target.key}", which does not exist inside "${definition.name}".`,
        ),
      );
      continue;
    }
    // The published definition is RE-AUTHORED, not copied — a different label, unit or
    // range is the point. A different TYPE is not: the value has to be writable to every
    // target, and `validateParameters` would reject it at the moment of the edit.
    if (internal.type !== published.definition.type) {
      diagnostics.push(
        error(
          "component.parameter.typeMismatch",
          `Published parameter "${published.key}" is a ${published.definition.type}, but "${target.nodeId}.${target.key}" is a ${internal.type}.`,
          "Re-author the label, range and unit freely; the type has to match every target.",
        ),
      );
      continue;
    }
    if (published.definition.type === "number" && internal.type === "number") {
      const below = internal.min !== undefined && (published.definition.min ?? -Infinity) < internal.min;
      const above = internal.max !== undefined && (published.definition.max ?? Infinity) > internal.max;
      if (below || above) {
        diagnostics.push(
          warning(
            "component.parameter.rangeWiderThanTarget",
            `Published range for "${published.key}" reaches outside the range of "${target.nodeId}.${target.key}".`,
            "Values outside the internal range will be refused when the knob is turned.",
          ),
        );
      }
    }
  }
}

/**
 * Everything that must hold before a definition is registered — and therefore before it
 * can be saved or loaded. Recursion is checked separately, by `detectComponentRecursion`,
 * because it needs the whole catalogue and not just this one definition (§V83).
 */
export function validateComponentDefinition(
  definition: GraphComponentDefinition,
  nodes: NodeRegistryView,
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];

  if (!isValidComponentId(definition.componentId)) {
    diagnostics.push(
      error(
        "component.id",
        `"${definition.componentId}" is not a usable component id.`,
        'A component id must be non-empty, untrimmed-free, and may not contain "@" — the version separator in the node type.',
      ),
    );
  }
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    diagnostics.push(
      error("component.version", `Component "${definition.name}" needs an integer version >= 1.`),
    );
  }
  if (definition.name.trim() === "") {
    diagnostics.push(error("component.name", `Component "${definition.componentId}" has no name.`));
  }

  const externalIds = new Set<string>();
  for (const [direction, ports] of [
    ["input", definition.inputs],
    ["output", definition.outputs],
  ] as const) {
    for (const port of ports) {
      if (externalIds.has(port.externalId)) {
        diagnostics.push(
          error(
            "component.port.duplicate",
            `Component "${definition.name}" exposes "${port.externalId}" more than once.`,
          ),
        );
      }
      externalIds.add(port.externalId);
      if (definition.graph.nodes[port.nodeId] === undefined) {
        diagnostics.push(
          error(
            "component.port.missingNode",
            `Exposed port "${port.externalId}" maps to internal node "${port.nodeId}", which is not in the component.`,
          ),
        );
        continue;
      }
      if (internalPortOf(definition.graph, port, direction, nodes) === undefined) {
        diagnostics.push(
          error(
            "component.port.missingPort",
            `Exposed port "${port.externalId}" maps to "${port.nodeId}.${port.portId}", which is not an ${direction} port.`,
          ),
        );
      }
    }
  }

  const keys = new Set<string>();
  for (const published of definition.parameters) {
    if (keys.has(published.key)) {
      diagnostics.push(
        error(
          "component.parameter.duplicate",
          `Component "${definition.name}" publishes "${published.key}" more than once.`,
        ),
      );
    }
    keys.add(published.key);
    // T1505b: the two keys an instance's preset state lives under are not the author's to publish.
    if (PRESET_STATE_KEYS.has(published.key)) {
      diagnostics.push(
        error(
          "component.parameter.reserved",
          `"${published.key}" is reserved: it holds the preset state of each instance of "${definition.name}".`,
          "Publish it under another key.",
        ),
      );
    }
    checkPublishedParameter(definition, published, nodes, diagnostics);
  }

  // T1505b (§1.2 Q1, Q2): one page bank per definition in v1, and `parent` is a reserved word.
  const pageBanks = pageBanksOf(definition);
  if (pageBanks.length > 1) {
    const named = pageBanks.map((bank) => `"${bank.label ?? bank.id}"`).join(", ");
    diagnostics.push(
      warning(
        "component.presets.twoPageBanks",
        `Component "${definition.name}" has more than one preset bank targeting parent (${named}); its instances use the first, "${pageBanks[0]?.label ?? pageBanks[0]?.id ?? ""}".`,
        "Keep one bank targeting parent; target internal nodes from the others.",
      ),
    );
  }
  if (pageBanks.length > 0) {
    for (const nodeId of Object.keys(definition.graph.nodes).sort()) {
      const node = definition.graph.nodes[nodeId];
      if (node?.label !== PAGE_TARGET) continue;
      diagnostics.push(
        warning(
          "component.presets.parentNamed",
          `A node inside "${definition.name}" is named "${PAGE_TARGET}", which a preset bank reads as the instance's page; it cannot be a preset target.`,
          "Rename that node.",
        ),
      );
    }
  }

  return diagnostics;
}
