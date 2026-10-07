import { describe, expect, it } from "vitest";
import { compileGraph } from "../../compiler/compile.ts";
import { flattenComponents } from "../../compiler/flatten.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { evaluateExpression, parseExpression } from "../../domain/expressions/evaluate.ts";
import { starterComponentsView } from "../../examples/component-files.ts";
import { SHOWCASE_BEAT, showcaseBarStart } from "../../examples/build-showcase-beat.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { shippedClipAudio } from "../../examples/shipped-clip-audio.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { SHOTS } from "./camera.ts";
import { boxesOverlap, nodeBox, previewAspectOf } from "../../domain/graph/node-box.ts";
import { diagnosticClass } from "../../domain/diagnostics/classes.ts";
import { against, DOCK_HUE, DOCK_TURN, dockTurn, FIELD_BARS, FIELD_HUE, FIELD_TURN, fieldTurn, GLIMPSE, pace, PACK_BARS, PACK_SHARE, packSize, PHRASE_BARS, phraseAttack, phraseDraw, phrasePause, phrasePerch, phraseRush, phraseSpiral, phraseSwim, rest, RUSH, SHOW_HUES, SHOW_TURNS, showHue, showStand, STAND, stride, surge, TEMPLE_HUE, TEMPLE_TURN, templeTurn } from "./director.ts";
import { SHIPPED_TRACK, sentinelDocument } from "./document.ts";
import { SEEK_FRAME_LIMIT, projectFps, projectRange } from "../../domain/types/graph.ts";
import { KIT_FIXTURE } from "./kit.fixture.ts";

/** T1561b — what following the track does to the pace and to swimming, read through the expression engine that runs it. */
function read(source: string, scope: Record<string, number>): number {
  const result = evaluateExpression(source, scope);
  if (!result.ok) throw new Error(`"${source}" does not evaluate`);
  return result.value;
}

describe("the sentinel's file", () => {
  it("lays no node of its canvas on top of another, in either tier", () => {
    // It did: 67 pairs, written 150 across and 125 down where a node is 178 by 148 or more, so a tile's own
    // sentence (what frames a Render, why a camera has no gizmo) was under its neighbour. The boxes are the
    // canvas's own (the examples' layout gate measures with the same ones).
    const registry = createNodeRegistry(allNodeDefinitions).view();
    for (const tier of ["live", "offline"] as const) {
      const built = sentinelDocument(KIT_FIXTURE, { tier });
      const aspect = previewAspectOf(built.settings);
      const placed = Object.values(built.graph.nodes).map((node) => ({ name: node.label ?? node.id, box: nodeBox(node, registry.get(node.type), aspect, built.graph) }));
      const overlapping: string[] = [];
      for (let a = 0; a < placed.length; a += 1) {
        for (let b = a + 1; b < placed.length; b += 1) {
          if (boxesOverlap((placed[a] as (typeof placed)[number]).box, (placed[b] as (typeof placed)[number]).box)) overlapping.push(`${tier}: ${placed[a]?.name} / ${placed[b]?.name}`);
        }
      }
      expect(overlapping).toEqual([]);
      expect(placed.length).toBeGreaterThan(150);
    }
  });

  it("holds no expression the engine cannot read: every one parses, function names and all", () => {
    // An expression that fails is not an error to the engine: the parameter quietly keeps its stored value.
    // A lamp's strength written with a function the grammar does not have (`pow`) shipped that way, three
    // lamps at their stored strength, and every render of it looked plausible.
    const { graph: built } = sentinelDocument(KIT_FIXTURE);
    const unread: string[] = [];
    let expressions = 0;
    for (const entry of Object.values(built.nodes)) {
      for (const [key, stored] of Object.entries(entry.parameters)) {
        if (typeof stored !== "object" || stored === null || !("bindings" in stored)) continue;
        const binding = stored.bindings.expression;
        if (binding === undefined || binding.kind !== "expression") continue;
        expressions += 1;
        const parsed = parseExpression(binding.source);
        if (!parsed.ok) unread.push(`${entry.label ?? entry.id}.${key}: ${parsed.reason}`);
      }
    }
    expect(unread).toEqual([]);
    // The walk really found them: the file is driven by hundreds.
    expect(expressions).toBeGreaterThan(200);
  });

  it("drives no parameter a node does not have: a compile of it names none as unknown", () => {
    // The other way a driven value is silently not driven: a slot under a key the node does not declare is a
    // WARNING, and the node keeps the value it had. The air's colour and the dust's were written `eyeColor.x`
    // for a day (a colour's parts are r, g and b), so the robot's light in the air stayed red whatever its
    // lenses did, and the fields' air stayed black.
    const built = sentinelDocument(KIT_FIXTURE);
    const compiled = compileGraph({ graph: built.graph, settings: built.settings, registry: createNodeRegistry(allNodeDefinitions).view(), capabilities: TIER_B_CAPABILITIES });
    expect(compiled.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message)).toEqual([]);
    expect(compiled.diagnostics.filter((entry) => diagnosticClass(entry.code) === "never").map((entry) => `${entry.code}: ${entry.message}`)).toEqual([]);
    // THE RINGS' SHADOW IS CAST BY THE KIT'S LOW RING (§T1689b): a Mesh File In of it is on the ring Geometry's Shadow
    // Mesh, and the engine has nothing to say of it (no triangles, or a proxy that does not fit the shape it stands for).
    const wires = Object.values(built.graph.edges).map((wire) => `${wire.source.nodeId}.${wire.source.portId} > ${wire.target.nodeId}.${wire.target.portId}`);
    expect(wires).toContain("mesh_ringshadow.out > geometry_ring.shadowMesh");
    expect(wires).toContain("mesh_ring.out > geometry_ring.mesh");
    expect(compiled.diagnostics.filter((entry) => entry.code.startsWith("node.scene.shadowMesh")).map((entry) => entry.message)).toEqual([]);
    // It compiled the whole piece, not a stub of it.
    expect(compiled.passes.length).toBeGreaterThan(20);
  });
});

describe("the sentinel's file is as long as its show", () => {
  it("with the loop on, every place of the show comes round before the file starts again, to the shipped beat and to a faster track", () => {
    for (const track of [SHIPPED_TRACK, { file: "media/sentinel-bot/track", bpm: 134, beatsPerBar: 4, beatOffset: 0 }]) {
      const built = sentinelDocument(KIT_FIXTURE, { track });
      const range = projectRange(built.settings);
      /** The bar of the track a frame of the file is in. */
      const barAt = (frame: number): number => (frame / projectFps(built.settings) - track.beatOffset) / ((track.beatsPerBar * 60) / track.bpm);
      expect(range.start).toBe(0);
      // The temple is the last place of a round (director.ts): the file runs well into its turn. (At the default
      // range, ten seconds, it ended in bar 5 of the first turn, and the loop began the show again from there.)
      expect(barAt(range.end)).toBeGreaterThan(TEMPLE_TURN * FIELD_BARS + FIELD_BARS / 4);
      // …and no further than a round, or than the transport will seek to.
      expect(barAt(range.end)).toBeLessThanOrEqual(SHOW_TURNS * FIELD_BARS);
      expect(range.end).toBeLessThanOrEqual(SEEK_FRAME_LIMIT);
    }
  });
});

describe("the sentinel follows the track", () => {
  it("measures a passage against a memory of the track, and no track at all is 0", () => {
    expect(read(against("loud", "memory"), { loud: 0.2, memory: 0.2 })).toBe(1);
    expect(read(against("loud", "memory"), { loud: 0.05, memory: 0.2 })).toBe(0.25);
    expect(read(against("loud", "memory"), { loud: 0.3, memory: 0.2 })).toBeCloseTo(1.5, 12);
    // Silence, and the first frame of a track over a memory of silence: no division by nothing.
    expect(read(against("loud", "memory"), { loud: 0, memory: 0 })).toBe(0);
    expect(read(against("loud", "memory"), { loud: 0.002, memory: 0 })).toBe(2);
  });

  it("is slower through a breakdown and faster through a loud passage, and the track is the difference", () => {
    expect(read(pace("follow", "energy"), { follow: 1, energy: 1 })).toBe(1);
    expect(read(pace("follow", "energy"), { follow: 1, energy: 0.8 })).toBeCloseTo(0.7, 12);
    expect(read(pace("follow", "energy"), { follow: 1, energy: 1.2 })).toBeCloseTo(1.3, 12);
    // Bounded both ways: a breakdown does not stop it and a drop does not fling it.
    expect(read(pace("follow", "energy"), { follow: 1, energy: 0.1 })).toBe(0.5);
    expect(read(pace("follow", "energy"), { follow: 1, energy: 4 })).toBe(1.6);
    // Cut the switch and every passage is walked at the panel's own speed.
    expect([0.1, 0.8, 1.2, 4].map((value) => read(pace("follow", "energy"), { follow: 0, energy: value }))).toEqual([1, 1, 1, 1]);
  });

  it("goes out to the fields for the third sixteen bars of the show and for a glimpse early on, on the bar count alone, and never opens there", () => {
    const afield = (bar: number, follow = 1): number => read(fieldTurn("follow", "bar"), { follow, bar });
    expect([FIELD_BARS, FIELD_TURN]).toEqual([16, 2]);
    // The opening is the tunnel's, twelve bars of it; then four bars' glimpse of the towers (the owner: "show the
    // aesthetics with the spires a bit earlier"); the tunnel to bar thirty-two; sixteen in the fields, to the bar;
    // then the tunnel again.
    expect([GLIMPSE.from, GLIMPSE.to]).toEqual([12, 16]);
    for (let bar = 0; bar < 96; bar += 0.25) expect([bar, afield(bar)]).toEqual([bar, (bar >= 12 && bar < 16) || (bar >= 32 && bar < 48) ? 1 : 0]);
    // …and again a show later, bars 128 to 144.
    expect([afield(127.999), afield(128), afield(143.999), afield(144)]).toEqual([0, 1, 1, 0]);
    // The glimpse is once: the second time round the show, bars 108 to 112 are the tunnel's.
    expect([afield(108), afield(111)]).toEqual([0, 0]);
    // It changes on a bar that is a multiple of two, which is where the camera cuts (camera.ts, `turn`).
    expect([afield(31.999), afield(32), afield(47.999), afield(48)]).toEqual([0, 1, 1, 0]);
    // Cut the switch and it never leaves the tunnel.
    for (let bar = 0; bar < 96; bar += 1) expect(afield(bar, 0)).toBe(0);
  });

  it("goes to the dock for the sixteen bars after its first turn in the fields, and is never in two places", () => {
    const docked = (bar: number, follow = 1): number => read(dockTurn("follow", "bar"), { follow, bar });
    const afield = (bar: number): number => read(fieldTurn("follow", "bar"), { follow: 1, bar });
    expect(DOCK_TURN).toBe(3);
    // Bars 48 to 64, to the bar, and again a show later (144 to 160); nowhere else.
    for (let bar = 0; bar < 192; bar += 0.25) expect([bar, docked(bar)]).toEqual([bar, (bar >= 48 && bar < 64) || (bar >= 144 && bar < 160) ? 1 : 0]);
    // It follows the fields without a bar of tunnel between: the place changes on the turn's own line, where the camera cuts.
    expect([afield(47.999), docked(47.999), afield(48), docked(48)]).toEqual([1, 0, 0, 1]);
    // THE TEMPLE: the last sixteen bars of the show's ninety-six, bars 80 to 96, and 176 to 192.
    const templed = (bar: number, follow = 1): number => read(templeTurn("follow", "bar"), { follow, bar });
    expect(TEMPLE_TURN).toBe(5);
    for (let bar = 0; bar < 192; bar += 0.25) expect([bar, templed(bar)]).toEqual([bar, (bar >= 80 && bar < 96) || bar >= 176 ? 1 : 0]);
    expect(templed(85, 0)).toBe(0);
    // Never two places at once, and in ninety-six bars it has been to all three.
    for (let bar = 0; bar < 192; bar += 0.5) expect(afield(bar) + docked(bar) + templed(bar)).toBeLessThanOrEqual(1);
    expect([afield(40), docked(56), templed(88)]).toEqual([1, 1, 1]);
    // Cut the switch and it never goes.
    for (let bar = 0; bar < 96; bar += 1) expect(docked(bar, 0)).toBe(0);
  });

  it("turns the robots' lights to a colour of its own in each sixteen bars of the show, cold in the fields, and only on a turn's first bar", () => {
    const hue = (bar: number, follow = 1, place = 0): number => read(showHue("follow", "place", "dock", "temple", "bar"), { follow, place, dock: 0, temple: 0, bar });
    expect(SHOW_TURNS * FIELD_BARS).toBe(96);
    // Each turn of the tunnel's holds its own colour from its first bar to its last. (The fields' turns read 0
    // here: out there the place says the colour, below.)
    for (let turn = 0; turn < SHOW_TURNS * 2; turn += 1) {
      // (Plus nothing: a sum of nothings can be minus zero, which is zero.)
      for (const within of [0, 7.5, 15.99]) expect([turn, hue(turn * FIELD_BARS + within) + 0]).toEqual([turn, SHOW_HUES[turn % SHOW_TURNS]]);
    }
    // Not one colour all the way through (the owner: "the colour feels very much static"): the tunnel alone has
    // three, and the fields and the dock one each of their own.
    expect(new Set(SHOW_HUES.filter((_, turn) => turn !== FIELD_TURN && turn !== DOCK_TURN && turn !== TEMPLE_TURN)).size).toBe(3);
    expect(new Set([...SHOW_HUES, FIELD_HUE, DOCK_HUE, TEMPLE_HUE]).size).toBe(6);
    // Never upward past amber: the wheel has green a third of the way up, and these lights have none.
    for (const turned of [...SHOW_HUES, FIELD_HUE, DOCK_HUE, TEMPLE_HUE]) expect(turned > -0.55 && turned < 0.1).toBe(true);
    // In the dock it is the dock's colour and in the temple the temple's, whoever put it there.
    expect(read(showHue("follow", "place", "dock", "temple", "bar"), { follow: 0, place: 0, dock: 1, temple: 0, bar: 5 })).toBe(DOCK_HUE);
    expect(read(showHue("follow", "place", "dock", "temple", "bar"), { follow: 0, place: 0, dock: 0, temple: 1, bar: 5 })).toBe(TEMPLE_HUE);
    // In the fields it is the fields' colour, whoever put it there: the show, or the panel with the show off.
    expect(hue(40, 1, 1)).toBe(FIELD_HUE);
    expect(hue(5, 0, 1)).toBe(FIELD_HUE);
    // The show off and the tunnel: where the panel has them.
    for (let bar = 0; bar < 96; bar += 8) expect(hue(bar, 0, 0) + 0).toBe(0);
  });

  it("stands for four bars in the middle of its turn in the fields and of its turn in the temple, and nowhere else", () => {
    const stands = (bar: number, follow = 1): number => read(showStand("follow", "bar"), { follow, bar });
    expect([STAND.from, STAND.to]).toEqual([8, 12]);
    for (let bar = 0; bar < 192; bar += 0.25) {
      const turn = Math.floor(bar / FIELD_BARS);
      const within = bar - turn * FIELD_BARS;
      expect([bar, stands(bar)]).toEqual([bar, (turn % 6 === FIELD_TURN || turn % 6 === TEMPLE_TURN) && within >= 8 && within < 12 ? 1 : 0]);
    }
    // It begins and ends on a bar the camera cuts on, and is two of its shots long.
    expect([stands(39.999), stands(40), stands(43.999), stands(44)]).toEqual([0, 1, 1, 0]);
    // The show off: no stand.
    for (let bar = 0; bar < 96; bar += 1) expect(stands(bar, 0)).toBe(0);
  });

  it("rushes only at the top of the track, every other eight bars of it, and never with the show off", () => {
    const rushes = (intensity: number, draw: number, follow = 1): number => read(phraseRush("follow", "intensity", "draw"), { follow, intensity, draw });
    expect([RUSH.bars, RUSH.over, RUSH.share]).toEqual([8, 0.75, 0.5]);
    expect([rushes(0.9, 0.2), rushes(0.9, 0.6), rushes(0.75, 0.2), rushes(0.76, 0.49)]).toEqual([1, 0, 0, 1]);
    expect(rushes(1, 0, 0)).toBe(0);
    // Visibly faster: well over twice the pace.
    expect(RUSH.pace).toBeGreaterThan(2);
  });

  it("perches only when a breakdown has gone nearly silent", () => {
    expect(read(rest("follow", "energy"), { follow: 1, energy: 0.3 })).toBe(0);
    expect(read(rest("follow", "energy"), { follow: 1, energy: 0.21 })).toBeCloseTo(0.5, 12);
    expect(read(rest("follow", "energy"), { follow: 1, energy: 0.12 })).toBe(1);
    expect(read(rest("follow", "energy"), { follow: 0, energy: 0.05 })).toBe(0);
  });

  it("swims only when the track is well over the quietest it has lately been", () => {
    expect(read(surge("follow", "lift"), { follow: 1, lift: 1.5 })).toBe(0);
    expect(read(surge("follow", "lift"), { follow: 1, lift: 1.85 })).toBeCloseTo(0.5, 12);
    expect(read(surge("follow", "lift"), { follow: 1, lift: 2.2 })).toBe(1);
    expect(read(surge("follow", "lift"), { follow: 0, lift: 2.2 })).toBe(0);
  });

  it("takes the long view a phrase at a time: swims some phrases when the passage is among the loudest of the last minute, perches some when among the quietest", () => {
    // A phrase is four bars, and its draw is the same wherever in the phrase it is asked, and another for the next.
    const draws = [0, 1, 3.9, 4, 7.99, 8].map((bar) => read(phraseDraw("bar", 1), { bar }));
    expect(PHRASE_BARS).toBe(4);
    expect([draws[1], draws[2]]).toEqual([draws[0], draws[0]]);
    expect(draws[4]).toBe(draws[3]);
    expect(new Set([draws[0], draws[3], draws[5]]).size).toBe(3);
    for (const draw of draws) expect(draw >= 0 && draw < 1).toBe(true);
    // Swimming: never under 0.7 of intensity whatever the draw; at the top, a draw under 0.66 swims and one over does not.
    expect(read(phraseSwim("follow", "intensity", "draw"), { follow: 1, intensity: 0.7, draw: 0 })).toBe(0);
    expect(read(phraseSwim("follow", "intensity", "draw"), { follow: 1, intensity: 1, draw: 0.6 })).toBe(1);
    expect(read(phraseSwim("follow", "intensity", "draw"), { follow: 1, intensity: 1, draw: 0.7 })).toBe(0);
    expect(read(phraseSwim("follow", "intensity", "draw"), { follow: 0, intensity: 1, draw: 0 })).toBe(0);
    // Perching: only under half, and then three phrases in five.
    expect(read(phrasePerch("follow", "intensity", "draw"), { follow: 1, intensity: 0.3, draw: 0.4 })).toBe(1);
    expect(read(phrasePerch("follow", "intensity", "draw"), { follow: 1, intensity: 0.3, draw: 0.6 })).toBe(0);
    expect(read(phrasePerch("follow", "intensity", "draw"), { follow: 1, intensity: 0.5, draw: 0 })).toBe(0);
    // The pace: 0.65 at the quietest of the last minute, 1 in the middle, 1.35 at the loudest.
    expect([0, 0.5, 1].map((intensity) => read(stride("follow", "intensity"), { follow: 1, intensity }))).toEqual([0.65, 1, 1.5]);
    expect(read(stride("follow", "intensity"), { follow: 0, intensity: 1 })).toBe(1);
    // The attack: only at the very top, three phrases in ten. The corkscrew: only in the middle, a phrase in four.
    expect(read(phraseAttack("follow", "intensity", "draw"), { follow: 1, intensity: 0.9, draw: 0.2 })).toBe(1);
    expect(read(phraseAttack("follow", "intensity", "draw"), { follow: 1, intensity: 0.9, draw: 0.4 })).toBe(0);
    expect(read(phraseAttack("follow", "intensity", "draw"), { follow: 1, intensity: 0.8, draw: 0 })).toBe(0);
    expect(read(phraseSpiral("follow", "intensity", "draw"), { follow: 1, intensity: 0.6, draw: 0.2 })).toBe(1);
    expect(read(phraseSpiral("follow", "intensity", "draw"), { follow: 1, intensity: 0.6, draw: 0.3 })).toBe(0);
    expect([0.4, 0.85].map((intensity) => read(phraseSpiral("follow", "intensity", "draw"), { follow: 1, intensity, draw: 0 }))).toEqual([0, 0]);
    expect(read(phraseAttack("follow", "intensity", "draw"), { follow: 0, intensity: 1, draw: 0 }) + read(phraseSpiral("follow", "intensity", "draw"), { follow: 0, intensity: 0.6, draw: 0 })).toBe(0);
    // A pause: the first two bars of a phrase in four, at any intensity short of the very top.
    expect([0, 1, 2, 3, 4].map((bar) => read(phrasePause("follow", "intensity", "draw", "bar"), { follow: 1, intensity: 0.6, draw: 0.2, bar }))).toEqual([1, 1, 0, 0, 1]);
    expect(read(phrasePause("follow", "intensity", "draw", "bar"), { follow: 1, intensity: 0.6, draw: 0.3, bar: 0 })).toBe(0);
    expect(read(phrasePause("follow", "intensity", "draw", "bar"), { follow: 1, intensity: 0.9, draw: 0, bar: 0 })).toBe(0);
    // The pack: the leader alone, except for about one eight-bar turn in five; never without the switch. By the turn's
    // draw and nothing that moves inside a turn, so it is called on a bar line, where the camera cuts.
    expect([0.1, PACK_SHARE - 0.01, PACK_SHARE + 0.01, 0.9].map((draw) => read(packSize("follow", "draw", 3), { follow: 1, draw }))).toEqual([3, 3, 1, 1]);
    expect(read(packSize("follow", "draw", 3), { follow: 0, draw: 0 })).toBe(1);
    // Its turns are eight bars long: the same draw from bar 0 to 7, another from 8.
    const turns = [0, 7, 8].map((bar) => read(phraseDraw("bar", 6, PACK_BARS), { bar }));
    expect([turns[1] === turns[0], turns[2] === turns[0]]).toEqual([true, false]);
  });

  it("follows nothing in silence: a host with no track behaves as the panel says", () => {
    expect(read(pace("follow", "energy"), { follow: 1, energy: 0 })).toBe(1);
    expect(read(surge("follow", "lift"), { follow: 1, lift: 0 })).toBe(0);
    // No track is not a silent breakdown: it does not sit down either.
    expect(read(rest("follow", "energy"), { follow: 1, energy: 0 })).toBe(0);
  });
});

/**
 * The same, through the document's own value graph hearing its own clip (the shipped beat,
 * by the app's offline walk), against the same frames with the Follow switch off. The clip's
 * arrangement is written down (`SHOWCASE_BEAT`): bars 9 and 10 are silent and bar 11 comes
 * back in full, so where the breakdown and the return fall is the clip's own statement.
 */
const FPS = 60;
const FRAMES = 30 * FPS;
const SILENT = { from: showcaseBarStart(SHOWCASE_BEAT.silence.from), to: showcaseBarStart(SHOWCASE_BEAT.silence.to + 1) };

interface Run {
  /** Metres a second asked of the robot, per frame. */
  readonly rate: number[];
  readonly energy: number[];
  readonly lift: number[];
  /** Where the passage stands among the last minute's, and the bar the track is in. */
  readonly intensity: number[];
  readonly bar: number[];
  /** How much it is told to swim, per frame, before the easing. */
  readonly swimAsked: number[];
  /** How much it swims, per frame: the channel every piece's kernel reads. */
  readonly swim: number[];
  /** How much it perches, per frame, before the easing the rig reads it through. */
  readonly perch: number[];
  /** How much it is attacking, per frame, eased: what the rig and the pace read. */
  readonly attack: number[];
  /** How many of the pack are out, per frame, eased. */
  readonly pack: number[];
  /** Whether it is told to rush, per frame, and how much it is rushing, eased. */
  readonly rush: number[];
  readonly rushing: number[];
  /** Which place it is in (1 the fields), and which shot of the early glimpse of them (0 none). */
  readonly place: number[];
  readonly glimpse: number[];
  /** The body light's Shadow On, per frame, as its expression has it (anything but 0 is on). */
  readonly bodyShadow: number[];
  /** Metres travelled by the last frame. */
  readonly distance: number;
  /** The camera, per frame: the lens the shot asks for and the one the Camera is given, degrees; and the kick. */
  readonly lens: number[];
  readonly fov: number[];
  readonly kick: number[];
  /** The focus pass's aperture, per frame, and what it is with nothing opening it (the panel's Depth of Field for that lens). */
  readonly aperture: number[];
  readonly apertureAtRest: number[];
  /** The shot the camera is on, per frame; how long a shot is held just then, in bars and as the least seconds between cuts. */
  readonly pick: number[];
  readonly shotBars: number[];
  readonly hold: number[];
}

async function run(follow: boolean, heard: boolean, pump?: number): Promise<Run> {
  const built = sentinelDocument(KIT_FIXTURE);
  const toggle = built.graph.nodes["toggle_follow"]!;
  const pumped = built.graph.nodes["slider_pump"]!;
  const graph = { ...built.graph, nodes: { ...built.graph.nodes, toggle_follow: { ...toggle, parameters: { ...toggle.parameters, on: follow } }, ...(pump === undefined ? {} : { slider_pump: { ...pumped, parameters: { ...pumped.parameters, value: pump } } }) } };
  /** A node parameter's expression, as the document stores it. */
  const expressionOf = (nodeId: string, key: string): string => {
    const stored = (graph.nodes as Record<string, typeof toggle | undefined>)[nodeId]?.parameters[key];
    if (typeof stored !== "object" || stored === null || !("bindings" in stored) || stored.bindings.expression?.kind !== "expression") throw new Error(`${nodeId}.${key} is not an expression`);
    return stored.bindings.expression.source;
  };
  const [fovSource, apertureSource, bodyShadowSource] = [expressionOf("camera_rig", "fov"), expressionOf("wgsl_focus", "aperture"), expressionOf("light_body", "shadowOn")];
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const flattened = flattenComponents({ graph, registry, components: await starterComponentsView() });
  const audio = shippedClipAudio(graph, FPS);
  if (audio === undefined) throw new Error("the sentinel binds the shipped beat; the test must hear it");
  const session = createValueGraphSession(registry);
  const rate: number[] = [];
  const energy: number[] = [];
  const lift: number[] = [];
  const intensity: number[] = [];
  const bar: number[] = [];
  const swimAsked: number[] = [];
  const swim: number[] = [];
  const perch: number[] = [];
  const attack: number[] = [];
  const pack: number[] = [];
  const rush: number[] = [];
  const rushing: number[] = [];
  const place: number[] = [];
  const glimpse: number[] = [];
  const bodyShadow: number[] = [];
  const lens: number[] = [];
  const fov: number[] = [];
  const kick: number[] = [];
  const aperture: number[] = [];
  const apertureAtRest: number[] = [];
  const pick: number[] = [];
  const shotBars: number[] = [];
  const hold: number[] = [];
  let first = Number.NaN;
  let last = Number.NaN;
  for (let index = 0; index < FRAMES; index += 1) {
    const features = heard ? audio(index) : null;
    const result = session.evaluate(
      flattened.graph,
      { timeSeconds: index / FPS, deltaSeconds: 1 / FPS, frameIndex: index, mode: "offline", randomSeed: 1 },
      { flattening: flattened, ...(features === null ? {} : { audio: features }) },
    );
    expect(result.diagnostics).toEqual([]);
    const read = (address: string): number => {
      const value = result.resolver(address, undefined as never);
      if (typeof value !== "number") throw new Error(`no channel ${address}`);
      return value;
    };
    rate.push(read("constant_rate:value"));
    energy.push(read("constant_energy:value"));
    lift.push(read("constant_lift:value"));
    intensity.push(read("lag_intensity:level"));
    bar.push(read("audiofile_track:bar"));
    swimAsked.push(read("constant_swim:value"));
    swim.push(read("lag_swim:value"));
    perch.push(read("constant_perch:value"));
    attack.push(read("lag_attack:value"));
    pack.push(read("lag_pack:value"));
    rush.push(read("constant_rush:value"));
    rushing.push(read("lag_rush:value"));
    place.push(read("constant_place:value"));
    glimpse.push(read("constant_glimpse:value"));
    // The camera's own two expressions, read as the app reads them: against this frame's channels.
    const evaluated = (source: string): number => {
      const value = evaluateExpression(source, { abstime: index / FPS, time: index / FPS }, (name, path) => (path[0] === "chan" && path[1] !== undefined ? { ok: true, value: read(`${name}:${path[1]}`) } : { ok: false, reason: `not a channel: ${path.join(".")}` }));
      if (!value.ok) throw new Error(`"${source.slice(0, 60)}…" does not evaluate: ${value.reason}`);
      return value.value;
    };
    lens.push(read("expression_camera:lens"));
    fov.push(evaluated(fovSource));
    kick.push(read("lag_hits:kickCount"));
    aperture.push(evaluated(apertureSource));
    bodyShadow.push(evaluated(bodyShadowSource));
    apertureAtRest.push((read("slider_focus:focus") * 55) / read("expression_camera:lens"));
    pick.push(read("expression_camera:pick"));
    shotBars.push(read("expression_cut:bars"));
    hold.push(read("expression_cut:hold"));
    last = read("speed_travel:value");
    if (index === 0) first = last;
  }
  return { rate, energy, lift, intensity, bar, swimAsked, swim, perch, attack, pack, rush, rushing, place, glimpse, bodyShadow, distance: last - first, lens, fov, kick, aperture, apertureAtRest, pick, shotBars, hold };
}

/** The frames of a stretch of the clip, in seconds. */
function during<T>(values: readonly T[], from: number, to: number): T[] {
  return values.slice(Math.round(from * FPS), Math.round(to * FPS));
}

/** The director's rules in plain arithmetic, for reading the chain's frames against. */
const smooth = (from: number, to: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
};
const drawOf = (bar: number, salt: number): number => {
  const x = Math.sin((Math.floor(bar / PHRASE_BARS) + salt) * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

describe("the sentinel follows its own clip, through the document's value graph", () => {
  it("walks at the pace the track sets, frame for frame, and has stopped by the end of the breakdown", async () => {
    const followed = await run(true, true);
    const panel = await run(false, true);
    // What the track is doing is the track's and not the switch's: both runs hear the same.
    expect(followed.energy).toEqual(panel.energy);
    expect(followed.intensity).toEqual(panel.intensity);
    // Every frame: the pace is the panel's own, times what the energy says, times what the long view says, less what it perches.
    const ratio = followed.rate.map((value, index) => value / panel.rate[index]!);
    const sounding = ratio.map((value, index) => ({ ratio: value, energy: followed.energy[index]!, intensity: followed.intensity[index]!, perch: followed.perch[index]!, attack: followed.attack[index]!, rush: followed.rush[index]! })).filter((frame) => frame.energy > 0);
    expect(sounding.length).toBeGreaterThan(FRAMES * 0.95);
    // …and it goes at four tenths of that while it attacks, and at RUSH.pace times it in a rush.
    const long = (intensity: number): number => 1 + (intensity - 0.5) * 0.7 + Math.max(intensity - 0.5, 0) * 0.3;
    for (const frame of sounding) expect(frame.ratio).toBeCloseTo(Math.min(1.6, Math.max(0.5, 1 + (frame.energy - 1) * 1.5)) * long(frame.intensity) * (1 - frame.perch) * (1 - 0.6 * frame.attack) * (1 + (RUSH.pace - 1) * frame.rush), 9);
    // A rush is told by its rule and nothing else: the top of the track, every other eight bars.
    for (let index = 0; index < FRAMES; index += 1) {
      const draw = Math.sin((Math.floor(followed.bar[index]! / RUSH.bars) + 7) * 12.9898) * 43758.5453;
      const margin = followed.intensity[index]! - RUSH.over;
      if (Math.abs(margin) < 1e-9) continue;
      expect(followed.rush[index]).toBe(followed.energy[index]! > 0 && margin > 0 && draw - Math.floor(draw) < RUSH.share ? 1 : 0);
    }
    // The breakdown, as measured on the clip: perched and standing still from three seconds into the silent
    // bars until the track is back.
    expect(during(followed.perch, SILENT.from + 3, SILENT.to).every((value) => value === 1)).toBe(true);
    expect(during(ratio, SILENT.from + 3, SILENT.to).every((value) => value === 0)).toBe(true);
    // With the switch off it never perches.
    expect(Math.max(...panel.perch)).toBe(0);
    // So it ends somewhere else along the tunnel.
    expect(Math.abs(followed.distance - panel.distance)).toBeGreaterThan(5);
  });

  it("swims and perches by its rules and nothing else, frame for frame; the return from the breakdown is a swim", async () => {
    const followed = await run(true, true);
    const panel = await run(false, true);
    let swimPhrases = 0;
    for (let index = 0; index < FRAMES; index += 1) {
      const sounding = followed.energy[index]! > 0;
      const margin = (followed.intensity[index]! - 0.7) * 2.2 - drawOf(followed.bar[index]!, 1);
      // A frame whose draw sits on the threshold could fall either way in the last bit of a double: not read.
      if (Math.abs(margin) < 1e-9) continue;
      const byPhrase = margin > 0 ? 1 : 0;
      swimPhrases += byPhrase;
      // Told to swim: the track coming back in (lift), or this phrase's turn at this intensity; never in a phrase it
      // attacks. And always while more than one of the pack is out: a pack flies, it does not walk.
      const attacking = followed.intensity[index]! > 0.85 && drawOf(followed.bar[index]!, 3) < 0.3 ? 1 : 0;
      const flown = smooth(1.1, 1.6, followed.pack[index]!);
      // …and in a rush, which is swum.
      expect(followed.swimAsked[index]).toBeCloseTo(Math.max(followed.rush[index]!, flown, Math.max(smooth(1.5, 2.2, followed.lift[index]!), byPhrase) * (1 - attacking)), 9);
      // Perched: a breakdown gone nearly silent, this phrase's turn at a low intensity, or a pause in its first two bars; never for no track.
      const bar = followed.bar[index]!;
      const low = followed.intensity[index]! < 0.5 && drawOf(bar, 2) < 0.6 && sounding ? 1 : 0;
      const pause = followed.intensity[index]! < 0.85 && drawOf(bar, 5) < 0.25 && bar - PHRASE_BARS * Math.floor(bar / PHRASE_BARS) < 2 && sounding ? 1 : 0;
      const silent = sounding ? 1 - smooth(0.12, 0.3, followed.energy[index]!) : 0;
      expect(followed.perch[index]).toBeCloseTo(Math.max(silent, low, pause), 9);
    }
    // From two and a half seconds after the return from the silent bars it is swimming (measured: 0.95 and over).
    // (Before the pack existed this also said it held the wall through the silent bars. On this clip the pack is out
    // by then, and a pack hovers when it stops: the frame-for-frame rule above is what says so.)
    expect(Math.min(...during(followed.swim, SILENT.to + 2.5, SILENT.to + 4))).toBeGreaterThan(0.9);
    // And the phrase rule did have its turn in these thirty seconds (88 frames of it on the clip), so the equality above read both branches.
    expect(swimPhrases).toBeGreaterThan(30);
    // The pack never comes out without the switch.
    expect(Math.max(...panel.pack)).toBe(1);
    // The switch is the difference: off, the panel's Swim (0) is all there is.
    expect(Math.max(...panel.swim)).toBe(0);
  });

  it("the lens holds its length through every kick; some phrases the kick opens the aperture instead, and the panel says how far", async () => {
    // The owner, 2026-10-06, of a lens that punched in 2.5 degrees on every kick: "the very prominent and constant
    // camera punching … feels a bit irritating … a bit jarring … maybe occasionally we drive DOF instead".
    const followed = await run(true, true);
    const kicks = followed.kick.filter((value) => value > 0.3).length;
    expect(kicks).toBeGreaterThan(50);
    // Every frame of the clip, kick or no kick: the Camera has the lens the shot asks for, and seven degrees more
    // of it in a rush, eased in and out over a second and more. Nothing of the kick.
    for (let index = 0; index < FRAMES; index += 1) expect(Math.abs(followed.fov[index]! - followed.lens[index]! - 7 * followed.rushing[index]!)).toBeLessThan(1e-9);
    // …and frame to frame it never moves as a punch does: under a fifth of a degree, where a shot does not change.
    for (let index = 1; index < FRAMES; index += 1) if (followed.pick[index] === followed.pick[index - 1]) expect(Math.abs(followed.fov[index]! - followed.fov[index - 1]!)).toBeLessThan(0.2);
    // The aperture: at rest except in the phrases whose draw is under 0.45, and there wider by as much as the kick is in.
    let opened = 0;
    let held = 0;
    for (let index = 0; index < FRAMES; index += 1) {
      const gate = drawOf(followed.bar[index]!, 11) < 0.45 ? 1 : 0;
      const expected = followed.apertureAtRest[index]! * (1 + 0.6 * 1.4 * followed.kick[index]! * gate);
      expect(Math.abs(followed.aperture[index]! - expected)).toBeLessThan(1e-9);
      if (followed.kick[index]! > 0.3) {
        if (gate === 1) opened += 1;
        else held += 1;
      }
    }
    // Both kinds of phrase are in the clip: kicks that open it and kicks that do not.
    expect(opened).toBeGreaterThan(10);
    expect(held).toBeGreaterThan(10);
    // The panel's Focus on the Kick at 0: never.
    const never = await run(true, true, 0);
    expect(never.aperture).toEqual(never.apertureAtRest);
  });

  it("holds the opening shot eight bars, cuts only on a bar line, and never twice within a shot's length", async () => {
    // The owner, 2026-10-06: "cuts are a bit too hectic even while there's a build up. we need to make sure to not
    // get tricked during intros etc and hastily cutting around if it's something rather calm". On his track the
    // old rule cut 73 times in 198 seconds, six of them in the first twelve, some a tenth of a second apart.
    const followed = await run(true, true);
    const cuts: number[] = [];
    for (let index = 1; index < FRAMES; index += 1) if (followed.pick[index] !== followed.pick[index - 1]) cuts.push(index);
    // A cut is the camera's own (its count went up) or the show's: the place changed, or the glimpse of the fields
    // went to its second shot (director.ts, GLIMPSE). The show's are on its own bars and are not the camera's pace.
    const shows = (index: number): boolean => followed.place[index] !== followed.place[index - 1] || followed.glimpse[index] !== followed.glimpse[index - 1];
    const own = cuts.filter((index) => !shows(index));
    // It does cut, and not on every second bar as it did: the shipped clip is sixteen bars of a sparse beat (measured:
    // one cut of its own, at bar 8; the old rule made seven).
    expect(own.length).toBeGreaterThanOrEqual(1);
    expect(own.length).toBeLessThanOrEqual(3);
    // The opening: one shot until the eighth bar, whatever the first bars hold.
    expect(followed.bar[cuts[0] as number]).toBeGreaterThanOrEqual(8);
    expect(followed.shotBars.slice(0, cuts[0] as number).every((bars) => bars === 8)).toBe(true);
    for (const [at, index] of own.entries()) {
      // On a bar line: the bar count has just stepped, and to a bar the pace at that moment cuts on.
      expect(followed.bar[index]).not.toBe(followed.bar[index - 1]);
      // Not within a shot's length of its last one: nine tenths of it, by the pace it is on.
      if (at > 0) expect((index - (own[at - 1] as number)) / FPS).toBeGreaterThanOrEqual((followed.hold[index] as number) - 1 / FPS);
    }
    // The show's cuts in this clip are the glimpse: into the fields on bar 12, to its second shot on bar 14, each
    // on the bar line; and the two shots are the place from above and then the three from in front.
    const shown = cuts.filter(shows);
    expect(shown.map((index) => followed.bar[index])).toEqual([GLIMPSE.from, (GLIMPSE.from + GLIMPSE.to) / 2].filter((bar) => bar <= (followed.bar[FRAMES - 1] as number)));
    expect(shown.map((index) => SHOTS[followed.pick[index] as number])).toEqual(["fieldhigh", "fieldfront"].slice(0, shown.length));
    expect(shown.length).toBeGreaterThanOrEqual(1);
    // Whatever pace it is on is one of the three (the rule for which is camera.test.ts's).
    expect([...new Set(followed.shotBars)].every((bars) => bars === 8 || bars === 4 || bars === 2)).toBe(true);
  });

  it("the body light's shadow is the tunnel's: on in the bore, out for as long as it is in a place, and back with the bore", async () => {
    // §T1688b: Shadow On is a value, so a place can put a shadow out and no plan is rebuilt for it. Out of the bore
    // nothing is in that light's reach to take a shadow, and its sweeps were the largest cost of the frame.
    const followed = await run(true, true);
    const inPlace = followed.place.map((place) => place !== 0);
    // The shipped clip holds both: the tunnel, and from bar 12 the glimpse of the fields.
    expect(inPlace.includes(true) && inPlace.includes(false)).toBe(true);
    // On is anything but 0 (the engine's rule for a driven switch): frame for frame it is on exactly where there is no place.
    expect(followed.bodyShadow.map((value) => value !== 0)).toEqual(inPlace.map((out) => !out));
    // …and it is a switch here, not a fade: one or nothing.
    expect([...new Set(followed.bodyShadow)].sort()).toEqual([0, 1]);
    // Not following the track there is no place to go to: the shadow never goes out.
    const unfollowed = await run(false, true);
    expect(unfollowed.place.every((place) => place === 0)).toBe(true);
    expect(unfollowed.bodyShadow.every((value) => value === 1)).toBe(true);
  });

  it("with nothing playing the switch changes nothing", async () => {
    const followed = await run(true, false);
    const panel = await run(false, false);
    expect(followed.rate).toEqual(panel.rate);
    expect(followed.swim).toEqual(panel.swim);
    expect(Math.max(...followed.swim)).toBe(0);
    expect(followed.distance).toBe(panel.distance);
    expect(followed.distance).toBeGreaterThan(0);
  });
});
