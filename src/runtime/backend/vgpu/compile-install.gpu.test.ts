import { Buffer } from "node:buffer";

import { beforeAll, describe, expect, it } from "vitest";

import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import type { GpuHost, GpuSession } from "./gpu-host.ts";
import { BackendDiagnosticCode } from "../diagnostics.ts";
import type { LogicalExecutionPlan } from "../../../domain/types/backend.ts";

/**
 * §T1529b + §T1528b — WHAT `compile()` INSTALLS WHEN SOMETHING GOES WRONG BETWEEN BUILD
 * AND INSTALL, on Dawn, through the real backend.
 *
 * A structural compile builds a resource set that CARRIES every unchanged object from the
 * installed program (§V22), waits for the device's verdict, then installs. Three ways the
 * stretch after the build can go wrong, and what each must leave behind:
 *
 * 1. §T1529b — the uniform flush throws. It used to run after `program` was reassigned and
 *    the previous program's objects released, so the throw left a program installed whose
 *    plan nobody was told about, and the program the caller still holds was gone. Now the
 *    previous program stays installed, flagged stale, renders the same bytes, and none of
 *    the objects it shares with the failed build is destroyed.
 * 2. §T1528b — the device is lost while the compile waits. `rebuild()` rebuilds the
 *    installed program on a new device; the compile then installed a set built on the dead
 *    one, and released the live rebuilt objects as "the previous program's". Now the
 *    compile starts over against what is installed, and the plan it was given renders.
 * 3. §B235 without `compile-latest.ts`'s queue — a second direct caller's compile installs
 *    while this one waits, releasing objects this one carried. Same cause as 2 (the carry's
 *    source is no longer what is installed), same answer.
 *
 * Every target is one constant colour, so every expected byte is written down, not
 * measured (§V147).
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const SIZE = 4;
const COLOR_WGSL = `struct Params { color: vec4f };
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f { return params.color; }`;

type Color = readonly number[];
const RED: Color = [1, 0, 0, 1];
const GREEN: Color = [0, 1, 0, 1];
const BLUE: Color = [0, 0, 1, 1];
const WHITE: Color = [1, 1, 1, 1];

/** One constant-colour pass per entry, each into its own target, in this order. */
function plan(colors: Readonly<Record<string, Color>>): LogicalExecutionPlan {
  const ids = Object.keys(colors);
  return {
    resources: ids.map((id) => ({ kind: "target", id, size: [SIZE, SIZE], format: "rgba8unorm" })),
    passes: ids.map((id) => ({
      kind: "effect",
      id,
      nodeId: `n-${id}`,
      shader: COLOR_WGSL,
      target: id,
      uniformBinding: "params",
      uniforms: { color: colors[id] },
    })),
    diagnostics: [],
  } as unknown as LogicalExecutionPlan;
}

function inputs(frameIndex: number) {
  return {
    frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 1 },
    pointer: { x: 0, y: 0, buttons: 0 },
    resolution: [SIZE, SIZE],
  } as never;
}

/** Every pixel of a target filled with `color`, as rgba8unorm bytes. */
const filled = (color: Color): Buffer =>
  Buffer.from(Array.from({ length: SIZE * SIZE }, () => color.map((channel) => Math.round(channel * 255))).flat());

/**
 * `nodeGpuHost()` that remembers every session it made and can hold the device settle a
 * structural compile awaits between building and installing — per waiter, so a test can
 * let one parked compile through and keep the next one parked.
 */
function holdingHost() {
  const inner = nodeGpuHost();
  const sessions: GpuSession[] = [];
  let held = false;
  const parked: Array<() => void> = [];
  const host: GpuHost = {
    label: inner.label,
    async create(options) {
      const session = await inner.create(options);
      const gpu = session.gpu as unknown as { settled(): Promise<void> };
      const settled = gpu.settled.bind(gpu);
      gpu.settled = () => (held ? new Promise<void>((resolve) => parked.push(resolve)).then(settled) : settled());
      sessions.push(session);
      return session;
    },
  };
  return {
    host,
    sessions,
    hold: () => {
      held = true;
    },
    /**
     * Stops holding and resumes only the longest-parked compile: the others stay parked
     * where they are, so the one let through runs to its end alone (each compile settles
     * more than once, and none of its later settles is held).
     */
    letFirstThrough: () => {
      held = false;
      parked.shift()?.();
    },
    releaseAll: () => {
      held = false;
      for (const resume of parked.splice(0)) resume();
    },
    parked: () => parked.length,
  };
}

async function until(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function stage() {
  if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
  const holding = holdingHost();
  const backend = createVgpuBackend({ host: holding.host });
  const reported: Array<{ code: string; line: string }> = [];
  backend.onDiagnostic((entry) => {
    if (entry.severity !== "info") reported.push({ code: entry.code, line: `${entry.severity} ${entry.code}: ${entry.message}` });
  });
  await backend.initialize({});
  const read = async (id: string): Promise<Buffer> => Buffer.from((await backend.readOutput(id)).bytes);
  return { backend, holding, reported, read };
}

describe("§T1529b — a throw after the build leaves the previous program installed", () => {
  it("the flush rejects a value: the old program renders the same bytes, nothing it shares was destroyed", async () => {
    const { backend, reported, read } = await stage();
    try {
      const before = await backend.compile(plan({ a: RED, b: BLUE }));
      backend.render(before, inputs(1));
      const aBefore = await read("a");
      const bBefore = await read("b");
      expect(aBefore.equals(filled(RED))).toBe(true);
      expect(bBefore.equals(filled(BLUE))).toBe(true);
      expect(reported).toEqual([]);

      // Structural (pass `c` is new), so this is a build that carries `a` and `b` — their
      // effects, targets and uniform blocks — from the installed program. `a` asks for a
      // new, valid colour, which the flush writes into the block `before` still draws
      // with; `b` hands a vec4f three numbers, which only the flush can find out (the
      // structure key holds uniform NAMES, not shapes), and it throws there, after `a`.
      const broken = plan({ a: GREEN, b: [1, 1, 1], c: WHITE });
      await expect(backend.compile(broken)).rejects.toThrow();
      expect(backend.status.stale).toBe(true);
      expect(reported.map((entry) => entry.code)).toEqual([BackendDiagnosticCode.compileFailed]);
      reported.length = 0;

      // The program the caller still holds is the installed one: it renders (no
      // planNotCurrent skip), with its own colour in `a` — not the GREEN the failed flush
      // wrote into the block they share — and with every carried object alive (a
      // destroyed target or block fails the frame or the readback).
      backend.render(before, inputs(2));
      expect(reported).toEqual([]);
      expect((await read("a")).equals(aBefore)).toBe(true);
      expect((await read("b")).equals(bBefore)).toBe(true);

      // And the backend is not wedged: the corrected plan installs from the same program.
      const fixed = await backend.compile(plan({ a: GREEN, b: WHITE, c: WHITE }));
      expect(backend.status.stale).toBe(false);
      backend.render(fixed, inputs(3));
      expect((await read("a")).equals(filled(GREEN))).toBe(true);
      expect((await read("b")).equals(filled(WHITE))).toBe(true);
      expect((await read("c")).equals(filled(WHITE))).toBe(true);
      expect(reported).toEqual([]);
    } finally {
      backend.dispose();
    }
  }, 60_000);
});

describe("§T1528b — a compile outlived by its carry starts over", () => {
  it("device lost while the compile waits on the settle: the rebuilt program is carried from, the new plan renders", async () => {
    const { backend, holding, reported, read } = await stage();
    try {
      const before = await backend.compile(plan({ a: RED, b: BLUE }));
      backend.render(before, inputs(1));
      expect((await read("a")).equals(filled(RED))).toBe(true);
      const generation = backend.status.deviceGeneration;

      // Built on device 1, carrying `a` and `b` from the program on device 1, then parked.
      holding.hold();
      const pending = backend.compile(plan({ a: GREEN, b: BLUE, c: WHITE }));
      const outcome = pending.then(
        (compiled) => ({ compiled }),
        (error: unknown) => ({ error }),
      );
      await until(() => holding.parked() === 1, "the compile to park between build and install");

      // A real loss on Dawn: device 1 destroyed. The backend's §V23 recovery rebuilds the
      // installed program — `before`'s plan — on device 2 while the compile is parked.
      const first = holding.sessions[0];
      if (first === undefined) throw new Error("the host made no session");
      (first.gpu.gpu as GPUDevice).destroy();
      await until(() => backend.status.deviceGeneration > generation, "the device-loss rebuild");
      expect(holding.sessions).toHaveLength(2);

      holding.releaseAll();
      const settled = await outcome;
      if ("error" in settled) throw new Error(`the compile failed: ${String(settled.error)}`);
      expect(backend.status.stale).toBe(false);
      expect(backend.status.halted).toBe(false);

      backend.render(settled.compiled, inputs(2));
      expect((await read("a")).equals(filled(GREEN))).toBe(true);
      expect((await read("b")).equals(filled(BLUE))).toBe(true);
      expect((await read("c")).equals(filled(WHITE))).toBe(true);
      // The loss itself is reported, and nothing else is: no dead-object frame error, no
      // compile failure.
      expect(reported.map((entry) => entry.code)).toEqual([BackendDiagnosticCode.deviceLost]);
    } finally {
      holding.releaseAll();
      backend.dispose();
    }
  }, 60_000);

  it("§B235 by direct callers: a compile that installs while another waits does not hand it destroyed objects", async () => {
    const { backend, holding, reported, read } = await stage();
    try {
      await backend.compile(plan({ a: RED, b: BLUE }));

      // Both carry from the program with `a` and `b`. `dropB` drops `b`; `addC` keeps `b`
      // (carried) and adds `c`. Both park; `dropB` is let through first and installs,
      // which releases `b`'s effect, target and uniform block — the ones `addC` carried.
      holding.hold();
      const dropB = backend.compile(plan({ a: RED }));
      const addC = backend.compile(plan({ a: RED, b: BLUE, c: WHITE }));
      await until(() => holding.parked() === 2, "both compiles to park");
      holding.letFirstThrough();
      await dropB;
      holding.releaseAll();

      const compiled = await addC;
      expect(backend.status.stale).toBe(false);
      backend.render(compiled, inputs(1));
      expect((await read("a")).equals(filled(RED))).toBe(true);
      expect((await read("b")).equals(filled(BLUE))).toBe(true);
      expect((await read("c")).equals(filled(WHITE))).toBe(true);
      expect(reported).toEqual([]);
    } finally {
      holding.releaseAll();
      backend.dispose();
    }
  }, 60_000);
});
