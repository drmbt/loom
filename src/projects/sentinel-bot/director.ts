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

/** A pack's turn is eight bars: the others take most of two to come up from behind and as long to fall back. */
export const PACK_BARS = 8;

/**
 * How many of the pack are out, 1 or `most`: the leader alone, except for some eight-bar turns (`draw`, two
 * in five of them) in the louder passages, when the rest come up from behind. An event, not a state: while a
 * pack is out it flies, and a piece that flew whenever it was loud never walked (measured on the owner's
 * track with the pack following the intensity itself: 157 of 198 seconds swimming).
 */
export function packSize(follow: string, intensity: string, draw: string, most: number): string {
  return `(1 + ${follow} * ${most - 1} * (${intensity} > 0.6) * (${draw} < 0.4))`;
}

/** What the long view multiplies the pace by: 0.65 at the quietest of the last minute, 1.35 at the loudest. */
export function stride(follow: string, intensity: string): string {
  return `(1 + ${follow} * (${intensity} - 0.5) * 0.7)`;
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

