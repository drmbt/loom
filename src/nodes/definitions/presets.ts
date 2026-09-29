import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import { EMPTY_PRESET_BANK_JSON, PRESETS_NODE_TYPE } from "../../domain/presets/bank.ts";

/**
 * T1496b (§T1398b S1, ruling 1) — Presets: a BANK of named parameter snapshots, as a node.
 *
 * Store captures the bank's `targets` (whole nodes, or single `node.key`) as whole stored
 * slots; Recall writes one back as ONE patch — one revision, one undo step, one
 * `preset.recall` audit entry. Both are bus commands (`src/domain/presets/commands.ts`),
 * so the inspector, a Panel, a pulse, an agent and the phone reach the same code.
 *
 * WHY A NODE (the design doc §4.2): the bank's data lives in its PARAMETERS, so undo,
 * autosave, copy/paste, save-as-component, component export and the agent's `get_graph`
 * all carry it with nothing built for them — the MIDI mapping's argument (`midi.ts`).
 * `node.state` would not survive paste and no patch operation writes it.
 *
 * No ports and no passes, like Panel: it reads its targets only when Store or Recall
 * runs, never per frame, so it is not a dependency of anything and prune never keeps it.
 *
 * The morph keys (`morph`, `curve`, `morphs`) arrive with §T1497b; a parameter added with
 * a default needs no migration, exactly as Panel's `remote` did.
 */
export const presetsNode: NodeDefinition = {
  type: PRESETS_NODE_TYPE,
  version: 1,
  title: "Presets",
  category: "value",
  description:
    "A bank of presets: named snapshots of the parameters of the nodes in Targets, stored and recalled whole. Targets lists node names (every parameter of that node — for a component, its published page) or node.key (one parameter), separated by spaces or commas. Store saves them under a name; Recall writes every one back in one step that one undo reverses, expressions and modes included. A target that has since been deleted, or a value that no longer fits, is skipped with a warning naming it; a recall with nothing left to apply is refused. The Recall pulse recalls the preset named in Select, so a MIDI pad, a beat or a Button can fire it. Use one bank per look, per FX chain, or per set of layers.",
  tags: ["preset", "presets", "bank", "snapshot", "recall", "store", "look", "perform", "live", "cue"],
  inputs: [],
  outputs: [],
  parameters: {
    targets: {
      type: "string",
      label: "Targets",
      default: "",
      description:
        "What Store captures: node names (every parameter of that node) or node.key (one parameter), separated by spaces or commas. Names, so a rename or a paste keeps them pointed at the right node.",
    },
    select: {
      type: "string",
      label: "Select",
      default: "",
      description: "The preset the Recall pulse recalls.",
    },
    recall: {
      type: "pulse",
      label: "Recall",
      fires: "preset.recall",
      input: { nodeId: "$node" },
      description: "Recalls the preset named in Select. Drive it with an expression to fire it from a MIDI note, a beat or a Button.",
    },
    current: {
      type: "string",
      label: "Current",
      default: "",
      description: "The preset recalled last. Written by Recall, so Panels and the phone can show which one is live.",
    },
    /*
     * THE BANK IS DOCUMENT STATE, and `code`/`json` for the MIDI mapping's reasons: a Store
     * is an ordinary parameter edit (undo, autosave, the diff and the agent surface for
     * free), and §V458's declared code kind gets it the JSON editor with no UI file
     * knowing this node exists. `src/domain/presets/bank.ts` defines the shape. Last, so
     * its editor sits below the controls (T1052).
     */
    presets: {
      type: "code",
      language: "json",
      label: "Presets",
      default: EMPTY_PRESET_BANK_JSON,
      description:
        "The bank: { version: 1, presets: [{ name, values: { node: { key: value } } }] }. Written by Store; editable by hand. Each value is kept as stored — an expression stays an expression.",
    },
  },
  compile: (): CompiledNodeDescription => ({ passes: [] }),
};
