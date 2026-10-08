import { describe, expect, it } from "vitest";

import { framesToTicks, rateOf, ticksToFrames } from "../time/ticks.ts";
import { newKey, newLane, parseAutomation, serializeAutomation, type AutomationDocument } from "./model.ts";
import { retimeAutomation } from "./retime.ts";

const at30 = rateOf(30);
const at2997 = rateOf(29.97);
const document: AutomationDocument = {
  version: 1,
  range: [0, framesToTicks(300, at30)],
  lanes: [newLane("l", "x", [newKey("a", 0, 0, { handle: "free", out: [8_000, 0.1] }), newKey("b", framesToTicks(90, at30), 1)])],
};

describe("VN61 — changing fps", () => {
  it("keeps time by default: nothing moves", () => {
    expect(retimeAutomation(document, "keepTime", at30, at2997)).toBe(document);
  });

  it("keeps frames on request: each key stays on its frame number, handles keep their shape in frames", () => {
    const retimed = retimeAutomation(document, "keepFrames", at30, at2997);
    const keys = retimed.lanes[0]!.keys;
    expect(keys.map((key) => ticksToFrames(key.t, at2997))).toEqual([0, 90]);
    expect(keys[1]!.t).toBe(90 * 8_008);
    expect(keys[0]!.out).toEqual([8_008, 0.1]);
    expect(retimed.range).toEqual([0, 300 * 8_008]);
    // Still a valid document.
    expect(parseAutomation(serializeAutomation(retimed)).ok).toBe(true);
  });
});
