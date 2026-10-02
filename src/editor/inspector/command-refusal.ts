/**
 * T1501b — what a section says when the bus REFUSES one of its buttons.
 *
 * A refused command carries its diagnostics in order, and the refusal itself is the ERROR:
 * a recall with nothing left to apply lists a warning per skipped target first, and "no
 * node is named blur1" on its own does not say the recall did not happen. The bank's and
 * the cue list's sections both show this one sentence, so it is picked in one place.
 */
export interface CommandAnswer {
  readonly status: string;
  readonly diagnostics: ReadonlyArray<{ readonly severity: string; readonly message: string }>;
}

/** The sentence a refused command is shown as, or `null` when it was not refused. */
export function refusalMessage(result: CommandAnswer): string | null {
  if (result.status !== "rejected") return null;
  const why = result.diagnostics.find((entry) => entry.severity === "error") ?? result.diagnostics[0];
  return why?.message ?? "Refused";
}
