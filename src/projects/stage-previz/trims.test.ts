import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileGraph } from "../../compiler/index.ts";
import { createComponentSystem } from "../../domain/components/index.ts";
import { projectorMatrix, type Mat4 } from "../../domain/geometry/camera.ts";
import type { ChannelResolver } from "../../domain/parameters/resolve.ts";
import { loadProject } from "../../domain/project/index.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";

/**
 * VN78 — stage-previz-9: the truss trims and the four presets, read back where the session's
 * consumers read them: each haze beam's uniforms carry its projector's lens, aim, roll, throw
 * and keystone as the compile resolved them, and the image's corners are cast through
 * `projectorMatrix` onto the surface they land on.
 *
 * Model facts (glTF metres, the committed GLB): the scrim's flat part is 36' wide at z −4.35;
 * the deck's top is 1.8572, 48' wide, its front edge at z 4.7536.
 */
const FT = 0.3048;
const SCRIM_Z = -4.35;
const SCRIM_HALF = 18 * FT;
const DECK_TOP = 1.8572;
const DECK_HALF = 24 * FT;
const DECK_FRONT = 4.7536;
/** The matrices are float32 (camera.ts): a corner cast back through one lands within a millimetre. */
const MM = 1e-3;

type V3 = readonly [number, number, number];
interface Beam {
  readonly lens: V3;
  readonly lensAim: V3;
  readonly spin: number;
  readonly throwRatio: number;
  readonly aspect: number;
  readonly shiftX: number;
  readonly shiftY: number;
  readonly keystoneH: number;
  readonly keystoneV: number;
}

const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
const loaded = loadProject(readFileSync("projects/stage-previz/stage-previz-9.loom.json", "utf8"), { nodes: system.nodes, components: system.components });
if (!loaded.ok) throw new Error(`stage-previz-9 did not load: ${loaded.reason}`);
const document = loaded.document;
const bank = Object.values(document.graph.nodes).find((entry) => entry.type === "presets")!;
const presets = (JSON.parse(String(bank.parameters["presets"])) as { presets: Array<{ name: string; values: Record<string, Record<string, number | boolean>> }> }).presets;

/** Every fader at a preset's value (a channel is `<name>:<role>`), any override on top. */
function beams(preset: string, overrides: Readonly<Record<string, number>> = {}): { readonly SR: Beam; readonly SL: Beam; readonly DS: Beam } {
  const values: Record<string, number> = {};
  for (const [label, value] of Object.entries(presets.find((entry) => entry.name === preset)!.values)) {
    values[label.replace(/^(slider|toggle)_/, "")] = Number(value["value"] ?? (value["on"] === true ? 1 : 0));
  }
  Object.assign(values, overrides);
  const channels: ChannelResolver = (name, context) => (context.definition.type === "number" ? values[name.split(":")[1] ?? name] : undefined);
  const plan = compileGraph({ graph: document.graph, settings: document.settings, registry: system.nodes, capabilities: TIER_B_CAPABILITIES, components: system.components.view(), resolution: { channels } });
  if (!plan.ok) throw new Error("stage-previz-9 did not compile");
  const found = plan.passes.map((pass) => (pass as { uniforms?: Partial<Beam> }).uniforms).filter((uniforms): uniforms is Beam => uniforms?.lensAim !== undefined);
  const which = (test: (x: number) => boolean) => {
    const beam = found.find((entry) => test(entry.lens[0]));
    if (beam === undefined) throw new Error("a beam is missing");
    return beam;
  };
  return { SR: which((x) => x < -1), SL: which((x) => x > 1), DS: which((x) => Math.abs(x) < 1e-6) };
}

function invert(m: Mat4): number[] {
  const a = [...Array(4)].map((_, row) => [...Array(4)].map((__, column) => m[column * 4 + row]!));
  const b: number[][] = [...Array(4)].map((_, row) => [...Array(4)].map((__, column) => (row === column ? 1 : 0)));
  for (let column = 0; column < 4; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 4; row += 1) if (Math.abs(a[row]![column]!) > Math.abs(a[pivot]![column]!)) pivot = row;
    [a[column], a[pivot]] = [a[pivot]!, a[column]!];
    [b[column], b[pivot]] = [b[pivot]!, b[column]!];
    const d = a[column]![column]!;
    for (let k = 0; k < 4; k += 1) {
      a[column]![k] = a[column]![k]! / d;
      b[column]![k] = b[column]![k]! / d;
    }
    for (let row = 0; row < 4; row += 1) {
      if (row === column) continue;
      const f = a[row]![column]!;
      for (let k = 0; k < 4; k += 1) {
        a[row]![k] = a[row]![k]! - f * a[column]![k]!;
        b[row]![k] = b[row]![k]! - f * b[column]![k]!;
      }
    }
  }
  return [...Array(16)].map((_, index) => b[index % 4]![Math.floor(index / 4)]!);
}

/** Where the image's corner (u, v) in ndc lands on the plane `axis` = `value`. */
function corner(beam: Beam, u: number, v: number, axis: 0 | 1 | 2, value: number): V3 {
  const inverse = invert(projectorMatrix({ eye: beam.lens, lookAt: beam.lensAim, roll: beam.spin }, beam));
  const at = (z: number): V3 => {
    const w = inverse[3]! * u + inverse[7]! * v + inverse[11]! * z + inverse[15]!;
    return [0, 1, 2].map((i) => (inverse[i]! * u + inverse[4 + i]! * v + inverse[8 + i]! * z + inverse[12 + i]!) / w) as unknown as V3;
  };
  const near = at(0.1);
  const far = at(0.9);
  const t = (value - near[axis]) / (far[axis] - near[axis]);
  return [0, 1, 2].map((i) => near[i]! + (far[i]! - near[i]!) * t) as unknown as V3;
}
const corners = (beam: Beam, axis: 0 | 1 | 2, value: number) =>
  ({ topLeft: corner(beam, -1, 1, axis, value), topRight: corner(beam, 1, 1, axis, value), bottomRight: corner(beam, 1, -1, axis, value), bottomLeft: corner(beam, -1, -1, axis, value) });

describe("stage-previz-9: the trims and the presets", () => {
  it("holds four presets, a 0.37 and a 0.74 DS lens at each of the two trims, every one on live input", () => {
    expect(presets.map((preset) => preset.name)).toEqual(["ds37_21ft", "ds74_21ft", "ds37_26ft", "ds74_26ft"]);
    for (const preset of presets) {
      const [lens, trim] = /^ds(\d+)_(\d+)ft$/.exec(preset.name)!.slice(1).map(Number);
      expect(preset.values["slider_source"]).toEqual({ value: 0 });
      expect(preset.values["slider_dsThrow"]).toEqual({ value: lens! / 100 });
      expect(preset.values["slider_trussTrim"]).toEqual({ value: trim });
      expect(preset.values["slider_dsTrim"]).toEqual({ value: trim });
    }
  });

  it.each(presets.map((preset) => preset.name))("%s: the DS image fills the scrim's width, level and square", (name) => {
    const { DS } = beams(name);
    const c = corners(DS, 2, SCRIM_Z);
    for (const point of Object.values(c)) expect(Math.abs(Math.abs(point[0]) - SCRIM_HALF)).toBeLessThan(MM);
    expect(Math.abs(c.topLeft[1] - c.topRight[1])).toBeLessThan(MM);
    expect(Math.abs(c.bottomLeft[1] - c.bottomRight[1])).toBeLessThan(MM);
  });

  it.each([21, 26])("%i': the 0.37 and the 0.74 cover the scrim the same: the same top edge, both past the scrim's foot", (trim) => {
    const wide = corners(beams(`ds37_${trim}ft`).DS, 2, SCRIM_Z);
    const long = corners(beams(`ds74_${trim}ft`).DS, 2, SCRIM_Z);
    expect(Math.abs(wide.topLeft[1] - long.topLeft[1])).toBeLessThan(MM);
    // the scrim's visible foot is the riser's top (layout.py RISER_TOP, 1.4 + 7'7")
    const riserTop = 1.4 + (7 + 7 / 12) * FT;
    expect(wide.bottomLeft[1]).toBeLessThan(riserTop);
    expect(long.bottomLeft[1]).toBeLessThan(riserTop);
  });

  it.each(presets.map((preset) => preset.name))("%s: each side image is square on the deck and runs off neither side nor the front", (name) => {
    const both = beams(name);
    for (const [side, beam] of [["SR", both.SR], ["SL", both.SL]] as const) {
      const c = corners(beam, 1, DECK_TOP);
      const xs = Object.values(c).map((point) => point[0]);
      const zs = Object.values(c).map((point) => point[2]);
      // the far edge on the opposite deck edge
      expect(Math.abs(Math.max(...xs.map(Math.abs)) - DECK_HALF), side).toBeLessThan(MM);
      for (const x of xs) expect(Math.abs(x), side).toBeLessThan(DECK_HALF + MM);
      for (const z of zs) expect(z, side).toBeLessThan(DECK_FRONT + MM);
      // square: its long edges run straight across the stage
      expect(Math.abs(c.topLeft[2] - c.topRight[2]), side).toBeLessThan(MM);
      expect(Math.abs(c.bottomLeft[2] - c.bottomRight[2]), side).toBeLessThan(MM);
    }
    // together they fill the width: each far edge is on the opposite deck edge (above), and
    // stage right's near edge lies left of stage left's, so no gap opens between them
    const reach = (beam: Beam) => Object.values(corners(beam, 1, DECK_TOP)).map((point) => point[0]);
    expect(Math.min(...reach(both.SR))).toBeLessThanOrEqual(Math.max(...reach(both.SL)));
  });

  it("Truss trim carries the side lenses and nothing of the DS; DS truss trim carries the DS lens and nothing of the sides", () => {
    const at21 = beams("ds37_21ft");
    const frame = beams("ds37_21ft", { trussTrim: 26 });
    const ds = beams("ds37_21ft", { dsTrim: 26 });
    expect(frame.SR.lens[1] - at21.SR.lens[1]).toBeCloseTo(5 * FT, 4);
    expect(frame.SL.lens[1] - at21.SL.lens[1]).toBeCloseTo(5 * FT, 4);
    expect(frame.DS.lens).toEqual(at21.DS.lens);
    expect(ds.DS.lens[1] - at21.DS.lens[1]).toBeCloseTo(5 * FT, 4);
    expect(ds.DS.lensAim[1] - at21.DS.lensAim[1]).toBeCloseTo(5 * FT, 4);
    expect(ds.SR.lens).toEqual(at21.SR.lens);
  });

  it("opens on the first preset, Source on live, both trims at 21'", () => {
    const value = (label: string) => Object.values(document.graph.nodes).find((entry) => entry.label === label)!.parameters["value"];
    expect(bank.parameters["current"]).toBe("ds37_21ft");
    expect(value("slider_source")).toBe(0);
    expect(value("slider_trussTrim")).toBe(21);
    expect(value("slider_dsTrim")).toBe(21);
  });
});
