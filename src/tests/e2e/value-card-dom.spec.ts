import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * §B228 / §V1026 / §T1389b(d) — a wide value bag costs a value card a BOUNDED amount of DOM.
 *
 * E32 Pasture carries a forty-channel audio bag through ~28 value nodes. Before §T1389b
 * every card drew one socket row per channel and one bar row per channel, re-rendered per
 * history tick: 1124 socket rows and 1198 bar rows, the editor main thread at 100% and
 * the app at 20–25 fps. The row asked for a timing gate; this asserts the CAUSE instead,
 * which is deterministic where a frame-time threshold on a shared machine is not:
 *
 *  - no per-channel socket exists anywhere (`[data-channel]`);
 *  - every bar list mounts at most its scroll box plus one row either side, however many
 *    channels it holds.
 *
 * ## Why the headed lane
 *
 * The bar list is windowed from MEASURED row pitch, and jsdom has no layout — there every
 * row mounts by design (`barWindow`), so the claim can only be made where rows have a
 * height. Values also only arrive while frames run, which needs a real adapter.
 */

/** Four visible rows (`BAR_ROWS_BEFORE_SCROLL`) plus one either side. */
const MOUNTED_ROWS_AT_MOST = 6;

async function openExample(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name: "examples" }).click();
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  const confirm = page.getByRole("button", { name: "Open", exact: true });
  if ((await confirm.count()) > 0) await confirm.click();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
}

interface BarList {
  readonly id: string;
  readonly mounted: number;
  /** How many rows the list's scroll height stands for — the channels it carries. */
  readonly carried: number;
}

function barLists(page: Page): Promise<BarList[]> {
  return page.$$eval('[data-testid^="value-bars-"]', (lists) =>
    lists.map((list) => {
      const rows = [...list.querySelectorAll<HTMLElement>("[data-bar-row]")];
      const first = rows[0];
      const second = rows[1];
      const pitch = first !== undefined && second !== undefined ? second.offsetTop - first.offsetTop : 0;
      return {
        id: list.getAttribute("data-testid") ?? "?",
        mounted: rows.length,
        carried: pitch > 0 ? Math.round(list.scrollHeight / pitch) : rows.length,
      };
    }),
  );
}

test("E32's value cards mount a bounded number of rows, and no channel sockets", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("shaderloom.project.startOnStarter.v1", "off");
    } catch {
      /* a storage-blocked context has no starter either way */
    }
  });
  await page.goto("/");
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  await openExample(page, "E32 Pasture");

  // THE PREMISE: the document really does carry wide bags into its cards. Without this a
  // build that published nothing would pass every bound below by drawing nothing.
  await expect
    .poll(async () => (await barLists(page)).filter((list) => list.carried >= 20).length, {
      message: "E32 never showed a value card carrying a wide bag",
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(5);

  const lists = await barLists(page);
  const over = lists.filter((list) => list.mounted > MOUNTED_ROWS_AT_MOST);
  expect(over, "bar lists mounting more rows than their box shows").toEqual([]);
  expect(await page.locator("[data-channel]").count(), "per-channel sockets on the canvas").toBe(0);
});
