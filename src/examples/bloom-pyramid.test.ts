import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GraphDocument } from "../domain/types/graph.ts";
import { bloomPyramidGraph, type BloomPyramidOptions } from "./bloom-pyramid.ts";

// These files predate the shared recipe. They independently preserve the projects'
// shader bytes, stable identities, explicit Multi input order and rounded scale chain.
// Do not regenerate them to make this test pass: a deliberate picture change needs its
// own migration proof. The recipe must reproduce their filtering subgraphs exactly.
const ids = {
  bright: "bright",
  down: ["bloomDown1", "bloomDown2", "bloomDown3", "bloomDown4"],
  up: ["bloomUp0", "bloomUp1", "bloomUp2", "bloomUp3"],
} as const;

const cases: readonly { file: string; options: BloomPyramidOptions }[] = [
  {
    file: "projects/furnace/furnace.loom.json",
    options: {
      ids, edgePrefix: "bloom",
      layout: { bright: [-1200, 300], down: [-900, 300], up: [-600, 150], step: [0, 150] },
      threshold: 2, knee: 1.5, firstClampLuma: 1, lower: 1,
    },
  },
  {
    file: "projects/sentinel-bot/sentinel.loom.json",
    options: {
      ids: {
        bright: "wgsl_bright",
        down: ["wgsl_bloomdown1", "wgsl_bloomdown2", "wgsl_bloomdown3", "wgsl_bloomdown4"],
        up: ["wgsl_bloomup0", "wgsl_bloomup1", "wgsl_bloomup2", "wgsl_bloomup3"],
      },
      edgePrefix: "bloom",
      // The Sentinel canvas applies its existing spread to every node once.
      layout: { bright: [-840, 450], down: [-420, 450], up: [0, 225], step: [0, 225] },
      threshold: 1.4, knee: 1, firstClampLuma: 1, lower: 1,
    },
  },
  {
    file: "projects/on-nothing/cyc.loom.json",
    options: {
      ids, edgePrefix: "bloom",
      layout: { bright: [-1300, 300], down: [-900, 300], up: [-700, 150], step: [0, 150] },
      // The white-limbo finish is the same graph with values, including no firefly filter.
      threshold: 0, knee: 0.001, firstClampLuma: 0, lower: 1.4,
    },
  },
];

describe("the shared bloom recipe preserves independent saved project graphs", () => {
  it.each(cases)("retains the exact filtering graph in $file", ({ file, options }) => {
    const saved = (JSON.parse(readFileSync(file, "utf8")) as { graph: GraphDocument }).graph;
    const recipe = bloomPyramidGraph(options);
    expect(recipe.nodes).toHaveLength(9);
    expect(recipe.edges).toHaveLength(12);
    for (const node of recipe.nodes) expect(node, node.id).toEqual(saved.nodes[node.id]);
    for (const edge of recipe.edges) expect(edge, edge.id).toEqual(saved.edges[edge.id]);
    const selected = new Set(recipe.nodes.map(node => node.id));
    expect(Object.values(saved.edges).filter(edge => selected.has(edge.source.nodeId) && selected.has(edge.target.nodeId)))
      .toHaveLength(recipe.edges.length);
    expect(recipe.bright).toEqual([options.ids.bright, "out"]);
    expect(recipe.glow).toEqual([options.ids.up[0], "out"]);
  });
});
