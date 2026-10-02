import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import { CUE_BACK_COMMAND, CUE_GO_COMMAND, CUE_LIST_NODE_TYPE, EMPTY_CUE_LIST_JSON } from "../../domain/presets/cue-list.ts";

/**
 * T1500b (§T1398b S5, ruling 15) — Cue List: an ORDERED list of preset recalls, as a node.
 *
 * Each cue names a bank and one of its presets (a shot is just a preset in a shots bank)
 * and may carry its own morph. GO fires the standby cue and the standby advances — the
 * convention of every cue-list tool, so an operator who knows one knows this. BACK fires
 * the previous cue. Both are bus commands (`src/domain/presets/cue-commands.ts`), so the
 * keys, a Panel, a pulse, an agent and the phone reach the same code, and a GO is ONE
 * patch: the recall and the list's `current` / `standby` in one revision and one undo.
 *
 * WHY A NODE, and why its data is PARAMETERS: the bank's argument (`presets.ts`, the
 * design doc §4.2). The list copies, undoes, autosaves, exports and shows up in the
 * agent's `get_graph` with nothing built for it.
 *
 * No ports and no passes, like the bank: it reads its banks only when a cue fires, never
 * per frame, so it is not a dependency of anything and prune never keeps it. It reads no
 * clock (§V44): a cue's morph is the resolver's, on the frame's absolute clock.
 *
 * HOW IT RELATES TO A BANK'S `select` / `recall`: a bank's pulse is random access within
 * one bank — a MIDI pad per preset, stateless. This is stateful sequencing ACROSS banks,
 * with a memory of where you are.
 */
export const cueListNode: NodeDefinition = {
  type: CUE_LIST_NODE_TYPE,
  version: 1,
  title: "Cue List",
  category: "value",
  description:
    "An ordered list of cues for running a set. Each cue names a Presets bank and one of its presets, and can carry its own morph time and an operator's note. GO fires the standby cue — the cue after the current one, or the first — and moves the standby on; BACK fires the previous cue; both recall the preset and move the list in one step that one undo reverses. GO past the last cue is refused unless Wrap is on, and a cue whose bank or preset is gone is refused with the standby left where it is, so the list never claims a cue that did not fire. Drive the GO pulse with an expression to fire it from a MIDI note or a beat, or use the GO and BACK keys. Use one list per set; a bank's own Recall pulse is for jumping straight to one preset.",
  tags: ["cue", "cues", "cue list", "go", "back", "standby", "sequence", "set", "show", "preset", "recall", "perform", "live"],
  inputs: [],
  outputs: [],
  parameters: {
    go: {
      type: "pulse",
      label: "GO",
      fires: CUE_GO_COMMAND,
      input: { nodeId: "$node" },
      description: "Fires the standby cue and moves the standby to the cue after it. Drive it with an expression to fire it from a MIDI note or a beat; it fires once each time the expression turns on.",
    },
    back: {
      type: "pulse",
      label: "BACK",
      fires: CUE_BACK_COMMAND,
      input: { nodeId: "$node" },
      description: "Fires the cue before the current one, with that cue's own morph.",
    },
    standby: {
      type: "string",
      label: "Standby",
      default: "",
      description: "The cue GO fires next. Empty means the cue after Current, or the first cue. Written by GO and BACK; set it to jump.",
    },
    current: {
      type: "string",
      label: "Current",
      default: "",
      description: "The cue that fired last. Empty before the first GO. Written by GO and BACK, so Panels and the phone can show where the set is.",
    },
    wrap: {
      type: "boolean",
      label: "Wrap",
      default: false,
      description: "GO past the last cue goes round to the first. Off, it is refused and the list stays on its last cue.",
    },
    keys: {
      type: "boolean",
      label: "Keys",
      default: true,
      description: "This list answers the GO and BACK keys. With two lists in a project, leave it on for the one you are running: the keys refuse to guess between them.",
    },
    /*
     * THE LIST IS DOCUMENT STATE, and `code`/`json` for the bank's reasons (`presets.ts`):
     * an edit is an ordinary parameter edit (undo, autosave, the diff and the agent surface
     * for free), and §V458's declared code kind gets it the JSON editor with no UI file
     * knowing this node exists. `src/domain/presets/cue-list.ts` defines the shape. Last,
     * so its editor sits below the controls (T1052).
     */
    cues: {
      type: "code",
      language: "json",
      label: "Cues",
      default: EMPTY_CUE_LIST_JSON,
      description:
        "The list, in order: { version: 1, cues: [{ name, bank, preset, morph?: { seconds, curve }, note? }] }. name is the cue's number or label and must be unique; bank is a Presets node's name; morph overrides the preset's and the bank's for this cue.",
    },
  },
  compile: (): CompiledNodeDescription => ({ passes: [] }),
};
