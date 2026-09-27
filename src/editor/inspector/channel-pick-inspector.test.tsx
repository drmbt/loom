// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { Inspector } from "./inspector.tsx";

/**
 * §T1390b through the REAL pane: a Select wired from an audio source offers the source's
 * channels as a picker, and a pick lands in the document as the pattern text the Select
 * evaluates. Mounted rather than unit-tested because the dead-seam shape (§V844) is the
 * risk: a picker that works in the kit and is never handed its channels by the pane.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

const context = contextFor(alice);

describe("a Select's Channels row is a picker over what arrives", () => {
  it("offers the wired source's channels and writes the pick into the document", async () => {
    const store = createGraphStore({ ids: createSequentialIdFactory("n") });
    const { bus } = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() });
    const created = await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: 0,
        operations: [
          { op: "addNode", ref: "$src", type: "audioPattern", position: { x: 0, y: 0 } },
          { op: "addNode", ref: "$pick", type: "valueSelect", position: { x: 200, y: 0 } },
          { op: "connect", source: { nodeId: "$src", portId: "out" }, target: { nodeId: "$pick", portId: "in" } },
        ],
      },
      context,
    );
    const source = created.output.createdIds["$src"] as NodeId;
    const pick = created.output.createdIds["$pick"] as NodeId;
    const sourceLabel = bus.store.getGraph().nodes[source]?.label;
    expect(sourceLabel).toBeTruthy();
    const channelNames = (name: string) => (name === sourceLabel ? ["level", "low", "band109"] : []);

    render(
      <StrictMode>
        <Inspector
          bus={bus}
          context={context}
          nodeId={pick}
          settings={{ outputResolution: { width: 64, height: 64 }, workingFormat: "rgba8unorm" }}
          channelNames={channelNames}
        />
      </StrictMode>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 32));
    });

    const add = screen.getByRole("combobox", { name: "Add to Channels" }) as HTMLSelectElement;
    expect([...add.options].map((option) => option.value).filter((value) => value !== "")).toEqual([
      "level",
      "low",
      "band109",
    ]);
    await act(async () => {
      fireEvent.change(add, { target: { value: "band109" } });
      await new Promise((resolve) => setTimeout(resolve, 32));
    });
    // The Select's default `*` is replaced by the one channel picked out of it.
    expect(bus.store.getGraph().nodes[pick]?.parameters["channels"]).toBe("band109");
  });
});
