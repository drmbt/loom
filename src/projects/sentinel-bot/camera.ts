/**
 * T1561b — THE CAMERA: five ways of watching a robot in a tunnel, and what picks between them.
 *
 * A shot is where the camera rides relative to the robot (metres ahead, right and up of the
 * tunnel's axis at that distance) and its lens. The rig is a few statements on one Expression
 * node, so a shot is numbers a person can read on the canvas, and a change of shot is a CUT:
 * the pick is an integer and nothing blends through a wall.
 *
 *   0 chase   behind, looking down the tunnel past the robot; the panel's distance and pad trim it
 *   1 lead    ahead, looking back into the eyes
 *   2 flank   beside it, close and wide: the tentacles pass the lens
 *   3 post    planted low on the deck at a station ahead; the robot comes, passes and goes
 *   4 circle  round the robot inside the bore
 *
 * With Cuts on, the shot changes every two bars of the track; off, the Shot slider holds one.
 * Every shot keeps inside the bore and above the deck: the test evaluates these statements.
 */

export const SHOTS = ["chase", "lead", "flank", "post", "circle"] as const;

/** Metres between the stations the post shot plants on. */
const POST_SPACING = 25.6;

/**
 * Reads, by wire: `value` (distance travelled), `bar` (the track's bar count), `shot`, `cuts`,
 * `distance`, `viewX`, `viewY` (the panel). Writes `pick`, `ahead`, `right`, `up`, `lens`, `z`.
 */
export const CAMERA_STATEMENTS = [
  `turn = floor(bar / 2)`,
  `pick = (cuts > 0.5) * (turn - ${SHOTS.length} * floor(turn / ${SHOTS.length})) + (cuts <= 0.5) * floor(shot + 0.5)`,
  `post = (floor(value / ${POST_SPACING}) + 0.5) * ${POST_SPACING}`,
  `ahead = (pick == 0) * (0 - distance) + (pick == 1) * 5.5 + (pick == 2) * 0.4 + (pick == 3) * (post - value) + (pick == 4) * 1.5 * sin(abstime * 0.17)`,
  `right = (pick == 0) * viewX + (pick == 1) * (0 - 0.9) + (pick == 2) * 2 + (pick == 3) * 1.6 + (pick == 4) * 1.9 * cos(abstime * 0.3)`,
  `up = (pick == 0) * viewY + (pick == 1) * 0.35 + (pick == 2) * 0.15 + (pick == 3) * (0 - 1.3) + (pick == 4) * 1.3 * sin(abstime * 0.3)`,
  `lens = (pick == 0) * 55 + (pick == 1) * 48 + (pick == 2) * 68 + (pick == 3) * 40 + (pick == 4) * 60`,
  `z = value + ahead`,
].join(";\n");

/** What a channel reads before anything is wired or playing: a silent host cuts on the clock instead of the bar. */
export const CAMERA_DEFAULTS = ["bar = floor(abstime / 4)", "value = 0", "shot = 0", "cuts = 0", "distance = 7.5", "viewX = 1.1", "viewY = 0.6"].join(";\n");
