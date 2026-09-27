import { describe, expect, it } from "vitest";

import { parseHandleId, variadicHandleId } from "./edge-order.ts";

/**
 * Every handle id in the app goes through `parseHandleId`: a plain port, or a variadic
 * slot (`in2#1`). Exact round trips (§V147): a wrong split here is a wire that lands on
 * the wrong port and looks fine. (§T1350b's per-channel `out@<channel>` sockets were
 * removed by §V1026; a value port is one socket.)
 */
describe("handle ids", () => {
  it("leaves plain ports and variadic slots exactly as they were (§V68)", () => {
    expect(parseHandleId("out")).toEqual({ portId: "out", slot: undefined });
    expect(parseHandleId(variadicHandleId("inputs", 2))).toEqual({ portId: "inputs", slot: 2 });
    expect(parseHandleId("in2#1")).toEqual({ portId: "in2", slot: 1 });
  });
});
