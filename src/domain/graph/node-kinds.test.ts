import { describe, expect, it } from "vitest";

import {
  COMPONENT_KIND,
  KIND_FAMILIES,
  NODE_KINDS,
  SOCKET_NAMED_TYPES,
  conformsToKind,
  conventionalName,
  kindBindsName,
  kindOfType,
  roleFromText,
  roleOf,
  withKind,
} from "./node-kinds.ts";

/**
 * `kind_role` (T1593b). The owner's reason is the test of every case below: a name has to
 * say what KIND of node it is, on the canvas and inside `op('…')`, and it has to say it in
 * a way that parses one way only. So these pin the exact strings, not "some prefix".
 */
describe("conformsToKind: the one answer to whether a name carries a kind", () => {
  it("accepts the three forms and nothing else", () => {
    expect(conformsToKind("blur", "blur")).toBe(true);
    expect(conformsToKind("blur1", "blur")).toBe(true);
    expect(conformsToKind("blur12", "blur")).toBe(true);
    expect(conformsToKind("blur_diffuse", "blur")).toBe(true);
    expect(conformsToKind("lfo_path_x", "lfo")).toBe(true);
    expect(conformsToKind("geometry_car01", "geometry")).toBe(true);
    expect(conformsToKind("geometry_01", "geometry")).toBe(true);
  });

  it("refuses a bare role, which is what 96 % of shipped names are today", () => {
    expect(conformsToKind("dye1", "feedback")).toBe(false);
    expect(conformsToKind("lamp", "slider")).toBe(false);
    expect(conformsToKind("pathx1", "lfo")).toBe(false);
  });

  it("is not fooled by a name that merely STARTS with the letters of the kind", () => {
    // `camerablur1` is a Camera Blur's auto-name; it does not make that node a camera.
    expect(conformsToKind("camerablur1", "camera")).toBe(false);
    expect(conformsToKind("blurry", "blur")).toBe(false);
    expect(conformsToKind("instances1", "in")).toBe(false);
    expect(conformsToKind("screenin1", "screen")).toBe(false);
  });

  it("needs a role after the underscore, made only of what a name may hold", () => {
    expect(conformsToKind("blur_", "blur")).toBe(false);
    expect(conformsToKind("blur__x", "blur")).toBe(false);
    expect(conformsToKind("blur_my glow", "blur")).toBe(false);
    expect(conformsToKind("blur_a.b", "blur")).toBe(false);
    expect(conformsToKind("blur_a,b", "blur")).toBe(false);
    expect(conformsToKind("blur_a:b", "blur")).toBe(false);
    expect(conformsToKind("blur-soft", "blur")).toBe(false);
  });

  it("is case-sensitive, because a name is an identifier", () => {
    expect(conformsToKind("Blur_soft", "blur")).toBe(false);
    expect(conformsToKind("blur_Soft", "blur")).toBe(true);
  });

  it("takes letters and digits of any script in the role", () => {
    expect(conformsToKind("blur_weichzeichner", "blur")).toBe(true);
    expect(conformsToKind("blur_ぼかし", "blur")).toBe(true);
    expect(conformsToKind("blur_größe2", "blur")).toBe(true);
  });
});

describe("withKind and roleOf: composing and reading back", () => {
  it("joins with one underscore, and a missing role leaves the bare kind", () => {
    expect(withKind("slider", "lamp")).toBe("slider_lamp");
    expect(withKind("kernel", "joints")).toBe("kernel_joints");
    expect(withKind("blur", "")).toBe("blur");
  });

  it("reads the role back; a bare or numbered name has none; a foreign name is null", () => {
    expect(roleOf("slider_lamp", "slider")).toBe("lamp");
    expect(roleOf("lfo_path_x", "lfo")).toBe("path_x");
    expect(roleOf("blur", "blur")).toBe("");
    expect(roleOf("blur1", "blur")).toBe("");
    expect(roleOf("dye1", "feedback")).toBeNull();
    expect(roleOf("camerablur1", "camera")).toBeNull();
  });

  it("round-trips every name that carries a role", () => {
    for (const [kind, role] of [["slider", "lamp"], ["lfo", "path_x"], ["geometry", "car01"]] as const) {
      expect(roleOf(withKind(kind, role), kind)).toBe(role);
    }
  });
});

describe("roleFromText: free text as a role", () => {
  it("turns each run of characters a name may not hold into one underscore", () => {
    expect(roleFromText("Bloom pass")).toBe("Bloom_pass");
    expect(roleFromText("key / fill")).toBe("key_fill");
    expect(roleFromText("a.b,c:d")).toBe("a_b_c_d");
    expect(roleFromText("path-x")).toBe("path_x");
  });

  it("trims the ends, and has nothing to say about text with no letters or digits", () => {
    expect(roleFromText("  lamp  ")).toBe("lamp");
    expect(roleFromText("_lamp_")).toBe("lamp");
    expect(roleFromText("!!!")).toBe("");
    expect(roleFromText("")).toBe("");
  });

  it("leaves a role that is already one alone", () => {
    expect(roleFromText("path_x")).toBe("path_x");
    expect(roleFromText("car01")).toBe("car01");
  });
});

describe("conventionalName: what a typed name becomes, for every door", () => {
  it("puts the kind in front of a bare role", () => {
    expect(conventionalName("lamp", "slider")).toEqual({ name: "slider_lamp", prefixed: true });
    expect(conventionalName("joints", "pointKernel")).toEqual({ name: "kernel_joints", prefixed: true });
    expect(conventionalName("Bloom pass", "blur")).toEqual({ name: "blur_Bloom_pass", prefixed: true });
  });

  it("takes a name that already carries the kind exactly as typed", () => {
    expect(conventionalName("slider_lamp", "slider")).toEqual({ name: "slider_lamp", prefixed: false });
    expect(conventionalName("blur2", "blur")).toEqual({ name: "blur2", prefixed: false });
    expect(conventionalName("blur", "blur")).toEqual({ name: "blur", prefixed: false });
  });

  it("does not prefix twice when the typed text carries the kind in a looser spelling", () => {
    expect(conventionalName("blur soft", "blur")).toEqual({ name: "blur_soft", prefixed: false });
    expect(conventionalName("Blur_soft", "blur")).toEqual({ name: "blur_soft", prefixed: false });
    expect(conventionalName("BLUR2", "blur")).toEqual({ name: "blur2", prefixed: false });
  });

  it("still prefixes a word that only begins like the kind", () => {
    expect(conventionalName("blurry", "blur")).toEqual({ name: "blur_blurry", prefixed: true });
    expect(conventionalName("lighthouse", "light")).toEqual({ name: "light_lighthouse", prefixed: true });
  });

  it("trims, and hands blank or unusable text back untouched for the caller to refuse", () => {
    expect(conventionalName("  lamp  ", "slider")).toEqual({ name: "slider_lamp", prefixed: true });
    expect(conventionalName("   ", "slider")).toEqual({ name: "   ", prefixed: false });
    expect(conventionalName("!!!", "slider")).toEqual({ name: "!!!", prefixed: false });
  });

  it("leaves a component's In and Out alone: their name is the socket's label", () => {
    expect(conventionalName("depth", "componentIn")).toEqual({ name: "depth", prefixed: false });
    expect(conventionalName("picture", "componentOutValue")).toEqual({ name: "picture", prefixed: false });
  });

  it("names a component instance with the component kind", () => {
    expect(conventionalName("hall", "component:bloom@2")).toEqual({ name: "comp_hall", prefixed: true });
  });
});

describe("the kind table", () => {
  it("gives the long types the short kinds that were ruled", () => {
    expect(kindOfType("pointKernel")).toBe("kernel");
    expect(kindOfType("renderInstances")).toBe("instances");
    expect(kindOfType("meshFileIn")).toBe("mesh");
    expect(kindOfType("movieFileIn")).toBe("movie");
    expect(kindOfType("customWgsl")).toBe("wgsl");
    expect(kindOfType("materialWgsl")).toBe("material");
    expect(kindOfType("slider")).toBe("slider");
    expect(kindOfType("light")).toBe("light");
    expect(kindOfType("lfo")).toBe("lfo");
  });

  it("names every component instance `comp`, whatever the component", () => {
    expect(kindOfType("component:bloom@1")).toBe(COMPONENT_KIND);
    expect(kindOfType("component:depthPoints@3")).toBe("comp");
  });

  it("falls back to the old base for a type it does not hold, and is not fooled by Object's own keys", () => {
    expect(kindOfType("test.blur")).toBe("blur");
    expect(kindOfType("vendor.Fancy-Glow")).toBe("fancyglow");
    expect(kindOfType("constructor")).toBe("constructor");
    expect(kindOfType("toString")).toBe("tostring");
  });

  it("holds only lowercase letters, so the kind ends at the first underscore or digit", () => {
    const malformed = Object.entries(NODE_KINDS).filter(([, kind]) => !/^[a-z]+$/.test(kind));
    expect(malformed).toEqual([]);
    expect(/^[a-z]+$/.test(COMPONENT_KIND)).toBe(true);
  });

  it("keeps the component kind for components alone", () => {
    expect(Object.values(NODE_KINDS)).not.toContain(COMPONENT_KIND);
  });

  /**
   * UNIQUE, except the families that are declared. Derived from the table and held equal
   * to the declaration in BOTH directions: a new type that takes an existing kind fails
   * here by name, and so does a family entry the table no longer backs.
   */
  it("shares a kind between types only where KIND_FAMILIES says so", () => {
    const byKind = new Map<string, string[]>();
    for (const [type, kind] of Object.entries(NODE_KINDS)) byKind.set(kind, [...(byKind.get(kind) ?? []), type]);
    const shared = Object.fromEntries(
      [...byKind].filter(([, types]) => types.length > 1).map(([kind, types]) => [kind, [...types].sort()]),
    );
    const declared = Object.fromEntries(
      Object.entries(KIND_FAMILIES).map(([kind, types]) => [kind, [...types].sort()]),
    );
    expect(shared).toEqual(declared);
  });

  it("binds every type's name except a component's In and Out", () => {
    expect(kindBindsName("blur")).toBe(true);
    expect(kindBindsName("component:bloom@1")).toBe(true);
    expect([...SOCKET_NAMED_TYPES].sort()).toEqual([
      "componentIn",
      "componentInPoints",
      "componentInValue",
      "componentOut",
      "componentOutPoints",
      "componentOutValue",
    ]);
    for (const type of SOCKET_NAMED_TYPES) {
      expect(kindBindsName(type)).toBe(false);
      // Still auto-named with a kind: a new In is `in1`, not `componentin1`.
      expect(["in", "out"]).toContain(kindOfType(type));
    }
  });
});
