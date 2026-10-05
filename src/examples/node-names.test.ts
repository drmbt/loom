import { describe, expect, it } from "vitest";

import { KIND_FAMILIES, NODE_KINDS, SOCKET_NAMED_TYPES } from "../domain/graph/node-kinds.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { listExamples, listProjectDocuments, listStarterComponentFiles, type ExampleFile } from "./catalogue.ts";
import { unconformingNames } from "./node-name-audit.ts";

/**
 * EVERY SHIPPED NODE NAME CARRIES ITS KIND: `kind_role` (T1593b, owner's ruling 2026-10-05).
 *
 * ## What this is the gate for
 *
 * The owner: "it's pretty damn hard that we need to zoom in and figure out, ah okay, this
 * is this kind of operator". A new node is auto-named from its kind (`blur1`), and then
 * almost every shipped node was renamed to a bare role (`dye1`, `lamp`, `pathx1`), which
 * spends the identification. The rule is that a name keeps its kind in front
 * (`feedback_dye`, `slider_lamp`, `lfo_pathx`). This file is what makes it a rule: a
 * shipped example, starter component or project document with a named node that does not
 * carry its type's kind fails here.
 *
 * ## Why it is a document-set walker, and why it is on `pnpm test:gates`
 *
 * It reads the shipped BYTES of every `.loom.json`, so it has no import edge from any
 * document source and no dependency-graph selector can find it (§V957). `gate-list.test.ts`
 * holds it on the gate script.
 *
 * ## THE LEDGER IS HONEST IN BOTH DIRECTIONS
 *
 * Phase 1 lands the rule and renames nothing, so the documents written before it are
 * listed in `NOT_YET_RENAMED` with the EXACT number of names each still owes. Not an
 * allow-list of files: a count. So:
 *
 *  - a file NOT listed must be clean. A new example conforms from its first commit.
 *  - a listed file's count must be exactly what is written. If it went DOWN, someone
 *    renamed nodes and the entry is now too generous: lower it, or remove it at zero. If
 *    it went UP, a non-conforming name was added to an old file, which the ledger was
 *    never permission for.
 *  - an entry for a file that no longer exists fails too.
 *
 * Phase 2 (the sweep) empties it. Until then it can only shrink without someone deciding
 * otherwise in a diff.
 *
 * ## What is not counted
 *
 * An unnamed node, and a component's In and Out (their name is the socket's label). See
 * `node-name-audit.ts`, which is the one reading of a file this gate and the sweep share.
 */

/**
 * repo-relative path → the number of named nodes in it that do not carry their kind yet.
 *
 * Counted over the file's root graph AND every component graph it embeds. To update after
 * renaming: run this test, and the failure prints the number each changed file now has.
 */
export const NOT_YET_RENAMED: Readonly<Record<string, number>> = {
  "examples/E10-Instanced-Torus.loom.json": 1,
  "examples/E11-Gradient-Remap.loom.json": 1,
  "examples/E12-Fluid.loom.json": 8,
  "examples/E13-Prism.loom.json": 32,
  "examples/E14-Self-Regulating-Bloom.loom.json": 5,
  "examples/E16-Murmuration.loom.json": 4,
  "examples/E2-Reaction-Diffusion.loom.json": 10,
  "examples/E20-Gooeyball.loom.json": 13,
  "examples/E24-Audio-Reaction-Diffusion.loom.json": 50,
  "examples/E25-Stage.loom.json": 21,
  "examples/E26-Interference.loom.json": 10,
  "examples/E27-Relief.loom.json": 35,
  "examples/E28-Sundial.loom.json": 20,
  "examples/E29-Descent.loom.json": 24,
  "examples/E30-Nave.loom.json": 20,
  "examples/E31-Corona.loom.json": 42,
  "examples/E32-Pasture.loom.json": 79,
  "examples/E33-Obol.loom.json": 36,
  "examples/E34-Lidar.loom.json": 44,
  "examples/E35-Nova-Torus.loom.json": 11,
  "examples/E36-Facade.loom.json": 19,
  "examples/E37-Sirocco.loom.json": 16,
  "examples/E38-Sigil.loom.json": 18,
  "examples/E39-Rosette.loom.json": 28,
  "examples/E40-Wake.loom.json": 36,
  "examples/E41-Cinder.loom.json": 21,
  "examples/E42-Current.loom.json": 18,
  "examples/E43-Splice.loom.json": 23,
  "examples/E44-Sounding.loom.json": 15,
  "examples/E45-Pulse.loom.json": 43,
  "examples/E46-Lantern.loom.json": 4,
  "examples/E47-Hologram.loom.json": 30,
  "examples/E48-Marionette.loom.json": 12,
  "examples/E49-Lissajous.loom.json": 9,
  "examples/E50-Galvo.loom.json": 9,
  "examples/E51-Chorus.loom.json": 24,
  "examples/E52-Presence.loom.json": 11,
  "examples/E53-Two-Cuts.loom.json": 25,
  "examples/E54-Quorum.loom.json": 42,
  "examples/E55-Reactor.loom.json": 38,
  "examples/E56-Vesper.loom.json": 13,
  "examples/E57-Forest.loom.json": 16,
  "examples/E58-Alembic.loom.json": 3,
  "examples/E59-Vault.loom.json": 3,
  "examples/E60-Snarl.loom.json": 3,
  "examples/E61-Skein.loom.json": 3,
  "examples/E62-Rake.loom.json": 3,
  "examples/E63-Skin.loom.json": 21,
  "examples/E64-Relay.loom.json": 26,
  "examples/E66-Meter.loom.json": 22,
  "examples/E67-Fins.loom.json": 8,
  "examples/E68-Sanctum.loom.json": 9,
  "examples/E69-Burnish.loom.json": 23,
  "examples/E7-LFO-Dissolve.loom.json": 1,
  "examples/E70-Chimera.loom.json": 10,
  "examples/E71-Syphon-Loopback.loom.json": 10,
  "examples/E72-NDI-Loopback.loom.json": 10,
  "examples/E73-Native-Person-Mask.loom.json": 12,
  "examples/E74-Spout-Loopback-Preparation.loom.json": 10,
  "examples/E75-Resonance.loom.json": 76,
  "examples/E76-Verdant-Lotus.loom.json": 72,
  "examples/E77-Ember-Monoliths.loom.json": 110,
  "examples/E78-Aether-Orrery.loom.json": 119,
  "examples/E79-Crucible.loom.json": 76,
  "examples/E8-Slit-Scan.loom.json": 4,
  "examples/E80-Azulejo.loom.json": 15,
  "examples/E81-Phone-Desk.loom.json": 15,
  "examples/E82-Set-List.loom.json": 30,
  "examples/E9-Ember.loom.json": 13,
  "projects/furnace/furnace.loom.json": 101,
  "projects/on-nothing/cards.loom.json": 13,
  "projects/on-nothing/crt.loom.json": 81,
  "projects/on-nothing/cyc-wide.loom.json": 38,
  "projects/on-nothing/cyc.loom.json": 35,
  "projects/on-nothing/halo.loom.json": 79,
  "projects/on-nothing/hands.loom.json": 42,
  "projects/on-nothing/incar.loom.json": 93,
  "projects/on-nothing/lights.loom.json": 81,
  "projects/on-nothing/mcu.loom.json": 44,
  "projects/on-nothing/mcu2.loom.json": 75,
  "projects/on-nothing/mirror.loom.json": 31,
  "projects/on-nothing/pendant.loom.json": 34,
  "projects/on-nothing/prism.loom.json": 42,
  "projects/on-nothing/quad.loom.json": 33,
  "projects/on-nothing/ring.loom.json": 33,
  "projects/on-nothing/sleep-like-a-baby-2.loom.json": 36,
  "projects/on-nothing/sleep-like-a-baby.loom.json": 24,
  "projects/on-nothing/sneaker.loom.json": 59,
  "projects/on-nothing/split.loom.json": 88,
  "projects/on-nothing/tableau.loom.json": 77,
  "projects/on-nothing/title.loom.json": 63,
  "projects/on-nothing/wheel.loom.json": 70,
  "projects/on-nothing/wide.loom.json": 77,
  "projects/on-nothing/zoom.loom.json": 77,
};

interface ShippedFile {
  /** Repo-relative, forward slashes: the ledger's key and the name in every message. */
  readonly path: string;
  readonly text: string;
}

const under = (prefix: string, files: readonly ExampleFile[]): ShippedFile[] =>
  files.map((file) => ({ path: `${prefix}${file.fileName}`, text: file.text }));

const SHIPPED: readonly ShippedFile[] = [
  ...under("examples/", listExamples()),
  ...under("examples/components/", listStarterComponentFiles()),
  ...under("projects/", listProjectDocuments()),
];

const HOW_TO_NAME =
  "A node's name is kind_role: its type's kind (NODE_KINDS in src/domain/graph/node-kinds.ts), one underscore, " +
  "then what the node is for. In a document source, `named(role, type, …)` from " +
  "src/examples/documents/builders.ts writes it from the role alone. Regenerate the file with " +
  "`build-examples.ts --only <name>` after editing its source; never edit the JSON.";

/** At most this many offending names are spelled out per file; a 100-name list hides its own first line. */
const SHOWN = 12;

function spelled(file: ShippedFile): string {
  const names = unconformingNames(file.text);
  const shown = names
    .slice(0, SHOWN)
    .map((each) => `"${each.name}" (${each.type}, ${each.graph}) wants "${each.kind}_…"`)
    .join("; ");
  return names.length > SHOWN ? `${shown}; and ${names.length - SHOWN} more` : shown;
}

/**
 * Every way the shipped set and the ledger can disagree, each as an instruction.
 *
 * A pure function of (files, ledger) so the tests below can hand it a file with a known
 * defect and a ledger with a known lie: a gate that has only ever been seen green has not
 * been seen to work (§V245).
 */
function nameProblems(files: readonly ShippedFile[], ledger: Readonly<Record<string, number>>): string[] {
  const problems: string[] = [];
  const present = new Set(files.map((file) => file.path));
  for (const file of files) {
    const actual = unconformingNames(file.text).length;
    const listed = Object.hasOwn(ledger, file.path) ? ledger[file.path] : undefined;
    if (listed === undefined) {
      if (actual > 0) {
        problems.push(
          `${file.path} has ${actual} node name(s) that do not carry their kind: ${spelled(file)}. ${HOW_TO_NAME} ` +
            "This file is not in NOT_YET_RENAMED, and a new document does not go on it.",
        );
      }
      continue;
    }
    if (actual === 0) {
      problems.push(
        `${file.path} now conforms (the ledger says ${listed}). Remove its line from NOT_YET_RENAMED in src/examples/node-names.test.ts.`,
      );
    } else if (actual < listed) {
      problems.push(
        `${file.path} is down to ${actual} non-conforming name(s) (the ledger says ${listed}). Lower its line in NOT_YET_RENAMED to ${actual}, so the names just fixed cannot come back unnoticed.`,
      );
    } else if (actual > listed) {
      problems.push(
        `${file.path} has ${actual} non-conforming name(s), up from the ${listed} the ledger allows: a name that does not carry its kind was ADDED to a listed file. Name the new node kind_role. Still owed: ${spelled(file)}. ${HOW_TO_NAME}`,
      );
    }
  }
  for (const path of Object.keys(ledger).sort()) {
    if (!present.has(path)) {
      problems.push(`NOT_YET_RENAMED lists ${path}, which is not a shipped file. Remove the line.`);
    }
  }
  return problems;
}

describe("every node type has a declared kind (T1593b)", () => {
  /*
   * The kind table is TOTAL over the catalogue, held in both directions. A new node type
   * without a row would silently be named by its type string (`pointkerneladvanced1`),
   * which is the long name the table exists to replace; a row for a type that is gone is a
   * kind nobody can check against anything.
   */
  it("holds a row for every registered type, so a new node type chooses its kind on purpose", () => {
    const missing = allNodeDefinitions.map((definition) => definition.type).filter((type) => !Object.hasOwn(NODE_KINDS, type));
    expect(
      missing,
      `These node types have no row in NODE_KINDS (src/domain/graph/node-kinds.ts): ${missing.join(", ")}. ` +
        "Add one line per type: the kind is a short lowercase word, the library title where that works, " +
        "and it may be shared with another type only by adding it to KIND_FAMILIES.",
    ).toEqual([]);
  });

  it("holds no row for a type the catalogue does not have", () => {
    const registered = new Set(allNodeDefinitions.map((definition) => definition.type));
    const stale = Object.keys(NODE_KINDS).filter((type) => !registered.has(type));
    expect(stale, `NODE_KINDS names types that are not registered: ${stale.join(", ")}. Remove the rows.`).toEqual([]);
  });

  it("names only registered types in its families and its socket-named exceptions", () => {
    const registered = new Set(allNodeDefinitions.map((definition) => definition.type));
    const unknown = [...Object.values(KIND_FAMILIES).flat(), ...SOCKET_NAMED_TYPES].filter((type) => !registered.has(type));
    expect(unknown).toEqual([]);
  });
});

describe("every shipped node name carries its kind, or its file is on the ledger for exactly what it owes (T1593b)", () => {
  it("sweeps the whole shipped set: examples, starter components and projects", () => {
    expect(SHIPPED.length).toBeGreaterThan(100);
    for (const prefix of ["examples/E", "examples/components/", "projects/"]) {
      expect(SHIPPED.some((file) => file.path.startsWith(prefix)), `no shipped file under ${prefix}`).toBe(true);
    }
  });

  it("agrees with NOT_YET_RENAMED, file by file", () => {
    const problems = nameProblems(SHIPPED, NOT_YET_RENAMED);
    expect(problems, `\n${problems.join("\n\n")}\n`).toEqual([]);
  });
});

/**
 * THE GATE CAN FAIL, EACH WAY IT CLAIMS TO. Hand-built files, so a red result here is
 * about the gate and never about the state of the shipped set.
 */
describe("the gate fails for each disagreement, with the instruction that fixes it", () => {
  const file = (path: string, nodes: Record<string, { type: string; label?: string }>): ShippedFile => ({
    path,
    text: JSON.stringify({ graph: { nodes } }),
  });
  const clean = file("examples/E900-Clean.loom.json", {
    a: { type: "slider", label: "slider_lamp" },
    b: { type: "pointKernel", label: "kernel1" },
    c: { type: "blur" },
  });
  const owing = file("examples/E901-Owing.loom.json", {
    a: { type: "slider", label: "lamp" },
    b: { type: "feedback", label: "dye1" },
    c: { type: "blur", label: "blur_soft" },
  });

  it("passes a clean file that is not listed, and a listed file at exactly its count", () => {
    expect(nameProblems([clean, owing], { [owing.path]: 2 })).toEqual([]);
  });

  it("fails an unlisted file with a non-conforming name, naming the node, its type and the kind it wants", () => {
    const [problem, ...rest] = nameProblems([owing], {});
    expect(rest).toEqual([]);
    expect(problem).toContain("examples/E901-Owing.loom.json has 2 node name(s) that do not carry their kind");
    expect(problem).toContain(`"lamp" (slider, root) wants "slider_…"`);
    expect(problem).toContain(`"dye1" (feedback, root) wants "feedback_…"`);
    expect(problem).toContain("named(role, type, …)");
  });

  it("fails a listed file that has become conforming, and says to remove its line", () => {
    expect(nameProblems([clean], { [clean.path]: 3 })).toEqual([
      "examples/E900-Clean.loom.json now conforms (the ledger says 3). Remove its line from NOT_YET_RENAMED in src/examples/node-names.test.ts.",
    ]);
  });

  it("fails a listed file whose count went DOWN, and says the number to write", () => {
    const [problem] = nameProblems([owing], { [owing.path]: 5 });
    expect(problem).toContain("is down to 2 non-conforming name(s) (the ledger says 5). Lower its line in NOT_YET_RENAMED to 2");
  });

  it("fails a listed file whose count went UP: the ledger is not permission to add one", () => {
    const [problem] = nameProblems([owing], { [owing.path]: 1 });
    expect(problem).toContain("has 2 non-conforming name(s), up from the 1 the ledger allows");
    expect(problem).toContain("Name the new node kind_role");
  });

  it("fails a ledger line for a file that is not shipped", () => {
    expect(nameProblems([clean], { "examples/E000-Gone.loom.json": 4 })).toEqual([
      "NOT_YET_RENAMED lists examples/E000-Gone.loom.json, which is not a shipped file. Remove the line.",
    ]);
  });

  /** A file that embeds the component "Glow Stack" under a minted id, with one instance of it. */
  const embedding = (instanceLabel: string, innerLabel: string, embedded = true): ShippedFile => ({
    path: "examples/E902-Embeds.loom.json",
    text: JSON.stringify({
      graph: { nodes: { inst: { type: "component:cmp_7@2", label: instanceLabel } } },
      componentLibrary: {
        components: embedded
          ? [{ componentId: "cmp_7", version: 2, name: "Glow Stack", graph: { nodes: { inner: { type: "blur", label: innerLabel } } } }]
          : [],
      },
    }),
  });

  it("reads a component graph embedded in the file, not only the root", () => {
    expect(nameProblems([embedding("glowstack_main", "soften1")], {})).toEqual([
      expect.stringContaining(`has 1 node name(s) that do not carry their kind: "soften1" (blur, component cmp_7) wants "blur_…"`),
    ]);
  });

  /*
   * RULED 2026-10-05: an instance is named for ITS COMPONENT. The kind is not in the type
   * (the id there is minted), so it is read from the definition the file itself embeds:
   * the one this file would open with.
   */
  it("judges a component instance against the name its embedded definition holds", () => {
    expect(nameProblems([embedding("glowstack_main", "blur_soften")], {})).toEqual([]);
    expect(nameProblems([embedding("glowstack1", "blur_soften")], {})).toEqual([]);
    // Not the old universal word, and not the id in its type.
    for (const wrong of ["comp_main", "cmp_main", "main1"]) {
      const [problem, ...rest] = nameProblems([embedding(wrong, "blur_soften")], {});
      expect(rest).toEqual([]);
      expect(problem).toContain(`"${wrong}" (component:cmp_7@2, root) wants "glowstack_…"`);
    }
  });

  it("fails an instance whose definition the file does not embed, instead of passing it unexamined", () => {
    const [problem] = nameProblems([embedding("glowstack_main", "blur_soften", false)], {});
    expect(problem).toContain(`"glowstack_main" (component:cmp_7@2, root) wants "component_…"`);
  });

  it("does not ask an unnamed node, or a component's In and Out, to conform", () => {
    const exempt = file("examples/E903-Exempt.loom.json", {
      unnamed: { type: "blur" },
      socketIn: { type: "componentIn", label: "depth" },
      socketOut: { type: "componentOutValue", label: "level" },
    });
    expect(nameProblems([exempt], {})).toEqual([]);
  });
});
