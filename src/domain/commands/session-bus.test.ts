import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { NodeId } from "../types/ids.ts";
import { createGraphStore } from "../graph/store.ts";
import { enteredThrough, fromInstance, toInstance } from "../components/addressing.ts";
import { createTestRegistry } from "../../nodes/registry/test-nodes.ts";
import { UnknownCommandError, type CommandContext, type InSession, type LoomBus } from "./bus.ts";
import { commandHolder, sharedForBus, sharedForDocument } from "./command-holder.ts";
import { createDomainBus } from "./index.ts";
import { NO_INPUT, canvasNodeIdsInput, idInput, nodeIdInput, nodeIdsInput, rewriteNodeAddresses, stringLeavesOf } from "./input-schema.ts";
import { alice, contextFor, createHarness, patch } from "./test-support.ts";

/**
 * §T1695b — A COMPONENT SESSION'S BUS HAS A PARENT, AND EVERY COMMAND SAYS WHAT IT MEANS THERE.
 *
 * The bus half of the rule, on two real buses over two real stores: the project's, and a
 * session's whose `parent` it is. The commands under test are doubles that record what
 * reached them, declared the three ways a command can be (`InSession`).
 *
 * What each claim would let through if it went: a graph edit that falls through to the
 * project patches it with a component's ids (§B286); an instance command that is not
 * rewritten clears the wrong loop, or none; one that is rewritten when it should not be
 * (an `app` command, a canvas id) names a node nobody has.
 */

declare module "../types/commands.ts" {
  interface CommandMap {
    "test.app": { input: { nodeIds?: readonly string[]; note?: string }; output: { ran: string } };
    "test.instance": { input: { nodeIds?: readonly string[]; nodeId?: string }; output: { ran: string } };
    "test.edit": { input: { nodeId?: string }; output: { ran: string } };
    "test.handsUp": { input: { nodeId: string; up?: boolean }; output: { ran: string } };
  }
}

const ctx = contextFor(alice);

interface Pair {
  readonly root: LoomBus;
  readonly session: LoomBus;
  /** `[bus, command, input, dryRun]` for every handler that ran. */
  readonly ran: Array<readonly [string, string, unknown, boolean]>;
  path: readonly NodeId[] | undefined;
}

function double(bus: LoomBus, where: string, name: "test.app" | "test.instance" | "test.edit" | "test.handsUp", inSession: InSession, ran: Pair["ran"]): void {
  const schemas = {
    "test.app": z.object({ nodeIds: canvasNodeIdsInput.optional(), note: z.string().optional() }).strict(),
    "test.instance": z.object({ nodeIds: nodeIdsInput.optional(), nodeId: nodeIdInput.optional() }).strict(),
    "test.edit": z.object({ nodeId: nodeIdInput.optional() }).strict(),
    "test.handsUp": z.object({ nodeId: nodeIdInput, up: z.boolean().optional() }).strict(),
  };
  bus.registerCommand({
    name,
    inSession,
    inputSchema: schemas[name],
    handler: async (input: { up?: boolean; nodeId?: string }, context: CommandContext) => {
      ran.push([where, name, input, context.dryRun]);
      if (input.up === true && context.session !== undefined) return context.session.handUp();
      if (name === "test.instance" && input.nodeId === "session/missing") {
        return { status: "rejected", output: { ran: where }, diagnostics: [{ severity: "error", code: "test.missing", message: "no", nodeId: input.nodeId }] };
      }
      return { status: context.dryRun ? "validated" : "applied", output: { ran: where } };
    },
    rejectionOutput: () => ({ ran: "refused" }),
  } as never);
}

function pair(): Pair {
  const { bus: root } = createHarness("r");
  const ran: Pair["ran"] = [];
  double(root, "root", "test.app", "app", ran);
  double(root, "root", "test.instance", "instance", ran);
  double(root, "root", "test.edit", "definition", ran);
  double(root, "root", "test.handsUp", { definition: true, handsUp: "when asked to" }, ran);
  const made: Pair = { root, session: root, ran, path: ["outer", "session"] };
  const { bus: session } = createDomainBus({
    store: createGraphStore(),
    registry: createTestRegistry().view(),
    parent: root,
    scope: { subject: () => 'component "Kit"', instancePath: () => made.path },
  });
  double(session, "session", "test.handsUp", { definition: true, handsUp: "when asked to" }, ran);
  return { ...made, session, get path() { return made.path; }, set path(next) { made.path = next; } };
}

describe("§T1695b — one address for a node of an instance", () => {
  it("joins the editor's path and takes it apart again", () => {
    expect(toInstance([], "fb")).toBe("fb");
    expect(toInstance(["two"], "fb")).toBe("two/fb");
    // The EDITOR's path: each id lives in the graph the one before it opened (§T1216).
    expect(toInstance(["outer", "two"], "fb")).toBe("outer/two/fb");

    expect(fromInstance(["outer", "two"], "outer/two/fb")).toBe("fb");
    // Not a node of THAT instance: another's, the root's, or one nested deeper inside it.
    expect(fromInstance(["two"], "one/fb")).toBeUndefined();
    expect(fromInstance(["two"], "fb")).toBeUndefined();
    expect(fromInstance(["two"], "two/inner/fb")).toBeUndefined();
    // A prefix that is only a prefix of the NAME is not the instance.
    expect(fromInstance(["two"], "two2/fb")).toBeUndefined();

    expect(enteredThrough("two/inner/fb")).toEqual({ instance: "two", rest: "inner/fb" });
    expect(enteredThrough("fb")).toBeUndefined();
  });
});

describe("§T1695b — which strings of an input are node addresses comes from its schema", () => {
  const schema = z
    .object({
      nodeId: nodeIdInput,
      nodeIds: nodeIdsInput.optional(),
      onCanvas: canvasNodeIdsInput.optional(),
      parameterKey: idInput,
      targets: z.array(z.object({ nodeId: nodeIdInput, key: z.string() }).strict()).optional(),
      either: z.union([z.object({ nodeIds: nodeIdsInput }).strict(), z.object({ all: z.literal(true) }).strict()]).optional(),
    })
    .strict();

  it("names every string, and how it is declared", () => {
    expect(stringLeavesOf(schema)).toEqual([
      { path: "nodeId", kind: "node" },
      { path: "nodeIds[]", kind: "node" },
      { path: "onCanvas[]", kind: "canvas" },
      { path: "parameterKey", kind: "unmarked" },
      { path: "targets[].nodeId", kind: "node" },
      { path: "targets[].key", kind: "unmarked" },
      { path: "either.nodeIds[]", kind: "node" },
    ]);
    // `.extend` carries the mark; a refinement mints a new schema and loses it, which the
    // gate over the registered commands then reports as an unmarked string.
    expect(stringLeavesOf(schema.extend({ more: nodeIdInput.optional() })).at(-1)).toEqual({ path: "more", kind: "node" });
    expect(stringLeavesOf(z.object({ nodeId: nodeIdInput.max(8) }))).toEqual([{ path: "nodeId", kind: "unmarked" }]);
  });

  it("rewrites the node addresses and nothing else", () => {
    const input = {
      nodeId: "a",
      nodeIds: ["b", "c"],
      onCanvas: ["d"],
      parameterKey: "a",
      targets: [{ nodeId: "e", key: "a" }],
      either: { nodeIds: ["f"] },
    };
    expect(rewriteNodeAddresses(schema, input, (id) => `two/${id}`)).toEqual({
      nodeId: "two/a",
      nodeIds: ["two/b", "two/c"],
      // A canvas id names what the canvas shows, and a key that happens to spell a node's id is a key.
      onCanvas: ["d"],
      parameterKey: "a",
      targets: [{ nodeId: "two/e", key: "a" }],
      either: { nodeIds: ["two/f"] },
    });
    // The other arm of the union holds no address; input the schema would refuse comes back as it was.
    expect(rewriteNodeAddresses(schema, { ...input, either: { all: true } }, (id) => `two/${id}`)).toMatchObject({ either: { all: true } });
    expect(rewriteNodeAddresses(schema, { nodeId: 7, nodeIds: "b" }, (id) => `two/${id}`)).toEqual({ nodeId: 7, nodeIds: "b" });
  });
});

describe("§T1695b — what a session bus does with a command, by the command's declaration", () => {
  it("an app command runs on the parent, input unchanged", async () => {
    const { session, ran } = pair();
    expect(session.hasCommand("test.app")).toBe(true);
    expect(session.ownsCommand("test.app")).toBe(false);
    const result = await session.execute("test.app", { nodeIds: ["x"], note: "x" }, ctx);
    expect(result.status).toBe("applied");
    expect(ran).toEqual([["root", "test.app", { nodeIds: ["x"], note: "x" }, false]]);
  });

  it("an instance command runs on the parent, addressed at the instance in view; the answer names the session's node", async () => {
    const made = pair();
    const result = await made.session.execute("test.instance", { nodeIds: ["fb"], nodeId: "missing" }, ctx);
    // The whole path, the editor's way.
    expect(made.ran).toEqual([["root", "test.instance", { nodeIds: ["outer/session/fb"], nodeId: "outer/session/missing" }, false]]);
    expect(result.status).toBe("applied");

    // One session outlives a move between two instances: the path is read at each call.
    made.path = ["session"];
    const refused = await made.session.execute("test.instance", { nodeId: "missing" }, ctx);
    expect(made.ran.at(-1)?.[2]).toEqual({ nodeId: "session/missing" });
    // A diagnostic about a node of the instance comes back under the name the session knows it by.
    expect(refused.diagnostics).toEqual([{ severity: "error", code: "test.missing", message: "no", nodeId: "missing" }]);
  });

  it("an address that is absent stays absent, and a dry run stays a dry run", async () => {
    const { session, ran } = pair();
    const result = await session.execute("test.instance", {}, { ...ctx, dryRun: true });
    expect(result.status).toBe("validated");
    expect(ran).toEqual([["root", "test.instance", {}, true]]);
  });

  it("an instance command with no instance in view is refused by name, on the parent's record", async () => {
    const made = pair();
    made.path = undefined;
    const audit = made.root.store.getAudit().length;
    const result = await made.session.execute("test.instance", { nodeIds: ["fb"] }, ctx);
    expect(result.status).toBe("rejected");
    expect(result.output).toEqual({ ran: "refused" });
    expect(result.diagnostics).toEqual([
      {
        severity: "error",
        code: "session.noInstance",
        message: '"test.instance" acts on a running instance of component "Kit", and this editor is not open through one.',
        suggestion: "Open the component from one of its instances in the project, then try again.",
      },
    ]);
    expect(made.ran).toEqual([]);
    expect(made.root.store.getAudit().slice(audit).map((entry) => `${entry.command}:${entry.status}`)).toEqual(["test.instance:rejected"]);
  });

  it("a definition command is the session's own or nothing: it never reaches the parent", async () => {
    const { root, session, ran } = pair();
    // The project holds `test.edit`; the session holds no copy. It is not offered, and asking
    // for it says what is wrong rather than patching the project (§B286's cause).
    expect(session.hasCommand("test.edit")).toBe(false);
    expect(session.listCommands()).not.toContain("test.edit");
    expect(session.inputSchemaOf("test.edit")).toBeUndefined();
    await expect(session.execute("test.edit", { nodeId: "x" }, ctx)).rejects.toThrow(UnknownCommandError);
    await expect(session.execute("test.edit", { nodeId: "x" }, ctx)).rejects.toThrow(/edits a graph, and this editor of component "Kit" holds no copy of it/);
    expect(ran).toEqual([]);

    // The real thing: an undo on the session with nothing to undo refuses THERE. The
    // project's last edit stands.
    await root.execute("graph.applyPatch", patch(0, [{ op: "addNode", ref: "$n", type: "test.solid", position: { x: 0, y: 0 } }]), ctx);
    const revision = root.store.getRevision();
    const undone = await session.execute("graph.undo", {}, ctx);
    expect(undone.status).toBe("rejected");
    expect(root.store.getRevision()).toBe(revision);
    expect(Object.keys(root.store.getGraph().nodes)).toHaveLength(1);
  });

  it("a session does not register its own copy of a command it inherits", () => {
    const { session, ran } = pair();
    expect(() => double(session, "session", "test.app", "app", ran)).toThrow(/is inherited from the parent bus \(declared "app"\)/);
    // And a real one: the project's settings are the project's (§B291).
    expect(session.ownsCommand("project.setSettings")).toBe(false);
    expect(session.hasCommand("project.setSettings")).toBe(true);
  });

  it("a definition command hands a call up only where it declared it would", async () => {
    const made = pair();
    const stays = await made.session.execute("test.handsUp", { nodeId: "looks" }, ctx);
    expect(stays.output).toEqual({ ran: "session" });
    const up = await made.session.execute("test.handsUp", { nodeId: "looks", up: true }, ctx);
    // The parent's handler ran, addressed at the instance in view; the session's revision is the answer's.
    expect(up.output).toEqual({ ran: "root" });
    expect(made.ran.at(-1)).toEqual(["root", "test.handsUp", { nodeId: "outer/session/looks", up: true }, false]);
    expect(up.revision).toBe(made.session.store.getRevision());

    // Undeclared, the same call is a defect and says so: registered on a session of its own.
    const { bus: root } = createHarness("u");
    double(root, "root", "test.edit", "definition", made.ran);
    const { bus: session } = createDomainBus({ store: createGraphStore(), registry: createTestRegistry().view(), parent: root });
    session.registerCommand({
      name: "test.edit",
      inSession: "definition",
      inputSchema: NO_INPUT,
      handler: (_input: unknown, context: { session?: { handUp: () => Promise<never> } }) => context.session!.handUp(),
    } as never);
    await expect(session.execute("test.edit", {}, ctx)).rejects.toThrow(/handed a call up without declaring handsUp/);
  });
});

describe("§T1695b — a registration says what it means inside a session, or does not register", () => {
  it("refuses a command with no inSession, and an instance command that cannot answer a refusal", () => {
    const { bus } = createHarness("g");
    const handler = () => ({ status: "applied" as const, output: { ran: "x" } });
    expect(() => bus.registerCommand({ name: "test.app", inputSchema: NO_INPUT, handler } as never)).toThrow(
      'Command "test.app" is registered without saying what it means inside a component session (inSession, §T1695b).',
    );
    expect(() => bus.registerCommand({ name: "test.instance", inSession: "instance", inputSchema: NO_INPUT, handler } as never)).toThrow(
      /is declared "instance" and has no rejectionOutput/,
    );
    // An instance command's addresses are rewritten FROM ITS SCHEMA, so the schema has to
    // declare them: a plain string would reach the project as the definition's bare id.
    const rejectionOutput = () => ({ ran: "refused" });
    expect(() =>
      bus.registerCommand({ name: "test.instance", inSession: "instance", inputSchema: z.object({ nodeIds: z.array(z.string()) }), handler, rejectionOutput } as never),
    ).toThrow(/every string of its input is a node address .* undeclared: nodeIds\[\]/);
    expect(() =>
      bus.registerCommand({ name: "test.instance", inSession: "instance", inputSchema: NO_INPUT, handler, rejectionOutput } as never),
    ).toThrow(/at least one is an address/);
    expect(bus.hasCommand("test.app")).toBe(false);
    expect(bus.hasCommand("test.instance")).toBe(false);
  });
});

describe("§T1695b — what a command holds is the app's, kept at the root", () => {
  it("one holder for the project's bus and every session's; a document's own state stays its own", () => {
    const { root, session } = pair();
    // The canvas inside a component fills the holder the project's command reads (§T1195's M2, M3).
    expect(commandHolder(session, "test.surface")).toBe(commandHolder(root, "test.surface"));
    expect(sharedForBus(session, "test.store", () => ({}))).toBe(sharedForBus(root, "test.store", () => ({})));
    // The component a session edits is a fact about THAT bus.
    expect(sharedForDocument(session, "test.host", () => ({}))).not.toBe(sharedForDocument(root, "test.host", () => ({})));
    expect(session.root).toBe(root);
    expect(root.root).toBe(root);
  });
});
