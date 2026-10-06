import { describe, expect, it } from "vitest";

import { diagnosticClass, leavesPlanUsable } from "../diagnostics/classes.ts";
import type { ParameterSchema } from "../types/parameters.ts";
import {
  completeParameterValue,
  defaultParameters,
  storedParameterFindings,
  validateParameterValue,
  validateParameters,
  validateStoredParameter,
} from "./validate.ts";

/**
 * Parameter values reaching the document come from agents, files and inspector drags —
 * all untrusted (§V37). They are checked against the manifest, never coerced.
 */

const schema: ParameterSchema = {
  amount: { type: "number", label: "Amount", default: 0.5, min: 0, max: 1 },
  enabled: { type: "boolean", label: "Enabled", default: true },
  mode: {
    type: "enum",
    label: "Mode",
    default: "over",
    options: [
      { value: "over", label: "Over" },
      { value: "add", label: "Add" },
    ],
  },
  tint: { type: "color", label: "Tint", default: [1, 1, 1, 1], space: "display" },
  offset: { type: "vector", label: "Offset", size: 2, default: [0, 0] },
  note: { type: "string", label: "Note", default: "" },
  texture: { type: "asset", label: "Texture", kind: "image" },
  curve: { type: "curve", label: "Curve", default: [{ x: 0, y: 0 }] },
};

describe("validateParameters", () => {
  it("accepts values matching the schema", () => {
    expect(
      validateParameters(schema, {
        amount: 0.25,
        enabled: false,
        mode: "add",
        tint: [0, 0, 0, 1],
        offset: [1, 2],
        note: "hi",
        texture: null,
        curve: [{ x: 0, y: 1 }],
      }),
    ).toEqual([]);
  });

  it("rejects an unknown parameter name", () => {
    const diagnostics = validateParameters(schema, { nope: 1 });
    expect(diagnostics[0]?.code).toBe("parameter.unknown");
    expect(diagnostics[0]?.suggestion).toContain("amount");
  });

  it("rejects wrong types without coercing", () => {
    expect(validateParameters(schema, { amount: "0.25" })[0]?.code).toBe("parameter.type");
    expect(validateParameters(schema, { enabled: 1 })[0]?.code).toBe("parameter.type");
    expect(validateParameters(schema, { note: 5 })[0]?.code).toBe("parameter.type");
    expect(validateParameters(schema, { amount: Number.NaN })[0]?.code).toBe("parameter.type");
  });

  it("rejects out-of-range numbers instead of clamping them silently", () => {
    expect(validateParameters(schema, { amount: 2 })[0]?.code).toBe("parameter.range");
    expect(validateParameters(schema, { amount: -1 })[0]?.code).toBe("parameter.range");
  });

  it("rejects an enum value outside its options", () => {
    const diagnostic = validateParameters(schema, { mode: "screen" })[0];
    expect(diagnostic?.code).toBe("parameter.enum");
    expect(diagnostic?.message).toContain("over, add");
  });

  it("rejects a vector or color of the wrong length", () => {
    expect(validateParameters(schema, { offset: [1, 2, 3] })[0]?.code).toBe("parameter.type");
    // T1434b: a colour takes rgb or rgba; two or five numbers are no colour.
    expect(validateParameters(schema, { tint: [1, 1] })[0]?.code).toBe("parameter.type");
    expect(validateParameters(schema, { tint: [1, 1, 1, 1, 1] })[0]?.code).toBe("parameter.type");
  });

  it("accepts an rgb colour, and the read path completes it to rgba with alpha 1 (T1434b)", () => {
    expect(validateParameters(schema, { tint: [1, 0.5, 0] })).toEqual([]);
    const tint = schema["tint"]!;
    expect(completeParameterValue(tint, [1, 0.5, 0])).toEqual([1, 0.5, 0, 1]);
    const rgba = [1, 0.5, 0, 0.25];
    expect(completeParameterValue(tint, rgba)).toBe(rgba);
  });

  it("accepts an asset id or null, nothing else", () => {
    expect(validateParameters(schema, { texture: "asset-1" })).toEqual([]);
    expect(validateParameters(schema, { texture: null })).toEqual([]);
    expect(validateParameters(schema, { texture: 7 })[0]?.code).toBe("parameter.type");
  });

  it("reports every bad key, not only the first", () => {
    expect(validateParameters(schema, { amount: 9, mode: "screen" })).toHaveLength(2);
  });

  it("attaches the node id so the diagnostic can be shown on the node badge", () => {
    expect(validateParameters(schema, { amount: 9 }, "node-1")[0]?.nodeId).toBe("node-1");
  });
});

describe("defaultParameters", () => {
  it("materialises manifest defaults, with null for unbound assets", () => {
    expect(defaultParameters(schema)).toEqual({
      amount: 0.5,
      enabled: true,
      mode: "over",
      tint: [1, 1, 1, 1],
      offset: [0, 0],
      note: "",
      texture: null,
      curve: [{ x: 0, y: 0 }],
    });
  });

  it("copies array and curve defaults so two nodes never share one array", () => {
    const first = defaultParameters(schema);
    const second = defaultParameters(schema);
    expect(first["tint"]).not.toBe(second["tint"]);
    expect(first["curve"]).not.toBe(second["curve"]);
  });

  it("produces defaults that validate against their own schema", () => {
    expect(validateParameters(schema, defaultParameters(schema))).toEqual([]);
  });
});

describe("validateParameterValue", () => {
  it("returns null for a valid value and a diagnostic otherwise", () => {
    const definition = schema["amount"];
    if (definition === undefined) throw new Error("fixture");
    expect(validateParameterValue("amount", definition, 0.5)).toBeNull();
    expect(validateParameterValue("amount", definition, 5)?.code).toBe("parameter.range");
  });
});

describe("validateStoredParameter — the slot write gate (T202, §V108)", () => {
  const amount = schema["amount"];
  const tint = schema["tint"];
  if (amount === undefined || tint === undefined) throw new Error("fixture");

  it("checks EVERY retained payload, not only the active mode", () => {
    // Static payload is out of range while expression mode is active: still refused —
    // a retained payload the resolver cannot trust is not a fallback (§V108). §T1641b
    // slice 3: under its own code, because it is not the value in effect.
    const bad = {
      mode: "expression" as const,
      bindings: {
        expression: { kind: "expression" as const, source: "time" },
        static: { kind: "static" as const, value: 42 },
      },
    };
    expect(validateStoredParameter("amount", amount, bad)?.code).toBe("parameter.retained");
  });

  it("refuses an expression that does not parse, at write time (§V110 spirit)", () => {
    const bad = {
      mode: "expression" as const,
      bindings: { expression: { kind: "expression" as const, source: "time +" } },
    };
    expect(validateStoredParameter("amount", amount, bad)?.code).toBe("parameter.expression.syntax");
  });

  it("says what to write instead of a function the grammar lacks, at the write too (§B262)", () => {
    // The bus refused `pow(a, b)` with the list of functions and no rewrite; the resolver had one.
    const bad = { mode: "expression" as const, bindings: { expression: { kind: "expression" as const, source: "pow(time, 2)" } } };
    const refusal = validateStoredParameter("amount", amount, bad);
    expect(refusal?.code).toBe("parameter.expression.syntax");
    expect(refusal?.suggestion).toContain("time ^ 2");
  });

  it("refuses a slot whose active mode has no payload", () => {
    const empty = { mode: "bind" as const, bindings: {} };
    expect(validateStoredParameter("amount", amount, empty)?.code).toBe("parameter.slot.empty");
  });

  it("validates a component key against its derived definition, not as unknown", () => {
    const diagnostics = validateParameters(schema, { "tint.g": 0.5, "offset.y": 3 });
    expect(diagnostics).toEqual([]);
    expect(validateParameters(schema, { "tint.q": 1 })[0]?.code).toBe("parameter.unknown");
    expect(validateParameters(schema, { "amount.x": 1 })[0]?.code).toBe("parameter.unknown");
  });

  it("still accepts every bare value the old gate accepted", () => {
    expect(validateStoredParameter("amount", amount, 0.5)).toBeNull();
    expect(validateStoredParameter("tint", tint, [0, 0, 0, 1])).toBeNull();
  });
});

/**
 * §T1641b slice 3. A slot reads ONE payload, its mode's, and keeps the rest. The same wrong
 * value is two different facts by where it sits: in effect (the default renders instead of
 * it) or kept (nothing reads it, and the plan does not depend on it). The consumer's file
 * held the second for a day: `reset`, a boolean, driven by an expression whose kept static
 * was the number 0.
 */
describe("storedParameterFindings: the payload in effect, and the payloads a slot keeps (T1641b)", () => {
  const amount = schema["amount"];
  const enabled = schema["enabled"];
  const mode = schema["mode"];
  if (amount === undefined || enabled === undefined || mode === undefined) throw new Error("fixture");
  const expression = (source: string) => ({ kind: "expression" as const, source });
  const fixed = (value: never) => ({ kind: "static" as const, value });

  it("a kept static of another type is `parameter.retained`, never, local, with the type to keep", () => {
    const slot = { mode: "expression" as const, bindings: { expression: expression("1 - time"), static: fixed(0 as never) } };
    const findings = storedParameterFindings("enabled", enabled, slot, "rope_legs");
    expect(findings.map((finding) => [finding.diagnostic.code, finding.retained])).toEqual([["parameter.retained", true]]);
    const said = findings[0]?.diagnostic;
    expect(said?.severity).toBe("error");
    expect(said?.nodeId).toBe("rope_legs");
    expect(said?.message).toBe(
      'Parameter "enabled" is in expression mode and keeps a static payload it cannot take: Parameter "enabled" expects a boolean, received number.',
    );
    expect(said?.suggestion).toContain("Keep true or false as the static value");
    expect(diagnosticClass("parameter.retained")).toBe("never");
    // The picture does not depend on it: an error that leaves the plan usable.
    expect(leavesPlanUsable("parameter.retained")).toBe(true);
  });

  it("the SAME value in effect keeps the code it always had, which does withdraw the plan", () => {
    // Bare, and as the static payload of a slot in Constant mode: the default renders instead.
    for (const stored of [0, { mode: "static" as const, bindings: { static: fixed(0 as never) } }]) {
      const findings = storedParameterFindings("enabled", enabled, stored as never);
      expect(findings.map((finding) => [finding.diagnostic.code, finding.retained])).toEqual([["parameter.type", false]]);
    }
    expect(leavesPlanUsable("parameter.type")).toBe(false);
  });

  it("the legitimate slot is silent: a kept static of the parameter's own type, under any mode", () => {
    expect(storedParameterFindings("enabled", enabled, { mode: "expression", bindings: { expression: expression("1 - time"), static: fixed(false as never) } })).toEqual([]);
    expect(storedParameterFindings("amount", amount, { mode: "map", bindings: { map: { kind: "map", attribute: "age" }, static: fixed(0.25 as never) } })).toEqual([]);
    expect(storedParameterFindings("mode", mode, { mode: "expression", bindings: { expression: expression("1"), static: fixed("add" as never) } })).toEqual([]);
  });

  it("a kept expression that does not parse is retained too, and says what to write", () => {
    // Constant mode in effect; the expression is read by nobody until the mode is switched back.
    const slot = { mode: "static" as const, bindings: { static: fixed(0.5 as never), expression: expression("pow(time, 2)") } };
    const findings = storedParameterFindings("amount", amount, slot);
    expect(findings.map((finding) => [finding.diagnostic.code, finding.retained])).toEqual([["parameter.retained", true]]);
    expect(findings[0]?.diagnostic.message).toContain('unknown function "pow"');
    expect(findings[0]?.diagnostic.suggestion).toContain("time ^ 2");
    expect(findings[0]?.diagnostic.suggestion).toContain("nothing reads it in static mode");
  });

  it("reports every payload of a slot, each as what it is, where the gate's verdict is only the first", () => {
    // In effect: an expression that does not parse. Kept: a static past the declared limit.
    const slot = { mode: "expression" as const, bindings: { expression: expression("time +"), static: fixed(42 as never) } };
    expect(storedParameterFindings("amount", amount, slot).map((finding) => [finding.diagnostic.code, finding.retained])).toEqual([
      ["parameter.expression.syntax", false],
      ["parameter.retained", true],
    ]);
    expect(validateStoredParameter("amount", amount, slot)?.code).toBe("parameter.expression.syntax");
  });

  it("a kept static under a map says who reads it", () => {
    const slot = { mode: "map" as const, bindings: { map: { kind: "map" as const, attribute: "age" }, static: fixed("wide" as never) } };
    const said = storedParameterFindings("amount", amount, slot)[0]?.diagnostic;
    expect(said?.code).toBe("parameter.retained");
    expect(said?.suggestion).toContain("every reader but the mapped one");
  });
});
