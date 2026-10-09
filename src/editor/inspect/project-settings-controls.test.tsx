// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import type { ProjectSettings } from "@domain/types/graph.ts";
import { ProjectSettingsDialog } from "./project-settings.tsx";

beforeAll(installDomStubs);
afterEach(cleanup);

const SETTINGS: ProjectSettings = {
  outputResolution: { width: 1280, height: 720 },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 20,
  fps: 60,
  limits: {
    maxResolution: 8192,
    maxDispatch: 65_535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
};

describe("the rendered fields are the kit's controls (T390)", () => {
  function mount() {
    return render(
      <ProjectSettingsDialog
        settings={SETTINGS}
        onChange={() => {}}
        open
        onOpenChange={() => {}}
      />,
    );
  }

  /**
   * `role="spinbutton"` with `aria-valuenow` is markup only `ui/controls`'s `NumberField`
   * produces — the fork rendered `<input type="number">`. So this is evidence about WHICH
   * component is on screen, not merely that a number can be typed.
   */
  it("renders every numeric setting as the shared draggable NumberField", () => {
    mount();
    for (const [label, value] of [
      ["width", 1280],
      ["height", 720],
      ["target fps", 60],
      ["preview fps", 20],
      // T1432b: no reference width reads as 0 ("none").
      ["pixel reference width", 0],
      ["seed", 1],
    ] as const) {
      const field = screen.getByLabelText(label);
      expect(field.getAttribute("role"), label).toBe("spinbutton");
      expect(field.getAttribute("aria-valuenow"), label).toBe(String(value));
    }
  });

  /**
   * The unit is INSIDE the field rather than a sibling of it in the row — which is the
   * structural half of "the units float": a `px` that is a child of the control cannot
   * drift away from it however the row is laid out.
   */
  it("attaches px to the dimension field rather than parking it in the row", () => {
    mount();
    const width = screen.getByLabelText("width");
    const host = width.parentElement;
    expect(host).not.toBeNull();
    expect(host?.textContent).toContain("px");
  });

  it("keeps the type-label switch on the same shared primitive", () => {
    mount();
    const toggle = screen.getByLabelText("Show each node's type beside its name");
    expect(toggle.getAttribute("role")).toBe("switch");
  });
});


it("shares resolution presets, aspect choices and orientation with video rendering",()=>{
  const onChange=vi.fn();
  render(<ProjectSettingsDialog settings={{...SETTINGS,outputResolution:{width:720,height:1280}}} onChange={onChange} open onOpenChange={vi.fn()} />);
  fireEvent.click(screen.getByRole("button",{name:"1080p"}));
  expect(onChange).toHaveBeenLastCalledWith({outputResolution:{width:1080,height:1920}},"Set output resolution to 1080p");
  fireEvent.click(screen.getByRole("button",{name:"4:3"}));
  expect(onChange).toHaveBeenLastCalledWith({outputResolution:{width:960,height:1280}},"Set output aspect ratio to 4:3");
  fireEvent.click(screen.getByRole("button",{name:"Swap width and height"}));
  expect(onChange).toHaveBeenLastCalledWith({outputResolution:{width:1280,height:720}},"Swap output orientation");
});

it("disables presets that exceed the project limit",()=>{
  render(<ProjectSettingsDialog settings={{...SETTINGS,limits:{...SETTINGS.limits,maxResolution:2048}}} onChange={vi.fn()} open onOpenChange={vi.fn()} />);
  expect((screen.getByRole("button",{name:"1080p"}) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole("button",{name:"4K UHD"}) as HTMLButtonElement).disabled).toBe(true);
});
