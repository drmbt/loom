/**
 * Node parameters whose value is a NAME (or a LIST of names) resolving to other nodes
 * (T350 for feedback; T447 generalized it for the scene family).
 *
 * Feedback names the node it records instead of taking a wired back-edge, so `edges`
 * stays a DAG. T447 extends the same mechanism to scene assembly — a Render names its
 * camera, lights and geometries; a Geometry names its material — on the owner's ruling
 * that many-object scenes are the NORMAL case and twenty wires converging on one node
 * is the shape that does not survive real use.
 *
 * THE COMPILER STILL WORKS ON EDGES: every reference is resolved into a SYNTHESIZED
 * edge before validation (compile.ts), so payload propagation, ordering and the whole
 * pass machinery never learn that names exist. References are the AUTHORING surface;
 * ports are the plumbing. Scene-reference inputs are declared as real (connect-refused)
 * ports on the definitions.
 *
 * LISTS, NOT PATTERNS, deliberately: a pattern (`geo*`) is a QUERY, not a reference —
 * a rename moves nodes silently in and out of its match set, which is the V320
 * silent-misbind class made into a feature. V128 requires that a rename rewrites every
 * stored reference; only explicit names can honour that. List order is DRAW/LIGHT
 * order — user-stated, deterministic.
 *
 * WHY A TABLE, when definitions also declare it: the document-side consumers — the
 * dependency walk, liveness, the rename rewrite — run where the catalogue must not be
 * imported. The definition stays the declaration of record; `index.test.ts` pins the
 * two to each other in both directions.
 *
 * ## A WIRE AS WELL AS A NAME (B233) — opt-in, and the wire wins
 *
 * A reference input refuses a wire for a REASON, and the reason differs by family. A
 * Feedback's source is a name so that `edges` stays a DAG (§V285). A scene's camera,
 * lights, material and geometries are names because scene ASSEMBLY flows by name (§V372).
 * Neither reason applies to a Window Out's input or a Layer's picture: those carry a
 * TEXTURE — "GPU data flows on wires", the first half of that same invariant — and the
 * name was ADDED to them as a convenience (the owner ruled both, §T1391b and ruling 11).
 * So `wire: true` is per input, never the default, and only those two declare it.
 *
 * For such an input both a wire and a name can be present, and the rule is stated once,
 * in `liveSourceReferenceTokens` below: THE WIRE WINS and the name is DORMANT. Dormant
 * means it stays written (a rename still rewrites it, and disconnecting returns to it)
 * but it resolves to no edge, is no dependency, and draws no line. Every reader that asks
 * "what does this node depend on by name" — the compiler's synthesis, the dependency walk
 * the canvas draws and the cycle gate checks, liveness — reads through that one function,
 * so they cannot disagree about a dormant name (§V109).
 *
 * Why the name is kept rather than cleared by the connect: the compiler has to define
 * "both present" regardless, because a loaded file, a paste and a raw patch can all
 * arrive with both; a connect that also rewrote a parameter would be a second mechanism
 * for the bus alone, with a mirror needed on every write of the name.
 */
export interface SourceReferenceSpec {
  /** The parameter carrying the name(s) (§V129 — names are identifiers). */
  readonly parameter: string;
  /** The input port the synthesized edge(s) feed. */
  readonly input: string;
  /** True: the parameter holds a whitespace/comma-separated LIST of names. */
  readonly list?: boolean;
  /**
   * B233: the input ALSO takes a wire (`connect` allowed, a socket drawn), and a wire on
   * it makes the name dormant. Absent: name only — the wire is refused and no socket
   * renders (§V285, §V372, §V387).
   */
  readonly wire?: boolean;
}

export const SOURCE_REFERENCE_PARAMETERS: Readonly<Record<string, ReadonlyArray<SourceReferenceSpec>>> = {
  feedback: [{ parameter: "source", input: "in" }],
  geometry: [{ parameter: "material", input: "material" }],
  // T1598b: a casting light names the geometries that cast for it, and those that do not.
  light: [
    { parameter: "shadowCasters", input: "shadowCasters", list: true },
    { parameter: "shadowExclude", input: "shadowExclude", list: true },
  ],
  render: [
    { parameter: "scenes", input: "scenes", list: true },
    { parameter: "camera", input: "camera" },
    { parameter: "lights", input: "lights", list: true },
    // T704: projectors reference exactly as lights do.
    { parameter: "projectors", input: "projectors", list: true },
  ],
  // T457 (V387): the point renderers share the SAME camera-by-name model as Render —
  // one camera node can frame instances, a surface and a scene render at once.
  renderSurface: [{ parameter: "camera", input: "camera" }],
  renderInstances: [{ parameter: "camera", input: "camera" }],
  // T1421b: Camera Blur names the camera whose motion it smears, as the renderers do.
  cameraBlur: [{ parameter: "camera", input: "camera" }],
  // §T1391b: a Window Out shows a node by name as well as by wire (the owner's ruling).
  window: [{ parameter: "source", input: "input", wire: true }],
  // T1498b: a Layer shows its picture by name as well as by wire, so only the named look cooks.
  layer: [{ parameter: "picture", input: "picture", wire: true }],
};

export function sourceReferencesOf(nodeType: string): ReadonlyArray<SourceReferenceSpec> {
  return SOURCE_REFERENCE_PARAMETERS[nodeType] ?? [];
}

/** The spec whose synthesized edges land on `input`, when the type has one. */
export function sourceReferenceForInput(nodeType: string, input: string): SourceReferenceSpec | undefined {
  return sourceReferencesOf(nodeType).find((spec) => spec.input === input);
}

/**
 * The stored NAMES of one spec, in list order. A plain string only — a slot here would
 * mean someone tried to animate an identity — split on whitespace/commas for a list
 * spec, whole-and-trimmed for a single one. Empty when nothing is written.
 */
export function sourceReferenceTokens(
  spec: SourceReferenceSpec,
  parameters: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> {
  const stored = parameters[spec.parameter];
  if (typeof stored !== "string") return [];
  if (spec.list === true) {
    return stored.split(/[\s,]+/).filter((token) => token !== "");
  }
  const trimmed = stored.trim();
  return trimmed === "" ? [] : [trimmed];
}

/**
 * True when `input` is fed by a name and ONLY by a name: `connect` refuses a wire into it
 * and the canvas draws no socket for it (§V387 — a socket exists exactly where a wire is
 * accepted). False for an ordinary input and for a `wire: true` reference input (B233).
 */
export function isNameOnlyInput(nodeType: string, input: string): boolean {
  const spec = sourceReferenceForInput(nodeType, input);
  return spec !== undefined && spec.wire !== true;
}

/** The node fields and the edge record the wire-or-name rule reads. */
interface ReferencingNode {
  readonly id: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}
interface ReferenceEdge {
  readonly source: { readonly nodeId: string };
  readonly target: { readonly nodeId: string; readonly portId: string };
}

/**
 * The wire that overrides a `wire: true` spec's name on this node, when there is one
 * (B233). Always `undefined` for a name-only spec: a wire there is not an override, it is
 * the ambiguity the compiler refuses.
 */
export function overridingWire<Edge extends ReferenceEdge>(
  spec: SourceReferenceSpec,
  nodeId: string,
  edges: Readonly<Record<string, Edge>>,
): Edge | undefined {
  if (spec.wire !== true) return undefined;
  for (const edgeId of Object.keys(edges)) {
    const edge = edges[edgeId];
    if (edge !== undefined && edge.target.nodeId === nodeId && edge.target.portId === spec.input) return edge;
  }
  return undefined;
}

/**
 * THE WIRE-OR-NAME RULE (B233): the names of one spec that are LIVE in this document.
 *
 * `sourceReferenceTokens`, except that a `wire: true` input with a wire on it answers
 * nothing — the wire wins and the name is dormant. Use this wherever a name is followed
 * to a node (synthesis, dependencies, liveness); use `sourceReferenceTokens` only where
 * the WRITTEN text matters (the rename rewrite, the inspector's field).
 */
export function liveSourceReferenceTokens(
  spec: SourceReferenceSpec,
  node: ReferencingNode,
  edges: Readonly<Record<string, ReferenceEdge>>,
): ReadonlyArray<string> {
  const tokens = sourceReferenceTokens(spec, node.parameters);
  if (tokens.length === 0) return tokens;
  return overridingWire(spec, node.id, edges) === undefined ? tokens : [];
}

/** Every LIVE referenced name across every spec of the node, deduplicated, in spec order. */
export function sourceReferenceNames(
  node: ReferencingNode & { readonly type: string },
  edges: Readonly<Record<string, ReferenceEdge>>,
): ReadonlyArray<string> {
  const names: string[] = [];
  for (const spec of sourceReferencesOf(node.type)) {
    for (const token of liveSourceReferenceTokens(spec, node, edges)) {
      if (!names.includes(token)) names.push(token);
    }
  }
  return names;
}

/**
 * The T350 shape, kept for feedback's single-name consumers (the loader migration and
 * liveness read it). Answers the FIRST single-name spec only.
 */
export function sourceReferenceOf(nodeType: string): SourceReferenceSpec | undefined {
  return sourceReferencesOf(nodeType).find((spec) => spec.list !== true);
}

/** The stored name of the type's single-name spec, when one is written (T350 shape). */
export function sourceReferenceName(
  nodeType: string,
  parameters: Readonly<Record<string, unknown>>,
): string | undefined {
  const spec = sourceReferenceOf(nodeType);
  if (spec === undefined) return undefined;
  return sourceReferenceTokens(spec, parameters)[0];
}
