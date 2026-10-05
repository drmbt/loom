/**
 * T1561b — THE CAMERA: nine ways of watching a robot in a tunnel, and what picks between them.
 *
 * A shot is where the camera rides relative to the robot (metres ahead, right and up of the
 * tunnel's axis at that distance), its lens, how far ahead of the robot it looks, and how much
 * it rides with the robot when the robot is adrift. The rig is a few statements on one
 * Expression node, so a shot is numbers a person can read on the canvas, and a change of shot
 * is a CUT: the pick is an integer and nothing blends through a wall.
 *
 * Wide ones and close ones (the owner, 2026-10-05: "being right in front of it … over the
 * shoulder, more close ups"); with Cuts on they alternate, a new one every two bars of the
 * track. Off, the Shot slider holds one. Every shot keeps inside the bore and above the deck:
 * the test evaluates these statements.
 */

interface Shot {
  readonly name: string;
  readonly what: string;
  /** Expressions over the rig's inputs: metres ahead of the robot, right and up of the axis. */
  readonly ahead: string;
  readonly right: string;
  readonly up: string;
  /** Field of view, degrees. */
  readonly lens: number;
  /** Metres ahead of the robot's middle that it looks at. */
  readonly aim: number;
  /** 0 to 1: how much the camera itself goes with a robot that is adrift. A close shot must, or it loses it. */
  readonly ride: number;
}

export const SHOT_TABLE: readonly Shot[] = [
  { name: "chase", what: "behind, looking down the tunnel past the robot; the panel's distance and pad trim it", ahead: "(0 - distance)", right: "viewX", up: "viewY", lens: 55, aim: 3.3, ride: 0 },
  { name: "lead", what: "ahead, looking back into the eyes", ahead: "5.5", right: "(0 - 0.9)", up: "0.35", lens: 48, aim: 0.3, ride: 0 },
  { name: "flank", what: "beside it, close and wide: the tentacles pass the lens", ahead: "0.4", right: "2", up: "0.15", lens: 68, aim: 0.3, ride: 0 },
  { name: "post", what: "planted low on the deck at a station ahead; the robot comes, passes and goes", ahead: "(post - value)", right: "1.6", up: "(0 - 1.3)", lens: 40, aim: 0.3, ride: 0 },
  { name: "circle", what: "round the robot inside the bore", ahead: "1.5 * sin(abstime * 0.17)", right: "1.9 * cos(abstime * 0.3)", up: "1.3 * sin(abstime * 0.3)", lens: 60, aim: 0.3, ride: 0.5 },
  { name: "face", what: "right in front of it, backing away: the eyes fill the frame", ahead: "2.7", right: "0.22 * sin(abstime * 0.23)", up: "(0 - 0.12)", lens: 34, aim: 0.7, ride: 0.85 },
  { name: "shoulder", what: "over its shoulder, down the tunnel it is going into", ahead: "(0 - 1.7)", right: "0.8", up: "0.75", lens: 52, aim: 8, ride: 1 },
  { name: "eye", what: "a long lens on the lenses, three-quarter on", ahead: "1.75", right: "0.7", up: "0.3", lens: 24, aim: 0.85, ride: 1 },
  { name: "under", what: "from the deck, looking up at its belly as the tentacles work overhead", ahead: "0.9", right: "0.35", up: "(0 - 1.45)", lens: 64, aim: 0.2, ride: 0.6 },
];

export const SHOTS: readonly string[] = SHOT_TABLE.map((shot) => shot.name);

/** Cutting, the shots come in this stride through the table, so a wide one and a close one take turns. */
const CUT_STRIDE = 4;
if (SHOT_TABLE.length % 2 === 0 || SHOT_TABLE.length % CUT_STRIDE === 0) throw new Error("camera.ts: the cut stride must not share a factor with the number of shots, or some are never cut to.");

/** The shot cut to on the `turn`-th pair of bars. */
export function shotAtTurn(turn: number): number {
  return (((turn * CUT_STRIDE) % SHOT_TABLE.length) + SHOT_TABLE.length) % SHOT_TABLE.length;
}

/** Metres between the stations the post shot plants on. */
const POST_SPACING = 25.6;

const picked = (value: (shot: Shot) => string | number): string => SHOT_TABLE.map((shot, index) => `(pick == ${index}) * ${value(shot)}`).join(" + ");

/**
 * Reads, by wire: `value` (distance travelled), `bar` (the track's bar count), `shot`, `cuts`,
 * `distance`, `viewX`, `viewY` (the panel). Writes `pick`, `ahead`, `right`, `up`, `lens`,
 * `aim`, `ride`, `z`.
 */
export const CAMERA_STATEMENTS = [
  `turn = floor(bar / 2) * ${CUT_STRIDE}`,
  `pick = (cuts > 0.5) * (turn - ${SHOT_TABLE.length} * floor(turn / ${SHOT_TABLE.length})) + (cuts <= 0.5) * floor(shot + 0.5)`,
  `post = (floor(value / ${POST_SPACING}) + 0.5) * ${POST_SPACING}`,
  `ahead = ${picked((shot) => shot.ahead)}`,
  `right = ${picked((shot) => shot.right)}`,
  `up = ${picked((shot) => shot.up)}`,
  `lens = ${picked((shot) => shot.lens)}`,
  `aim = ${picked((shot) => shot.aim)}`,
  `ride = ${picked((shot) => shot.ride)}`,
  `z = value + ahead`,
].join(";\n");

/** What a channel reads before anything is wired or playing: a silent host cuts on the clock instead of the bar. */
export const CAMERA_DEFAULTS = ["bar = floor(abstime / 4)", "value = 0", "shot = 0", "cuts = 0", "distance = 7.5", "viewX = 1.1", "viewY = 0.6"].join(";\n");
