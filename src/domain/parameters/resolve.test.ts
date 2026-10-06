import { describe, expect, it } from "vitest";
import { buildParentScope, parentBindResolver, parentScopeDrivers } from "../components/parent-scope.ts";
import type { ParentScope } from "../types/components.ts";
import type { GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import { diagnosticClass } from "../diagnostics/classes.ts";
import { bindCycleDiagnostics } from "./bind-cycles.ts";
import { STORED_READ, effectiveParameterSchema, resolveParameter, resolveParameterSchema, resolveParameters, srgbToLinear } from "./resolve.ts";
import { testRead } from "./test-support.ts";
import { EXPRESSION_DRIVEN_TYPES, validateStoredParameter } from "./validate.ts";

/**
 * The promoted §V61 resolver (T168, closing B8).
 *
 * These are the claims that must hold for the compiler and the inspector alike, because
 * after T168 there is one function and they are the same claims. What made B8 possible
 * was that they were only ever asserted against the editor's copy.
 */

const solidLike: NodeDefinition = {
  type: "test.solid",
  version: 1,
  title: "Solid",
  category: "generator",
  inputs: [],
  outputs: [],
  parameters: {
    color: { type: "color", label: "Color", default: [0, 0, 0, 1], space: "display" },
    linearColor: { type: "color", label: "Linear", default: [0, 0, 0, 1], space: "linear" },
    gain: { type: "number", label: "Gain", default: 4, min: 0, max: 64 },
  },
  compile: () => ({ passes: [] }),
};

function nodeWith(parameters: GraphNode["parameters"], id = "node-1"): GraphNode {
  return {
    id: id as NodeId,
    type: solidLike.type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters,
  };
}

describe("display→linear decode reaches evaluation (T148, §V56, B8)", () => {
  it("decodes a display-space colour into `values`, leaving alpha alone", () => {
    const resolved = resolveParameters(nodeWith({ color: [0.5, 0.5, 0.5, 0.7] }), solidLike, STORED_READ);
    const [r, g, b, a] = resolved.values["color"] as readonly number[];

    expect(r).toBeCloseTo(0.2140, 4);
    expect(g).toBeCloseTo(0.2140, 4);
    expect(b).toBeCloseTo(0.2140, 4);
    // Alpha is coverage, not light: encoding it would make 50% opacity compose wrong.
    expect(a).toBe(0.7);
  });

  it("leaves a space:\"linear\" colour untouched — it is already the working space", () => {
    const resolved = resolveParameters(nodeWith({ linearColor: [0.5, 0.5, 0.5, 0.7] }), solidLike, STORED_READ);
    expect(resolved.values["linearColor"]).toEqual([0.5, 0.5, 0.5, 0.7]);
  });

  it("keeps the display/evaluation split: the entry a control renders is undecoded", () => {
    // If the per-entry value were decoded too, the picker would show a different number
    // than the one the user chose, every time the document round-tripped.
    const resolved = resolveParameters(nodeWith({ color: [0.5, 0.5, 0.5, 0.7] }), solidLike, STORED_READ);
    expect(resolved.get("color")?.value).toEqual([0.5, 0.5, 0.5, 0.7]);
    expect(resolved.get("color")?.stored).toEqual([0.5, 0.5, 0.5, 0.7]);
    expect(resolved.values["color"]).not.toEqual([0.5, 0.5, 0.5, 0.7]);
  });

  it("decodes the manifest default too, not only a stored value", () => {
    const white: NodeDefinition = {
      ...solidLike,
      parameters: {
        color: { type: "color", label: "Color", default: [0.5, 0.5, 0.5, 1], space: "display" },
      },
    };
    const [r] = resolveParameters(nodeWith({}), white, STORED_READ).values["color"] as readonly number[];
    expect(r).toBeCloseTo(srgbToLinear(0.5), 10);
  });
});

describe("validation decides the value, so it lives in the resolver (§V61)", () => {
  it("falls back to the default and says why when the manifest refuses the stored value", () => {
    const resolved = resolveParameters(nodeWith({ gain: "big" as unknown as number }), solidLike, STORED_READ);
    const entry = resolved.get("gain");

    expect(entry?.value).toBe(4);
    expect(entry?.source).toBe("default");
    expect(entry?.stored).toBe("big");
    expect(entry?.diagnostic?.code).toBe("parameter.type");
    expect(resolved.diagnostics).toHaveLength(1);
  });

  it("treats an out-of-range number as unusable, the same way on both call sites", () => {
    // The one rule the two old implementations could still have disagreed about: the
    // editor's copy checked shape only, the compiler's checked range as well.
    const resolved = resolveParameters(nodeWith({ gain: 999 }), solidLike, STORED_READ);
    expect(resolved.get("gain")?.value).toBe(4);
    expect(resolved.get("gain")?.diagnostic?.code).toBe("parameter.range");
  });

  it("reports nothing when the document is simply silent — a default is not a fault", () => {
    const resolved = resolveParameters(nodeWith({}), solidLike, STORED_READ);
    expect(resolved.get("gain")).toMatchObject({ value: 4, source: "default", diagnostic: null });
    expect(resolved.diagnostics).toEqual([]);
  });

  it("copies array defaults so two nodes never share one array", () => {
    const first = resolveParameters(nodeWith({}), solidLike, STORED_READ).get("color")?.value;
    const second = resolveParameters(nodeWith({}), solidLike, STORED_READ).get("color")?.value;
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it("resolves nothing for an unknown node type rather than guessing a schema (§V10)", () => {
    const resolved = resolveParameters(nodeWith({ anything: 1 }), undefined, STORED_READ);
    expect(resolved.entries).toEqual([]);
    expect(resolved.values).toEqual({});
  });
});

describe("the driver seam survives the promotion (§V61 injection point)", () => {
  const gain = solidLike.parameters["gain"];
  if (gain === undefined) throw new Error("fixture lost its gain parameter");

  it("prefers a driver's value and marks the parameter driven", () => {
    const resolved = resolveParameter(nodeWith({ gain: 12 }), "gain", gain, {
      ...STORED_READ,
      drivers: { gain: () => 30 },
    });
    expect(resolved).toMatchObject({ value: 30, stored: 12, source: "driven", driven: true });
  });

  it("checks a driver's output against the manifest like any other value", () => {
    const resolved = resolveParameter(nodeWith({ gain: 12 }), "gain", gain, {
      ...STORED_READ,
      drivers: { gain: () => "nonsense" as unknown as number },
    });
    expect(resolved.value).toBe(4);
    expect(resolved.diagnostic).not.toBeNull();
  });

  it("falls back to the stored value when a driver declines to produce one", () => {
    const resolved = resolveParameter(nodeWith({ gain: 12 }), "gain", gain, {
      ...STORED_READ,
      drivers: { gain: () => undefined },
    });
    expect(resolved).toMatchObject({ value: 12, driven: false });
  });

  it("hands the frame to the driver rather than letting it read a clock (§V44)", () => {
    const resolved = resolveParameter(nodeWith({ gain: 12 }), "gain", gain, {
      ...testRead({
        frame: {
          timeSeconds: 2,
          deltaSeconds: 0.016,
          frameIndex: 120,
          mode: "realtime",
          randomSeed: 7,
        },
      }),
      drivers: { gain: (context) => (context.frame?.frameIndex ?? 0) / 10 },
    });
    expect(resolved.value).toBe(12);
  });
});

/**
 * §V81 through the promoted resolver. `parent.<key>` is the one driver that already
 * exists, so it is the one that proves the seam did not become decorative in the move.
 */
describe("parent.<key> bindings, at depth (§V81, T133)", () => {
  const bound = (reference: string): GraphNode => ({
    ...nodeWith({ gain: 1 }, "inner"),
    state: { parentBindings: { gain: reference } },
  });

  /** Outermost first: the outer component publishes 9, the inner one 5. */
  const scope: ParentScope | undefined = buildParentScope([{ gain: 9 }, { gain: 5 }]);

  it("reads one hop out", () => {
    const node = bound("parent.gain");
    const resolved = resolveParameters(node, solidLike, {
      ...STORED_READ,
      drivers: parentScopeDrivers(node, scope),
    });
    expect(resolved.get("gain")).toMatchObject({ value: 5, source: "driven", driven: true });
  });

  it("reads two hops out — nesting is lexical, not a per-depth special case", () => {
    const node = bound("parent.parent.gain");
    const resolved = resolveParameters(node, solidLike, {
      ...STORED_READ,
      drivers: parentScopeDrivers(node, scope),
    });
    expect(resolved.get("gain")?.value).toBe(9);
  });

  it("keeps the node's own value and reports when the binding cannot resolve", () => {
    const node = bound("parent.parent.parent.gain");
    const diagnostics: string[] = [];
    const resolved = resolveParameters(node, solidLike, {
      ...STORED_READ,
      drivers: parentScopeDrivers(node, scope, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
      }),
    });
    expect(resolved.get("gain")).toMatchObject({ value: 1, driven: false });
    expect(diagnostics).toEqual(["component.parentScope.too-deep"]);
  });

  it("decodes a parent-driven display colour for evaluation, like any other source", () => {
    const node: GraphNode = {
      ...nodeWith({ color: [0, 0, 0, 1] }, "inner"),
      state: { parentBindings: { color: "parent.tint" } },
    };
    const resolved = resolveParameters(node, solidLike, {
      ...STORED_READ,
      drivers: parentScopeDrivers(node, buildParentScope([{ tint: [0.5, 0.5, 0.5, 1] }])),
    });
    expect(resolved.get("color")?.value).toEqual([0.5, 0.5, 0.5, 1]);
    expect((resolved.values["color"] as readonly number[])[0]).toBeCloseTo(0.2140, 4);
  });
});

/**
 * Parameter modes (T202/T203, §V107, §V108) and compound components (T207, §V113).
 * The claims: every type takes every mode; a failed mode falls back to the retained
 * static value, never hangs; component slots drive one channel while siblings hold.
 */
describe("parameter modes (T203, §V107)", () => {
  const frame = {
    timeSeconds: 2,
    deltaSeconds: 0.016,
    frameIndex: 120,
    mode: "realtime",
    randomSeed: 7,
  } as const;

  const slot = (mode: "static" | "expression" | "bind" | "driven", bindings: object) =>
    ({ mode, bindings }) as GraphNode["parameters"][string];

  const expr = (source: string, retained?: number) =>
    slot("expression", {
      expression: { kind: "expression", source },
      ...(retained === undefined ? {} : { static: { kind: "static", value: retained } }),
    });

  it("evaluates an expression against the frame (§V71, §V44)", () => {
    const resolved = resolveParameters(nodeWith({ gain: expr("time * 3") }), solidLike, testRead({ frame }));
    expect(resolved.get("gain")).toMatchObject({ value: 6, mode: "expression", source: "driven", driven: true });
  });

  it("resolves the deterministic zero frame when no frame is given — compile-time, not an error", () => {
    const resolved = resolveParameters(nodeWith({ gain: expr("10 + time") }), solidLike, STORED_READ);
    expect(resolved.get("gain")?.value).toBe(10);
    expect(resolved.diagnostics).toEqual([]);
  });

  it("clamps an expression into the declared range instead of snapping to default", () => {
    const resolved = resolveParameters(nodeWith({ gain: expr("9999") }), solidLike, testRead({ frame }));
    expect(resolved.get("gain")?.value).toBe(64);
  });

  /**
   * T368 — the clamp used to be MUTE.
   *
   * Measured before this landed: `transform.r` (±360) resolving `time * 7` at t=100
   * produced 360 and zero diagnostics. Correct at t=0, a stopped rotation from t≈51, and
   * nothing anywhere said so — §V240's shape exactly. The value in effect is still the
   * limit; what changed is that it is now reported, by name, with the remedy in this
   * parameter's own numbers (§V288).
   */
  it("SAYS SO when an expression is clamped, naming the parameter and the remedy (T368)", () => {
    const resolved = resolveParameters(nodeWith({ gain: expr("time * 100") }), solidLike, testRead({ frame }));
    const entry = resolved.get("gain");
    expect(entry?.value).toBe(64); // pinned, as before — the value behaviour is unchanged
    expect(entry?.diagnostic?.code).toBe("parameter.expression.clamped");
    expect(entry?.diagnostic?.severity).toBe("warning");
    expect(entry?.diagnostic?.message).toContain('"gain"');
    expect(entry?.diagnostic?.message).toContain("time * 100");
    expect(entry?.diagnostic?.message).toContain("200"); // what it actually produced
    expect(entry?.diagnostic?.message).toContain("64"); // and the limit it was pinned to
    // The declared bounds, so the reader can check the claim without opening the manifest.
    expect(entry?.diagnostic?.message).toContain("0…64");
    // The remedy is expression text for THIS parameter, not a sentence about ranges.
    expect(entry?.diagnostic?.suggestion).toContain("clamp(time * 100, 0, 64)");
    expect(entry?.diagnostic?.suggestion).toContain("mod(time * 100, 64)");
    // And it travels: a diagnostic that never leaves the entry reaches no panel.
    expect(resolved.diagnostics.map((d) => d.code)).toContain("parameter.expression.clamped");
  });

  it("stays quiet while the expression is inside the range — the warning is not ambient", () => {
    // The other half of the claim. A warning that fires on every expression is a warning
    // people learn to scroll past, and this one has to still mean something at t=3100.
    const resolved = resolveParameters(nodeWith({ gain: expr("time * 3") }), solidLike, testRead({ frame }));
    expect(resolved.diagnostics).toEqual([]);
  });

  it("falls back to the RETAINED static value when the expression breaks (§V108)", () => {
    const resolved = resolveParameters(nodeWith({ gain: expr("nope + 1", 12) }), solidLike, testRead({ frame }));
    const entry = resolved.get("gain");
    expect(entry?.value).toBe(12);
    expect(entry?.mode).toBe("expression"); // the active mode still shows, value or not
    // §T1641b: a bare name nothing supplies can never evaluate. An error, by its own code.
    expect([entry?.diagnostic?.severity, entry?.diagnostic?.code]).toEqual(["error", "parameter.expression.name"]);
  });

  it("agrees with the write gate, type by type, on what an expression can drive (§B266)", () => {
    // One rule, two readers: the write gate refuses an expression on a type that takes
    // none (`EXPRESSION_DRIVEN_TYPES`), and the resolver says the same of one already
    // stored. A type added to the union must be decided in both or this fails.
    const every: NodeDefinition["parameters"] = {
      number: { type: "number", label: "n", default: 0 },
      boolean: { type: "boolean", label: "b", default: false },
      pulse: { type: "pulse", label: "p", fires: "feedback.reset" },
      enum: { type: "enum", label: "e", default: "a", options: [{ value: "a", label: "A" }] },
      string: { type: "string", label: "s", default: "" },
      vector: { type: "vector", label: "v", size: 2, default: [0, 0] },
      color: { type: "color", label: "c", default: [0, 0, 0, 1], space: "linear" },
      code: { type: "code", label: "k", language: "wgsl", default: "" },
      asset: { type: "asset", label: "a", kind: "image" },
      curve: { type: "curve", label: "u", default: [] },
      stops: { type: "stops", label: "t", default: [], space: "linear" },
    };
    for (const [key, parameter] of Object.entries(every)) {
      const stored = { mode: "expression" as const, bindings: { expression: { kind: "expression" as const, source: "0" } } };
      const atRest = resolveParameters(nodeWith({ [key]: stored }), { ...solidLike, parameters: every }, STORED_READ).get(key)?.diagnostic?.code;
      const atTheWrite = validateStoredParameter(key, parameter, stored)?.code;
      const driven = EXPRESSION_DRIVEN_TYPES.has(parameter.type);
      expect([key, atRest === "parameter.expression.type", atTheWrite === "parameter.expression.type"]).toEqual([key, !driven, !driven]);
    }
    expect(Object.keys(every).filter((key) => !EXPRESSION_DRIVEN_TYPES.has(every[key]!.type))).toEqual(["code", "asset", "curve", "stops"]);
  });

  it("drives every type from a number: bool ≠0, enum by index, string rendered (§V107)", () => {
    const definition: NodeDefinition = {
      ...solidLike,
      parameters: {
        on: { type: "boolean", label: "On", default: false },
        blend: {
          type: "enum",
          label: "Blend",
          default: "normal",
          options: [
            { value: "normal", label: "Normal" },
            { value: "add", label: "Add" },
            { value: "multiply", label: "Multiply" },
          ],
        },
        note: { type: "string", label: "Note", default: "" },
      },
    };
    const resolved = resolveParameters(
      nodeWith({ on: expr("time"), blend: expr("1"), note: expr("time * 10") }),
      definition,
      testRead({ frame }),
    );
    expect(resolved.get("on")?.value).toBe(true);
    expect(resolved.get("blend")?.value).toBe("add");
    expect(resolved.get("note")?.value).toBe("20");
  });

  it("binds a sibling parameter, reading its EFFECTIVE value", () => {
    const resolved = resolveParameters(
      nodeWith({
        gain: expr("time"),
        linearColor: [0, 0, 0, 1],
        color: slot("bind", { bind: { kind: "bind", ref: "linearColor" } }),
      }),
      solidLike,
      testRead({ frame }),
    );
    expect(resolved.get("color")?.value).toEqual([0, 0, 0, 1]);
    expect(resolved.get("color")?.driven).toBe(true);
  });

  it("binds parent.* through the injected resolver — one lookup with the legacy path", () => {
    const node = nodeWith({ gain: slot("bind", { bind: { kind: "bind", ref: "parent.gain" } }) });
    const resolved = resolveParameters(node, solidLike, {
      ...STORED_READ,
      parentBind: parentBindResolver(buildParentScope([{ gain: 9 }])),
    });
    expect(resolved.get("gain")).toMatchObject({ value: 9, mode: "bind", driven: true });
  });

  it("reports and retains when a bind names nothing", () => {
    const node = nodeWith({
      gain: slot("bind", { bind: { kind: "bind", ref: "missing" }, static: { kind: "static", value: 2 } }),
    });
    const resolved = resolveParameters(node, solidLike, STORED_READ);
    expect(resolved.get("gain")?.value).toBe(2);
    // §T1641b slice 1b: it can never read. An error, by its own code.
    expect([resolved.get("gain")?.diagnostic?.severity, resolved.get("gain")?.diagnostic?.code]).toEqual(["error", "parameter.bind.unreadable"]);
  });

  it("survives a circular bind at runtime — backstop, not the contract (§V110)", () => {
    const resolved = resolveParameters(
      nodeWith({
        gain: slot("bind", { bind: { kind: "bind", ref: "gain" } }),
      }),
      solidLike, STORED_READ,
    );
    expect(resolved.get("gain")?.value).toBe(4); // default; no hang, no throw
    expect(resolved.get("gain")?.diagnostic?.code).toBe("parameter.bind.unreadable");
    expect(resolved.get("gain")?.diagnostic?.message).toContain("cannot bind to itself");
  });

  /**
   * §T1641b slice 1b — EVERY WAY A BIND FAILS HAS ITS OWN CODE, as slice 1 did for an
   * expression. `parameter.bind` was one warning for a ref that names nothing this node has
   * (it can never read) beside a value that is past a limit at this moment (it reads at
   * another value). Both directions: the first kind is an error, the second stays as loud
   * as it was.
   */
  describe("the kind of a failed bind decides its code and its severity (T1641b slice 1b)", () => {
    const mixed: NodeDefinition = {
      ...solidLike,
      parameters: {
        gain: { type: "number", label: "Gain", default: 4, min: 0, max: 64 },
        amount: { type: "number", label: "Amount", default: 0.5, min: 0, max: 1, range: "bounded" },
        on: { type: "boolean", label: "On", default: false },
        tint: { type: "color", label: "Tint", default: [0, 0, 0, 1], space: "linear" },
      },
    };
    const bound = (ref: string, retained?: number) =>
      slot("bind", { bind: { kind: "bind", ref }, ...(retained === undefined ? {} : { static: { kind: "static", value: retained } }) });
    const said = (parameters: GraphNode["parameters"], key: string, read = STORED_READ as Parameters<typeof resolveParameters>[2]) =>
      resolveParameters(nodeWith(parameters), mixed, read).get(key);
    const verdict = (parameters: GraphNode["parameters"], key: string, read?: Parameters<typeof resolveParameters>[2]) => {
      const diagnostic = said(parameters, key, read)?.diagnostic;
      return diagnostic == null ? null : [diagnostic.severity, diagnostic.code, diagnosticClass(diagnostic.code)];
    };

    it("is an error when the bind can never read: nothing of that name, no such part, itself", () => {
      const never = ["error", "parameter.bind.unreadable", "never"];
      expect(verdict({ gain: bound("gian", 2) }, "gain")).toEqual(never);
      expect(verdict({ gain: bound("tint.q", 2) }, "gain")).toEqual(never);
      expect(verdict({ gain: bound("gain", 2) }, "gain")).toEqual(never);
      // The stored value stands in, and the nearest declared key is named.
      const missing = said({ gain: bound("gian", 2) }, "gain");
      expect(missing?.value).toBe(2);
      expect(missing?.diagnostic?.message).toContain("it names no parameter on this node (it has amount, gain, on, tint)");
      expect(missing?.diagnostic?.suggestion).toBe('Nearest: "gain".');
    });

    it("is an error when what is bound is of another type: no value of it fits", () => {
      const never = ["error", "parameter.bind.type", "never"];
      // A whole colour onto a number, and a boolean onto a number.
      expect(verdict({ gain: bound("tint", 2) }, "gain")).toEqual(never);
      expect(verdict({ gain: bound("on", 2) }, "gain")).toEqual(never);
      expect(said({ gain: bound("tint", 2) }, "gain")?.value).toBe(2);
    });

    it("stays a warning when the bound VALUE is past this parameter's limit: another value fits", () => {
      // `amount` is 0…1; `gain` holds 3.
      expect(verdict({ gain: 3, amount: bound("gain", 0.25) }, "amount")).toEqual(["warning", "parameter.bind.value", "degraded"]);
      expect(said({ gain: 3, amount: bound("gain", 0.25) }, "amount")?.value).toBe(0.25);
      // And the same bind reads the moment the value fits: it was never a bind to nothing.
      expect(said({ gain: 0.75, amount: bound("gain", 0.25) }, "amount")).toMatchObject({ value: 0.75, driven: true, diagnostic: null });
    });

    it("survives a loop of binds, which the node's own check names with the loop's code (§V110)", () => {
      const loop = { gain: bound("amount", 2), amount: bound("gain", 0.25) };
      // The resolver's guard is a backstop ONE HOP INSIDE the loop: it stops the recursion,
      // and a bind reads what its sibling is in effect, so the parameter at the top reads
      // the fallback and says nothing of a loop. That is why the loop is not the resolver's
      // to report: the compile asks the whole node, once, and that check owns the code.
      expect(said(loop, "gain")?.value).toBe(0.25);
      const looped = nodeWith(loop);
      const named = bindCycleDiagnostics(looped, effectiveParameterSchema(mixed, looped.parameters));
      expect(named.length).toBeGreaterThan(0);
      expect(named.map((entry) => [entry.severity, entry.code, diagnosticClass(entry.code)])).toEqual(
        named.map(() => ["error", "parameter.bindCycle", "never"]),
      );
    });

    it("says of a parent ref what the scope it was GIVEN says, and of a missing scope that it is the caller's", () => {
      // With the component's scope: a key the component does not publish can never read.
      const scoped = { ...STORED_READ, parentBind: parentBindResolver(buildParentScope([{ gain: 9 }])) };
      expect(verdict({ gain: bound("parent.gane", 2) }, "gain", scoped)).toEqual(["error", "parameter.bind.unreadable", "never"]);
      expect(verdict({ gain: bound("parent.gain", 2) }, "gain", scoped)).toBeNull();
      // With no scope handed over at all: nothing is known of the document. Not an error.
      expect(verdict({ gain: bound("parent.gain", 2) }, "gain")).toEqual(["warning", "parameter.bind.unavailable", "build"]);
    });
  });

  it("holds a driven parameter at its retained value until a channel attaches (T203 reserved)", () => {
    const stored = slot("driven", {
      driven: { kind: "driven", channel: "audio.rms" },
      static: { kind: "static", value: 8 },
    });
    const idle = resolveParameters(nodeWith({ gain: stored }), solidLike, STORED_READ);
    expect(idle.get("gain")?.value).toBe(8);
    expect(idle.get("gain")?.diagnostic?.severity).toBe("info");

    const attached = resolveParameters(nodeWith({ gain: stored }), solidLike, testRead({
      channels: (channel) => (channel === "audio.rms" ? 32 : undefined),
    }));
    expect(attached.get("gain")).toMatchObject({ value: 32, mode: "driven", driven: true });
  });

  /**
   * B155 — a channel overshooting a bounded range was an ERROR, and the error was fatal.
   *
   * E43 drives a 0…1 `amount` from an audio band, and the band grazes ~1.06 at a peak —
   * the signal working, not a wrong document. The raw value went to the manifest check,
   * came back `parameter.range` at error severity, snapped the value to the retained
   * fallback (0 — glitch dead), and because the app's structural compile resolves with
   * the LIVE channel resolver, a compile landing on a peak turned `plan.ok` false and
   * blacked out the whole document. A driven number now pins into its declared range
   * exactly as an expression result does (T368), with the same warning-severity report.
   */
  it("pins a driven number into its declared range and SAYS SO — never an error (B155)", () => {
    const stored = slot("driven", {
      driven: { kind: "driven", channel: "gd1:high" },
      static: { kind: "static", value: 0 },
    });
    const resolved = resolveParameters(nodeWith({ gain: stored }), solidLike, testRead({
      channels: (channel) => (channel === "gd1:high" ? 67.9245 : undefined),
    }));
    const entry = resolved.get("gain");
    expect(entry?.value).toBe(64); // the limit, not the retained fallback
    expect(entry?.driven).toBe(true);
    expect(entry?.diagnostic?.code).toBe("parameter.driven.clamped");
    expect(entry?.diagnostic?.severity).toBe("warning"); // fatal error was the bug
    expect(entry?.diagnostic?.message).toContain('"gain"');
    expect(entry?.diagnostic?.message).toContain("gd1:high"); // the channel, by name
    expect(entry?.diagnostic?.message).toContain("67.9245"); // what it actually produced
    expect(entry?.diagnostic?.message).toContain("0…64"); // the declared bounds
    expect(resolved.diagnostics.some((d) => d.severity === "error")).toBe(false);
  });

  it("stays quiet while the channel is inside the range — the warning is not ambient", () => {
    const stored = slot("driven", {
      driven: { kind: "driven", channel: "gd1:high" },
      static: { kind: "static", value: 0 },
    });
    const resolved = resolveParameters(nodeWith({ gain: stored }), solidLike, testRead({
      channels: () => 32,
    }));
    expect(resolved.get("gain")?.value).toBe(32);
    expect(resolved.diagnostics).toEqual([]);
  });

  it("retains every mode's payload across the active-mode switch (§V108)", () => {
    // The same slot resolved twice with only `mode` differing: neither resolution
    // destroys or ignores the other mode's payload.
    const bindings = {
      static: { kind: "static", value: 12 },
      expression: { kind: "expression", source: "time * 3" },
    };
    const asStatic = resolveParameters(nodeWith({ gain: slot("static", bindings) }), solidLike, testRead({ frame }));
    const asExpr = resolveParameters(nodeWith({ gain: slot("expression", bindings) }), solidLike, testRead({ frame }));
    expect(asStatic.get("gain")?.value).toBe(12);
    expect(asExpr.get("gain")?.value).toBe(6);
    expect(asStatic.get("gain")?.slot?.bindings.expression).toEqual(bindings.expression);
  });
});

describe("compound components (T207, §V113)", () => {
  const frame = {
    timeSeconds: 0.5,
    deltaSeconds: 0.016,
    frameIndex: 30,
    mode: "realtime",
    randomSeed: 7,
  } as const;

  it("lets one channel run an expression while its siblings stay put", () => {
    const resolved = resolveParameters(
      nodeWith({
        linearColor: [0.1, 0.2, 0.3, 1],
        "linearColor.g": {
          mode: "expression",
          bindings: { expression: { kind: "expression", source: "time" } },
        } as unknown as GraphNode["parameters"][string],
      }),
      solidLike,
      testRead({ frame }),
    );
    const entry = resolved.get("linearColor");
    expect(entry?.value).toEqual([0.1, 0.5, 0.3, 1]);
    expect(entry?.driven).toBe(true);
    expect(entry?.components?.map((c) => c.mode)).toEqual(["static", "expression", "static", "static"]);
  });

  it("keeps the output compound-keyed — component keys never reach values", () => {
    const resolved = resolveParameters(
      nodeWith({
        linearColor: [0, 0, 0, 1],
        "linearColor.r": {
          mode: "static",
          bindings: { static: { kind: "static", value: 1 } },
        } as unknown as GraphNode["parameters"][string],
      }),
      solidLike, STORED_READ,
    );
    expect(Object.keys(resolved.values)).not.toContain("linearColor.r");
    expect(resolved.values["linearColor"]).toEqual([1, 0, 0, 1]);
  });

  it("decodes display colour AFTER assembly, so a driven channel is decoded too", () => {
    const resolved = resolveParameters(
      nodeWith({
        color: [0, 0, 0, 1],
        "color.r": {
          mode: "expression",
          bindings: { expression: { kind: "expression", source: "time" } },
        } as unknown as GraphNode["parameters"][string],
      }),
      solidLike,
      testRead({ frame }),
    );
    // entry.value stays display-encoded; values gets the linear decode of 0.5.
    expect((resolved.get("color")?.value as readonly number[])[0]).toBe(0.5);
    expect((resolved.values["color"] as readonly number[])[0]).toBeCloseTo(0.214, 3);
  });

  it("binds a scalar to one component of a sibling compound", () => {
    const resolved = resolveParameters(
      nodeWith({
        linearColor: [0.25, 0, 0, 1],
        gain: {
          mode: "bind",
          bindings: { bind: { kind: "bind", ref: "linearColor.r" } },
        } as unknown as GraphNode["parameters"][string],
      }),
      solidLike, STORED_READ,
    );
    expect(resolved.get("gain")?.value).toBe(0.25);
  });
});

describe("the map mode resolves as data, not a value (T286/§V287)", () => {
  const definition = { type: "number", label: "Size", default: 4 } as const;

  it("hands evaluation the retained static and reports the mapping beside it", () => {
    const node = {
      id: "n1",
      type: "renderPoints",
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      parameters: {
        sizePixels: {
          mode: "map",
          bindings: {
            static: { kind: "static", value: 7 },
            map: { kind: "map", attribute: "size" },
          },
        },
      },
    } as never;
    const resolved = resolveParameterSchema(node, { sizePixels: definition }, STORED_READ);
    // §V108's corner-square: the inspector and the zero-frame compile see 7.
    expect(resolved.values["sizePixels"]).toBe(7);
    // §V287: the mapping is DATA the consumer compiles from.
    expect(resolved.maps).toEqual({ sizePixels: { attribute: "size" } });
    // A mapped parameter is a NORMAL state — no diagnostic (§V288: the consumer that
    // cannot honour it is the one that speaks).
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.get("sizePixels")?.mode).toBe("map");
  });

  it("falls to the manifest default when no static was ever retained", () => {
    const node = {
      id: "n1",
      type: "renderPoints",
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      parameters: {
        sizePixels: { mode: "map", bindings: { map: { kind: "map", attribute: "size", channel: "x" } } },
      },
    } as never;
    const resolved = resolveParameterSchema(node, { sizePixels: definition }, STORED_READ);
    expect(resolved.values["sizePixels"]).toBe(4);
    expect(resolved.maps["sizePixels"]).toEqual({ attribute: "size", channel: "x" });
  });

  it("an unmapped document resolves with an empty maps record", () => {
    const node = {
      id: "n1",
      type: "renderPoints",
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      parameters: { sizePixels: 9 },
    } as never;
    const resolved = resolveParameterSchema(node, { sizePixels: definition }, STORED_READ);
    expect(resolved.maps).toEqual({});
    expect(resolved.values["sizePixels"]).toBe(9);
  });
});

describe("map on a COMPOUND HEAD (T364, §V195 as amended)", () => {
  it("a slot at the bare compound key collects into maps and evaluation keeps the tuple", () => {
    const node = {
      id: "n1",
      type: "renderPoints",
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      parameters: {
        color: {
          mode: "map",
          bindings: {
            static: { kind: "static", value: [1, 0, 0, 1] },
            map: { kind: "map", attribute: "tint" },
          },
        },
      },
    } as never;
    const resolved = resolveParameterSchema(node, {
      color: { type: "color", label: "Color", default: [1, 1, 1, 1], space: "display" },
    }, STORED_READ);
    expect(resolved.maps).toEqual({ color: { attribute: "tint" } });
    // The retained tuple still resolves for the inspector and the zero-frame compile.
    expect(Array.isArray(resolved.values["color"])).toBe(true);
    expect(resolved.get("color")?.mode).toBe("map");
  });
});
