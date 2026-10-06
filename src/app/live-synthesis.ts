import type { ResolvedOutput } from "@compiler/index.ts";

/**
 * T1655b — A SYNTHESIZED PREVIEW DRAWS ITS NODE'S NEWEST VALUES (B176, lost again at T1163).
 *
 * ## What was measured
 *
 * In the real app, with a camera, a light and a material on the canvas: typing a new Eye,
 * Intensity or Roughness into the inspector changed the document and changed NOT ONE PIXEL
 * of that node's own tile. The camera gizmo (T692) was the same failure seen from the other
 * side: the drag wrote the pose, the inspector showed it, and the tile it was dragged on
 * stayed where it was. "What you see move IS the document moving" was false.
 *
 * ## Why
 *
 * A synthesized preview's passes and their uniform values live on the row
 * (`ResolvedOutput.synthesis`), not in the main plan, so the per-edit uniform push to the
 * main program cannot reach them. B176's fix was that a values-only recompile mints a new
 * descriptor and the preview system re-reads its values (`previews/system.ts` compares
 * descriptors by identity for exactly this). T1163 then made the tiles read the INSTALLED
 * plan, and a values-only variation is deliberately never announced as a new install: it
 * would re-render the whole App on every parameter edit (§V16). Both halves are right, and
 * together the fresh descriptor had no way to reach a tile.
 *
 * ## The seam
 *
 * A read, not a render. The frame loop already holds the newest values-only variation of
 * the installed plan; it hands out its rows through a getter, and the preview tick — a
 * rAF loop that re-renders nothing — asks this for the descriptor to draw each tile with.
 *
 * The answer keeps its IDENTITY while the values stand still: the preview system rebuilds
 * its program description when a descriptor's identity moves (T1241), so a fresh object per
 * tick would make every tick a rebuild. It moves exactly when a uniform value did.
 *
 * NOT covered, and it cannot be from here (reported with T1655b): a payload ANIMATED by an
 * expression. The per-frame path splices pass uniforms over the base plan and keeps the
 * base's rows (`frame-compile.ts`: "`outputs` (preview synthesis included) … are the
 * BASE's"), so an expression-driven light's own tile shows the values of the last edit.
 */
type Synthesis = NonNullable<ResolvedOutput["synthesis"]>;

export interface LiveSynthesis {
  /** The descriptor to draw `installed` with: its newest values where the live rows have them. */
  of(installed: ResolvedOutput): ResolvedOutput["synthesis"];
}

/** Everything about a draw except its values. Two descriptors that differ here are not one program. */
const structureOf = (synthesis: Synthesis): string =>
  JSON.stringify(synthesis.passes.map((pass) => ({ ...pass, uniforms: undefined })));

const valuesOf = (synthesis: Synthesis): string => JSON.stringify(synthesis.passes.map((pass) => pass.uniforms ?? null));

export function createLiveSynthesis(read: () => ReadonlyArray<ResolvedOutput> | null): LiveSynthesis {
  let seen: ReadonlyArray<ResolvedOutput> | null = null;
  let live = new Map<string, Synthesis>();
  /** Per row: what was answered for this (installed, live) pair, so a tick with nothing new costs two lookups. */
  const answered = new Map<string, { installed: Synthesis; fresh: Synthesis; answer: Synthesis; values: string }>();

  return {
    of(installed) {
      const base = installed.synthesis;
      if (base === undefined) return undefined;
      const rows = read();
      if (rows === null) return base;
      if (rows !== seen) {
        seen = rows;
        live = new Map();
        for (const row of rows) {
          if (row.synthesis !== undefined) live.set(`${row.nodeId}:${row.portId}`, row.synthesis);
        }
      }
      const key = `${installed.nodeId}:${installed.portId}`;
      const fresh = live.get(key);
      if (fresh === undefined || fresh === base) return base;
      const previous = answered.get(key);
      if (previous !== undefined && previous.installed === base && previous.fresh === fresh) return previous.answer;
      // The installed program was built from `base`. Values may differ; anything else may not.
      if (structureOf(fresh) !== structureOf(base)) return base;
      const values = valuesOf(fresh);
      const answer =
        previous !== undefined && previous.installed === base && previous.values === values
          ? previous.answer
          : values === valuesOf(base)
            ? base
            : fresh;
      answered.set(key, { installed: base, fresh, answer, values });
      return answer;
    },
  };
}
