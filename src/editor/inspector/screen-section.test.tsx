// @vitest-environment jsdom
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import type { ScreenCaptureStatus, ScreenCaptureWiring } from "@/app/use-screen-sources.ts";
import { Inspector } from "./inspector.tsx";
import { ScreenSection } from "./screen-section.tsx";

beforeAll(installDomStubs);
afterEach(cleanup);

const nodeId = "capture" as NodeId;
function wiring(status?: ScreenCaptureStatus): ScreenCaptureWiring {
  return {
    statuses: status === undefined ? {} : { [nodeId]: status },
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(),
    diagnostics: [],
  };
}

describe("Screen In session controls", () => {
  it("never opens a picker on mount and starts on the click stack", () => {
    let clickReturned = false;
    const capture = { ...wiring(), start: vi.fn(() => {
      expect(clickReturned).toBe(false);
      return Promise.resolve();
    }) };
    render(<StrictMode><ScreenSection nodeId={nodeId} capture={capture} /></StrictMode>);
    expect(capture.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Share tab/window" }));
    clickReturned = true;
    expect(capture.start).toHaveBeenCalledTimes(1);
    expect(capture.start).toHaveBeenCalledWith(nodeId);
  });

  it("disables another picker while choosing", () => {
    const capture = wiring({ phase: "choosing" });
    render(<ScreenSection nodeId={nodeId} capture={capture} />);
    const button = screen.getByRole("button", { name: "Choosing…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(capture.start).not.toHaveBeenCalled();
    expect(screen.getByText("Choose a tab, window or screen in your browser")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
    expect(capture.stop).toHaveBeenCalledWith(nodeId);
  });

  it("keeps the active source label and stop control during a replacement picker", () => {
    const capture = wiring({ phase: "choosing", label: "Still shared tab" });
    render(<ScreenSection nodeId={nodeId} capture={capture} />);
    expect(screen.getByText("Sharing Still shared tab · choose another source in your browser")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Choosing…" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
    expect(capture.stop).toHaveBeenCalledTimes(1);
    expect(capture.stop).toHaveBeenCalledWith(nodeId);
  });

  it("shows the live source and offers stop and reshare", () => {
    const capture = wiring({ phase: "sharing", label: "Presentation tab" });
    render(<ScreenSection nodeId={nodeId} capture={capture} />);
    expect(screen.getByText("Sharing Presentation tab")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Share another" }));
    expect(capture.start).toHaveBeenCalledTimes(1);
    expect(capture.start).toHaveBeenCalledWith(nodeId);
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
    expect(capture.stop).toHaveBeenCalledTimes(1);
    expect(capture.stop).toHaveBeenCalledWith(nodeId);
  });

  it("updates ended, idle and failed states without retaining a stale source label", () => {
    const capture = wiring({ phase: "sharing", label: "Old tab" });
    const view = render(<ScreenSection nodeId={nodeId} capture={capture} />);
    const ended = { ...capture, statuses: { [nodeId]: { phase: "ended" as const } } };
    view.rerender(<ScreenSection nodeId={nodeId} capture={ended} />);
    expect(screen.queryByText("Sharing Old tab")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop sharing" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Share again" }));
    expect(capture.start).toHaveBeenCalledTimes(1);

    view.rerender(<ScreenSection nodeId={nodeId} capture={{ ...capture, statuses: {} }} />);
    expect(screen.getByRole("button", { name: "Share tab/window" })).toBeTruthy();
    view.rerender(<ScreenSection nodeId={nodeId} capture={{ ...capture, statuses: {
      [nodeId]: { phase: "error", message: "Permission denied" },
    } }} />);
    expect(screen.getByRole("alert").textContent).toBe("Permission denied");
    fireEvent.click(screen.getByRole("button", { name: "Retry sharing" }));
    expect(capture.start).toHaveBeenCalledTimes(2);
  });

  it.each(["inspector", "node"] as const)("the real %s uses the flattened capture id without document edits", async (variant) => {
    const store = createGraphStore({ ids: createSequentialIdFactory("n") });
    const { bus } = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() });
    const context = contextFor(alice);
    const created = await bus.execute("graph.applyPatch", {
      baseRevision: 0,
      operations: [{ op: "addNode", ref: "$screen", type: "screenIn", position: { x: 0, y: 0 } }],
    }, context);
    expect(created.status).toBe("applied");
    const innerId = created.output.createdIds["$screen"] as NodeId;
    const flatId = `component/${innerId}` as NodeId;
    const capture = wiring();
    const before = bus.store.getRevision();
    render(<Inspector bus={bus} context={context} nodeId={innerId} planNodeId={flatId}
      settings={{ outputResolution: { width: 64, height: 64 }, workingFormat: "rgba8unorm" }}
      variant={variant} screenCapture={{ ...capture, statuses: {
        [flatId]: { phase: "sharing", label: "Nested tab" },
        [innerId]: { phase: "error", message: "Wrong local id" },
      } }} />);
    expect(screen.getByText("Sharing Nested tab")).toBeTruthy();
    expect(screen.queryByText("Wrong local id")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Share another" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
    expect(capture.start).toHaveBeenCalledTimes(1);
    expect(capture.start).toHaveBeenCalledWith(flatId);
    expect(capture.stop).toHaveBeenCalledTimes(1);
    expect(capture.stop).toHaveBeenCalledWith(flatId);
    expect(bus.store.getRevision()).toBe(before);
  });
});
