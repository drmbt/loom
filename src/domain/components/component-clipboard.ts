import type { GraphComponentDefinition } from "../types/components.ts";
import type { ComponentId } from "../types/ids.ts";
import type { ClipboardArrival, ClipboardComponents } from "../commands/loom-clipboard.ts";
import { orderDeepestFirst, planComponentImport, type ComponentRef } from "./component-file.ts";
import { componentNodeType, parseComponentNodeType } from "./component-type.ts";
import { importPlanProblems, installDefinitions } from "./file-commands.ts";
import type { ComponentRegistry } from "./registry.ts";
import { parseComponentDefinition } from "./schemas.ts";

/**
 * A COMPONENT CROSSING DOCUMENTS ON THE CLIPBOARD (T1493b) — the second carrier, beside the
 * file (`component-file.ts`), and deliberately nothing new: the copy carries the same
 * definitions an export writes (the instanced component and everything it nests), and the
 * paste installs them through the same plan, the same checks and the same registration a
 * dropped file goes through. One identity rule (owner ruling 2026-09-29, §T1395b): same
 * id + version + content is the SAME component and is reused; an id taken by a different
 * component is renamed (`bloom` → `bloom1`) and the pasted instances point at the new one.
 */

const refKey = (reference: ComponentRef): string => `${reference.componentId}@${reference.version}`;

/** Carried nothing this build can use: every instance is checked against the document alone. */
const NOTHING_CARRIED: ClipboardArrival = { types: new Map(), install: () => () => undefined };

export interface ComponentClipboardOptions {
  components: ComponentRegistry;
  /** The component being edited, when the bus is a component session's (§V83). */
  host: { componentId: ComponentId; version: number } | null;
}

export function componentClipboard(options: ComponentClipboardOptions): ClipboardComponents {
  const { components, host } = options;

  /** The definitions the instance `types` name, once each, from `lookup`. */
  const rootsOf = (
    types: readonly string[],
    lookup: (reference: ComponentRef) => GraphComponentDefinition | undefined,
  ): GraphComponentDefinition[] => {
    const roots = new Map<string, GraphComponentDefinition>();
    for (const type of types) {
      const reference = parseComponentNodeType(type);
      const definition = reference === null ? undefined : lookup(reference);
      if (reference !== null && definition !== undefined) roots.set(refKey(reference), definition);
    }
    return [...roots.values()];
  };

  return {
    carry(types) {
      const installed = (reference: ComponentRef) => components.get(reference.componentId, reference.version);
      // A nested component this catalogue lacks is not carried; the paste names it.
      const ordered = orderDeepestFirst(rootsOf(types, installed), installed);
      return ordered.ok ? ordered.definitions : [];
    },

    receive(types, carried, registry) {
      const byKey = new Map<string, GraphComponentDefinition>();
      for (const raw of carried) {
        const read = parseComponentDefinition(raw);
        // Definitions that do not read are no definitions: the paste falls back to what
        // this document holds, and names the instance it cannot build.
        if (!read.ok) return NOTHING_CARRIED;
        byKey.set(refKey(read.definition), read.definition);
      }
      const lookup = (reference: ComponentRef) => byKey.get(refKey(reference));
      const roots = rootsOf(types, lookup);
      if (roots.length === 0) return NOTHING_CARRIED;

      const ordered = orderDeepestFirst(roots, lookup);
      if (!ordered.ok) {
        return {
          refusal: `The copied components contain each other (${ordered.cycle.join(" → ")}), so they cannot be pasted (§V83).`,
        };
      }
      const plan = planComponentImport(ordered.definitions, components);
      const missing = plan.missing[0];
      if (missing !== undefined) {
        return {
          refusal: `The copy needs ${missing.componentId} v${missing.version}, which it does not carry and this document does not have.`,
        };
      }

      const renamed = new Map(plan.renamed.map((rename) => [refKey(rename.from), rename.to.componentId]));
      const placed = roots.map((root) => ({
        from: componentNodeType(root.componentId, root.version),
        componentId: renamed.get(refKey(root)) ?? root.componentId,
        version: root.version,
      }));
      const problems = importPlanProblems(plan.install, placed, { components, registry, host });
      if (problems.length > 0) return { refusal: problems.map((problem) => problem.message).join(" ") };

      return {
        types: new Map(placed.map((each) => [each.from, componentNodeType(each.componentId, each.version)])),
        install: () => installDefinitions(plan.install, components),
      };
    },
  };
}
