import type { LoomBus } from "@domain/commands/bus.ts";
import type { Actor, InvocationContext } from "@domain/types/commands.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { FrameScheduler } from "@ui/controls/coalesce.ts";
import { createParameterEditor, type ParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { phoneActorId, type PhoneSet } from "@devices/phone/phone-protocol.ts";
import { vetPhoneSet } from "@devices/phone/phone-snapshot.ts";

/**
 * T1396b — A PHONE'S WRITES, THROUGH THE BUS, AS THAT PHONE.
 *
 * Every write a phone sends is vetted against the document as it is now
 * (`vetPhoneSet`) and applied through a parameter editor whose actor IS the phone:
 * kind `human` (a person moved it, with a finger), id `remote-<phone>` (`phoneActorId`).
 * The actor union is not widened for this — a phone is a person somewhere else, and
 * everything keyed by actor (undo stacks, audit entries, grants) already does the right
 * thing with a distinct id:
 *
 *  - **undo is per phone.** One editor per phone, so a drag from a phone is live frames
 *    plus a commit sharing ONE transaction — one undo group on that phone's stack, never
 *    on the desk's (§V15, §V41);
 *  - **the audit names the phone** — every applied patch is an entry whose actor id is
 *    `remote-<phone>` (§V31);
 *  - **grants do not follow** — `viewportControl` is granted to the page's own actor by
 *    id (`app-runtime.ts`), so a phone holds none; it only ever sends `graph.applyPatch`
 *    with one `setParameters`, which needs none. `selectCreatedNodes` returns early
 *    without `createdIds`, which a parameter write never has, so a phone cannot move
 *    the desk's selection through it either.
 *
 * ## Why a button waits for its own write
 *
 * A press is counted on the false→true edge of `held`, read from the document. A phone
 * sends press and release back to back, and the parameter editor coalesces live values
 * to a frame — so without waiting, the release would be vetted against a document that
 * does not have the press yet, and would write the old count over the new one. So each
 * phone's writes run in order on one chain, and a button write (or any commit) waits
 * for the editor to settle before the next is vetted. A slider's live frames do not
 * wait: they only need clamping, and waiting would undo the per-frame coalescing.
 */

export interface PhoneWritesOptions {
  readonly bus: LoomBus;
  /** The page's invocation: project and grants. The actor is replaced per phone. */
  readonly invocation: InvocationContext;
  /** Injected by tests; the default is the animation frame. */
  readonly schedule?: FrameScheduler;
  /** A write the vet or the bus refused — never silence (§V365). */
  readonly onRefused: (phone: string, reason: string) => void;
}

export interface PhoneWrites {
  /** One phone write, vetted and applied in order after that phone's previous ones. */
  write(phone: string, set: PhoneSet): Promise<void>;
  /**
   * The phone is gone: let go of every button it was holding (a dropped connection
   * mid-press must not leave a channel stuck at 1), then forget its editor.
   */
  release(phone: string): Promise<void>;
  /** Resolves once every phone's queued writes have been applied. */
  settled(): Promise<void>;
  dispose(): void;
}

/** The actor a phone's writes carry. */
export function phoneActor(phone: string): Actor {
  return { kind: "human", id: phoneActorId(phone), label: "Phone" };
}

interface Lane {
  readonly editor: ParameterEditor;
  chain: Promise<void>;
  /** Buttons this phone pressed and has not released. */
  readonly held: Set<NodeId>;
}

export function createPhoneWrites(options: PhoneWritesOptions): PhoneWrites {
  const lanes = new Map<string, Lane>();

  const laneFor = (phone: string): Lane => {
    const existing = lanes.get(phone);
    if (existing !== undefined) return existing;
    const lane: Lane = {
      editor: createParameterEditor({
        bus: options.bus,
        context: { ...options.invocation, actor: phoneActor(phone) },
        ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
        onDiagnostics: (diagnostics) => {
          for (const diagnostic of diagnostics) options.onRefused(phone, diagnostic.message);
        },
      }),
      chain: Promise.resolve(),
      held: new Set(),
    };
    lanes.set(phone, lane);
    return lane;
  };

  const apply = async (lane: Lane, phone: string, set: PhoneSet, report: boolean): Promise<void> => {
    const vet = vetPhoneSet(options.bus.store.getGraph(), set);
    if (!vet.ok) {
      if (report) options.onRefused(phone, vet.reason);
      return;
    }
    lane.editor.setStored(vet.nodeId, vet.entries, vet.phase);
    if (vet.kind === "button") {
      if (vet.entries["held"] === true) lane.held.add(vet.nodeId);
      else lane.held.delete(vet.nodeId);
      await lane.editor.settled();
    } else if (vet.phase === "commit") {
      await lane.editor.settled();
    }
  };

  const enqueue = (lane: Lane, run: () => Promise<void>): Promise<void> => {
    const next = lane.chain.then(run, run);
    lane.chain = next.catch(() => undefined);
    return lane.chain;
  };

  return {
    write(phone, set) {
      const lane = laneFor(phone);
      return enqueue(lane, () => apply(lane, phone, set, true));
    },

    async release(phone) {
      const lane = lanes.get(phone);
      if (lane === undefined) return;
      for (const nodeId of [...lane.held]) {
        // Not reported when refused: the phone is gone, and a Panel switched off since
        // the press is the desk's own decision about that button.
        void enqueue(lane, () => apply(lane, phone, { handle: nodeId, values: { held: false }, phase: "commit" }, false));
      }
      await lane.chain;
      await lane.editor.settled();
      lane.editor.dispose();
      lanes.delete(phone);
    },

    async settled() {
      for (const lane of [...lanes.values()]) {
        await lane.chain;
        await lane.editor.settled();
      }
    },

    dispose() {
      for (const lane of lanes.values()) lane.editor.dispose();
      lanes.clear();
    },
  };
}
