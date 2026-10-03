// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { componentInstances } from "@domain/components/instance.ts";
import {
  blurKnob,
  bloomComponent,
  createComponentHarness,
  graphOf,
  instanceNode,
  node,
} from "@domain/components/test-support.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { registerComponentCommands } from "@domain/components/commands.ts";
import { createComponentSystem } from "@domain/components/registry.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { ComponentLibrary } from "./component-library.tsx";

/**
 * The component library (T188, §V93, §V79, §V84).
 *
 * What these defend is that the pane is a VIEW, not a second implementation: every row
 * comes from `component.list` and every action leaves through the bus, so a component
 * placed from here is indistinguishable from one placed by an agent or a menu (§V29).
 *
 * The two that matter most:
 *  - linked and detached are DIFFERENT placements and both are reachable. A pane that
 *    only offered one would make §V79's choice invisible;
 *  - a pinned version is shown and an upgrade is offered per instance, never applied in
 *    bulk and never silently (§V84, §V10).
 */

beforeAll(installDomStubs);
afterEach(cleanup);

const context = contextFor(alice);

function setup(options: { registerV2?: boolean; withInstance?: boolean } = {}) {
  const harness = createComponentHarness(
    "c",
    options.withInstance === true
      ? graphOf([instanceNode("inst", "bloom", 1, { blur: 12 })])
      : graphOf([]),
  );
  harness.components.register(bloomComponent("bloom", 1, [blurKnob]));
  if (options.registerV2 === true) harness.components.register(bloomComponent("bloom", 2, [blurKnob]));
  return harness;
}

describe("ComponentLibrary (T188)", () => {
  it("sixty parameter revisions refresh no catalogue/upgrades queries; instance and definition changes still refresh", async () => {
    const harness = createComponentHarness("c", graphOf([
      node("soften", "test.blur", { radius: 4 }),
      instanceNode("inst", "bloom", 1, { blur: 12 }),
    ]));
    harness.components.register(bloomComponent("bloom", 1, [blurKnob]));
    const query = vi.spyOn(harness.bus, "query");
    render(<ComponentLibrary bus={harness.bus} context={context} components={harness.components.view()} />);
    await screen.findByRole("button", { name: /^Bloom/ });
    expect(query.mock.calls.map(call => call[0])).toEqual(["component.list", "component.upgrades"]);
    for (let revision = 0; revision < 60; revision++) {
      await act(async () => {
        const result = await harness.bus.execute("graph.applyPatch", {
          baseRevision: harness.bus.store.getGraph().revision,
          operations: [{ op: "setParameters", nodeId: revision % 2 === 0 ? "soften" : "inst",
            parameters: revision % 2 === 0 ? { radius: revision + 1 } : { blur: revision + 1 } }],
        }, context);
        expect(result.status).toBe("applied");
      });
    }
    expect(query).toHaveBeenCalledTimes(2);
    await act(async () => harness.components.register(bloomComponent("bloom", 2, [blurKnob])));
    const upgrades = await screen.findByRole("region", { name: "Upgrades" });
    expect(within(upgrades).getByText("v1 → v2")).toBeDefined();
    expect(query).toHaveBeenCalledTimes(4);

    await act(async () => {
      await harness.bus.execute("component.instantiate", { componentId: "bloom", version: 1, mode: "linked" }, context);
    });
    expect(query).toHaveBeenCalledTimes(6);
    expect(within(upgrades).getAllByText("v1 → v2")).toHaveLength(2);

    const names = within(upgrades).getAllByRole("button", { name: /Upgrade Bloom/ });
    fireEvent.click(names[0]!);
    await waitFor(() => expect(within(upgrades).getAllByText("v1 → v2")).toHaveLength(1));
    expect(query.mock.calls.filter(call => call[0] === "component.upgrades").length).toBeGreaterThan(3);

    await act(async () => {
      harness.components.register({ ...bloomComponent("bloom", 1, [blurKnob]), name: "Reauthored" });
      harness.components.register({ ...bloomComponent("bloom", 2, [blurKnob]), name: "Reauthored" });
    });
    expect(await screen.findByRole("button", { name: /^Reauthored/ })).toBeDefined();
    expect(within(upgrades).getByRole("button", { name: /Upgrade Reauthored/ })).toBeDefined();

    const beforeRemoval = query.mock.calls.length;
    const pinned = componentInstances(harness.bus.store.getGraph()).find(instance => instance.state.version === 1)!;
    await act(async () => {
      const result = await harness.bus.execute("graph.applyPatch", {
        baseRevision: harness.bus.store.getGraph().revision,
        operations: [{ op: "removeNodes", nodeIds: [pinned.nodeId] }],
      }, context);
      expect(result.status).toBe("applied");
    });
    expect(screen.queryByRole("region", { name: "Upgrades" })).toBeNull();
    expect(query).toHaveBeenCalledTimes(beforeRemoval + 2);
  });
  it("lists what the bus says is installed, with its version", async () => {
    const harness = setup();
    render(
      <ComponentLibrary
        bus={harness.bus}
        context={context}
        components={harness.components.view()}
      />,
    );

    const row = await screen.findByRole("button", { name: /^Bloom/ });
    expect(within(row).getByText("v1")).toBeDefined();
    // The row is the query's answer, not a literal: nothing else was registered.
    expect(screen.queryByRole("button", { name: /Kaleidoscope/ })).toBeNull();
  });

  it("instantiates LINKED through the bus — one instance node pinning the version (§V79, §V84)", async () => {
    const harness = setup();
    const execute = vi.spyOn(harness.bus, "execute");
    render(
      <ComponentLibrary
        bus={harness.bus}
        context={context}
        components={harness.components.view()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /^Bloom/ }));

    await waitFor(() => {
      expect(componentInstances(harness.bus.store.getGraph())).toHaveLength(1);
    });
    expect(execute).toHaveBeenCalledWith(
      "component.instantiate",
      expect.objectContaining({ componentId: "bloom", mode: "linked" }),
      context,
    );
    // Linked means ONE node that points at the definition, not a copy of its three blurs.
    expect(Object.keys(harness.bus.store.getGraph().nodes)).toHaveLength(1);
    expect(componentInstances(harness.bus.store.getGraph())[0]?.state.version).toBe(1);
  });

  it("instantiates DETACHED as an independent copy of the internals (§V79)", async () => {
    const harness = setup();
    const execute = vi.spyOn(harness.bus, "execute");
    render(
      <ComponentLibrary
        bus={harness.bus}
        context={context}
        components={harness.components.view()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Copy Bloom" }));

    await waitFor(() => {
      // Bloom's three internal blurs, copied in; no instance node at all.
      expect(Object.keys(harness.bus.store.getGraph().nodes)).toHaveLength(3);
    });
    expect(componentInstances(harness.bus.store.getGraph())).toHaveLength(0);
    expect(execute).toHaveBeenCalledWith(
      "component.instantiate",
      expect.objectContaining({ mode: "detached" }),
      context,
    );
  });

  it("shows an instance's pinned version and the upgrade waiting for it (§V84)", async () => {
    const harness = setup({ registerV2: true, withInstance: true });
    render(
      <ComponentLibrary
        bus={harness.bus}
        context={context}
        components={harness.components.view()}
      />,
    );

    const upgrades = await screen.findByRole("region", { name: "Upgrades" });
    // Both numbers: what it is pinned to, and what it could move to. Neither implied.
    expect(within(upgrades).getByText("v1 → v2")).toBeDefined();

    fireEvent.click(within(upgrades).getByRole("button", { name: /Upgrade Bloom/ }));

    await waitFor(() => {
      expect(componentInstances(harness.bus.store.getGraph())[0]?.state.version).toBe(2);
    });
  });

  it("offers no upgrade while the pinned version IS the latest", async () => {
    const harness = setup({ withInstance: true });
    render(
      <ComponentLibrary
        bus={harness.bus}
        context={context}
        components={harness.components.view()}
      />,
    );
    await screen.findByRole("button", { name: /^Bloom/ });
    expect(screen.queryByRole("region", { name: "Upgrades" })).toBeNull();
  });

  it("saves the selection as a component and instances it (§V79)", async () => {
    // A real node to capture, of a type the harness's registry actually carries.
    const harness = createComponentHarness("c", graphOf([node("soften", "test.blur", { radius: 4 })]));

    render(
      <ComponentLibrary
        bus={harness.bus}
        context={context}
        components={harness.components.view()}
        selection={["soften"]}
      />,
    );

    fireEvent.change(screen.getByLabelText("Component name"), { target: { value: "Softener" } });
    fireEvent.click(screen.getByRole("button", { name: "Save selection" }));

    await waitFor(() => {
      expect(harness.components.list().map((definition) => definition.name)).toContain("Softener");
    });
    // Saving replaces the selection with an instance of what was saved.
    expect(componentInstances(harness.bus.store.getGraph())).toHaveLength(1);
  });

  it("exports a row to a file through the bus, and says where it went (T1395b)", async () => {
    const written: Array<{ fileName: string; text: string }> = [];
    const harness = createComponentHarness("c", graphOf([]), async (file) => {
      written.push({ fileName: file.fileName, text: file.text });
      return { kind: "saved", fileName: "my-bloom.loom.json" };
    });
    harness.components.register(bloomComponent("bloom", 1, [blurKnob]));
    render(
      <ComponentLibrary
        bus={harness.bus}
        context={context}
        components={harness.components.view()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Export Bloom" }));

    // The notice names the file the WRITER reported, not the one it was offered.
    expect(await screen.findByText('Exported "Bloom" to my-bloom.loom.json.')).toBeDefined();
    expect(written.map((file) => file.fileName)).toEqual(["Bloom.loom.json"]);
    const library = (JSON.parse(written[0]?.text ?? "{}") as { componentLibrary?: { components: Array<{ componentId: string }> } })
      .componentLibrary;
    expect(library?.components.map((each) => each.componentId)).toEqual(["bloom"]);
  });

  it("an export refused for a session-only file says the fix, not only the refusal (T1519b)", async () => {
    // The shipped node set: Movie File In's `file` is the asset a picked file lands in.
    const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view(), [{
      componentId: "clip",
      version: 1,
      name: "Clip",
      graph: graphOf([node("movie", "movieFileIn", { file: "blob:http://localhost:5173/3f2a#take3.mp4" }, { label: "clip1" })]),
      inputs: [],
      outputs: [{ externalId: "out", label: "Out", nodeId: "movie", portId: "out" }],
      parameters: [],
    }]);
    const store = createGraphStore({ ids: createSequentialIdFactory("c"), now: () => "2026-10-04T00:00:00.000Z" });
    const { bus } = createDomainBus({ store, registry: system.nodes });
    let writes = 0;
    registerComponentCommands(bus, {
      components: system.components,
      writeFile: async (file) => { writes += 1; return { kind: "saved", fileName: file.fileName }; },
      retainsPickedFiles: true,
    });
    render(<ComponentLibrary bus={bus} context={context} components={system.components.view()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Export Clip" }));

    expect(
      await screen.findByText(
        '"Clip" was not exported: "clip1" in "Clip" reads "take3.mp4", a file picked for this session only, which no other document could open. '
          + 'Enter "Clip" and choose "take3.mp4" again with the file picker on File of "clip1": it is then kept as a reference to the file on disk, which an export carries. Then export again.',
      ),
    ).toBeDefined();
    expect(writes).toBe(0);
  });

  it("cannot save with nothing selected", () => {
    const harness = setup();
    render(
      <ComponentLibrary
        bus={harness.bus}
        context={context}
        components={harness.components.view()}
      />,
    );
    expect(screen.getByRole("button", { name: "Save selection" }).hasAttribute("disabled")).toBe(true);
  });
});
