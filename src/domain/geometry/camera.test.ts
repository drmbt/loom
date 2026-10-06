import { describe, expect, it } from "vitest";
import { cameraPayloadMatrix, identity, lookAt, multiply, perspective, pointShadowFaceMatrices, pointShadowFaceReaches, projectorMatrix, transformPoint, viewProjection } from "./camera.ts";

/**
 * §V198: the composition order is PUBLISHED (clip = projection × view × world,
 * column-major, right-multiplied, right-handed, WebGPU [0,1] depth) and these tests
 * pin every clause — the cheapest insurance in the whole geometry system.
 */

const close = (a: readonly number[], b: readonly number[]): void => {
  expect(a.length).toBe(b.length);
  a.forEach((value, index) => expect(value).toBeCloseTo(b[index] ?? NaN, 5));
};

describe("camera math (T295, §V198)", () => {
  it("multiplies column-major, applying the RIGHT matrix first", () => {
    // Translate(1,0,0) then Scale(2): scale × translate moves THEN scales → x = 4.
    const translate = identity();
    translate[12] = 1;
    const scale = identity();
    scale[0] = scale[5] = scale[10] = 2;
    const composed = multiply(scale, translate);
    close(transformPoint(composed, [1, 0, 0]), [4, 0, 0, 1]);
    // The other order: scales THEN moves → x = 3. Order is not a matter of taste.
    close(transformPoint(multiply(translate, scale), [1, 0, 0]), [3, 0, 0, 1]);
  });

  it("looks down -z: a point in front of the camera lands at negative view z", () => {
    const view = lookAt([0, 0, 5], [0, 0, 0]);
    const inFront = transformPoint(view, [0, 0, 0]);
    close(inFront, [0, 0, -5, 1]);
  });

  it("projects into WebGPU's [0,1] depth — near→0, far→1, monotone between", () => {
    const proj = perspective(Math.PI / 2, 1, 1, 10);
    const ndcZ = (viewZ: number): number => {
      const clip = transformPoint(proj, [0, 0, viewZ]);
      return clip[2] / clip[3];
    };
    expect(ndcZ(-1)).toBeCloseTo(0, 5); // the near plane
    expect(ndcZ(-10)).toBeCloseTo(1, 5); // the far plane
    expect(ndcZ(-2)).toBeGreaterThan(0);
    expect(ndcZ(-2)).toBeLessThan(ndcZ(-5)); // farther = deeper, always
  });

  it("viewProjection composes projection × view — the published order, end to end", () => {
    const vp = viewProjection([0, 0, 5], [0, 0, 0], { fovY: Math.PI / 2, aspect: 1, near: 1, far: 100 });
    // The look-at target sits dead centre, in front of the camera.
    const centre = transformPoint(vp, [0, 0, 0]);
    expect(centre[0] / centre[3]).toBeCloseTo(0, 5);
    expect(centre[1] / centre[3]).toBeCloseTo(0, 5);
    expect(centre[3]).toBeGreaterThan(0); // in front, not behind
    // A point up and right of the target lands up and right on screen.
    const upRight = transformPoint(vp, [1, 1, 0]);
    expect(upRight[0] / upRight[3]).toBeGreaterThan(0);
    expect(upRight[1] / upRight[3]).toBeGreaterThan(0);
  });
});

describe("T706 — the camera can aim anywhere and bank (cameraPayloadMatrix)", () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    eye: [0, 5, 0] as const,
    lookAt: [0, 0, 0] as const,
    fovDeg: 60,
    near: 0.1,
    far: 100,
    ortho: false,
    orthoHeight: 2,
    ...over,
  });

  it("straight DOWN is a picture, not a collapsed basis — the missing third guard", () => {
    // Before T706 this path fed cross([0,1,0],[0,1,0]) = 0 into the view basis (the
    // shadow path guards at |d.y| > 0.999 and the environment basis at 0.99; this was
    // the one of three without a guard) — verified red: every basis entry read 0.
    // §V461 lesson, learned in THIS test's first draft: a zero basis is perfectly
    // finite, so "every entry is finite" passed with the guard deleted. The claim that
    // cannot pass on a collapsed basis is SEPARATION: under a working straight-down
    // camera, two distinct ground points land on distinct screen points; under the
    // degenerate basis every world point projects to screen (0,0).
    const project = (m: Float32Array, point: [number, number, number]) => {
      const w = (m[3] ?? 0) * point[0] + (m[7] ?? 0) * point[1] + (m[11] ?? 0) * point[2] + (m[15] ?? 0);
      return [
        ((m[0] ?? 0) * point[0] + (m[4] ?? 0) * point[1] + (m[8] ?? 0) * point[2] + (m[12] ?? 0)) / w,
        ((m[1] ?? 0) * point[0] + (m[5] ?? 0) * point[1] + (m[9] ?? 0) * point[2] + (m[13] ?? 0)) / w,
      ] as const;
    };
    const down = cameraPayloadMatrix(payload(), 1);
    const px = project(down, [1, 0, 0]);
    const pz = project(down, [0, 0, 1]);
    expect(Math.hypot(px[0] ?? 0, px[1] ?? 0)).toBeGreaterThan(0.1);
    expect(Math.hypot(pz[0] ?? 0, pz[1] ?? 0)).toBeGreaterThan(0.1);
    expect(Math.hypot((px[0] ?? 0) - (pz[0] ?? 0), (px[1] ?? 0) - (pz[1] ?? 0))).toBeGreaterThan(0.1);
    // And straight UP guards identically.
    const up = cameraPayloadMatrix(payload({ eye: [0, -5, 0] }), 1);
    expect(Math.hypot(project(up, [1, 0, 0])[0] ?? 0, project(up, [1, 0, 0])[1] ?? 0)).toBeGreaterThan(0.1);
  });

  it("roll 0 and roll absent are byte-identical to the old matrix", () => {
    const level = payload({ eye: [0, 0.5, 3] });
    const a = cameraPayloadMatrix(level, 16 / 9);
    const b = cameraPayloadMatrix({ ...level, roll: 0 }, 16 / 9);
    expect([...a]).toEqual([...b]);
  });

  it("roll's SIGN (T1433b, schema 5): +90 turns the camera counter-clockwise from behind, so world up lands screen-RIGHT", () => {
    // Right-handed about the camera's own +z, as Blender and three.js: the owner's ruling, with
    // the 4 → 5 migration negating older rolls. Pinned so a flip is a deliberate, visible change.
    const level = payload({ eye: [0, 0, 3], lookAt: [0, 0, 0] });
    const project = (m: Float32Array, p: [number, number, number]) => {
      const w = (m[3] ?? 0) * p[0] + (m[7] ?? 0) * p[1] + (m[11] ?? 0) * p[2] + (m[15] ?? 0);
      return [((m[0] ?? 0) * p[0] + (m[4] ?? 0) * p[1] + (m[8] ?? 0) * p[2] + (m[12] ?? 0)) / w, ((m[1] ?? 0) * p[0] + (m[5] ?? 0) * p[1] + (m[9] ?? 0) * p[2] + (m[13] ?? 0)) / w];
    };
    const [ux = 0, uy = 0] = project(cameraPayloadMatrix({ ...level, roll: 90 }, 1), [0, 1, 0]);
    expect(ux).toBeGreaterThan(0.1); // world up -> screen right: the picture turned clockwise
    expect(Math.abs(uy)).toBeLessThan(1e-6);
    // A small positive roll: the right end of the horizon sinks on screen.
    const [, ry = 0] = project(cameraPayloadMatrix({ ...level, roll: 10 }, 1), [1, 0, 0]);
    expect(ry).toBeLessThan(-0.01);
  });

  it("roll banks around the view axis by exact degrees, aim untouched", () => {
    // Looking down -z from the origin side: world +x is screen-right. At roll 90 the
    // camera's up becomes world -x... the exact expectation is computed from the
    // definition rather than guessed: up' = Rodrigues([0,0,-1] view axis, 90°) of
    // [0,1,0] = [1,0,0] — so world +x lands on screen-UP's row.
    const level = payload({ eye: [0, 0, 3], lookAt: [0, 0, 0] });
    const rolled = cameraPayloadMatrix({ ...level, roll: 90 }, 1);
    const flat = cameraPayloadMatrix(level, 1);
    // Project world +x with both. Screen x/y live in rows 0 and 1 of the view part;
    // through the full view-projection a point at [1,0,0] swaps its screen axis.
    const apply = (m: Float32Array, p: [number, number, number]) => {
      const w = (m[3] ?? 0) * p[0] + (m[7] ?? 0) * p[1] + (m[11] ?? 0) * p[2] + (m[15] ?? 0);
      return [
        ((m[0] ?? 0) * p[0] + (m[4] ?? 0) * p[1] + (m[8] ?? 0) * p[2] + (m[12] ?? 0)) / w,
        ((m[1] ?? 0) * p[0] + (m[5] ?? 0) * p[1] + (m[9] ?? 0) * p[2] + (m[13] ?? 0)) / w,
      ];
    };
    const [fx = 0, fy = 0] = apply(flat, [1, 0, 0]);
    const [rx = 0, ry = 0] = apply(rolled, [1, 0, 0]);
    expect(fx).toBeGreaterThan(0.1); // screen-right, flat
    expect(Math.abs(fy)).toBeLessThan(1e-6);
    expect(Math.abs(rx)).toBeLessThan(1e-6); // rolled 90: same point is now vertical
    expect(Math.abs(ry)).toBeGreaterThan(0.1);
    // And the aim did not move: the look-at point projects to centre in both.
    expect(apply(flat, [0, 0, 0])[0]).toBeCloseTo(0, 6);
    expect(apply(rolled, [0, 0, 0])[0]).toBeCloseTo(0, 6);
  });
});

describe("T704 — the projector's matrix speaks the lens sheet", () => {
  const project = (m: Float32Array, p: [number, number, number]) => {
    const w = (m[3] ?? 0) * p[0] + (m[7] ?? 0) * p[1] + (m[11] ?? 0) * p[2] + (m[15] ?? 0);
    return [
      ((m[0] ?? 0) * p[0] + (m[4] ?? 0) * p[1] + (m[8] ?? 0) * p[2] + (m[12] ?? 0)) / w,
      ((m[1] ?? 0) * p[0] + (m[5] ?? 0) * p[1] + (m[9] ?? 0) * p[2] + (m[13] ?? 0)) / w,
      ((m[2] ?? 0) * p[0] + (m[6] ?? 0) * p[1] + (m[10] ?? 0) * p[2] + (m[14] ?? 0)) / w,
    ] as const;
  };
  const LENS = { throwRatio: 1.5, aspect: 16 / 9, shiftX: 0, shiftY: 0, keystoneH: 0, keystoneV: 0 };
  const POSE = { eye: [0, 0, 4] as const, lookAt: [0, 0, 0] as const };

  it("throw ratio IS the frustum: the image edge lands at ndc ±1, exactly", () => {
    // Throw 1.5 at distance z: image width = z/1.5, so the half-width point at the
    // look-at plane (z_view = -4) sits at x = 4/(2·1.5) = 4/3 — and must project to
    // ndc x = 1 to the arithmetic, because that IS what "throw ratio 1.5" prints.
    const m = projectorMatrix(POSE, LENS);
    const edge = project(m, [4 / 3, 0, 0]);
    expect(edge[0]).toBeCloseTo(1, 6);
    expect(project(m, [-4 / 3, 0, 0])[0]).toBeCloseTo(-1, 6);
    // The vertical edge follows the NATIVE aspect: half-height = half-width / aspect.
    expect(project(m, [0, (4 / 3) / (16 / 9), 0])[1]).toBeCloseTo(1, 6);
    // And the axis point projects dead centre.
    expect(project(m, [0, 0, 0])[0]).toBeCloseTo(0, 6);
  });

  it("lens shift slides the image without re-aiming: centre moves by 2·shift ndc", () => {
    const m = projectorMatrix(POSE, { ...LENS, shiftX: 0.25 });
    // Positive shift slides the IMAGE right (the venue convention), so the optical
    // axis point lands off-centre the OTHER way by a quarter image width (= half an
    // ndc unit): the body did not turn, the lens moved.
    expect(project(m, [0, 0, 0])[0]).toBeCloseTo(-0.5, 6);
    // Straight-through geometry is otherwise untouched: relative spans are preserved.
    const a = project(m, [4 / 3, 0, 0])[0];
    const b = project(m, [-4 / 3, 0, 0])[0];
    expect(a - b).toBeCloseTo(2, 6);
  });

  it("keystone is a trapezoid, not a slide: mirror points scale asymmetrically", () => {
    const m = projectorMatrix(POSE, { ...LENS, keystoneH: 15 });
    const right = project(m, [1, 0.5, 0]);
    const left = project(m, [-1, 0.5, 0]);
    // A horizontal keystone makes one side of the image effectively nearer: the same
    // world height projects TALLER on one side than the other.
    expect(Math.abs(right[1])).not.toBeCloseTo(Math.abs(left[1]), 3);
    // Zero keystone restores symmetry — the term is the trapezoid, nothing else.
    const flat = projectorMatrix(POSE, LENS);
    expect(project(flat, [1, 0.5, 0])[1]).toBeCloseTo(project(flat, [-1, 0.5, 0])[1], 6);
  });

  it("near and far bracket the throw distance, derived rather than asked for", () => {
    const m = projectorMatrix(POSE, LENS);
    // At the look-at plane, depth is comfortably inside (0..1); at 8× the distance it
    // has left the frustum. No near/far parameters exist to mis-set.
    const atTarget = project(m, [0, 0, 0])[2];
    expect(atTarget).toBeGreaterThan(0);
    expect(atTarget).toBeLessThan(1);
    expect(project(m, [0, 0, -40])[2]).toBeGreaterThan(1);
  });

  it("shares the camera's guarded, rolled basis (§V437) — straight down still works", () => {
    const m = projectorMatrix({ eye: [0, 5, 0], lookAt: [0, 0, 0] }, LENS);
    const px = project(m, [1, 0, 0]);
    const pz = project(m, [0, 0, 1]);
    expect(Math.hypot(px[0], px[1])).toBeGreaterThan(0.01);
    expect(Math.hypot(px[0] - pz[0], px[1] - pz[1])).toBeGreaterThan(0.01);
  });
});

/*
 * T1598b: `pointShadowFaceReaches` decides which shadow draws are LEFT OUT, so the one way
 * it may be wrong is by answering true. A false for a sphere any part of which the face's
 * sweep would have drawn is a shadow that silently goes missing.
 */
describe("what one face of a point light's cube can reach (T1598b)", () => {
  const LIGHT: [number, number, number] = [1, 2, -0.5];
  const RANGE = 6;
  const reached = (center: readonly [number, number, number], radius: number): number[] =>
    [0, 1, 2, 3, 4, 5].filter((face) => pointShadowFaceReaches(LIGHT, RANGE, face, { center, radius }));
  const from = (x: number, y: number, z: number): [number, number, number] => [LIGHT[0] + x, LIGHT[1] + y, LIGHT[2] + z];

  it("a small sphere straight down an axis is in that face and no other (atlas order +X −X +Y −Y +Z −Z)", () => {
    expect(reached(from(3, 0, 0), 0.5)).toEqual([0]);
    expect(reached(from(-3, 0, 0), 0.5)).toEqual([1]);
    expect(reached(from(0, 3, 0), 0.5)).toEqual([2]);
    expect(reached(from(0, -3, 0), 0.5)).toEqual([3]);
    expect(reached(from(0, 0, 3), 0.5)).toEqual([4]);
    expect(reached(from(0, 0, -3), 0.5)).toEqual([5]);
  });

  it("a sphere beyond the range is in no face, and one that reaches back into it still is", () => {
    expect(reached(from(RANGE + 1.01, 0, 0), 1)).toEqual([]);
    expect(reached(from(RANGE + 0.99, 0, 0), 1)).toEqual([0]);
    // Far out on a diagonal: beyond the range by distance, though inside two faces' planes.
    expect(reached(from(5, 5, 0), 0.5)).toEqual([]);
  });

  it("a sphere across the seam of two faces is in both, and one holding the light is in all six", () => {
    expect(reached(from(2, 2, 0), 0.25)).toEqual([0, 2]);
    expect(reached(from(0.2, 0, 0), 1)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("never answers false for a sphere the face's own matrix can see (5,000 spheres against the sweep's projection)", () => {
    const matrices = pointShadowFaceMatrices(LIGHT, RANGE);
    // A deterministic generator: the claim must not depend on a lucky seed.
    let state = 0x2545f491;
    const random = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    let left = 0;
    for (let trial = 0; trial < 5000; trial += 1) {
      const center = from((random() - 0.5) * 18, (random() - 0.5) * 18, (random() - 0.5) * 18);
      const radius = random() * random() * 3;
      for (let face = 0; face < 6; face += 1) {
        if (pointShadowFaceReaches(LIGHT, RANGE, face, { center, radius })) continue;
        left += 1;
        // Left out: then no point of the sphere may be something the sweep keeps — inside
        // the face's frustum AND within range of the light.
        for (let sample = 0; sample < 40; sample += 1) {
          const u = random() * 2 - 1;
          const phi = random() * Math.PI * 2;
          const ring = Math.sqrt(1 - u * u);
          const length = radius * Math.cbrt(random());
          const point: [number, number, number] = [
            center[0] + length * ring * Math.cos(phi),
            center[1] + length * ring * Math.sin(phi),
            center[2] + length * u,
          ];
          const clip = transformPoint(matrices[face]!, point);
          const inFace = clip[3] > 0 && Math.abs(clip[0]) <= clip[3] && Math.abs(clip[1]) <= clip[3];
          const inRange = Math.hypot(point[0] - LIGHT[0], point[1] - LIGHT[1], point[2] - LIGHT[2]) <= RANGE;
          if (inFace && inRange) throw new Error(`face ${String(face)} was left out of a sphere at ${center.join(",")} r ${String(radius)} that it can see at ${point.join(",")}`);
        }
      }
    }
    // The test is only worth its name if it leaves a good share out: 30,000 pairs, most unreachable.
    expect(left).toBeGreaterThan(15000);
  });
});
