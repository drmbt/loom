/**
 * T1561b — THE CAMERA: nineteen ways of watching a robot, or a pack of them, in a tunnel, and what picks between them.
 *
 * A shot is where the camera rides relative to the robot (metres ahead, right and up of the
 * tunnel's axis at that distance), its lens, how far ahead of the robot it looks, and how much
 * it rides with the robot when the robot is adrift. The rig is a few statements on one
 * Expression node, so a shot is numbers a person can read on the canvas, and a change of shot
 * is a CUT: the pick is an integer and nothing blends through a wall.
 *
 * Wide ones and close ones (the owner, 2026-10-05: "being right in front of it … over the
 * shoulder, more close ups"), and six of the TAIL: the tentacles it trails and their lights,
 * close (2026-10-06: "i do love some of the tail light shots when in squid mode … more angles
 * like this to choose from and step through that show the wiggly set of tentacles with its
 * lights in interesting angles closer up").
 *
 * With Cuts on a new shot comes every two bars of the track, from one of two orders: walking,
 * the nine shots of the robot, a wide one and a close one taking turns; swimming, the tail
 * shots with a few of the others between. It cuts when the robot lets go of the wall or takes
 * hold of it, too. Off, the Shot slider holds one, and steps through all fifteen. Every shot
 * keeps inside the bore and above the deck: the test evaluates these statements.
 */

export interface Shot {
  readonly name: string;
  readonly what: string;
  /** Expressions over the rig's inputs: metres ahead of the robot, right and up of the axis. */
  readonly ahead: string;
  readonly right: string;
  readonly up: string;
  /** Field of view, degrees. */
  readonly lens: number;
  /** Metres ahead of the robot's middle that it looks at. Under zero it looks at the tail. */
  readonly aim: number;
  /** 0 to 1: how much the camera itself goes with a robot that is adrift. A close shot must, or it loses it. */
  readonly ride: number;
  /** What the shot is OF: the robot, its tail, or the pack (which is only worth cutting to when more than one is out). */
  readonly subject: "robot" | "tail" | "pack" | "field";
}

export const SHOT_TABLE: readonly Shot[] = [
  { name: "chase", what: "behind, looking down the tunnel past the robot; the panel's distance and pad trim it. Behind the WHOLE pack: it stands back 5.5 m for each one more that is out", ahead: "(0 - distance - (pack - 1) * 5.5)", right: "viewX", up: "viewY", lens: 55, aim: 3.3, ride: 0, subject: "robot" },
  { name: "lead", what: "ahead, looking back into the eyes", ahead: "5.5", right: "(0 - 0.9)", up: "0.35", lens: 48, aim: 0.3, ride: 0, subject: "robot" },
  { name: "flank", what: "beside it, close and wide: the tentacles pass the lens", ahead: "0.4", right: "2", up: "0.15", lens: 68, aim: 0.3, ride: 0, subject: "robot" },
  { name: "post", what: "planted low on the deck at a station ahead; the robot comes, passes and goes", ahead: "(post - value)", right: "1.6", up: "(0 - 1.3)", lens: 40, aim: 0.3, ride: 0, subject: "robot" },
  { name: "circle", what: "round the robot inside the bore", ahead: "1.5 * sin(abstime * 0.17)", right: "1.9 * cos(abstime * 0.3)", up: "1.3 * sin(abstime * 0.3)", lens: 60, aim: 0.3, ride: 0.5, subject: "robot" },
  { name: "face", what: "right in front of it, backing away: the eyes fill the frame", ahead: "2.7", right: "0.22 * sin(abstime * 0.23)", up: "(0 - 0.12)", lens: 34, aim: 0.7, ride: 0.85, subject: "robot" },
  { name: "shoulder", what: "over its shoulder, down the tunnel it is going into", ahead: "(0 - 1.7)", right: "0.8", up: "0.75", lens: 52, aim: 8, ride: 1, subject: "robot" },
  { name: "eye", what: "a long lens on the lenses, three-quarter on", ahead: "1.75", right: "0.7", up: "0.3", lens: 24, aim: 0.85, ride: 1, subject: "robot" },
  { name: "under", what: "from the deck, looking up at its belly as the tentacles work overhead", ahead: "0.9", right: "0.35", up: "(0 - 1.45)", lens: 64, aim: 0.2, ride: 0.6, subject: "robot" },
  // ── The tail: what it trails, and the lights along it ──
  { name: "tail", what: "behind the ends of the tentacles, looking up the bundle to the body", ahead: "(0 - 4.4)", right: "0.5", up: "0.3", lens: 40, aim: -1.4, ride: 1, subject: "tail" },
  { name: "wake", what: "in among the ends, wide: the tentacles stream past the lens toward the body", ahead: "(0 - 3.5)", right: "0.12 * sin(abstime * 0.21)", up: "0.1", lens: 74, aim: 0, ride: 1, subject: "tail" },
  { name: "tailside", what: "close beside the bundle, across it: the lit segments go by", ahead: "(0 - 2.2)", right: "1.05", up: "(0 - 0.2)", lens: 44, aim: -2.1, ride: 1, subject: "tail" },
  { name: "tailtop", what: "over the bundle, looking down it and forward", ahead: "(0 - 3)", right: "0.2", up: "1.2", lens: 50, aim: -1, ride: 1, subject: "tail" },
  { name: "tips", what: "a long lens from well behind: the ends large, the body small beyond them", ahead: "(0 - 6.8)", right: "0.8 * sin(abstime * 0.13)", up: "0.45", lens: 26, aim: -2.6, ride: 1, subject: "tail" },
  { name: "tailround", what: "slowly round the bundle, an arm's length off it", ahead: "(0 - 2.1 + 0.7 * sin(abstime * 0.19))", right: "1.15 * cos(abstime * 0.33)", up: "1.15 * sin(abstime * 0.33)", lens: 48, aim: -2, ride: 1, subject: "tail" },
  // ── The pack: placed for the formation it flies in (document.ts, PACK: an echelon, the second up and out to the
  // leader's right 5.5 m back, the third down and out to its left 11 back), so that all of them are in the frame
  // and more than a body's width apart. Each place was found by a search over the bore with the test's own
  // arithmetic, for the largest robots that stay apart; the test projects the three through each ──
  { name: "packfront", what: "a long lens from ahead, high on the left: three faces, stepped back down the tunnel", ahead: "6", right: "(0 - 0.9 + 0.1 * sin(abstime * 0.17))", up: "1.6", lens: 24, aim: -4, ride: 0.4, subject: "pack" },
  { name: "packquarter", what: "close ahead and above on the left: the leader under the lens, the others strung out behind", ahead: "2", right: "(0 - 1.2)", up: "1.6", lens: 60, aim: -4, ride: 0.4, subject: "pack" },
  { name: "packrear", what: "a long lens from well behind, clear of the last one's tail (it ends 15 m behind the leader): three tails stepped up the tunnel", ahead: "(0 - 19.5)", right: "0.5", up: "0.4", lens: 32, aim: -5.5, ride: 0.3, subject: "pack" },
  { name: "packunder", what: "from low on the right just ahead of them, looking back and up as they come over", ahead: "1", right: "1.5", up: "(0 - 1.3)", lens: 70, aim: -4, ride: 0.3, subject: "pack" },
  // ── The fields (field.ts): no bore to stay inside, so the camera stands off as far as the avenue between the
  // towers lets it (12 m either side of the line) and the place is what the shot is of. The pack is wider
  // apart out here, and each of these holds all three ──
  { name: "fieldwide", what: "far behind and above on the right: the three small in the avenue, the towers going on ahead", ahead: "(0 - 26)", right: "(8 + 0.6 * sin(abstime * 0.11))", up: "6", lens: 62, aim: -2, ride: 0.2, subject: "field" },
  { name: "fieldside", what: "abreast of them from the edge of the avenue: they cross the towers behind", ahead: "(0 - 4)", right: "9.5", up: "(0.8 + 0.5 * sin(abstime * 0.13))", lens: 64, aim: -5, ride: 0.2, subject: "field" },
  { name: "fieldlow", what: "from well below and ahead, looking back and up: they come over against the towers' tops", ahead: "8", right: "(0 - 5)", up: "(0 - 8)", lens: 66, aim: -5, ride: 0.2, subject: "field" },
  { name: "fieldhigh", what: "from high behind, looking down past them into the dark the towers come up out of", ahead: "(0 - 23)", right: "(0 - 4)", up: "12", lens: 58, aim: -5.5, ride: 0.2, subject: "field" },
];

export const SHOTS: readonly string[] = SHOT_TABLE.map((shot) => shot.name);

const index = (name: string): number => {
  const at = SHOT_TABLE.findIndex((shot) => shot.name === name);
  if (at < 0) throw new Error(`camera.ts: no shot "${name}".`);
  return at;
};

/** The order shots are cut to while it walks: the nine of the robot, a wide one and a close one taking turns. */
export const WALKING_ORDER: readonly number[] = ["chase", "circle", "under", "post", "eye", "flank", "shoulder", "lead", "face"].map(index);
/** …and while it swims: every tail shot, with four of the others between so the tail is not all there is. */
export const SWIMMING_ORDER: readonly number[] = ["tail", "chase", "tailside", "tips", "lead", "wake", "circle", "tailtop", "tailround", "flank"].map(index);
/** …and while more than one of the pack is out: the four shots of the pack, with the tail and the chase between. */
export const PACK_ORDER: readonly number[] = ["packfront", "tail", "packquarter", "chase", "packrear", "tips", "packunder", "wake"].map(index);

/** The shot cut to on the `turn`-th pair of bars. */
/** …and in the fields: the place's own four between shots of the tails and the long chase, never two of a kind running. */
export const FIELD_ORDER: readonly number[] = ["fieldwide", "tail", "fieldside", "chase", "fieldlow", "tips", "fieldhigh", "wake"].map(index);

export function shotAtTurn(turn: number, swimming = false, pack = false, field = false): number {
  const order = field ? FIELD_ORDER : pack ? PACK_ORDER : swimming ? SWIMMING_ORDER : WALKING_ORDER;
  return order[((turn % order.length) + order.length) % order.length] as number;
}

/** Metres between the stations the post shot plants on. */
const POST_SPACING = 25.6;

const picked = (value: (shot: Shot) => string | number): string => SHOT_TABLE.map((shot, at) => `(pick == ${at}) * ${value(shot)}`).join(" + ");
/** Entry `place` of an order, as an expression: there is no table to look up in, so it is a sum with one live term. */
const ordered = (order: readonly number[], place: string): string => `(${order.map((shot, at) => `(${place} == ${at}) * ${shot}`).join(" + ")})`;
const turnIn = (order: readonly number[]): string => `(turn - ${order.length} * floor(turn / ${order.length}))`;

/**
 * Reads, by wire: `value` (distance travelled), `bar` (the track's bar count), `swim` (how
 * much it is swimming), `pack` (how many are out), `shot`, `cuts`, `distance`, `viewX`,
 * `viewY` (the panel), `place` (0 the tunnel, 1 the fields). Writes
 * `pick`, `ahead`, `right`, `up`, `lens`, `aim`, `ride`, `z`.
 */
export const CAMERA_STATEMENTS = [
  `turn = floor(bar / 2)`,
  `packed = (pack > 1.5)`,
  `fielded = (place > 0.5)`,
  `cut = fielded * ${ordered(FIELD_ORDER, turnIn(FIELD_ORDER))} + (1 - fielded) * (packed * ${ordered(PACK_ORDER, turnIn(PACK_ORDER))} + (1 - packed) * ((swim > 0.5) * ${ordered(SWIMMING_ORDER, turnIn(SWIMMING_ORDER))} + (swim <= 0.5) * ${ordered(WALKING_ORDER, turnIn(WALKING_ORDER))}))`,
  `pick = (cuts > 0.5) * cut + (cuts <= 0.5) * floor(shot + 0.5)`,
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
export const CAMERA_DEFAULTS = ["bar = floor(abstime / 4)", "value = 0", "swim = 0", "pack = 1", "shot = 0", "cuts = 0", "distance = 7.5", "viewX = 1.1", "viewY = 0.6", "place = 0"].join(";\n");
