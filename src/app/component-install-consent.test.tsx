// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { applyBridgeOperatorConsent, type AgentToolSurface, type ToolResult } from "@agent/index.ts";
import type { ExportComponentData } from "@agent/tools/components.ts";
import { componentNodeType } from "@domain/components/component-type.ts";
import type { ComponentImportOutput } from "@domain/components/file-commands.ts";
import { createAppRuntime, type AppRuntime } from "./app-runtime.ts";
import { AgentPane } from "./dock-panes.tsx";
import { AGENT_ACTOR, useAgentSurface, type AgentSurfaceState } from "./use-agent-surface.ts";

/**
 * T1510b (§V38): AN AGENT'S COMPONENT IMPORT ASKS THE PERSON, AND THE ANSWER IS THE GRANT.
 *
 * T1494b gated `import_component` behind `componentInstall` and nothing in a tab could
 * issue it, so an agent's import was refused forever. The owner kept the gate and asked
 * for a way through it: the first refused call puts an Allow/Deny card in the agent pane,
 * the refusal names that card, an Allow grants the class to the agent actor for the
 * session, a bridge detach takes it back, and a Deny leaves the tool refused.
 *
 * Everything here is the product's own: the runtime `app.tsx` builds, the surface
 * `useAgentSurface` builds (with the root's routes and issuer), and the pane `AgentPane`
 * renders, clicked like a person clicks it. What is read back is what the agent and the
 * operator would see — the tool's status and sentence, the catalogue, the placed node.
 */

afterEach(cleanup);

const STATE: AgentSurfaceState = { selection: [], playing: false, diagnostics: [], diagnosticsRevision: 0 };

const newRuntime = (): AppRuntime =>
  createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });

function surfaceOf(runtime: AppRuntime): AgentToolSurface {
  return renderHook(() => useAgentSurface(runtime, STATE)).result.current;
}

/** A component the target document does not have, exported as an agent would get it. */
async function probeFileText(): Promise<string> {
  const source = newRuntime();
  const [starter] = source.components.all();
  if (starter === undefined) throw new Error("the runtime installed no starter components");
  source.components.register({ ...starter, componentId: "t1510probe", name: "T1510 probe" });
  const exported = await surfaceOf(source).callTool("export_component", { componentId: "t1510probe" });
  expect(exported.status, exported.diagnostics.map((d) => d.message).join("; ")).toBe("ok");
  return (exported.data as ExportComponentData).text as string;
}

const installed = (runtime: AppRuntime): boolean => runtime.components.get("t1510probe", 1) !== undefined;

async function placedTypes(runtime: AppRuntime): Promise<string[]> {
  const graph = await runtime.bus.query("graph.get", {}, runtime.invocation);
  return Object.values(graph.nodes).map((each) => each.type);
}

const call = (surface: AgentToolSurface, text: string): Promise<ToolResult> =>
  act(() => surface.callTool("import_component", { text, position: { x: 120, y: 80 } }));

function consentCards(): HTMLElement[] {
  return screen.queryAllByText("Allow component install").map((label) => label.closest("article") as HTMLElement);
}

describe("import_component asks the operator for componentInstall (T1510b)", () => {
  it("is refused naming the card, applies after Allow, and is refused again once the bridge detaches", async () => {
    const text = await probeFileText();
    const runtime = newRuntime();
    const surface = surfaceOf(runtime);
    render(<AgentPane surface={surface} />);

    // 1. Refused — and the sentence tells the agent where the question went.
    const refused = await call(surface, text);
    expect(refused.status).toBe("denied");
    expect(refused.diagnostics[0]?.code).toBe("capability.denied");
    expect(refused.diagnostics[0]?.message).toContain("componentInstall");
    expect(refused.diagnostics[0]?.message).toContain("Pending changes");
    expect(refused.diagnostics[0]?.message).toContain("Allow");
    expect(installed(runtime)).toBe(false);
    expect(await placedTypes(runtime)).toEqual([]);

    // The operator sees ONE card, however often a looping agent retries before answering.
    await call(surface, text);
    expect(consentCards()).toHaveLength(1);
    expect(runtime.bus.grants.has(AGENT_ACTOR, "componentInstall")).toBe(false);

    // 2. The person clicks Allow on the card the product renders.
    await act(async () => {
      fireEvent.click(within(consentCards()[0] as HTMLElement).getByRole("button", { name: "Allow" }));
    });
    expect(consentCards()).toHaveLength(0);
    expect(runtime.bus.grants.has(AGENT_ACTOR, "componentInstall")).toBe(true);
    // Only the class asked for: an Allow here is not a key to the others (§V38).
    expect(runtime.bus.grants.list(AGENT_ACTOR).map((grant) => grant.capability)).toEqual(["componentInstall"]);

    // 3. The SAME call now installs the component and places one instance where asked.
    const applied = await call(surface, text);
    expect(applied.status, applied.diagnostics.map((d) => d.message).join("; ")).toBe("ok");
    expect(installed(runtime)).toBe(true);
    const nodeId = (applied.data as ComponentImportOutput).nodeId as string;
    const graph = await runtime.bus.query("graph.get", {}, runtime.invocation);
    expect(graph.nodes[nodeId]).toMatchObject({ type: componentNodeType("t1510probe", 1), position: { x: 120, y: 80 } });

    // 4. The bridge detaches — where the session's other page grant ends — and so does this.
    applyBridgeOperatorConsent(runtime.bus.grants, AGENT_ACTOR, null);
    const after = await call(surface, text);
    expect(after.status).toBe("denied");
    expect(await placedTypes(runtime)).toEqual([componentNodeType("t1510probe", 1)]);
    // A new session is asked afresh rather than remembering a consent it no longer holds.
    expect(consentCards()).toHaveLength(1);
  });

  it("an attach alone never grants it: only the person's click does", () => {
    const runtime = newRuntime();
    applyBridgeOperatorConsent(runtime.bus.grants, AGENT_ACTOR, { snapshots: true });
    expect(runtime.bus.grants.has(AGENT_ACTOR, "componentInstall")).toBe(false);
  });

  it("Deny leaves it refused, says so, and does not ask again this session", async () => {
    const text = await probeFileText();
    const runtime = newRuntime();
    const surface = surfaceOf(runtime);
    render(<AgentPane surface={surface} />);

    await call(surface, text);
    await act(async () => {
      fireEvent.click(within(consentCards()[0] as HTMLElement).getByRole("button", { name: "Deny" }));
    });
    expect(runtime.bus.grants.has(AGENT_ACTOR, "componentInstall")).toBe(false);

    const again = await call(surface, text);
    expect(again.status).toBe("denied");
    expect(again.diagnostics[0]?.suggestion).toContain("denied componentInstall for this session");
    expect(consentCards()).toHaveLength(0);
    expect(installed(runtime)).toBe(false);
    expect(await placedTypes(runtime)).toEqual([]);
  });
});
