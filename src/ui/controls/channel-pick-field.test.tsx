import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ParameterDefinition } from "@domain/types/parameters.ts";
import { installDomStubs } from "../testing/install-dom-stubs.ts";
import { ParameterControl } from "./parameter-control.tsx";
import type { EditPhase } from "./types.ts";

/**
 * §T1390b — a channel list is PICKED from what arrives, through the control the inspector
 * really mounts for a `channelsFrom` string. The owner asked for selects instead of a
 * socket per channel; what they read back is the stored pattern text, so every assertion
 * is on the string the control writes.
 */

const levels: ParameterDefinition = {
  type: "string",
  label: "Levels",
  default: "*",
  channelsFrom: "audio",
};

function mount(value: string, available: readonly string[]) {
  const writes: Array<[unknown, EditPhase]> = [];
  render(
    <ParameterControl
      parameterKey="levels"
      definition={levels}
      value={value}
      channelsAvailable={available}
      onChange={vi.fn((next: unknown, phase: EditPhase) => {
        writes.push([next, phase]);
      })}
    />,
  );
  return { writes, add: () => screen.getByRole("combobox", { name: "Add to Levels" }) as HTMLSelectElement };
}

beforeAll(() => {
  installDomStubs();
});
afterEach(cleanup);

describe("a channel list is picked, not typed", () => {
  it("offers only the arriving channels not already picked, and appends the pick", () => {
    const { writes, add } = mount("level low", ["level", "low", "band109", "kick"]);
    const offered = [...add().options].map((option) => option.value).filter((value) => value !== "");
    expect(offered).toEqual(["band109", "kick"]);
    fireEvent.change(add(), { target: { value: "band109" } });
    expect(writes).toEqual([["level low band109", "commit"]]);
  });

  it("replaces a lone `*` with the first pick — one channel out of everything means that channel", () => {
    const { writes, add } = mount("*", ["level", "low"]);
    fireEvent.change(add(), { target: { value: "low" } });
    expect(writes).toEqual([["low", "commit"]]);
  });

  it("removes one chip and keeps the others in their written order", () => {
    const { writes } = mount("high low level", ["level", "low", "high"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove low from Levels" }));
    expect(writes).toEqual([["high level", "commit"]]);
  });

  it("marks a named channel nothing is sending, and never a pattern", () => {
    mount("level band109 band* ^hat", ["level", "low"]);
    const chip = (token: string) => document.querySelector(`[data-channel-token="${token}"]`);
    expect(chip("band109")?.getAttribute("data-channel-missing")).toBe("true");
    expect(chip("level")?.hasAttribute("data-channel-missing")).toBe(false);
    expect(chip("band*")?.getAttribute("data-channel-pattern")).toBe("true");
    expect(chip("^hat")?.getAttribute("data-channel-pattern")).toBe("true");
    expect(chip("band*")?.hasAttribute("data-channel-missing")).toBe(false);
  });

  it("marks nothing missing and offers nothing when no channel is arriving", () => {
    const { add } = mount("level band109", []);
    expect(document.querySelectorAll("[data-channel-missing]")).toHaveLength(0);
    expect(add().disabled).toBe(true);
    expect(add().options[0]?.textContent).toBe("No channels arriving");
  });

  it("opens the full pattern text for editing, one control at a time", () => {
    const { writes } = mount("level low", ["level", "low"]);
    fireEvent.click(screen.getByRole("button", { name: "Edit Levels as text" }));
    expect(screen.queryByRole("combobox", { name: "Add to Levels" })).toBeNull();
    const text = screen.getByRole("textbox", { name: "Levels" }) as HTMLInputElement;
    expect(text.value).toBe("level low");
    fireEvent.change(text, { target: { value: "band[1-4]*" } });
    fireEvent.keyDown(text, { key: "Enter" });
    expect(writes.at(-1)).toEqual(["band[1-4]*", "commit"]);
  });

  it("is a plain text field for a string that declares no channel source", () => {
    render(
      <ParameterControl
        parameterKey="name"
        definition={{ type: "string", label: "Name", default: "" }}
        value="x"
        channelsAvailable={["a"]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
