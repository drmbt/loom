// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * T733 / B141 — a load's history reset survives the compile that follows it.
 *
 * The owner, on the pair this file uses as its shape: "loading the reaction diffusion
 * example after the audio reactive reaction diffusion sample breaks stuff indicating that
 * we're still weirdly leaking stuff over by id or name or whatever."
 *
 * ## What was actually wrong, measured in the running app
 *
 * T519 wired the load rite — `resetTemporalHistory(undefined, { buffers: true })` and a
 * seek to frame 0 — into the `.then` after `await backend.compile`, and read whether to
 * run it from a REF that every render overwrites. Instrumenting that `.then` against the
 * owner's own pair, opening E2-Reaction-Diffusion over E24-Audio-Reaction-Diffusion:
 *
 *     [T733] {"gen":3,"cur":5,"superseded":true,"boundary":false}
 *     [T733] {"gen":4,"cur":5,"superseded":true,"boundary":false}
 *     [T733] {"gen":5,"cur":5,"superseded":false,"boundary":false}
 *
 * THREE compiles for one load, and `boundary: false` on every one of them — including the
 * first, whose own render had set it true. Two mechanisms, both live: the load's compile
 * is SUPERSEDED (the preview-sink store republishes on the graph pane's rAF tick, well
 * inside a 70-node compile) so its `.then` returns early, and the compile that does land
 * belongs to the same document as its predecessor so its flag is false. The rite never
 * ran. Both documents are Gray-Scott simulations sharing eleven node ids, and
 * `backend.compile` carries resources over BY RESOURCE ID (§V62b, T143), so E2's chemical
 * field started from E24's — which is what "breaks stuff" looks like from the owner's
 * seat. The FIRST load of a session survives, which is why it presents as intermittent.
 *
 * ## Why this gate drives the second compile with a patch
 *
 * The production trigger is the preview scheduler's republish, and it needs a real rAF
 * loop over a laid-out canvas — jsdom has neither, which is why B141 was filed as "not
 * reddenable in jsdom". It does not need to be reproduced by its own trigger: the claim
 * is not "the sink store republishes", it is **the load's rite must not be lost because
 * another compile follows it**. Any second revision produces that shape, so the gate uses
 * the one it can drive deterministically — a patch through the bus, which is a real path
 * (an agent edits, §V32; so do undo and redo) and lands the same interleaving.
 *
 * ## TWO documents, and the interleaving is asserted rather than hoped for
 *
 * One load cannot show this: with nothing before it there is no carried-over ring to leak.
 * And a gate that flushed each compile before the next revision would be green on the
 * broken code. Since §B235 serializes backend compiles, the fixture CHECKS that later
 * revisions wait behind the held load, only the newest waiting revision is compiled,
 * and the superseded load cannot discharge the reset before that newest plan installs
 * (§V461 — a fixture must be capable of distinguishing what its test asserts).
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

/** One `.loom.json`, parameterised by the one thing that differs. */
function documentText(name: string, color: readonly number[]): string {
  return JSON.stringify({
    schemaVersion: 3,
    projectId: `t733-${name}`,
    name,
    assets: [],
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    settings: {
      outputResolution: { width: 320, height: 180 },
      workingFormat: "rgba16float",
      randomSeed: 1,
      previewLongEdge: 192,
      previewFps: 20,
      limits: {
        maxResolution: 4096,
        maxDispatch: 65_535,
        maxBufferBytes: 268_435_456,
        memoryBudgetBytes: 1_073_741_824,
      },
    },
    graph: {
      revision: 1,
      nodes: {
        field: {
          id: "field",
          type: "solid",
          definitionVersion: 1,
          label: "solid1",
          position: { x: 0, y: 0 },
          parameters: { color },
        },
        out: {
          id: "out",
          type: "output",
          definitionVersion: 1,
          label: "out1",
          position: { x: 240, y: 0 },
          parameters: {},
        },
      },
      edges: {
        "e-field-out": {
          id: "e-field-out",
          source: { nodeId: "field", portId: "out" },
          target: { nodeId: "out", portId: "input" },
        },
      },
      groups: {},
    },
  });
}

/** Red. */
const DOCUMENT_A = documentText("T733 A", [1, 0, 0, 1]);
/** Blue — the same document in every respect a node-id comparison can see. */
const DOCUMENT_B = documentText("T733 B", [0, 0, 1, 1]);

interface Journal {
  /** Every backend call that matters here, in order. */
  readonly calls: string[];
  /** Each `resetTemporalHistory`, with the two things that distinguish the LOAD rite. */
  readonly resets: Array<{ scoped: boolean; buffers: boolean }>;
  /** Logical plans actually sent to the backend, excluding superseded queued requests. */
  readonly compiles: CompiledGraph[];
}

interface Deferred {
  readonly backend: LoomBackend;
  readonly journal: Journal;
  /** Compiles the backend has been handed and not yet answered. */
  readonly pending: Array<() => void>;
}

/**
 * A backend whose `compile` does not resolve until the test says so.
 *
 * That control is the whole instrument: B141 only exists in the window between a compile
 * being scheduled and its promise resolving, and a backend that answers on a microtask
 * closes that window before anything can interleave with it.
 */
function deferredBackend(): Deferred {
  const journal: Journal = { calls: [], resets: [], compiles: [] };
  const pending: Array<() => void> = [];
  let planCount = 0;
  const backend = {
    status: {
      initialized: true,
      disposed: false,
      halted: false,
      deviceGeneration: 1,
      temporalResets: 0,
      resourceBuilds: 0,
      framesSubmitted: 0,
      readbacks: 0,
      stale: false,
      estimatedResourceBytes: 0,
    },
    onDiagnostic: () => () => {},
    recover: async () => {},
    loop: () => ({ stop: () => {} }),
    previewHost: () => ({
      setPreviewProgram: () => {},
      presentPreviews: () => {},
      dispose: () => {},
    }),
    present: () => ({ id: "present", outputId: "", setOutput: () => {}, dispose: () => {} }),
    onGpuTimings: () => () => {},
    onCpuTimings: () => () => {},
    compile: (plan: CompiledGraph) => {
      journal.calls.push("compile");
      journal.compiles.push(plan);
      planCount += 1;
      const id = `plan-${planCount}`;
      return new Promise((resolve) => {
        pending.push(() => {
          journal.calls.push(`install:${id}`);
          resolve({ id, passes: [] });
        });
      });
    },
    render: () => {},
    resize: () => {},
    updateUniforms: () => {
      journal.calls.push("updateUniforms");
    },
    resetTemporalHistory: (
      resourceIds?: readonly string[],
      options?: { buffers?: boolean; silent?: boolean },
    ) => {
      journal.calls.push("resetTemporalHistory");
      journal.resets.push({
        scoped: resourceIds !== undefined,
        buffers: options?.buffers === true,
      });
    },
    setCookPolicy() {},
    dispose: () => {},
  } as unknown as LoomBackend;
  return { backend, journal, pending };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

interface Session {
  runtime(): AppRuntime;
  /** Opens WITHOUT answering the compile it starts. */
  open(text: string, fileName: string): Promise<void>;
  patch(operations: GraphPatchOperation[]): Promise<void>;
  /** Answers every compile now outstanding, oldest first. */
  flush(): Promise<void>;
  /** Lands one held compile, allowing its newest queued successor to start. */
  answerOne(): Promise<void>;
  readonly journal: Journal;
  readonly pending: Array<() => void>;
}

async function mount(): Promise<Session> {
  const first = createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
  let current = first;
  const { backend, journal, pending } = deferredBackend();
  const status: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend };

  render(
    <App
      runtime={first}
      storage={createMemoryStorage()}
      gpuProbe={() => Promise.resolve(status)}
      onRuntimeChange={(next) => {
        current = next;
      }}
    />,
  );
  await act(async () => {});
  await settle();

  const answerOne = async (): Promise<void> => {
    await act(async () => {
      const next = pending.shift();
      if (next === undefined) throw new Error("No backend compile is in flight.");
      next();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();
  };
  const flush = async (): Promise<void> => {
    // Each answer lets compileLatest start the newest waiting plan on a microtask.
    // Drain that successor too, rather than observing only the first pending array.
    while (pending.length > 0) await answerOne();
  };

  return {
    runtime: () => current,
    journal,
    pending,
    flush,
    answerOne,
    async open(text, fileName) {
      // Through the BUS — the door the example library and the file picker both use
      // (§V29, §V88).
      await act(async () => {
        await current.bus.execute("project.open", { text, fileName }, current.invocation);
      });
      await settle();
    },
    async patch(operations) {
      await act(async () => {
        await current.bus.execute(
          "graph.applyPatch",
          { baseRevision: current.bus.store.getRevision(), operations },
          current.invocation,
        );
      });
      await settle();
    },
  };
}

/** A node the document did not have: topology, so it cannot take the uniform path. */
const ADD_A_NODE: GraphPatchOperation[] = [
  { op: "addNode", ref: "$extra", type: "noise", position: { x: 0, y: 400 } },
];

describe("T733 — a load's history reset is owed work, not an observed flag (B141)", () => {
  it("clears history even when a later compile supersedes the load's own", async () => {
    const session = await mount();

    await session.open(DOCUMENT_A, "A.loom.json");
    await session.flush();
    // NON-VACUITY: everything below is about what the SECOND load does. If the first one
    // never reached the backend there would be no carried-over resources to leak and no
    // claim to make.
    await waitFor(() => {
      expect(session.journal.calls).toContain("compile");
    });

    const before = session.journal.calls.length;
    const resetsBefore = session.journal.resets.length;
    const compilesBefore = session.journal.compiles.length;

    // The load. Its compile is left IN FLIGHT — this is the window B141 lives in.
    await session.open(DOCUMENT_B, "B.loom.json");
    expect(session.pending).toHaveLength(1);
    expect(session.journal.compiles).toHaveLength(compilesBefore + 1);

    // A second revision lands while it is still in flight. In the app this is the preview
    // scheduler republishing its kept tile set; here it is a patch, which produces the
    // same shape and is a real path in its own right (§V32).
    await session.patch(ADD_A_NODE);
    await session.patch([
      { op: "addNode", ref: "$newest", type: "noise", position: { x: 200, y: 400 } },
    ]);
    const addedIds = Object.values(session.runtime().bus.store.getGraph().nodes)
      .filter((node) => node.type === "noise")
      .map((node) => node.id);
    expect(addedIds).toHaveLength(2);

    // THE FIXTURE IS CAPABLE (§V461). Both revisions are queued while B's load compile
    // remains held; a second backend call now would violate §B235, not prove B141.
    expect(session.pending).toHaveLength(1);
    expect(session.journal.compiles).toHaveLength(compilesBefore + 1);
    expect(session.journal.resets).toHaveLength(resetsBefore);

    await session.answerOne();
    // The running load was superseded. Its install cannot consume the debt; only the
    // newest waiting revision starts, with BOTH added preview outputs present. The
    // intermediate queued revision would contain only the first added node.
    expect(session.pending).toHaveLength(1);
    expect(session.journal.compiles).toHaveLength(compilesBefore + 2);
    const newestOutputs = session.journal.compiles.at(-1)!.outputs.map((output) => output.nodeId);
    const loadOutputs = session.journal.compiles[compilesBefore]!.outputs.map((output) => output.nodeId);
    for (const id of addedIds) {
      expect(newestOutputs).toContain(id);
      expect(loadOutputs).not.toContain(id);
    }
    expect(session.journal.resets).toHaveLength(resetsBefore);

    await session.flush();

    const since = session.journal.calls.slice(before);

    /*
     * THE RITE RAN.
     *
     * A load invalidates every pair and every buffer, so it is the UNSCOPED clear that
     * carries `buffers` — the one that zeroes the point storage a simulation seeds from,
     * and the thing that distinguishes it from §V22's plain feedback reset. Without it the
     * incoming document's ping-pongs keep the CONTENTS the closed project left in them
     * (§V62b, T143, §V22), which on two Gray-Scott documents sharing a node id is one
     * project's chemical field running under another project's rules.
     *
     * COUNTED AS "at least one", deliberately, and the population is why (§V649): the rite
     * is a PAIR of calls — the clear, then `seek(0)`, and the seek performs a clear of its
     * own by §V170 ("a seek REPLAYS"). So the number of `resetTemporalHistory` calls is not
     * the number of rites, and an exact count here would be measuring the seek's
     * implementation rather than this claim. The direction that an exact count would have
     * protected — "do not clear on every compile" — is the second test in this file, which
     * is where it belongs.
     */
    const boundaryResets = session.journal.resets
      .slice(resetsBefore)
      .filter((reset) => !reset.scoped && reset.buffers);
    expect(boundaryResets.length).toBeGreaterThan(0);

    // AFTER a plan was installed, never before. `resetTemporalHistory` clears the ACTIVE
    // program, and the active program is the previous document's until a compile resolves
    // — the reversed order wipes the picture the user is looking at and leaves the
    // incoming document's carried resources exactly as contaminated as they were.
    const installs = since.flatMap((call, index) => call.startsWith("install:") ? [index] : []);
    expect(installs).toHaveLength(2);
    expect(since.indexOf("resetTemporalHistory")).toBeGreaterThan(installs[1]!);
  }, 30_000);

  it("does not clear history for an ordinary edit inside ONE document (the control)", async () => {
    // The negative direction, and the reason it lives beside the test above: making every
    // compile pay the rite would satisfy every assertion there and would be a worse
    // product — §V22 says a feedback loop survives an edit, and a simulation the user has
    // been growing for a minute must not restart because they added a node.
    const session = await mount();
    await session.open(DOCUMENT_A, "A.loom.json");
    await session.flush();
    await waitFor(() => {
      expect(session.journal.calls).toContain("compile");
    });

    const before = session.journal.calls.length;
    await session.patch(ADD_A_NODE);
    await session.flush();

    const since = session.journal.calls.slice(before);
    // It did recompile — otherwise "no reset" would be true of a gate stuck shut.
    expect(since).toContain("compile");
    expect(since).not.toContain("resetTemporalHistory");
  }, 30_000);
});
