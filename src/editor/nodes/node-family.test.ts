import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { PORT_FAMILY_VAR } from "@ui/ports.ts";
import { FAMILY_TINT_VAR, NODE_FAMILIES, familyForKind, nodeFamilyOf } from "./node-family.ts";

const TOKENS = readFileSync(
  fileURLToPath(new URL("../../ui/tokens.css", import.meta.url)),
  "utf8",
);

describe("T712 — every family declares a tint, and the mapping cannot go stale", () => {
  it("gives EVERY port kind a family — the whole union, not just the ones in use", () => {
    /*
     * The `satisfies Record<PortKind, NodeFamily>` in node-family.ts is what makes a new
     * port kind a COMPILE error until it declares a family. This is its runtime shadow,
     * and it is asserted over `PORT_FAMILY_VAR` — itself exhaustively typed over
     * `PortKind` — rather than over the kinds shipped nodes happen to use.
     *
     * That distinction is the point. Only eight kinds appear on a port today (camera,
     * light, material, pointset, projector, scene, texture2d, value); the other seven are
     * declared and unused. A test that walked the registry would have said nothing about
     * them, and the first node to output a `buffer` would have arrived untinted.
     */
    const kinds = Object.keys(PORT_FAMILY_VAR) as Array<keyof typeof PORT_FAMILY_VAR>;
    // Guards the guard: an empty list would make this vacuous.
    expect(kinds.length).toBeGreaterThan(10);
    for (const kind of kinds) {
      expect(NODE_FAMILIES, `${kind} has no family`).toContain(familyForKind(kind));
    }
  });

  it("actually tints the nodes that ship, in every family that has any", () => {
    // Non-vacuity from the other side: the mapping being total is worthless if it lands
    // every shipped node in one bucket. Measured today: texture 48, value 16, points 14,
    // spatial 8, and two sinks correctly claiming none.
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const counts = new Map<string, number>();
    for (const definition of registry.list()) {
      const family = nodeFamilyOf(definition) ?? "(none)";
      counts.set(family, (counts.get(family) ?? 0) + 1);
    }
    for (const family of ["texture", "value", "points", "spatial"]) {
      expect(counts.get(family) ?? 0, `no shipped node is in ${family}`).toBeGreaterThan(0);
    }
  });

  it("declares a token for every family and no orphans", () => {
    expect(Object.keys(FAMILY_TINT_VAR).sort()).toEqual([...NODE_FAMILIES].sort());
    for (const name of Object.values(FAMILY_TINT_VAR)) {
      expect(TOKENS).toMatch(new RegExp(`${name}:\\s*[^;]+;`));
    }
  });

  it("reads a node's family off its own primary output", () => {
    const registry = createNodeRegistry(allNodeDefinitions).view();
    // Spot the four the owner named, by the nodes they actually are.
    expect(nodeFamilyOf(registry.get("noise"))).toBe("texture");
    expect(nodeFamilyOf(registry.get("lfo"))).toBe("value");
    // And a SINK claims no family rather than defaulting into one: it produces no
    // payload, so there is nothing for a tint to be about.
    const sink = registry.list().find((definition) => definition.outputs.length === 0);
    expect(sink).toBeDefined();
    expect(nodeFamilyOf(sink)).toBeNull();
    expect(nodeFamilyOf(undefined)).toBeNull();
  });
});
