import { useState } from "react";
import { cx } from "../cx.ts";
import { EnumField } from "./enum-field.tsx";
import { TextField } from "./text-field.tsx";
import type { ValueListener } from "./types.ts";
import styles from "./controls.module.css";

/**
 * A list of channels, PICKED from what arrives rather than typed — §T1390b.
 *
 * The owner, on the AudioAnalysis component: *"we probably should rather use selects …
 * instead of having this massive list"* — and, ruling on §T1350b's one socket per
 * channel: *"we never want to have an explosion of sockets … the select node should
 * handle the rest"*. So the channel choice lives on a parameter, and this is its control.
 *
 * The stored value is still the Select pattern text (`level low band*`), because that is
 * what `valueSelect` evaluates and what every existing document holds. The control is a
 * different way of WRITING it:
 *
 *  - each pattern is a chip, removable on its own;
 *  - "Add channel…" offers the channels arriving on the declared input right now, minus
 *    the ones already named (§V830: absent, not present-and-refused);
 *  - a pattern that is a name nothing is sending is marked, because a chip that looks
 *    like a working channel and delivers nothing is §V369's silent miss at the control;
 *  - "Edit as text" is the door to the full pattern language (`*`, `?`, `[1-4]`, `^`).
 *    It REPLACES the chips while open rather than sitting beside them: one field, one
 *    control at a time (§T811's two-controls-one-field wart).
 *
 * `available` is empty when nothing is wired or nothing has been published yet. Then no
 * name can be judged missing, so none is marked, and the picker says there is nothing to
 * add rather than offering a guess.
 */

export interface ChannelPickFieldProps {
  label: string;
  /** The stored pattern text, space-separated. */
  value: string;
  /** The channels arriving on the declared input, in publication order. */
  available: readonly string[];
  disabled?: boolean;
  /** §V830: shown, focusable, and not writable — an expression decides the value. */
  readOnly?: boolean;
  id?: string;
  describedBy?: string;
  onChange: ValueListener<string>;
}

/** A token the pattern parser treats as more than a literal name. */
function isChannelPattern(token: string): boolean {
  return token.startsWith("^") || /[*?[\]]/.test(token);
}

/** The tokens of a pattern string, in written order — the same split `valueSelect` makes. */
function channelTokens(value: string): string[] {
  return value.split(/\s+/).filter((token) => token !== "");
}

export function ChannelPickField({
  label,
  value,
  available,
  disabled = false,
  readOnly = false,
  id,
  describedBy,
  onChange,
}: ChannelPickFieldProps) {
  const [asText, setAsText] = useState(false);
  const tokens = channelTokens(value);
  const locked = disabled || readOnly;

  const offered = available.filter((name) => !tokens.includes(name));
  const options = [
    {
      value: "",
      label: available.length === 0 ? "No channels arriving" : offered.length === 0 ? "All channels picked" : "Add channel…",
    },
    ...offered.map((name) => ({ value: name, label: name })),
  ];

  const remove = (token: string): void => {
    onChange(tokens.filter((entry) => entry !== token).join(" "), "commit");
  };

  if (asText) {
    return (
      <div className={styles.reference} data-channel-pick="text">
        <TextField
          label={label}
          value={value}
          disabled={disabled}
          readOnly={readOnly}
          {...(id === undefined ? {} : { id })}
          {...(describedBy === undefined ? {} : { describedBy })}
          onChange={onChange}
        />
        <button type="button" className={cx(styles.channelPickToggle, "nodrag")} onClick={() => setAsText(false)}>
          Done
        </button>
      </div>
    );
  }

  return (
    <div className={styles.reference} data-channel-pick="chips">
      {tokens.length === 0 ? null : (
        <ul className={styles.referenceChips} aria-label={label}>
          {tokens.map((token) => {
            const pattern = isChannelPattern(token);
            const missing = !pattern && available.length > 0 && !available.includes(token);
            return (
              <li
                className={cx(styles.referenceChip, missing && styles.referenceDangling)}
                key={token}
                data-channel-token={token}
                {...(pattern ? { "data-channel-pattern": "true" } : {})}
                {...(missing ? { "data-channel-missing": "true" } : {})}
                title={missing ? `${token}: nothing arriving is called this` : pattern ? `${token}: a pattern` : token}
              >
                <span className={cx(styles.referenceName, pattern && styles.channelPattern)}>{token}</span>
                <button
                  type="button"
                  className={cx(styles.referenceRemove, "nodrag")}
                  aria-label={`Remove ${token} from ${label}`}
                  disabled={locked}
                  onPointerDown={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                  onClick={() => remove(token)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className={styles.referencePick}>
        <EnumField
          label={`Add to ${label}`}
          // Held at the empty option, so the select returns to "Add channel…" after every
          // pick instead of freezing on the last name added.
          value=""
          options={options}
          disabled={locked || offered.length === 0}
          {...(id === undefined ? {} : { id })}
          {...(describedBy === undefined ? {} : { describedBy })}
          onChange={(name, phase) => {
            if (name === "") return;
            // A lone `*` is "everything" — valueSelect's default. Picking one channel out
            // of everything means THAT channel, not everything plus a duplicate of it.
            const kept = tokens.length === 1 && tokens[0] === "*" ? [] : tokens;
            onChange([...kept, name].join(" "), phase);
          }}
        />
        <button
          type="button"
          className={cx(styles.channelPickToggle, "nodrag")}
          disabled={disabled}
          aria-label={`Edit ${label} as text`}
          title="Edit as pattern text"
          onClick={() => setAsText(true)}
        >
          Aa
        </button>
      </div>
    </div>
  );
}
