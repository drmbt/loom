import { describe, expect, it } from "vitest";
import {
  ARC_BRANCH_REACH,
  ARC_TICK_MS,
  arcAmplitude,
  arcBolt,
  arcBranch,
  arcTick,
  distanceFromLine,
  polylinePath,
} from "./wire-arc.ts";
import type { ArcInput, ArcPoint } from "./wire-arc.ts";

/**
 * T1639b — the arc between a wire's tip and the port it would connect to.
 *
 * The arc is a sentence: "let go here and it connects, to THAT port". So what is held is
 * what makes the sentence true and readable, not the numbers a generator happened to
 * produce: it joins the tip to the port exactly, it stays near the straight line between
 * them (an arc that wandered off would point at a neighbouring port, 18 px away), it is a
 * different shape on the next tick (or it is a zigzag line and not a spark), and the same
 * tick always draws the same shape (or nothing about it could be asserted at all).
 */

const tip: ArcPoint = { x: 100, y: 240 };
const port: ArcPoint = { x: 138, y: 222 };
const base: ArcInput = { from: tip, to: port, tick: 7, seed: 12345, scale: 1 };

/** A spread of tips round one port: every direction, and from touching it to the range's edge. */
function approaches(): ArcInput[] {
  const cases: ArcInput[] = [];
  for (let angle = 0; angle < 360; angle += 30) {
    for (const length of [2, 9, 20, 34, 48]) {
      const radians = (angle * Math.PI) / 180;
      const from = { x: port.x + Math.cos(radians) * length, y: port.y + Math.sin(radians) * length };
      for (const tick of [0, 1, 2, 3]) cases.push({ from, to: port, tick, seed: 99 + angle, scale: 1 });
    }
  }
  return cases;
}

describe("the bolt joins the wire's tip to the port", () => {
  it("starts exactly at the tip and ends exactly on the port, from every side and distance", () => {
    for (const input of approaches()) {
      const bolt = arcBolt(input);
      // The two ends are the points that were given, not points computed to be near them:
      // a bolt that stopped a pixel short of the dot would read as a miss.
      expect(bolt[0]).toEqual(input.from);
      expect(bolt.at(-1)).toEqual(input.to);
    }
  });

  it("still joins them when the tip is ON the port (a wire just pulled off is)", () => {
    const bolt = arcBolt({ ...base, from: port });
    expect(bolt).toEqual([port, port]);
    expect(arcBranch(bolt, { ...base, from: port })).toEqual([]);
  });

  it("has corners: it is a zigzag, not the straight line", () => {
    const bolt = arcBolt(base);
    expect(bolt.length).toBeGreaterThanOrEqual(4);
    const furthest = Math.max(...bolt.map((point) => distanceFromLine(point, tip, port)));
    expect(furthest).toBeGreaterThan(1);
  });

  it("alternates sides, which is what makes it read as a bolt", () => {
    const bolt = arcBolt({ ...base, from: { x: 90, y: 222 } });
    // Signed distance from the line for the corners between the ends: +, -, +, - …
    const sides = bolt.slice(1, -1).map((point) => Math.sign(point.y - 222));
    for (let index = 1; index < sides.length; index += 1) {
      expect(sides[index]).toBe(-(sides[index - 1] ?? 0));
    }
  });
});

describe("it stays by the line it is drawn along", () => {
  it("no corner sits further off the line than the amplitude, whatever the tick", () => {
    for (const input of approaches()) {
      const length = Math.hypot(input.to.x - input.from.x, input.to.y - input.from.y);
      const limit = arcAmplitude(length, input.scale) + 1e-9;
      for (const point of arcBolt(input)) {
        expect(distanceFromLine(point, input.from, input.to)).toBeLessThanOrEqual(limit);
      }
    }
  });

  it("the amplitude is a share of a short bolt and a fixed size for a long one", () => {
    // Ports are 18 px apart. At the edge of the 48 px range the bolt may not reach one.
    expect(arcAmplitude(48, 1)).toBeLessThan(9);
    expect(arcAmplitude(48, 1)).toBe(arcAmplitude(480, 1));
    // Close in, it shrinks with the bolt: a 5 px bolt with a 4.5 px swing would be a knot.
    expect(arcAmplitude(5, 1)).toBeLessThan(1);
  });

  it("the branch starts on a corner of the bolt and stands no further off than its reach", () => {
    let branches = 0;
    for (const input of approaches()) {
      const bolt = arcBolt(input);
      const branch = arcBranch(bolt, input);
      if (branch.length === 0) continue;
      branches += 1;
      // On the bolt: the two are drawn as separate paths, and must not come apart.
      expect(bolt).toContainEqual(branch[0]);
      const length = Math.hypot(input.to.x - input.from.x, input.to.y - input.from.y);
      const limit = arcAmplitude(length, input.scale) * ARC_BRANCH_REACH + 1e-9;
      for (const point of branch) {
        expect(distanceFromLine(point, input.from, input.to)).toBeLessThanOrEqual(limit);
      }
    }
    // Non-vacuity: the long approaches do carry a branch.
    expect(branches).toBeGreaterThan(50);
  });

  it("the branch runs back towards the tip, on the upper side of a level bolt", () => {
    const from = { x: 90, y: 222 };
    const input = { ...base, from };
    const branch = arcBranch(arcBolt(input), input);
    expect(branch).toHaveLength(3);
    const [root, knee, end] = branch as [ArcPoint, ArcPoint, ArcPoint];
    expect(knee.x).toBeLessThan(root.x);
    expect(end.x).toBeLessThan(knee.x);
    // Screen y grows downwards: above the line is a smaller y.
    expect(knee.y).toBeLessThan(222);
    expect(end.y).toBeLessThan(222);
  });

  it("too short a bolt has no branch", () => {
    const input = { ...base, from: { x: port.x - 9, y: port.y } };
    expect(arcBranch(arcBolt(input), input)).toEqual([]);
  });
});

describe("it crackles, and it is the same crackle every time", () => {
  it("the same tick and seed draw the same shape", () => {
    expect(arcBolt(base)).toEqual(arcBolt({ ...base }));
    expect(arcBranch(arcBolt(base), base)).toEqual(arcBranch(arcBolt(base), base));
  });

  it("the next tick draws a different shape between the same two points", () => {
    for (let tick = 0; tick < 40; tick += 1) {
      const now = polylinePath(arcBolt({ ...base, tick }));
      const next = polylinePath(arcBolt({ ...base, tick: tick + 1 }));
      expect(next).not.toBe(now);
    }
  });

  it("two ports do not spark in step", () => {
    expect(polylinePath(arcBolt({ ...base, seed: 1 }))).not.toBe(polylinePath(arcBolt({ ...base, seed: 2 })));
  });

  it("a new shape 15 times a second, as measured from the reference", () => {
    expect(ARC_TICK_MS).toBe(66);
    expect(arcTick(0)).toBe(0);
    expect(arcTick(65.9)).toBe(0);
    expect(arcTick(66)).toBe(1);
    // One second of frames at 60 Hz shows 15 or 16 shapes, not 60.
    const shapes = new Set(Array.from({ length: 60 }, (_unused, frame) => arcTick((frame * 1000) / 60)));
    expect(shapes.size).toBeGreaterThanOrEqual(15);
    expect(shapes.size).toBeLessThanOrEqual(16);
  });
});

describe("it holds its size on screen when the canvas is zoomed out", () => {
  it("at 35 % the same screen distance gives the same shape, scaled", () => {
    // 40 screen px at 100 % is 40 graph px; at 35 % it is 114 graph px and the scale is 1/0.35.
    const scale = 1 / 0.35;
    const near = arcBolt({ from: { x: 0, y: 0 }, to: { x: 40, y: 0 }, tick: 3, seed: 5, scale: 1 });
    const far = arcBolt({ from: { x: 0, y: 0 }, to: { x: 40 * scale, y: 0 }, tick: 3, seed: 5, scale });
    expect(far).toHaveLength(near.length);
    far.forEach((point, index) => {
      expect(point.x / scale).toBeCloseTo(near[index]?.x ?? Number.NaN, 9);
      expect(point.y / scale).toBeCloseTo(near[index]?.y ?? Number.NaN, 9);
    });
  });
});

describe("the path it is written as", () => {
  it("is a polyline through every point, to a hundredth", () => {
    expect(
      polylinePath([
        { x: 1, y: 2 },
        { x: 3.456, y: -4.004 },
        { x: 5, y: 6 },
      ]),
    ).toBe("M1 2 L3.46 -4 L5 6");
  });

  it("is empty for less than a line, so an absent branch draws nothing", () => {
    expect(polylinePath([])).toBe("");
    expect(polylinePath([{ x: 1, y: 1 }])).toBe("");
  });
});
