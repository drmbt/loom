import { describe, expect, it } from "vitest";
import { PACK, flownReachExpression, sentinelDocument } from "./document.ts";
import { compileGraph } from "../../compiler/compile.ts";
import { evaluateExpression } from "../../domain/expressions/evaluate.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { KIT_FIXTURE } from "./kit.fixture.ts";
import { STORED_READ } from "../../domain/parameters/resolve.ts";
import { readCameraPoseFacts } from "../../editor/viewer/camera-pose.ts";
import { cameraNode } from "../../nodes/definitions/scene.ts";
import { ZERO_FRAME, frameFromClock } from "../../domain/types/frame.ts";
import { valueExpressionNode } from "../../nodes/definitions/value-structure-nodes.ts";
import { CAMERA_DEFAULTS, CAMERA_STATEMENTS, CUT_DEFAULTS, CUT_PACE, FIELD_ORDER, GLIMPSE_SHOTS, PACK_ORDER, ROBOT_ORDER, SHOTS, SHOT_TABLE, cutStatements, shotAtTurn, type Shot } from "./camera.ts";
import { FIELD } from "./field.ts";
import { CHAMBERS } from "./path.ts";
import { FIELD_BERTH } from "./rig.ts";

/**
 * T1561b — the camera rig, run through the Expression node that runs it in the document.
 */
function rig(inputs: Record<string, number>, seconds: number): Record<string, number> {
  const evaluate = valueExpressionNode.valueEvaluate;
  if (evaluate === undefined) throw new Error("the Expression node has no evaluator");
  const frame = frameFromClock({ timeSeconds: seconds, deltaSeconds: 1 / 60, frameIndex: Math.round(seconds * 60), mode: ZERO_FRAME.mode, randomSeed: 0, fps: 60 });
  return evaluate({ inputs: { in: inputs }, values: { expressions: CAMERA_STATEMENTS, defaults: CAMERA_DEFAULTS }, frame, state: {} } as never) as Record<string, number>;
}

/**
 * Bodies seen through a shot's own camera: all in the frame, and no two nearer each other ACROSS the picture
 * than a body is wide (0.85 m, at the distance of the nearer one), so neither hides the other. (A first
 * version asked only for a tenth of the frame between centres, and passed a shot in which one robot stood
 * behind another.)
 */
function expectAllSeenApart(shot: Shot, out: Record<string, number>, bodies: ReadonlyArray<readonly [number, number, number]>): void {
  const eye = [out["right"] as number, out["up"] as number, out["ahead"] as number] as const;
  const forward = [0 - eye[0], 0 - eye[1], shot.aim - eye[2]] as const;
  const length = Math.hypot(...forward);
  const f = forward.map((value) => value / length) as [number, number, number];
  // Camera right and up from the world's up, as the Camera node builds them.
  const flat = Math.hypot(f[0], f[2]);
  const r = [f[2] / flat, 0, -f[0] / flat] as const;
  const u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]] as const;
  const half = Math.tan(((shot.lens / 2) * Math.PI) / 180);
  const seen = bodies.map((body) => {
    const to = [body[0] - eye[0], body[1] - eye[1], body[2] - eye[2]] as const;
    const depth = to[0] * f[0] + to[1] * f[1] + to[2] * f[2];
    return { depth, across: to[0] * r[0] + to[2] * r[2], up: to[0] * u[0] + to[1] * u[1] + to[2] * u[2] };
  });
  for (const body of seen) {
    expect([shot.name, body.depth > 0.5]).toEqual([shot.name, true]);
    expect([shot.name, Math.abs(body.across) < 0.92 * body.depth * half * (16 / 9) && Math.abs(body.up) < 0.92 * body.depth * half]).toEqual([shot.name, true]);
  }
  for (let a = 0; a < seen.length; a += 1) {
    for (let b = a + 1; b < seen.length; b += 1) {
      const [one, other] = [seen[a]!, seen[b]!];
      const near = Math.min(one.depth, other.depth);
      // Where each stands in the picture, as metres at the nearer one's distance.
      const apart = Math.hypot((one.across / one.depth - other.across / other.depth) * near, (one.up / one.depth - other.up / other.depth) * near);
      expect([shot.name, a, b, apart > 0.85]).toEqual([shot.name, a, b, true]);
    }
  }
}

describe("the sentinel camera", () => {
  /** The bore's narrowest: the ribs' crests at the default radius (tunnel.ts), and the deck below the axis. */
  const RIB_CREST = 2.6 - 0.12;
  const DECK = 2.6 * 0.74;

  it("holds the shot the slider names, and every shot keeps inside the bore and above the deck", () => {
    for (let shot = 0; shot < SHOTS.length; shot += 1) {
      for (let seconds = 0; seconds < 60; seconds += 0.37) {
        const out = rig({ value: seconds * 3.2, shot, cuts: 0, distance: 7.5, viewX: 1.1, viewY: 0.6, bar: 99 }, seconds);
        expect(out["pick"]).toBe(shot);
        // A shot of the fields is taken where there is no bore: it has the avenue to keep to instead (below).
        if (SHOT_TABLE[shot]?.subject === "field") continue;
        // 0.3 m of air between the lens and the nearest steel.
        expect(Math.hypot(out["right"] as number, out["up"] as number)).toBeLessThan(RIB_CREST - 0.3);
        expect(out["up"] as number).toBeGreaterThan(-DECK + 0.3);
      }
    }
  });

  it("circles: that shot rides round the robot with the clock", () => {
    const early = rig({ value: 0, shot: 4, cuts: 0 }, 1);
    const later = rig({ value: 0, shot: 4, cuts: 0 }, 6);
    // 1.5 rad of a 0.3 rad/s circle apart: on the far side of the bore, not parked.
    expect(Math.hypot((later["right"] as number) - (early["right"] as number), (later["up"] as number) - (early["up"] as number))).toBeGreaterThan(1.5);
  });

  it("takes the shot the cut counter is on, through the fifteen shots of the robot, never from a close one to a close one nor from the tail to the tail", () => {
    const order: number[] = [];
    for (let want = 0; want < ROBOT_ORDER.length; want += 1) {
      const out = rig({ value: 0, shot: 0, cuts: 1, want }, 0);
      expect(out["pick"]).toBe(shotAtTurn(want));
      order.push(out["pick"] as number);
    }
    expect(order).toEqual([...ROBOT_ORDER]);
    expect(new Set(order).size).toBe(15);
    // Every shot of the robot and of its tail is in it; the pack's and the fields' are for when there is one.
    const subjects = order.map((pick) => (SHOT_TABLE[pick] as (typeof SHOT_TABLE)[number]).subject);
    expect(subjects.filter((subject) => subject === "robot").length).toBe(9);
    expect(subjects.filter((subject) => subject === "tail").length).toBe(6);
    // A close shot is one that rides with the robot (it would lose it otherwise). Round the whole cycle, wrap included:
    // no two shots of the tail running, and no two close shots of the body.
    for (let at = 0; at < order.length; at += 1) {
      const [here, next] = [SHOT_TABLE[order[at] as number]!, SHOT_TABLE[order[(at + 1) % order.length] as number]!];
      expect([here.name, next.name, here.subject === "tail" && next.subject === "tail"]).toEqual([here.name, next.name, false]);
      expect([here.name, next.name, here.subject === "robot" && next.subject === "robot" && here.ride >= 0.6 && next.ride >= 0.6]).toEqual([here.name, next.name, false]);
    }
    // With Cuts off the slider holds any of them, whatever the counter says.
    expect(rig({ value: 0, shot: 12, cuts: 0, want: 7 }, 0)["pick"]).toBe(12);
  });

  it("asks for a cut every eighth bar while the track is calm or just begun, every second only with a full beat in a loud passage, every fourth otherwise; and says how long to hold", () => {
    // The owner, 2026-10-06: "cuts are a bit too hectic even while there's a build up … not get tricked during intros".
    const BAR = 1.8;
    const asked = (inputs: Record<string, number>): Record<string, number> => {
      const evaluate = valueExpressionNode.valueEvaluate;
      if (evaluate === undefined) throw new Error("the Expression node has no evaluator");
      return evaluate({ inputs: { in: inputs }, values: { expressions: cutStatements(BAR), defaults: CUT_DEFAULTS }, frame: frameFromClock({ timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: ZERO_FRAME.mode, randomSeed: 0, fps: 60 }), state: {} } as never) as Record<string, number>;
    };
    const paceOf = (inputs: Record<string, number>): number => asked(inputs)["bars"] as number;
    // The opening eight bars are held however busy and loud they are.
    expect(paceOf({ bar: 3, busy: 9, level: 1 })).toBe(8);
    // After them: few hits is calm whatever the level; a full beat that is not among the loudest is four; both is two.
    expect(paceOf({ bar: 40, busy: CUT_PACE.calm - 0.1, level: 1 })).toBe(8);
    expect(paceOf({ bar: 40, busy: CUT_PACE.busy + 1, level: CUT_PACE.loud - 0.1 })).toBe(4);
    expect(paceOf({ bar: 40, busy: CUT_PACE.busy - 0.1, level: 1 })).toBe(4);
    expect(paceOf({ bar: 40, busy: CUT_PACE.busy + 1, level: 1 })).toBe(2);
    // The request goes high on a bar line of that pace and nowhere else: bars 40 and 48 when calm, not 42, 44 or 46.
    const high = (bar: number, busy: number): number => asked({ bar, busy, level: 1 })["want"] as number;
    expect([40, 42, 44, 46, 48].map((bar) => high(bar, 2))).toEqual([1, 0, 0, 0, 1]);
    expect([40, 42, 44, 46, 48].map((bar) => high(bar, 5))).toEqual([1, 0, 1, 0, 1]);
    expect([40, 42, 44, 46, 48].map((bar) => high(bar, 9))).toEqual([1, 1, 1, 1, 1]);
    // …and falls again inside the bar, so the next line is a rise.
    expect(high(41.5, 9)).toBe(0);
    // The hold is nine tenths of the shot's own length: the next line of the same pace gets through, and nothing before it.
    expect(asked({ bar: 40, busy: 2, level: 1 })["hold"]).toBeCloseTo(8 * BAR * 0.9, 9);
    expect(asked({ bar: 40, busy: 9, level: 1 })["hold"]).toBeCloseTo(2 * BAR * 0.9, 9);
  });

  it("with more than one of the pack out, cuts through the four shots of the pack, each placed to hold all three apart in its frame", () => {
    const order: number[] = [];
    for (let want = 0; want < PACK_ORDER.length; want += 1) order.push(rig({ value: 0, shot: 0, cuts: 1, want, pack: 3, packing: 3 }, 0)["pick"] as number);
    expect(order).toEqual([...PACK_ORDER]);
    const ofThePack = SHOT_TABLE.map((shot, at) => ({ shot, at })).filter(({ shot }) => shot.subject === "pack");
    expect(ofThePack.map(({ shot }) => shot.name)).toEqual(["packfront", "packquarter", "packrear", "packunder"]);
    for (const { at } of ofThePack) expect(order).toContain(at);
    // One robot out: the pack's shots are not in the cut at all.
    for (let want = 0; want < 40; want += 1) expect(SHOT_TABLE[rig({ value: 0, shot: 0, cuts: 1, want, pack: 1, packing: 1 }, 0)["pick"] as number]?.subject).not.toBe("pack");
    // The formation the pack flies in (document.ts, PACK), seen through each of its shots.
    for (const { shot, at } of ofThePack) expectAllSeenApart(shot, rig({ value: 0, shot: at, cuts: 0, pack: 3 }, 0), PACK);
  });

  it("in the fields, cuts through the place's own four shots between the tails and the long chase; each keeps inside the avenue and holds all three", () => {
    const order: number[] = [];
    for (let want = 0; want < FIELD_ORDER.length; want += 1) order.push(rig({ value: 0, shot: 0, cuts: 1, want, pack: 3, packing: 3, place: 1 }, 0)["pick"] as number);
    expect(order).toEqual([...FIELD_ORDER]);
    for (const [turn, pick] of order.entries()) expect(pick).toBe(shotAtTurn(turn, true, true));
    const ofTheFields = SHOT_TABLE.map((shot, at) => ({ shot, at })).filter(({ shot }) => shot.subject === "field");
    expect(ofTheFields.map(({ shot }) => shot.name)).toEqual(["fieldfront", "fieldside", "fieldlow", "fieldhigh"]);
    for (const { at } of ofTheFields) expect(order).toContain(at);
    // The place changes on a cut: no shot of the fields' order is in the robot's or the pack's, so whichever shot
    // the tunnel was on and whichever the fields begin with, they are two shots. (They shared four; on the owner's
    // track the tunnel came back in the middle of "tips".)
    for (const pick of FIELD_ORDER) expect([SHOT_TABLE[pick]?.name, ROBOT_ORDER.includes(pick) || PACK_ORDER.includes(pick)]).toEqual([SHOT_TABLE[pick]?.name, false]);
    // Never two of the place's wide shots running: between any two, a shot of the robots.
    for (let turn = 0; turn < order.length; turn += 1) {
      const [here, next] = [SHOT_TABLE[order[turn] as number], SHOT_TABLE[order[(turn + 1) % order.length] as number]];
      expect(here?.subject === "field" && next?.subject === "field").toBe(false);
    }
    // In the tunnel none of them is ever in the cut, however it is going.
    for (let want = 0; want < 40; want += 1) for (const pack of [1, 3]) expect(SHOT_TABLE[rig({ value: 0, shot: 0, cuts: 1, want, pack, packing: pack, place: 0 }, 0)["pick"] as number]?.subject).not.toBe("field");
    // Out there the pack flies wider apart, below the line as well as above it (rig.ts, FIELD_BERTH).
    const wider = 1 + CHAMBERS.swell * FIELD_BERTH;
    const afield = PACK.map((body) => [body[0] * wider, body[1] * wider, body[2]] as const);
    for (const { shot, at } of ofTheFields) {
      for (let seconds = 0; seconds < 60; seconds += 1.7) {
        const out = rig({ value: seconds * 3.2, shot: at, cuts: 0, pack: 3, place: 1 }, seconds);
        // No tower's trunk comes within a metre of the avenue's edge (field.gpu.test.ts): the lens keeps another metre inside that.
        expect([shot.name, Math.abs(out["right"] as number) < FIELD.avenue - 2]).toEqual([shot.name, true]);
        // …and within the heights that test looks at.
        expect([shot.name, Math.abs(out["up"] as number) < 30]).toEqual([shot.name, true]);
        expectAllSeenApart(shot, out, afield);
        // The robots are what the shot is of (the owner, 2026-10-06: not "a handful of pixels in the distance"):
        // the nearest one's body, 1.2 m of it, is a seventh of the frame's height or more, and the furthest a twentieth.
        const eye = [out["right"] as number, out["up"] as number, out["ahead"] as number] as const;
        const toward = [0 - eye[0], 0 - eye[1], shot.aim - eye[2]] as const;
        const depths = afield.map((body) => body.reduce((sum, part, axis) => sum + (part - (eye[axis] as number)) * ((toward[axis] as number) / Math.hypot(...toward)), 0));
        const tall = (depth: number): number => 1.2 / (2 * depth * Math.tan(((shot.lens / 2) * Math.PI) / 180));
        expect([shot.name, tall(Math.min(...depths)) >= 1 / 7]).toEqual([shot.name, true]);
        expect([shot.name, tall(Math.max(...depths)) >= 0.05]).toEqual([shot.name, true]);
      }
    }
  });

  it("the early glimpse of the fields is two shots of its own, whatever the turn: the place from above, then the three from in front", () => {
    expect(GLIMPSE_SHOTS.map((at) => SHOTS[at])).toEqual(["fieldhigh", "fieldfront"]);
    for (let want = 0; want < 12; want += 1) {
      for (const pack of [1, 3]) {
        const at = (glimpse: number): number => rig({ value: 0, shot: 0, cuts: 1, want, pack, packing: pack, place: 1, glimpse }, 0)["pick"] as number;
        expect([want, pack, SHOTS[at(1)], SHOTS[at(2)]]).toEqual([want, pack, "fieldhigh", "fieldfront"]);
        // No glimpse: the turn's own shot, as before.
        expect(at(0)).toBe(shotAtTurn(want, true, true));
      }
    }
    // With the camera in the hand (Auto camera off) the glimpse takes nothing: the slider's shot holds.
    expect(rig({ value: 0, shot: 3, cuts: 0, want: 5, glimpse: 1, place: 1 }, 0)["pick"]).toBe(3);
  });

  it("looks where the shot says: past the robot down the tunnel, at the robot, at its tail, or at the pack", () => {
    for (const [index, shot] of SHOT_TABLE.entries()) {
      const out = rig({ value: 10, shot: index, cuts: 0, distance: 7.5 }, 3);
      expect([shot.name, out["aim"], out["ride"], out["lens"]]).toEqual([shot.name, shot.aim, shot.ride, shot.lens]);
      const ahead = out["ahead"] as number;
      if (shot.subject === "tail") {
        // Behind the robot's middle, looking at a point no further forward than that middle, from close
        // (the furthest is the long lens, 4.3 m off what it looks at), and riding with the robot.
        expect(ahead).toBeLessThan(-1.2);
        expect(shot.aim).toBeLessThanOrEqual(0);
        expect(Math.hypot(ahead - shot.aim, out["right"] as number, out["up"] as number)).toBeLessThan(4.5);
        expect(shot.ride).toBe(1);
      } else if (shot.subject === "pack" || shot.subject === "field") {
        // At the middle of the echelon, which is some five metres behind the leader.
        expect(shot.aim).toBeLessThan(-1);
        expect(shot.aim).toBeGreaterThan(-8);
      } else if (ahead < -1) {
        // Behind the robot and not a tail shot: it looks past it, down the tunnel.
        expect(shot.aim).toBeGreaterThan(3);
      } else {
        expect(shot.aim).toBeLessThan(1);
      }
    }
  });

  it("plants the post shot: the camera's place does not move while the robot travels one station's length", () => {
    const places = [0.5, 8, 16, 25].map((travel) => rig({ value: travel, shot: 3, cuts: 0 }, travel)["z"]);
    expect(new Set(places).size).toBe(1);
    // …and the robot does pass it: it starts ahead of the robot and ends behind.
    expect(rig({ value: 0.5, shot: 3, cuts: 0 }, 0)["ahead"] as number).toBeGreaterThan(0);
    expect(rig({ value: 25, shot: 3, cuts: 0 }, 0)["ahead"] as number).toBeLessThan(0);
  });
});

/**
 * THE CAMERA'S FRAME (document.ts, cameraPose). The directed pose is the camera's Origin and Heading, its own Eye a
 * plain 0 0 0, so the Viewer can fly it; and what else needs the camera's place reads the pose the engine composes,
 * by name (§T1674b), never the offsets.
 */
describe("the sentinel's camera can be flown, and what reads it reads where it is (T1561b)", () => {
  type Stored = { bindings?: { expression?: { source?: string } } } | null;
  const sourcesOf = (graph: ReturnType<typeof sentinelDocument>["graph"]): Array<{ at: string; source: string }> =>
    (Object.values(graph.nodes) as unknown as Array<{ id: string; parameters: Record<string, unknown> }>).flatMap((node) =>
      Object.entries(node.parameters).flatMap(([key, value]) => {
        const source = (value as Stored)?.bindings?.expression?.source;
        return source === undefined ? [] : [{ at: `${node.id}.${key}`, source }];
      }),
    );

  it("the focus goes with a flown camera: by nothing with no trim, and by as much as the eye is nearer its aim or farther", () => {
    /** What the expression gives for a camera this far from its aim, whose Heading (the directed way to the aim) is this. */
    const reach = (distance: number, heading: readonly [number, number, number]): number => {
      const result = evaluateExpression(flownReachExpression("camera_rig"), {}, (name, path) => {
        const value = name !== "camera_rig" ? undefined : path.join(".") === "chan.distance" ? distance : path[0] === "par" && path[1] === "heading" ? heading[["x", "y", "z"].indexOf(path[2] ?? "")] : undefined;
        return value === undefined ? ({ ok: false, reason: `no ${name}.${path.join(".")}` } as const) : ({ ok: true, value } as const);
      });
      if (!result.ok) throw new Error("the reach does not evaluate");
      return result.value;
    };
    const heading = [-2, -0.6, 9] as const;
    const directed = Math.hypot(...heading);
    // No trim: the camera is as far from its aim as the director put it.
    expect(reach(directed, heading)).toBeCloseTo(1, 12);
    // Flown back to twice as far, and in to half.
    expect(reach(directed * 2, heading)).toBeCloseTo(2, 12);
    expect(reach(directed / 2, heading)).toBeCloseTo(0.5, 12);
  });

  it("in the document the camera's Eye is a plain offset of nothing, and whatever reads the camera's place reads the composed pose", () => {
    const built = sentinelDocument(KIT_FIXTURE);
    const graph = built.graph;
    const camera = (graph.nodes["camera_rig" as never] as unknown as { parameters: Record<string, unknown> }).parameters;
    // What a flight writes is free: Eye, all of it, and Look At across. No expression on any of them.
    expect(camera["eye"]).toEqual([0, 0, 0]);
    expect(Object.keys(camera).filter((key) => key.startsWith("eye.") || key === "lookAt.x")).toEqual([]);
    expect((camera["lookAt"] as number[])[0]).toBe(0);
    // The directed pose is the frame. (Heading's y turns nothing in a level frame; it is there for its length.)
    for (const key of ["origin.x", "origin.y", "origin.z", "heading.x", "heading.y", "heading.z", "lookAt.y", "lookAt.z"]) expect(typeof camera[key]).toBe("object");
    // …and the editor's own answer, the one its "Fly camera_rig" button is offered by: there is a pose to fly, and it
    // says which two channels a flight leaves to the director. (All six driven, it offers nothing: what this file was.)
    const facts = readCameraPoseFacts(graph.nodes["camera_rig" as never] as never, cameraNode, STORED_READ);
    expect(facts?.held).toBe("Stays driven: Look At y (Expression), Look At z (Expression).");
    // No parameter of any node reads the camera's Eye or Look At: with a frame those are offsets, not where the
    // camera is. (The first build read them so, and the haze went out.)
    const sources = sourcesOf(graph);
    expect(sources.filter(({ source }) => /op\('camera_rig'\)\.par\.(eye|lookAt)/.test(source)).map(({ at }) => at)).toEqual([]);
    // The air and the focus read where it is, by name: all six of the eye and the aim, and the distance between them.
    for (const channel of ["eyeX", "eyeY", "eyeZ", "aimX", "aimY", "aimZ", "distance"]) expect([channel, sources.some(({ source }) => source.includes(`op('camera_rig').chan.${channel}`))]).toEqual([channel, true]);
    // …and the engine, which says so by name when a place is read off an offset (§T1674b), has nothing to say.
    const compiled = compileGraph({ graph, settings: built.settings, registry: createNodeRegistry(allNodeDefinitions).view(), capabilities: TIER_B_CAPABILITIES });
    expect(compiled.diagnostics.filter((entry) => entry.code === "parameter.reference.notComposed").map((entry) => entry.message)).toEqual([]);
  });
});
