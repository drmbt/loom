import { describe, expect, it } from "vitest";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import { NODE_KINDS } from "../graph/node-kinds.ts";
import { referenceNameFor, timelineReferenceOf } from "./timeline-reference.ts";

const node = (id: string, type: string, label: string, playMode?: string): GraphNode =>
  ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, label, parameters: playMode === undefined ? {} : { playMode } }) as GraphNode;

const graphOf = (...nodes: GraphNode[]): GraphDocument =>
  ({ revision: 0, edges: {}, groups: {}, nodes: Object.fromEntries(nodes.map((each) => [each.id, each])) }) as GraphDocument;

describe("the timeline's reference media (VN64)", () => {
  it("is named from the kind table, so a kind change follows", () => {
    expect(referenceNameFor("movieFileIn")).toBe(`${NODE_KINDS["movieFileIn"]}_reference`);
    expect(referenceNameFor("audioFileIn")).toBe(`${NODE_KINDS["audioFileIn"]}_reference`);
  });

  it("is the node carrying the role, whatever its play mode", () => {
    const graph = graphOf(node("a", "movieFileIn", "movie_intro", "timeline"), node("b", "audioFileIn", "audiofile_reference"));
    expect(timelineReferenceOf(graph)).toEqual({ nodeId: "b", type: "audioFileIn", name: "audiofile_reference", how: "named", warning: null });
  });

  it("falls back to the ONE timeline-locked media node, and to nothing when there are two or none", () => {
    expect(timelineReferenceOf(graphOf(node("a", "movieFileIn", "movie_intro", "timeline"), node("b", "audioFileIn", "audiofile_bed"))))
      .toMatchObject({ nodeId: "a", how: "onlyLocked" });
    expect(timelineReferenceOf(graphOf(node("a", "movieFileIn", "movie_intro", "timeline"), node("b", "audioFileIn", "audiofile_bed", "timeline")))).toBeNull();
    expect(timelineReferenceOf(graphOf(node("a", "movieFileIn", "movie_intro")))).toBeNull();
    // The role on another kind of node is not the role: a constant named like one is ignored.
    expect(timelineReferenceOf(graphOf(node("c", "constant", "movie_reference")))).toBeNull();
  });

  it("picks the first by id when two carry the role, and says so", () => {
    const reference = timelineReferenceOf(graphOf(node("z", "audioFileIn", "audiofile_reference"), node("m", "movieFileIn", "movie_reference")));
    expect(reference).toMatchObject({ nodeId: "m", name: "movie_reference" });
    expect(reference?.warning).toContain('"audiofile_reference"');
  });
});
