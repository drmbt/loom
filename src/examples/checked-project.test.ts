import { describe, expect, it } from "vitest";

import { DocumentRefused } from "../compiler/document-findings.ts";
import { buildProjectFile, loadProject } from "../domain/project/index.ts";
import { serializeProjectDocument } from "../domain/project/serialize.ts";
import type { GraphNode, ProjectDocument } from "../domain/types/graph.ts";
import { DOT, LAMP, NEVER_EFFECTIVE_REGISTRY, dotDocument, hazeDocument, lampDocument } from "../tests/fixtures/never-effective.ts";
import { buildCheckedProjectFile, codeBuiltFindings, serializeCheckedProject } from "./checked-project.ts";
import { EXAMPLE_TIMESTAMP, document, edge, expressionSlot, graph, named, settings } from "./documents/builders.ts";
import { presenceDocument } from "./documents/presence.ts";

/**
 * §T1641b slice 3 — THE SAVE FOR A DOCUMENT BUILT BY CODE.
 *
 * Phase 1's main finding: the bus refuses a stored thing that can never take effect, and a
 * document built by code never meets the bus. So each document below is built the way a
 * project's build script builds one (object literals through the builders) and handed to
 * both saves: the one that checks nothing, which wrote §B262 and §B264 into a shipped
 * file, and the checked one every build script now calls.
 */

/** What the refusal says, or null when the document was saved. */
function refusalOf(built: ProjectDocument): string | null {
  try {
    serializeCheckedProject(built);
    return null;
  } catch (error) {
    if (!(error instanceof DocumentRefused)) throw error;
    return error.message;
  }
}

/** A node the builders refuse to make: a type this build does not have. */
const ofAnotherBuild = (id: string): GraphNode => ({ id, type: "aurora", definitionVersion: 1, position: { x: 0, y: 400 }, parameters: {}, label: id });

describe("a document built by code is refused where it is saved (T1641b)", () => {
  const wrong: ReadonlyArray<readonly [string, ProjectDocument, readonly string[]]> = [
    [
      "a kept static of another type than its parameter (the consumer's `reset`)",
      dotDocument(expressionSlot("1", 0)),
      [
        `parameter.retained: "${DOT}" (circle): Parameter "aspectcorrect" is in expression mode and keeps a static payload it cannot take: Parameter "aspectcorrect" expects a boolean, received number.`,
        "Keep true or false as the static value",
      ],
    ],
    [
      "a key no node declares (§B264)",
      lampDocument(0.5, [], { contrst: 2 }),
      [`parameter.unknown: "${LAMP}" (level): Node "${LAMP}" stores a value under "contrst", which "level" does not declare: nothing reads it.`, 'Nearest: "contrast".'],
    ],
    [
      "a function the grammar does not have (§B262)",
      lampDocument(expressionSlot("pow(0.5 + abstime * 0, 2)", 0.5)),
      [`parameter.expression.syntax: "${LAMP}" (level): Parameter "brightness" expression "pow(0.5 + abstime * 0, 2)"`, "Write (0.5 + abstime * 0) ^ 2."],
    ],
    [
      "a colour's parts written x, y, z (§B264 as it shipped)",
      hazeDocument({ "eyeColor.x": expressionSlot("0.5", 0) }),
      ['parameter.unknown: "wgsl_haze" (customWgsl):', '"eyeColor" is a colour, and its parts are r, g, b', 'Write "eyeColor.r".'],
    ],
  ];

  it.each(wrong)("%s: the save that checks nothing writes it, and the load says nothing", (_what, built) => {
    // The state of things before this slice, and the reason for it: this is the door two
    // silent failures shipped through. It stays so; the app's save is this function.
    const text = serializeProjectDocument(built);
    const loaded = loadProject(text, { nodes: NEVER_EFFECTIVE_REGISTRY });
    expect(loaded.ok).toBe(true);
    expect(loaded.diagnostics).toEqual([]);
  });

  it.each(wrong)("%s: the checked save refuses it by code, node and what to write instead", (_what, built, says) => {
    const refusal = refusalOf(built);
    expect(refusal).not.toBeNull();
    expect(refusal).toContain(`"${built.name}" was not saved: one thing in it cannot take effect as written.`);
    for (const text of says) expect(refusal).toContain(text);
    // And through the other form of the same door, which stamps the file as the app's save does.
    expect(() => buildCheckedProjectFile({ document: built, now: () => EXAMPLE_TIMESTAMP })).toThrow(DocumentRefused);
  });

  it("lists every refused finding of a document, not the first", () => {
    const refusal = refusalOf(lampDocument(expressionSlot("pow(2, 2)", 0.5), [], { contrst: 2, opacity: expressionSlot("1", true) }));
    expect(refusal).toContain("3 things in it cannot take effect as written.");
    for (const code of ["parameter.expression.syntax:", "parameter.unknown:", "parameter.retained:"]) expect(refusal).toContain(code);
  });

  it("refuses the same wrong value in effect, under the code it always had", () => {
    expect(refusalOf(dotDocument(0))).toContain(`parameter.type: "${DOT}" (circle): Parameter "aspectcorrect" expects a boolean, received number.`);
  });
});

/**
 * What a guard like this one could swallow. Each of these is a legitimate document, each is
 * saved, and the checked save writes THE SAME BYTES as the unchecked one: it adds a refusal
 * and changes nothing it lets through.
 */
describe("what the checked save lets through, byte for byte (T1641b)", () => {
  const codesOf = (built: ProjectDocument): string[] => [...new Set(codeBuiltFindings(built).map((finding) => `${finding.diagnostic.code} ${finding.class}`))];
  const saved = (built: ProjectDocument): void => {
    expect(serializeCheckedProject(built)).toBe(serializeProjectDocument(built));
  };

  it("a shipped example that reads a channel only a live publisher supplies (E52's `coverage`)", () => {
    // A Person Mask publishes through the vision helper. Nothing here has one, so the read
    // waits: `elsewhereHost` at rest, `notYet` at a frame. Neither is the document's fault.
    const checked = buildCheckedProjectFile({ document: presenceDocument, now: () => EXAMPLE_TIMESTAMP });
    expect(checked.text).toBe(buildProjectFile({ document: presenceDocument, now: () => EXAMPLE_TIMESTAMP }).text);
    const wash = checked.findings.filter((finding) => finding.node?.name === "level_wash");
    expect(wash.map((finding) => [finding.diagnostic.code, finding.class])).toEqual([["parameter.channels.unavailable", "elsewhereHost"]]);
    expect(wash[0]?.diagnostic.message).toContain("coverage");
  });

  it("a reference to a node that is not in the document yet", () => {
    const built = lampDocument(expressionSlot("op('slider_absent').par.value", 0.5));
    expect(codesOf(built)).toEqual(["parameter.reference.node notYet"]);
    saved(built);
  });

  it("an expression past its parameter's limit, clamped and said", () => {
    const built = lampDocument(0.5, [], { opacity: expressionSlot("2", 1) });
    expect(codesOf(built)).toEqual(["parameter.expression.clamped degraded"]);
    saved(built);
  });

  it("a node saved by a newer version of its definition, with a key this build does not know", () => {
    const built = lampDocument(0.5);
    const lamp = built.graph.nodes[LAMP];
    if (lamp === undefined) throw new Error("fixture");
    built.graph.nodes[LAMP] = { ...lamp, definitionVersion: lamp.definitionVersion + 1, parameters: { ...lamp.parameters, shimmer: 3 } };
    expect(codesOf(built)).toEqual(["compiler/definition-version degraded"]);
    saved(built);
  });

  it("a node of a type a newer build declares, on a branch no sink reaches", () => {
    const built = lampDocument(0.5, [ofAnotherBuild("aurora_side")]);
    expect(codesOf(built)).toEqual(["compiler/unknown-node-type elsewhereBuild"]);
    saved(built);
  });

  it("a kept static of its parameter's own type, and a document that says nothing at all", () => {
    for (const built of [dotDocument(expressionSlot("1", false)), lampDocument(expressionSlot("(0.5 + abstime * 0) ^ 2", 0.5)), lampDocument(0.5)]) {
      expect(codeBuiltFindings(built)).toEqual([]);
      saved(built);
    }
  });
});

describe("a code-built save refuses an error on a node a sink reaches, and only there (ruling 12, T1641b)", () => {
  const small = settings({ outputResolution: { width: 8, height: 8 }, previewLongEdge: 8 });

  it("a required input nothing is wired to, on the way to the Output", () => {
    const lamp = named("lamp", "level", [0, 0]);
    const out = named("out", "output", [300, 0]);
    const built = document("t1641b-unwired", "T1641b unwired", small, graph([lamp, out], [edge("e_lamp", [lamp.id, "out"], [out.id, "input"])]));
    // `compiler/input-missing` is still waiting (notYet), and an ERROR: a script's output is meant to render.
    expect(refusalOf(built)).toContain(`compiler/input-missing: "${LAMP}" (level): Input "input" on "${LAMP}" (level) is required but nothing is connected to it.`);
  });

  it("the same unwired node beside the picture is not an error at all, and saves", () => {
    const white = named("white", "solid", [0, 0]);
    const out = named("out", "output", [300, 0]);
    const spare = named("spare", "level", [0, 300]);
    const built = document("t1641b-spare", "T1641b spare", small, graph([white, out, spare], [edge("e_white", [white.id, "out"], [out.id, "input"])]));
    expect(refusalOf(built)).toBeNull();
  });

  it("a type this build lacks IN the picture's path is refused, where beside it it was let through", () => {
    const built = lampDocument(0.5);
    const lamp = built.graph.nodes[LAMP];
    if (lamp === undefined) throw new Error("fixture");
    built.graph.nodes[LAMP] = { ...lamp, type: "aurora", parameters: {} };
    const refusal = refusalOf(built);
    expect(refusal).toContain("compiler/unknown-node-type:");
    expect(refusal).toContain('has unknown type "aurora"');
  });
});
