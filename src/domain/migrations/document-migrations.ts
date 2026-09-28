import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import { SCHEMA_VERSION } from "../types/schemas.ts";
import type { AppliedMigration, DocumentMigration, RawDocument } from "./types.ts";
import { channelExpression } from "../parameters/slots.ts";
import { parseComponentNodeType } from "../components/component-type.ts";
import { COMPONENT_OVERRIDES_STATE_KEY } from "../components/instance.ts";

/**
 * The document-level migration ladder (T43, §V10).
 *
 * Empty at `schemaVersion: 1` — there is nothing before version 1 to come from. It is
 * wired up anyway, and exercised by tests with synthetic steps, because the moment the
 * first real step is needed there will already be `.loom.json` files in the wild: the
 * scaffolding has to exist BEFORE it is needed, not after.
 *
 * Adding a step: append `{ from: N, to: N + 1, description, migrate }` here and raise
 * `SCHEMA_VERSION`. The ladder is checked for integrity (no gap, no duplicate `from`, no
 * step that goes backwards) every time it runs, so a mistake surfaces as a refused load
 * with a named reason rather than as a document that is half in one version and half in
 * the next.
 */

/** Nodes of a raw document, or an empty object when the shape is not what we expect. */
function rawNodes(document: RawDocument): Record<string, Record<string, unknown>> {
  const graph = document["graph"];
  if (typeof graph !== "object" || graph === null) return {};
  const nodes = (graph as Record<string, unknown>)["nodes"];
  if (typeof nodes !== "object" || nodes === null) return {};
  return nodes as Record<string, Record<string, unknown>>;
}

/**
 * 1 → 2: `ui.preview` was the PIN and is now the SWITCH (T353, §V297).
 *
 * The field kept its name and changed its meaning, which is the one shape a migration
 * genuinely has to exist for. Read literally, an old document says the wrong thing in
 * BOTH directions:
 *
 *  - `preview: true` meant "pinned — keep previewing when scrolled off". Read as the
 *    switch it means "on", which is the default anyway, so the pin would be silently lost.
 *  - `preview: false` meant "not pinned", which is also the default. Read as the switch it
 *    means OFF — so every node the user ever pinned and unpinned would load with its
 *    preview disabled, showing a dark slot for a choice nobody made. That is the failure
 *    that would actually be reported, and it is why this cannot be left to "the new
 *    default is fine".
 *
 * So: the truth moves to `previewPinned`, and the switch is left ABSENT, which is on. No
 * document written before today has an opinion about the switch, and this refuses to
 * invent one.
 */
const previewPinBecomesSwitch: DocumentMigration = {
  from: 1,
  to: 2,
  description: "Node preview flag split: the old pin became `previewPinned`, and `preview` is now the on/off switch.",
  migrate(document) {
    for (const node of Object.values(rawNodes(document))) {
      const ui = node["ui"];
      if (typeof ui !== "object" || ui === null) continue;
      const flags = ui as Record<string, unknown>;
      if (!("preview" in flags)) continue;
      if (flags["preview"] === true) flags["previewPinned"] = true;
      delete flags["preview"];
    }
    return document;
  },
};

function rawEdges(document: RawDocument): Record<string, Record<string, unknown>> {
  const graph = document["graph"];
  if (typeof graph !== "object" || graph === null) return {};
  const edges = (graph as Record<string, unknown>)["edges"];
  if (typeof edges !== "object" || edges === null) return {};
  return edges as Record<string, Record<string, unknown>>;
}

/**
 * 2 → 3 (T350, §V285): feedback loops stop being WIRED. A feedback node's `in` edge
 * becomes a `source` parameter naming the source node, and the edge is deleted —
 * `edges` is a DAG from here on, and the loop the user sees is the dashed reference.
 *
 * The name written is the node's effective name (its label, or the auto-number the
 * name derivation assigns) — the same currency driven channels and op() use (§V129).
 * The compiler synthesizes the identical edge back at compile time, so a converted
 * document's PLAN is byte-identical to the wired one's; the equivalence test pins it.
 */
const feedbackLoopBecomesReference: DocumentMigration = {
  from: 2,
  to: 3,
  description: "Feedback takes its source by NAME: the wired in-edge becomes the `source` parameter.",
  migrate(document) {
    const nodes = rawNodes(document);
    const edges = rawEdges(document);
    for (const [edgeId, edge] of Object.entries(edges)) {
      const target = edge["target"] as { nodeId?: string; portId?: string } | undefined;
      if (target?.portId !== "in") continue;
      const targetNode = nodes[target.nodeId ?? ""];
      if (targetNode?.["type"] !== "feedback") continue;
      const source = edge["source"] as { nodeId?: string } | undefined;
      const sourceNode = nodes[source?.nodeId ?? ""];
      if (sourceNode === undefined) continue;
      const name = effectiveName(nodes, source?.nodeId ?? "");
      if (name === undefined) continue;
      const parameters = (targetNode["parameters"] ?? {}) as Record<string, unknown>;
      parameters["source"] = name;
      targetNode["parameters"] = parameters;
      delete edges[edgeId];
    }
    return document;
  },
};

/**
 * The source node's NAME — its label, or one this migration ASSIGNS. Names are labels
 * and nothing else (`nodeNames` in names.ts): an unlabeled node has NO name, so a
 * reference to a derived-but-unwritten name would dangle at compile. Assigning the
 * label makes the name real, the way creating the node in the editor would have.
 */
function effectiveName(
  nodes: Record<string, Record<string, unknown>>,
  nodeId: string,
): string | undefined {
  const node = nodes[nodeId];
  if (node === undefined) return undefined;
  const label = node["label"];
  if (typeof label === "string" && label.trim() !== "") return label.trim();
  const type = node["type"];
  if (typeof type !== "string") return undefined;
  const taken = new Set(
    Object.values(nodes)
      .map((entry) => entry["label"])
      .filter((value): value is string => typeof value === "string"),
  );
  for (let index = 1; ; index += 1) {
    const candidate = `${type}${index}`;
    if (!taken.has(candidate)) {
      node["label"] = candidate;
      return candidate;
    }
  }
}

/**
 * 3 → 4 (§T1390b, §V1026): a wire no longer carries ONE channel of its source's bag.
 *
 * §T1350b let an edge name a channel (`edge.channel`), written by dragging from a socket
 * per channel on the source card. The owner ruled that out — *"we never want to have an
 * explosion of sockets … the select node should handle the rest"* — so the sockets went,
 * and a narrowing that lives invisibly on a wire goes with them. Each such edge becomes
 * what it always meant: the whole bag into a `valueSelect` whose Channels is that one
 * name, and the Select into the original target. One Select per (source, port, channel),
 * shared by every wire that picked the same channel, so ten wires from `band109` are one
 * node, not ten. The Select publishes `{ [channel]: value }`, exactly what the narrowed
 * wire delivered. One difference remains, stated rather than hidden: when the source does
 * not publish that channel this frame, the narrowed wire read as UNWIRED, while the Select
 * publishes an empty bag — which a `valueSwitch` counts as a connected branch (T541).
 *
 * The same rewrite runs over every component definition's internal graph, and a published
 * string parameter that writes a `valueSelect`'s Channels gains the `channelsFrom` of the
 * component input that feeds that Select — so an AudioAnalysis embedded before §T1390b
 * shows its Levels and Hits as pickers without being re-instantiated.
 */
const channelEdgeBecomesSelect: DocumentMigration = {
  from: 3,
  to: 4,
  description: "A wire that carried one channel becomes the whole bag into a Select naming that channel.",
  migrate(document) {
    rewriteChannelEdges(document["graph"]);
    const library = document["componentLibrary"];
    const components = typeof library === "object" && library !== null ? (library as Record<string, unknown>)["components"] : undefined;
    if (Array.isArray(components)) {
      for (const component of components) {
        if (typeof component !== "object" || component === null) continue;
        rewriteChannelEdges((component as Record<string, unknown>)["graph"]);
        declareChannelSources(component as Record<string, unknown>);
      }
    }
    return document;
  },
};

type RawRecord = Record<string, unknown>;

function recordOf(value: unknown): RawRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RawRecord) : undefined;
}

function rewriteChannelEdges(graphValue: unknown): void {
  const graph = recordOf(graphValue);
  const nodes = recordOf(graph?.["nodes"]) as Record<string, RawRecord> | undefined;
  const edges = recordOf(graph?.["edges"]) as Record<string, RawRecord> | undefined;
  if (nodes === undefined || edges === undefined) return;
  const selects = new Map<string, string>();
  const freshId = (base: string, taken: Record<string, unknown>): string => {
    if (!(base in taken)) return base;
    for (let index = 2; ; index += 1) if (!(`${base}${index}` in taken)) return `${base}${index}`;
  };
  for (const edge of Object.values(edges)) {
    const channel = edge["channel"];
    if (typeof channel !== "string") continue;
    const source = recordOf(edge["source"]);
    const sourceId = typeof source?.["nodeId"] === "string" ? source["nodeId"] : undefined;
    const sourcePort = typeof source?.["portId"] === "string" ? source["portId"] : undefined;
    delete edge["channel"];
    if (sourceId === undefined || sourcePort === undefined) continue;
    const key = `${sourceId}\u0000${sourcePort}\u0000${channel}`;
    let selectId = selects.get(key);
    if (selectId === undefined) {
      selectId = freshId(`${sourceId}-${channel}`, nodes);
      const at = recordOf(nodes[sourceId]?.["position"]);
      const x = typeof at?.["x"] === "number" ? at["x"] : 0;
      const y = typeof at?.["y"] === "number" ? at["y"] : 0;
      nodes[selectId] = {
        id: selectId,
        type: "valueSelect",
        definitionVersion: 1,
        position: { x: x + 160, y: y + 40 * selects.size },
        parameters: { channels: channel },
      };
      const feedId = freshId(`${selectId}-in`, edges);
      edges[feedId] = {
        id: feedId,
        source: { nodeId: sourceId, portId: sourcePort },
        target: { nodeId: selectId, portId: "in" },
      };
      selects.set(key, selectId);
    }
    edge["source"] = { nodeId: selectId, portId: "out" };
  }
}

function declareChannelSources(component: RawRecord): void {
  const graph = recordOf(component["graph"]);
  const nodes = recordOf(graph?.["nodes"]) as Record<string, RawRecord> | undefined;
  const edges = recordOf(graph?.["edges"]) as Record<string, RawRecord> | undefined;
  const inputs = component["inputs"];
  const parameters = component["parameters"];
  if (nodes === undefined || edges === undefined || !Array.isArray(inputs) || !Array.isArray(parameters)) return;
  const inputFeeding = (nodeId: string): string | undefined => {
    for (const edge of Object.values(edges)) {
      const target = recordOf(edge["target"]);
      if (target?.["nodeId"] !== nodeId || target["portId"] !== "in") continue;
      const from = recordOf(edge["source"])?.["nodeId"];
      const exposed = inputs.map(recordOf).find((entry) => entry?.["nodeId"] === from);
      return typeof exposed?.["externalId"] === "string" ? exposed["externalId"] : undefined;
    }
    return undefined;
  };
  for (const published of parameters.map(recordOf)) {
    const definition = recordOf(published?.["definition"]);
    const targets = published?.["targets"];
    if (definition?.["type"] !== "string" || "channelsFrom" in definition || !Array.isArray(targets) || targets.length === 0) continue;
    const feeds = new Set<string | undefined>();
    for (const target of targets.map(recordOf)) {
      const nodeId = typeof target?.["nodeId"] === "string" ? target["nodeId"] : "";
      feeds.add(nodes[nodeId]?.["type"] === "valueSelect" && target?.["key"] === "channels" ? inputFeeding(nodeId) : undefined);
    }
    const [only] = feeds;
    if (feeds.size === 1 && only !== undefined) definition["channelsFrom"] = only;
  }
}

/**
 * 4 → 5 (§T1433b): camera ROLL turns right-handed, as in Blender and three.js.
 *
 * Before schema 5 a positive roll turned the camera clockwise as seen from behind it; the
 * owner ruled for the convention every DCC tool uses, where it turns counter-clockwise. The
 * engine flipped, so every stored roll is NEGATED here and a saved document frames exactly
 * what it framed before. The nodes that carry a roll: Camera, Projector (their shared rolled
 * up-vector) and CRT Tube (its macro camera follows the Camera's sign).
 *
 * What "negated" means for each way a roll can be stored:
 *  - a number: its negative (0 stays 0);
 *  - a slot's static binding: its negative; an EXPRESSION binding is WRAPPED, `-(expr)`
 *    (an expression cannot be negated by value, and the wrap is exact — IEEE negation);
 *  - a retired `driven` binding becomes the negated channel read, `-(op('x').chan.y)` —
 *    exactly what the §T897 load upgrade would have written, negated;
 *  - a `bind` binding is LEFT: it names another parameter, which is not a roll, and there is
 *    nothing to negate without changing what it points at. (No shipped document binds a roll.)
 * Every expression anywhere in the same graph that READS such a node's roll by reference,
 * `op('cam1').par.roll`, is wrapped `(-op('cam1').par.roll)`, so a streak turned with the
 * camera keeps turning the way it did. The same rewrite runs over every embedded component's
 * graph; a published parameter whose every target is such a roll has its default negated, and
 * so does every instance's value for it and every instance override of an internal roll.
 */
const ROLL_NODE_TYPES: ReadonlySet<string> = new Set(["camera", "projector", "crtTube"]);

function negateRollValue(value: unknown): unknown {
  if (typeof value === "number") return value === 0 ? 0 : -value;
  const slot = recordOf(value);
  const bindings = recordOf(slot?.["bindings"]);
  if (slot === undefined || bindings === undefined) return value;
  const statics = recordOf(bindings["static"]);
  if (statics !== undefined && typeof statics["value"] === "number") statics["value"] = statics["value"] === 0 ? 0 : -statics["value"];
  const expression = recordOf(bindings["expression"]);
  if (expression !== undefined && typeof expression["source"] === "string") expression["source"] = `-(${expression["source"]})`;
  const driven = recordOf(bindings["driven"]);
  if (driven !== undefined && typeof driven["channel"] === "string") {
    const read = `-(${channelExpression(driven["channel"])})`;
    delete bindings["driven"];
    if (slot["mode"] === "driven") {
      bindings["expression"] = { kind: "expression", source: read };
      slot["mode"] = "expression";
    } else if (expression === undefined) {
      bindings["expression"] = { kind: "expression", source: read };
    }
  }
  return value;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Negates the rolls of one graph's roll-carrying nodes; returns their ids. */
function negateGraphRolls(graphValue: unknown): Set<string> {
  const graph = recordOf(graphValue);
  const nodes = recordOf(graph?.["nodes"]) as Record<string, RawRecord> | undefined;
  const rolled = new Set<string>();
  if (nodes === undefined) return rolled;
  const names: string[] = [];
  for (const [id, node] of Object.entries(nodes)) {
    if (!ROLL_NODE_TYPES.has(String(node["type"]))) continue;
    rolled.add(id);
    const parameters = recordOf(node["parameters"]);
    if (parameters !== undefined && "roll" in parameters) parameters["roll"] = negateRollValue(parameters["roll"]);
    if (typeof node["label"] === "string" && node["label"].trim() !== "") names.push(node["label"].trim());
  }
  if (names.length === 0) return rolled;
  // Every reader of those rolls, by reference: `op('name').par.roll` → `(-op('name').par.roll)`.
  const reader = new RegExp(`op\\((['"])(${names.map(escapeRegExp).join("|")})\\1\\)\\.par\\.roll\\b`, "g");
  for (const node of Object.values(nodes)) {
    const parameters = recordOf(node["parameters"]);
    if (parameters === undefined) continue;
    for (const stored of Object.values(parameters)) {
      const expression = recordOf(recordOf(recordOf(stored)?.["bindings"])?.["expression"]);
      if (expression === undefined || typeof expression["source"] !== "string") continue;
      expression["source"] = expression["source"].replace(reader, (match) => `(-${match})`);
    }
  }
  return rolled;
}

const rollTurnsRightHanded: DocumentMigration = {
  from: 4,
  to: 5,
  description: "Camera roll turns right-handed (as in Blender and three.js): every stored roll is negated, so each shot frames as it did.",
  migrate(document) {
    const library = recordOf(document["componentLibrary"]);
    const components = Array.isArray(library?.["components"]) ? (library["components"] as unknown[]).map(recordOf) : [];
    // Per component: which published parameters are wholly rolls, and which internal nodes roll.
    const rolledParameters = new Map<string, Set<string>>();
    const rolledInternals = new Map<string, Set<string>>();
    for (const component of components) {
      if (component === undefined) continue;
      const id = String(component["componentId"]);
      const internal = negateGraphRolls(component["graph"]);
      rolledInternals.set(id, internal);
      const published = new Set<string>();
      for (const parameter of Array.isArray(component["parameters"]) ? component["parameters"].map(recordOf) : []) {
        const targets = Array.isArray(parameter?.["targets"]) ? (parameter["targets"] as unknown[]).map(recordOf) : [];
        if (parameter === undefined || targets.length === 0) continue;
        if (!targets.every((target) => target?.["key"] === "roll" && internal.has(String(target["nodeId"])))) continue;
        published.add(String(parameter["key"]));
        const definition = recordOf(parameter["definition"]);
        if (definition !== undefined && typeof definition["default"] === "number") definition["default"] = negateRollValue(definition["default"]);
      }
      rolledParameters.set(id, published);
    }
    const instancesIn = (graphValue: unknown): void => {
      const nodes = recordOf(recordOf(graphValue)?.["nodes"]) as Record<string, RawRecord> | undefined;
      for (const node of Object.values(nodes ?? {})) {
        const ref = parseComponentNodeType(String(node["type"]));
        if (ref === null) continue;
        const parameters = recordOf(node["parameters"]);
        for (const key of rolledParameters.get(ref.componentId) ?? []) {
          if (parameters !== undefined && key in parameters) parameters[key] = negateRollValue(parameters[key]);
        }
        const overrides = recordOf(recordOf(node["state"])?.[COMPONENT_OVERRIDES_STATE_KEY]);
        for (const internalId of rolledInternals.get(ref.componentId) ?? []) {
          const path = `${internalId}/roll`;
          if (overrides !== undefined && path in overrides) overrides[path] = negateRollValue(overrides[path]);
        }
      }
    };
    negateGraphRolls(document["graph"]);
    instancesIn(document["graph"]);
    for (const component of components) instancesIn(component?.["graph"]);
    return document;
  },
};

export const DOCUMENT_MIGRATIONS: readonly DocumentMigration[] = [
  previewPinBecomesSwitch,
  feedbackLoopBecomesReference,
  channelEdgeBecomesSelect,
  rollTurnsRightHanded,
];

export interface MigrateDocumentOptions {
  migrations?: readonly DocumentMigration[];
  /** The version this build writes. Defaults to `SCHEMA_VERSION`. */
  targetVersion?: number;
}

export type MigrateDocumentResult =
  | {
      ok: true;
      document: RawDocument;
      fromVersion: number;
      applied: readonly AppliedMigration[];
      /**
       * The file was written by a LATER build than this one. Not an error: §V68 says such
       * a document loads and keeps what this build does not understand.
       */
      newerThanApp: boolean;
      diagnostics: RuntimeDiagnostic[];
    }
  | { ok: false; reason: string; diagnostics: RuntimeDiagnostic[] };

/**
 * Structural check on the ladder itself, independent of any document.
 *
 * Run separately by the migration test so a broken ladder is caught by the suite rather
 * than by the first user who opens an old file.
 */
export function validateMigrationLadder(
  migrations: readonly DocumentMigration[],
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  const seen = new Set<number>();
  for (const migration of migrations) {
    if (!Number.isInteger(migration.from) || !Number.isInteger(migration.to)) {
      diagnostics.push({
        severity: "error",
        code: "project.migration.malformed",
        message: `Migration "${migration.description}" has a non-integer version (${migration.from} → ${migration.to}).`,
      });
      continue;
    }
    if (migration.to <= migration.from) {
      diagnostics.push({
        severity: "error",
        code: "project.migration.backwards",
        message: `Migration "${migration.description}" does not move forwards (${migration.from} → ${migration.to}).`,
      });
    }
    if (seen.has(migration.from)) {
      diagnostics.push({
        severity: "error",
        code: "project.migration.duplicate",
        message: `Two migrations both start at schemaVersion ${migration.from}; the order they run in would be arbitrary.`,
      });
    }
    seen.add(migration.from);
  }
  return diagnostics;
}

/**
 * Walks a raw document from its own `schemaVersion` up to `targetVersion`.
 *
 * Nothing is adopted unless the WHOLE chain succeeds: the walk runs on a private deep
 * clone and the clone is only returned on success, so a missing step or a throwing step
 * leaves the caller with the original file and a reason, never with a document that had
 * two of three steps applied to it.
 */
export function migrateProjectDocument(
  raw: unknown,
  options: MigrateDocumentOptions = {},
): MigrateDocumentResult {
  const migrations = options.migrations ?? DOCUMENT_MIGRATIONS;
  const targetVersion = options.targetVersion ?? SCHEMA_VERSION;
  const diagnostics: RuntimeDiagnostic[] = [];

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("The file does not contain a project object.", "project.parse.notAnObject", diagnostics);
  }

  const source = raw as RawDocument;
  const fromVersion = source["schemaVersion"];
  if (typeof fromVersion !== "number" || !Number.isInteger(fromVersion) || fromVersion < 1) {
    return fail(
      "The file has no usable schemaVersion, so there is no way to know which migrations it needs.",
      "project.migration.noVersion",
      diagnostics,
    );
  }

  const ladderIssues = validateMigrationLadder(migrations);
  if (ladderIssues.length > 0) {
    diagnostics.push(...ladderIssues);
    return {
      ok: false,
      reason: `The migration ladder is broken: ${ladderIssues.map((issue) => issue.message).join(" ")}`,
      diagnostics,
    };
  }

  // §V68: a file from a newer build is loaded as-is and everything unrecognised is kept.
  // Downgrading it is not possible and refusing it would lose the user's work.
  if (fromVersion > targetVersion) {
    diagnostics.push({
      severity: "warning",
      code: "project.schema.newer",
      message: `This project was saved by a newer version of Loom (schema ${fromVersion}, this build writes ${targetVersion}).`,
      suggestion: "Anything this build does not understand is kept as-is and written back on save (§V68).",
    });
    return {
      ok: true,
      document: structuredClone(source),
      fromVersion,
      applied: [],
      newerThanApp: true,
      diagnostics,
    };
  }

  let document = structuredClone(source);
  const applied: AppliedMigration[] = [];
  let at = fromVersion;
  while (at < targetVersion) {
    const step = migrations.find((migration) => migration.from === at);
    if (step === undefined) {
      return fail(
        `No migration from schemaVersion ${at} to ${at + 1}; this project cannot be upgraded to ${targetVersion} safely.`,
        "project.migration.missing",
        diagnostics,
      );
    }
    try {
      document = step.migrate(document);
    } catch (error) {
      return fail(
        `Migration ${step.from} → ${step.to} ("${step.description}") failed: ${describeError(error)}`,
        "project.migration.failed",
        diagnostics,
      );
    }
    if (document === null || typeof document !== "object" || Array.isArray(document)) {
      return fail(
        `Migration ${step.from} → ${step.to} ("${step.description}") did not return a document object.`,
        "project.migration.failed",
        diagnostics,
      );
    }
    document["schemaVersion"] = step.to;
    applied.push({ from: step.from, to: step.to, description: step.description });
    at = step.to;
  }

  for (const step of applied) {
    diagnostics.push({
      severity: "info",
      code: "project.migration.applied",
      message: `Upgraded schema ${step.from} → ${step.to}: ${step.description}`,
    });
  }

  return { ok: true, document, fromVersion, applied, newerThanApp: false, diagnostics };
}

function fail(reason: string, code: string, diagnostics: RuntimeDiagnostic[]): MigrateDocumentResult {
  diagnostics.push({ severity: "error", code, message: reason });
  return { ok: false, reason, diagnostics };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
