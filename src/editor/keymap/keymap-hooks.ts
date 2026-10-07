import { useCallback, useContext } from "react";
import type {
  CommandInput,
  CommandName,
  CommandResult,
} from "../../domain/types/commands.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import { selectCreatedNodes } from "@editor/selection/select-created.ts";
import type { KeymapContextValue } from "./keymap-context.ts";
import { KeymapReactContext } from "./keymap-context.ts";
import { displayForBinding, displayForCommand } from "./resolve.ts";

/**
 * What a component asks the keymap for (T76). Split out of `keymap-provider.tsx` by
 * T1315b so that file exports only components and Fast Refresh can swap the provider.
 */

export function useKeymap(): KeymapContextValue {
  const value = useContext(KeymapReactContext);
  if (value === null) {
    throw new Error("useKeymap must be used inside a <KeymapProvider>.");
  }
  return value;
}

/** Optional form, for chrome that may render outside a provider (storybook, tests). */
export function useOptionalKeymap(): KeymapContextValue | null {
  return useContext(KeymapReactContext);
}

/**
 * The display string a menu item or tooltip should show (§V55) — never a hardcoded
 * "⌘Z". `null` when the command has no binding, so the caller renders nothing.
 */
export function useCommandKeyDisplay(command: string): string | null {
  const keymap = useOptionalKeymap();
  return keymap === null ? null : displayForCommand(keymap.resolved, command);
}

export function useBindingKeyDisplay(bindingId: string): string | null {
  const keymap = useOptionalKeymap();
  return keymap === null ? null : displayForBinding(keymap.resolved, bindingId);
}

/**
 * Runs a bus command the way a hotkey would — for a toolbar button, menu item or the
 * command palette, so there stays exactly one mutation path (§V29). Resolves to `null`
 * when no track has registered the command yet, instead of throwing.
 */
export function useRunCommand(
  /**
   * §T1696b: the bus to run on, for a surface that read its target from a document of its
   * own (a context menu). Absent: the keymap's, which is the bus of what the canvas shows.
   */
  on?: LoomBus,
): (
  command: string,
  input?: Record<string, unknown>,
) => Promise<CommandResult<CommandName> | null> {
  const keymap = useKeymap();
  const bus = on ?? keymap.bus;
  const invocationContext = keymap.invocationContext;
  return useCallback(
    async (command, input = {}) => {
      if (!bus.hasCommand(command)) return null;
      const result = await bus.execute(
        command as CommandName,
        input as CommandInput<CommandName>,
        invocationContext,
      );
      // "the way a hotkey would" includes this: the canvas menu's "Add node here", and
      // Paste/Duplicate from a menu row or the palette, select what they created exactly
      // as `mod+v` does above (§V78 — one behaviour, not two).
      await selectCreatedNodes(bus, invocationContext, result);
      return result;
    },
    [bus, invocationContext],
  );
}
