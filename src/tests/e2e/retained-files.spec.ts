import { _electron, expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = "/src/desktop/testing/retained-file-fixture.html";
const SAVED_PROJECT = "retained-proof.loom.json";

interface Baseline {
  readonly references: readonly string[];
  readonly urls: readonly string[];
  readonly bytes: readonly number[][];
  readonly project: string;
}

/** Real browser-owned handles and bytes. No App, backend, media decoder, or GPU is loaded. */
async function prepare(page: Page): Promise<Baseline> {
  return page.evaluate(async savedName => {
    const moduleAt = async <T>(path: string): Promise<T> => await import(path) as T;
    const { retainedFiles } = await moduleAt<typeof import("@ui/files/retained-files.ts")>("/src/ui/files/retained-files.ts");
    const { buildProjectFile } = await moduleAt<typeof import("@domain/project/project-file.ts")>("/src/domain/project/project-file.ts");
    const { document, settings } = await moduleAt<typeof import("@/examples/documents/builders.ts")>("/src/examples/documents/builders.ts");
    const directory = await navigator.storage.getDirectory();
    const broker = retainedFiles();
    const samples = [
      { name: "retained-picture.png", kind: "video" as const, bytes: [137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3] },
      { name: "retained-audio.wav", kind: "audio" as const, bytes: [82, 73, 70, 70, 4, 0, 0, 0, 87, 65, 86, 69, 4, 5, 6] },
    ];
    const references: string[] = [], urls: string[] = [], bytes: number[][] = [];
    for (const sample of samples) {
      const handle = await directory.getFileHandle(sample.name, { create: true });
      const writer = await handle.createWritable();
      await writer.write(new Uint8Array(sample.bytes));
      await writer.close();
      const reference = await broker.remember(handle as FileSystemFileHandle & import("@ui/files/retained-files.ts").RetainedFileHandle, sample.kind);
      const lease = broker.acquire(reference);
      // Retain the leases across navigation: the old document's URLs must still disappear.
      (window as unknown as { retainedProofLeases: unknown[] }).retainedProofLeases ??= [];
      (window as unknown as { retainedProofLeases: unknown[] }).retainedProofLeases.push(lease);
      await new Promise<void>((resolve, reject) => {
        const inspect = () => {
          const snapshot = broker.snapshot(reference);
          if (snapshot.kind === "ready") { unsubscribe(); resolve(); }
          else if (snapshot.kind !== "pending") { unsubscribe(); reject(new Error(snapshot.message)); }
        };
        const unsubscribe = broker.subscribe(inspect);
        inspect();
      });
      const snapshot = broker.snapshot(reference);
      if (snapshot.kind !== "ready") throw new Error("Prepared file did not become ready");
      references.push(reference); urls.push(snapshot.url);
      bytes.push([...new Uint8Array(await (await fetch(snapshot.url)).arrayBuffer())]);
    }
    const graph = { revision: 1, edges: {}, groups: {}, nodes: {
      movie: { id: "movie", type: "movieFileIn", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { file: references[0]! } },
      audio: { id: "audio", type: "audioFileIn", definitionVersion: 1, position: { x: 200, y: 0 }, parameters: { file: references[1]! } },
    } };
    const project = buildProjectFile({ document: document("retained-proof", "Retained proof",
      settings({ outputResolution: { width: 64, height: 64 } }), graph), now: () => "2026-10-03T00:00:00.000Z" }).text;
    const saved = await directory.getFileHandle(savedName, { create: true });
    const writer = await saved.createWritable(); await writer.write(project); await writer.close();
    return { references, urls, bytes, project };
  }, SAVED_PROJECT);
}

async function restore(page: Page, baseline: Baseline) {
  return page.evaluate(async ({ baseline, savedName }) => {
    const moduleAt = async <T>(path: string): Promise<T> => await import(path) as T;
    const { retainedFiles } = await moduleAt<typeof import("@ui/files/retained-files.ts")>("/src/ui/files/retained-files.ts");
    const { loadProject } = await moduleAt<typeof import("@domain/project/load.ts")>("/src/domain/project/load.ts");
    const { createNodeRegistry } = await moduleAt<typeof import("@nodes/registry/registry.ts")>("/src/nodes/registry/registry.ts");
    const { allNodeDefinitions } = await moduleAt<typeof import("@nodes/definitions/index.ts")>("/src/nodes/definitions/index.ts");
    const directory = await navigator.storage.getDirectory();
    const saved = await directory.getFileHandle(savedName);
    const text = await (await saved.getFile()).text();
    const loaded = loadProject(text, { nodes: createNodeRegistry(allNodeDefinitions).view() });
    if (!loaded.ok) throw new Error(loaded.reason);
    const broker = retainedFiles();
    const references = [loaded.document.graph.nodes.movie?.parameters.file, loaded.document.graph.nodes.audio?.parameters.file];
    const bytes: number[][] = [], urls: string[] = [], revoked: boolean[] = [];
    for (const reference of references) {
      if (typeof reference !== "string") throw new Error("Saved project lost its durable file reference");
      const lease = broker.acquire(reference);
      try {
        await new Promise<void>((resolve, reject) => {
          const inspect = () => {
            const snapshot = broker.snapshot(reference);
            if (snapshot.kind === "ready") { unsubscribe(); resolve(); }
            else if (snapshot.kind !== "pending") { unsubscribe(); reject(new Error(snapshot.message)); }
          };
          const unsubscribe = broker.subscribe(inspect); inspect();
        });
        const snapshot = broker.snapshot(reference);
        if (snapshot.kind !== "ready") throw new Error("Retained handle did not reopen");
        urls.push(snapshot.url); bytes.push([...new Uint8Array(await (await fetch(snapshot.url)).arrayBuffer())]);
      } finally { lease.release(); }
    }
    for (const oldUrl of baseline.urls) {
      let failed = false;
      try { await fetch(oldUrl); } catch { failed = true; }
      revoked.push(failed);
    }
    return { text, references, bytes, urls, revoked, assets: loaded.document.assets,
      placeholders: loaded.placeholders, relink: loaded.assetsToRelink, diagnostics: loaded.diagnostics,
      scriptSources: [...document.scripts].map(script => script.src) };
  }, { baseline, savedName: SAVED_PROJECT });
}

function assertRestored(baseline: Baseline, reopened: Awaited<ReturnType<typeof restore>>) {
  expect(baseline.references.every(reference => reference.startsWith("loom-file:"))).toBe(true);
  expect(baseline.bytes).toEqual([[137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3], [82, 73, 70, 70, 4, 0, 0, 0, 87, 65, 86, 69, 4, 5, 6]]);
  expect(baseline.project).not.toContain("blob:");
  expect(reopened.text).toBe(baseline.project);
  expect(reopened.references).toEqual(baseline.references);
  expect(reopened.bytes).toEqual(baseline.bytes);
  expect(reopened.urls).toHaveLength(2);
  for (let i = 0; i < 2; i++) expect(reopened.urls[i]).not.toBe(baseline.urls[i]);
  expect(reopened.revoked).toEqual([true, true]);
  expect(reopened.assets).toHaveLength(2);
  expect(reopened.assets.every(asset => asset.source.kind === "fileHandle")).toBe(true);
  expect(reopened.placeholders).toEqual([]);
  expect(reopened.relink).toEqual([]);
  expect(reopened.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
  expect(reopened.scriptSources.every(source => !source.includes("/src/main.tsx"))).toBe(true);
}

// OPFS grants access by origin. These tests prove persisted structured-cloned handles,
// not external filesystem permission prompts or OS-picker permission restoration.
test("browser reload restores retained video/audio references with fresh blob URLs", async ({ page }) => {
  await page.goto(FIXTURE);
  const baseline = await prepare(page);
  await page.reload();
  assertRestored(baseline, await restore(page, baseline));
});

test("Electron process restart restores retained handles from the same isolated profile", async ({ baseURL }) => {
  test.setTimeout(45_000);
  if (baseURL === undefined) throw new Error("Persistence fixture requires its owned test origin");
  const temporary = await mkdtemp(join(tmpdir(), "loom-retained-files-"));
  const main = join(temporary, "main.cjs");
  const preload = join(temporary, "preload.cjs");
  const profile = join(temporary, "profile");
  await mkdir(profile);
  const origin = new URL(FIXTURE, baseURL).href;
  // Electron's public renderer Process properties expose the real security configuration.
  await writeFile(preload, `const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('retainedProofSecurity', {
  sandboxed: process.sandboxed, contextIsolated: process.contextIsolated,
});\n`);
  await writeFile(main, `const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(profile)});
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: ${JSON.stringify(preload)} } });
  window.loadURL(${JSON.stringify(origin)});
});
app.on('window-all-closed', () => app.quit());\n`);
  const executablePath = createRequire(import.meta.url)("electron") as string;
  let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    application = await _electron.launch({ executablePath, args: [main], env: { ...process.env, ELECTRON_RUN_AS_NODE: "" } });
    const first = await application.firstWindow();
    await first.waitForURL(origin);
    const baseline = await prepare(first);
    expect(await first.evaluate(() => {
      const view = window as unknown as { retainedProofSecurity: { sandboxed: boolean; contextIsolated: boolean }; require?: unknown };
      return [view.retainedProofSecurity.sandboxed, view.retainedProofSecurity.contextIsolated, typeof view.require];
    })).toEqual([true, true, "undefined"]);
    await application.close(); application = undefined;
    application = await _electron.launch({ executablePath, args: [main], env: { ...process.env, ELECTRON_RUN_AS_NODE: "" } });
    const second = await application.firstWindow(); await second.waitForURL(origin);
    assertRestored(baseline, await restore(second, baseline));
  } finally {
    await application?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
