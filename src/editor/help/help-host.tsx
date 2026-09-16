import { useEffect, useState } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { ExpressionScope } from "@domain/expressions/index.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import type { HelpSection } from "./command.ts";
import { registerHelpCommand } from "./command.ts";
import { HelpPanel } from "./help-panel.tsx";

/**
 * Mounts the help panel and answers `ui.openHelp` (T200).
 *
 * The panel's open state is not document state — it produces no patch, makes no undo
 * entry and never reaches a file (§V16) — so it lives here, and the command reaches it
 * through the holder rather than through the store. One of these, once, inside the
 * `KeymapProvider` whose resolved keymap the shortcuts tab reads.
 */

export interface HelpHostProps {
  bus: LoomBus;
  /** The installed catalogue — `registry.list()`. */
  nodes: readonly NodeDefinition[];
  /** The scope a parameter expression sees (§V71). */
  scope?: ExpressionScope;
}

export function HelpHost({ bus, nodes, scope }: HelpHostProps) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<HelpSection>("shortcuts");
  /**
   * T1342b — the search the panel opens with, and it is a REQUEST rather than the panel's
   * state: the panel owns what the box currently says, so typing in it must not be undone
   * by a re-render, and re-opening on the same node must re-apply. A counter makes the
   * second true without the first becoming false.
   */
  const [nodeQuery, setNodeQuery] = useState<{ value: string; nonce: number } | null>(null);

  useEffect(() => {
    const holder = registerHelpCommand(bus);
    const handlers = {
      open(requested: HelpSection | undefined, nodeType: string | undefined): HelpSection {
        // A node type implies the nodes tab: asking for a node and landing on Shortcuts is
        // the shape of path that reads as broken rather than as absent.
        const next = nodeType === undefined ? (requested ?? "shortcuts") : "nodes";
        setSection(next);
        if (nodeType !== undefined) {
          setNodeQuery((previous) => ({ value: nodeType, nonce: (previous?.nonce ?? 0) + 1 }));
        }
        setOpen(true);
        return next;
      },
    };
    holder.current = handlers;
    return () => {
      if (holder.current === handlers) holder.current = null;
    };
  }, [bus]);

  return (
    <HelpPanel
      open={open}
      onOpenChange={setOpen}
      section={section}
      onSectionChange={setSection}
      nodes={nodes}
      {...(nodeQuery === null ? {} : { nodeQuery })}
      {...(scope === undefined ? {} : { scope })}
    />
  );
}
