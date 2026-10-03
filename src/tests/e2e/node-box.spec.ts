import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { nodeBox, previewAspectOf } from "@domain/graph/node-box.ts";
import { EXAMPLE_DOCUMENTS } from "../../examples/documents.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { createComponentSystem } from "../../domain/components/registry.ts";
import { buildStarterComponents } from "../../examples/starter-components.ts";
import { APP_VIEWPORT } from "./app.ts";

/**
 * THE SIZE MODEL IS PINNED TO THE REAL DOM (T460, §V389, §V339).
 *
 * `src/domain/graph/node-box.ts` predicts a node's rendered box from its definition and
 * the document, and `src/examples/layout.test.ts` gates every shipped example on it. That
 * gate is worth exactly as much as the model: if the CSS moves and the arithmetic does
 * not, the gate goes green while the examples overlap — which is the bug it exists to
 * catch, one level up. A model nobody measures is a guess with a docstring.
 *
 * jsdom paints nothing (§V339), so this cannot live in the jsdom suite. It lives here,
 * where a real browser lays real nodes out, and it compares the model's numbers against
 * MEASURED ones for the same shipped documents. Change `node-view.module.css` and this
 * goes red naming every node that drifted.
 *
 * `offsetWidth`/`offsetHeight` rather than `boundingBox()`, deliberately: React Flow
 * scales the viewport with a CSS transform, so a bounding box is screen pixels at
 * whatever zoom the fit landed on, while the offset pair is the node's own graph-space
 * box — the space positions are authored in and the space the model predicts.
 *
 * No GPU needed (see `app.ts` on what this environment has): a node's chrome is the same
 * size whether or not its preview ever receives pixels.
 */

test.use({ viewport: { width: APP_VIEWPORT.width, height: APP_VIEWPORT.height } });

/**
 * T1515b — THE MODEL'S REGISTRY IS THE GATE'S REGISTRY, COMPONENTS INCLUDED.
 *
 * This spec used to size nodes through a bare `createNodeRegistry(allNodeDefinitions)`,
 * which has no `component:…` type in it. A definition that does not resolve is modelled
 * as chrome only — 34 px — so E24's `analysis` (an Audio Analysis INSTANCE) failed at
 * 34 vs 165 on a mismatch that was the spec's own, and everything listed after E24 was
 * never measured. `layout.test.ts` has sized instances through the component-aware pair
 * since T956; this is the same pair, fed the same starter definitions the shipped files
 * embed, so the box measured here is the box the §V389 gate lays out with.
 */
const { components, nodes: registry } = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
for (const built of await buildStarterComponents()) components.register(built.definition);

type ExampleDocument = (typeof EXAMPLE_DOCUMENTS)[number];

function modelledBoxes(document: ExampleDocument): Record<string, { width: number; height: number }> {
  return Object.fromEntries(
    Object.values(document.graph.nodes).map((node) => {
      const definition = registry.get(node.type);
      // The cause of T1515b, refused rather than sized: an unresolved definition yields a
      // plausible chrome-only box, and a comparison against it says nothing about the model.
      if (definition === undefined) {
        throw new Error(`${document.name}: "${node.id}" is a ${node.type}, which this spec's registry cannot resolve`);
      }
      const box = nodeBox(
        node,
        definition,
        previewAspectOf(document.settings),
        // T695: variadic inputs render one socket per edge plus a spare, so the model
        // cannot predict a node's height from its definition alone any more.
        document.graph,
        // T1541b: a look's instance draws a bank's "+ panel"; only the catalogue says which.
        components,
      );
      return [node.id, { width: box.width, height: box.height }];
    }),
  );
}

async function openExample(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name: "examples" }).click();
  // A row's accessible name STARTS with the example's name; the E-number and the space
  // after it keep `E1 …` from also matching `E10 …`.
  const literal = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await page.getByRole("button", { name: new RegExp(`^${literal}`) }).click();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
}

/*
 * EVERY SHIPPED EXAMPLE, ONE TEST EACH (T1515b). The gate applies the model to every
 * document in `EXAMPLE_DOCUMENTS`, so a hand-picked five left the other sixty-odd laid out
 * on arithmetic nobody had measured — and one loop over them stopped at the first example
 * that disagreed. A test per example cannot hide a later one behind an earlier failure,
 * and each gets a fresh page: no previous example's nodes still on the canvas to be
 * counted as this one's, and no dirty document to ask about before opening.
 */
for (const document of EXAMPLE_DOCUMENTS) {
  test(`${document.name}: the derived node box is the box the browser renders`, async ({ page }) => {
    const expected = modelledBoxes(document);
    /*
     * This spec navigates itself rather than going through `openApp`, so it opts out of the
     * starter network here (the shipped preference, same key the settings dialog writes).
     * Without it the app boots into E6 and the first `openExample` races the starter's own
     * load — measured: six nodes on screen where the spec was counting nine.
     */
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("shaderloom.project.startOnStarter.v1", "off");
      } catch {
        /* a storage-blocked context has no starter either way */
      }
    });
    await page.goto("/");
    await expect(page.getByTestId("graph-canvas")).toBeVisible();
    await openExample(page, document.name);

    await expect
      .poll(async () => Object.keys(await measure(page)).length, {
        message: `${document.name} never rendered its nodes`,
      })
      .toBe(Object.keys(expected).length);

    // Compared as ONE object so a failure lists every node that drifted, not the first.
    expect(await measure(page), `${document.name}: the DOM and node-box.ts disagree`).toEqual(expected);
  });
}

/**
 * The box the DOCUMENT gives a node: its rendered box less the rows that are runtime state.
 *
 * `node-box.ts` says outright that it does not model the diagnostic message, the inference
 * note or the agent-activity row — the same document renders with and without them, and
 * the layout gate's vertical gutter is what covers them. `node-view.tsx` marks each
 * `data-runtime-row`, and they are subtracted HERE rather than left to fail: T1515b found
 * E71–E74's Syphon/NDI/Spout/Vision nodes 36 px over the model in every browser, because
 * "cannot run on this machine" is a message row a page always shows for them.
 */
function measure(page: Page): Promise<Record<string, { width: number; height: number }>> {
  return page.$$eval(".react-flow__node", (nodes) =>
    Object.fromEntries(
      nodes.map((node) => {
        const runtime = [...node.querySelectorAll<HTMLElement>("[data-runtime-row]")].reduce((sum, row) => {
          const style = getComputedStyle(row);
          return sum + row.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
        }, 0);
        return [
          node.getAttribute("data-id") ?? "?",
          { width: (node as HTMLElement).offsetWidth, height: (node as HTMLElement).offsetHeight - runtime },
        ];
      }),
    ),
  );
}
