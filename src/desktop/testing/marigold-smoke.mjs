/* global window, Blob, URL, console, AbortController */
import { _electron, chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// Explicit expensive proof. The ordinary desktop checks never load this model.
const root = fileURLToPath(new URL('../../..', import.meta.url));
const photoPath = process.env.LOOM_MARIGOLD_TEST_PHOTO;
if (!photoPath) throw new Error('Set LOOM_MARIGOLD_TEST_PHOTO to a local reference photograph.');
const origin = process.env.LOOM_DESKTOP_URL;
if (!origin) throw new Error('Set LOOM_DESKTOP_URL to the running local Loom server.');
const executable = process.env.LOOM_DESKTOP_EXECUTABLE;
if (!executable) throw new Error('Set LOOM_DESKTOP_EXECUTABLE to the Electron executable used by this desktop checkout.');
const photo = await readFile(photoPath);
const name = photoPath.split('/').at(-1);
const profile = await mkdtemp(join(tmpdir(), 'loom-marigold-desktop-'));
const output = join(root, '.cache/marigold-v2/smoke');
await mkdir(output, { recursive: true });
let app, browser, appClosed = false;
try {
  app = await _electron.launch({ executablePath: executable,
  args: [join(root, 'src/desktop/testing/electron-entry.cjs')],
  env: { ...process.env, LOOM_DESKTOP_PROFILE: profile, LOOM_MARIGOLD_TEST_MAIN: join(root, 'src/desktop/main.cjs') }, timeout: 30000 });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => {
    if (dialog.type() === 'beforeunload') return; // Main owns the awaited unload gate.
    errors.push(`Unexpected ${dialog.type()} dialog: ${dialog.message()}`);
    void dialog.dismiss().catch(error => errors.push(error.message));
  });
  await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: 60000 });
  const capability = await page.evaluate(() => window.loomDesktop.preparation.probe());
  assert.equal(capability.available, true, capability.reason);
  assert.equal(await page.evaluate(() => window.loomDesktop.nativeOutput), undefined);
  assert.equal(await page.evaluate(() => window.loomDesktop.input), undefined);
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Map from photo…', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('group', { name: 'Reference photo', exact: true }).locator('input[type=file]').setInputFiles({ name, mimeType: 'image/webp', buffer: photo });
  await dialog.getByRole('combobox', { name: 'Depth model', exact: true }).selectOption('marigold-v2-q4');
  await expect(dialog.getByRole('combobox', { name: 'Detail', exact: true })).toHaveValue('512');
  await expect(dialog.getByRole('combobox', { name: 'Inference backend', exact: true })).toHaveValue('mlx');
  await expect(dialog.getByRole('button', { name: 'Run depth', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Run depth', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Rerun depth', exact: true })).toBeEnabled({ timeout: 180000 });
  assert.equal(await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0];
    return main.webContents.getURL();
  }), `${origin}/`);
  await page.screenshot({ path: join(output, 'desktop.png') });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const artifact = await page.evaluate(async bytes => {
    const { createPhotoPreparer, decodePreparationPhoto } = await import('/src/app/photo-preparation.ts');
    const { DEFAULT_MARIGOLD_RECIPE } = await import('/src/domain/media/photo-depth-recipe.ts');
    const { encodeDepthExr } = await import('/src/runtime/media/depth-exr.ts');
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
    const photo = await decodePreparationPhoto(url, 'reference.webp', new AbortController().signal);
    const preparer = createPhotoPreparer(() => {});
    try {
      const map = await preparer.run({ kind: 'depth', photo, recipe: DEFAULT_MARIGOLD_RECIPE });
      return { bytes: Array.from(encodeDepthExr(map)), width: map.width, height: map.height };
    } finally { preparer.dispose(); photo.bitmap.close(); URL.revokeObjectURL(url); }
  }, Array.from(photo));
  await writeFile(join(output, 'native.loom.exr'), Buffer.from(artifact.bytes));
  assert.deepEqual(await app.evaluate(() => process.getBuiltinModule('module').createRequire(process.env.LOOM_MARIGOLD_TEST_MAIN)(process.env.LOOM_MARIGOLD_TEST_MAIN).nativePreparationDiagnostics()), []);
  assert.deepEqual(errors, []);
  await app.close();
  appClosed = true;
  browser = await chromium.launch({ headless: true });
  const web = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await web.goto(`${origin}/`);
  const reused = await web.evaluate(async bytes => {
    const { decodeDepthExr } = await import('/src/runtime/media/depth-exr.ts');
    const { preparedMetadata, rasterizeFloatMap } = await import('/src/runtime/media/prepared-map.ts');
    const map = decodeDepthExr(new Uint8Array(bytes));
    const values = rasterizeFloatMap(map, 'depth', 900, 900);
    return { desktop: window.loomDesktop !== undefined, metadata: preparedMetadata(map),
      finite: values.every(Number.isFinite), width: map.width, height: map.height };
  }, artifact.bytes);
  assert.equal(reused.desktop, false);
  assert.equal(reused.finite, true);
  assert.equal(reused.metadata.semantics, 'relative-log');
  assert.equal(reused.metadata.recipe.seed, 2025);
  assert.equal(reused.width, artifact.width);
  assert.equal(reused.height, artifact.height);
  console.log(JSON.stringify({ passed: true, native: `${artifact.width}x${artifact.height}`, browserReuse: true, output }));
} finally {
  if (app && !appClosed) await app.close();
  await browser?.close();
  await rm(profile, { recursive: true, force: true });
}
