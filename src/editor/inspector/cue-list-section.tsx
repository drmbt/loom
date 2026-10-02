import { useState } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import {
  CUE_BACK_COMMAND,
  CUE_GO_COMMAND,
  CUE_SET_STANDBY_COMMAND,
  MORPH_CURVES,
  PRESETS_NODE_TYPE,
  nextCueName,
  parseCueList,
  parsePresetBank,
  serializeCueList,
  type Cue,
  type MorphCurve,
} from "@domain/presets/index.ts";
import { Button } from "@ui/primitives/button.tsx";
import { ControlRow } from "@ui/controls/control-row.tsx";
import { EnumField } from "@ui/controls/enum-field.tsx";
import type { EnumOption } from "@ui/controls/enum-field.tsx";
import { TextField } from "@ui/controls/text-field.tsx";
import { refusalMessage, type CommandAnswer } from "./command-refusal.ts";
import type { ParameterEditor } from "./parameter-editor.ts";
import styles from "./inspector.module.css";
import rows from "./preset-sections.module.css";

/**
 * T1501b (§T1398b S6) — THE CUE LIST, ON ITS NODE: the cue table edited as a table, the
 * standby picked from the list, and GO / BACK.
 *
 * ## The table writes the `cues` parameter, one patch per edit
 *
 * The list is the node's `cues` JSON (ruling 1) and stays visible below as the RESULT. A
 * row edit — a name, a bank, a preset, a morph, add, remove, move — rewrites that
 * parameter through the parameter editor as ONE `setParameters`, so each is one undo step
 * and an ordinary audited patch. Nothing is written per keystroke: a name and a morph time
 * commit on Enter or when the field is left.
 *
 * A bank and a preset are PICKED from what the document holds, because a cue that names
 * neither is refused at GO; one that names something since deleted still shows it, marked,
 * rather than silently becoming another. A rename that would collide or leave a name empty
 * is refused here, because the parser would then refuse the whole list.
 *
 * Renaming the cue the list is ON carries `current` / `standby` with it in the same patch —
 * the list is on the same cue under a new name. REMOVING that cue does not: the domain's
 * rule is that a position naming no cue refuses GO rather than guessing (`standbyCue`), and
 * the picker right here is how the operator answers it.
 *
 * ## GO, BACK and the standby are the bus's
 *
 * `cue.go` / `cue.back` on THIS list and `cue.setStandby` — the commands the keys, the
 * Panel's pad and an agent run. A refusal is the command's own sentence.
 */

/** T994's claim: the section presents Standby; every other parameter keeps its row. */
// eslint-disable-next-line react-refresh/only-export-components -- T994: the claim lives WITH the section it mirrors.
export function cueListSectionParameters(): readonly string[] {
  return ["standby"];
}

export interface CueListSectionProps {
  readonly nodeId: NodeId;
  /** The stored `cues`, `current` and `standby` parameters, verbatim, and `wrap` resolved. */
  readonly cues: string;
  readonly current: string;
  readonly standby: string;
  readonly wrap: boolean;
  /** For the bank and preset pickers. */
  readonly graph: Pick<GraphDocument, "nodes">;
  readonly bus: LoomBus;
  readonly context: InvocationContext;
  readonly editor: ParameterEditor;
}

/** Standby empty: GO takes the cue after Current, or the first. */
const IN_ORDER = "";
const NO_CUE = "—";

const CURVE_OPTIONS: readonly EnumOption[] = [
  { value: "linear", label: "Linear" },
  { value: "smooth", label: "Smooth" },
  { value: "in", label: "Ease in" },
  { value: "out", label: "Ease out" },
];

/** The first whole number no cue is named: `1`, `2`, … — a cue's name is its number until it is given one. */
function nextCueNumber(cues: readonly Cue[]): string {
  for (let index = cues.length + 1; ; index += 1) {
    if (!cues.some((cue) => cue.name === String(index))) return String(index);
  }
}

/** The choices of a picker, with the stored value kept — marked — when the document no longer has it. */
function withStored(choices: readonly string[], stored: string): EnumOption[] {
  const options = choices.map((choice) => ({ value: choice, label: choice }));
  return choices.includes(stored) ? options : [{ value: stored, label: `${stored} (missing)` }, ...options];
}

/** A cue's own morph time as its field shows it; blank when the cue carries none. */
const morphText = (cue: Cue): string => (cue.morph === undefined ? "" : String(cue.morph.seconds));

/**
 * A cue's morph time: blank means the cue carries none (the preset's or the bank's applies).
 * A draft, committed on Enter or when the field is left — one patch, not one per key.
 * Mounted under a key of the stored value, so an undo or an agent's edit replaces the draft.
 */
function MorphSeconds({ label, stored, onCommit }: { readonly label: string; readonly stored: string; readonly onCommit: (seconds: number | undefined) => void }) {
  const [draft, setDraft] = useState(stored);
  const commit = (): void => {
    const trimmed = draft.trim();
    const parsed = Number(trimmed);
    if (trimmed === stored) return;
    if (trimmed === "") onCommit(undefined);
    else if (Number.isFinite(parsed) && parsed >= 0) onCommit(parsed);
    else setDraft(stored);
  };
  return (
    <input
      className={rows.number}
      type="number"
      min={0}
      step="0.1"
      placeholder="preset's"
      value={draft}
      aria-label={label}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") commit();
      }}
    />
  );
}

export function CueListSection({ nodeId, cues, current, standby, wrap, graph, bus, context, editor }: CueListSectionProps) {
  const parsed = parseCueList(cues);
  const list = parsed.ok ? parsed.list.cues : [];
  const [problem, setProblem] = useState<string | null>(null);
  const next = parsed.ok ? nextCueName(parsed.list, { current, standby, wrap }) : null;

  /** bank node name → its preset names, for every Presets node the document holds. */
  const banks = new Map<string, readonly string[]>();
  for (const node of Object.values(graph.nodes)) {
    if (node.type !== PRESETS_NODE_TYPE) continue;
    const bank = parsePresetBank(node.parameters["presets"]);
    banks.set(node.label ?? node.id, bank.ok ? bank.bank.presets.map((preset) => preset.name) : []);
  }
  const bankNames = [...banks.keys()].sort((a, b) => a.localeCompare(b));
  const firstUsable = bankNames.find((bank) => (banks.get(bank)?.length ?? 0) > 0);

  /** ONE patch: the list, and — on a rename — the position that named the renamed cue. */
  const write = (nextCues: readonly Cue[], position: Readonly<Record<string, string>> = {}): void => {
    setProblem(null);
    editor.setStored(nodeId, { cues: serializeCueList({ version: 1, cues: nextCues }), ...position }, "commit");
  };
  const replace = (index: number, cue: Cue): void => write(list.map((each, at) => (at === index ? cue : each)));
  const said = (result: CommandAnswer): void => setProblem(refusalMessage(result));

  const rename = (index: number, typed: string): void => {
    const name = typed.trim();
    const cue = list[index];
    if (cue === undefined || name === cue.name) return;
    if (name === "" || list.some((each) => each.name === name)) {
      setProblem(name === "" ? "A cue needs a name." : `Two cues cannot both be named "${name}".`);
      return;
    }
    write(
      list.map((each, at) => (at === index ? { ...each, name } : each)),
      { ...(current === cue.name ? { current: name } : {}), ...(standby === cue.name ? { standby: name } : {}) },
    );
  };

  const move = (index: number, by: -1 | 1): void => {
    const to = index + by;
    const cue = list[index];
    const other = list[to];
    if (cue === undefined || other === undefined) return;
    write(list.map((each, at) => (at === index ? other : at === to ? cue : each)));
  };

  const setBank = (index: number, cue: Cue, bank: string): void => {
    const presets = banks.get(bank) ?? [];
    // The cue keeps its preset when the new bank has one of that name; else it takes the bank's first.
    replace(index, { ...cue, bank, preset: presets.includes(cue.preset) ? cue.preset : (presets[0] ?? cue.preset) });
  };

  const setMorph = (index: number, cue: Cue, seconds: number | undefined, curve: MorphCurve = cue.morph?.curve ?? "smooth"): void => {
    const { morph: _dropped, ...bare } = cue;
    replace(index, seconds === undefined ? bare : { ...bare, morph: { seconds, curve } });
  };

  const addCue = (): void => {
    const last = list[list.length - 1];
    const bank = last !== undefined && banks.has(last.bank) ? last.bank : firstUsable;
    const preset = bank === undefined ? undefined : banks.get(bank)?.[0];
    if (bank === undefined || preset === undefined) return;
    write([...list, { name: nextCueNumber(list), bank, preset }]);
  };

  return (
    <section className={styles.section} aria-label="Cues">
      <div className={styles.sectionHeader}>
        <span>Cues</span>
        <span className={styles.sectionRule} aria-hidden />
      </div>

      <div className={rows.transport}>
        <Button variant="outline" title="Fires the cue before the current one" onClick={() => void bus.execute(CUE_BACK_COMMAND, { nodeId }, context).then(said)}>
          BACK
        </Button>
        <Button variant="outline" title="Fires the standby cue" onClick={() => void bus.execute(CUE_GO_COMMAND, { nodeId }, context).then(said)}>
          GO
        </Button>
        <span className={rows.position} role="status" data-cue-position>
          {current === "" ? NO_CUE : current} ▸ {next ?? NO_CUE}
        </span>
      </div>

      <ControlRow label="Standby" description="The cue GO fires next.">
        <EnumField
          label="Standby"
          value={standby}
          options={[{ value: IN_ORDER, label: "Next in order" }, ...withStored(list.map((cue) => cue.name), standby).filter((option) => option.value !== IN_ORDER)]}
          onChange={(cue) => {
            // "Next in order" is the EMPTY standby, which no cue is named — a plain write, one patch.
            if (cue === IN_ORDER) editor.setParameter(nodeId, "standby", IN_ORDER, "commit");
            else void bus.execute(CUE_SET_STANDBY_COMMAND, { nodeId, cue }, context).then(said);
          }}
        />
      </ControlRow>

      {parsed.ok ? null : (
        <p className={rows.problem} role="alert">
          {parsed.reason}
        </p>
      )}

      <div className={rows.rows}>
        {parsed.ok && list.length === 0 ? <span className={styles.emptyPage}>No cues yet.</span> : null}
        {list.map((cue, index) => (
          <div className={`${rows.cue} ${cue.name === current ? rows.cueLive : ""}`} key={cue.name} data-cue-row={cue.name}>
            <div className={rows.cueHead}>
              <TextField label={`Name of cue ${cue.name}`} value={cue.name} onChange={(typed) => rename(index, typed)} />
              <Button aria-label={`Move cue ${cue.name} up`} title="Earlier in the list" disabled={index === 0} onClick={() => move(index, -1)}>
                ↑
              </Button>
              <Button aria-label={`Move cue ${cue.name} down`} title="Later in the list" disabled={index === list.length - 1} onClick={() => move(index, 1)}>
                ↓
              </Button>
              <Button aria-label={`Remove cue ${cue.name}`} onClick={() => write(list.filter((_each, at) => at !== index))}>
                Remove
              </Button>
            </div>
            <div className={rows.cueDetail}>
              <div className={rows.field}>
                <span className={rows.fieldLabel}>Bank</span>
                <EnumField label={`Bank for cue ${cue.name}`} value={cue.bank} options={withStored(bankNames, cue.bank)} onChange={(bank) => setBank(index, cue, bank)} />
              </div>
              <div className={rows.field}>
                <span className={rows.fieldLabel}>Preset</span>
                <EnumField
                  label={`Preset for cue ${cue.name}`}
                  value={cue.preset}
                  options={withStored(banks.get(cue.bank) ?? [], cue.preset)}
                  onChange={(preset) => replace(index, { ...cue, preset })}
                />
              </div>
              <label className={rows.field}>
                <span className={rows.fieldLabel}>Morph (s)</span>
                <MorphSeconds
                  key={morphText(cue)}
                  label={`Morph seconds for cue ${cue.name}`}
                  stored={morphText(cue)}
                  onCommit={(seconds) => setMorph(index, cue, seconds)}
                />
              </label>
              <div className={rows.field}>
                <span className={rows.fieldLabel}>Curve</span>
                <EnumField
                  label={`Curve for cue ${cue.name}`}
                  value={cue.morph?.curve ?? "smooth"}
                  options={CURVE_OPTIONS}
                  disabled={cue.morph === undefined}
                  onChange={(curve) => {
                    if (cue.morph !== undefined && MORPH_CURVES.includes(curve as MorphCurve)) setMorph(index, cue, cue.morph.seconds, curve as MorphCurve);
                  }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className={rows.footer}>
        <Button variant="outline" disabled={!parsed.ok || firstUsable === undefined} onClick={addCue}>
          Add cue
        </Button>
        {firstUsable === undefined ? <span className={styles.statusHint}>Store a preset in a Presets bank first.</span> : null}
      </div>

      {problem === null ? null : (
        <span className={rows.problem} role="alert">
          {problem}
        </span>
      )}
    </section>
  );
}
