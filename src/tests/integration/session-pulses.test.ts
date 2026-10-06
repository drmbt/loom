import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createAppRuntime, type AppRuntime } from "@/app/app-runtime.ts";
import { createAgentToolSurface } from "@agent/surface.ts";
import type { CommandContext } from "@domain/commands/bus.ts";
import { nodeIdsInput } from "@domain/commands/input-schema.ts";
import { componentNodeType } from "@domain/components/component-type.ts";
import { openComponentSession, type ComponentSession } from "@domain/components/session.ts";
import { serializePresetBank } from "@domain/presets/bank.ts";
import { PRESET_CURRENT_KEY } from "@domain/presets/bank-view.ts";
import { serializeCueList } from "@domain/presets/cue-list.ts";
import type { CommandName, CommandResult } from "@domain/types/commands.ts";
import type { GraphComponentDefinition } from "@domain/types/components.ts";
import type { GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";

/**
 * §T1695b — THE SEVEN COMMANDS A PULSE FIRES, FROM THE BUTTON INSIDE A COMPONENT AND FROM AN
 * EXPRESSION.
 *
 * A pulse is fired by two doors. The inspector's button inside a component runs
 * `parameter.pulse` on the SESSION bus with the definition's own node id. An expression
 * runs it on the PROJECT's bus with a flattened id, because the pulse watcher steps the
 * flattened document (`pulse-firing.ts`). Before the rule the two disagreed for every one of
 * the seven (`docs/component-session-commands-design-2026-10-06.md` §1.4): four were refused
 * from the button (VNB6, §B287) and worked from an expression.
 *
 * What is claimed, as ruled 2026-10-06:
 *
 *  - The four commands about a RUNNING INSTANCE, and a PAGE bank's recall, answer the same
 *    from both doors: the project's command is reached with the same input, naming the
 *    instance in view. Two instances, and the editor stands in the SECOND, so the
 *    definition's bare id, or the wrong instance, fails rather than passing by coincidence.
 *  - An INNER bank's recall and a cue list's GO and BACK write state the COMPONENT stores,
 *    one for every instance. The button inside edits the component. An expression, which
 *    speaks for one running instance, is refused by name, and the sentence says why.
 *
 * The four instance commands are recording doubles here, as in VNB6's own test: the app
 * registers the real ones from hooks, and what is under test is the road into them.
 */

const node = (id: NodeId, type: string, parameters: Record<string, StoredParameter> = {}): GraphNode => ({
  id,
  type,
  label: id,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
});

const KIT = "session-pulse-kit";

/** One component holding a node for every pulse, a page bank and an inner bank. */
function kit(): GraphComponentDefinition {
  const nodes = [
    node("level_soft", "level", { brightness: 1 }),
    node("feedback_trail", "feedback"),
    node("movie_clip", "movieFileIn"),
    node("depth_scene", "depth"),
    // The PAGE bank: it targets the enclosing instance's published page.
    node("presets_looks", "presets", {
      targets: "parent",
      presets: serializePresetBank({ version: 1, presets: [{ name: "calm", values: { parent: { bright: 2 } } }] }),
      select: "calm",
    }),
    // An INNER bank: it targets a node of the component itself.
    node("presets_inner", "presets", {
      targets: "level_soft",
      presets: serializePresetBank({ version: 1, presets: [{ name: "wide", values: { level_soft: { brightness: 3 } } }] }),
      select: "wide",
    }),
    node("cuelist_set", "cueList", {
      cues: serializeCueList({ version: 1, cues: [{ name: "1", bank: "presets_inner", preset: "wide" }, { name: "2", bank: "presets_inner", preset: "wide" }] }),
    }),
  ];
  return {
    componentId: KIT,
    version: 1,
    name: "Pulse Kit",
    graph: { revision: 0, nodes: Object.fromEntries(nodes.map((each) => [each.id, each])), edges: {}, groups: {} },
    inputs: [],
    outputs: [{ externalId: "out", label: "Out", nodeId: "level_soft", portId: "out" }],
    parameters: [{ key: "bright", definition: { type: "number", label: "Bright", default: 1, min: 0, max: 8 }, targets: [{ nodeId: "level_soft", key: "brightness" }] }],
  };
}

interface Stage {
  readonly runtime: AppRuntime;
  readonly session: ComponentSession;
  readonly one: NodeId;
  readonly two: NodeId;
  /** Every call the project's bus received for a recorded command: `[command, input, dryRun]`. */
  readonly reached: Array<readonly [string, unknown, boolean]>;
}

const INSTANCE_COMMANDS = ["runtime.resetFeedback", "runtime.resetInference", "media.cue", "media.reload"] as const;

async function stage(): Promise<Stage> {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester" } });
  runtime.components.register(kit());
  const added = await runtime.bus.execute(
    "graph.applyPatch",
    {
      baseRevision: runtime.bus.store.getRevision(),
      label: "two instances",
      operations: [
        { op: "addNode", ref: "$one", type: componentNodeType(KIT, 1), label: "pulsekit_one", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$two", type: componentNodeType(KIT, 1), label: "pulsekit_two", position: { x: 300, y: 0 } },
      ],
    },
    runtime.invocation,
  );
  expect(added.status, added.diagnostics.map((each) => each.message).join("; ")).toBe("applied");
  const one = added.output.createdIds["$one"] as NodeId;
  const two = added.output.createdIds["$two"] as NodeId;
  // What the app's compile hook does: a pulse an expression fires names a FLAT id.
  runtime.bus.attachFlattenedGraph(() => runtime.flattened.current());

  const reached: Array<readonly [string, unknown, boolean]> = [];
  for (const name of INSTANCE_COMMANDS) {
    runtime.bus.registerCommand({
      name,
      inSession: "instance",
      inputSchema: z.object({ nodeIds: nodeIdsInput.optional() }).strict(),
      handler: (input: unknown, context: CommandContext) => {
        reached.push([name, input, context.dryRun]);
        return { status: context.dryRun ? "validated" : "applied", output: { cleared: 1, reset: 1, cued: 1, reloaded: 1 }, diagnostics: [] };
      },
      rejectionOutput: () => ({ cleared: 0, reset: 0, cued: 0, reloaded: 0 }),
    } as never);
  }

  const session = openComponentSession({
    components: runtime.components,
    nodes: runtime.registry,
    componentId: KIT,
    version: 1,
    parent: runtime.bus,
    // The editor stands in the SECOND instance.
    instancePath: () => [two],
    registerDocumentCommands: runtime.registerDocumentCommands,
  });
  return { runtime, session, one, two, reached };
}

const said = (result: CommandResult<CommandName>): string => result.diagnostics.map((each) => `${each.code}: ${each.message}`).join("; ");

let made: Stage;
beforeEach(async () => {
  made = await stage();
});

describe("§T1695b — a command about a running instance answers the same from both doors", () => {
  const pulses = [
    ["runtime.resetFeedback", "feedback_trail", "resetPulse"],
    ["runtime.resetInference", "depth_scene", "reset"],
    ["media.cue", "movie_clip", "cuePulse"],
    ["media.reload", "movie_clip", "reload"],
  ] as const;

  it.each(pulses)("%s: the button inside reaches the instance in view, as an expression on that instance does", async (command, nodeId, key) => {
    const { runtime, session, one, two, reached } = made;

    // The inspector's button, inside the component: the session bus, the definition's own id.
    const button = await session.bus.execute("parameter.pulse", { nodeId, parameterKey: key }, runtime.invocation);
    expect(button.status, said(button)).toBe("applied");
    // An expression on the same pulse of the same instance: the project's bus, the flat id.
    const expression = await runtime.bus.execute("parameter.pulse", { nodeId: `${two}/${nodeId}`, parameterKey: key }, runtime.invocation);
    expect(expression.status, said(expression)).toBe("applied");

    // The same call reached the project's command twice: THIS instance, not the other, not the bare id.
    expect(reached).toEqual([
      [command, { nodeIds: [`${two}/${nodeId}`] }, false],
      [command, { nodeIds: [`${two}/${nodeId}`] }, false],
    ]);
    expect(JSON.stringify(reached)).not.toContain(`${one}/`);
    // Nothing of it is the component's: the definition did not move.
    expect(session.store.view.getRevision()).toBe(0);
  });

  it("refuses by name when the editor is open through no instance", async () => {
    const { runtime, reached } = made;
    const alone = openComponentSession({ components: runtime.components, nodes: runtime.registry, componentId: KIT, version: 1, parent: runtime.bus });
    const refused = await alone.bus.execute("parameter.pulse", { nodeId: "feedback_trail", parameterKey: "resetPulse" }, runtime.invocation);
    expect(refused.status).toBe("rejected");
    expect(refused.diagnostics.map((each) => each.code)).toEqual(["session.noInstance"]);
    expect(refused.diagnostics[0]?.message).toBe('"runtime.resetFeedback" acts on a running instance of component "Pulse Kit", and this editor is not open through one.');
    expect(reached).toEqual([]);
  });

  it("a page bank's Recall inside the component recalls on the instance in view, as its expression does", async () => {
    const { runtime, session, one, two } = made;
    const current = (instance: NodeId): unknown => runtime.bus.store.getGraph().nodes[instance]?.parameters[PRESET_CURRENT_KEY];
    const bright = (instance: NodeId): unknown => runtime.bus.store.getGraph().nodes[instance]?.parameters["bright"];

    const button = await session.bus.execute("parameter.pulse", { nodeId: "presets_looks", parameterKey: "recall" }, runtime.invocation);
    expect(button.status, said(button)).toBe("applied");
    // The page it wrote is the SECOND instance's, in the project; the other instance and the definition stand.
    expect([current(two), bright(two)]).toEqual(["calm", 2]);
    expect([current(one), bright(one)]).toEqual(["", 1]);
    expect(session.store.view.getRevision()).toBe(0);
    // And it says whose step it is to undo.
    expect(button.diagnostics.map((each) => each.code)).toContain("session.projectStep");

    // The expression's road, on the other instance: the same command, the same kind of answer.
    const expression = await runtime.bus.execute("parameter.pulse", { nodeId: `${one}/presets_looks`, parameterKey: "recall" }, runtime.invocation);
    expect(expression.status, said(expression)).toBe("applied");
    expect([current(one), bright(one)]).toEqual(["calm", 2]);
  });
});

describe("§T1695b — state the component stores: the button edits the component, an expression is refused and says why", () => {
  it("an inner bank's Recall: inside, it writes the component; from a running instance it is refused", async () => {
    const { runtime, session, two } = made;
    const rootRevision = runtime.bus.store.getRevision();

    const button = await session.bus.execute("parameter.pulse", { nodeId: "presets_inner", parameterKey: "recall" }, runtime.invocation);
    expect(button.status, said(button)).toBe("applied");
    // The component's own node took the preset, so every instance has it; the project did not move.
    expect(session.store.view.getGraph().nodes["level_soft"]?.parameters["brightness"]).toBe(3);
    expect(runtime.components.get(KIT, 1)?.graph.nodes["level_soft"]?.parameters["brightness"]).toBe(3);
    expect(runtime.bus.store.getRevision()).toBe(rootRevision);

    const expression = await runtime.bus.execute("parameter.pulse", { nodeId: `${two}/presets_inner`, parameterKey: "recall" }, runtime.invocation);
    expect(expression.status).toBe("rejected");
    expect(expression.diagnostics.map((each) => each.code)).toEqual(["preset.bank.inner"]);
    expect(expression.diagnostics[0]?.message).toBe(
      'Bank "presets_inner" inside component instance "pulsekit_two" writes the component\'s own nodes. Those values are the component\'s, the same for every instance, so a recall fired from a running instance is refused. Nothing was changed.',
    );
    expect(runtime.bus.store.getRevision()).toBe(rootRevision);
  });

  it.each([
    ["go", "1"],
    ["back", ""],
  ] as const)("a cue list's %s: inside, it steps the component's list; from a running instance it is refused", async (key, expected) => {
    const { runtime, session, two } = made;
    const rootRevision = runtime.bus.store.getRevision();
    if (key === "back") {
      // BACK needs somewhere to come back from: two GOs put the list on its second cue.
      await session.bus.execute("cue.go", { nodeId: "cuelist_set" }, runtime.invocation);
      await session.bus.execute("cue.go", { nodeId: "cuelist_set" }, runtime.invocation);
    }
    const before = session.store.view.getRevision();

    const button = await session.bus.execute("parameter.pulse", { nodeId: "cuelist_set", parameterKey: key }, runtime.invocation);
    expect(button.status, said(button)).toBe("applied");
    // The list's place moved in the COMPONENT, and nothing in the project did.
    expect(session.store.view.getRevision()).toBeGreaterThan(before);
    if (key === "go") expect(session.store.view.getGraph().nodes["cuelist_set"]?.parameters["current"]).toBe(expected);
    else expect(session.store.view.getGraph().nodes["cuelist_set"]?.parameters["current"]).toBe("1");
    expect(runtime.bus.store.getRevision()).toBe(rootRevision);

    const expression = await runtime.bus.execute("parameter.pulse", { nodeId: `${two}/cuelist_set`, parameterKey: key }, runtime.invocation);
    expect(expression.status).toBe("rejected");
    expect(expression.diagnostics.map((each) => each.code)).toEqual(["cue.list.inInstance"]);
    expect(expression.diagnostics[0]?.message).toBe(
      `"${two}/cuelist_set" is inside component instance "pulsekit_two". A cue list there keeps its cues and its place in them in the component, the same for every instance, so stepping it from a running instance is refused. Nothing was changed.`,
    );
    expect(runtime.bus.store.getRevision()).toBe(rootRevision);
  });
});

describe("§T1695b — an agent's command lands where a person's does", () => {
  /**
   * The agent surface and the MCP bridge execute on the PROJECT's bus (`use-agent-surface.ts`,
   * `useMcpTransports(surface, runtime.bus)`): an agent is never inside a component editor,
   * and addresses a node of an instance by its flattened id. A person inside the component
   * presses Reset on the definition's node. Both must reach the same history.
   */
  it("reset_feedback on an instance's node, and the Reset button inside that instance, reach one call", async () => {
    const { runtime, session, two, reached } = made;
    const surface = createAgentToolSurface({ bus: runtime.bus, actor: { kind: "agent", id: "agent-1" }, projectId: runtime.invocation.projectId, now: () => 1_000 });

    const person = await session.bus.execute("parameter.pulse", { nodeId: "feedback_trail", parameterKey: "resetPulse" }, runtime.invocation);
    expect(person.status, said(person)).toBe("applied");
    const agent = await surface.callTool("reset_feedback", { nodeIds: [`${two}/feedback_trail`] });
    expect(agent.status, agent.diagnostics.map((each) => each.message).join("; ")).toBe("ok");

    expect(reached.map(([command, input]) => [command, input])).toEqual([
      ["runtime.resetFeedback", { nodeIds: [`${two}/feedback_trail`] }],
      ["runtime.resetFeedback", { nodeIds: [`${two}/feedback_trail`] }],
    ]);
  });
});
