import type { GraphEdge, GraphNode, ProjectDocument } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { edge as buildEdge, expressionSlot, node as buildNode } from "../../../examples/documents/builders.ts";

/**
 * T1407b (split/mirror) — a PLATE: one shot graph built by `onNothingDocument`, taken apart
 * and re-cut for a composite. The split screen (0:27) is two plates side by side — two sets,
 * two cameras, two lighting states, two grades — so it builds both stock graphs and edits
 * them here instead of growing a second code path through document.ts.
 *
 * Every edit names the node it expects and throws when that node is missing, so a change to
 * document.ts that renames a node breaks these shots loudly instead of silently dropping a
 * light or a camera move.
 */
export class Plate {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();

  constructor(document: ProjectDocument) {
    for (const [id, entry] of Object.entries(document.graph.nodes)) this.nodes.set(id, entry);
    for (const [id, entry] of Object.entries(document.graph.edges)) this.edges.set(id, entry);
  }

  node(id: string): GraphNode {
    const found = this.nodes.get(id);
    if (found === undefined) throw new Error(`plate: no node "${id}" (did document.ts rename it?).`);
    return found;
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  /** Merge parameters into a node; a dotted key (`eye.x`) is a vector component slot. */
  set(id: string, parameters: Record<string, StoredParameter>): void {
    const target = this.node(id);
    this.nodes.set(id, { ...target, parameters: { ...target.parameters, ...parameters } });
  }

  /** Drop every component slot of a vector parameter (`eye` → `eye.x`, `eye.y`, `eye.z`), so a new base value holds. */
  clearSlots(id: string, vector: string): void {
    const target = this.node(id);
    const parameters = Object.fromEntries(Object.entries(target.parameters).filter(([key]) => !key.startsWith(`${vector}.`)));
    this.nodes.set(id, { ...target, parameters });
  }

  add(id: string, type: string, parameters: Record<string, StoredParameter>, extra: Partial<GraphNode> = {}): void {
    if (this.nodes.has(id)) throw new Error(`plate: node "${id}" already exists.`);
    this.nodes.set(id, buildNode(id, type, [0, 0], {}, { ...extra, parameters }));
  }

  connect(id: string, from: readonly [string, string], to: readonly [string, string], order?: number): void {
    this.edges.set(id, buildEdge(id, from, to, order));
  }

  /** Remove nodes and every edge touching them. */
  remove(...ids: string[]): void {
    for (const id of ids) {
      this.node(id);
      this.nodes.delete(id);
    }
    for (const [key, entry] of this.edges) if (ids.includes(entry.source.nodeId) || ids.includes(entry.target.nodeId)) this.edges.delete(key);
  }

  /** The edges that read a node's output port. */
  readersOf(id: string, port = "out"): GraphEdge[] {
    return [...this.edges.values()].filter((entry) => entry.source.nodeId === id && entry.source.portId === port);
  }

  /** The edge that feeds a node's input port. */
  feederOf(id: string, port = "input"): GraphEdge {
    const found = [...this.edges.values()].find((entry) => entry.target.nodeId === id && entry.target.portId === port);
    if (found === undefined) throw new Error(`plate: nothing feeds "${id}.${port}".`);
    return found;
  }

  /**
   * Splice a single-input pass (already added, reading nothing) in right after `after`'s
   * output: every reader of `after` now reads `pass` instead, and `pass` reads `after`.
   */
  spliceAfter(after: string, pass: string, extraInputs: readonly (readonly [string, string])[] = []): void {
    for (const reader of this.readersOf(after)) this.edges.set(reader.id, { ...reader, source: { nodeId: pass, portId: "out" } });
    this.connect(`${after}-${pass}`, [after, "out"], [pass, "input"]);
    extraInputs.forEach((port, index) => this.connect(`${pass}-more${index}`, port, [pass, "more"], index));
  }

  /** Take a pass out of the chain: its readers read what fed it. */
  bypass(id: string): void {
    const feeder = this.feederOf(id);
    for (const reader of this.readersOf(id)) this.edges.set(reader.id, { ...reader, source: feeder.source });
    this.remove(id);
  }

  /** Remove a name from a space-separated name list parameter (a Render's scenes or lights). */
  dropFromList(id: string, parameter: string, label: string): void {
    const list = String(this.node(id).parameters[parameter] ?? "").split(" ").filter((entry) => entry !== "" && entry !== label);
    this.set(id, { [parameter]: list.join(" ") });
  }

  /**
   * Every node and edge, ids and names prefixed so two plates share one graph. A name keeps
   * its kind and takes the prefix on its role (T1593b): `render_shot` is `render_carshot`, and
   * a node named for its kind alone (`camera1`) takes the prefix as its role (`camera_car`).
   * A name is referenced by other nodes (op('camera1') in expressions, a Render's `scenes`, a
   * Feedback's `source`), so every single-line string in every parameter has its name tokens
   * renamed too; multi-line strings are WGSL and are left alone.
   */
  prefixed(prefix: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const names = new Map<string, string>();
    for (const entry of this.nodes.values()) {
      if (entry.label === undefined) continue;
      // the kind is the name up to its first underscore, or all of it but a number
      const at = entry.label.indexOf("_");
      names.set(entry.label, at < 0 ? `${entry.label.replace(/[0-9]+$/, "")}_${prefix}` : `${entry.label.slice(0, at)}_${prefix}${entry.label.slice(at + 1)}`);
    }
    if (new Set(names.values()).size !== names.size) throw new Error(`plate: two nodes would share a name under the prefix "${prefix}" (two numbered nodes of one kind?).`);
    const pattern = names.size === 0 ? undefined : new RegExp(`(?<![A-Za-z0-9_])(${[...names.keys()].sort((a, b) => b.length - a.length).map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![A-Za-z0-9_])`, "g");
    const rename = (value: unknown): unknown => {
      if (typeof value === "string") return pattern === undefined || value.includes("\n") ? value : value.replace(pattern, (name) => names.get(name) ?? name);
      if (Array.isArray(value)) return value.map(rename);
      if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rename(entry)]));
      return value;
    };
    const nodes = [...this.nodes.values()].map((entry): GraphNode => ({
      ...entry,
      id: `${prefix}_${entry.id}`,
      ...(entry.label === undefined ? {} : { label: names.get(entry.label) ?? entry.label }),
      parameters: rename(entry.parameters) as GraphNode["parameters"],
    }));
    const edges = [...this.edges.values()].map((entry): GraphEdge => ({
      ...entry,
      id: `${prefix}_${entry.id}`,
      source: { ...entry.source, nodeId: `${prefix}_${entry.source.nodeId}` },
      target: { ...entry.target, nodeId: `${prefix}_${entry.target.nodeId}` },
    }));
    return { nodes, edges };
  }
}

/**
 * The white limbo's graph (shots/cyc.ts) poses one skin kernel per figure (`skin_<id>`, drawn by
 * `geo_<id>`). Keep the first figure alone — its kernel stripped of the cyc's performance —
 * and return its kernel's id, for a shot that poses the figure itself.
 */
export function soleCycFigure(plate: Plate): string {
  const skins = [...plate.nodes.keys()].filter((id) => id.startsWith("skin_")).sort();
  const kept = skins[0];
  if (kept === undefined) throw new Error("plate: the cyc graph has no skin_ figure (did shots/cyc.ts change?).");
  for (const id of skins.slice(1)) {
    const figure = id.slice("skin_".length);
    plate.remove(id, `geo_${figure}`);
    plate.dropFromList("shot", "scenes", `geometry_${figure}`);
  }
  const skin = plate.node(kept);
  const parameters = Object.fromEntries(Object.entries(skin.parameters).filter(([key]) => ["capacity", "attributes", "kernel"].includes(key)));
  plate.nodes.set(kept, { ...skin, parameters });
  return kept;
}

/**
 * The cyc's key is six jittered directional lights (an area source, a penumbra that widens
 * with distance). A shot that wants ONE hard key keeps the first, aimed its own way, and drops
 * the rest (six shadow maps cost six times one).
 */
export function cycKey(plate: Plate, parameters: Record<string, StoredParameter>): void {
  const keys = [...plate.nodes.keys()].filter((id) => /^key\d+$/.test(id)).sort();
  const first = keys[0];
  if (first === undefined) throw new Error("plate: the cyc graph has no key lights (did shots/cyc.ts change?).");
  for (const id of keys.slice(1)) {
    plate.remove(id);
    plate.dropFromList("shot", "lights", `light_${id}`);
  }
  plate.set(first, parameters);
}

/** A number or an expression slot (a string is an expression over `abstime`). */
export function knob(value: number | string, retained = 0): StoredParameter {
  return typeof value === "number" ? value : expressionSlot(value, retained);
}

/** Three knobs on a vector parameter's component slots. */
export function vectorKnobs(name: string, value: readonly [number | string, number | string, number | string], retained: readonly [number, number, number] = [0, 0, 0]): Record<string, StoredParameter> {
  return {
    [name]: [...retained],
    [`${name}.x`]: knob(value[0], retained[0]),
    [`${name}.y`]: knob(value[1], retained[1]),
    [`${name}.z`]: knob(value[2], retained[2]),
  };
}

/**
 * HANDHELD, as the owner asks for every shot: a sway of three incommensurate sines per axis
 * (it never loops visibly), in metres, and a roll in degrees. `seed` decorrelates plates.
 */
export function wobble(seed: number, amplitude: number): string {
  const a = 0.9 + seed * 0.13;
  return `((sin(abstime * ${(a * 1.0).toFixed(3)} + ${(seed * 1.7).toFixed(2)}) * 0.5 + sin(abstime * ${(a * 2.37).toFixed(3)} + ${(seed * 2.9).toFixed(2)}) * 0.3 + sin(abstime * ${(a * 5.11).toFixed(3)} + ${(seed * 4.3).toFixed(2)}) * 0.2) * ${amplitude})`;
}

/** smoothstep(e0, e1, x) spelled in the expression language (which has no smoothstep). */
export function smooth(e0: number, e1: number, x: string): string {
  const c = `clamp((${x} - ${e0}) / ${e1 - e0}, 0, 1)`;
  return `(${c} * ${c} * (3 - 2 * ${c}))`;
}
