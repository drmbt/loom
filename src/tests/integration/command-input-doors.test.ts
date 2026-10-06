import { describe, expect, it } from "vitest";

import { createPhoneWrites } from "@/app/phone-writes.ts";
import { createAgentToolSurface } from "@agent/surface.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { agent, alice, contextFor } from "@domain/commands/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { serializePresetBank } from "@domain/presets/index.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { serializePanelBoard } from "@nodes/definitions/controls.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";

/**
 * §T1556b — ONE MALFORMED INPUT, ONE REFUSAL, WHICHEVER DOOR IT CAME IN BY.
 *
 * `bus.execute` used to parse nothing: the agent surface validated its tool input, the phone
 * vetted its writes, and every other door — a menu row, a keybind, the palette, anything that
 * calls `execute` itself — handed input straight to the handler. The case below is the one
 * that made it matter: `preset.recall` with `name: 42`. The agent refused it. The handler,
 * reached directly, read "no string name" as "no name" and RECALLED THE BANK'S SELECT — a
 * malformed call that changed the document, on every door but one.
 *
 * Now the registration carries the schema and the bus parses it before the handler runs, so
 * the direct door is refused in the bus's sentence and the agent's tool (whose schema IS the
 * command's, extended with `dryRun`) in the same sentence, naming the tool. The phone cannot
 * send command input at all — its vet builds every input from the document — so its
 * malformed press never reaches the bus: what this asserts there is that the vet refuses the
 * same mistake and asks the bus nothing.
 *
 * Through the real bus, the real registry, the real agent surface and the real phone path.
 */

const desk = contextFor(alice);

const LOOKS = serializePresetBank({
  version: 1,
  presets: [
    { name: "soft", values: { blur1: { size: 4 } } },
    { name: "hard", values: { blur1: { size: 20 } } },
  ],
});

/** blur1 at 9; a bank `looks` whose Select is `hard`, on a published Panel's board. */
async function show(): Promise<{ bus: LoomBus; looks: NodeId; blur: NodeId }> {
  const store = createGraphStore({ ids: createSequentialIdFactory("d"), now: () => "2026-10-04T00:00:00.000Z" });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() });
  const add = (ref: string, type: string, label: string, parameters: Record<string, unknown> = {}): GraphPatchOperation =>
    ({ op: "addNode", ref: `$${ref}`, type, position: { x: 0, y: 0 }, label, parameters }) as GraphPatchOperation;
  const board = serializePanelBoard({ columns: 8, items: [{ member: "looks", rect: { x: 0, y: 0, w: 4, h: 1 } }] });
  const result = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: bus.store.getRevision(),
      operations: [
        add("blur", "blur", "blur1", { size: 9 }),
        add("looks", "presets", "looks", { targets: "blur1", presets: LOOKS, select: "hard" }),
        add("stage", "panel", "panel1", { remote: true, board }),
      ],
    },
    desk,
  );
  expect(result.output.status).toBe("applied");
  const created = result.output.createdIds as Record<string, NodeId>;
  return { bus, looks: created["$looks"]!, blur: created["$blur"]! };
}

const size = (bus: LoomBus, blur: NodeId): unknown => bus.store.getGraph().nodes[blur]!.parameters["size"];

/** The sentence after its subject: what was wrong, and where — the part every door shares. */
const issueOf = (message: string | undefined): string => (message ?? "").replace(/^Input to "[^"]+" /, "");

const NAME_IS_A_NUMBER = 'is invalid at name (invalid_type): Expected string, received number';

describe("§T1556b — the same malformed input is refused the same way on every door", () => {
  it("UI door (a menu row, a keybind, the palette: a direct execute) — the bus refuses it, naming command and field, and nothing changes", async () => {
    const { bus, looks, blur } = await show();
    const revision = bus.store.getRevision();

    const result = await bus.execute("preset.recall", { nodeId: looks, name: 42 } as never, desk);

    expect(result.status).toBe("rejected");
    expect(result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message])).toEqual([
      ["command.input", `Input to "preset.recall" ${NAME_IS_A_NUMBER}`],
    ]);
    // Before the bus parsed, this recalled the Select (`hard`): size 20.
    expect(size(bus, blur)).toBe(9);
    expect(bus.store.getRevision()).toBe(revision);
    // §V31: a refusal is a log entry, by the actor who sent it.
    expect(bus.store.getAudit().at(-1)).toMatchObject({ command: "preset.recall", status: "rejected", actor: { id: "alice" } });
  });

  it("agent door — recall_preset refuses the same input in the same sentence, naming the tool", async () => {
    const { bus, looks, blur } = await show();
    const surface = createAgentToolSurface({ bus, actor: agent, projectId: "doors", now: () => 0 });

    const viaAgent = await surface.callTool("recall_preset", { nodeId: looks, name: 42 });
    const direct = await bus.execute("preset.recall", { nodeId: looks, name: 42 } as never, desk);

    expect(viaAgent.status).toBe("error");
    expect(viaAgent.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([`Input to "recall_preset" ${NAME_IS_A_NUMBER}`]);
    // ONE schema decided both: the field and the reason are the bus's, word for word.
    expect(issueOf(viaAgent.diagnostics[0]?.message)).toBe(issueOf(direct.diagnostics[0]?.message));
    expect(size(bus, blur)).toBe(9);
  });

  it("phone door — the vet refuses the same mistake and the bus is never asked; a vetted press passes the command's own schema", async () => {
    const { bus, looks, blur } = await show();
    const refusals: string[] = [];
    const writes = createPhoneWrites({ bus, invocation: desk, schedule: () => () => undefined, onRefused: (_phone, reason) => refusals.push(reason) });
    const audit = bus.store.getAudit().length;

    await writes.write("p1", { handle: looks, values: { recall: 42 }, phase: "commit" });

    expect(refusals).toEqual(["“looks” has no preset by the name a phone asked for; it was renamed or deleted since the phone drew it."]);
    expect(bus.store.getAudit().length).toBe(audit);
    expect(size(bus, blur)).toBe(9);
    // The same value through the direct door is refused too (by the bus) — no door takes it.
    expect((await bus.execute("preset.recall", { nodeId: looks, name: 42 } as never, desk)).status).toBe("rejected");

    // And the input the vet DOES build is one the command's schema takes, so the phone's
    // well-formed press lands rather than meeting a refusal its user cannot read.
    await writes.write("p1", { handle: looks, values: { recall: "soft" }, phase: "commit" });
    expect(size(bus, blur)).toBe(4);
    expect(bus.store.getAudit().at(-1)).toMatchObject({ command: "preset.recall", status: "applied", actor: { id: "remote-p1" } });
  });
});
