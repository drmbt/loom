// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ZodTypeAny } from "zod";

import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { inSessionKind, type LoomBus } from "@domain/commands/bus.ts";
import { isAnyInput, stringLeavesOf } from "@domain/commands/input-schema.ts";
import type { ComponentSession } from "@domain/components/session.ts";
import { isMenuSeparator, type MenuEntry } from "@domain/types/menus.ts";
import type { CommandName } from "@domain/types/commands.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { PHONE_COMMANDS } from "@devices/phone/phone-snapshot.ts";
import { DEFAULT_BINDINGS } from "@editor/keymap/defaults.ts";
import { menuSchemaFor } from "@editor/menus/schemas.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * §T1695b — THE GATES OVER EVERY COMMAND THE MOUNTED APP HOLDS, ASKED OF THE SESSION BUS
 * THE APP ITSELF OPENS ON A DIVE.
 *
 * `docs/component-session-commands-design-2026-10-06.md` measured it: the project's bus held
 * 117 commands, the session bus a dive opened held 74, and the other 43 threw
 * `UnknownCommandError` into a `void` promise when a pane inside the component fired them
 * (§B287): a button that does nothing and says nothing. Pull request #1's VNB6 was the one
 * member of that class that at least refused aloud.
 *
 * Nothing below is a list of commands. Each gate walks `bus.listCommands()` of the mounted
 * app, or a table the app's own data names commands in, and asks the session the app opened
 * (captured where `use-component-editing.ts` opens it, so a session built by a test and
 * green by construction cannot stand in for it).
 *
 * What these cannot see is said in the design doc §4: a handler that takes a canvas id and
 * resolves it against the bus's own document is caught only where a claim names it (the
 * rename below).
 */

const sessions: ComponentSession[] = [];
vi.mock("@domain/components/session.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@domain/components/session.ts")>();
  return {
    ...original,
    openComponentSession: (options: Parameters<typeof original.openComponentSession>[0]) => {
      const session = original.openComponentSession(options);
      sessions.push(session);
      return session;
    },
  };
});

const NO_WEBGPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(() => {
  cleanup();
  sessions.length = 0;
});

interface Inside {
  readonly runtime: AppRuntime;
  readonly session: ComponentSession;
  readonly instance: NodeId;
  /** A node of the PROJECT that the component does not hold. */
  readonly rootOnly: NodeId;
  readonly interior: readonly NodeId[];
}

/** The whole app around one instance of the Bloom starter component, the editor inside it. */
async function insideBloom(): Promise<Inside> {
  const { App } = await import("../../app/app.tsx");
  const { createAppRuntime } = await import("../../app/app-runtime.ts");
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester" } });
  const placed = await runtime.bus.execute("component.instantiate", { componentId: "bloom", position: { x: 0, y: 0 } }, runtime.invocation);
  const instance = placed.output.nodeId as NodeId;
  const added = await runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), label: "add", operations: [{ op: "addNode", ref: "$n", type: "noise", position: { x: 300, y: 0 } }] },
    runtime.invocation,
  );
  const rootOnly = added.output.createdIds["$n"] as NodeId;
  await act(async () => {
    render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(NO_WEBGPU)} />);
  });
  await act(async () => {
    await runtime.bus.execute("graph.diveIn", { nodeId: instance }, runtime.invocation);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const session = sessions.at(-1);
  if (session === undefined) throw new Error("the dive opened no session");
  // The precondition, asserted: the editor IS inside, through the app's own session.
  expect(session.componentId).toBe("bloom");
  expect(session.bus.parent).toBe(runtime.bus);
  const interior = Object.keys(session.store.view.getGraph().nodes).sort();
  expect(interior.length).toBeGreaterThan(1);
  expect(interior).not.toContain(rootOnly);
  return { runtime, session, instance, rootOnly, interior };
}

/** Every command a table of the app's own DATA names, with where. */
function namedByData(bus: LoomBus): Array<{ readonly what: string; readonly command: string }> {
  const rows: Array<{ what: string; command: string }> = [];
  for (const binding of DEFAULT_BINDINGS) rows.push({ what: `key binding ${binding.id}`, command: binding.command });
  const walk = (surface: string, entries: readonly MenuEntry[]): void => {
    for (const entry of entries) {
      if (isMenuSeparator(entry)) continue;
      if (entry.command !== undefined) rows.push({ what: `${surface} menu "${entry.label}"`, command: entry.command });
      if (entry.submenu !== undefined) walk(surface, entry.submenu);
    }
  };
  for (const surface of ["canvas", "node", "port", "edge", "parameter", "control"] as const) {
    walk(surface, menuSchemaFor(surface, bus.registry).entries);
  }
  for (const definition of bus.registry.list()) {
    for (const [key, parameter] of Object.entries(definition.parameters)) {
      if (parameter.type === "pulse") rows.push({ what: `pulse ${definition.type}.${key}`, command: parameter.fires });
    }
  }
  for (const command of PHONE_COMMANDS) rows.push({ what: "the phone", command });
  return rows;
}

describe("§T1695b — every command, asked of the session the app opens on a dive", () => {
  it("B287: none is unknown there, and none throws; and the project holds the same commands as before the dive", async () => {
    const { runtime, session } = await insideBloom();
    const names = runtime.bus.listCommands();
    // The registry IS the derivation: an empty one would pass vacuously (§V707).
    expect(names.length).toBeGreaterThan(100);

    const dry = { ...runtime.invocation, dryRun: true };
    const trouble: string[] = [];
    for (const name of names) {
      if (!session.bus.hasCommand(name)) {
        trouble.push(`${name}: the session does not offer it (declared ${JSON.stringify(runtime.bus.inSessionOf(name))})`);
        continue;
      }
      try {
        await act(async () => session.bus.execute(name as CommandName, {} as never, dry));
      } catch (thrown) {
        trouble.push(`${name}: THROWS ${(thrown as Error).name}: ${(thrown as Error).message}`);
      }
    }
    expect(trouble).toEqual([]);
    // One list for the palette and the gates, whichever bus is asked.
    expect(session.bus.listCommands()).toEqual(names);
  });

  it("G2: every command the app's data names is one a session can run", async () => {
    const { runtime, session } = await insideBloom();
    const rows = namedByData(runtime.bus);
    // Bindings, menu rows, pulses and the phone: well over a hundred rows when this was written.
    expect(rows.length).toBeGreaterThan(100);
    // A row whose command nothing registers anywhere is §T77's "unresolved", and not this gate's.
    const reachable = rows.filter((row) => runtime.bus.hasCommand(row.command));
    expect(reachable.length).toBeGreaterThan(90);
    expect(reachable.filter((row) => !session.bus.hasCommand(row.command)).map((row) => `${row.what} → ${row.command}`)).toEqual([]);
  });

  it("G5: every definition command the project holds, the session holds its OWN copy of", async () => {
    const { runtime, session } = await insideBloom();
    const definition = runtime.bus.listCommands().filter((name) => inSessionKind(runtime.bus.inSessionOf(name)!) === "definition");
    expect(definition.length).toBeGreaterThan(50);
    expect(definition.filter((name) => !session.bus.ownsCommand(name))).toEqual([]);
    // And the mirror: what is not a definition command, the session holds NO copy of.
    const inherited = runtime.bus.listCommands().filter((name) => inSessionKind(runtime.bus.inSessionOf(name)!) !== "definition");
    expect(inherited.length).toBeGreaterThan(40);
    expect(inherited.filter((name) => session.bus.ownsCommand(name))).toEqual([]);
  });

  it("G3: an inherited command's strings are classified, and an instance command's addresses all arrive on the instance in view", async () => {
    const { runtime, session, instance } = await insideBloom();
    const unclassified: string[] = [];
    const instanceCommands: string[] = [];
    for (const name of runtime.bus.listCommands()) {
      const kind = inSessionKind(runtime.bus.inSessionOf(name)!);
      if (kind === "definition") continue;
      const schema = runtime.bus.inputSchemaOf(name);
      if (schema === undefined || isAnyInput(schema)) {
        if (kind === "instance") unclassified.push(`${name}: an instance command with ANY_INPUT cannot be addressed`);
        continue;
      }
      const leaves = stringLeavesOf(schema as ZodTypeAny);
      if (kind === "app") {
        // An app command names no node of a document. A canvas id is not one.
        unclassified.push(...leaves.filter((leaf) => leaf.kind === "node").map((leaf) => `${name}: app, and ${leaf.path} is a document node address`));
      } else {
        instanceCommands.push(name);
        unclassified.push(...leaves.filter((leaf) => leaf.kind === "unmarked").map((leaf) => `${name}: instance, and ${leaf.path} is a string nobody declared`));
        if (!leaves.some((leaf) => leaf.kind === "node")) unclassified.push(`${name}: instance, and its input names no node`);
      }
    }
    expect(unclassified).toEqual([]);
    // The four a pulse fires, at least (the app registers them from hooks, so they are here).
    expect(instanceCommands).toEqual(expect.arrayContaining(["media.cue", "media.reload", "runtime.resetFeedback", "runtime.resetInference"]));

    // The rewrite, exercised: a sentinel in every address, through the session, into the project's bus.
    const seen: Array<readonly [string, unknown]> = [];
    const real = runtime.bus.execute.bind(runtime.bus);
    const spy = vi.spyOn(runtime.bus, "execute").mockImplementation(((name: CommandName, input: never, context: never) => {
      seen.push([name, input]);
      return real(name, input, context);
    }) as never);
    const dry = { ...runtime.invocation, dryRun: true };
    for (const name of instanceCommands) {
      const leaves = stringLeavesOf(runtime.bus.inputSchemaOf(name) as ZodTypeAny).filter((leaf) => leaf.kind === "node");
      const input: Record<string, unknown> = {};
      for (const leaf of leaves) {
        // Every address these commands take is a top-level id or list of ids; a deeper one fails here and is built then.
        expect(leaf.path, `${name}: an address deeper than this gate builds`).toMatch(/^[A-Za-z]+(\[\])?$/);
        if (leaf.path.endsWith("[]")) input[leaf.path.slice(0, -2)] = ["sentinel"];
        else input[leaf.path] = "sentinel";
      }
      seen.length = 0;
      await act(async () => session.bus.execute(name as CommandName, input as never, dry));
      const arrived = seen.find(([command]) => command === name)?.[1];
      expect(JSON.stringify(arrived), name).toBe(JSON.stringify(input).replaceAll("sentinel", `${instance}/sentinel`));
    }
    spy.mockRestore();
  });

  it("G4: no definition command run on the session touches the project", async () => {
    const { runtime, session, rootOnly } = await insideBloom();
    const root = runtime.bus.store;
    const before = { revision: root.getRevision(), graph: root.getGraph(), audit: root.getAudit().length };
    const definition = session.bus
      .listCommands()
      .filter((name) => session.bus.ownsCommand(name))
      // A command that declared it hands up is MEANT to reach the project on that arm, which has its own claims.
      .filter((name) => typeof session.bus.inSessionOf(name) === "string");
    expect(definition.length).toBeGreaterThan(50);

    // Three shapes of call, each with a node only the PROJECT holds: the id §B286's key sent.
    let reachedAHandler = 0;
    for (const name of definition) {
      for (const input of [{}, { nodeIds: [rootOnly] }, { nodeId: rootOnly }]) {
        try {
          const result = await act(async () => session.bus.execute(name as CommandName, input as never, runtime.invocation));
          if (!result.diagnostics.some((each) => each.code === "command.input")) reachedAHandler += 1;
          // Whatever it answered, it did not act on the project's node.
          expect(result.status === "applied" && JSON.stringify(result.output).includes(rootOnly), `${name} acted on a project node`).toBe(false);
        } catch {
          // A command with no rejectionOutput throws its refusal; the project is checked below either way.
        }
      }
    }
    // The gate read something: 29 of these calls got past the input schema to a handler when
    // this was written (the rest are refused for their shape, which is also not touching it).
    expect(reachedAHandler).toBeGreaterThan(20);
    expect(root.getRevision()).toBe(before.revision);
    expect(root.getGraph()).toBe(before.graph);
    expect(root.getGraph().nodes[rootOnly]).toBeDefined();
    expect(root.getAudit().length).toBe(before.audit);
  });

  it("G4, the mirror: an inherited command leaves the component's own store alone", async () => {
    const { runtime, session } = await insideBloom();
    const before = { revision: session.store.view.getRevision(), audit: session.store.view.getAudit().length };
    const dry = { ...runtime.invocation, dryRun: true };
    for (const name of session.bus.listCommands().filter((each) => !session.bus.ownsCommand(each))) {
      try {
        await act(async () => session.bus.execute(name as CommandName, {} as never, dry));
      } catch {
        // A refusal with no rejectionOutput is thrown; the store is checked below either way.
      }
    }
    expect(session.store.view.getRevision()).toBe(before.revision);
    expect(session.store.view.getAudit().length).toBe(before.audit);
  });
});

describe("§T1695b — a canvas command inside a component is answered by the canvas", () => {
  /**
   * The regression inheritance would have made, and §T1195's M1 that it closes instead.
   * `ui.beginRename` asked the BUS's document whether the node exists. Inherited, that is the
   * project's, while the canvas shows the component's inside: the title's own double-click
   * (the session bus) and the rename key (the project's bus) both named a node the project
   * does not hold. Measured before: `rename.unknownNode` from the key.
   */
  it("rename begins on an interior node from either bus, and still refuses a node the canvas does not show", async () => {
    const { runtime, session, interior, instance } = await insideBloom();
    const inner = interior[0] as NodeId;

    const fromCanvas = await act(async () => session.bus.execute("ui.beginRename", { nodeIds: [inner] }, runtime.invocation));
    expect(fromCanvas.status, fromCanvas.diagnostics.map((each) => each.code).join(",")).toBe("applied");
    expect(fromCanvas.output.editing).toBe(inner);
    const fromKey = await act(async () => runtime.bus.execute("ui.beginRename", { nodeIds: [interior[1] as NodeId] }, runtime.invocation));
    expect(fromKey.status, fromKey.diagnostics.map((each) => each.code).join(",")).toBe("applied");
    expect(fromKey.output.editing).toBe(interior[1]);

    // The instance is a node of the PROJECT, which this canvas is not showing.
    const stale = await act(async () => runtime.bus.execute("ui.beginRename", { nodeIds: [instance] }, runtime.invocation));
    expect(stale.status).toBe("rejected");
    expect(stale.diagnostics.map((each) => each.code)).toEqual(["rename.unknownNode"]);
  });
});
