import { documentFindings, requireCodeBuilt, type DocumentFinding } from "../compiler/document-findings.ts";
import { createComponentSystem } from "../domain/components/registry.ts";
import { buildProjectFile, type BuildProjectFileInput, type ProjectFile } from "../domain/project/index.ts";
import { serializeProjectDocument } from "../domain/project/serialize.ts";
import type { GraphComponentDefinition } from "../domain/types/components.ts";
import type { ProjectDocument } from "../domain/types/graph.ts";
import { TIER_B_CAPABILITIES, exampleRegistry } from "./runner.ts";

/**
 * §T1641b slice 3 — THE SAVE FOR A DOCUMENT BUILT BY CODE.
 *
 * `buildProjectFile` and `serializeProjectDocument` are the app's save path and check
 * nothing: a person's work is written whatever it holds (the app's save reports, and never
 * refuses). A build script is not a person's work. Its document is an object literal that
 * never met the command bus, and two silent failures shipped through exactly that gap in
 * one day: three lamps behind a function the grammar does not have (§B262), a light driven
 * under a key nothing reads (§B264). Both would have been refused by the first
 * `setParameters` that wrote them.
 *
 * So every document a script builds is saved through here: `documentFindings` first, against
 * the whole node catalogue and the definitions the file carries, compiled at the Tier B
 * baseline as the example gate compiles; and NO BYTE IS WRITTEN while the document holds
 * anything `refusedAtCodeSave` names. The refusal lists every such finding by its code, its
 * node's name and what to write instead.
 *
 * The load's half is `requireExample` (`runner.ts`): a script that reads a file to render or
 * test it is refused the same findings. `never-effective.test.ts` holds every writer under
 * `src/examples` and `src/projects` to this door.
 */

/** What `documentFindings` says of a document as a script built it, with the library it ships with. */
export function codeBuiltFindings(
  document: ProjectDocument,
  definitions: readonly GraphComponentDefinition[] = [],
): readonly DocumentFinding[] {
  const { components, nodes: registry } = createComponentSystem(exampleRegistry());
  for (const definition of definitions) components.register(definition);
  return documentFindings({
    graph: document.graph,
    settings: document.settings,
    registry,
    components: components.view(),
    capabilities: TIER_B_CAPABILITIES,
  });
}

/** `buildProjectFile`, refused (`DocumentRefused`) while the document holds what a code save refuses. */
export function buildCheckedProjectFile(input: BuildProjectFileInput): ProjectFile & { readonly findings: readonly DocumentFinding[] } {
  const findings = codeBuiltFindings(input.document, input.components);
  requireCodeBuilt(`"${input.document.name}" was not saved`, findings);
  return { ...buildProjectFile(input), findings };
}

/**
 * `serializeProjectDocument`, refused the same way: for a build that writes the document
 * exactly as it built it, its own `updatedAt` included.
 */
export function serializeCheckedProject(document: ProjectDocument): string {
  requireCodeBuilt(`"${document.name}" was not saved`, codeBuiltFindings(document));
  return serializeProjectDocument(document);
}
