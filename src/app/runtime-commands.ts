import { useEffect, useRef } from "react";

import type { LoomBus } from "@domain/commands/bus.ts";
import type { CompiledGraph } from "../compiler/types.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { z } from "zod";
import { nodeIdsInput } from "@domain/commands/input-schema.ts";

/**
 * `runtime.resetFeedback`, REGISTERED (T292's enumeration found it missing — the
 * fourth instance of built-but-unwired, this time a command both the keymap and the
 * `reset_feedback` tool already reference).
 *
 * It waited, correctly, for per-resource reset granularity (T215): a whole-backend
 * clear was the wrong blast radius for "pulse THIS feedback loop" (§V126). Now:
 * `{nodeId?}` clears that node's pair — resolved through the CURRENT plan's feedback
 * table — or every pair when unscoped. The backend refuses unknown ids loudly; this
 * handler resolves honestly and reports how many pairs it addressed.
 */

declare module "@domain/types/commands.ts" {
  interface CommandMap {
    "runtime.resetFeedback": {
      input: { nodeIds?: readonly string[] };
      output: { cleared: number };
    };
  }
}

/**
 * The input `runtime.resetFeedback` takes (T1556b). `nodeIds` are node ADDRESSES
 * (`nodeIdsInput`): fired inside a component session they are rewritten onto the instance
 * in view, which is the whole of what VNB6's hand-written forward did (§T1695b).
 */
export const RESET_FEEDBACK_INPUT = z.object({ nodeIds: nodeIdsInput.optional() }).strict();

/**
 * T597: the registration as a PURE function, so the headless MCP server registers the
 * SAME command from the same body (§V39) — the hook below wraps it with refs.
 */
export function registerResetFeedbackCommand(
  bus: LoomBus,
  sources: {
    backend: () => LoomBackend | undefined;
    compiled: () => CompiledGraph | null;
  },
): void {
  // T531 (§V467): ask the BUS, not a ref — the guard is scoped to the thing being
  // registered INTO, so a second mount (or the headless server) cannot double-register.
  if (bus.hasCommand("runtime.resetFeedback")) return;
  bus.registerCommand({
      name: "runtime.resetFeedback",
      inSession: "instance",
      inputSchema: RESET_FEEDBACK_INPUT,
      description: "Clear temporal (feedback) history — one node's pair, or all of them.",
      handler: (input, context) => {
        const backend = sources.backend();
        const feedback = sources.compiled()?.feedback ?? [];
        if (backend === undefined) {
          return {
            status: "rejected",
            output: { cleared: 0 },
            diagnostics: [
              {
                severity: "error",
                code: "runtime.noBackend",
                message: "No GPU backend is attached; there is no feedback history to clear.",
              },
            ],
          };
        }
        const scoped = input.nodeIds !== undefined;
        const wanted = new Set(input.nodeIds ?? []);
        const pairs = scoped ? feedback.filter((pair) => wanted.has(pair.nodeId)) : [...feedback];
        // T237: a Cache's history lives in a `ring` resource, which is not a feedback
        // PAIR and so is not in that table. Resolved from the plan's resources instead,
        // by the scratch id's own `scratch:<nodeId>:<key>` shape — without this the
        // node's reset pulse would be a button that lies (§V123), which is exactly the
        // reason the other stateful nodes are listed as gaps rather than given one.
        const rings = (sources.compiled()?.resources ?? []).filter(
          (resource): resource is typeof resource & { kind: "ring" } => resource.kind === "ring",
        );
        const ringIds = rings
          .filter((resource) => !scoped || wanted.has(resource.id.split(":")[1] ?? ""))
          .map((resource) => resource.id);
        if (scoped && pairs.length === 0 && ringIds.length === 0) {
          return {
            status: "rejected",
            output: { cleared: 0 },
            diagnostics: [
              {
                severity: "error",
                code: "runtime.noFeedback",
                message: `None of ${[...wanted].sort().join(", ")} holds temporal history in the current plan.`,
              },
            ],
          };
        }
        const cleared = pairs.length + (scoped ? ringIds.length : rings.length);
        // §V36 (§B288): a dry run says what WOULD be cleared. A reset has no rollback.
        if (context.dryRun) return { status: "validated", output: { cleared }, diagnostics: [] };
        backend.resetTemporalHistory(
          scoped ? [...pairs.map((pair) => pair.resourceId), ...ringIds] : undefined,
        );
        return { status: "applied", output: { cleared }, diagnostics: [] };
      },
      rejectionOutput: () => ({ cleared: 0 }),
    });
}

/*
 * VNB6 (pull request #1) registered a forward of this command on every component session
 * bus, because a Reset pulse inside a component refused with "which no track has
 * registered". §T1695b replaced it with the rule it was the first case of: the command is
 * declared `instance` above, a session bus inherits it from the project's bus, and its
 * node addresses are rewritten onto the instance the editor is viewing by the bus itself
 * (`src/domain/commands/bus.ts`, `src/domain/components/addressing.ts`). The contributor's
 * test stands as written (`component-editing.test.tsx`, "a Reset pulse inside a component
 * clears ITS instance's history").
 */

export function useRuntimeCommands(inputs: {
  bus: LoomBus;
  backend: LoomBackend | undefined;
  compiled: CompiledGraph | null;
}): void {
  const backendRef = useRef(inputs.backend);
  backendRef.current = inputs.backend;
  const compiledRef = useRef(inputs.compiled);
  compiledRef.current = inputs.compiled;

  useEffect(() => {
    registerResetFeedbackCommand(inputs.bus, {
      backend: () => backendRef.current,
      compiled: () => compiledRef.current,
    });
  }, [inputs.bus]);
}
