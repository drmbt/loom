import { describe, expect, it } from "vitest";

import {
  COMPONENT_KIND,
  KIND_FAMILIES,
  NODE_KINDS,
  SOCKET_NAMED_TYPES,
  conformingFormOf,
  conformsToKind,
  conventionalName,
  kindBindsName,
  kindFromName,
  kindOf,
  kindOfType,
  roleFromText,
  roleOf,
  roleOrName,
  withKind,
  type KindSource,
} from "./node-kinds.ts";

/** A built-in type's definition, as far as naming needs it: the title plays no part. */
const of = (type: string): KindSource => ({ type, title: "" });
/** An instance of a component: the registry hands its definition the component's own name as title. */
const instanceOf = (name: string, id = "cmp_7", version = 1): KindSource => ({ type: `component:${id}@${version}`, title: name });

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
    expect(conventionalName("lamp", of("slider"))).toEqual({ name: "slider_lamp", prefixed: true });
    expect(conventionalName("joints", of("pointKernel"))).toEqual({ name: "kernel_joints", prefixed: true });
    expect(conventionalName("Bloom pass", of("blur"))).toEqual({ name: "blur_Bloom_pass", prefixed: true });
  });

  it("takes a name that already carries the kind exactly as typed", () => {
    expect(conventionalName("slider_lamp", of("slider"))).toEqual({ name: "slider_lamp", prefixed: false });
    expect(conventionalName("blur2", of("blur"))).toEqual({ name: "blur2", prefixed: false });
    expect(conventionalName("blur", of("blur"))).toEqual({ name: "blur", prefixed: false });
  });

  it("does not prefix twice when the typed text carries the kind in a looser spelling", () => {
    expect(conventionalName("blur soft", of("blur"))).toEqual({ name: "blur_soft", prefixed: false });
    expect(conventionalName("Blur_soft", of("blur"))).toEqual({ name: "blur_soft", prefixed: false });
    expect(conventionalName("BLUR2", of("blur"))).toEqual({ name: "blur2", prefixed: false });
  });

  it("still prefixes a word that only begins like the kind", () => {
    expect(conventionalName("blurry", of("blur"))).toEqual({ name: "blur_blurry", prefixed: true });
    expect(conventionalName("lighthouse", of("light"))).toEqual({ name: "light_lighthouse", prefixed: true });
  });

  it("trims, and hands blank or unusable text back untouched for the caller to refuse", () => {
    expect(conventionalName("  lamp  ", of("slider"))).toEqual({ name: "slider_lamp", prefixed: true });
    expect(conventionalName("   ", of("slider"))).toEqual({ name: "   ", prefixed: false });
    expect(conventionalName("!!!", of("slider"))).toEqual({ name: "!!!", prefixed: false });
  });

  it("leaves a component's In and Out alone: their name is the socket's label", () => {
    expect(conventionalName("depth", of("componentIn"))).toEqual({ name: "depth", prefixed: false });
    expect(conventionalName("picture", of("componentOutValue"))).toEqual({ name: "picture", prefixed: false });
  });

  it("names a component instance for its component", () => {
    expect(conventionalName("glow", instanceOf("Bloom"))).toEqual({ name: "bloom_glow", prefixed: true });
    expect(conventionalName("bloom_glow", instanceOf("Bloom"))).toEqual({ name: "bloom_glow", prefixed: false });
    expect(conventionalName("holo", instanceOf("Depth Points"))).toEqual({ name: "depthpoints_holo", prefixed: true });
  });
});

/**
 * RULED 2026-10-05: an instance of Bloom is `bloom_glow`, not `comp_glow`. To a reader it
 * is "a bloom" the way a Blur is "a blur". The kind is the component's own NAME, and the
 * tests below are about the three things that follow from a kind that is not in the type.
 */
describe("a component instance is named for its component", () => {
  it("makes the kind from the component's name, lowercased to the kind character set", () => {
    expect(kindFromName("Bloom")).toBe("bloom");
    expect(kindFromName("Depth Points")).toBe("depthpoints");
    expect(kindFromName("DepthPoints")).toBe("depthpoints");
    expect(kindFromName("Bloom 2")).toBe("bloom");
    expect(kindFromName("lo-fi_grade")).toBe("lofigrade");
  });

  it("is a kind like any other: letters only, so the name still parses one way", () => {
    for (const name of ["Bloom", "Depth Points", "Bloom 2", "lo-fi_grade", "3D Glow"]) {
      expect(/^[a-z]+$/.test(kindFromName(name)), name).toBe(true);
    }
  });

  it("falls back to `component` when the name holds no letter a kind can hold", () => {
    expect(COMPONENT_KIND).toBe("component");
    expect(kindFromName("2×2")).toBe("component");
    expect(kindFromName("光")).toBe("component");
    expect(kindFromName("")).toBe("component");
  });

  it("reads the kind from the definition's title, never from the opaque id in the type", () => {
    // A saved component's id is minted (`cmp_7`), not spelled from its name.
    expect(kindOf(instanceOf("Bloom", "cmp_7"))).toBe("bloom");
    expect(kindOf(instanceOf("Bloom", "zzz"))).toBe("bloom");
    expect(kindOf(of("pointKernel"))).toBe("kernel");
    // A built-in type's title plays no part.
    expect(kindOf({ type: "blur", title: "Anything At All" })).toBe("blur");
  });

  /*
   * The type string cannot answer, so it REFUSES rather than answer wrong. A quiet
   * `component` here is how an instance of Bloom would get named `component1` by a caller
   * that forgot it needed the definition.
   */
  it("refuses to name an instance from its type alone", () => {
    expect(() => kindOfType("component:bloom@1")).toThrow(/named for its component.*Use kindOf\(definition\)/);
  });

  it("lets a component share a word with a built-in kind: to the reader it is that kind of thing", () => {
    expect(kindOf(instanceOf("Blur"))).toBe("blur");
    expect(kindOf(of("blur"))).toBe("blur");
    expect(conformsToKind("blur_soft", kindOf(instanceOf("Blur")))).toBe(true);
  });

  /*
   * STORED NAMES NEVER MOVE. Renaming the component changes the kind the NEXT name is made
   * under; a name made under the old one is still that name. It no longer carries the
   * kind, which is all that happens to it.
   */
  it("when the component is renamed, an old instance's name is untouched and simply stops conforming", () => {
    const stored = conventionalName("glow", instanceOf("Bloom")).name;
    expect(stored).toBe("bloom_glow");
    const renamed = instanceOf("Glow Stack");
    expect(conformsToKind(stored, kindOf(renamed))).toBe(false);
    expect(roleOf(stored, kindOf(renamed))).toBeNull();
    // And the next name made is under the new one.
    expect(conventionalName("hall", renamed)).toEqual({ name: "glowstack_hall", prefixed: true });
  });
});

/**
 * RULED 2026-10-05: a Panel board and the phone caption a bank, a Layer and a Cue List by
 * the ROLE. On stage `presets_looks` reads `looks`.
 */
describe("roleOrName: what a one-word surface shows", () => {
  it("shows the role of a name that carries its kind", () => {
    expect(roleOrName("presets_looks", "presets")).toBe("looks");
    expect(roleOrName("layer_graphic", "layer")).toBe("graphic");
    expect(roleOrName("cuelist_set", "cuelist")).toBe("set");
    expect(roleOrName("layer_lower_third", "layer")).toBe("lower_third");
  });

  it("shows a name with no role whole: an auto-name is all the name there is", () => {
    expect(roleOrName("presets1", "presets")).toBe("presets1");
    expect(roleOrName("layer", "layer")).toBe("layer");
  });

  it("shows a name that does not carry its kind exactly as it is, cutting nothing", () => {
    expect(roleOrName("looks", "presets")).toBe("looks");
    expect(roleOrName("My Looks", "presets")).toBe("My Looks");
    // Begins with the letters of the kind, but is not `kind_role`: nothing is stripped.
    expect(roleOrName("layers_main", "layer")).toBe("layers_main");
    expect(roleOrName("presetsA", "presets")).toBe("presetsA");
  });
});

describe("conformingFormOf: the advice a patch's warning carries", () => {
  it("names the conforming form of a label that lacks its kind", () => {
    expect(conformingFormOf("lamp", of("slider"))).toBe("slider_lamp");
    expect(conformingFormOf("  Bloom pass ", of("blur"))).toBe("blur_Bloom_pass");
    expect(conformingFormOf("glow", instanceOf("Bloom"))).toBe("bloom_glow");
  });

  it("has nothing to say about a label that conforms", () => {
    expect(conformingFormOf("slider_lamp", of("slider"))).toBeNull();
    expect(conformingFormOf("slider2", of("slider"))).toBeNull();
    expect(conformingFormOf(" slider_lamp ", of("slider"))).toBeNull();
  });

  it("has nothing to say where the convention does not bind, or no name can be made", () => {
    expect(conformingFormOf("depth", of("componentIn"))).toBeNull();
    expect(conformingFormOf("!!!", of("slider"))).toBeNull();
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
