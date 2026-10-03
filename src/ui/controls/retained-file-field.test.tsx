// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileReference } from "@domain/media/file-reference.ts";
import { retainedFiles } from "../files/retained-files.ts";
import { AssetField } from "./curve-field.tsx";

vi.mock("../files/retained-files.ts", () => ({ retainedFiles: vi.fn() }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup(status: { kind: "pending" | "ready" | "permission" | "missing"; message?: string } = { kind: "pending" }) {
  const reference = createFileReference("clip", "video", "clip.mp4");
  const handle = { name: "clip.mp4" };
  const remember = vi.fn(async () => reference);
  const allow = vi.fn(async () => {});
  vi.mocked(retainedFiles).mockReturnValue({ remember, allow, snapshot: () => status,
    revision: () => 0, subscribe: () => () => {}, acquire: () => ({ release() {} }),
  } as unknown as ReturnType<typeof retainedFiles>);
  const picker = vi.fn(async () => [handle]);
  vi.stubGlobal("showOpenFilePicker", picker);
  return { reference, handle, remember, allow, picker };
}

describe("retained file picker", () => {
  it("reports malformed retained references while keeping the picker usable", () => {
    setup();
    render(<AssetField label="File" kind="picture" value="loom-file:broken#%" onPick={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toContain("Invalid retained file reference");
    expect(screen.getByRole("button", { name: "choose…" })).toBeDefined();
  });
  it("commits the durable reference after storing the handle, rather than a blob URL", async () => {
    const fixture = setup();
    const onPick = vi.fn();
    render(<AssetField label="File" kind="picture" value={null} onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: "choose…" }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(fixture.reference, "clip.mp4"));
    expect(fixture.remember).toHaveBeenCalledWith(fixture.handle, "video", undefined);
    expect(fixture.picker).toHaveBeenCalledOnce();
    const filters = fixture.picker.mock.calls[0] as unknown as [{ types: [{ accept: Record<string, string[]> }] }];
    expect(filters[0].types[0].accept["image/*"]).toContain(".png");
    expect(onPick.mock.calls[0]![0]).not.toContain("blob:");
  });
  it("does not change the document when storing the selected handle fails", async () => {
    const fixture = setup();
    fixture.remember.mockRejectedValue(new Error("File storage is full"));
    const onPick = vi.fn();
    render(<AssetField label="File" kind="audio" value={null} onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: "choose…" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("File storage is full");
    expect(onPick).not.toHaveBeenCalled();
  });
  it("allows the existing handle from a user click without opening the picker", async () => {
    const fixture = setup({ kind: "permission", message: "Access required" });
    render(<AssetField label="File" kind="picture" value={fixture.reference} onPick={vi.fn()} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Allow access" })));
    expect(fixture.allow).toHaveBeenCalledWith(fixture.reference);
    expect(fixture.picker).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "File" }).title).toContain("retained in this local profile");
  });
  it("relinks a missing handle while keeping its identity", async () => {
    const fixture = setup({ kind: "missing", message: "No handle" });
    const onPick = vi.fn();
    render(<AssetField label="File" kind="picture" value={fixture.reference} onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: "relink…" }));
    await waitFor(() => expect(onPick).toHaveBeenCalledOnce());
    expect(fixture.remember).toHaveBeenCalledWith(fixture.handle, "video", fixture.reference);
  });
  it("treats cancellation as cancellation, with no write", async () => {
    const fixture = setup();
    fixture.picker.mockRejectedValue(new DOMException("Cancelled", "AbortError"));
    const onPick = vi.fn();
    render(<AssetField label="File" kind="audio" value={null} onPick={onPick} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "choose…" })));
    expect(onPick).not.toHaveBeenCalled();
    expect(fixture.remember).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
