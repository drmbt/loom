/**
 * THE NAMES A RULE COULD NOT DECIDE (T1593b phase 2a).
 *
 * Each line is one shipped name, the role proposed for it, and one sentence saying why.
 * A role says what the node is FOR in that document (`lag_slam`, not `lag_s`), and it was
 * chosen by reading the example's source and what the node is wired to.
 *
 * `scope` is the file's stem (`E45-Pulse`), `components/<File>` for a starter component's
 * host document, `component <id>@<version>` for a component's own graph, `projects/<name>`
 * for a project, or `*` for every scope that has the name.
 *
 * `role: ""` means the node has no role and is numbered, as auto-naming would.
 *
 * ## This list only holds what is still to be applied
 *
 * A line is removed in the batch that applies it, because a judgement that matches no
 * shipped name is refused as stale (`auditRenameMap`). All seventy, with their reasons, are
 * in the approved record: `docs/node-rename-map-2026-10-05.md`.
 *
 * ## Where the line was drawn
 *
 * A role is decided here when the rules leave one or two characters (`lag_s`, `math_hd`),
 * and then its whole CHAIN is decided with it: three nodes in a row called
 * `math_glitchgain`, `math_gsub`, `lag_genv` is worse than either spelling. A chain with no
 * thin member keeps the author's words (`math_hsub`, `lag_henv` in E54), short as they are.
 * Three-letter roles that are real words or the trade's own (`rim`, `key`, `cyc`, `dof`,
 * `taa`) are not touched.
 */
export interface Judgement {
  readonly scope: string;
  readonly kind: string;
  readonly old: string;
  readonly role: string;
  readonly reason: string;
  /** The proposer could not tell. */
  readonly unsure?: true;
}

const REST = "takes the band's resting level off first, so silence drives exactly zero";

export const JUDGEMENTS: readonly Judgement[] = [
  // ── E45: a shot's letter is its name ───────────────────────────────────────────────────
  { scope: "E45-Pulse", kind: "camera", old: "camA1", role: "A", reason: "shot A's camera: kept, the letter is the shot's name (`render_shotA`)" },
  { scope: "E45-Pulse", kind: "camera", old: "camB1", role: "B", reason: "shot B's camera: kept, as above" },

  // ── E37: a number that only told two kinds apart ───────────────────────────────────────

  // ── E36: left and right ────────────────────────────────────────────────────────────────

  // ── E43 Splice: three drives off the beat ──────────────────────────────────────────────
  { scope: "E43-Splice", kind: "math", old: "gsub1", role: "glitchrest", reason: `the glitch drive: ${REST}` },
  { scope: "E43-Splice", kind: "math", old: "gd1", role: "glitchgain", reason: "the glitch drive's gain (x5.5)" },
  { scope: "E43-Splice", kind: "lag", old: "genv1", role: "glitch", reason: "the envelope on the tear, fast up and slow down; it drives the splice's amount" },
  { scope: "E43-Splice", kind: "math", old: "esub1", role: "echorest", reason: `the echo drive: ${REST}` },
  { scope: "E43-Splice", kind: "math", old: "ed1", role: "echogain", reason: "the echo drive's gain (x1.7)" },
  { scope: "E43-Splice", kind: "lag", old: "lenv1", role: "echo", reason: "the envelope on the echo; it drives the echo's opacity" },
  { scope: "E43-Splice", kind: "lag", old: "slag1", role: "slam", reason: "onsets through a lag, so the letterbox bar decays like a hit" },
  { scope: "E43-Splice", kind: "math", old: "sl1", role: "slamgain", reason: "how far the bar slams (x0.24); it drives the crop's bottom edge" },

  // ── E45 Pulse: high band, low band, the shot, the palette ──────────────────────────────
  { scope: "E45-Pulse", kind: "math", old: "hs1", role: "highrest", reason: `the high band: ${REST}` },
  { scope: "E45-Pulse", kind: "lag", old: "henv1", role: "high", reason: "the one envelope both high-band consumers read" },
  { scope: "E45-Pulse", kind: "math", old: "gth1", role: "glitchthreshold", reason: "a threshold before the gain, so only a strong strike tears" },
  { scope: "E45-Pulse", kind: "math", old: "hd1", role: "glitchgain", reason: "the tear's gain (x8); its id is `hglitch`" },
  { scope: "E45-Pulse", kind: "limit", old: "glim1", role: "glitch", reason: "clamps the tear to 0..1; it drives the splice's amount" },
  { scope: "E45-Pulse", kind: "math", old: "hm1", role: "radiusgain", reason: "the high band into the web's radius (x0.32); its id is `hrad`" },
  { scope: "E45-Pulse", kind: "math", old: "rad1", role: "radius", reason: "adds the web's resting radius (0.12); it drives the proximity radius" },
  { scope: "E45-Pulse", kind: "math", old: "ls1", role: "lowrest", reason: `the low band: ${REST}` },
  { scope: "E45-Pulse", kind: "lag", old: "lenv1", role: "low", reason: "the low band's envelope" },
  { scope: "E45-Pulse", kind: "math", old: "ld1", role: "breath", reason: "the low band into the constellation's breath (x1.4); its id is `lbreath`" },
  { scope: "E45-Pulse", kind: "math", old: "sm1", role: "shotgain", reason: "reshapes the held value so most phrases land on one shot or the other (x12)" },
  { scope: "E45-Pulse", kind: "math", old: "ss1", role: "shotbias", reason: "the second half of that reshape (-5.5)" },
  { scope: "E45-Pulse", kind: "limit", old: "sl1", role: "shot", reason: "clamps it to 0..1: which shot, A or B; `step1` before it and `lag1` after already carry their kind" },
  { scope: "E45-Pulse", kind: "step", old: "pstep1", role: "palette", reason: "a second value held per phrase: the palette's" },
  { scope: "E45-Pulse", kind: "math", old: "pm1", role: "palettegain", reason: "spreads it over the hue swing (x320)" },
  { scope: "E45-Pulse", kind: "math", old: "pal1", role: "palette", reason: "centres the swing (-160); it drives the hue offset" },

  // ── E54 Quorum: the phrase lane and the deposit lane ───────────────────────────────────
  { scope: "E54-Quorum", kind: "step", old: "cstep1", role: "envoy", reason: "the phrase lane: a value held four bars that ends on the kernel's Envoy" },
  { scope: "E54-Quorum", kind: "math", old: "cmul1", role: "envoygain", reason: "the phrase lane's gain (x0.6)" },
  { scope: "E54-Quorum", kind: "math", old: "csub1", role: "envoybias", reason: "the phrase lane's offset (-0.6)" },
  { scope: "E54-Quorum", kind: "limit", old: "clim1", role: "envoy", reason: "the phrase lane's clamp" },
  { scope: "E54-Quorum", kind: "lag", old: "clag1", role: "envoy", reason: "eases the phrase in; it drives Envoy" },
  { scope: "E54-Quorum", kind: "step", old: "dstep1", role: "deposit", reason: "the deposit lane: a value held two bars" },
  { scope: "E54-Quorum", kind: "limit", old: "dlim1", role: "deposit", reason: "the deposit lane's clamp" },
  { scope: "E54-Quorum", kind: "lag", old: "dlag1", role: "deposit", reason: "eases the deposit; it drives how much scent a footfall leaves" },

  // ── E66, E81: bg ───────────────────────────────────────────────────────────────────────
  { scope: "E66-Meter", kind: "solid", old: "bg1", role: "background", reason: "`bg` is background: the backdrop the onsets flash" },
  { scope: "E81-Phone-Desk", kind: "solid", old: "bg1", role: "background", reason: "`bg` is background: the black behind the pinned quad" },

  // ── E75 to E78: the wall of time ───────────────────────────────────────────────────────
  { scope: "*", kind: "timegrid", old: "timewall1", role: "wall", reason: "`time` is already in the kind; E51 calls the same instance `wall`" },

  // ── E79 Crucible: a band's number is not a count ───────────────────────────────────────
  { scope: "E79-Crucible", kind: "range", old: "range380x1", role: "band380", reason: "the 380 Hz band's range; `range380` would read as the 380th" },
  { scope: "E79-Crucible", kind: "range", old: "range1300x1", role: "band1300", reason: "the 1300 Hz band's range" },
  { scope: "E79-Crucible", kind: "range", old: "range3400x1", role: "band3400", reason: "the 3400 Hz band's range" },
  { scope: "E79-Crucible", kind: "tail", old: "tail380x1", role: "band380", reason: "the 380 Hz band's tail" },
  { scope: "E79-Crucible", kind: "tail", old: "tail3400x1", role: "band3400", reason: "the 3400 Hz band's tail" },
  { scope: "E79-Crucible", kind: "beat", old: "beat1300x1", role: "band1300", reason: "the 1300 Hz band's beat" },

  // ── E82 Set List ───────────────────────────────────────────────────────────────────────
  { scope: "E82-Set-List", kind: "presets", old: "fx", role: "fx", reason: "kept: two letters, and the word the set list's own cues and a performer use for this bank" },
  { scope: "E82-Set-List", kind: "layer", old: "layerFx", role: "fx", reason: "kept: the layer that bank works on, beside `layer_grid` and `layer_rings`" },

  // ── on-nothing: `wh` ───────────────────────────────────────────────────────────────────
  { scope: "projects/on-nothing", kind: "mesh", old: "meshwh1", role: "warehouse", reason: "`wh` is the warehouse area in scene-facts" },
  { scope: "projects/on-nothing", kind: "mesh", old: "mesh_wh1", role: "warehouse", reason: "the same node in the shots that spell it with an underscore" },
  { scope: "projects/on-nothing", kind: "geometry", old: "geowh1", role: "warehouse", reason: "`wh` is the warehouse area in scene-facts" },
  { scope: "projects/on-nothing", kind: "geometry", old: "geo_wh1", role: "warehouse", reason: "the same node in the shots that spell it with an underscore" },
];
