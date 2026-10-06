/**
 * T1561b — FOLLOWING THE TRACK: how the piece behaves by itself when nobody is on the panel.
 *
 * Two numbers say what the track is doing, each the loudness of this passage against a
 * memory of itself (1 = no different):
 *
 *   ENERGY   against what it has USUALLY been lately. The memory is slow to fall, so a
 *            breakdown reads well under 1 for as long as it lasts.
 *   LIFT     against the QUIETEST it has lately been. The memory falls at once and rises
 *            slowly, so the moment a track comes back from a breakdown (or starts) reads well
 *            over 1, and stays there for a few bars until the memory has caught up.
 *
 * Three things follow them:
 *
 *   the robot's pace   slower through a breakdown, a little faster through a loud passage;
 *   perching           when a breakdown goes nearly silent it stops, holds the wall and looks about;
 *   swimming           when the track comes back in, it lets go of the wall and swims.
 *
 * In SILENCE nothing follows: with no track both numbers are 0, which is not a quiet
 * passage, so a host with nothing playing (a headless still, the app before Play) behaves as
 * the panel says. Each is an expression, built here so the document and the test read the
 * same text.
 */

/** Below this a level is no track at all. */
const SOUNDING = 0.001;

/** A loudness against a memory of itself: 1 when they agree, 0 when nothing is sounding. */
export function against(loud: string, memory: string): string {
  return `((${loud} > ${SOUNDING}) * ${loud} / max(${memory}, ${SOUNDING}))`;
}

/** What the pace is multiplied by: half in a breakdown, 1 when the track is as loud as usual, 1.6 at most. */
export function pace(follow: string, energy: string): string {
  return `(1 + ${follow} * (${energy} > 0) * clamp((${energy} - 1) * 1.5, -0.5, 0.6))`;
}

/** How much it perches because of the track: not at all above three tenths of the usual loudness, wholly under an eighth. */
export function rest(follow: string, energy: string): string {
  return `(${follow} * (${energy} > 0) * (1 - smoothstep(0.12, 0.3, ${energy})))`;
}

/**
 * How much it swims because of the track: nothing until the passage is half as loud again as
 * the quietest lately, all of it from 2.2 times. A bar that only pulls back does not reach it.
 */
export function surge(follow: string, lift: string): string {
  return `(${follow} * smoothstep(1.5, 2.2, ${lift}))`;
}

/**
 * THE LONG VIEW. Energy and lift above only see a change: a track that builds for a minute
 * without ever breaking down reads as "no different" all the way (measured on the owner's first
 * track: after the opening it never swam again in three minutes). INTENSITY is where this
 * passage's loudness stands among the last minute's, 0 the quietest to 1 the loudest, and the
 * piece is cut into PHRASES of four bars, each with a draw of its own (the same draw for the
 * same phrase every time, so a scrub finds the same behaviour). A phrase is one behaviour:
 *
 *   high intensity   some phrases it swims, the more of them the higher;
 *   low intensity    some phrases it perches;
 *   between          it walks, at a pace the intensity sets.
 */
export const PHRASE_BARS = 4;

/** A number 0 to 1 for the phrase `bar` is in; `salt` gives each use its own draw. `bars` long: four unless said. */
export function phraseDraw(bar: string, salt: number, bars: number = PHRASE_BARS): string {
  return `fract(sin((floor(${bar} / ${bars}) + ${salt}) * 12.9898) * 43758.5453)`;
}

/** Whether it swims this phrase for the track's sake: never under 0.7 of intensity, two phrases in three at the top. */
export function phraseSwim(follow: string, intensity: string, draw: string): string {
  return `(${follow} * (${draw} < (${intensity} - 0.7) * 2.2))`;
}

/** Whether it perches this phrase for the track's sake: only under half of intensity, and then three phrases in five. */
export function phrasePerch(follow: string, intensity: string, draw: string): string {
  return `(${follow} * (${intensity} < 0.5) * (${draw} < 0.6))`;
}

/**
 * A PAUSE: it stops for the first two bars of a phrase, holds, looks about, and goes on. A phrase in four,
 * at any intensity short of the very top. (The owner, 2026-10-06: "perching and looking around could be
 * more frequent or integrated into other moves".)
 */
export function phrasePause(follow: string, intensity: string, draw: string, bar: string): string {
  return `(${follow} * (${intensity} < 0.85) * (${draw} < 0.25) * (mod(${bar}, ${PHRASE_BARS}) < 2))`;
}

/**
 * THE OTHER PLACES. The piece goes out of the tunnel for sixteen bars at a time. Of the show's six such turns:
 * tunnel, tunnel, the FIELDS (field.ts), the DOCK (dock.ts), tunnel, the TEMPLE (temple.ts); and round again. On
 * the owner's 110 bars the fields are bars 32 to 48 (and four bars early on: GLIMPSE, below), the dock 48 to 64,
 * the temple 80 to 96.
 * By the bar count and nothing else. The track's loudness cannot choose it, because a place must not change
 * in the middle of a shot and nothing here can hold a decision once taken: a rule that read the loudness
 * would put the tunnel back whenever a passage dipped. Sixteen bars is eight of the camera's two-bar shots, so
 * the place changes on a cut.
 */
export const FIELD_BARS = 16;
/** Which of the show's six turns of sixteen bars is the fields': the third. */
export const FIELD_TURN = 2;
/** The show comes round every this many turns of sixteen bars (SHOW_TURNS, below, is the same number, said where the show is). */
const SHOW_TURNS_COUNT = 6;

/**
 * …and a GLIMPSE of them before the first turn: four bars, the last four of the opening sixteen. (The owner,
 * 2026-10-06, of a track whose first sight of the towers was a minute in: "maybe we show the aesthetics with
 * the spires a bit earlier, at least for a little bit".) Two of the camera's shots, and back.
 */
export const GLIMPSE = { from: 12, to: 16 } as const;

/**
 * THE DOCK (dock.ts): the turn after the fields'. By the bar count, as every place is.
 */
export const DOCK_TURN = 3;
/** …and THE TEMPLE (temple.ts): the last turn of the six. */
export const TEMPLE_TURN = 5;

/** Whether the bar `bar` is spent in the temple: 0 or 1. */
export function templeTurn(follow: string, bar: string): string {
  return `(${follow} * (mod(floor(${bar} / ${FIELD_BARS}), ${SHOW_TURNS_COUNT}) == ${TEMPLE_TURN}))`;
}

/** Whether the bar `bar` is spent in the dock: 0 or 1. */
export function dockTurn(follow: string, bar: string): string {
  return `(${follow} * (mod(floor(${bar} / ${FIELD_BARS}), ${SHOW_TURNS_COUNT}) == ${DOCK_TURN}))`;
}

/** Which shot of the glimpse bar `bar` is in: 0 none, 1 its first two bars, 2 its last two (camera.ts, GLIMPSE_SHOTS). */
export function glimpseShot(follow: string, bar: string): string {
  return `(${follow} * (${bar} >= ${GLIMPSE.from}) * (${bar} < ${GLIMPSE.to}) * (1 + (${bar} >= ${(GLIMPSE.from + GLIMPSE.to) / 2})))`;
}

/** Whether the bar `bar` is spent in the fields: 0 or 1. */
export function fieldTurn(follow: string, bar: string): string {
  return `(${follow} * max(mod(floor(${bar} / ${FIELD_BARS}), ${SHOW_TURNS_COUNT}) == ${FIELD_TURN}, (${bar} >= ${GLIMPSE.from}) * (${bar} < ${GLIMPSE.to})))`;
}

/** A pack's turn is eight bars: the others take most of two to come up from behind and as long to fall back. */
export const PACK_BARS = 8;

/**
 * How many of the pack are out, 1 or `most`: the leader alone, except for some eight-bar turns (`draw`, about
 * one in five of them), when the rest come up from behind. An event, not a state: while a pack is out it flies,
 * and a piece that flew whenever it was loud never walked (measured on the owner's track with the pack
 * following the intensity itself: 157 of 198 seconds swimming).
 *
 * By the bar count alone, as the fields are. It also asked for a loud passage (intensity over 0.6), and a
 * number that crosses a line does it between bar lines: the pack's shots then came in a second after the cut
 * on the bar, two cuts for one. Nothing here can hold a decision taken at the head of a turn (a value node
 * that samples and holds is §T1651b), so the call is one that cannot change inside a turn.
 */
export function packSize(follow: string, draw: string, most: number): string {
  return `(1 + ${follow} * ${most - 1} * (${draw} < ${PACK_SHARE}))`;
}
/** The share of eight-bar turns a pack is out for. */
export const PACK_SHARE = 0.22;

/** What the long view multiplies the pace by: 0.65 at the quietest of the last minute, 1.5 at the loudest. */
export function stride(follow: string, intensity: string): string {
  return `(1 + ${follow} * ((${intensity} - 0.5) * 0.7 + max(${intensity} - 0.5, 0) * 0.3))`;
}

/**
 * A RUSH: for some eight-bar turns at the top of the track it lets go of the wall and goes down the tunnel (or
 * between the towers) at well over twice its pace. (The owner, 2026-10-06: "some more energy sections where we
 * go visibly faster through the tunnels maybe. it still feels a bit static even while the music is marching at
 * max".) Swimming, because a walk at that speed is a scramble; and by eight bars, so it is four of the camera's
 * shots at the least and the speed has time to come up and be seen.
 */
export const RUSH = { bars: 8, over: 0.75, share: 0.5, pace: 2.6 } as const;

/** Whether it rushes this turn: only over three quarters of intensity, and then every other turn. */
export function phraseRush(follow: string, intensity: string, draw: string): string {
  return `(${follow} * (${intensity} > ${RUSH.over}) * (${draw} < ${RUSH.share}))`;
}

/**
 * Two more behaviours a phrase can be (the owner, 2026-10-05: "walking in a spiral could be an
 * interesting addition to the repertoire, as well as an attack posture with a bunch of tentacles
 * attacking forwards").
 */

/** Whether it attacks this phrase: only at the very top of the intensity, and then three phrases in ten. It does not swim while it does. */
export function phraseAttack(follow: string, intensity: string, draw: string): string {
  return `(${follow} * (${intensity} > 0.85) * (${draw} < 0.3))`;
}

/** Whether it walks a corkscrew this phrase: in the middle of the intensity, where it is walking, a phrase in four. */
export function phraseSpiral(follow: string, intensity: string, draw: string): string {
  return `(${follow} * (${intensity} > 0.45) * (${intensity} < 0.8) * (${draw} < 0.25))`;
}

/**
 * THE SHOW: what the piece does over a whole track, by turns of sixteen bars (the fields' own turn, FIELD_BARS).
 *
 * The owner, 2026-10-06, of three and a half minutes that were one state travelling forward: "the colour feels
 * very much static all the way through for no good reason … we have a lot of space to use the energy of the song
 * and drive certain things"; "have even a shot where all three of them in the wide space come to a halt, go into
 * attack mode … so that we're not just only going forward, forward, forward … we have so many cool ways of
 * operating these robots and I feel like we are not using a lot of them with a long song."
 *
 * So each turn has a colour of its own for the robots' lights, and the fields' turns have a set piece. Six turns
 * and it comes round again: 96 bars. All of it by the bar count, as the place is, so it changes on a cut and
 * never in the middle of a shot.
 */
export const SHOW_TURNS = SHOW_TURNS_COUNT;

/**
 * How far the robots' lights are turned round the wheel in each turn of the show, in turns of the wheel from
 * where the panel has them (red), for the turns spent in the tunnel: home; amber; (the fields); (the dock);
 * violet; (the temple). A place out of the tunnel has a colour of its own (FIELD_HUE, DOCK_HUE, TEMPLE_HUE).
 * Never upward past amber: no green.
 */
export const SHOW_HUES: readonly number[] = [0, 0.05, 0, 0, -0.28, 0];
/** …and in the fields, whichever turn it is: red becomes a cold cyan, against the pods' red. */
export const FIELD_HUE = -0.45;
for (let turn = 0; turn < SHOW_TURNS; turn += 1) {
  const elsewhere = turn === FIELD_TURN || turn === DOCK_TURN || turn === TEMPLE_TURN;
  if (elsewhere && SHOW_HUES[turn] !== 0) throw new Error(`director.ts: turn ${turn} of the show is spent out of the tunnel, in a place with a colour of its own: its entry in SHOW_HUES must be 0.`);
}

/** …and in the dock: magenta, against the sodium of its lamps. */
export const DOCK_HUE = -0.12;
/** …and in the temple: blue, against its fires. */
export const TEMPLE_HUE = -0.36;

/**
 * The turn of the wheel for bar `bar`: a place's own wherever its flag is 1 (the panel can put it in any of
 * them too), else the show's turn's when following.
 */
export function showHue(follow: string, fields: string, dock: string, temple: string, bar: string): string {
  const turn = `mod(floor(${bar} / ${FIELD_BARS}), ${SHOW_TURNS})`;
  const table = SHOW_HUES.map((hue, index) => (hue === 0 ? null : `(${turn} == ${index}) * ${hue}`)).filter((term) => term !== null).join(" + ");
  return `(${fields} * ${FIELD_HUE} + ${dock} * ${DOCK_HUE} + ${temple} * ${TEMPLE_HUE} + (1 - ${fields}) * (1 - ${dock}) * (1 - ${temple}) * ${follow} * (${table}))`;
}

/**
 * THE STAND: in the turn the piece spends in the fields, and in the one it spends in the temple, for four bars
 * in the middle (bars 8 to 12 of the sixteen) the pack stops where it is, out in the open, and goes over to
 * the attack; then it goes on. Two of the camera's shots long. (Not in the dock: it goes straight down that.)
 */
export const STAND = { from: 8, to: 12 } as const;

/** Whether bar `bar` is in a stand: 0 or 1. */
export function showStand(follow: string, bar: string): string {
  const within = `mod(${bar}, ${FIELD_BARS})`;
  const turn = `mod(floor(${bar} / ${FIELD_BARS}), ${SHOW_TURNS})`;
  // Of a whole turn: the glimpse of the fields (GLIMPSE) is too short to stop in.
  return `(${follow} * max(${turn} == ${FIELD_TURN}, ${turn} == ${TEMPLE_TURN}) * (${within} >= ${STAND.from}) * (${within} < ${STAND.to}))`;
}
