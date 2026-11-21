import type { LoomBus } from "@domain/commands/bus.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { sharedForBus } from "@domain/commands/command-holder.ts";
import { idInput } from "@domain/commands/input-schema.ts";
import { parsePresetBank } from "@domain/presets/bank.ts";
import { z } from "zod";

/**
 * VN152 (upstream §T1648b) — `ui.beginPresetRename`: the ONE way a preset button's name
 * editor opens, `ui.beginRename`'s shape for a preset (`src/editor/nodes/rename-session.ts`,
 * T415, §V307, §V342).
 *
 * `preset.rename` is the rename: one patch, one undo group, the cues and shots that name the
 * preset rewritten with it. What a menu row cannot do is COLLECT a name, so the row names this
 * command, which puts the button on the bank's strip into edit mode; the field is what runs
 * `preset.rename` with what was typed (Enter), or closes having run nothing (Escape, blur).
 *
 * Which button is an input box is not document state — no patch, no undo, nothing in the
 * `.loom.json` — so it lives beside its surface, registered where the strip mounts.
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    "ui.beginPresetRename": {
      input: { nodeId: NodeId; name: string };
      output: { editing: PresetRenameSession | null };
    };
  }
}

export const BEGIN_PRESET_RENAME_COMMAND = "ui.beginPresetRename";

/** The preset whose button is being renamed: its bank and its name. */
export interface PresetRenameSession {
  readonly nodeId: NodeId;
  readonly name: string;
}

export interface PresetRenameSessionStore {
  /** The preset being renamed, or `null`. At most one, ever. */
  get(): PresetRenameSession | null;
  begin(session: PresetRenameSession): void;
  /** Ends the session, but only if `session` still owns it — a stale blur closes nothing. */
  end(session: PresetRenameSession): void;
  subscribe(listener: () => void): () => void;
}

const same = (a: PresetRenameSession | null, b: PresetRenameSession): boolean => a !== null && a.nodeId === b.nodeId && a.name === b.name;

/** Not exported: `presetRenameSessionStoreFor` is the one way to it, keyed by bus. */
function createPresetRenameSessionStore(): PresetRenameSessionStore {
  let editing: PresetRenameSession | null = null;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => editing,
    begin: (session) => {
      if (same(editing, session)) return;
      editing = { nodeId: session.nodeId, name: session.name };
      notify();
    },
    end: (session) => {
      if (!same(editing, session)) return;
      editing = null;
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * One store per bus — STATE HELD: which preset button is being renamed and who is watching.
 * The Controls tab and a Panel's canvas body draw the same strip, so they agree on it.
 */
export function presetRenameSessionStoreFor(bus: LoomBus): PresetRenameSessionStore {
  return sharedForBus<PresetRenameSessionStore>(bus, BEGIN_PRESET_RENAME_COMMAND, createPresetRenameSessionStore);
}

/** Idempotent: the bus has no unregister, and React mounts more than once. */
export function registerPresetRenameSessionCommand(bus: LoomBus): PresetRenameSessionStore {
  const store = presetRenameSessionStoreFor(bus);
  if (bus.hasCommand(BEGIN_PRESET_RENAME_COMMAND)) return store;

  bus.registerCommand({
    name: BEGIN_PRESET_RENAME_COMMAND,
    inSession: "app",
    inputSchema: z.object({ nodeId: idInput, name: z.string().min(1) }).strict(),
    description: "Edit a preset's name in place, on its button on the bank's strip (VN152, §T1648b).",
    handler: (input, context) => {
      const revision = context.store.getRevision();
      const node = context.store.getGraph().nodes[input.nodeId];
      const parsed = node === undefined ? null : parsePresetBank(node.parameters["presets"]);
      const holds = parsed !== null && parsed.ok && parsed.bank.presets.some((preset) => preset.name === input.name);
      // Named, not silent: an editor opened on a button that is not there edits nothing (§V288).
      if (!holds) {
        return {
          status: "rejected" as const,
          revision,
          diagnostics: [{ severity: "warning" as const, code: "presetRename.unknown", message: `There is no preset "${input.name}" on "${input.nodeId}" to rename.` }],
          output: { editing: store.get() },
        };
      }
      const session = { nodeId: input.nodeId, name: input.name };
      // §V36 — a dry run answers what WOULD happen and opens nothing.
      if (context.dryRun) return { status: "validated" as const, revision, output: { editing: session } };
      store.begin(session);
      return { status: "applied" as const, revision, output: { editing: session } };
    },
    rejectionOutput: () => ({ editing: store.get() }),
  });

  return store;
}
