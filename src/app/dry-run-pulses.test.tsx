// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { alice, contextFor, createHarness } from "@domain/commands/test-support.ts";
import type { CompiledGraph } from "../compiler/types.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { createMediaControlRegistry, useMediaCommands } from "./media-commands.ts";
import { registerResetFeedbackCommand } from "./runtime-commands.ts";

/**
 * §B288 — A DRY RUN OF A COMMAND A PULSE FIRES DOES NOT FIRE IT (§V36).
 *
 * `runtime.resetFeedback`, `media.cue` and `media.reload` never read `dryRun`: asked to
 * validate, they cleared the loop, moved the playhead, reopened the file. A component
 * session passes an invocation through to the project's bus as it is (§T1695b), and the
 * gates over every command ask with a dry run, so "validate" has to mean it.
 *
 * `runtime.resetInference` has the same guard and no claim here: it is registered inside
 * `useModelInference`, whose mount needs a worker and a backend.
 */

afterEach(cleanup);

const ctx = contextFor(alice);
const dry = contextFor(alice, { dryRun: true });

describe("§B288 — runtime.resetFeedback", () => {
  it("counts what it would clear on a dry run and clears it on a real one", async () => {
    const { bus } = createHarness();
    const cleared: Array<readonly string[] | undefined> = [];
    const backend = { resetTemporalHistory: (ids?: readonly string[]) => cleared.push(ids) } as unknown as LoomBackend;
    const compiled = { feedback: [{ nodeId: "two/fb", resourceId: "pair:two/fb" }], resources: [] } as unknown as CompiledGraph;
    registerResetFeedbackCommand(bus, { backend: () => backend, compiled: () => compiled, resetState: () => backend.resetTemporalHistory(undefined, { buffers: true }) });

    const asked = await bus.execute("runtime.resetFeedback", { nodeIds: ["two/fb"] }, dry);
    expect(asked.status).toBe("validated");
    expect(asked.output).toEqual({ cleared: 1 });
    expect(cleared).toEqual([]);

    const done = await bus.execute("runtime.resetFeedback", { nodeIds: ["two/fb"] }, ctx);
    expect(done.status).toBe("applied");
    expect(cleared).toEqual([["pair:two/fb"]]);
  });
});

describe("§B288 — media.cue and media.reload", () => {
  it("count what they would reach on a dry run and reach it on a real one", async () => {
    const { bus } = createHarness();
    const registry = createMediaControlRegistry();
    const moved: string[] = [];
    registry.register("two/movie", { cue: () => moved.push("cue"), reload: () => moved.push("reload") });
    renderHook(() => useMediaCommands(bus, registry));

    const cue = await bus.execute("media.cue", { nodeIds: ["two/movie"] }, dry);
    const reload = await bus.execute("media.reload", { nodeIds: ["two/movie"] }, dry);
    expect([cue.status, cue.output, reload.status, reload.output]).toEqual(["validated", { cued: 1 }, "validated", { reloaded: 1 }]);
    expect(moved).toEqual([]);

    await bus.execute("media.cue", { nodeIds: ["two/movie"] }, ctx);
    await bus.execute("media.reload", { nodeIds: ["two/movie"] }, ctx);
    expect(moved).toEqual(["cue", "reload"]);
  });
});
