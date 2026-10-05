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

export const JUDGEMENTS: readonly Judgement[] = [
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
