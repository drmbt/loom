import { describe, expect, it } from "vitest";
import { conformsToKind } from "../../domain/graph/node-kinds.ts";
import { mechanicalRole, nameFor, restatedKind, thinRole } from "./rename-rules.ts";

/**
 * THE RULES THAT RENAME 3,000 SHIPPED NODES (T1593b phase 2a).
 *
 * The sweep's promise to somebody who knows an example is that they will still know its
 * nodes afterwards: the author's word is kept and only the old naming HABIT is taken off.
 * Each case here is one way that promise could be broken, with the name it must give.
 */

const none: ReadonlySet<string> = new Set();

describe("the role a name already says", () => {
  it("takes off the 1 the habit added to the node's id, and keeps the author's spelling", () => {
    expect(mechanicalRole("dye", "dye1", none)).toEqual({ role: "dye", rule: "habit" });
    // The label's capitals are the author's, not the id's.
    expect(mechanicalRole("raysB", "raysB1", none)).toEqual({ role: "raysB", rule: "habit" });
    expect(mechanicalRole("orbAx", "orbax1", none)).toEqual({ role: "orbax", rule: "habit" });
  });

  it("keeps a digit that was the author's: only the LAST 1 is the habit", () => {
    // `streak0`, `streak1`, `streak2` were labelled `streak01`, `streak11`, `streak21`. Read
    // as a run they would become car 1, car 11 and car 21.
    expect(mechanicalRole("streak0", "streak01", new Set(["streak11", "streak21"]))).toEqual({ role: "streak0", rule: "habit" });
    expect(mechanicalRole("streak1", "streak11", new Set(["streak01", "streak21"]))).toEqual({ role: "streak1", rule: "habit" });
  });

  it("sees the habit through an id the builder spelled with an underscore", () => {
    expect(mechanicalRole("geo_car0", "geocar01", new Set(["geocar11"]))).toEqual({ role: "geocar0", rule: "habit" });
  });

  it("sees the habit behind the x an author put after an id that ends in a number", () => {
    // `band109` could not become `band1091`, so it was labelled `band109x1`.
    expect(mechanicalRole("band109", "band109x1", none)).toEqual({ role: "band109", rule: "habit" });
    // An id that does not end in a digit never got an x: `boxx1` is the node `boxx`.
    expect(mechanicalRole("boxx", "boxx1", none)).toEqual({ role: "boxx", rule: "habit" });
  });

  it("keeps the number of a node that is the first of a run", () => {
    // `soften1` beside `soften2`: taking the 1 off would leave `blur_soften` and `blur_soften2`.
    expect(mechanicalRole("soften", "soften1", new Set(["soften2"]))).toEqual({ role: "soften1", rule: "series" });
    expect(mechanicalRole("soften2", "soften2", new Set(["soften1"]))).toEqual({ role: "soften2", rule: "series" });
  });

  it("drops a lone 1 from a word that is not the id, and keeps any other number", () => {
    expect(mechanicalRole("lcap", "lum1", none)).toEqual({ role: "lum", rule: "number" });
    expect(mechanicalRole("mark2", "mark2a", none)).toEqual({ role: "mark2a", rule: "as-is" });
    expect(mechanicalRole("x", "take3", none)).toEqual({ role: "take3", rule: "series" });
  });

  it("leaves a name with no number as it is", () => {
    expect(mechanicalRole("dim", "dim", none)).toEqual({ role: "dim", rule: "as-is" });
  });
});

describe("a role that says the kind again", () => {
  it("finds the kind in the author's own short form, at either end", () => {
    expect(restatedKind("wallgrid", "grid")).toEqual({ rest: "wall", word: "grid", at: "suffix" });
    expect(restatedKind("floorpts", "grid")).toEqual({ rest: "floor", word: "pts", at: "suffix" });
    expect(restatedKind("matFloor", "material")).toEqual({ rest: "floor", word: "mat", at: "prefix" });
    expect(restatedKind("geo_car0", "geometry")).toEqual({ rest: "car0", word: "geo", at: "prefix" });
  });

  it("takes the capital off what followed, because the underscore is the joint now", () => {
    expect(restatedKind("noteBanks", "note")?.rest).toBe("banks");
    // A capital that is a name of its own is not a joint. A person decides `camA`.
    expect(restatedKind("camA", "camera")?.rest).toBe("A");
  });

  it("says a role that is ONLY the kind has nothing left", () => {
    expect(restatedKind("out", "output")?.rest).toBe("");
    expect(restatedKind("cam", "webcam")?.rest).toBe("");
    // A piece of the kind's own word, which is how an instance restates its component.
    expect(restatedKind("analysis", "audioanalysis")).toEqual({ rest: "", word: "analysis", at: "whole" });
  });

  it("does not find a kind in a role that merely shares letters with it", () => {
    expect(restatedKind("dye", "feedback")).toBeNull();
    // Two letters are not a word: `in` is inside `screenin`, and a node called `in` is not restating it.
    expect(restatedKind("in", "screenin")).toBeNull();
  });
});

describe("a role too thin to leave to a rule", () => {
  it("is one or two characters, or only a number", () => {
    expect(thinRole("s")).toBe(true);
    expect(thinRole("hd")).toBe(true);
    expect(thinRole("1300")).toBe(true);
    expect(thinRole("rim")).toBe(false);
  });
});

describe("the name a role becomes", () => {
  it("is kind_role", () => {
    expect(nameFor("feedback", "dye", 1)).toBe("feedback_dye");
  });

  it("is the kind and a number when there is no role, which is what auto-naming gives", () => {
    expect(nameFor("output", "", 1)).toBe("output1");
    // A role that is only a number IS that number: `renderpoints2` is `points2`.
    expect(nameFor("points", "2", 1)).toBe("points2");
  });

  it("always carries its kind", () => {
    for (const [kind, role] of [["lfo", "pathx"], ["camera", "A"], ["grid", "ring0Inset"], ["range", "band1300"], ["mesh", ""]] as const) {
      expect(conformsToKind(nameFor(kind, role, 1), kind)).toBe(true);
    }
  });
});
