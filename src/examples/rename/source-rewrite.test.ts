import { describe, expect, it } from "vitest";
import { rewriteDocumentSource, rewritePage, rewriteTest, type NameTable } from "./source-rewrite.ts";

/**
 * RENAMING NODES IN THE SOURCE THAT BUILDS A DOCUMENT (T1593b phase 2a).
 *
 * A source file holds a node's name next to a great many strings that look just like one:
 * its id, a port, an edge's id, a parameter's value. Moving one of those changes what the
 * document IS (an id is an address every edge is written against), and nothing would say
 * so until an example rendered differently. So each case here is a string that must move,
 * beside one that must not.
 */

function table(names: Record<string, string>, more: Partial<{ typed: Record<string, string>; clash: string[]; idsToo: string[] }> = {}): NameTable {
  return {
    names: new Map(Object.entries(names)),
    typed: new Map(Object.entries(more.typed ?? {})),
    clash: new Set(more.clash ?? []),
    idsToo: new Set(more.idsToo ?? []),
  };
}

describe("a document's source", () => {
  it("moves the label and leaves the id, even when they are the same word", () => {
    const source = `node("dim", "level", [0, 0], { brightness: 1 }, { label: "dim" });\nedge("e1", ["dim", "out"], ["out", "input"]);`;
    const done = rewriteDocumentSource("x.ts", source, table({ dim: "level_dim" }, { typed: { "level\ndim": "level_dim" }, idsToo: ["dim"] }));
    expect(done.text).toBe(`node("dim", "level", [0, 0], { brightness: 1 }, { label: "level_dim" });\nedge("e1", ["dim", "out"], ["out", "input"]);`);
    expect(done.changed).toBe(1);
  });

  it("moves the names a parameter holds, in order, and only on a type whose parameter holds names", () => {
    const source = [
      `node("shot", "render", [0, 0], { scenes: "dots1 links1", camera: "cam1", lights: "" }, { label: "shot1" });`,
      // `source` on a Feedback names a node. On a shader node it is the shader.
      `node("vel", "feedback", [0, 0], { source: "stir1" }, { label: "vel1" });`,
      `node("fx", "customWgsl", [0, 0], { source: "stir1" }, { label: "fx1" });`,
    ].join("\n");
    const done = rewriteDocumentSource("x.ts", source, table(
      { dots1: "geometry_dots", links1: "geometry_links", cam1: "camera1", shot1: "render_shot", stir1: "wgsl_stir", vel1: "feedback_velocity" },
      { typed: { "render\nshot1": "render_shot", "feedback\nvel1": "feedback_velocity" } },
    ));
    expect(done.text).toContain(`scenes: "geometry_dots geometry_links", camera: "camera1"`);
    expect(done.text).toContain(`node("vel", "feedback", [0, 0], { source: "wgsl_stir" }, { label: "feedback_velocity" })`);
    expect(done.text).toContain(`scenes: "geometry_dots geometry_links", camera: "camera1", lights: "" }, { label: "render_shot" }`);
    expect(done.text).toContain(`node("fx", "customWgsl", [0, 0], { source: "stir1" }, { label: "fx1" })`);
  });

  it("moves a channel read, keeping the channel", () => {
    const source = `{ amount: drivenSlot("glim1:high", 0), size: expressionSlot("op('lag1').chan.bar * 2", 1) }`;
    const done = rewriteDocumentSource("x.ts", source, table({ glim1: "limit_glitch", lag1: "lag_cut" }));
    expect(done.text).toBe(`{ amount: drivenSlot("limit_glitch:high", 0), size: expressionSlot("op('lag_cut').chan.bar * 2", 1) }`);
  });

  it("moves the keys of a record that is keyed by node name", () => {
    const source = `const BANK = [{ name: "dirty", values: { shear: { weight: 1 }, glitch: { value: 1 } }, on: { shear: true } }];`;
    const done = rewriteDocumentSource("x.ts", source, table({ shear: "displace_shear", glitch: "hsv_glitch", dirty: "never" }));
    // `name` is the PRESET's name. A preset called like a node is not that node.
    expect(done.text).toBe(`const BANK = [{ name: "dirty", values: { displace_shear: { weight: 1 }, hsv_glitch: { value: 1 } }, on: { displace_shear: true } }];`);
  });

  it("reads a label by the type beside it, so two nodes that shared a word do not share a fate", () => {
    const source = [
      `node("cut", "mask", [0, 0], {}, { label: "cut1" });`,
      `node("edge", "threshold", [0, 0], {}, { label: "cut1" });`,
      // A Grid called `grid1` already carries its kind. Some other document's Tile called `grid1` does not.
      `const grid = { id: "grid", type: "pointGrid", label: "grid1" };`,
      `const tile = { id: "wall", type: "tile", label: "grid1" };`,
    ].join("\n");
    const done = rewriteDocumentSource("x.ts", source, table({ grid1: "tile_grid" }, { typed: { "mask\ncut1": "mask_cut", "threshold\ncut1": "threshold_cut", "tile\ngrid1": "tile_grid" } }));
    expect(done.text).toContain(`"mask", [0, 0], {}, { label: "mask_cut" }`);
    expect(done.text).toContain(`"threshold", [0, 0], {}, { label: "threshold_cut" }`);
    expect(done.text).toContain(`type: "pointGrid", label: "grid1"`);
    expect(done.text).toContain(`type: "tile", label: "tile_grid"`);
  });

  it("says where a name is built by code, and where two documents disagree, and changes neither", () => {
    const source = "node(id, \"light\", [0, 0], {}, { label: `${id}1` });\nconst read = \"op('matte1').chan.ready\";";
    const done = rewriteDocumentSource("x.ts", source, table({}, { clash: ["matte1"] }));
    expect(done.text).toBe(source);
    expect(done.notes).toEqual([
      "line 1: a name is built here, not written: `${id}1`",
      "line 2: op('matte1') is renamed differently in two documents this file builds",
    ]);
  });

  it("leaves an edge's id alone though it is made of two names", () => {
    const source = `edge("e-rd1-rd2", ["rd", "out"], ["rd2", "input"]); // rd1 feeds rd2`;
    const done = rewriteDocumentSource("x.ts", source, table({ rd1: "wgsl_reaction1", rd2: "wgsl_reaction2" }, { idsToo: ["rd2"] }));
    // The comment is prose about the nodes, so it follows them. The id is an address.
    expect(done.text).toBe(`edge("e-rd1-rd2", ["rd", "out"], ["rd2", "input"]); // wgsl_reaction1 feeds wgsl_reaction2`);
  });
});

describe("a test that names nodes", () => {
  it("moves a literal that is a name, and shows one that is also an id instead of guessing", () => {
    const source = `expect(byLabel("rd1")).toBeDefined();\nexpect(labelled("dim")).toBeDefined();\nexpect(source).toBe("op('rd1').chan.x");`;
    const done = rewriteTest("x.test.ts", source, table({ rd1: "wgsl_reaction", dim: "level_dim" }, { idsToo: ["dim"] }));
    expect(done.text).toBe(`expect(byLabel("wgsl_reaction")).toBeDefined();\nexpect(labelled("dim")).toBeDefined();\nexpect(source).toBe("op('wgsl_reaction').chan.x");`);
    expect(done.notes).toEqual([`line 2: "dim" is a node's name and, here or in another document, a node's id: left alone`]);
  });

  /*
   * The literal mistake of the sweep's first batch. `cut1` is the name of a node inside
   * DepthCut. A test of DepthCut's ports gave its own instance the ID `cut1`, the tool took
   * the four strings for the name and renamed them, and the record still keyed `cut1` no
   * longer held the node its edges pointed at. Nothing failed: every edge moved together.
   * It was simply no longer the fixture its author wrote.
   */
  it("never moves a string written as an id, though the word is a name in another document", () => {
    const fixture = [
      `const instance = node("cut1", componentNodeType("depthCut", 1));`,
      `const edges = { e: { source: { nodeId: "cut1", portId: "out" } } };`,
      `edge("e2", ["cut1", "out"], ["sink", "input"]);`,
      `expect(graph.nodes["cut1"]).toBe(instance);`,
    ].join("\n");
    const reads = `expect(byLabel("cut1")).toBeDefined();`;
    const done = rewriteTest("x.test.ts", `${fixture}\n${reads}`, table({ cut1: "mask_cut" }));
    // The four ids are what they were. The one string that asks for the NAME moved.
    expect(done.text).toBe(`${fixture}\nexpect(byLabel("mask_cut")).toBeDefined();`);
    expect(done.notes).toEqual([1, 2, 3, 4].map((line) => `line ${String(line)}: "cut1" is written as a node's ID here, and is a node's name elsewhere: an id is never moved`));
  });
});

describe("the page beside an example", () => {
  it("moves the claim a gate checks, the name in backticks and the name in prose", () => {
    const page = "```\nbeat1(audioPattern) ─► clock1(valueSwitch, index 0)\n```\nEvery lane reads `clock1`, never beat1. The `hsv` turn is one node.";
    const done = rewritePage(page, table({ beat1: "pattern_beat", clock1: "switch_clock" }));
    expect(done.text).toBe("```\npattern_beat(audioPattern) ─► switch_clock(valueSwitch, index 0)\n```\nEvery lane reads `switch_clock`, never pattern_beat. The `hsv` turn is one node.");
  });

  it("does not take an ordinary word for the node that was named after it", () => {
    // E82 has a node called `out`. Its page also says "fades out".
    const done = rewritePage("The set fades out. `out` is the Output, drawn as out(output).", table({ out: "output1" }));
    expect(done.text).toBe("The set fades out. `output1` is the Output, drawn as output1(output).");
  });

  /*
   * A diagram is read by its COLUMNS: `─┐` on one line meets `─┴─►` on the next because they
   * stand in the same column. A longer name pushes one line's junction right and not the
   * other's. Nothing fails. The page still parses and every claim in it is still true; the
   * drawing just no longer connects.
   */
  it("keeps a diagram's junctions in one column when the names on its lines grow by different amounts", () => {
    const page = [
      "```",
      "a1(noise) ─► warp1.source ─┐",
      "b1(noise) ──► warp1.disp ──┴─► warp1(displace) ─► out",
      "                           │",
      "c1(lfo) ───────────────────┘",
      "```",
    ].join("\n");
    const done = rewritePage(page, table({ a1: "noise_broad", b1: "noise_b", warp1: "displace_warp", c1: "lfo_c" }));
    const [, first = "", second = "", bar = "", last = ""] = done.text.split("\n");
    // Every name moved…
    expect(first).toContain("noise_broad(noise) ─► displace_warp.source");
    expect(second).toContain("noise_b(noise)");
    expect(second).toContain("displace_warp(displace) ─► out");
    expect(last).toContain("lfo_c(lfo)");
    // …and the four ends of the junction are still one above the other.
    const column = first.indexOf("┐");
    expect([second.indexOf("┴"), bar.indexOf("│"), last.indexOf("┘")]).toEqual([column, column, column]);
    // Padded with what was already there, and nothing else: a line of spaces stays spaces.
    expect(bar.trim()).toBe("│");
    expect(last).toMatch(/^lfo_c\(lfo\) ─+┘$/);
  });

  it("leaves a fence that is not a diagram exactly as long as its names make it", () => {
    const page = "```\nset  beat1.amount   0.5\nset  clock1.index   1\n```";
    const done = rewritePage(page, table({ beat1: "pattern_beat", clock1: "switch_clock" }));
    expect(done.text).toBe("```\nset  pattern_beat.amount   0.5\nset  switch_clock.index   1\n```");
  });
});
