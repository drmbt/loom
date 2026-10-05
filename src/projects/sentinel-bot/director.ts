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

/** A number 0 to 1 for the phrase `bar` is in; `salt` gives each use its own draw. */
export function phraseDraw(bar: string, salt: number): string {
  return `fract(sin((floor(${bar} / ${PHRASE_BARS}) + ${salt}) * 12.9898) * 43758.5453)`;
}

/** Whether it swims this phrase for the track's sake: never under 0.7 of intensity, two phrases in three at the top. */
export function phraseSwim(follow: string, intensity: string, draw: string): string {
  return `(${follow} * (${draw} < (${intensity} - 0.7) * 2.2))`;
}

/** Whether it perches this phrase for the track's sake: only under 0.42 of intensity, and then every other phrase. */
export function phrasePerch(follow: string, intensity: string, draw: string): string {
  return `(${follow} * (${intensity} < 0.42) * (${draw} < 0.5))`;
}

/** What the long view multiplies the pace by: 0.65 at the quietest of the last minute, 1.35 at the loudest. */
export function stride(follow: string, intensity: string): string {
  return `(1 + ${follow} * (${intensity} - 0.5) * 0.7)`;
}

