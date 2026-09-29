// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { controlPanelNode } from "@nodes/definitions/controls.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { Inspector } from "./inspector.tsx";

/**
 * T1512b — a fresh Panel's inspector does not lead with a text box to fill in. The owner:
 * "that layout text box is confusing me". The Layout override lives in the Advanced group,
 * which the inspector draws as a CLOSED disclosure — there when asked for, never the first
 * thing shown — while Title and Phone stay in the open.
 */
beforeAll(installDomStubs);
afterEach(cleanup);

describe("T1512b — the Advanced group is collapsed", () => {
  it("puts a Panel's Layout behind a closed disclosure and leaves Title in the open", async () => {
    const context = contextFor(alice);
    const store = createGraphStore({ ids: createSequentialIdFactory("adv") });
    const { bus } = createDomainBus({ store, registry: createNodeRegistry([controlPanelNode]).view() });
    const created = await bus.execute(
      "graph.applyPatch",
      { baseRevision: 0, operations: [{ op: "addNode", ref: "$p", type: "panel", position: { x: 0, y: 0 } }] },
      context,
    );
    const nodeId = created.output.createdIds["$p"] as NodeId;
    render(
      <Inspector bus={bus} context={context} nodeId={nodeId} settings={{ outputResolution: { width: 640, height: 360 }, workingFormat: "rgba8unorm" }} />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 32));
    });

    const layoutRow = document.querySelector("[data-parameter-key='layout']")!;
    const advanced = layoutRow.closest("details");
    expect(advanced).not.toBeNull();
    expect(advanced!.open).toBe(false);
    expect(advanced!.querySelector("summary")?.textContent).toContain("Advanced");
    // What a person needs first is not behind it.
    expect(document.querySelector("[data-parameter-key='title']")!.closest("details")).toBeNull();
    expect(document.querySelector("[data-parameter-key='remote']")!.closest("details")).toBeNull();
    expect(screen.getByText("Title")).not.toBeNull();
  });
});
