import type { GraphComponentDefinition, PublishedParameter } from "../types/components.ts";
import type { GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { StoredParameter } from "../types/parameters.ts";
import { isParameterSlot } from "../parameters/slots.ts";
import { PAGE_TARGET, PRESET_CURRENT_KEY, PRESET_MORPHS_KEY } from "./bank-view.ts";
import { parsePresetBank, parsePresetTargets, serializePresetBank, type Preset, type PresetValues } from "./bank.ts";
import { parseMorphRecords, serializeMorphRecords } from "./morph.ts";

/**
 * T1541b — A PAGE BANK, DETACHED (the design doc §1.2 Q7).
 *
 * Detach (`component.detach`) copies a look's internals into the document, and its page bank
 * — whose Targets and values say `parent` — would land as a root bank whose `parent` names
 * nothing: inert. So detach REWRITES it, through the mapping the definition already holds
 * (`definition.parameters`: each published key → the internal `node.key`s it drives):
 *
 *  - Targets `parent` (the whole page) → every published key's internal targets, as
 *    `name.key`; `parent.k` → published `k`'s;
 *  - a preset's `{ parent: { k: v } }` → `v` on each of `k`'s internal targets, by the
 *    copied node's NAME (after detach's own renames);
 *  - the instance's own state comes along: `presetCurrent` → the bank's `current`, and
 *    `presetMorphs` (keyed `parent`) → its `morphs`, rekeyed the same way, so a fade in
 *    flight keeps running on the nodes that now hold it.
 *
 * ## Exact, or not at all
 *
 * Each published value reaches its internal targets verbatim through flattening (§V80), so
 * writing it there directly recalls the same thing — unless the rewrite would have to
 * GUESS. Then nothing is rewritten and `reasons` says why, each by name, for detach to warn
 * with: a published key with no internal target (it exists for `parent.k` reads), a target
 * node with no name to write, a key a preset holds that the page does not publish (a
 * component key such as `tint.r` among them), two published keys driving one internal key,
 * a `bind` value (relative — it would name a different knob one level out), and anything a
 * look's preset reaches only to have it skipped (values for another node, `on`, `recalls`).
 */

export type DetachedPageBank =
  | { readonly ok: true; readonly parameters: Readonly<Record<string, StoredParameter>>; readonly targets: string }
  | { readonly ok: false; readonly reasons: readonly string[] };

export function detachedPageBank(
  definition: Pick<GraphComponentDefinition, "parameters">,
  bank: GraphNode,
  instance: GraphNode,
  /** The copied internal node's name, by its id in the definition; `undefined` when it has none. */
  nameOf: (internalId: NodeId) => string | undefined,
): DetachedPageBank {
  const reasons: string[] = [];
  const published = new Map<string, PublishedParameter>(definition.parameters.map((each) => [each.key, each]));

  /** A published key's internal targets as `[name, key]`, or `null` (with its reason said). */
  const said = new Set<string>();
  const reason = (text: string): void => {
    if (!said.has(text)) reasons.push(text);
    said.add(text);
  };
  const internal = (key: string): Array<readonly [string, string]> | null => {
    const parameter = published.get(key);
    if (parameter === undefined) {
      reason(`"${key}" is not a published parameter of the component`);
      return null;
    }
    if (parameter.targets.length === 0) {
      reason(`published "${key}" drives no internal parameter directly`);
      return null;
    }
    const out: Array<readonly [string, string]> = [];
    for (const target of parameter.targets) {
      const name = nameOf(target.nodeId);
      if (name === undefined) {
        reason(`internal node "${target.nodeId}" (driven by "${key}") has no name to target`);
        return null;
      }
      out.push([name, target.key]);
    }
    return out;
  };
  // Two published keys onto one internal key: which wins is the flattening's order, not a value.
  const drivenBy = new Map<string, string>();
  for (const parameter of definition.parameters) {
    for (const target of parameter.targets) {
      const address = `${target.nodeId}.${target.key}`;
      const other = drivenBy.get(address);
      if (other !== undefined && other !== parameter.key) reason(`"${other}" and "${parameter.key}" both drive "${nameOf(target.nodeId) ?? target.nodeId}.${target.key}"`);
      drivenBy.set(address, parameter.key);
    }
  }

  /** `{ parent: { k: v } }` → `{ name: { key: v } }`, or `null` when it cannot be exact. */
  const rekeyed = (values: PresetValues, who: string): PresetValues | null => {
    const out: Record<string, Record<string, StoredParameter>> = {};
    let exact = true;
    for (const [name, record] of Object.entries(values)) {
      if (name !== PAGE_TARGET) {
        reason(`${who} holds values for "${name}", which a look's preset never reached`);
        exact = false;
        continue;
      }
      for (const [key, value] of Object.entries(record)) {
        if (isParameterSlot(value) && value.mode === "bind") {
          reason(`${who} holds a bind for "${key}", which reads a different knob once detached`);
          exact = false;
          continue;
        }
        const targets = internal(key);
        if (targets === null) {
          exact = false;
          continue;
        }
        for (const [node, internalKey] of targets) (out[node] ??= {})[internalKey] = value;
      }
    }
    return exact ? out : null;
  };

  // Targets.
  const tokens: string[] = [];
  for (const target of parsePresetTargets(bank.parameters["targets"])) {
    const keys = target.key === undefined ? definition.parameters.map((each) => each.key) : [target.key];
    for (const key of keys) {
      for (const [node, internalKey] of internal(key) ?? []) {
        const token = `${node}.${internalKey}`;
        if (!tokens.includes(token)) tokens.push(token);
      }
    }
  }

  // Presets.
  const parsed = parsePresetBank(bank.parameters["presets"]);
  if (!parsed.ok) return { ok: false, reasons: [`its Presets cannot be read (${parsed.reason})`] };
  const presets: Preset[] = [];
  for (const preset of parsed.bank.presets) {
    const who = `preset "${preset.name}"`;
    if (Object.keys(preset.on ?? {}).length > 0) reason(`${who} switches layers inside the look, which its recall skipped`);
    if ((preset.recalls ?? []).length > 0) reason(`${who} recalls other banks from inside the look, which its recall skipped`);
    const values = rekeyed(preset.values, who);
    if (values !== null) presets.push({ name: preset.name, values, ...(preset.morph === undefined ? {} : { morph: preset.morph }) });
  }

  // The instance's own state.
  const records = parseMorphRecords(instance.parameters[PRESET_MORPHS_KEY]);
  const morphs = records.flatMap((record) => {
    const from = rekeyed(record.from, `a running fade to "${record.preset}"`);
    const to = rekeyed(record.to, `a running fade to "${record.preset}"`);
    return from === null || to === null ? [] : [{ ...record, from, to }];
  });
  const current = instance.parameters[PRESET_CURRENT_KEY];

  if (reasons.length > 0) return { ok: false, reasons };
  const targets = tokens.join(" ");
  return {
    ok: true,
    targets,
    parameters: {
      targets,
      presets: serializePresetBank({ version: 1, presets }),
      current: typeof current === "string" ? current : "",
      morphs: serializeMorphRecords(morphs),
    },
  };
}
