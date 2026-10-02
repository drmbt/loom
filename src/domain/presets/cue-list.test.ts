import { describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode } from "../types/graph.ts";
import { countNodeNameReferences, rewriteNodeNameReferences } from "../graph/names.ts";
import {
  EMPTY_CUE_LIST_JSON,
  cueAfter,
  cueNamed,
  nextCueName,
  parseCueList,
  previousCue,
  serializeCueList,
  standbyCue,
  type Cue,
  type CueList,
} from "./cue-list.ts";

/**
 * T1500b (§T1398b S5) — the cue list's DATA: what parses, and where GO and BACK land.
 *
 * "Next" is derived, never stored (the design doc §8.2), so these are the functions every
 * surface and every command share. The cases that matter are the ones where a wrong
 * answer fires the wrong cue on stage: a standby that names a cue no longer in the list
 * must be a refusal and never a fallback to cue 1.
 */

const cue = (name: string, bank = "looks", preset = "a"): Cue => ({ name, bank, preset });
const list = (...cues: Cue[]): CueList => ({ version: 1, cues });
const three = list(cue("1"), cue("2", "fx", "dirty"), cue("3", "looks", "b"));

describe("parseCueList (T1500b)", () => {
  it("round-trips a list with a morph and a note, and reads blank text as empty", () => {
    const full = list({ name: "1", bank: "shots", preset: "intro", morph: { seconds: 4, curve: "smooth" }, note: "house lights down" }, cue("2a"));
    expect(parseCueList(serializeCueList(full))).toEqual({ ok: true, list: full });
    expect(parseCueList("")).toEqual({ ok: true, list: list() });
    expect(parseCueList(EMPTY_CUE_LIST_JSON)).toEqual({ ok: true, list: list() });
  });

  it.each([
    ["not JSON", "{", "not valid JSON"],
    ["another version", JSON.stringify({ version: 2, cues: [] }), "unknown version"],
    ["no cues list", JSON.stringify({ version: 1 }), "no cues list"],
    ["a cue with no name", JSON.stringify({ version: 1, cues: [{ bank: "b", preset: "p" }] }), "cue 1 needs a name"],
    ["a name padded with spaces", JSON.stringify({ version: 1, cues: [{ name: " 1", bank: "b", preset: "p" }] }), "cue 1 needs a name"],
    ["a cue with no bank", JSON.stringify({ version: 1, cues: [{ name: "1", preset: "p" }] }), 'cue "1": bank'],
    ["a cue with no preset", JSON.stringify({ version: 1, cues: [{ name: "1", bank: "b" }] }), 'cue "1": preset'],
    ["a negative morph", JSON.stringify({ version: 1, cues: [{ name: "1", bank: "b", preset: "p", morph: { seconds: -1, curve: "linear" } }] }), 'cue "1": morph'],
    ["an unknown curve", JSON.stringify({ version: 1, cues: [{ name: "1", bank: "b", preset: "p", morph: { seconds: 1, curve: "bounce" } }] }), 'cue "1": morph'],
    ["a note that is not text", JSON.stringify({ version: 1, cues: [{ name: "1", bank: "b", preset: "p", note: 3 }] }), 'cue "1": note'],
  ])("refuses %s, naming the cue and the field", (_what, text, reason) => {
    const parsed = parseCueList(text);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.reason).toContain(reason);
  });

  it("refuses two cues with one name: GO, BACK and the standby all spell a cue by it", () => {
    const parsed = parseCueList(serializeCueList(list(cue("1"), cue("1", "fx", "dirty"))));
    expect(parsed).toEqual({ ok: false, reason: 'two cues are named "1"' });
  });
});

describe("the cue GO fires is DERIVED: standby, else the cue after current, else the first (T1500b)", () => {
  const at = (current: string, standby = "", wrap = false) => ({ current, standby, wrap });
  const fired = (pick: ReturnType<typeof standbyCue>): string => (pick.ok ? pick.cue.name : `refused:${pick.code}`);

  it("is the first cue before any GO, and the cue after current once one has fired", () => {
    expect(fired(standbyCue(three, at("")))).toBe("1");
    expect(fired(standbyCue(three, at("1")))).toBe("2");
    expect(fired(standbyCue(three, at("2")))).toBe("3");
  });

  it("is the standby when one is set, wherever current is", () => {
    expect(fired(standbyCue(three, at("1", "3")))).toBe("3");
    expect(fired(standbyCue(three, at("3", "1")))).toBe("1");
    expect(fired(standbyCue(three, at("", "2")))).toBe("2");
  });

  it("past the last cue is refused without wrap, and the first cue with it", () => {
    expect(fired(standbyCue(three, at("3")))).toBe("refused:cue.go.end");
    expect(fired(standbyCue(three, at("3", "", true)))).toBe("1");
  });

  it("a standby or current naming a cue that is gone is REFUSED — never a quiet jump to cue 1", () => {
    expect(fired(standbyCue(three, at("1", "9")))).toBe("refused:cue.standby.unknown");
    expect(fired(standbyCue(three, at("9")))).toBe("refused:cue.current.unknown");
    // …and with wrap on too: wrap is about the END of the list, not about a missing cue.
    expect(fired(standbyCue(three, at("9", "", true)))).toBe("refused:cue.current.unknown");
  });

  it("an empty list has nothing to fire", () => {
    expect(fired(standbyCue(list(), at("")))).toBe("refused:cue.go.empty");
  });

  it("`next`, as a surface shows it, is the same derivation — null where GO would be refused", () => {
    expect(nextCueName(three, at("1"))).toBe("2");
    expect(nextCueName(three, at("3"))).toBeNull();
    expect(nextCueName(three, at("3", "", true))).toBe("1");
  });

  it("BACK is the cue before current; it ignores the standby and does not wrap", () => {
    const back = (current: string, standby = "", wrap = false): string => {
      const pick = previousCue(three, at(current, standby, wrap));
      return pick.ok ? pick.cue.name : `refused:${pick.code}`;
    };
    expect(back("3")).toBe("2");
    expect(back("2", "3")).toBe("1");
    expect(back("1")).toBe("refused:cue.back.start");
    expect(back("1", "", true)).toBe("refused:cue.back.start");
    expect(back("")).toBe("refused:cue.back.unfired");
    expect(back("9")).toBe("refused:cue.current.unknown");
  });

  it("after a cue fires, the standby is the one after it — the first on a wrap, none at the end", () => {
    expect(cueAfter(three, 0, false)?.name).toBe("2");
    expect(cueAfter(three, 2, false)).toBeUndefined();
    expect(cueAfter(three, 2, true)?.name).toBe("1");
  });

  it("a cue is found by name, and an unknown one says which cues exist", () => {
    expect(fired(cueNamed(three, "2"))).toBe("2");
    const missing = cueNamed(three, "7");
    expect(missing.ok ? "" : `${missing.reason} | ${missing.suggestion}`).toBe('it has no cue "7" | Its cues: 1, 2, 3.');
  });
});

describe("a rename carries a cue's bank name, and only that (§V128, §V320, T1500b)", () => {
  function graphWith(cues: CueList, extra: Record<string, string> = {}): GraphDocument {
    const node: GraphNode = {
      id: "list",
      type: "cueList",
      label: "set",
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      parameters: { cues: serializeCueList(cues), ...extra },
    };
    return { revision: 0, nodes: { list: node }, edges: {}, groups: {} };
  }
  const cuesOf = (graph: GraphDocument): readonly Cue[] => {
    const parsed = parseCueList(graph.nodes["list"]?.parameters["cues"]);
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.list.cues;
  };

  it("rewrites every cue naming the bank, leaves the other bank alone, and counts one reference", () => {
    const graph = graphWith(three);
    expect(countNodeNameReferences(graph, "looks")).toBe(1);
    expect(countNodeNameReferences(graph, "nobody")).toBe(0);
    expect(rewriteNodeNameReferences(graph, "looks", "city")).toBe(1);
    expect(cuesOf(graph).map((each) => each.bank)).toEqual(["city", "fx", "city"]);
  });

  it("does not touch a cue NAME, a PRESET name or the list's position that share the spelling", () => {
    // A node called "a" is renamed: the cue named "a", the preset "a" and standby "a" are
    // not node names, so nothing here refers to it.
    const graph = graphWith(list({ name: "a", bank: "looks", preset: "a" }), { current: "a", standby: "a" });
    expect(countNodeNameReferences(graph, "a")).toBe(0);
    expect(rewriteNodeNameReferences(graph, "a", "z")).toBe(0);
    expect(cuesOf(graph)).toEqual([{ name: "a", bank: "looks", preset: "a" }]);
    expect(graph.nodes["list"]?.parameters["standby"]).toBe("a");
  });

  it("leaves a malformed list exactly as the user typed it", () => {
    const graph = graphWith(three);
    graph.nodes["list"]!.parameters["cues"] = "{ looks";
    expect(rewriteNodeNameReferences(graph, "looks", "city")).toBe(0);
    expect(graph.nodes["list"]?.parameters["cues"]).toBe("{ looks");
  });
});
