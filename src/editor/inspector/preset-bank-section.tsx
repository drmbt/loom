import { useState } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { PRESET_DELETE_COMMAND } from "@domain/presets/delete-command.ts";
import { PRESET_RECALL_COMMAND, PRESET_STORE_COMMAND, isPresetName, parsePresetBank, parsePresetTargets } from "@domain/presets/index.ts";
import { Button } from "@ui/primitives/button.tsx";
import { ControlRow } from "@ui/controls/control-row.tsx";
import { EnumField } from "@ui/controls/enum-field.tsx";
import { TextField } from "@ui/controls/text-field.tsx";
import { refusalMessage, type CommandAnswer } from "./command-refusal.ts";
import type { ParameterEditor } from "./parameter-editor.ts";
import styles from "./inspector.module.css";
import rows from "./preset-sections.module.css";

/**
 * T1501b (§T1398b S6) — THE BANK, ON ITS NODE: Store, Recall and Delete without
 * hand-writing the Presets JSON.
 *
 * The bank's data is its `presets` parameter (ruling 1) and stays visible below as the
 * RESULT these controls write — the MIDI section's arrangement, for its reason. Nothing
 * here edits that text: each button runs the bus command the Panel's strip, the pulse and
 * an agent run (`preset.store`, `preset.recall`, `preset.delete`), so a Store from here is
 * the same one patch, one undo step and one audit entry as from anywhere else, and a
 * refusal is the command's own sentence, shown here until the next press.
 *
 * Targets is the one parameter this section PRESENTS (its claim, T994): the same text
 * field, plus a picker that appends a node by name — the list of what Store captures is
 * built by choosing nodes, not by remembering how they are spelled.
 */

/** T994's claim: the section presents Targets; every other parameter keeps its row. */
// eslint-disable-next-line react-refresh/only-export-components -- T994: the claim lives WITH the section it mirrors.
export function presetBankSectionParameters(): readonly string[] {
  return ["targets"];
}

export interface PresetBankSectionProps {
  readonly nodeId: NodeId;
  /** The stored `targets`, `presets` and `current` parameters, verbatim. */
  readonly targets: string;
  readonly presets: string;
  readonly current: string;
  /** For the target picker: the nodes there are to name. */
  readonly graph: Pick<GraphDocument, "nodes">;
  readonly bus: LoomBus;
  readonly context: InvocationContext;
  readonly editor: ParameterEditor;
}

/** `preset1`, `preset2`, … — the first the bank does not hold, so Store never overwrites by default. */
function nextPresetName(taken: readonly string[]): string {
  for (let index = taken.length + 1; ; index += 1) {
    const candidate = `preset${String(index)}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

const NO_PICK = "";

export function PresetBankSection({ nodeId, targets, presets, current, graph, bus, context, editor }: PresetBankSectionProps) {
  const parsed = parsePresetBank(presets);
  const names = parsed.ok ? parsed.bank.presets.map((preset) => preset.name) : [];
  // `null`: the field shows the next free name; typing replaces it until the next Store.
  const [typed, setTyped] = useState<string | null>(null);
  const [said, setSaid] = useState<{ readonly text: string; readonly error: boolean } | null>(null);
  const name = typed ?? nextPresetName(names);
  const overwrites = names.includes(name);

  const refused = (result: CommandAnswer): boolean => {
    const message = refusalMessage(result);
    setSaid(message === null ? null : { text: message, error: true });
    return message !== null;
  };

  const store = (): void => {
    void bus.execute(PRESET_STORE_COMMAND, { nodeId, name }, context).then((result) => {
      if (refused(result)) return;
      setTyped(null);
      // A target Store could not capture is said, not swallowed: the preset is short of it.
      const { missing } = result.output;
      if (missing.length > 0) setSaid({ text: `Stored without ${missing.join(", ")}`, error: false });
    });
  };

  // T1527b: a delete that leaves a cue or a shot naming the preset is applied, and says which.
  const remove = (preset: string): void => {
    void bus.execute(PRESET_DELETE_COMMAND, { nodeId, name: preset }, context).then((result) => {
      if (refused(result)) return;
      const warnings = result.diagnostics.filter((entry) => entry.severity === "warning").map((entry) => entry.message);
      if (warnings.length > 0) setSaid({ text: warnings.join(" "), error: false });
    });
  };

  const listed = new Set(parsePresetTargets(targets).filter((target) => target.key === undefined).map((target) => target.node));
  const candidates = Object.values(graph.nodes)
    .filter((node) => node.id !== nodeId)
    .map((node) => node.label ?? node.id)
    .filter((candidate) => !listed.has(candidate))
    .sort((a, b) => a.localeCompare(b));

  return (
    <section className={styles.section} aria-label="Presets bank">
      <div className={styles.sectionHeader}>
        <span>Presets</span>
        <span className={styles.sectionRule} aria-hidden />
      </div>

      <ControlRow label="Targets" description="What Store captures: node names, or node.key for one parameter.">
        <TextField label="Targets" value={targets} onChange={(value, phase) => editor.setParameter(nodeId, "targets", value, phase)} />
      </ControlRow>
      <ControlRow label="Add target">
        <EnumField
          label="Add target"
          value={NO_PICK}
          options={[{ value: NO_PICK, label: candidates.length === 0 ? "No other node" : "Pick a node…" }, ...candidates.map((candidate) => ({ value: candidate, label: candidate }))]}
          disabled={candidates.length === 0}
          onChange={(picked) => {
            if (picked !== NO_PICK) editor.setParameter(nodeId, "targets", targets.trim() === "" ? picked : `${targets.trim()} ${picked}`, "commit");
          }}
        />
      </ControlRow>

      {parsed.ok ? null : (
        <p className={rows.problem} role="alert">
          {parsed.reason}
        </p>
      )}

      <div className={rows.rows}>
        {parsed.ok && names.length === 0 ? <span className={styles.emptyPage}>No presets stored yet.</span> : null}
        {names.map((preset) => (
          <div className={rows.preset} key={preset} data-preset-row={preset}>
            <span className={rows.name}>{preset}</span>
            <span className={rows.live}>{current === preset ? "live" : ""}</span>
            <Button variant="outline" aria-label={`Recall ${preset}`} onClick={() => void bus.execute(PRESET_RECALL_COMMAND, { nodeId, name: preset }, context).then(refused)}>
              Recall
            </Button>
            <Button aria-label={`Delete ${preset}`} onClick={() => remove(preset)}>
              Delete
            </Button>
          </div>
        ))}
      </div>

      <div className={rows.action}>
        <TextField label="Preset name" value={name} onChange={(value) => setTyped(value.trim())} />
        <Button variant="outline" disabled={!isPresetName(name)} title={overwrites ? "Stores the targets over this preset" : "Stores the targets under this name"} onClick={store}>
          {overwrites ? "Store over" : "Store"}
        </Button>
      </div>
      {isPresetName(name) ? null : <span className={styles.statusHint}>A preset name is letters, digits and _, not starting with a digit.</span>}

      {said === null ? null : (
        <span className={said.error ? rows.problem : styles.statusHint} role={said.error ? "alert" : "status"}>
          {said.text}
        </span>
      )}
    </section>
  );
}
