import { z } from "zod";
import type { GraphComponentDefinition } from "../types/components.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument, ProjectDocument, ProjectSettings } from "../types/graph.ts";
import type { ComponentId } from "../types/ids.ts";
import { SCHEMA_VERSION } from "../types/schemas.ts";
import { buildProjectFile, detachComponentLibrary, type ProjectFile } from "../project/project-file.ts";
import { parseProjectDocument, sortKeysDeep } from "../project/serialize.ts";
import { withBoundaryPorts } from "./boundary-ports.ts";
import { componentNodeType, parseComponentNodeType } from "./component-type.ts";
import { renumberedName } from "../graph/names.ts";
import { componentReferences } from "./recursion.ts";
import { defaultPublishedValues } from "./published-parameter.ts";
import { componentLibrarySchema } from "./schemas.ts";

/**
 * ONE COMPONENT AS A FILE, AND THE IDENTITY RULE THAT LETS IT ARRIVE (T1395b, §T962).
 *
 * ## The file is a save, not a new format (§V94)
 *
 * The starter set already ships one component per `.loom.json` (`examples/components/`):
 * a project whose `componentLibrary` carries the component and whose graph instances it.
 * Exporting writes exactly that shape through `buildProjectFile`, the real save path — so
 * an exported component opens as a project too, and a shipped starter file can be dropped
 * on a canvas like any exported one.
 *
 * What makes a file a COMPONENT file rather than a project is structural, not a marker:
 * its library has exactly ONE root — one definition no other definition in the file
 * instances. Everything else in the library is that root's nested dependencies. A project
 * saved by the app carries the whole catalogue (`components.all()`, starters included), so
 * it has many roots and is refused by name rather than half-imported. The host graph is
 * never read on import: it is the demonstration, the library is the payload.
 *
 * ## The identity rule (owner ruling, 2026-09-29)
 *
 * The name an instance addresses a component by is its `componentId` — `component:bloom@1`
 * — so that is the "name" the rule is about.
 *
 *  - same id + version + content as an installed definition → the SAME component: reused,
 *    nothing installed, no duplicate;
 *  - an id nothing installed uses → installed as it is;
 *  - otherwise → imported under a new, unused id, numbered the way every other name in
 *    the app is (`renumberedName`: `bloom` → `bloom1`, display name `Bloom` → `Bloom1`).
 *    Never merged into the installed id's version history, never overwriting it.
 *
 * Applied deepest dependency first, so a renamed nested component rewrites the instance
 * types of everything in the file that pointed at it before THOSE are compared — a parent
 * whose child had to be renamed is no longer identical to the installed parent either,
 * and is renamed in turn.
 *
 * The candidates `bloom1`, `bloom2`… are held to the same rule: a `bloom1` already
 * installed with this version and this (renamed) content IS this component, so dropping
 * the same file twice reuses the first import instead of minting `bloom2`.
 */

/** A component version, as a pair. */
export interface ComponentRef {
  readonly componentId: ComponentId;
  readonly version: number;
}

/** Just enough of the catalogue to plan against. `ComponentRegistryView` satisfies it. */
export interface ComponentCatalogue {
  has(componentId: ComponentId, version?: number): boolean;
  get(componentId: ComponentId, version: number): GraphComponentDefinition | undefined;
}

export const componentImportInputSchema = z.object({
  text: z.string().min(1),
  fileName: z.string().optional(),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
});

export const componentExportInputSchema = z.object({
  componentId: z.string().min(1),
  version: z.number().int().positive().optional(),
});

const refKey = (componentId: ComponentId, version: number): string => `${componentId}@${version}`;

function error(code: string, message: string, suggestion?: string): RuntimeDiagnostic {
  return { severity: "error", code, message, ...(suggestion === undefined ? {} : { suggestion }) };
}

/** Byte-level content identity: the same serialization a save writes, keys sorted. */
function sameContent(a: GraphComponentDefinition, b: GraphComponentDefinition): boolean {
  return JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b));
}

// ---------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------

export type CollectDependenciesResult =
  | { readonly ok: true; readonly definitions: readonly GraphComponentDefinition[] }
  | { readonly ok: false; readonly missing: readonly ComponentRef[] };

/**
 * The root and every component it nests, transitively, deepest first. A nested reference
 * the catalogue cannot answer is reported rather than skipped: a file without it would
 * open everywhere as a placeholder.
 */
export function collectComponentDependencies(
  root: GraphComponentDefinition,
  catalogue: ComponentCatalogue,
): CollectDependenciesResult {
  const ordered: GraphComponentDefinition[] = [];
  const missing: ComponentRef[] = [];
  const seen = new Set<string>();
  const visit = (definition: GraphComponentDefinition): void => {
    seen.add(refKey(definition.componentId, definition.version));
    for (const reference of componentReferences(definition.graph)) {
      const key = refKey(reference.componentId, reference.version);
      if (seen.has(key)) continue;
      const nested = catalogue.get(reference.componentId, reference.version);
      if (nested === undefined) {
        seen.add(key);
        missing.push(reference);
        continue;
      }
      visit(nested);
    }
    ordered.push(definition);
  };
  visit(root);
  return missing.length > 0 ? { ok: false, missing } : { ok: true, definitions: ordered };
}

export interface BuildComponentFileInput {
  readonly root: GraphComponentDefinition;
  /** Root plus its dependencies, as `collectComponentDependencies` returns them. */
  readonly definitions: readonly GraphComponentDefinition[];
  /** The exporting document's settings, so the file opens as a project at the same size. */
  readonly settings: ProjectSettings;
  readonly now?: () => string;
}

/**
 * The bytes of one exported component: its library, and a host graph holding one linked
 * instance so opening the file as a project shows the component rather than nothing.
 */
export function buildComponentFile(input: BuildComponentFileInput): ProjectFile {
  const now = input.now ?? (() => new Date().toISOString());
  const stamp = now();
  const { root } = input;
  const graph: GraphDocument = {
    revision: 1,
    nodes: {
      instance: {
        id: "instance",
        type: componentNodeType(root.componentId, root.version),
        definitionVersion: root.version,
        position: { x: 0, y: 0 },
        parameters: defaultPublishedValues(root),
      },
    },
    edges: {},
    groups: {},
  };
  const document: ProjectDocument = {
    schemaVersion: SCHEMA_VERSION,
    projectId: `component-${root.componentId}`,
    name: root.name,
    settings: input.settings,
    assets: [],
    createdAt: stamp,
    updatedAt: stamp,
    graph,
  };
  return buildProjectFile({ document, components: input.definitions, now: () => stamp });
}

// ---------------------------------------------------------------------------------------
// Import: reading
// ---------------------------------------------------------------------------------------

export type ReadComponentFileResult =
  | {
      readonly ok: true;
      readonly root: GraphComponentDefinition;
      /** Root plus the dependencies it reaches, deepest first; the root is last. */
      readonly definitions: readonly GraphComponentDefinition[];
    }
  | { readonly ok: false; readonly diagnostics: readonly RuntimeDiagnostic[] };

/**
 * Reads a dropped file as ONE component, or refuses it with the reason.
 *
 * Every refusal is total: nothing is returned to install, so a caller cannot half-apply.
 */
export function readComponentFile(text: string, fileName = "The file"): ReadComponentFileResult {
  const label = fileName === "The file" ? fileName : `"${fileName}"`;
  const parsed = parseProjectDocument(text);
  if (!parsed.ok) {
    return {
      ok: false,
      diagnostics: [
        error("component.import.malformed", `${label} is not a readable Loom file: ${parsed.reason}`),
      ],
    };
  }

  const { raw } = detachComponentLibrary(parsed.document);
  if (raw === undefined) {
    return {
      ok: false,
      diagnostics: [
        error(
          "component.import.noComponent",
          `${label} is a project with no component in it, so there is nothing to import.`,
          "Open it as a project instead (File → Open).",
        ),
      ],
    };
  }
  const library = componentLibrarySchema.safeParse(raw);
  if (!library.success) {
    return {
      ok: false,
      diagnostics: [
        error(
          "component.import.malformed",
          `${label} carries a component library that does not read: ${library.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
        ),
      ],
    };
  }

  const definitions = library.data.components as GraphComponentDefinition[];
  const byKey = new Map<string, GraphComponentDefinition>();
  for (const definition of definitions) {
    const key = refKey(definition.componentId, definition.version);
    if (byKey.has(key)) {
      return {
        ok: false,
        diagnostics: [
          error(
            "component.import.malformed",
            `${label} carries ${definition.componentId} v${definition.version} twice.`,
          ),
        ],
      };
    }
    byKey.set(key, definition);
  }
  if (byKey.size === 0) {
    return {
      ok: false,
      diagnostics: [
        error("component.import.noComponent", `${label} carries an empty component library.`),
      ],
    };
  }

  const referenced = new Set<string>();
  for (const definition of definitions) {
    for (const reference of componentReferences(definition.graph)) {
      referenced.add(refKey(reference.componentId, reference.version));
    }
  }
  const roots = definitions.filter(
    (definition) => !referenced.has(refKey(definition.componentId, definition.version)),
  );
  const root = roots[0];
  if (root === undefined || roots.length > 1) {
    return {
      ok: false,
      diagnostics: [
        error(
          "component.import.notAComponent",
          roots.length > 1
            ? `${label} is a whole project carrying ${roots.length} separate components, not one component file.`
            : `${label} has no top-level component: its components only contain each other.`,
          "Open a project with File → Open. A component file is what Export component writes.",
        ),
      ],
    };
  }

  // Deepest first, from the root, refusing a loop (§V83) before anything is planned.
  const ordered: GraphComponentDefinition[] = [];
  const done = new Set<string>();
  const onStack: string[] = [];
  const loop: { cycle: string[] | null } = { cycle: null };
  const visit = (definition: GraphComponentDefinition): void => {
    const key = refKey(definition.componentId, definition.version);
    onStack.push(key);
    for (const reference of componentReferences(definition.graph)) {
      if (loop.cycle !== null) return;
      const nestedKey = refKey(reference.componentId, reference.version);
      const at = onStack.indexOf(nestedKey);
      if (at >= 0) {
        loop.cycle = [...onStack.slice(at), nestedKey];
        return;
      }
      const nested = byKey.get(nestedKey);
      // Not in the file: resolved against the target catalogue when the import is planned.
      if (nested === undefined || done.has(nestedKey)) continue;
      visit(nested);
    }
    onStack.pop();
    done.add(key);
    ordered.push(definition);
  };
  visit(root);
  if (loop.cycle !== null) {
    return {
      ok: false,
      diagnostics: [
        error(
          "component.recursion",
          `${label} is refused: its components contain each other (${loop.cycle.join(" → ")}).`,
          "A component may not contain itself, directly or through another component (§V83).",
        ),
      ],
    };
  }
  return { ok: true, root, definitions: ordered };
}

// ---------------------------------------------------------------------------------------
// Import: planning (the identity rule)
// ---------------------------------------------------------------------------------------

export interface ComponentRename {
  readonly from: ComponentRef;
  readonly to: ComponentRef;
  readonly name: string;
}

export interface ComponentImportPlan {
  /** Definitions to register, deepest first, with ids and references already rewritten. */
  readonly install: readonly GraphComponentDefinition[];
  /** Incoming definitions that ARE an installed one (same id, version and content). */
  readonly reused: readonly ComponentRef[];
  readonly renamed: readonly ComponentRename[];
  /** The root, as the target catalogue will know it. */
  readonly root: GraphComponentDefinition;
  /** References the file needs and neither carries nor finds installed. */
  readonly missing: readonly ComponentRef[];
}

function rewriteReferences(
  definition: GraphComponentDefinition,
  mapped: ReadonlyMap<string, ComponentId>,
): GraphComponentDefinition {
  let nodes: GraphDocument["nodes"] | null = null;
  for (const [nodeId, node] of Object.entries(definition.graph.nodes)) {
    const ref = parseComponentNodeType(node.type);
    if (ref === null) continue;
    const target = mapped.get(refKey(ref.componentId, ref.version));
    if (target === undefined || target === ref.componentId) continue;
    nodes ??= { ...definition.graph.nodes };
    nodes[nodeId] = { ...node, type: componentNodeType(target, ref.version) };
  }
  return nodes === null ? definition : { ...definition, graph: { ...definition.graph, nodes } };
}

const withoutCounter = (text: string): string => text.replace(/[0-9]+$/, "") || text;

/** Applies the identity rule to a read file against the catalogue it is arriving in. */
export function planComponentImport(
  definitions: readonly GraphComponentDefinition[],
  catalogue: ComponentCatalogue,
): ComponentImportPlan {
  const fileKeys = new Set(definitions.map((each) => refKey(each.componentId, each.version)));
  const fileIds = new Set(definitions.map((each) => each.componentId));
  const mapped = new Map<string, ComponentId>();
  const claimed = new Set<ComponentId>();
  const install: GraphComponentDefinition[] = [];
  const reused: ComponentRef[] = [];
  const renamed: ComponentRename[] = [];
  const missing: ComponentRef[] = [];
  let root: GraphComponentDefinition | undefined;

  for (const incoming of definitions) {
    for (const reference of componentReferences(incoming.graph)) {
      const key = refKey(reference.componentId, reference.version);
      if (!fileKeys.has(key) && !catalogue.has(reference.componentId, reference.version)) {
        missing.push(reference);
      }
    }

    const rewritten = rewriteReferences(incoming, mapped);
    const key = refKey(incoming.componentId, incoming.version);
    const installed = catalogue.get(incoming.componentId, incoming.version);

    let placed: GraphComponentDefinition;
    if (installed !== undefined && sameContent(withBoundaryPorts(rewritten), installed)) {
      reused.push({ componentId: incoming.componentId, version: incoming.version });
      placed = installed;
    } else if (!catalogue.has(incoming.componentId)) {
      install.push(rewritten);
      placed = rewritten;
    } else {
      // The app's one numbering rule (`renumberedName`, B41/B44): trailing digits strip to
      // the word and the next free number appends — `bloom` → `bloom1`, `bloom1` → `bloom2`.
      // A candidate is free when nothing claims it OR it already holds this very content (an
      // earlier import of the same file, under the name it was given then — reused below).
      const renamedTo = (candidateId: string): GraphComponentDefinition => ({
        ...rewritten,
        componentId: candidateId,
        name: `${withoutCounter(incoming.name)}${candidateId.slice(withoutCounter(incoming.componentId).length)}`,
      });
      const candidateId = renumberedName(incoming.componentId, (candidate) => {
        if (fileIds.has(candidate) || claimed.has(candidate)) return true;
        if (!catalogue.has(candidate)) return false;
        const existing = catalogue.get(candidate, incoming.version);
        return existing === undefined || !sameContent(withBoundaryPorts(renamedTo(candidate)), existing);
      });
      const existing = catalogue.get(candidateId, incoming.version);
      let chosen: GraphComponentDefinition;
      if (existing !== undefined) {
        reused.push({ componentId: candidateId, version: incoming.version });
        chosen = existing;
      } else {
        chosen = renamedTo(candidateId);
        install.push(chosen);
      }
      renamed.push({
        from: { componentId: incoming.componentId, version: incoming.version },
        to: { componentId: chosen.componentId, version: incoming.version },
        name: chosen.name,
      });
      placed = chosen;
    }
    claimed.add(placed.componentId);
    mapped.set(key, placed.componentId);
    root = placed;
  }

  if (root === undefined) throw new Error("planComponentImport needs at least the root definition");
  return { install, reused, renamed, root, missing };
}
