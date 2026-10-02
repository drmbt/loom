import type { FrameClock } from "../types/frame.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { StoredParameter } from "../types/parameters.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { createGraphStore, type GraphStore } from "../graph/store.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import { createDomainBus } from "../commands/index.ts";
import type { LoomBus } from "../commands/bus.ts";
import { alice, contextFor } from "../commands/test-support.ts";
import { serializePresetBank, type MorphSpec, type Preset } from "./bank.ts";

/**
 * T1497b — a document that has been RECALLED INTO, for the tests that render one.
 *
 * The morph gates outside this folder (the compiler's, the Dawn one) need a document
 * carrying a morph record, and the only honest way to get one is the way the app does:
 * the real `preset.recall`, on the real bus, with a frame clock attached. A hand-written
 * record would test the reader against the test author's idea of what the writer writes.
 */

export function presetBankNode(
  id: NodeId,
  label: string,
  targets: string,
  presets: readonly Preset[],
  extra: Record<string, StoredParameter> = {},
): GraphNode {
  return {
    id,
    type: "presets",
    label,
    definitionVersion: 1,
    position: { x: 0, y: 200 },
    parameters: { targets, presets: serializePresetBank({ version: 1, presets }), ...extra },
  };
}

export interface PresetSession {
  readonly bus: LoomBus;
  readonly store: GraphStore;
  /** The frame clock a command invoked now reads; `undefined` detaches it (headless). */
  at(clock: FrameClock | undefined): void;
  recall(bankId: NodeId, name: string, morph?: MorphSpec): Promise<void>;
  graph(): GraphDocument;
}

/** A bus over `graph` with a settable frame clock — the app's attachment, by hand. */
export function presetSession(graph: GraphDocument, registry: NodeRegistryView): PresetSession {
  const store = createGraphStore({ ids: createSequentialIdFactory("t"), now: () => "2026-10-02T00:00:00.000Z", initialGraph: graph });
  const { bus } = createDomainBus({ store, registry });
  let clock: FrameClock | undefined;
  bus.attachFrameClock(() => clock);
  return {
    bus,
    store,
    at(next) {
      clock = next;
    },
    async recall(bankId, name, morph) {
      const result = await bus.execute("preset.recall", { nodeId: bankId, name, ...(morph === undefined ? {} : { morph }) }, contextFor(alice));
      if (result.status !== "applied") {
        throw new Error(`preset.recall "${name}" was ${result.status}: ${(result.diagnostics ?? []).map((each) => each.message).join("; ")}`);
      }
    },
    graph: () => store.view.getGraph(),
  };
}
