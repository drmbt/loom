import { applyRenameMap } from "./apply-rename-map.ts";
import { compareRenamed, sabotages, type Finding } from "./rename-equivalence.ts";
import { auditRenameMap, buildRenameMap, renamesByScope, shippedDocuments } from "./rename-map.ts";

/**
 * Applies the rename map to every shipped document IN MEMORY and asks whether each still
 * does what it did (T1593b phase 2a). CPU only: it loads, flattens and compiles, and never
 * opens a device. It writes nothing.
 *
 *   node --import ./src/tooling/alias-hooks.ts src/examples/rename/check-rename-equivalence.ts
 *   node --import ./src/tooling/alias-hooks.ts src/examples/rename/check-rename-equivalence.ts --only E45
 *   node --import ./src/tooling/alias-hooks.ts src/examples/rename/check-rename-equivalence.ts --mentions
 *   node --import ./src/tooling/alias-hooks.ts src/examples/rename/check-rename-equivalence.ts --sabotage
 *
 * `--only <text>` checks the documents whose path contains the text.
 *
 * `--mentions` also lists the prose that still says an old name after the rename (a note's
 * text, a description). Those are not references and fail nothing; they are sentences the
 * apply has to rewrite by hand.
 *
 * `--sabotage` is how this check is shown to be able to fail. For each document it breaks
 * the rename in every way `sabotages` knows (a reference left on its old name, a reference
 * moved onto another node, labels renamed with no reference rewritten) and requires every
 * one of those to be REPORTED. It exits non-zero if any broken rename passes as sound.
 *
 * What the four checks are, and why there are four, is in `rename-equivalence.ts`.
 */
const started = performance.now();
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined;
const sabotage = process.argv.includes("--sabotage");
const listMentions = process.argv.includes("--mentions");

const everyDocument = shippedDocuments();
const map = buildRenameMap(everyDocument);
const unsound = auditRenameMap(map, everyDocument);
if (unsound.length > 0) {
  console.error(`The rename map is not sound; nothing was checked.\n  ${unsound.slice(0, 10).join("\n  ")}`);
  process.exit(1);
}
const byScope = renamesByScope(map);
const documents = everyDocument.filter((document) => only === undefined || document.path.includes(only));

const summary = (findings: readonly Finding[]): string => [...new Set(findings.map((finding) => finding.check))].join(", ");

let failed = 0;
let renamed = 0;
let references = 0;
let mentions = 0;
let mentioning = 0;
let broken = 0;
let caught = 0;
const escaped: string[] = [];
const caughtBy = new Map<string, number>();

for (const document of documents) {
  const after = applyRenameMap(document.path, document.text, byScope);
  renamed += after.applied.filter((rename) => rename.nodeId !== "").length;
  references += after.applied.reduce((sum, rename) => sum + rename.references, 0);

  if (!sabotage) {
    const compared = compareRenamed(document.text, after.text, after.applied);
    mentions += compared.mentions.length;
    if (compared.mentions.length > 0) mentioning += 1;
    if (listMentions) for (const mention of compared.mentions) console.log(`mention  ${document.path} ${mention}`);
    if (compared.findings.length === 0) continue;
    failed += 1;
    console.log(`NOT THE SAME  ${document.path}`);
    for (const finding of compared.findings.slice(0, 8)) console.log(`    ${finding.check}: ${finding.detail}`);
    if (compared.findings.length > 8) console.log(`    … and ${String(compared.findings.length - 8)} more`);
    continue;
  }

  for (const attempt of sabotages(document.text, after.text, after.applied)) {
    broken += 1;
    const { findings } = compareRenamed(document.text, attempt.text, after.applied);
    if (findings.length === 0) {
      escaped.push(`${document.path}: ${attempt.what}`);
      continue;
    }
    caught += 1;
    for (const check of new Set(findings.map((finding) => finding.check))) caughtBy.set(check, (caughtBy.get(check) ?? 0) + 1);
    if (only !== undefined) console.log(`  caught (${summary(findings)}): ${attempt.what}`);
  }
}

const seconds = ((performance.now() - started) / 1000).toFixed(1);
if (sabotage) {
  console.log(`${String(broken)} broken renames over ${String(documents.length)} documents; ${String(caught)} caught, ${String(escaped.length)} passed as sound. ${seconds} s.`);
  for (const [check, count] of [...caughtBy].sort((left, right) => right[1] - left[1])) console.log(`  ${check}: reported ${String(count)} of them`);
  for (const line of escaped) console.log(`  PASSED AS SOUND  ${line}`);
  process.exit(escaped.length === 0 && broken > 0 ? 0 : 1);
}
console.log(
  `${String(documents.length - failed)} of ${String(documents.length)} documents are the same before and after: `
  + `${String(renamed)} names (a component's, once per file that embeds it) and ${String(references)} references moved. ${seconds} s, no GPU.`,
);
if (mentions > 0) console.log(`${String(mentions)} sentences in ${String(mentioning)} documents still mention an old name in prose (--mentions lists them).`);
process.exit(failed === 0 ? 0 : 1);
