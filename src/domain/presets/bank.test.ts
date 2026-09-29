import { describe, expect, it } from "vitest";

import { EMPTY_PRESET_BANK_JSON, parsePresetBank, parsePresetTargets, serializePresetBank } from "./bank.ts";

/**
 * T1496b — the bank's JSON and its target list. The parser is structure only: whether a
 * name still resolves is the recall's question (ruling 4), so these tests pin what a bank
 * FILE may hold, and that a bad one is refused by name rather than half-read — a recall
 * reading half a bank would apply a preset nobody wrote.
 */
describe("parsePresetBank (T1496b)", () => {
  it("round-trips a bank, slots included, through the stored text", () => {
    const bank = {
      version: 1 as const,
      presets: [
        {
          name: "dawn",
          values: {
            glow: {
              radius: 12,
              amount: { mode: "expression" as const, bindings: { expression: { kind: "expression" as const, source: "sin(2)" } } },
            },
          },
        },
      ],
    };
    const parsed = parsePresetBank(serializePresetBank(bank));
    expect(parsed).toEqual({ ok: true, bank });
  });

  it("reads blank text and a fresh node's default as an empty bank", () => {
    expect(parsePresetBank("")).toEqual({ ok: true, bank: { version: 1, presets: [] } });
    expect(parsePresetBank(EMPTY_PRESET_BANK_JSON)).toEqual({ ok: true, bank: { version: 1, presets: [] } });
  });

  it("refuses what a recall could only half-read, naming the preset", () => {
    const bad = (presets: unknown): string => {
      const parsed = parsePresetBank(JSON.stringify({ version: 1, presets }));
      if (parsed.ok) throw new Error("expected a refusal");
      return parsed.reason;
    };
    expect(parsePresetBank("{ not json").ok).toBe(false);
    expect(parsePresetBank(JSON.stringify({ version: 2, presets: [] })).ok).toBe(false);
    expect(bad([{ name: "a", values: {} }, { name: "a", values: {} }])).toContain('"a"');
    expect(bad([{ name: "1st", values: {} }])).toContain("identifier");
    expect(bad([{ name: "riot", values: { glow: 3 } }])).toContain('"riot"');
    expect(bad([{ name: "riot", values: { glow: { radius: { not: "a slot" } } } }])).toContain("glow.radius");
    expect(bad([{ name: "riot", values: {}, morph: { seconds: -1, curve: "smooth" } }])).toContain("morph");
  });
});

describe("parsePresetTargets (T1496b)", () => {
  it("splits on spaces and commas; the first dot separates node from key", () => {
    expect(parsePresetTargets(" glow, blur1.radius\nsolid1.color.r ")).toEqual([
      { token: "glow", node: "glow" },
      { token: "blur1.radius", node: "blur1", key: "radius" },
      { token: "solid1.color.r", node: "solid1", key: "color.r" },
    ]);
    expect(parsePresetTargets(undefined)).toEqual([]);
  });
});
