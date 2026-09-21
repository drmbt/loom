import { describe, expect, it } from "vitest";

import { channelHandleId, parseHandleId, variadicHandleId } from "./edge-order.ts";

/**
 * T1350b — every handle id in the app goes through `parseHandleId`, so the three shapes it
 * must tell apart are pinned side by side: a plain port, a variadic slot (`in2#1`), and a
 * per-channel socket (`out@band109`). Exact round trips (§V147): a wrong split here is a
 * wire that lands on the wrong port and looks fine.
 */
describe("T1350b — per-channel handle ids", () => {
  it("round-trips a channel socket, and a channel that carries digits is not a slot", () => {
    expect(channelHandleId("out", "band109")).toBe("out@band109");
    expect(parseHandleId("out@band109")).toEqual({ portId: "out", slot: undefined, channel: "band109" });
    expect(parseHandleId(channelHandleId("out", "x"))).toEqual({ portId: "out", slot: undefined, channel: "x" });
  });

  it("leaves plain ports and variadic slots exactly as they were (§V68)", () => {
    expect(parseHandleId("out")).toEqual({ portId: "out", slot: undefined });
    expect(parseHandleId(variadicHandleId("inputs", 2))).toEqual({ portId: "inputs", slot: 2 });
    expect(parseHandleId("in2#1")).toEqual({ portId: "in2", slot: 1 });
  });

  it("does not read a leading or trailing `@` as a channel", () => {
    expect(parseHandleId("@x")).toEqual({ portId: "@x", slot: undefined });
    expect(parseHandleId("out@")).toEqual({ portId: "out@", slot: undefined });
  });
});
