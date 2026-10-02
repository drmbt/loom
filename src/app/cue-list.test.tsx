// @vitest-environment jsdom
import { useMemo } from "react";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { CommandResult } from "@domain/types/commands.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { ParameterSlot, StoredParameter } from "@domain/types/parameters.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import { serializePresetBank } from "@domain/presets/bank.ts";
import { serializeCueList } from "@domain/presets/cue-list.ts";
import { KeymapProvider } from "@editor/keymap/index.ts";
import type { KeymapDispatch } from "@editor/keymap/engine.ts";
import { createKeymapStore } from "@editor/keymap/store.ts";
import { DEFAULT_BINDINGS } from "@editor/keymap/defaults.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { usePulseFiring } from "./pulse-firing.ts";
import { renderRangeHolderFor } from "./render-range.ts";

/**
 * T1500b (§T1398b S5) — THE CUE LIST'S TWO LIVE DOORS, in the composed app: the keys and
 * the expression-driven pulse.
 *
 * `src/domain/presets/cue-commands.test.ts` proves what GO does. This file proves a
 * performer can REACH it, which is the half this codebase keeps losing ("built, tested,
 * never wired"): the real runtime (`createAppRuntime` — the bus, catalogue and commands
 * the app boots with), the SHIPPED keymap table rather than a binding written for the
 * test, the real `KeymapProvider` listening on the window, and the real pulse hook the
 * frame loop steps. Every assertion is on the document afterwards — which cue the list
 * says is live and what the cue's target now holds — never on "a command was dispatched".
 *
 * The set: a Level and a bank over it with two presets, and a cue list `1 → dim`,
 * `2 → bright`, `3 → dim`. Brightness tells cue 2 from its neighbours; `current` tells
 * how many times the list moved.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

async function seed(runtime: AppRuntime, operations: GraphPatchOperation[]) {
  const result = await runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), operations, label: "seed" },
    runtime.invocation,
  );
  expect(result.status, JSON.stringify(result.diagnostics)).toBe("applied");
  return result;
}

const expression = (source: string): ParameterSlot => ({
  mode: "expression",
  bindings: { static: { kind: "static", value: false }, expression: { kind: "expression", source } },
});

interface Stage {
  runtime: AppRuntime;
  level: string;
  list: string;
}

/** The set above. `listParameters` rides on the cue list (its `go` expression, its `keys`). */
async function stage(listParameters: Record<string, StoredParameter> = {}): Promise<Stage> {
  const runtime = newRuntime();
  let level = "";
  let list = "";
  await act(async () => {
    const first = await seed(runtime, [
      { op: "addNode", ref: "$level", type: "level", position: { x: 0, y: 0 }, parameters: { brightness: 0.2 } },
    ]);
    level = first.output.createdIds["$level"] ?? "";
    const levelName = runtime.bus.store.getGraph().nodes[level]?.label ?? "";
    expect(levelName).not.toBe("");
    const second = await seed(runtime, [
      {
        op: "addNode",
        ref: "$bank",
        type: "presets",
        position: { x: 0, y: 200 },
        parameters: {
          targets: levelName,
          presets: serializePresetBank({
            version: 1,
            presets: [
              { name: "dim", values: { [levelName]: { brightness: 0.3 } } },
              { name: "bright", values: { [levelName]: { brightness: 0.8 } } },
            ],
          }),
        },
      },
    ]);
    const bankName = runtime.bus.store.getGraph().nodes[second.output.createdIds["$bank"] ?? ""]?.label ?? "";
    expect(bankName).not.toBe("");
    list = await addList(runtime, bankName, listParameters);
  });
  runtime.bus.attachFlattenedGraph(() => runtime.flattened.current().graph);
  return { runtime, level, list };
}

async function addList(runtime: AppRuntime, bankName: string, parameters: Record<string, StoredParameter> = {}): Promise<string> {
  const added = await seed(runtime, [
    {
      op: "addNode",
      ref: "$list",
      type: "cueList",
      position: { x: 0, y: 400 },
      parameters: {
        cues: serializeCueList({
          version: 1,
          cues: [
            { name: "1", bank: bankName, preset: "dim" },
            { name: "2", bank: bankName, preset: "bright" },
            { name: "3", bank: bankName, preset: "dim" },
          ],
        }),
        ...parameters,
      },
    },
  ]);
  return added.output.createdIds["$list"] ?? "";
}

const parameter = (runtime: AppRuntime, nodeId: string, key: string): unknown => runtime.bus.store.getGraph().nodes[nodeId]?.parameters[key];
const current = (runtime: AppRuntime, list: string): unknown => parameter(runtime, list, "current") ?? "";
const nameOf = (runtime: AppRuntime, nodeId: string): string => runtime.bus.store.getGraph().nodes[nodeId]?.label ?? "";
const commandsSince = (runtime: AppRuntime, from: number): string[] =>
  runtime.bus.store
    .getAudit()
    .slice(from)
    .map((entry) => `${entry.command}:${entry.status}`);

describe("the GO and BACK keys reach the cue list with Keys on (T1500b)", () => {
  /** The app's own arrangement: the shipped bindings, the runtime's bus, the window listener. */
  function Keys({ runtime, onDispatch }: { runtime: AppRuntime; onDispatch: (dispatch: KeymapDispatch) => void }) {
    const keymap = useMemo(() => createKeymapStore({ defaults: DEFAULT_BINDINGS, storage: null, platform: "other" }), []);
    return (
      <KeymapProvider bus={runtime.bus} store={keymap} invocationContext={runtime.invocation} onDispatch={onDispatch}>
        <div />
      </KeymapProvider>
    );
  }

  /** Presses a chord on the window and hands back what the command it reached answered. */
  async function press(runtime: AppRuntime, key: "g" | "b"): Promise<CommandResult<"cue.go">> {
    const dispatches: KeymapDispatch[] = [];
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<Keys runtime={runtime} onDispatch={(dispatch) => dispatches.push(dispatch)} />);
    });
    await act(async () => {
      fireEvent.keyDown(window, { key, code: key === "g" ? "KeyG" : "KeyB", ctrlKey: true, altKey: true });
    });
    const dispatched = dispatches.find((each) => each.status === "dispatched");
    if (dispatched?.status !== "dispatched") throw new Error(`mod+alt+${key} dispatched nothing: ${JSON.stringify(dispatches)}`);
    const result = (await dispatched.run) as CommandResult<"cue.go">;
    view.unmount();
    return result;
  }

  it("mod+alt+g fires the standby cue, and mod+alt+b fires the one before it", async () => {
    const { runtime, level, list } = await stage();
    expect(current(runtime, list)).toBe("");

    expect((await press(runtime, "g")).status).toBe("applied");
    expect(current(runtime, list)).toBe("1");
    expect(parameter(runtime, level, "brightness")).toBe(0.3);

    expect((await press(runtime, "g")).status).toBe("applied");
    expect(current(runtime, list)).toBe("2");
    expect(parameter(runtime, level, "brightness")).toBe(0.8);

    const back = await press(runtime, "b");
    expect(back.status).toBe("applied");
    expect(current(runtime, list)).toBe("1");
    expect(parameter(runtime, level, "brightness")).toBe(0.3);
    expect(parameter(runtime, list, "standby")).toBe("2");
    runtime.dispose();
  });

  it("with two lists answering the keys, GO is refused naming both and neither moves", async () => {
    const { runtime, level, list } = await stage();
    const bankName = Object.values(runtime.bus.store.getGraph().nodes).find((node) => node.type === "presets")?.label ?? "";
    let other = "";
    await act(async () => {
      other = await addList(runtime, bankName);
    });
    const revision = runtime.bus.store.getRevision();

    const result = await press(runtime, "g");
    expect(result.status).toBe("rejected");
    expect(result.diagnostics.map((each) => each.code)).toEqual(["cue.list.ambiguous"]);
    expect(result.diagnostics[0]?.message).toContain(`"${nameOf(runtime, list)}"`);
    expect(result.diagnostics[0]?.message).toContain(`"${nameOf(runtime, other)}"`);
    expect(nameOf(runtime, list)).not.toBe(nameOf(runtime, other));

    expect(runtime.bus.store.getRevision()).toBe(revision);
    expect(current(runtime, list)).toBe("");
    expect(current(runtime, other)).toBe("");
    expect(parameter(runtime, level, "brightness")).toBe(0.2);

    // Keys off on the second: the same key now reaches the first.
    await act(async () => {
      await seed(runtime, [{ op: "setParameters", nodeId: other, parameters: { keys: false } }]);
    });
    expect((await press(runtime, "g")).status).toBe("applied");
    expect(current(runtime, list)).toBe("1");
    expect(current(runtime, other)).toBe("");
    runtime.dispose();
  });
});

const frameAt = (frameIndex: number): FrameEvaluationInput => ({
  timeSeconds: frameIndex / 60,
  deltaSeconds: 1 / 60,
  frameIndex,
  mode: "offline",
  randomSeed: 1,
});

describe("a MIDI-driven GO pulse advances the list once per rising edge (T1500b)", () => {
  /**
   * The pad: a MIDI In node's learned channel, read by the list's GO as
   * `op('<midi>').chan.pad`. The channel RESOLVER is the stand-in — in the app it is the
   * compile's ladder, fed by Web MIDI, which no test environment has — and it is handed to
   * the hook exactly as `app.tsx` hands it. Everything from the expression inwards is real.
   */
  async function withPad(): Promise<Stage & { pad: { level: number }; channels: ChannelResolver }> {
    const staged = await stage();
    let midi = "";
    await act(async () => {
      const added = await seed(staged.runtime, [{ op: "addNode", ref: "$midi", type: "midiIn", position: { x: 0, y: -200 } }]);
      midi = added.output.createdIds["$midi"] ?? "";
      await seed(staged.runtime, [
        { op: "setParameters", nodeId: staged.list, parameters: { go: expression(`op('${nameOf(staged.runtime, midi)}').chan.pad`) } },
      ]);
    });
    expect(nameOf(staged.runtime, midi)).not.toBe("");
    const pad = { level: 0 };
    const address = `${nameOf(staged.runtime, midi)}:pad`;
    const channels: ChannelResolver = (channel) => (channel === address ? pad.level : undefined);
    return { ...staged, pad, channels };
  }

  it("a held pad is ONE GO; releasing and pressing again is the next", async () => {
    const { runtime, level, list, pad, channels } = await withPad();
    const auditBefore = runtime.bus.store.getAudit().length;
    const { result } = renderHook(() => usePulseFiring(runtime, runtime.invocation, () => channels));
    let frame = 0;
    const run = async (frames: number, padLevel: number): Promise<void> => {
      pad.level = padLevel;
      await act(async () => {
        for (let step = 0; step < frames; step += 1) {
          result.current.observe(frameAt(frame));
          frame += 1;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };

    await run(5, 0);
    expect(current(runtime, list)).toBe("");

    // Pressed and HELD for thirty frames: one rising edge, so one cue — not thirty.
    await run(30, 1);
    expect(current(runtime, list)).toBe("1");
    expect(parameter(runtime, level, "brightness")).toBe(0.3);
    expect(commandsSince(runtime, auditBefore).filter((entry) => entry === "cue.go:applied")).toHaveLength(1);

    await run(5, 0);
    expect(current(runtime, list)).toBe("1");

    // A second press, at a different velocity: any non-zero level is "on".
    await run(12, 0.4);
    expect(current(runtime, list)).toBe("2");
    expect(parameter(runtime, level, "brightness")).toBe(0.8);
    expect(commandsSince(runtime, auditBefore).filter((entry) => entry === "cue.go:applied")).toHaveLength(2);

    // Cut the wire: with no channel behind the expression the same frames move nothing.
    await run(5, 0);
    const { result: unwired } = renderHook(() => usePulseFiring(runtime, runtime.invocation, () => () => undefined));
    pad.level = 1;
    await act(async () => {
      for (let step = 0; step < 10; step += 1) unwired.current.observe(frameAt(frame + step));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(current(runtime, list)).toBe("2");
    runtime.dispose();
  });
});

describe("a take does not fire the cue list's pulses (T1500b, the design doc §5.4)", () => {
  /** GO and BACK both on a beat: `time` crossing a quarter second, as a render would step it. */
  const BEAT = "max(0, sign(time - 0.25))";

  it("live, the beat fires GO — the wire the take must cut", async () => {
    const { runtime, level, list } = await stage({ go: expression(BEAT) });
    const { result } = renderHook(() => usePulseFiring(runtime, runtime.invocation));
    await act(async () => {
      for (let frameIndex = 0; frameIndex < 40; frameIndex += 1) result.current.observe(frameAt(frameIndex));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(current(runtime, list)).toBe("1");
    expect(parameter(runtime, level, "brightness")).toBe(0.3);
    runtime.dispose();
  });

  it.each(["go", "back"] as const)("during a take the `%s` pulse fires nothing, and no stale edge fires after it", async (key) => {
    const { runtime, level, list } = await stage({ [key]: expression(BEAT) });
    // BACK needs somewhere to go back FROM, or its refusal would pass for "did not fire".
    await act(async () => {
      await runtime.bus.execute("cue.fire", { nodeId: list, cue: "2" }, runtime.invocation);
    });
    expect(current(runtime, list)).toBe("2");

    let taking = true;
    renderRangeHolderFor(runtime.bus).current = {
      busy: () => taking,
      render: async () => ({ kind: "rendered", frames: 0, fileName: null }),
    };
    const revision = runtime.bus.store.getRevision();
    const auditBefore = runtime.bus.store.getAudit().length;
    const { result } = renderHook(() => usePulseFiring(runtime, runtime.invocation));
    await act(async () => {
      for (let frameIndex = 0; frameIndex < 40; frameIndex += 1) result.current.observe(frameAt(frameIndex));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // No command at all: not the GO, and not a rejected `parameter.pulse` either.
    expect(commandsSince(runtime, auditBefore)).toEqual([]);
    expect(runtime.bus.store.getRevision()).toBe(revision);
    expect(current(runtime, list)).toBe("2");
    expect(parameter(runtime, level, "brightness")).toBe(0.8);

    // The take ends with the expression still armed. That is a LEVEL, not a new edge.
    taking = false;
    await act(async () => {
      for (let frameIndex = 40; frameIndex < 50; frameIndex += 1) result.current.observe(frameAt(frameIndex));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(commandsSince(runtime, auditBefore)).toEqual([]);
    expect(current(runtime, list)).toBe("2");
    renderRangeHolderFor(runtime.bus).current = null;
    runtime.dispose();
  });
});
