// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_IMAGE_FRAMING, type ImageFraming } from "@domain/media/image-framing.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { PhotoPreviewCrop, type PhotoPreviewCropProps } from "./photo-preview-crop.tsx";

const defaults = { source: { width: 600, height: 300 }, target: { width: 200, height: 400 }, url: "blob:preview", fit: "fill" as const };
function Interactive(props: Partial<PhotoPreviewCropProps> = {}) {
  const [value, setValue] = useState<ImageFraming>(props.value ?? DEFAULT_IMAGE_FRAMING);
  return <PhotoPreviewCrop {...defaults} {...props} value={value} onChange={next => { props.onChange?.(next); setValue(next); }} />;
}
beforeEach(() => { installDomStubs(); vi.stubGlobal("PointerEvent", MouseEvent); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const controls = () => screen.getByRole("group", { name: "Preview crop controls" });
const guide = () => screen.getByRole("img", { name: "Preview framing guide" });
const slider = (name: string) => screen.getByRole("slider", { name: `Preview crop ${name}` }) as HTMLInputElement;
const crop = () => guide().querySelector("rect")!;

describe("controlled preview photograph crop", () => {
  it("drags the crop in source coordinates while leaving the uncropped axis unchanged", () => {
    const onChange = vi.fn(), original = { ...DEFAULT_IMAGE_FRAMING };
    render(<Interactive value={original} onChange={onChange} />);
    vi.spyOn(guide(), "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 300, height: 150 } as DOMRect);
    fireEvent.pointerDown(guide(), { button: 0, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(guide(), { clientX: 190, clientY: 120 });
    fireEvent.pointerUp(guide(), { clientX: 190, clientY: 120 });
    expect(Number(slider("horizontal position").value)).toBeCloseTo(0.9);
    expect(slider("vertical position").value).toBe("0.5");
    expect(Number(crop().getAttribute("x"))).toBeCloseTo(405);
    expect(original).toEqual(DEFAULT_IMAGE_FRAMING);
    expect(document.activeElement).toBe(controls());
    expect(onChange).toHaveBeenCalled();
  });

  it("clamps a dragged crop to the photo bounds and stops after pointer cancellation", () => {
    render(<Interactive />);
    fireEvent.pointerDown(guide(), { button: 0, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(guide(), { clientX: 10000, clientY: 50 });
    expect(slider("horizontal position").value).toBe("1");
    expect(Number(crop().getAttribute("x")) + Number(crop().getAttribute("width"))).toBe(600);
    fireEvent.pointerCancel(guide());
    fireEvent.pointerMove(guide(), { clientX: -10000, clientY: 50 });
    expect(slider("horizontal position").value).toBe("1");
    fireEvent.pointerDown(guide(), { button: 0, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(guide(), { clientX: -10000, clientY: 50 });
    expect(slider("horizontal position").value).toBe("0");
    expect(crop().getAttribute("x")).toBe("0");
  });

  it("does not invent pan on a full uncropped photograph", () => {
    const onChange = vi.fn();
    render(<Interactive target={defaults.source} fit="fit" onChange={onChange} />);
    fireEvent.pointerDown(guide(), { button: 0, clientX: 10, clientY: 20 });
    fireEvent.pointerMove(guide(), { clientX: 900, clientY: 600 });
    fireEvent.pointerUp(guide(), { clientX: 900, clientY: 600 });
    expect(onChange).not.toHaveBeenCalled();
    expect(slider("horizontal position").value).toBe("0.5");
    expect(slider("vertical position").value).toBe("0.5");
  });

  it("offers fine and Shift arrow positioning plus bounded keyboard zoom", () => {
    render(<Interactive />);
    controls().focus(); fireEvent.keyDown(controls(), { key: "ArrowRight" });
    expect(Number(slider("horizontal position").value)).toBeCloseTo(0.51);
    fireEvent.keyDown(controls(), { key: "ArrowUp", shiftKey: true });
    expect(Number(slider("vertical position").value)).toBeCloseTo(0.4);
    fireEvent.keyDown(controls(), { key: "+" });
    expect(Number(slider("zoom").value)).toBeCloseTo(1.05);
    fireEvent.keyDown(controls(), { key: "-" }); fireEvent.keyDown(controls(), { key: "-" });
    expect(slider("zoom").value).toBe("1");
    fireEvent.change(slider("zoom"), { target: { value: "8" } });
    fireEvent.keyDown(controls(), { key: "+" }); expect(slider("zoom").value).toBe("8");
  });

  it("zooms the crop and resets every framing setting without modifying the input object", () => {
    const original = { x: 0.8, y: 0.2, zoom: 3 }, onChange = vi.fn();
    render(<Interactive target={defaults.source} fit="stretch" value={original} onChange={onChange} />);
    fireEvent.change(slider("zoom"), { target: { value: "2" } });
    expect(crop().getAttribute("width")).toBe("300"); expect(crop().getAttribute("height")).toBe("150");
    fireEvent.change(slider("horizontal position"), { target: { value: "0.1" } });
    fireEvent.change(slider("vertical position"), { target: { value: "0.9" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset preview crop" }));
    expect(slider("zoom").value).toBe("1");
    expect(slider("horizontal position").value).toBe("0.5"); expect(slider("vertical position").value).toBe("0.5");
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_IMAGE_FRAMING);
    expect(original).toEqual({ x: 0.8, y: 0.2, zoom: 3 });
  });

  it("keeps native slider keyboard events separate from gizmo shortcuts", () => {
    const onChange = vi.fn(); render(<Interactive onChange={onChange} />);
    slider("horizontal position").focus(); fireEvent.keyDown(slider("horizontal position"), { key: "ArrowRight" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disables pointer, keyboard, range and reset interaction during owned work", () => {
    const onChange = vi.fn(); render(<Interactive disabled onChange={onChange} />);
    expect(controls().tabIndex).toBe(-1); expect(controls().getAttribute("aria-disabled")).toBe("true");
    for (const name of ["zoom", "horizontal position", "vertical position"]) expect(slider(name).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reset preview crop" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.pointerDown(guide(), { button: 0, clientX: 10, clientY: 20 });
    fireEvent.pointerMove(guide(), { clientX: 900, clientY: 600 });
    fireEvent.keyDown(controls(), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Reset preview crop" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is controlled by its value and retains the accessible original photograph", () => {
    const onChange = vi.fn();
    const result = render(<PhotoPreviewCrop {...defaults} value={DEFAULT_IMAGE_FRAMING} onChange={onChange} />);
    fireEvent.change(slider("horizontal position"), { target: { value: "1" } });
    expect(onChange).toHaveBeenCalledWith({ x: 1, y: 0.5, zoom: 1 });
    expect(slider("horizontal position").value).toBe("0.5");
    result.rerender(<PhotoPreviewCrop {...defaults} value={{ x: 1, y: 0.5, zoom: 1 }} onChange={onChange} />);
    expect(crop().getAttribute("x")).toBe("450");
    expect((screen.getByAltText("Full preview photograph") as HTMLImageElement).src).toBe("blob:preview");
  });
});
