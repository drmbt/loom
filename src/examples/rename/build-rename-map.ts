import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { auditRenameMap, buildRenameMap, shippedDocuments } from "./rename-map.ts";
import { MAP_JSON_PATH, MAP_PAGE_PATH, renameMapJson, renameMapPage } from "./rename-map-files.ts";

/**
 * Writes the rename map for review (T1593b phase 2a). It writes two files under `docs/`
 * and nothing else: no example, no component, no project document, no source.
 *
 *   node --import ./src/tooling/alias-hooks.ts src/examples/rename/build-rename-map.ts
 *   node --import ./src/tooling/alias-hooks.ts src/examples/rename/build-rename-map.ts --check
 *
 * `--check` writes nothing and fails when the two files are not what the rules and
 * judgements give today, which is what the apply tool asks before it trusts them.
 *
 * It refuses to write a map that is not sound (`auditRenameMap`): one that would leave a
 * name without its kind, name two nodes of a graph alike, or leave a thin role undecided.
 */
const root = fileURLToPath(new URL("../../../", import.meta.url));
const documents = shippedDocuments();
const map = buildRenameMap(documents);

const problems = auditRenameMap(map, documents);
if (problems.length > 0) {
  console.error(`The rename map is not sound (${String(problems.length)}):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

const files = [
  [MAP_JSON_PATH, renameMapJson(map, documents)],
  [MAP_PAGE_PATH, renameMapPage(map, documents)],
] as const;

if (process.argv.includes("--check")) {
  const stale = files.filter(([path, text]) => {
    try {
      return readFileSync(`${root}${path}`, "utf8") !== text;
    } catch {
      return true;
    }
  });
  if (stale.length > 0) {
    console.error(`Stale: ${stale.map(([path]) => path).join(", ")}. Run build-rename-map.ts without --check.`);
    process.exit(1);
  }
  console.log(`The rename map files are current: ${String(map.entries.length)} names.`);
} else {
  for (const [path, text] of files) {
    writeFileSync(`${root}${path}`, text);
    console.log(`wrote ${path} (${String(text.length)} bytes)`);
  }
  console.log(`${String(map.entries.length)} names over ${String(documents.length)} documents.`);
}
