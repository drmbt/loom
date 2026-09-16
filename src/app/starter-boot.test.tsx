// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { starterPreferenceStore } from "@editor/inspect/index.ts";
import { newProjectDocument } from "./app-runtime.ts";
import { serializeProjectDocument } from "@domain/project/index.ts";
import type { SnapshotMeta, SnapshotRecord, SnapshotStore } from "@domain/project/index.ts";
import type { ProjectDocument } from "@domain/types/graph.ts";
import { App } from "./app.tsx";
import type { AppRuntime } from "./app-runtime.ts";
import type { GpuStatus } from "./gpu-status.ts";
import { PROJECT_STORAGE_KEY } from "./app-runtime.ts";
import { STARTER_EXAMPLE_FILE, starterProjectText, unrunnableHere } from "./use-starter-project.ts";
import type { StarterDocument } from "./use-starter-project.ts";
import { orderRequirements } from "@domain/types/requirements.ts";
import type { HostFacts, RuntimeRequirementId } from "@domain/types/requirements.ts";

/**
 * THE STARTER NETWORK AND THE AUTOSAVE IT MUST NEVER TOUCH (owner request).
 *
 * The feature is small — a boot with nothing to restore opens a tiny shipped example so
 * the first thing anybody sees is moving. The DANGER is not small, and it is the whole
 * subject of this file:
 *
 *   1. a starter that loads over an existing autosave destroys real work;
 *   2. a starter that autosaves ITSELF becomes the user's document, which silently kills
 *      the preference (an autosave now exists on every boot forever) and starts offering
 *      people a "restore" of a file they never authored.
 *
 * So the assertions are about the DOCUMENT ON SCREEN after each kind of boot and about
 * what reached the snapshot store, never about whether a loader was called. `mountApp`
 * renders the bare `<App />` — no runtime prop — because that is the only spelling the
 * product uses (`main.tsx`) and the only one the starter acts on.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});

const NO_GPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

/** A fixed project id, so a seeded snapshot lands in the slot the boot will look in. */
const PROJECT_ID = "project-starter-boot-test";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_ID);
  // The preference is a per-person singleton over `localStorage`; put it back to its
  // shipped default before each case rather than assuming the previous one left it there.
  starterPreferenceStore().set(true);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** A `SnapshotStore` over a Map, with every `put` recorded. */
function memorySnapshotStore(seedRecords: SnapshotRecord[] = []) {
  const records = new Map<string, SnapshotRecord>(
    seedRecords.map((record) => [`${record.projectId}/${record.key}`, record]),
  );
  const puts: SnapshotRecord[] = [];
  const store: SnapshotStore = {
    async list(projectId: string): Promise<SnapshotMeta[]> {
      return [...records.values()]
        .filter((record) => record.projectId === projectId)
        .map(({ key, revision, savedAt, pinned }) => ({ key, revision, savedAt, pinned }));
    },
    async get(projectId: string, key: string): Promise<SnapshotRecord | undefined> {
      return records.get(`${projectId}/${key}`);
    },
    async put(record: SnapshotRecord): Promise<void> {
      puts.push(record);
      records.set(`${record.projectId}/${record.key}`, record);
    },
    async delete(projectId: string, key: string): Promise<void> {
      records.delete(`${projectId}/${key}`);
    },
  };
  return { store, puts, records };
}

/** Somebody's real work, as an autosave snapshot would hold it. */
function autosavedWork(projectId: string): ProjectDocument {
  return {
    ...newProjectDocument(projectId),
    name: "an evening of real work",
    graph: {
      revision: 12,
      nodes: {
        theirNode: {
          id: "theirNode",
          type: "solid",
          definitionVersion: 1,
          position: { x: 10, y: 20 },
          parameters: {},
        },
      },
      edges: {},
      groups: {},
    },
  };
}

function snapshotOf(document: ProjectDocument): SnapshotRecord {
  return {
    key: `1-r${document.graph.revision}`,
    projectId: document.projectId,
    revision: document.graph.revision,
    savedAt: 1,
    pinned: false,
    body: serializeProjectDocument(document),
  };
}

/**
 * Mounts the app the way the product does and reports the runtime that is LIVE when the
 * dust settles — the boot one, or whatever replaced it.
 */
async function mountApp(store: SnapshotStore | undefined) {
  let live: AppRuntime | null = null;
  await act(async () => {
    render(
      <App
        storage={createMemoryStorage()}
        gpuProbe={() => Promise.resolve(NO_GPU)}
        createSnapshotStore={() => store}
        onRuntimeChange={(next) => {
          live = next;
        }}
      />,
    );
  });
  // The starter decision waits on an IndexedDB round trip, so it lands a turn or two
  // after mount. Settle those turns rather than asserting into a race.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    runtime: () => live as AppRuntime | null,
    nodeTypes: (): string[] => {
      const runtime = live as AppRuntime | null;
      if (runtime === null) return [];
      return Object.values(runtime.bus.store.getGraph().nodes).map((node) => node.type);
    },
  };
}

/**
 * Long enough for a queued autosave to have LANDED.
 *
 * `createAutosave`'s debounce is 2 s, and a shorter wait makes "nothing was written" a
 * statement about the clock rather than about the app — measured: with a deliberate
 * boot-time `notifyChange()` spliced in, a 60 ms wait still saw an empty store. Real time
 * rather than fake timers because the decision this file is about rides on an IndexedDB
 * promise as well as a timer, and faking only one half proves the wrong thing.
 */
const PAST_AUTOSAVE_DEBOUNCE_MS = 2_400;

async function settleAutosave(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, PAST_AUTOSAVE_DEBOUNCE_MS));
  });
}

function nodeTypesOf(runtime: AppRuntime): string[] {
  return Object.values(runtime.bus.store.getGraph().nodes).map((node) => node.type);
}

/** The node types E6 is made of — what "the starter is on screen" actually looks like. */
const STARTER_NODE_TYPES = ["checker", "noise", "level", "transform", "displace", "output"];

describe("first boot: something is happening (owner request)", () => {
  it("opens the starter network when there is nothing to restore", async () => {
    const { store } = memorySnapshotStore();
    const app = await mountApp(store);

    await waitFor(() => {
      expect(app.runtime()).not.toBeNull();
    });
    // The DOCUMENT, not the fact that a loader ran: six nodes, and the ones E6 is built
    // from. An empty canvas would have none.
    expect([...app.nodeTypes()].sort()).toEqual([...STARTER_NODE_TYPES].sort());
  });

  it("keeps the starter in the SAME autosave slot the rest of the app uses", async () => {
    const { store } = memorySnapshotStore();
    const app = await mountApp(store);

    await waitFor(() => {
      expect(app.runtime()).not.toBeNull();
    });
    /*
     * The shipped file carries `example-displacement-stack` as its project id, and the
     * snapshot ring is keyed by project id while the launch lookup asks for the
     * browser-local one. Left unstamped, every edit the user makes to the starter would
     * be autosaved into a slot no boot ever reads: drag a slider for ten minutes, reload,
     * and the work is gone with nothing even offering it back.
     */
    expect(app.runtime()?.invocation.projectId).toBe(PROJECT_ID);
  });

  it("costs no permission prompt and no download — the file is in the bundle already", () => {
    const starter = starterProjectText(PROJECT_ID);
    expect(starter, `${STARTER_EXAMPLE_FILE} must be in the shipped catalogue`).not.toBeNull();
    /*
     * A first boot may not open a browser permission dialog or start a fetch. These are
     * the node types that would cause one, and the assertion is against the STARTER'S OWN
     * GRAPH rather than against a promise in a docblock — swapping the starter for an
     * example with a webcam in it fails here.
     */
    const gated = new Set([
      "webcam",
      "audioFileIn",
      "audioDeviceIn",
      "channelIn",
      "movieFileIn",
      "depth",
      "inference",
      "personMask",
      "midiIn",
      "osc",
    ]);
    const parsed = JSON.parse(starter!.text) as { graph: { nodes: Record<string, { type: string }> } };
    const types = Object.values(parsed.graph.nodes).map((node) => node.type);
    expect(types.filter((type) => gated.has(type))).toEqual([]);
    // And it is small enough to read at a glance, which is the other half of the ask.
    expect(types.length).toBeLessThanOrEqual(8);
  });
});

/**
 * THE GATE (rule 1). Everything else here is behaviour; this is the one that must not be
 * able to regress, because the failure it describes costs somebody a project.
 */
describe("an existing autosave ALWAYS wins", () => {
  it("does not load the starter over work that is waiting to be restored", async () => {
    const work = autosavedWork(PROJECT_ID);
    const { store } = memorySnapshotStore([snapshotOf(work)]);
    const app = await mountApp(store);

    // The restore prompt is on screen, offering their document…
    expect(await screen.findByText(/is newer than what is open/i)).toBeDefined();

    // …and nothing was opened over it. `onRuntimeChange` fires on every document swap, so
    // a null runtime here IS "the boot document is still the one that is open", and the
    // boot document is empty.
    expect(app.runtime()).toBeNull();
  });

  it("still refuses the starter when the user asked for one but there is work to restore", async () => {
    starterPreferenceStore().set(true);
    const { store } = memorySnapshotStore([snapshotOf(autosavedWork(PROJECT_ID))]);
    const app = await mountApp(store);

    expect(await screen.findByText(/is newer than what is open/i)).toBeDefined();
    // The preference chooses between a starter and an empty canvas. It is never allowed
    // to choose between a starter and the user's project.
    expect(app.nodeTypes()).toEqual([]);
  });
});

describe("the starter never lands on a document somebody chose", () => {
  it("stands down when a project is opened while the launch lookup is still in flight", async () => {
    /*
     * The window is real: the lookup is an IndexedDB round trip and the app is usable the
     * whole time it runs. `e2e/node-box.spec.ts` navigates and opens an example in the
     * same breath and hit exactly this — the starter arrived a beat later and replaced the
     * example it had just loaded.
     *
     * A store whose `list` never settles holds the boot open so the race is deterministic
     * rather than a matter of who wins today.
     */
    let releaseLookup = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const store: SnapshotStore = {
      async list(): Promise<SnapshotMeta[]> {
        await gate;
        return [];
      },
      async get() {
        return undefined;
      },
      async put() {},
      async delete() {},
    };

    let live: AppRuntime | null = null;
    await act(async () => {
      render(
        <App
          storage={createMemoryStorage()}
          gpuProbe={() => Promise.resolve(NO_GPU)}
          createSnapshotStore={() => store}
          onRuntimeChange={(next) => {
            live = next;
          }}
        />,
      );
    });
    expect(live as AppRuntime | null, "nothing has replaced the boot document yet").toBeNull();

    /*
     * The real door: the examples tab is the bottom dock's first and open tab now, and its
     * rows execute `project.open` on the bus (§V29, §V88). A hand-rolled adopt here would
     * be testing a path the product does not have.
     */
    const chosen = "E3 Animated Noise Field";
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${chosen}`) }));
    });
    await waitFor(() => {
      expect(live as AppRuntime | null, "the example should have replaced the runtime").not.toBeNull();
    });
    const afterOpen = new Set(nodeTypesOf(live as unknown as AppRuntime));

    // NOW let the lookup answer "nothing to restore". The starter must stand down.
    await act(async () => {
      releaseLookup();
      await gate;
    });
    await settleAutosave();

    // Still the example they chose, node for node — not E6 on top of it.
    expect(new Set(nodeTypesOf(live as unknown as AppRuntime))).toEqual(afterOpen);
    expect(nodeTypesOf(live as unknown as AppRuntime)).not.toContain("checker");
  });
});

describe("the starter does not become the user's document", () => {
  it("writes NOTHING to the snapshot store on a boot nobody touched", async () => {
    const { store, puts } = memorySnapshotStore();
    const app = await mountApp(store);

    await waitFor(() => {
      expect(app.runtime()).not.toBeNull();
    });
    // Give the autosave debounce every chance to fire: it is 2 s, and a fake clock would
    // only prove the timer was not set rather than that nothing was queued.
    await settleAutosave();

    /*
     * This is the property the whole design rests on. `GraphStore` takes its graph at
     * CONSTRUCTION and autosave writes only from a committed mutation, so a starter
     * nobody edited leaves no trace — which is what keeps the NEXT boot's lookup empty,
     * keeps the preference meaningful, and keeps the restore prompt from offering a
     * document the user never authored.
     *
     * If this ever goes red, something now commits during boot, and the starter is on its
     * way into the snapshot ring.
     */
    expect(puts, "a pristine starter must leave no snapshot behind").toEqual([]);
  });

  it("autosaves normally the moment the user edits it", async () => {
    const { store, puts } = memorySnapshotStore();
    const app = await mountApp(store);

    await waitFor(() => {
      expect(app.runtime()).not.toBeNull();
    });
    const runtime = app.runtime()!;

    await act(async () => {
      await runtime.bus.execute(
        "graph.applyPatch",
        {
          baseRevision: runtime.bus.store.getRevision(),
          operations: [{ op: "addNode", ref: "$n", type: "solid", position: { x: 0, y: 0 } }],
          label: "the user does something",
        },
        runtime.invocation,
      );
    });

    await waitFor(
      () => {
        expect(puts.length).toBeGreaterThan(0);
      },
      { timeout: 4000 },
    );
    // Their edited starter, in the slot the next boot reads. It is their document now.
    expect(puts.at(-1)?.projectId).toBe(PROJECT_ID);
  });
});

describe("the preference (persisted, per person, not in the .loom.json)", () => {
  it("boots to an empty canvas when it is off and there is nothing to restore", async () => {
    starterPreferenceStore().set(false);
    const { store, puts } = memorySnapshotStore();
    const app = await mountApp(store);

    await settleAutosave();
    expect(app.runtime()).toBeNull();
    expect(puts).toEqual([]);
  });

  it("boots to the restore prompt when it is off and an autosave exists", async () => {
    starterPreferenceStore().set(false);
    const { store } = memorySnapshotStore([snapshotOf(autosavedWork(PROJECT_ID))]);
    const app = await mountApp(store);

    expect(await screen.findByText(/is newer than what is open/i)).toBeDefined();
    expect(app.runtime()).toBeNull();
  });
});

describe("File → New means an empty canvas, and it stays empty", () => {
  it("does not reinstall the starter under a user who asked for nothing", async () => {
    const { store } = memorySnapshotStore();
    const app = await mountApp(store);

    await waitFor(() => {
      expect(app.runtime()).not.toBeNull();
    });
    const started = app.runtime()!;

    /*
     * No confirmation is expected, and that is an assertion in itself: nobody has edited
     * the starter, so there is nothing to lose and §V165 has nothing to ask about. Before
     * `document-dirty.ts` was rekeyed to the bus, this call sat on an unsaved-changes
     * dialog forever, because every shipped example carries `graph.revision: 1` and the
     * baseline was still the empty document's 0.
     */
    await act(async () => {
      await started.bus.execute("project.new", {}, started.invocation);
    });
    // The user-visible half of the same fact: no dialog was raised, so nothing asked them
    // to save a document they had not written a line of.
    expect(screen.queryByText(/unsaved/i)).toBeNull();
    // `project.new` builds a fresh runtime, which re-runs the launch lookup. A per-runtime
    // decision would answer "nothing to restore" again and put the starter straight back.
    await settleAutosave();

    expect(app.nodeTypes()).toEqual([]);
  });
});

/**
 * T1164 — A REFRESH RETURNS YOU WHERE YOU WERE, AND THE STARTER IS FOR A FIRST VISIT.
 *
 * The owner: *"the example that we're loading by default now, which is actually kinda
 * weird — because if I just loaded another thing and then refresh, I wouldn't want to end
 * up here."*
 *
 * What makes this worth a describe of its own is that NOTHING ABOVE WAS BROKEN. Opening an
 * example and not editing it commits nothing — that is this file's own §T1123 gate, three
 * describes up, and it is the property that keeps a starter from becoming somebody's
 * document. So the next boot correctly found no autosave and correctly loaded the starter.
 * Every rule fired as designed. The rules model EDITED WORK; the missing concept was
 * DELIBERATE INTENT, and `last-opened.ts` is that concept as a POINTER — a file name and a
 * kind, never bytes, so it cannot become the user's work the way autosave-on-open would.
 *
 * A BOOT here is a fresh `mountApp` after `cleanup()`. The pointer lives in this browser's
 * `localStorage`, which `beforeEach` clears and a remount does not, so the second mount is
 * the same browser on a later day — which is exactly the claim.
 */
describe("T1164 — the starter does not override a document somebody deliberately opened", () => {
  it("reopens the example the user chose, instead of the starter, on the next boot", async () => {
    const { store, puts } = memorySnapshotStore();

    // BOOT ONE. Nothing has ever been opened here, so this IS the first visit and the
    // starter is right — asserted, because otherwise the second boot proves nothing.
    const first = await mountApp(store);
    await waitFor(() => {
      expect(first.runtime()).not.toBeNull();
    });
    expect([...first.nodeTypes()].sort()).toEqual([...STARTER_NODE_TYPES].sort());

    // The user opens something else, through the real row on the real examples tab, which
    // executes `project.open` on the bus (§V29, §V88) — not a hand-rolled adopt.
    const chosen = "E3 Animated Noise Field";
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${chosen}`) }));
    });
    await waitFor(() => {
      expect(first.nodeTypes()).not.toEqual([]);
    });
    const theirDocument = [...first.nodeTypes()].sort();
    // Non-vacuity: they are genuinely somewhere else, so "the starter came back" and "we
    // returned them" are distinguishable outcomes.
    expect(theirDocument).not.toEqual([...STARTER_NODE_TYPES].sort());

    // AND THEY DID NOT EDIT IT. This is the §T1123 property that caused the bug, held
    // here on purpose: the pointer must not have been bought with a snapshot.
    await settleAutosave();
    expect(
      puts,
      "opening an example must still write NOTHING to the snapshot ring — a pointer, not a snapshot",
    ).toEqual([]);

    cleanup();

    // BOOT TWO — same browser, still nothing to restore. The old behaviour was E6 here.
    const second = await mountApp(store);
    await waitFor(() => {
      expect(second.runtime()).not.toBeNull();
    });
    expect(
      [...second.nodeTypes()].sort(),
      "a refresh put the user somewhere they did not choose",
    ).toEqual(theirDocument);
  }, 30_000);

  it("still lets an existing autosave win over the remembered example (rule one)", async () => {
    // The pointer is asked AFTER the autosave, never instead of it. If that order ever
    // inverts, a reload would answer an evening of work with a pristine example.
    const { store: firstStore } = memorySnapshotStore();
    const first = await mountApp(firstStore);
    await waitFor(() => {
      expect(first.runtime()).not.toBeNull();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^E3 Animated Noise Field/ }));
    });
    await waitFor(() => {
      expect(first.nodeTypes()).not.toEqual([]);
    });
    cleanup();

    // The same browser, now with real work waiting.
    const work = autosavedWork(PROJECT_ID);
    const { store } = memorySnapshotStore([snapshotOf(work)]);
    const second = await mountApp(store);

    expect(await screen.findByText(/is newer than what is open/i)).toBeDefined();
    // `onRuntimeChange` fires on every document swap, so a null runtime IS "nothing was
    // opened over the boot document" — the remembered example included.
    expect(second.runtime()).toBeNull();
  }, 30_000);

  it("keeps File → New empty across a boot, not just for the rest of the session", async () => {
    const { store } = memorySnapshotStore();
    const first = await mountApp(store);
    await waitFor(() => {
      expect(first.runtime()).not.toBeNull();
    });
    const started = first.runtime()!;
    await act(async () => {
      await started.bus.execute("project.new", {}, started.invocation);
    });
    await settleAutosave();
    expect(first.nodeTypes()).toEqual([]);

    cleanup();

    /*
     * BOOT TWO. §T1123 made "the user asked for nothing" stick for the rest of the
     * SESSION; it came undone on the next reload, because from the boot decision's side
     * "they asked for an empty canvas" and "this browser has never been used" were the
     * same state. An empty canvas is a document somebody chose, so it survives a refresh
     * the way any other chosen document does.
     */
    const second = await mountApp(store);
    await settleAutosave();
    expect(second.nodeTypes()).toEqual([]);
  }, 30_000);

  it("boots to the starter for someone who has genuinely never opened anything", async () => {
    /*
     * The other side of the same switch, and the reason it is a separate case: a pointer
     * that answered "something" for everybody would silently retire the starter, and every
     * assertion above would still pass. This is the first visit, and it is E6.
     */
    const { store } = memorySnapshotStore();
    const app = await mountApp(store);
    await waitFor(() => {
      expect(app.runtime()).not.toBeNull();
    });
    expect([...app.nodeTypes()].sort()).toEqual([...STARTER_NODE_TYPES].sort());
  });
});

/**
 * B225 — THE FIRST THING SOMEBODY SEES MUST BE RUNNABLE WHERE THEY ARE.
 *
 * The owner, on the hosted build: *"the current version doesn't have the checkerboard
 * displacement noise example as the default any more, but the SYPHON LOOPBACK. that's
 * confusing… that's a HELPER-SUPPORTED one and we're in the BROWSER."*
 *
 * And, as with T1164 above, NOTHING WAS BROKEN. The starter is still E6 (the describe at
 * the top of this file asserts it), and a genuinely fresh profile against the deployed
 * build opens E6 — checked, not assumed. What had happened is that rule two worked: the
 * pointer had been left on E71 by a visit that browsed the desktop-only examples, and the
 * next boot dutifully returned the user to a Syphon loopback in a browser tab, where it
 * cannot render a pixel. **Restoring an example this host cannot run is a bad boot
 * whatever recorded it**, and a first impression that cannot render is worse than none.
 *
 * The defect's own signature is therefore "A BROWSER BOOT OPENED A DESKTOP-ONLY EXAMPLE",
 * and that is what the first case here asserts, end to end through the real store, the
 * real pointer and the real catalogue — not that a predicate returned a value.
 */
describe("B225 — a boot does not restore an example this machine cannot run", () => {
  /** E71's node types — what "a Syphon loopback is on screen" actually looks like. */
  const E71 = "E71 Syphon Loopback";

  it("opens the starter, not the desktop-only example the pointer names, and SAYS SO", async () => {
    const { store } = memorySnapshotStore();

    // BOOT ONE. The user browses the new examples and opens E71 through the real row,
    // which executes `project.open` on the bus and records the pointer (§V29, §V88).
    const first = await mountApp(store);
    await waitFor(() => {
      expect(first.runtime()).not.toBeNull();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${E71}`) }));
    });
    await waitFor(() => {
      expect(first.nodeTypes()).not.toEqual([]);
    });
    /*
     * NON-VACUITY, and the thing that makes this a browser boot rather than a unit test:
     * a Syphon node really is on the canvas, in jsdom, where `desktopShellPresent()` is
     * false. If E71 ever stopped containing one, the case below would pass for no reason.
     */
    expect(
      first.nodeTypes().some((type) => type.toLowerCase().startsWith("syphon")),
      "E71 must really put a Syphon node on the canvas, or this case proves nothing",
    ).toBe(true);

    cleanup();

    // BOOT TWO — same browser, still nothing to restore, still a browser tab. Before
    // B225 this put the Syphon loopback straight back.
    const second = await mountApp(store);
    await waitFor(() => {
      expect(second.runtime()).not.toBeNull();
    });
    expect(
      [...second.nodeTypes()].sort(),
      "a browser boot reopened a desktop-only example",
    ).toEqual([...STARTER_NODE_TYPES].sort());

    /*
     * AND THE SUBSTITUTION IS NOT SILENT. They chose E71 on purpose; a boot that hands
     * them a different document with no word about it is its own bug report. The notice
     * names the example and the requirement that decided it, and "Open it anyway" is
     * theirs to click — being unable to RUN a graph never stopped it opening (§V93).
     */
    const notice = await screen.findByText(new RegExp(`${E71} was not reopened`));
    // The WHY, in the same words the Examples pane puts on the row — asserted off the
    // notice's own subtree, because "Desktop only" is also a badge on four library rows.
    expect(
      notice.textContent,
      "the notice must name the requirement that decided it, not just refuse",
    ).toContain("Desktop only");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Open it anyway/ }));
    });
    await waitFor(() => {
      expect(
        second.nodeTypes().some((type) => type.toLowerCase().startsWith("syphon")),
        "the override must actually take the user to the example they chose",
      ).toBe(true);
    });
  }, 30_000);

  it("still reopens an example this machine CAN run, and says nothing about it", async () => {
    /*
     * The other side of the switch. A guard that declined everything would pass every
     * assertion above while quietly retiring T1164 — so this is the legitimate case the
     * guard could swallow: E3 needs nothing beyond a browser tab, and rule two must be
     * exactly as it was.
     */
    const { store } = memorySnapshotStore();
    const first = await mountApp(store);
    await waitFor(() => {
      expect(first.runtime()).not.toBeNull();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^E3 Animated Noise Field/ }));
    });
    await waitFor(() => {
      expect(first.nodeTypes()).not.toEqual([]);
    });
    const theirDocument = [...first.nodeTypes()].sort();
    expect(theirDocument).not.toEqual([...STARTER_NODE_TYPES].sort());

    cleanup();

    const second = await mountApp(store);
    await waitFor(() => {
      expect(second.runtime()).not.toBeNull();
    });
    expect([...second.nodeTypes()].sort()).toEqual(theirDocument);
    // Nothing was overridden, so there is nothing to announce.
    expect(screen.queryByText(/was not reopened/)).toBeNull();
  }, 30_000);
});

/**
 * B225 — THE THREE VERDICTS, against a FAKE host record.
 *
 * The evaluation is pure (`requirements × HostFacts → verdict`), so the interesting half
 * of this fix is assertable without a browser at all — and the `unknown` arm is the one
 * that decides the design. §V986: only a KNOWN `unmet` may override what the user chose.
 * A guard that also refused on `cannot tell` would be the same confident wrong answer
 * pointing the other way, and no host reachable from jsdom can produce that arm.
 */
describe("B225 — only a KNOWN 'cannot run' overrides a deliberate choice (§V986)", () => {
  function documentNeeding(ids: readonly RuntimeRequirementId[]): StarterDocument {
    return {
      text: "{}",
      example: {
        fileName: "E-fake.loom.json",
        name: "Fake",
        nodeCount: 1,
        text: "{}",
        description: "",
        category: "image",
        tags: [],
        requirements: orderRequirements(ids),
      },
    };
  }

  const BROWSER_ON_A_MAC: HostFacts = { shell: "browser", helper: "unknown", os: "macos" };

  it("declines a desktop-only example in a browser — the verdict is KNOWN unmet", () => {
    const refusal = unrunnableHere(documentNeeding(["desktop", "macos"]), BROWSER_ON_A_MAC);
    expect(refusal, "a browser tab has no Syphon transport at all, and we can prove it").not.toBeNull();
    // The words the notice shows: the blocking requirement is the one the reader acts on.
    expect(refusal?.blocking.id).toBe("desktop");
  });

  it("REOPENS an example whose requirement this page cannot check", () => {
    /*
     * `ndi-sdk` is a machine install: a page cannot see the filesystem, so the verdict is
     * `unknown` on every host, forever. Refusing here would mean nobody who works on NDI
     * can ever be returned to their own document — punishment for a fact we declined to
     * establish.
     */
    expect(unrunnableHere(documentNeeding(["ndi-sdk"]), BROWSER_ON_A_MAC)).toBeNull();
  });

  it("REOPENS a helper example on a tab whose bridge has not finished probing", () => {
    /*
     * `helper: "unknown"` is the state one second after load — the socket is still
     * opening. Reading that as "the helper is absent" is exactly the confident wrong
     * answer §V986 names, and it would hit every OSC and laser user on every reload.
     */
    expect(unrunnableHere(documentNeeding(["helper"]), BROWSER_ON_A_MAC)).toBeNull();
    // …and when the page has genuinely established there is no helper, it declines.
    expect(
      unrunnableHere(documentNeeding(["helper"]), { ...BROWSER_ON_A_MAC, helper: "absent" }),
    ).not.toBeNull();
  });

  it("REOPENS a plain example, and one whose requirements could not be read at all", () => {
    expect(unrunnableHere(documentNeeding([]), BROWSER_ON_A_MAC)).toBeNull();
    const unreadable: StarterDocument = {
      ...documentNeeding([]),
      example: { ...documentNeeding([]).example, requirementsError: "unavailable node spoutIn" },
    };
    // Knowing nothing about what a file needs is not evidence that it needs the impossible.
    expect(unrunnableHere(unreadable, BROWSER_ON_A_MAC)).toBeNull();
  });

  it("declines on the desktop app too, when the PLATFORM is the thing that is wrong", () => {
    // Not a browser-only rule: a macOS Syphon example on a Windows desktop build is just
    // as unrunnable, and the same sentence is the right one.
    const windowsDesktop: HostFacts = { shell: "desktop", helper: "paired", os: "windows" };
    expect(unrunnableHere(documentNeeding(["desktop", "macos"]), windowsDesktop)?.blocking.id).toBe(
      "macos",
    );
    // …and it reopens the same file on the Mac desktop build that meets it.
    const macDesktop: HostFacts = { shell: "desktop", helper: "paired", os: "macos" };
    expect(unrunnableHere(documentNeeding(["desktop", "macos"]), macDesktop)).toBeNull();
  });
});
