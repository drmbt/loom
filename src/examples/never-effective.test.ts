import { describe, expect, it } from "vitest";

import { diagnosticClass } from "../domain/diagnostics/classes.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import { listExamples, listProjectDocuments, listStarterComponentFiles, type ExampleFile } from "./catalogue.ts";
import { runExample } from "./runner.ts";

/**
 * §T1641b — NO SHIPPED DOCUMENT HOLDS SOMETHING THAT CAN NEVER TAKE EFFECT.
 *
 * §B262 shipped in a project file: three lamps whose expression called a function the
 * grammar does not have, each rendering at its stored value. The compile said so, as a
 * warning nobody read, and no gate read `projects/` at all. This one reads every shipped
 * document (the examples, the starter component files, every project document) through
 * the real load and the real compile, with the file's own component library, and fails on
 * any finding whose CLASS is `never`, at any severity, and on any code nobody has classed
 * (`src/domain/diagnostics/classes.ts`). By class and not by code, so a code that is split
 * tomorrow cannot walk past it.
 *
 * What it reads is what a structural compile says: the zero frame, no channel resolver, no
 * mesh or media facts. A finding only a running frame or an asset's contents can show is
 * not here. Neither, yet, is what only the write gate checks of a stored value (a retained
 * static of the wrong type under a working expression): that arrives with the document
 * check of the slices that follow.
 *
 * It lives beside the documents because it reads the document set, and is on `test:gates`
 * for the same reason: no file's own tests would run it.
 */

const SHIPPED: ReadonlyArray<readonly [string, ExampleFile]> = [
  ...listExamples().map((file) => [`examples/${file.fileName}`, file] as const),
  ...listStarterComponentFiles().map((file) => [`examples/components/${file.fileName}`, file] as const),
  ...listProjectDocuments().map((file) => [`projects/${file.fileName}`, file] as const),
];

const refused = (diagnostic: RuntimeDiagnostic): boolean => {
  const found = diagnosticClass(diagnostic.code);
  return found === "never" || found === "unclassified";
};

describe("no shipped document holds something that can never take effect (T1641b)", () => {
  it("reads every example, starter component file and project document", () => {
    // If a directory moved, every case below would pass for want of subjects.
    expect(listExamples().length).toBeGreaterThan(60);
    expect(listStarterComponentFiles().length).toBeGreaterThan(8);
    expect(listProjectDocuments().length).toBeGreaterThan(10);
  });

  it("the load and the compile of each say nothing of class never", () => {
    const problems: string[] = [];
    let compiled = 0;
    for (const [path, file] of SHIPPED) {
      const result = runExample(file);
      if (result.plan === undefined) {
        problems.push(`${path} did not load: ${result.reason ?? "no reason given"}`);
        continue;
      }
      compiled += 1;
      for (const diagnostic of [...result.loadDiagnostics, ...result.plan.diagnostics]) {
        if (!refused(diagnostic)) continue;
        const node = diagnostic.nodeId === undefined ? "" : ` [${result.document?.graph.nodes[diagnostic.nodeId]?.label ?? diagnostic.nodeId}]`;
        problems.push(
          `${path}${node}: ${diagnostic.severity} ${diagnostic.code} (${diagnosticClass(diagnostic.code)})\n    ${diagnostic.message}` +
            (diagnostic.suggestion === undefined ? "" : `\n    ${diagnostic.suggestion}`),
        );
      }
    }
    expect(compiled).toBe(SHIPPED.length);
    expect(
      problems,
      `\n${problems.join("\n\n")}\n\nEach is a stored thing that can never do what it says. Fix it in the document's source ` +
        "(src/examples/documents/**, src/projects/**) and regenerate; it is not a warning to live with.\n",
    ).toEqual([]);
  });
});
