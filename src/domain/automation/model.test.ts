import { describe, expect, it } from "vitest";

import {
  EMPTY_AUTOMATION_JSON,
  INTERPOLATIONS,
  newKey,
  newLane,
  denormalizeValue,
  freshKeyId,
  freshLaneId,
  nodeSpan,
  normalizeValue,
  parseAutomation,
  serializeAutomation,
  type AutomationDocument,
} from "./model.ts";

const doc = (lanes: unknown[], extra: Record<string, unknown> = {}): string => JSON.stringify({ version: 1, ...extra, lanes });
const lane = (name: string, keys: unknown[], extra: Record<string, unknown> = {}) => ({ id: `id_${name}`, name, keys, ...extra });
const reasonOf = (text: string): string => {
  const parsed = parseAutomation(text);
  if (parsed.ok) throw new Error("expected a refusal");
  return parsed.reason;
};

describe("VN61 — the lanes JSON", () => {
  it("empty text and the default are the empty document", () => {
    expect(parseAutomation("")).toEqual({ ok: true, document: { version: 1, lanes: [] } });
    expect(parseAutomation(EMPTY_AUTOMATION_JSON)).toEqual({ ok: true, document: { version: 1, lanes: [] } });
  });

  it("fills the defaults a terse lane leaves out", () => {
    const parsed = parseAutomation(doc([lane("opacity", [{ id: "k1", t: 0, v: 0.5 }])]));
    expect(parsed).toEqual({
      ok: true,
      document: { version: 1, lanes: [newLane("id_opacity", "opacity", [newKey("k1", 0, 0.5)])] },
    });
  });

  it("serializes canonically and round-trips", () => {
    const document: AutomationDocument = {
      version: 1,
      range: [0, 480_000],
      lanes: [
        newLane("l1", "rotate", [
          newKey("a", 0, 0, { interp: "easep", power: 3, handle: "free", out: [1_000, 0.25] }),
          newKey("b", 240_000, 1, { interp: "outBounce", in: [-2_000, -0.1] }),
        ], { min: -360, max: 360, pre: "mirror", post: "cycleOffset", clamp: false, color: "series-2", mute: true, mutedValue: 1.2 }),
      ],
    };
    const text = serializeAutomation(document);
    const parsed = parseAutomation(text);
    expect(parsed).toEqual({ ok: true, document });
    if (parsed.ok) expect(serializeAutomation(parsed.document)).toBe(text);
  });

  it("refuses each broken invariant by name", () => {
    expect(reasonOf("{")).toMatch(/not valid JSON/);
    expect(reasonOf(JSON.stringify({ version: 2, lanes: [] }))).toMatch(/unknown version/);
    expect(reasonOf(doc([lane("a", [])]))).toMatch(/at least one key/);
    expect(reasonOf(doc([lane("a", [{ id: "k1", t: 10, v: 0 }, { id: "k2", t: 10, v: 1 }])]))).toMatch(/strictly increasing/);
    expect(reasonOf(doc([lane("a", [{ id: "k1", t: 10, v: 0 }, { id: "k2", t: 5, v: 1 }])]))).toMatch(/strictly increasing/);
    expect(reasonOf(doc([lane("a", [{ id: "k1", t: 0.5, v: 0 }])]))).toMatch(/whole number of ticks/);
    expect(reasonOf(doc([lane("a", [{ id: "k1", t: 0, v: 1.5 }])]))).toMatch(/0\.\.1/);
    expect(reasonOf(doc([lane("a", [{ id: "k1", t: 0, v: Number.NaN }])]))).toMatch(/0\.\.1/);
    expect(reasonOf(doc([lane("a", [{ id: "k1", t: 0, v: 0, out: [-5, 0] }])]))).toMatch(/out handle points forward/);
    expect(reasonOf(doc([lane("a", [{ id: "k1", t: 0, v: 0, in: [5, 0] }])]))).toMatch(/in handle points back/);
    expect(reasonOf(doc([lane("a", [{ id: "k1", t: 0, v: 0, interp: "wobble" }])]))).toMatch(/interp must be one of/);
    expect(reasonOf(doc([lane("a", [{ id: "k1", t: 0, v: 0 }, { id: "k1", t: 5, v: 0 }])]))).toMatch(/two keys have the id "k1"/);
    expect(reasonOf(doc([lane("2bad", [{ id: "k1", t: 0, v: 0 }])]))).toMatch(/identifier/);
    expect(reasonOf(doc([lane("a", [{ id: "k1", t: 0, v: 0 }]), { ...lane("a", [{ id: "k1", t: 0, v: 0 }]), id: "other" }]))).toMatch(/two lanes are named "a"/);
    expect(reasonOf(doc([lane("a", [{ id: "k1", t: 0, v: 0 }]), lane("a", [{ id: "k1", t: 0, v: 0 }])]))).toMatch(/two lanes have the id/);
    expect(reasonOf(doc([lane("a", [{ id: "k1", t: 0, v: 0 }], { min: Infinity })]))).toMatch(/finite/);
    expect(reasonOf(doc([], { range: [10, 10] }))).toMatch(/range/);
    expect(reasonOf(doc([lane("a", [{ id: "k1", t: 0, v: 0 }], { mutedValue: "half" })]))).toMatch(/mutedValue/);
  });

  it("every interpolation name parses", () => {
    for (const interp of INTERPOLATIONS) expect(parseAutomation(doc([lane("a", [{ id: "k", t: 0, v: 0, interp }])])).ok).toBe(true);
    expect(INTERPOLATIONS).toHaveLength(10 + 30);
  });

  it("mints deterministic free ids", () => {
    const one = newLane("lane1", "a", [newKey("key1", 0, 0), newKey("key3", 5, 0)]);
    expect(freshLaneId({ version: 1, lanes: [one] })).toBe("lane2");
    expect(freshKeyId(one)).toBe("key2");
  });

  it("normalizes against the lane's range and back", () => {
    const range = { min: -360, max: 360 };
    expect(normalizeValue(range, 0)).toBe(0.5);
    expect(denormalizeValue(range, 0.75)).toBe(180);
    expect(normalizeValue({ min: 3, max: 3 }, 3)).toBe(0);
  });

  it("the node's span is one span over every lane, or the explicit range", () => {
    const lanes = [newLane("l1", "a", [newKey("k", 100, 0), newKey("j", 500, 0)]), newLane("l2", "b", [newKey("k", 50, 0), newKey("j", 300, 0)])];
    expect(nodeSpan({ version: 1, lanes })).toEqual([50, 500]);
    expect(nodeSpan({ version: 1, range: [0, 1000], lanes })).toEqual([0, 1000]);
    expect(nodeSpan({ version: 1, lanes: [] })).toBeNull();
  });
});
