import { describe, expect, it } from "vitest";

import { formatNodePath, parseNodePath, pathBetween, renamedPathHead, resolveNodePath, type NameScopes } from "./addressing.ts";

/**
 * VN35 — the path grammar and its walk, on a hand-built scope table:
 * the root holds `camera_stage` and two rigs; `rig_a` holds a projector instance; the
 * unnamed rig `u` holds a node no path can reach.
 */
const scopes: NameScopes = new Map([
  ["", { parent: undefined, label: undefined, names: new Map([["camera_stage", { node: "cam" }], ["rig_a", { scope: "a" }], ["rig_b", { scope: "b" }]]) }],
  ["a", { parent: "", label: "rig_a", names: new Map([["projector_lamp", { scope: "a/lamp" }], ["render_rig", { node: "a/shot" }]]) }],
  ["a/lamp", { parent: "a", label: "projector_lamp", names: new Map([["projector_beam", { node: "a/lamp/beam" }]]) }],
  ["b", { parent: "", label: "rig_b", names: new Map([["render_rig", { node: "b/shot" }]]) }],
  ["u", { parent: "", label: undefined, names: new Map([["hidden", { node: "u/hidden" }]]) }],
] as const);

describe("node paths (VN35)", () => {
  it("parses relative paths and refuses the malformed", () => {
    expect(parseNodePath("rig_a/projector_lamp")).toEqual({ up: 0, names: ["rig_a", "projector_lamp"] });
    expect(parseNodePath("../../camera_stage")).toEqual({ up: 2, names: ["camera_stage"] });
    for (const malformed of ["/rig_a", "rig_a/", "rig_a//x", "..", "rig_a/../x", "./rig_a", "rig_a/./x", ""]) {
      expect(parseNodePath(malformed), malformed).toBeUndefined();
    }
    expect(formatNodePath({ up: 1, names: ["rig_b", "render_rig"] })).toBe("../rig_b/render_rig");
  });

  it("walks down through instances and up out of them, and says where a walk stops", () => {
    const walk = (text: string, from: string) => resolveNodePath(parseNodePath(text)!, from, scopes);
    expect(walk("rig_a/projector_lamp/projector_beam", "")).toEqual({ ok: true, nodeId: "a/lamp/beam" });
    expect(walk("../../camera_stage", "a/lamp")).toEqual({ ok: true, nodeId: "cam" });
    expect(walk("../rig_b/render_rig", "a")).toEqual({ ok: true, nodeId: "b/shot" });
    expect(walk("../camera_stage", "")).toMatchObject({ ok: false, reason: "it climbs above the document's root" });
    expect(walk("rig_a/nope", "")).toMatchObject({ ok: false, reason: 'no node is named "nope" there' });
    expect(walk("rig_a/projector_lamp", "")).toMatchObject({ ok: false });
    expect(walk("camera_stage/x", "")).toMatchObject({ ok: false });
  });

  it("writes the path between two graphs, and none through an unnamed instance", () => {
    expect(pathBetween("", "a/lamp", "projector_beam", scopes)).toBe("rig_a/projector_lamp/projector_beam");
    expect(pathBetween("b", "a/lamp", "projector_beam", scopes)).toBe("../rig_a/projector_lamp/projector_beam");
    expect(pathBetween("", "u", "hidden", scopes)).toBeUndefined();
  });

  it("renames only the head of a path that starts in the renamed node's graph", () => {
    expect(renamedPathHead("rig_a/projector_lamp", "rig_a", "rig_left")).toBe("rig_left/projector_lamp");
    expect(renamedPathHead("rig_a", "rig_a", "rig_left")).toBeUndefined();
    expect(renamedPathHead("../rig_a/x", "rig_a", "rig_left")).toBeUndefined();
    expect(renamedPathHead("rig_b/rig_a", "rig_a", "rig_left")).toBeUndefined();
  });
});
