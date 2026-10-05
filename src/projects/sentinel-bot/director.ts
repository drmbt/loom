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
 * Two things follow them:
 *
 *   the robot's pace   slower through a breakdown, a little faster through a loud passage;
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

/**
 * How much it swims because of the track: nothing until the passage is half as loud again as
 * the quietest lately, all of it from 2.2 times. A bar that only pulls back does not reach it.
 */
export function surge(follow: string, lift: string): string {
  return `(${follow} * smoothstep(1.5, 2.2, ${lift}))`;
}
