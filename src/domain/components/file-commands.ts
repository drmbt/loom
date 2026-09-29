import type { GraphComponentDefinition } from "../types/components.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { ComponentId, NodeId } from "../types/ids.ts";
import type { CommandOutcome, LoomBus } from "../commands/bus.ts";
import type { ProjectFile } from "../project/project-file.ts";
import {
  buildComponentFile,
  collectComponentDependencies,
  componentExportInputSchema,
  componentImportInputSchema,
  planComponentImport,
  readComponentFile,
  type ComponentRef,
  type ComponentRename,
} from "./component-file.ts";
import { componentNodeType } from "./component-type.ts";
import { defaultPublishedValues } from "./published-parameter.ts";
import { describeRecursion, detectComponentRecursion, wouldRecurse } from "./recursion.ts";
import type { ComponentGraphSource } from "./recursion.ts";
import { ComponentDefinitionError, createComponentSystem } from "./registry.ts";
import type { ComponentRegistry } from "./registry.ts";

/**
 * `component.import` and `component.export` (T1395b): one component crossing a document
 * boundary as a file. The file shape and the identity rule are `component-file.ts`'s; this
 * is the bus half.
 *
 * IMPORT is a graph command AND a catalogue command, and it is atomic across both: the
 * whole plan — every definition it would install and the instance it would place — is
 * validated before anything is written. A refused file leaves the catalogue and the
 * document exactly as they were (§V32). The instance is one patch, one undo step (§V34);
 * undo removes the instance and leaves the imported definitions installed, the same as
 * `component.saveSelection` does.
 *
 * EXPORT writes through a port, never the DOM: `writeFile` is the composition root's
 * `writeTextFile` ladder (picker, then download), and a bus without one — a component
 * session, a headless harness — refuses by name rather than pretending to have saved.
 *
 * T1494b: the same ports make the other doors. IMPORT without `text` asks `readFile` (the
 * composition root's open picker), so the palette and the canvas menu run the command
 * with no file in hand. EXPORT with `destination: "text"` writes nothing and returns the
 * bytes, which is the agent's door: an agent has no picker and no disk (`save_project`
 * sits behind a `localFile` grant nothing issues), and the text is the document's own
 * content, which it can already read.
 */
declare module "../types/commands.ts" {
  interface CommandMap {
    /** Install a component file by the §T962 identity rule and place one linked instance. */
    "component.import": { input: ComponentImportInput; output: ComponentImportOutput };
    /** Write one component, and every component it nests, to a `.loom.json`. */
    "component.export": { input: ComponentExportInput; output: ComponentExportOutput };
  }
}

export interface ComponentImportInput {
  /** The file's text. Absent: the command's `readFile` asks the user for one. */
  text?: string;
  /** Named in every refusal, so the message says WHICH file. */
  fileName?: string;
  /** Where the instance lands, in graph coordinates. */
  position?: { x: number; y: number };
}

export interface ComponentImportOutput {
  ok: boolean;
  nodeId: NodeId | null;
  /** The root as this document knows it — the renamed id when the rule renamed it. */
  componentId: ComponentId | null;
  version: number | null;
  installed: readonly ComponentRef[];
  reused: readonly ComponentRef[];
  renamed: readonly ComponentRename[];
  diagnostics: RuntimeDiagnostic[];
}

export interface ComponentExportInput {
  componentId: ComponentId;
  /** Omitted means the latest installed version. */
  version?: number;
  /** `"text"` returns the file's text instead of writing it. Omitted means `"file"`. */
  destination?: "file" | "text";
}

export interface ComponentExportOutput {
  saved: boolean;
  /** The name written — or, for `destination: "text"`, the name a save would use. */
  fileName: string | null;
  /** The file's text, for `destination: "text"` only. */
  text: string | null;
  /** Every definition the file carries, deepest first; the exported one is last. */
  components: readonly ComponentRef[];
}

/** `writeTextFile`'s outcome, as much of it as the command reads. */
export type ComponentFileWriteOutcome =
  | { readonly kind: "saved"; readonly fileName: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly reason: string };

export type ComponentFileWriter = (file: ProjectFile) => Promise<ComponentFileWriteOutcome>;

/** The open picker's outcome, as much of it as the command reads. */
export type ComponentFileReadOutcome =
  | { readonly kind: "opened"; readonly fileName: string; readonly text: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly reason: string };

export type ComponentFileReader = () => Promise<ComponentFileReadOutcome>;

export interface ComponentFileCommandOptions {
  components: ComponentRegistry;
  host: { componentId: ComponentId; version: number } | null;
  writeFile?: ComponentFileWriter;
  readFile?: ComponentFileReader;
}

function error(code: string, message: string, suggestion?: string): RuntimeDiagnostic {
  return { severity: "error", code, message, ...(suggestion === undefined ? {} : { suggestion }) };
}

const refOf = (definition: GraphComponentDefinition): ComponentRef => ({
  componentId: definition.componentId,
  version: definition.version,
});

const IMPORT_REFUSED: Omit<ComponentImportOutput, "diagnostics"> = {
  ok: false,
  nodeId: null,
  componentId: null,
  version: null,
  installed: [],
  reused: [],
  renamed: [],
};

const EXPORT_REFUSED: ComponentExportOutput = { saved: false, fileName: null, text: null, components: [] };

export function registerComponentFileCommands(bus: LoomBus, options: ComponentFileCommandOptions): void {
  const { components, host } = options;

  bus.registerCommand({
    name: "component.import",
    description: "Import a component file: reuse it if it is already installed, otherwise install it (renamed if its name is taken), and place it.",
    handler: async (input, context): Promise<CommandOutcome<ComponentImportOutput>> => {
      const revision = context.store.getRevision();
      const diagnostics: RuntimeDiagnostic[] = [];
      const refuse = (...found: readonly RuntimeDiagnostic[]): CommandOutcome<ComponentImportOutput> => {
        diagnostics.push(...found);
        return { status: "rejected", revision, diagnostics, output: { ...IMPORT_REFUSED, diagnostics } };
      };

      const parsedInput = componentImportInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return refuse(
          error(
            "component.import.input",
            "Importing a component needs the text of a component file.",
            "Drop a .loom.json component file on the canvas.",
          ),
        );
      }
      const { position } = parsedInput.data;
      let { text, fileName } = parsedInput.data;
      if (text === undefined) {
        if (options.readFile === undefined) {
          return refuse(
            error(
              "component.import.input",
              "Importing a component needs the text of a component file.",
              "Drop a .loom.json component file on the canvas.",
            ),
          );
        }
        // §V36: a dry run must not open a picker.
        if (context.dryRun) {
          return refuse(
            error("component.import.input", "A dry run cannot ask for a file.", "Pass the file's text to validate it."),
          );
        }
        const picked = await options.readFile();
        // A cancelled picker is not a failure, and is not reported as one (project.save's rule).
        if (picked.kind === "cancelled") return refuse();
        if (picked.kind === "failed") {
          return refuse(error("component.import.readFailed", `The component file could not be read: ${picked.reason}`));
        }
        text = picked.text;
        fileName = picked.fileName;
      }

      const read = readComponentFile(text, fileName);
      if (!read.ok) return refuse(...read.diagnostics);

      const plan = planComponentImport(read.definitions, components);
      if (plan.missing.length > 0) {
        return refuse(
          ...plan.missing.map((reference) =>
            error(
              "component.import.missingDependency",
              `The file needs ${reference.componentId} v${reference.version}, which it does not carry and this document does not have.`,
              "Export the component again: an export carries every component it nests.",
            ),
          ),
        );
      }

      // THE WHOLE PLAN, VALIDATED BEFORE ANYTHING IS WRITTEN. A scratch catalogue layered
      // over the live one registers the definitions in order — the same checks the live
      // `register` runs, nested types resolving scratch-first — and recursion is walked
      // across both, because the scratch alone cannot see an installed component's graph.
      const planned = new Map(plan.install.map((definition) => [`${definition.componentId}@${definition.version}`, definition]));
      const combined: ComponentGraphSource = {
        graphOf: (id, version) => planned.get(`${id}@${version}`)?.graph ?? components.graphOf(id, version),
      };
      const scratch = createComponentSystem(context.registry);
      for (const definition of plan.install) {
        const recursion = detectComponentRecursion({
          componentId: definition.componentId,
          graph: definition.graph,
          source: combined,
        });
        if (recursion !== null) return refuse(error("component.recursion", describeRecursion(recursion)));
        try {
          scratch.components.register(definition);
        } catch (thrown) {
          if (thrown instanceof ComponentDefinitionError) {
            return refuse(...thrown.diagnostics.filter((diagnostic) => diagnostic.severity === "error"));
          }
          throw thrown;
        }
      }
      // §V83 at the drop point: placing the root where the user dropped it must not close
      // a loop through the component being edited.
      const placement = wouldRecurse(host?.componentId ?? null, plan.root.componentId, plan.root.version, combined);
      if (placement !== null) {
        return refuse(
          error("component.recursion", describeRecursion(placement), "A component may not contain itself (§V83)."),
        );
      }

      for (const rename of plan.renamed) {
        diagnostics.push({
          severity: "info",
          code: "component.import.renamed",
          message: `A different ${rename.from.componentId} v${rename.from.version} is already installed, so the file's was imported as "${rename.name}" (${rename.to.componentId}).`,
        });
      }

      const installed = plan.install.map(refOf);
      const root = plan.root;
      if (context.dryRun) {
        return {
          status: "validated",
          revision,
          diagnostics,
          output: {
            ok: true,
            nodeId: null,
            componentId: root.componentId,
            version: root.version,
            installed,
            reused: plan.reused,
            renamed: plan.renamed,
            diagnostics,
          },
        };
      }

      // Definitions first, so the instance never names a type that is not installed. The
      // registrations were each proven above; if the patch still fails, they come back out.
      const registered: GraphComponentDefinition[] = [];
      const nodeId = context.ids.node();
      try {
        for (const definition of plan.install) {
          components.register(definition);
          registered.push(definition);
        }
        const applied = context.apply({
          label: `Import "${root.name}"`,
          recipe: (draft) => {
            draft.nodes[nodeId] = {
              id: nodeId,
              type: componentNodeType(root.componentId, root.version),
              definitionVersion: root.version,
              position: position ?? { x: 0, y: 0 },
              parameters: defaultPublishedValues(root),
            };
          },
        });
        return {
          status: "applied",
          revision: applied.revision,
          diagnostics,
          ...(applied.undoGroupId === undefined ? {} : { undoGroupId: applied.undoGroupId }),
          output: {
            ok: true,
            nodeId,
            componentId: root.componentId,
            version: root.version,
            installed,
            reused: plan.reused,
            renamed: plan.renamed,
            diagnostics,
          },
        };
      } catch (thrown) {
        for (const definition of registered.reverse()) components.remove(definition.componentId, definition.version);
        throw thrown;
      }
    },
    rejectionOutput: (_input, diagnostics) => ({ ...IMPORT_REFUSED, diagnostics }),
  });

  bus.registerCommand({
    name: "component.export",
    description: "Export a component, and every component it nests, to a .loom.json file.",
    handler: async (input, context): Promise<CommandOutcome<ComponentExportOutput>> => {
      const revision = context.store.getRevision();
      const refuse = (...diagnostics: RuntimeDiagnostic[]): CommandOutcome<ComponentExportOutput> => ({
        status: "rejected",
        revision,
        diagnostics,
        output: EXPORT_REFUSED,
      });

      const parsedInput = componentExportInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return refuse(
          error(
            "component.export.input",
            "Exporting needs the id of an installed component.",
            "Use Export on a row of the component library, or Component > Export component on an instance's menu.",
          ),
        );
      }
      const { componentId, version, destination } = parsedInput.data;
      const root = version === undefined ? components.latest(componentId) : components.get(componentId, version);
      if (root === undefined) {
        return refuse(
          error(
            "component.notInstalled",
            `Component "${componentId}"${version === undefined ? "" : ` version ${version}`} is not installed.`,
          ),
        );
      }
      const collected = collectComponentDependencies(root, components);
      if (!collected.ok) {
        return refuse(
          ...collected.missing.map((reference) =>
            error(
              "component.export.missingDependency",
              `"${root.name}" nests ${reference.componentId} v${reference.version}, which is not installed, so the file would not open anywhere else.`,
            ),
          ),
        );
      }
      const carried = collected.definitions.map(refOf);
      const file = buildComponentFile({
        root,
        definitions: collected.definitions,
        settings: context.store.getSettings(),
      });

      // §V36: a dry run must not open a picker or write a byte.
      if (context.dryRun) {
        return { status: "validated", revision, output: { saved: false, fileName: null, text: null, components: carried } };
      }
      if (destination === "text") {
        return {
          status: "applied",
          revision,
          output: { saved: false, fileName: file.fileName, text: file.text, components: carried },
        };
      }
      if (options.writeFile === undefined) {
        return refuse(
          error(
            "component.export.noWriter",
            "Nothing on this bus can write a file, so the component was not exported.",
            "Export from the component library at the root of the project.",
          ),
        );
      }
      const outcome = await options.writeFile(file);
      if (outcome.kind === "failed") {
        return refuse(error("component.export.failed", `"${root.name}" could not be written: ${outcome.reason}`));
      }
      // A cancelled picker is not a failure, and is not reported as one (project.save's rule).
      return {
        status: "applied",
        revision,
        output: {
          saved: outcome.kind === "saved",
          fileName: outcome.kind === "saved" ? outcome.fileName : null,
          text: null,
          components: carried,
        },
      };
    },
    rejectionOutput: () => EXPORT_REFUSED,
  });
}
