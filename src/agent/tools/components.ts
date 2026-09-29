import type { ComponentExportOutput, ComponentImportOutput } from "@domain/components/file-commands.ts";

import { exportComponentInput, importComponentInput } from "../schemas.ts";
import type { ExportComponentInput, ImportComponentInput } from "../schemas.ts";
import { result } from "../tool-support.ts";
import type { AgentTool, ToolStatus } from "../types.ts";

/**
 * Component files (T1494b) — the agent's door to `component.import` / `component.export`
 * (T1395b). Adapters only: the identity rule, the validation and the undo step are the
 * commands', and these two tools forward and project (§V39).
 *
 * ## Export hands back TEXT
 *
 * The page's export writes through a picker, and the precedent for an agent writing a file
 * is `save_project`: gated behind `localFile`, which nothing issues. An export to disk would
 * be the same wall. What an agent can use is the file itself, so the tool asks the command
 * for `destination: "text"` and returns the bytes — the document's own content, which the
 * read tools already hand over ungated. It writes nothing, so it needs no grant.
 *
 * ## Import needs `componentInstall`
 *
 * §V38 names "component install" as a gated class, and this is exactly that: it adds
 * definitions to the document's catalogue, which an undo does not take back (undo removes
 * the instance only). So the tool declares the class and the surface refuses it until a
 * grant exists — the same shape as `save_project`.
 */

export type ExportComponentData = Pick<ComponentExportOutput, "fileName" | "text" | "components">;

const statusOf = (status: "applied" | "validated" | "rejected" | "conflict"): ToolStatus =>
  status === "applied" ? "ok" : status;

export const importComponent: AgentTool<ImportComponentInput, ComponentImportOutput> = {
  name: "import_component",
  title: "Import component",
  description:
    "Install a component file (its text, as export_component returns it) and place one instance. A component already installed with the same id, version and content is reused; a different one under a taken id is imported renamed. Installing a component needs the componentInstall capability.",
  kind: "mutate",
  inputSchema: importComponentInput,
  requires: { commands: ["component.import"] },
  capabilities: ["componentInstall"],
  mutates: true,
  async run(input, runtime) {
    const dispatched = await runtime.execute<ComponentImportOutput>("component.import", {
      text: input.text,
      ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
      ...(input.position === undefined ? {} : { position: input.position }),
    });
    return result<ComponentImportOutput>("import_component", statusOf(dispatched.status), dispatched.output, {
      diagnostics: dispatched.diagnostics,
      revision: dispatched.revision,
      undoGroupId: dispatched.undoGroupId,
    });
  },
};

export const exportComponent: AgentTool<ExportComponentInput, ExportComponentData> = {
  name: "export_component",
  title: "Export component",
  description:
    "Return an installed component as the text of a .loom.json component file, carrying every component it nests. Writes nothing; pass the text to import_component in another document.",
  kind: "read",
  inputSchema: exportComponentInput,
  requires: { commands: ["component.export"] },
  capabilities: [],
  mutates: false,
  async run(input, runtime) {
    const dispatched = await runtime.execute<ComponentExportOutput>("component.export", {
      componentId: input.componentId,
      ...(input.version === undefined ? {} : { version: input.version }),
      destination: "text",
    });
    const { fileName, text, components } = dispatched.output;
    return result<ExportComponentData>("export_component", statusOf(dispatched.status), { fileName, text, components }, {
      diagnostics: dispatched.diagnostics,
      revision: dispatched.revision,
    });
  },
};

export const componentTools: readonly AgentTool[] = [importComponent, exportComponent] as readonly AgentTool[];
