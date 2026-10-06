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
 * in the approved record: `docs/node-rename-map-2026-10-05.md`. The last batch (the
 * on-nothing project, 2026-10-06) applied the last four, so the list is empty.
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

export const JUDGEMENTS: readonly Judgement[] = [];
