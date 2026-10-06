import { expect, test } from "@playwright/test";

interface MidiProof {
  send(value: number): void;
  snapshot(): { requests: number; revision: number; value: number; diagnostics: unknown[] };
  dispose(): void;
}

test("learn on a wired control board follows real decoded CC without document writes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/src/tests/e2e/panel-midi-fixture.html");
  const slider = page.getByRole("slider", { name: "Heat" });
  await expect(slider).toBeVisible();
  const before = await page.evaluate(() => (window as unknown as { panelMidiProof: MidiProof }).panelMidiProof.snapshot());
  expect(before.requests).toBe(0);
  await page.getByRole("button", { name: "MIDI Learn" }).click();
  await expect(page.getByRole("status")).toContainText("Click a control");
  await slider.click();
  await expect(page.getByRole("status")).toContainText("Move a MIDI control for Heat");
  await page.evaluate(() => (window as unknown as { panelMidiProof: MidiProof }).panelMidiProof.send(127));
  await expect(page.getByRole("status")).toContainText("Mapped Heat");
  await expect(slider).toHaveAttribute("aria-valuenow", "8");
  const mapped = await page.evaluate(() => (window as unknown as { panelMidiProof: MidiProof }).panelMidiProof.snapshot());
  expect(mapped.revision).toBe(before.revision + 1);
  expect(mapped.value).toBe(8);
  expect(mapped.diagnostics).toEqual([]);
  await page.evaluate(() => (window as unknown as { panelMidiProof: MidiProof }).panelMidiProof.send(0));
  await expect(slider).toHaveAttribute("aria-valuenow", "2");
  expect(await page.evaluate(() => (window as unknown as { panelMidiProof: MidiProof }).panelMidiProof.snapshot().revision)).toBe(mapped.revision);
  await page.getByRole("button", { name: "Unlink MIDI" }).click();
  await expect(slider).toHaveAttribute("aria-valuenow", "4");
  expect(errors).toEqual([]);
  await page.evaluate(() => (window as unknown as { panelMidiProof: MidiProof }).panelMidiProof.dispose());
});
