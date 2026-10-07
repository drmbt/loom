import type { LoomBus } from "@domain/commands/bus.ts";
import { commandHolder } from "@domain/commands/command-holder.ts";
import { z } from "zod";
import { canvasNodeIdsInput } from "@domain/commands/input-schema.ts";

/**
 * Perform windows, as bus commands (§T1391b, §V307).
 *
 * An openable surface is opened by a COMMAND, so a Window Out's window has the same doors
 * as everything else: the inspector's button, the palette, a rebindable key, and an agent.
 * The owner ruled what the key does with nothing selected: every Window Out in the
 * document. With Window Outs among the selection, only those.
 *
 * ## Registered unconditionally
 *
 * §B48: a command registered behind "is there a GPU" is a dead key on a machine without
 * one. These register at mount; with nothing to open they REJECT by name (§V288).
 *
 * ## A popup needs the gesture
 *
 * `window.open` is allowed only inside a user gesture, and nothing is awaited between the
 * key press and the open: the screen list is read ahead of time for exactly this reason.
 * A command run without a gesture (an agent, a timer) is refused by the browser, and says
 * so as `perform.popupBlocked`.
 */

declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /** Open the targets' windows, or close them if every one is already open. */
    "perform.toggle": { input: { nodeIds?: readonly string[] }; output: { open: readonly string[] } };
  }
}

/** What the mounted perform-window owner offers the commands. */
export interface PerformWindows {
  /** False with no GPU device, or outside a browser: there is nothing to present with. */
  available(): boolean;
  /** Window Out node ids in the document, sorted. */
  windowNodes(): readonly string[];
  isOpen(nodeId: string): boolean;
  /** Opens synchronously; returns the ids whose popup the browser refused. */
  open(nodeIds: readonly string[]): readonly string[];
  close(nodeIds: readonly string[]): void;
  openIds(): readonly string[];
}

export function performHolderFor(bus: LoomBus) {
  return commandHolder<PerformWindows>(bus, "perform.toggle");
}

const rejected = (code: string, message: string) => ({ severity: "warning" as const, code, message });

/** Registers `perform.toggle` on `bus`, once. */
export function registerPerformCommands(bus: LoomBus): ReturnType<typeof performHolderFor> {
  const holder = performHolderFor(bus);
  if (!bus.hasCommand("perform.toggle")) {
    bus.registerCommand({
      name: "perform.toggle",
      // T1697b: `app` for now. It takes the id its door sends; whether it is an `instance` command is that task's look.
      inSession: "app",
      inputSchema: z.object({ nodeIds: canvasNodeIdsInput.optional() }).strict(),
      description:
        "Open the perform windows of the selected Window Out nodes (every one when none is selected), or close them if they are all open.",
      handler: (input, context) => {
        const revision = context.store.getRevision();
        const windows = holder.current;
        if (windows === null) {
          return {
            status: "rejected",
            revision,
            diagnostics: [rejected("perform.unavailable", "Perform windows are not available here: the app has not mounted them.")],
            output: { open: [] },
          };
        }
        if (!windows.available()) {
          return {
            status: "rejected",
            revision,
            diagnostics: [rejected("perform.unavailable", "Perform windows need a GPU device, and this session has none.")],
            output: { open: [] },
          };
        }
        const all = windows.windowNodes();
        const asked = input.nodeIds?.filter((id) => all.includes(id)) ?? [];
        const targets = asked.length > 0 ? asked : all;
        if (targets.length === 0) {
          return {
            status: "rejected",
            revision,
            diagnostics: [rejected("perform.noWindowNode", "There is no Window Out node to open. Add one from the library (Output → Window Out).")],
            output: { open: windows.openIds() },
          };
        }
        const closing = targets.every((id) => windows.isOpen(id));
        if (context.dryRun) return { status: "validated", revision, output: { open: windows.openIds() } };
        if (closing) {
          windows.close(targets);
          return { status: "applied", revision, output: { open: windows.openIds() } };
        }
        const blocked = windows.open(targets.filter((id) => !windows.isOpen(id)));
        if (blocked.length > 0) {
          return {
            status: "rejected",
            revision,
            diagnostics: [
              rejected(
                "perform.popupBlocked",
                `The browser blocked the perform window for ${blocked.join(", ")}: opening a window needs a click or a key press, and popups must be allowed for this site.`,
              ),
            ],
            output: { open: windows.openIds() },
          };
        }
        return { status: "applied", revision, output: { open: windows.openIds() } };
      },
      rejectionOutput: () => ({ open: [] }),
    });
  }
  return holder;
}
