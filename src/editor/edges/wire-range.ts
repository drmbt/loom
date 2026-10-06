/**
 * How near a wire's tip has to be to a port to connect to it, and how big the things that
 * say so are drawn (T1639b). One number and one rule; the design and the reference's
 * measurements are in docs/wire-snap-design-2026-10-06.md.
 *
 * ## The range is the library's, and this is where it is set
 *
 * React Flow decides what a release connects to: the closest handle within
 * `connectionRadius` of the pointer, then the validity rule. The canvas does not hit-test
 * beside it. The arc is drawn from the library's own answer, so what sparks and what a
 * release does are one fact. A new connection and a reconnect read the same value from the
 * library's store, so they have the same range without either naming it.
 *
 * ## It does not shrink with the canvas
 *
 * `connectionRadius` is in GRAPH units. The library's default of 20 was 7 px on screen at
 * 35 % zoom, where the canvas is mostly used to wire things that are far apart. The rule
 * is the low-zoom kind label's (T1597b): below 100 % the range is the same size on screen
 * at every zoom; above 100 % it grows with the canvas, because there the port it belongs
 * to grows too (at 800 % the dot alone is 56 px wide).
 */

/** The range at 100 % zoom and below, in screen pixels. Above 100 % it is this many graph pixels. */
export const WIRE_RANGE_PX = 48;

/**
 * The library's grab zone on a wire's input end, in graph pixels (`reconnectRadius`).
 *
 * Not the range. It is where a PRESS picks a connected wire's end up, a circle on the
 * wire's last pixels outside the port, and it stays small so it does not take presses
 * meant for the canvas beside every connected port. It is the library's default, named.
 */
export const WIRE_GRAB_RADIUS = 10;

/**
 * Graph units per design pixel at this zoom: 1 at 100 % and above, `1 / zoom` below.
 *
 * Everything the effect draws in graph space (the ring, the arc's thickness and reach, the
 * wire's tip, the snap's bar) is a design size times this, so it holds its size on screen
 * below 100 % and grows with the canvas above. A zoom that is not a positive number (an
 * unlaid-out pane, §V66) reads as 100 %.
 */
export function wireScale(zoom: number): number {
  return zoom > 0 && zoom < 1 ? 1 / zoom : 1;
}

/** The range in graph units, which is what React Flow's `connectionRadius` is measured in. */
export function wireRangeInGraph(zoom: number): number {
  return WIRE_RANGE_PX * wireScale(zoom);
}

/**
 * What the port in range says to the wire in the hand.
 *
 *  - `live`: it takes the wire. The arc is drawn, and a release connects.
 *  - `refused`: it is the right kind of end (an input for a wire held by its output) and
 *    the validity rule says no. A dashed ring, no arc, and a release connects nothing to it.
 *  - `free`: nothing is in range, or what is in range could never be the other end (an
 *    output, for a wire held by its output). Nothing is drawn.
 */
export type WireAnswer = "free" | "live" | "refused";

/** The three facts of React Flow's connection state the answer is read from. */
export interface WireInRange {
  readonly isValid: boolean | null;
  readonly fromHandle: { readonly type: string } | null;
  readonly toHandle: { readonly type: string } | null;
}

/**
 * The ONE reading of "what is in range", for the drawing and for what a release means.
 *
 * `wire-in-flight.tsx` draws from it and the canvas decides a pulled wire's fate from it
 * (let go with nothing answering, the wire comes off; let go on a port that refuses, it
 * goes back). Two readings would be a ring that says one thing and a release that does
 * another.
 */
export function wireAnswer(connection: WireInRange): WireAnswer {
  const { toHandle, fromHandle } = connection;
  if (toHandle === null || fromHandle === null) return "free";
  if (connection.isValid === true) return "live";
  return toHandle.type === fromHandle.type ? "free" : "refused";
}
