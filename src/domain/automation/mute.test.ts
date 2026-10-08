import { describe, expect, it } from "vitest";

import { compileAutomation, evaluateLane } from "./evaluate.ts";
import { newKey, newLane, parseAutomation, serializeAutomation } from "./model.ts";
import { setLaneMute } from "./mute.ts";

const S = 240_000;
// 0 → 100 over one second, linear.
const TEXT = serializeAutomation({
  version: 1,
  lanes: [newLane("lane1", "level", [newKey("a", 0, 0, { interp: "linear" }), newKey("b", S, 1)], { min: 0, max: 100 })],
});

const valueAt = (text: string, t: number): number => {
  const compiled = compileAutomation(text);
  if (!compiled.ok) throw new Error(compiled.reason);
  return evaluateLane(compiled.compiled.lanes[0]!, t);
};

const mute = (text: string, muted: boolean, at: number): string => {
  const result = setLaneMute(text, "lane1", muted, at);
  if (!result.ok) throw new Error(result.reason);
  return result.text;
};

describe("VN61 — a muted lane holds the value it had when it was muted", () => {
  it("muting at two playheads holds two values, at every time; unmuting returns to the curve", () => {
    const at25 = mute(TEXT, true, S / 4);
    const at75 = mute(TEXT, true, (3 * S) / 4);
    for (const t of [0, S / 2, S, 5 * S]) {
      expect(valueAt(at25, t)).toBe(25);
      expect(valueAt(at75, t)).toBe(75);
    }
    const parsed = parseAutomation(at25);
    expect(parsed.ok && parsed.document.lanes[0]).toMatchObject({ mute: true, mutedValue: 0.25 });

    const unmuted = mute(at25, false, 0);
    expect(valueAt(unmuted, S / 2)).toBe(50);
    // Unmuting clears the held value: the text is the original again.
    expect(unmuted).toBe(TEXT);
  });

  it("re-muting holds the curve's value at the new time, not the old hold", () => {
    expect(valueAt(mute(mute(TEXT, true, S / 4), true, S / 2), 0)).toBe(50);
  });

  it("a muted lane with no mutedValue (hand-written text) holds its first key", () => {
    const parsed = parseAutomation(TEXT);
    if (!parsed.ok) throw new Error(parsed.reason);
    const handWritten = serializeAutomation({ ...parsed.document, lanes: parsed.document.lanes.map((lane) => ({ ...lane, mute: true })) });
    expect(valueAt(handWritten, S / 2)).toBe(0);
  });

  it("refuses an unknown lane and a broken text", () => {
    expect(setLaneMute(TEXT, "nope", true, 0)).toEqual({ ok: false, reason: 'No lane with the id "nope".' });
    expect(setLaneMute("{", "lane1", true, 0)).toMatchObject({ ok: false });
  });
});
