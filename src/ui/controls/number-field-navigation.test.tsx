// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "../testing/install-dom-stubs.ts";
import { NumberField } from "./number-field.tsx";

beforeAll(installDomStubs);
afterEach(() => { cleanup(); vi.useRealTimers(); });

function PixelFields() {
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  return <>
    <NumberField label="Width" value={width} spec={{ min: 1, max: 8192, step: 1 }} showPrecisionSelector={false} onChange={setWidth} />
    <NumberField label="Height" value={height} spec={{ min: 1, max: 8192, step: 1 }} showPrecisionSelector={false} onChange={setHeight} />
    <button type="button">Render</button>
  </>;
}

describe("fixed-unit number fields", () => {
  it("typing then Tab commits width and reaches height directly; ShiftTab returns to width", async () => {
    const user = userEvent.setup();
    render(<PixelFields />);
    const width = screen.getByRole("spinbutton", { name: "Width" });
    const height = screen.getByRole("spinbutton", { name: "Height" });
    await user.tab();
    expect(document.activeElement).toBe(width);
    await user.keyboard("3840");
    await user.tab();
    expect(document.activeElement).toBe(height);
    expect((width as HTMLInputElement).value).toBe("3840");
    await user.keyboard("2160");
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(width);
    expect((height as HTMLInputElement).value).toBe("2160");
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Render" }));
    expect(screen.queryByRole("button", { name: /drag magnitude/ })).toBeNull();
  });

  it("does not expose the ladder through a hold or keyboard chord", () => {
    vi.useFakeTimers();
    render(<PixelFields />);
    const width = screen.getByRole("spinbutton", { name: "Width" });
    fireEvent.pointerDown(width, { button: 0, pointerId: 1, clientX: 20 });
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.pointerUp(width, { button: 0, pointerId: 1, clientX: 20 });
    fireEvent.keyDown(width, { key: "Escape" });
    fireEvent.keyDown(width, { key: "ArrowUp", ctrlKey: true });
    fireEvent.keyUp(width, { key: "ArrowUp", ctrlKey: true });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect((width as HTMLInputElement).value).toBe("1921");
  });
});
