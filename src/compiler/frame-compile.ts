import type { NodeId } from "../domain/types/ids.ts";
import type { FlatGraph, GraphNode } from "../domain/types/graph.ts";
import { parameterDependencies } from "../domain/graph/parameter-dependencies.ts";
import type { NodeDefinition, CompiledNodeDescription, KernelStepsDeclaration } from "../domain/types/node-definition.ts";
import type { ScenePayload } from "../domain/types/scene.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { ParameterValue } from "../domain/types/parameters.ts";
import { effectiveParameterSchema } from "../domain/parameters/resolve.ts";
import type { ParameterMapBinding, ParameterMorphs } from "../domain/parameters/resolve.ts";
import { parameterReadOptions } from "../domain/parameters/node-references.ts";
import type { PassDescriptor } from "../runtime/backend/plan.ts";
import { readPass, samePassStructure } from "../runtime/backend/plan.ts";
import { compileGraphRetaining, descriptionStructureKey, normalizePass } from "./compile.ts";
import type { CompileGraphResult, RetainedCompile, RetainedNodeCompile } from "./compile.ts";
import { isParameterPolicy } from "./resolution.ts";
import { kernelStepsFor, substepCount } from "./substeps.ts";
import { flatteningReadsOf, resolveNodeParameters } from "./validate.ts";
import { scaleOutputPixels } from "./pixel-scale.ts";
import { timeProbeFor } from "./time-probe.ts";
import { outputPixelScale } from "../domain/types/graph.ts";
import type { ParameterResolution } from "./validate.ts";
import { outputKey } from "./types.ts";
import type { ActiveSink, CompileRequest, CompiledGraph, CompiledInputBinding, CompilerNodeContext } from "./types.ts";

/**
 * The per-frame VALUES-ONLY compile (T1182, T1183, §V936).
 *
 * ## What it replaces
 *
 * An animated document re-ran the whole of `compileGraph` on every frame — flatten
 * reuse aside: every node's parameters re-resolved, the graph re-pruned and re-ordered,
 * resolution and format re-propagated, every node re-compiled, every pass re-keyed —
 * and the frame loop then read back exactly one thing from the result: the uniform
 * VALUES of each pass and the count of each loop-begin marker (`animate-parameters.ts`).
 * Measured on E24 that was 0.85 ms a frame of which ~85% produced nothing the consumer
 * looked at (`docs/perf-profile-2026-09-08.md` item 5).
 *
 * ## What it does instead
 *
 * ONE full compile per graph revision (`prepare`), which keeps, per compiled node, the
 * context it was compiled with, the pass ids it emitted and the structural half of its
 * description (`RetainedNodeCompile`). A frame then:
 *
 *   1. re-resolves parameters for the nodes that ANIMATE (expression / driven / bind —
 *      `animatedRootKeys` mirrors `nodeHasAnimatedParameters` — and, T1497b, a key a
 *      preset morph record covers), through the same resolver and the same `op()` reader
 *      the full compile uses (§V61, §V939);
 *   2. re-runs `definition.compile` for those nodes, and for every node downstream of
 *      them through a SCENE PAYLOAD edge — a payload is a CPU value that travels
 *      (camera → render), so its consumers' uniforms move when it does;
 *   3. PROVES each re-run is structure-preserving: same scratch and pointset
 *      declarations (`descriptionStructureKey`), same pass ids in the same order, and
 *      the same structure per pass as the base plan's (`samePassStructure`: what
 *      `passStructureKey` compares, without serialising the shader text to do it) — and
 *   4. splices the re-emitted passes over the base plan's, re-deriving loop-begin counts
 *      through `substepCount`, so the result's `signature` is the base's by construction.
 *
 * ## What it refuses, and how
 *
 * Two gates, both loud in the result rather than silent (§V936):
 *
 *   - the CLASSIFIER (`structuralParameterKeys`): a node animating a parameter the
 *     DEFINITIONS declare structural — `compileTime: true` in its effective schema, or a
 *     key a `kind: "parameter"` resolution policy reads — makes the whole document
 *     ineligible (`uniformOnly === false`, `reason` names the node and key), because the
 *     full compile would let that parameter change resolution, shader text or resources;
 *   - the VERIFIER (step 3): a definition whose structure depends on a parameter it did
 *     NOT declare `compileTime` is caught per frame; `compileFrame` returns `null`, the
 *     path stays degraded for the life of the prepared compiler (`reason` says why), and
 *     the caller falls through to the full compile — which is exactly what it did before
 *     this file existed, so a lying definition costs a fallback, never a wrong picture.
 *
 * `outputWhen` and `msaaWhen` read STORED parameters (`compile.ts` propagate), never
 * resolved ones, so they cannot vary with the frame inside a revision (T1176's finding);
 * the keys they read are `compileTime` today and `frame-compile.test.ts` derives that from
 * the registry rather than trusting it.
 *
 * ## What the result IS
 *
 * `{ ...base, passes }`: the base plan with pass uniforms and loop counts at the frame.
 * `diagnostics`, `outputs` (preview synthesis included), `feedback` and every signature
 * are the BASE's — the only consumer (`pushAnimatedValues`) reads passes and nothing
 * else, and the full per-frame compile's versions of those fields were discarded too. A
 * caller that needs per-frame diagnostics runs `compileGraph` with a `resolution`.
 */

export interface FrameCompiler {
  /** The full compile at the request's own resolution — the plan every frame is spliced over. */
  readonly base: CompiledGraph;
  /**
   * True when every animated parameter of every compiled node is a VALUE by declaration.
   * False means `compileFrame` always returns `null` and `reason` says which node and key.
   */
  readonly uniformOnly: boolean;
  /** Why the fast path is off or has degraded; `null` while it is live. */
  readonly reason: string | null;
  /**
   * The base plan with uniforms and loop counts at `resolution`, or `null` when this
   * frame could not be proven structure-preserving — the caller then compiles in full.
   */
  compileFrame(resolution: ParameterResolution): CompiledGraph | null;
}

/**
 * Root keys of the parameters that CAN read the frame: expression, driven or bind mode.
 * A component key (`color.g`) counts under its compound's root, because `compileTime`
 * is declared on the compound. The mode list is `nodeHasAnimatedParameters`'s
 * (`graph-channels.ts`); `frame-compile.test.ts` holds the two together on every
 * shipped example.
 *
 * T1497b: plus every key a preset MORPH record covers. A morphing key stores a plain
 * value — the destination — so no mode gives it away; the index is what knows (the
 * design doc §5.3). The index only ever lists keys that may fade, never a structural
 * one (`morphableKey`), so a morph cannot push a document off the values-only path.
 */
export function animatedRootKeys(node: GraphNode, morphs?: ParameterMorphs): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [key, stored] of Object.entries(node.parameters)) {
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) continue;
    const mode = (stored as { mode?: unknown }).mode;
    if (mode === "expression" || mode === "driven" || mode === "bind") keys.add(key.split(".")[0] as string);
  }
  for (const key of morphs?.keysOf(node.id) ?? []) keys.add(key.split(".")[0] as string);
  return keys;
}

/**
 * The parameters of ONE node whose value the compiler treats as STRUCTURE, derived from
 * the definition rather than listed: every key the effective schema marks
 * `compileTime`, plus the two a `kind: "parameter"` resolution policy reads for the
 * node's size (`resolution.ts`). A parameter outside this set may change nothing but
 * uniform values — `frame-compile.test.ts` perturbs every such parameter of every
 * registered node type and checks that claim against the full compile.
 */
export function structuralParameterKeys(
  definition: NodeDefinition,
  stored: Readonly<Record<string, unknown>>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  const schema = effectiveParameterSchema(definition, stored);
  for (const [key, parameter] of Object.entries(schema)) {
    if (parameter.compileTime === true) keys.add(key);
  }
  // The frozen ResolutionPolicy union has no "parameter" member yet (see resolution.ts,
  // T151), so the guard narrows from `unknown` exactly as the resolver itself does.
  const policy: unknown = definition.resolutionPolicy;
  if (isParameterPolicy(policy)) {
    keys.add(policy.width);
    keys.add(policy.height);
  }
  return keys;
}

interface FrameValues {
  readonly parameters: Readonly<Record<string, ParameterValue>>;
  readonly parameterMaps: Readonly<Record<string, ParameterMapBinding>>;
}

/** A node that animates, with what its per-frame resolution needs, computed once. */
interface AnimatedNode {
  readonly nodeId: NodeId;
  readonly record: RetainedNodeCompile;
  readonly schema: ReturnType<typeof effectiveParameterSchema>;
}

function classify(
  retained: RetainedCompile,
  /** T1652b: re-resolve exactly these nodes, animated or not (`rebaseOnValues`). */
  only?: ReadonlySet<NodeId>,
): { animated: AnimatedNode[]; reason: string | null } {
  const animated: AnimatedNode[] = [];
  for (const nodeId of retained.order) {
    const record = retained.nodes.get(nodeId);
    if (record === undefined) continue;
    if (only !== undefined && !only.has(nodeId)) continue;
    const keys = animatedRootKeys(record.node, retained.morphs);
    if (keys.size === 0 && only === undefined) continue;
    const structural = structuralParameterKeys(record.definition, record.node.parameters);
    for (const key of [...keys].sort()) {
      if (structural.has(key)) {
        return {
          animated,
          reason: `Node "${nodeId}" (${record.node.type}) animates "${key}", which is structural (compileTime or a resolution policy input); every frame compiles in full.`,
        };
      }
    }
    animated.push({
      nodeId,
      record,
      schema: effectiveParameterSchema(record.definition, record.node.parameters),
    });
  }
  return { animated, reason: null };
}

function bindingsReadScene(
  inputs: CompilerNodeContext["inputs"],
  recompiled: ReadonlySet<NodeId>,
): boolean {
  for (const bindings of Object.values(inputs)) {
    for (const binding of bindings) {
      if (binding.scene !== undefined && recompiled.has(binding.sourceNodeId)) return true;
    }
  }
  return false;
}

function withScenePayloads(
  inputs: CompilerNodeContext["inputs"],
  scene: ReadonlyMap<string, ScenePayload>,
): CompilerNodeContext["inputs"] {
  const next: Record<string, CompiledInputBinding[]> = {};
  for (const [portId, bindings] of Object.entries(inputs)) {
    next[portId] = bindings.map((binding) => {
      if (binding.scene === undefined) return binding;
      const payload = scene.get(outputKey(binding.sourceNodeId, binding.sourcePortId));
      return payload === undefined || payload === binding.scene ? binding : { ...binding, scene: payload };
    });
  }
  return next;
}

function sameSinks(
  a: ReadonlyArray<ActiveSink> | undefined,
  b: ReadonlyArray<ActiveSink> | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  return a.every((sink, index) => {
    const other = b[index] as ActiveSink;
    return sink.nodeId === other.nodeId && sink.portId === other.portId && sink.kind === other.kind;
  });
}

/**
 * Whether a base compiled for `built` IS the compile `request` would produce (T1254).
 *
 * The compiler is pure, so identical inputs are the proof: every input the plan depends
 * on must be the same object (sinks by value — a caller without a sink store derives a
 * fresh array per request), and both must be FRAMELESS with one channel reader, because
 * a base resolved at a frame carries that frame's values in every pass the frames do not
 * re-emit. Returns the first input that differs, or `null`.
 */
function baseMismatch(built: CompileRequest, request: CompileRequest): string | null {
  if (built.graph !== request.graph) return "graph";
  if (built.flattened !== request.flattened) return "flattened";
  if (built.settings !== request.settings) return "settings";
  if (built.registry !== request.registry) return "registry";
  if (built.capabilities !== request.capabilities) return "capabilities";
  if (built.components !== request.components) return "components";
  if (!sameSinks(built.sinks, request.sinks)) return "sinks";
  if (built.resolution?.frame !== undefined || request.resolution?.frame !== undefined) return "resolution.frame";
  if (built.resolution?.channels !== request.resolution?.channels) return "resolution.channels";
  return null;
}

/**
 * One full compile, then frames at the cost of the nodes that animate.
 *
 * `request.resolution` is the BASE's moment (the structural compile passes its channel
 * resolver and no frame); each `compileFrame` supplies its own.
 *
 * T1254: a caller that has ALREADY compiled `request` in full hands that result in as
 * `base` and no second compile happens — the app's structural memo compiles once per
 * revision and the frames splice over that very plan, which is also what makes the
 * frame loop's `isUniformOnlyChange` check hold by identity rather than by luck. A base
 * built for a different request is a wrong plan wearing a fast path, so it is REFUSED
 * with a throw (a caller bug, not a frame to degrade on): the compiler's own record of
 * what it compiled (`retained.request`) is compared input by input.
 */
export function prepareFrameCompiler(request: CompileRequest, base?: CompileGraphResult): FrameCompiler {
  if (base !== undefined && base.retained !== null) {
    const mismatch = baseMismatch(base.retained.request, request);
    if (mismatch !== null) {
      throw new Error(
        `prepareFrameCompiler: the supplied base was compiled for a different request (${mismatch} differs); compile the request itself or pass no base.`,
      );
    }
  }
  return frameCompilerOver(request, base ?? compileGraphRetaining(request));
}

/** T1652b: what a re-run left behind, for the caller that keeps it (`rebaseOnValues`). */
interface RerunCapture {
  /** The context each re-run node compiled with. */
  readonly contexts: Map<NodeId, CompilerNodeContext>;
  /** Scene payloads after the re-run. */
  scene: ReadonlyMap<string, ScenePayload> | null;
  /** What each re-run node said: resolving its parameters, then compiling them. */
  readonly said: Map<NodeId, RuntimeDiagnostic[]>;
}

function frameCompilerOver(
  request: CompileRequest,
  result: CompileGraphResult,
  only?: ReadonlySet<NodeId>,
): FrameCompiler & { compileFrame(resolution: ParameterResolution, capture?: RerunCapture): CompiledGraph | null } {
  const { compiled: base, retained } = result;
  if (retained === null) {
    return { base, uniformOnly: false, reason: "The compile produced no plan to splice over.", compileFrame: () => null };
  }
  const { animated, reason: classified } = classify(retained, only);
  if (classified !== null) {
    return { base, uniformOnly: false, reason: classified, compileFrame: () => null };
  }

  /* T1603b: the base's own passes, to compare a re-emitted one against where it stands
     (`samePassStructure`) instead of serialising it, shader text and all, every frame. */
  const basePasses = new Map<string, PassDescriptor>();
  for (const pass of base.passes) basePasses.set(pass.id, pass);
  /** Loop-begin markers, with the parameter whose value sets their count. */
  const loopCounts = new Map<string, { nodeId: NodeId; key: string }>();
  /** T1583b: kernel regions, whose count is two parameters' product (T1585b: or a rate's). */
  const kernelSteps = new Map<string, { nodeId: NodeId; declared: KernelStepsDeclaration }>();
  for (const pass of base.passes) {
    if (pass.kind !== "loop" || pass.edge !== "begin" || pass.nodeId === undefined) continue;
    const definition = retained.nodes.get(pass.nodeId)?.definition;
    if (pass.steps !== undefined) {
      if (definition?.steps !== undefined) kernelSteps.set(pass.id, { nodeId: pass.nodeId, declared: definition.steps });
      continue;
    }
    const key = definition?.temporal?.substeps;
    if (key !== undefined) loopCounts.set(pass.id, { nodeId: pass.nodeId, key });
  }

  let reason: string | null = null;
  const degrade = (why: string): null => {
    reason = why;
    return null;
  };

  const compileFrame = (resolution: ParameterResolution, capture?: RerunCapture): CompiledGraph | null => {
    if (reason !== null) return null;
    // T1497b: the morph index the BASE was compiled and classified with, unless the
    // caller brings its own — the same precedence `compileGraphRetaining` applies.
    const morphs = resolution.morphs ?? retained.morphs;
    // T1485b: the instances the BASE compile read through, by the same precedence.
    const instances = resolution.instances ?? retained.instances;
    // The same reader `validateGraph` builds (§V939).
    const reader = parameterReadOptions({
      graph: retained.graph,
      registry: request.registry,
      frame: resolution.frame,
      channels: resolution.channels,
      flattening: flatteningReadsOf({ morphs, instances }),
    });
    // Per-frame resolution diagnostics (a clamped expression, an unattached channel) are
    // dropped, exactly as the full per-frame compile's were by its one consumer.
    const discarded: RuntimeDiagnostic[] = [];
    const values = new Map<NodeId, FrameValues>();
    // T1432b: the same pixel scale the full compile gave the node's context.
    const pixelScale = outputPixelScale(retained.request.settings);
    for (const entry of animated) {
      // T1652b: a rebase keeps what the node said, exactly as `validateGraph` collects it.
      const said: RuntimeDiagnostic[] | undefined = capture === undefined ? undefined : [];
      // §T1641b: the retained keys ride along so that a variant's kept settings are not
      // written up as undeclared sixty times a second only to be discarded below.
      // The note and the version are what `validateGraph` passes too: a rebase compares what
      // the node says with what it said there, sentence for sentence.
      const resolved = resolveNodeParameters(entry.record.node, entry.schema, entry.record.definition.type, said ?? discarded, reader, {
        retained: entry.record.definition.retainedParameterKeys,
        note: entry.record.definition.parameterKeysNote,
        otherVersion: entry.record.node.definitionVersion !== entry.record.definition.version,
      });
      if (said !== undefined && said.length > 0) capture?.said.set(entry.nodeId, said);
      values.set(entry.nodeId, { parameters: scaleOutputPixels({ ...resolved.values }, entry.schema, pixelScale), parameterMaps: resolved.maps });
    }

    const scene = new Map(retained.scenePayloads);
    const recompiled = new Set<NodeId>();
    const replacements = new Map<string, PassDescriptor>();
    for (const nodeId of retained.order) {
      const record = retained.nodes.get(nodeId);
      if (record === undefined) continue;
      const frameValues = values.get(nodeId);
      const sceneMoved = bindingsReadScene(record.context.inputs, recompiled);
      if (frameValues === undefined && !sceneMoved) continue;
      // T1421b: the probe moves with the frame, exactly as the full compile's does.
      const probe = timeProbeFor(record.node, record.definition, retained.graph, request.registry, { ...resolution, morphs, ...(instances === undefined ? {} : { instances }) }, retained.request.settings);
      const context: CompilerNodeContext = {
        ...record.context,
        ...(frameValues === undefined ? {} : frameValues),
        inputs: sceneMoved ? withScenePayloads(record.context.inputs, scene) : record.context.inputs,
        ...(probe === undefined ? {} : { timeProbe: probe }),
      };
      let description: CompiledNodeDescription;
      try {
        description = record.definition.compile(context);
      } catch (error) {
        return degrade(`Node "${nodeId}" (${record.node.type}) threw while compiling a frame: ${error instanceof Error ? error.message : String(error)}.`);
      }
      if (descriptionStructureKey(description) !== record.structureKey) {
        return degrade(`Node "${nodeId}" (${record.node.type}) declared different scratch or pointset storage at this frame; a value-only parameter changed structure.`);
      }
      if (capture !== undefined) {
        capture.contexts.set(nodeId, context);
        if (description.diagnostics !== undefined && description.diagnostics.length > 0) {
          capture.said.set(nodeId, [...(capture.said.get(nodeId) ?? []), ...description.diagnostics]);
        }
      }
      const sceneRaw = (description as { scene?: unknown }).scene;
      if (typeof sceneRaw === "object" && sceneRaw !== null) {
        for (const [portId, payload] of Object.entries(sceneRaw as Record<string, unknown>)) {
          if (typeof payload === "object" && payload !== null && typeof (payload as { kind?: unknown }).kind === "string") {
            scene.set(outputKey(nodeId, portId), payload as ScenePayload);
          }
        }
      }
      const passes: PassDescriptor[] = [];
      for (let index = 0; index < description.passes.length; index += 1) {
        const normalized = normalizePass(nodeId, record.context.target, index, description.passes[index], discarded);
        const pass = normalized === undefined ? undefined : readPass(normalized);
        if (pass === undefined) {
          return degrade(`Node "${nodeId}" (${record.node.type}) emitted pass #${String(index)} that the plan reader refused at this frame.`);
        }
        passes.push(pass);
      }
      if (passes.length !== record.passIds.length) {
        return degrade(`Node "${nodeId}" (${record.node.type}) emitted ${String(passes.length)} passes at this frame, ${String(record.passIds.length)} at the base; a value-only parameter changed structure.`);
      }
      for (let index = 0; index < passes.length; index += 1) {
        const pass = passes[index] as PassDescriptor;
        const basePass = basePasses.get(pass.id);
        if (pass.id !== record.passIds[index] || basePass === undefined || !samePassStructure(pass, basePass)) {
          return degrade(`Node "${nodeId}" (${record.node.type}) emitted pass "${pass.id}" with a different structure at this frame; a value-only parameter changed structure.`);
        }
        replacements.set(pass.id, pass);
      }
      recompiled.add(nodeId);
    }

    const passes = base.passes.map((pass): PassDescriptor => {
      const replacement = replacements.get(pass.id);
      if (replacement !== undefined) return replacement;
      if (pass.kind !== "loop" || pass.edge !== "begin") return pass;
      const stepped = kernelSteps.get(pass.id);
      if (stepped !== undefined && pass.steps !== undefined) {
        /* T1585b: a RATE's count is this frame's own whether or not any parameter of the
           node animates, so it is re-derived from the node's base values when none does —
           which keeps this path saying what a full compile at this frame says. A count
           declaration with nothing animating has nothing that can have moved. */
        const node =
          values.get(stepped.nodeId) ??
          (typeof stepped.declared.substeps === "string" ? undefined : retained.nodes.get(stepped.nodeId)?.context);
        if (node === undefined) return pass;
        // The same function the full compile's region came from, so the two cannot disagree.
        // The backend derives a rate's count again, for the frame it renders.
        const { count, iterations, rate } = kernelStepsFor(stepped.declared, node.parameters, resolution.frame?.deltaSeconds ?? 0);
        const sameRate =
          rate === undefined
            ? pass.steps.rate === undefined
            : pass.steps.rate !== undefined &&
              rate.perSecond === pass.steps.rate.perSecond &&
              rate.min === pass.steps.rate.min &&
              rate.max === pass.steps.rate.max;
        return count === pass.count && iterations === pass.steps.iterations && sameRate
          ? pass
          : { ...pass, count, steps: { ...pass.steps, iterations, ...(rate === undefined ? {} : { rate }) } };
      }
      const loop = loopCounts.get(pass.id);
      const owner = loop === undefined ? undefined : values.get(loop.nodeId);
      if (loop === undefined || owner === undefined) return pass;
      const count = substepCount(owner.parameters[loop.key]);
      return count === pass.count ? pass : { ...pass, count };
    });
    if (capture !== undefined) capture.scene = scene;
    return { ...base, passes };
  };

  return {
    base,
    uniformOnly: true,
    get reason() {
      return reason;
    },
    compileFrame,
  };
}

/**
 * T1652b — who reads a node's VALUES, per retained compile: the nodes whose resolved
 * parameters can move when one of its stored values does. Built once per structural
 * compile, on the first value written after it, and carried from each rebase to the next
 * (a values-only revision changes no reference and no wire).
 */
const VALUE_READERS = new WeakMap<RetainedCompile, ReadonlyMap<NodeId, ReadonlyArray<NodeId>>>();

/** Port kinds that carry a GPU resource: what flows is pixels or points, never a parameter's value. */
const RESOURCE_PORT_KINDS: ReadonlySet<string> = new Set(["texture2d", "pointset", "buffer"]);

function valueReadersOf(retained: RetainedCompile, registry: CompileRequest["registry"]): ReadonlyMap<NodeId, ReadonlyArray<NodeId>> {
  const known = VALUE_READERS.get(retained);
  if (known !== undefined) return known;
  const readers = new Map<NodeId, NodeId[]>();
  const add = (source: NodeId, reader: NodeId): void => {
    const list = readers.get(source);
    if (list === undefined) readers.set(source, [reader]);
    else if (!list.includes(reader)) list.push(reader);
  };
  // A parameter that reads another node: `op('a')` in an expression, a driven channel, a
  // source named by a reference parameter (§V154, the one traversal).
  for (const [reader, dependencies] of parameterDependencies(retained.graph)) {
    for (const dependency of dependencies) add(dependency.to, reader);
  }
  // A wire that carries a VALUE: a value channel into the next value stage, a scene payload
  // into its consumer. A texture or a pointset wire carries a resource, and what its
  // consumer reads of the producer is structure (size, format, attributes).
  for (const edge of Object.values(retained.graph.edges)) {
    const source = retained.graph.nodes[edge.source.nodeId];
    const port = source === undefined ? undefined : registry.get(source.type)?.outputs.find((candidate) => candidate.id === edge.source.portId);
    if (port !== undefined && RESOURCE_PORT_KINDS.has(port.type.kind)) continue;
    add(edge.source.nodeId, edge.target.nodeId);
  }
  VALUE_READERS.set(retained, readers);
  return readers;
}

const saidKey = (said: ReadonlyArray<RuntimeDiagnostic> | undefined): string =>
  said === undefined || said.length === 0 ? "" : JSON.stringify(said);

/**
 * Whether two flattened nodes (or wires) are the same: the same object, or — a flattening
 * with instances mints a copy per walk — objects whose fields are the same objects, or say
 * the same. A document is JSON, so "says the same" is its serialisation; it is only asked
 * of the fields a copy rebuilt.
 */
function sameFlattened(a: object | undefined, b: object | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const left = a as Readonly<Record<string, unknown>>;
  const right = b as Readonly<Record<string, unknown>>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (left[key] === right[key]) continue;
    if (typeof left[key] !== "object" || left[key] === null || JSON.stringify(left[key]) !== JSON.stringify(right[key])) return false;
  }
  return true;
}

/**
 * T1652b — THE VALUES LANE: the compile of `request`, from the compile of the revision
 * before it, when only VALUES moved between them (`classifyRevision` in the app says
 * which revisions those are, and which nodes were `written`).
 *
 * A value written on a 150-node document used to re-run the whole of `compileGraph`:
 * every node re-resolved, the graph re-pruned and re-ordered, every node re-compiled,
 * every pass re-keyed (10.8 ms of a 57 ms task, measured). The plan that came back
 * differed from the one before it in the uniform values of a handful of passes.
 *
 * This re-resolves the nodes whose values can have moved — the written ones and, through
 * `valueReadersOf`, everything that reads them — and re-runs `definition.compile` for
 * those, through the per-frame compile's own re-run and UNDER ITS VERIFIER (§V936): same
 * scratch and pointset declarations, same pass ids in the same order, the same structure
 * per pass. Then it is the base plan with those passes spliced, and the base's retained
 * records with those nodes' moved, so the frames after it splice over this revision.
 *
 * Returns the reason, as a sentence, whenever it cannot PROVE the result is the full
 * compile's. The caller then compiles in full, which is what every revision did before
 * this existed, so a refusal costs time and never a wrong picture or a lost diagnostic:
 *
 *  - an input other than the document moved (settings, sinks, device, catalogue, reader);
 *  - the flattening differs anywhere but at the written nodes (a component instance);
 *  - a node that reads a written value animates a STRUCTURAL parameter;
 *  - a re-run node emitted another structure, or threw, or a loop's count moved;
 *  - a node SAYS something different about its new value: a diagnostic appeared, went or
 *    changed its words. Diagnostics are part of what a compile answers, and the spliced
 *    plan carries the base's.
 *
 * `frame-compile.test.ts` holds the result against `compileGraphRetaining(request)` pass
 * for pass on shipped examples.
 */
export function rebaseOnValues(previous: CompileGraphResult, request: CompileRequest, written: ReadonlyArray<NodeId>): CompileGraphResult | string {
  const { compiled: base, retained } = previous;
  if (retained === null) return "The compile before this value produced no plan to splice over.";
  if (!base.ok) return "The plan before this value has errors, so it is compiled in full.";
  const built = retained.request;
  for (const input of ["settings", "registry", "capabilities", "components"] as const) {
    if (built[input] !== request[input]) return `The compile's ${input} moved with the value.`;
  }
  if (!sameSinks(built.sinks, request.sinks)) return "The compile's sinks moved with the value.";
  if (built.resolution?.frame !== undefined || request.resolution?.frame !== undefined) return "A plan resolved at a frame is not a base.";
  if (built.resolution?.channels !== request.resolution?.channels) return "The compile's channel reader moved with the value.";

  const before = built.flattened?.graph;
  const after = request.flattened?.graph;
  if (before === undefined || after === undefined) return "No flattening to compare the two revisions by.";
  // The flattening of a document with no instance holds the document's OWN node and wire
  // objects (`identityFlattening`), so two revisions compare by reference. The walk of a
  // document with instances mints copies, and those are compared by what they say: the two
  // flattenings must differ at the written nodes and nowhere else.
  const wires = Object.keys(after.edges);
  if (wires.length !== Object.keys(before.edges).length || wires.some((id) => !sameFlattened(after.edges[id], before.edges[id]))) {
    return "The flattening's wires differ between the two revisions.";
  }
  const moved = new Set<NodeId>(written);
  const ids = Object.keys(after.nodes) as NodeId[];
  if (ids.length !== Object.keys(before.nodes).length) return "The flattening holds a different set of nodes.";
  for (const id of ids) {
    if (!moved.has(id) && !sameFlattened(after.nodes[id], before.nodes[id])) return `The flattening differs at "${id}", which was not written.`;
  }
  for (const id of moved) {
    if (after.nodes[id] === undefined) return `"${id}" was written and is not in the flattening.`;
    // The node the base read must be the flattening's own, not a timeline override of it.
    if (!sameFlattened(retained.graph.nodes[id], before.nodes[id])) return `The base compiled "${id}" under a structure override.`;
  }

  const readers = valueReadersOf(retained, request.registry);
  const affected = new Set<NodeId>(moved);
  const queue = [...moved];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const reader of readers.get(next) ?? []) {
      if (affected.has(reader)) continue;
      affected.add(reader);
      queue.push(reader);
    }
  }

  const nodes: Record<NodeId, GraphNode> = { ...retained.graph.nodes };
  for (const id of moved) nodes[id] = after.nodes[id] as GraphNode;
  const graph: FlatGraph = { ...retained.graph, nodes };
  const morphs = request.resolution?.morphs ?? request.flattened?.morphs ?? retained.morphs;
  const instances = request.resolution?.instances ?? request.flattened?.instanceChannels;
  const records = new Map(retained.nodes);
  for (const id of moved) {
    const record = records.get(id);
    if (record !== undefined) records.set(id, { ...record, node: nodes[id] as GraphNode });
  }
  const staged: RetainedCompile = { ...retained, request, graph, nodes: records, morphs, instances };

  const rerun = new Set<NodeId>([...affected].filter((id) => records.has(id)));
  const compiler = frameCompilerOver(request, { compiled: base, retained: staged }, rerun);
  if (!compiler.uniformOnly) return compiler.reason ?? "A node that reads the value animates a structural parameter.";
  const capture: RerunCapture = { contexts: new Map(), scene: null, said: new Map() };
  const reading: ParameterResolution = { ...(request.resolution ?? {}), morphs, ...(instances === undefined ? {} : { instances }) };
  const spliced = compiler.compileFrame(reading, capture);
  if (spliced === null) return compiler.reason ?? "A re-run node could not be proven structure-preserving.";
  for (const id of capture.contexts.keys()) {
    if (!rerun.has(id)) return `"${id}" re-ran through a scene payload and was not known to read the value.`;
  }
  for (let index = 0; index < spliced.passes.length; index += 1) {
    const pass = spliced.passes[index] as PassDescriptor;
    if (pass.kind === "loop" && pass !== base.passes[index]) return `The count of loop "${pass.id}" follows the value.`;
  }

  // A node that reads the value and compiles nothing (a control, a lag) still resolves, and
  // may say something: the same call `validateGraph` makes for it.
  const reader = parameterReadOptions({
    graph,
    registry: request.registry,
    frame: undefined,
    channels: reading.channels,
    flattening: flatteningReadsOf(reading),
  });
  for (const id of affected) {
    if (rerun.has(id)) continue;
    const node = nodes[id];
    const definition = node === undefined ? undefined : request.registry.get(node.type);
    if (node === undefined || definition === undefined) continue;
    const said: RuntimeDiagnostic[] = [];
    resolveNodeParameters(node, effectiveParameterSchema(definition, node.parameters), definition.type, said, reader, {
      retained: definition.retainedParameterKeys,
      note: definition.parameterKeysNote,
      otherVersion: node.definitionVersion !== definition.version,
    });
    if (said.length > 0) capture.said.set(id, said);
  }
  const said = new Map(retained.said);
  for (const id of affected) {
    const now = capture.said.get(id);
    if (saidKey(now) !== saidKey(retained.said.get(id))) {
      return `Node "${id}" says something different about its new value, so the revision is compiled in full.`;
    }
    if (now === undefined) said.delete(id);
    else said.set(id, now);
  }

  for (const [id, context] of capture.contexts) {
    const record = records.get(id);
    if (record !== undefined) records.set(id, { ...record, context });
  }
  const rebased: RetainedCompile = { ...staged, scenePayloads: capture.scene ?? retained.scenePayloads, said };
  VALUE_READERS.set(rebased, readers);
  return { compiled: spliced, retained: rebased };
}
