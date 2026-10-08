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
 * VN78, VN79 — the truss trims and the presets of stage-previz-9 and -10, read back where the
 * session's consumers read them: each haze beam's uniforms carry its projector's lens, aim,
 * roll, throw and keystone as the compile resolved them, and the image's corners are cast
 * through `projectorMatrix` onto the surface they land on.
 *
 * Model facts (glTF metres, from each session's GLB): -9 is on the first export (`stage.glb`):
 * the scrim's flat part 36' wide at z −4.35, the deck's top 1.8572, trims in feet off the venue
 * floor. -10 is on layout revision 2 (`stage-r2.glb`): the scrim's straight face 30' wide at
 * z −2.6816, its top at 8.5598, the deck's top 1.9812, trims in feet above the house deck; its
 * presets are the 0.74 alone, from where the plot hangs its truss (42.9' wide) and slid upstage
 * to fill the face. Both decks are 48' wide with their front edge at z 4.7536.
 */
const FT = 0.3048;
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

interface Session {
  readonly file: string;
  readonly scrimZ: number;
  readonly deckTop: number;
  /** Each preset by name, with the trim (feet) its faders hold and the half width (m) its DS image lands. */
  readonly presets: Readonly<Record<string, { readonly trim: number; readonly half: number }>>;
  /** Where every DS image's top edge lands, when the presets hold it on the scrim's top. */
  readonly scrimTop?: number;
  /** Where the faders open. */
  readonly openTrim: number;
}
const SESSIONS: readonly Session[] = [
  {
    file: "stage-previz-9", scrimZ: -4.35, deckTop: 1.8572, openTrim: 21,
    presets: { ds37_21ft: { trim: 21, half: 18 * FT }, ds74_21ft: { trim: 21, half: 18 * FT }, ds37_26ft: { trim: 26, half: 18 * FT }, ds74_26ft: { trim: 26, half: 18 * FT } },
  },
  {
    file: "stage-previz-10", scrimZ: -2.6816, deckTop: 1.9812, openTrim: 22.5833, scrimTop: 8.5598,
    presets: { ds74_plot: { trim: 22.5833, half: 42.9208 / 2 * FT }, ds74_fill: { trim: 22.5833, half: 15 * FT } },
  },
];

/** Each session in a component system of its own: -9 and -10 define components under the same ids. */
function open(session: Session) {
  const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
  const loaded = loadProject(readFileSync(`projects/stage-previz/${session.file}.loom.json`, "utf8"), { nodes: system.nodes, components: system.components });
  if (!loaded.ok) throw new Error(`${session.file} did not load: ${loaded.reason}`);
  const document = loaded.document;
  const bank = Object.values(document.graph.nodes).find((entry) => entry.type === "presets")!;
  const presets = (JSON.parse(String(bank.parameters["presets"])) as { presets: Array<{ name: string; values: Record<string, Record<string, number | boolean>> }> }).presets;
  return { system, document, bank, presets };
}

/** Every fader at a preset's value (a channel is `<name>:<role>`), any override on top. */
function beams(opened: ReturnType<typeof open>, preset: string, overrides: Readonly<Record<string, number>> = {}): { readonly SR: Beam; readonly SL: Beam; readonly DS: Beam } {
  const { system, document, presets } = opened;
  const values: Record<string, number> = {};
  for (const [label, value] of Object.entries(presets.find((entry) => entry.name === preset)!.values)) {
    values[label.replace(/^(slider|toggle)_/, "")] = Number(value["value"] ?? (value["on"] === true ? 1 : 0));
  }
  Object.assign(values, overrides);
  const channels: ChannelResolver = (name, context) => (context.definition.type === "number" ? values[name.split(":")[1] ?? name] : undefined);
  const plan = compileGraph({ graph: document.graph, settings: document.settings, registry: system.nodes, capabilities: TIER_B_CAPABILITIES, components: system.components.view(), resolution: { channels } });
  if (!plan.ok) throw new Error(`${document.name} did not compile`);
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

describe.each(SESSIONS)("$file: the trims and the presets", (session) => {
  const opened = open(session);
  const names = Object.keys(session.presets);

  it("holds its DS lens presets at each trim, every one on live input", () => {
    expect(opened.presets.map((preset) => preset.name)).toEqual(names);
    for (const preset of opened.presets) {
      expect(preset.values["slider_source"]).toEqual({ value: 0 });
      expect(preset.values["slider_dsThrow"]).toEqual({ value: preset.name.startsWith("ds37") ? 0.37 : 0.74 });
      expect(preset.values["slider_trussTrim"]).toEqual({ value: session.presets[preset.name]!.trim });
      expect(preset.values["slider_dsTrim"]).toEqual({ value: session.presets[preset.name]!.trim });
    }
  });

  it.each(names)("%s: the DS image lands its width on the scrim, level and square", (name) => {
    const { DS } = beams(opened, name);
    const c = corners(DS, 2, session.scrimZ);
    // the plotted 0.74 is 42.9' wide to the inch: four decimals of a foot, a few hundredths of a millimetre
    for (const point of Object.values(c)) expect(Math.abs(Math.abs(point[0]) - session.presets[name]!.half)).toBeLessThan(MM);
    if (session.scrimTop !== undefined) expect(Math.abs(c.topLeft[1] - session.scrimTop)).toBeLessThan(MM);
    expect(Math.abs(c.topLeft[1] - c.topRight[1])).toBeLessThan(MM);
    expect(Math.abs(c.bottomLeft[1] - c.bottomRight[1])).toBeLessThan(MM);
  });

  const paired = [...new Set(Object.values(session.presets).map((preset) => preset.trim))].filter((trim) => names.some((name) => name.startsWith("ds37") && session.presets[name]!.trim === trim));
  it.skipIf(paired.length === 0).each(paired)("%s': the 0.37 and the 0.74 cover the scrim the same: the same top edge, both past the scrim's foot", (trim) => {
    const at = (lens: string) => names.find((name) => name.startsWith(lens) && session.presets[name]!.trim === trim)!;
    const wide = corners(beams(opened, at("ds37")).DS, 2, session.scrimZ);
    const long = corners(beams(opened, at("ds74")).DS, 2, session.scrimZ);
    expect(Math.abs(wide.topLeft[1] - long.topLeft[1])).toBeLessThan(MM);
    // the scrim's visible foot is the riser's top: 7'7" over the house deck (1.4, then 5'0")
    const riserTop = (session.file === "stage-previz-9" ? 1.4 : 5 * FT) + (7 + 7 / 12) * FT;
    expect(wide.bottomLeft[1]).toBeLessThan(riserTop);
    expect(long.bottomLeft[1]).toBeLessThan(riserTop);
  });

  it.each(names)("%s: each side image is square on the deck and runs off neither side nor the front", (name) => {
    const both = beams(opened, name);
    for (const [side, beam] of [["SR", both.SR], ["SL", both.SL]] as const) {
      const c = corners(beam, 1, session.deckTop);
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
    const reach = (beam: Beam) => Object.values(corners(beam, 1, session.deckTop)).map((point) => point[0]);
    expect(Math.min(...reach(both.SR))).toBeLessThanOrEqual(Math.max(...reach(both.SL)));
  });

  it("Truss trim carries the side lenses and nothing of the DS; DS truss trim carries the DS lens and nothing of the sides", () => {
    const first = names[0]!;
    const base = beams(opened, first);
    const frame = beams(opened, first, { trussTrim: session.presets[first]!.trim + 5 });
    const ds = beams(opened, first, { dsTrim: session.presets[first]!.trim + 5 });
    expect(frame.SR.lens[1] - base.SR.lens[1]).toBeCloseTo(5 * FT, 4);
    expect(frame.SL.lens[1] - base.SL.lens[1]).toBeCloseTo(5 * FT, 4);
    expect(frame.DS.lens).toEqual(base.DS.lens);
    expect(ds.DS.lens[1] - base.DS.lens[1]).toBeCloseTo(5 * FT, 4);
    expect(ds.DS.lensAim[1] - base.DS.lensAim[1]).toBeCloseTo(5 * FT, 4);
    expect(ds.SR.lens).toEqual(base.SR.lens);
  });

  it("opens on the first preset, Source on live, both trims where the presets put them", () => {
    const value = (label: string) => Object.values(opened.document.graph.nodes).find((entry) => entry.label === label)!.parameters["value"];
    expect(opened.bank.parameters["current"]).toBe(names[0]);
    expect(value("slider_source")).toBe(0);
    expect(value("slider_trussTrim")).toBe(session.openTrim);
    expect(value("slider_dsTrim")).toBe(session.openTrim);
  });
});

describe("stage-previz-10: the trims are measured from the house deck", () => {
  it("at the plot's 22'-7\", the frame's projectors hang where layout revision 2 puts them", () => {
    const opened = open(SESSIONS[1]!);
    const { SR, DS } = beams(opened, "ds74_plot", { dsTilt: 0 });
    // layout.py: the side lens 20'-5" over the house deck, the DS lens 19'-8" at zero tilt (5'0" house deck)
    expect(SR.lens[1]).toBeCloseTo(5 * FT + (20 + 5 / 12) * FT, 3);
    expect(DS.lens[1]).toBeCloseTo(5 * FT + (19 + 8 / 12) * FT, 3);
  });
});
