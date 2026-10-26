import { describe, expect, it } from "vitest";
import { createMa3Playback, DMX_SLOTS, parseMa3Show, phaserValue, type Ma3ShowFile, type ShowCue } from "./ma3-show.ts";

/**
 * VN131 — the show player read back where a consumer reads it: the DMX bytes.
 *
 * Fixture 1 is a two-cell pixel bar (master on slot 1, RGB cells on 2-4 and 5-7, each cell
 * behind a virtual dimmer, the RGB group behind another) at universe 2, address 10. Fixture 2
 * is a mover (16-bit pan, CMY fed by the show's RGB, a shutter held open) at universe 1,
 * address 1.
 */
const cue = (no: number, part: Partial<ShowCue>): ShowCue => ({ no, name: `c${no}`, fade: 0, off: [], set: [], release: [], phasers: [], ...part });

function show(overrides: Partial<Ma3ShowFile> = {}): Ma3ShowFile {
  return {
    format: "loom-ma3-show", version: 1,
    fixtures: [
      { fid: 1, name: "bar", layer: "PL", type: "bar", kind: "pixelbar", universe: 2, address: 10, position: [0, 0, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
      { fid: 2, name: "mover", layer: "M", type: "mover", kind: "mover", universe: 1, address: 1, position: [0, 0, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
    ],
    types: {
      bar: {
        footprint: 7, kind: "bar", virtualDimmers: ["1", "1.1", "1.2"],
        channels: [
          { offset: [1], sub: "", attr: "Dimmer", default: 100 },
          ...[1, 2].flatMap(k => ["ColorRGB_R", "ColorRGB_G", "ColorRGB_B"].map((attr, i) => ({ offset: [2 + 3 * (k - 1) + i], sub: `1.${k}`, attr, default: 100 }))),
        ],
      },
      mover: {
        footprint: 6, kind: "mover",
        channels: [
          { offset: [1, 2], sub: "", attr: "Pan", physFrom: -270, physTo: 270 },
          { offset: [3], sub: "", attr: "ColorSub_C", source: "ColorRGB_R", invert: true },
          { offset: [4], sub: "", attr: "Shutter1", fixed: true, default: 20 },
          { offset: [5], sub: "", attr: "Dimmer" },
        ],
      },
    },
    // 0 bar cell1 dim, 1 bar cell1 R, 2 bar cell2 dim, 3 mover pan, 4 mover R, 5 mover dimmer, 6 mover shutter (programmed, must be ignored)
    channels: [[1, "1.1", "Dimmer"], [1, "1.1", "ColorRGB_R"], [1, "1.2", "Dimmer"], [2, "", "Pan"], [2, "", "ColorRGB_R"], [2, "", "Dimmer"], [2, "", "Shutter1"]],
    sequences: [
      { no: 10, name: "look", tracking: true, wrap: false, offFade: 0, cues: [
        cue(1, { set: [[0, 100], [1, 50], [3, 90, 1], [6, 0, 1]] }),
        cue(2, { fade: 2, set: [[0, 50], [5, 100]] }),
      ] },
      { no: 20, name: "hit", tracking: false, wrap: false, offFade: 0.5, cues: [cue(1, { off: [20], set: [[2, 100], [0, 0]] })] },
      { no: 30, name: "notrack", tracking: false, wrap: true, offFade: 0, cues: [cue(1, { set: [[4, 0]] }), cue(2, { set: [[5, 40]] })] },
    ],
    timecode: { name: "song", start: "0:00:00", events: [] },
    ...overrides,
  };
}

const bar = (dmx: Float32Array, slot: number): number => Math.round(dmx[(2 - 1) * DMX_SLOTS + 10 - 1 + slot - 1]! * 255);
const mover = (dmx: Float32Array, slot: number): number => Math.round(dmx[slot - 1]! * 255);

describe("ma3 show playback (VN131)", () => {
  it("encodes a cell's colour through its virtual dimmers at the patched universe and address", () => {
    const pb = createMa3Playback(show({ timecode: { name: "s", start: "0", events: [[1, 10, 0, 1]] } }));
    expect(bar(pb.evaluate(0.5), 2)).toBe(0);              // before the cue: the cell dimmer is closed
    const dmx = pb.evaluate(1.5);
    expect(bar(dmx, 1)).toBe(255);                          // master default
    expect(bar(dmx, 2)).toBe(Math.round(0.5 * 255));        // R 50 % x cell 100 % x group 100 %
    expect(bar(dmx, 3)).toBe(255);                          // G default 100 % x cell 100 %
    expect(bar(dmx, 5)).toBe(0);                            // cell 2's dimmer never set
  });

  it("writes a physical attribute 16-bit and holds a fixed slot at its default", () => {
    const pb = createMa3Playback(show({ timecode: { name: "s", start: "0", events: [[0, 10, 0, 1]] } }));
    const dmx = pb.evaluate(0);
    const word = Math.round(dmx[0]! * 255) * 256 + Math.round(dmx[1]! * 255);
    expect(word).toBe(Math.round(((90 + 270) / 540) * 65535));
    expect(mover(dmx, 4)).toBe(Math.round(0.2 * 255));     // shutter: the programmed 0 is not read
    expect(mover(dmx, 3)).toBe(0);                          // C = 100 % - R (default 100 %)
  });

  it("fades a cue from what the sequence showed, and tracks values the cue does not set", () => {
    const pb = createMa3Playback(show({ timecode: { name: "s", start: "0", events: [[0, 10, 0, 1], [10, 10, 0, 2]] } }));
    expect(bar(pb.evaluate(11), 2)).toBe(Math.round(0.5 * 0.75 * 255));  // cell dim 100 -> 50, halfway
    expect(bar(pb.evaluate(13), 2)).toBe(Math.round(0.5 * 0.5 * 255));
    expect(mover(pb.evaluate(13), 5)).toBe(255);
    const word = (d: Float32Array): number => Math.round(d[0]! * 255) * 256 + Math.round(d[1]! * 255);
    expect(word(pb.evaluate(13))).toBe(Math.round((360 / 540) * 65535));   // pan tracked from cue 1
  });

  it("flashes a hit over what lies under it and releases back over its off fade", () => {
    const pb = createMa3Playback(show({ timecode: { name: "s", start: "0", events: [[0, 10, 0, 1], [5, 20, 0, 1]] } }));
    expect(bar(pb.evaluate(5), 5)).toBe(255);              // the hit's cell 2 at full
    expect(bar(pb.evaluate(5), 2)).toBe(0);                 // and it holds cell 1 down (latest takes precedence)
    expect(bar(pb.evaluate(5.25), 5)).toBe(Math.round(0.5 * 255));
    expect(bar(pb.evaluate(6), 5)).toBe(0);
    expect(bar(pb.evaluate(6), 2)).toBe(Math.round(0.5 * 255));   // back to the look underneath
    expect(pb.active()).toEqual(["look"]);
  });

  it("drops what a non-tracking sequence's previous cue held, and Go+ wraps", () => {
    const pb = createMa3Playback(show({ timecode: { name: "s", start: "0", events: [[0, 30, 1, 0], [1, 30, 1, 0], [2, 30, 1, 0]] } }));
    expect(mover(pb.evaluate(0.5), 3)).toBe(255);          // cue 1: R 0 -> C full
    expect(mover(pb.evaluate(1.5), 3)).toBe(0);            // cue 2 does not carry R
    expect(mover(pb.evaluate(1.5), 5)).toBe(Math.round(0.4 * 255));
    expect(mover(pb.evaluate(2.5), 3)).toBe(255);          // wrapped to cue 1
  });

  it("is a function of time: an earlier frame after a later one reads the same as before", () => {
    const pb = createMa3Playback(show({ timecode: { name: "s", start: "0", events: [[0, 10, 0, 1], [10, 10, 0, 2]] } }));
    const first = Array.from(pb.evaluate(11));
    pb.evaluate(30);
    expect(Array.from(pb.evaluate(11))).toEqual(first);
  });

  it("steps a phaser: a short step flashes, a full step crossfades into the next", () => {
    expect(phaserValue([0, 1, 0, [100, 0], [10, 100], [100, 100]], 0.02)).toBe(100);
    expect(phaserValue([0, 1, 0, [100, 0], [10, 100], [100, 100]], 0.2)).toBe(0);
    expect(phaserValue([0, 1, 0, [100, 0], [100, 100], [100, 100]], 0.25)).toBeCloseTo(50, 5);
    expect(phaserValue([0, 1, 180, [100, 0], [100, 100], [100, 100]], 0)).toBeCloseTo(0, 5);
  });

  it("refuses a file that is not a show, or names a type it does not define", () => {
    expect(() => parseMa3Show("{}")).toThrow(/format/);
    const broken = { ...show(), types: {} };
    expect(() => parseMa3Show(JSON.stringify(broken))).toThrow(/does not define/);
  });
});
