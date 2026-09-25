import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import console from 'node:console';
import process from 'node:process';

const server = await createServer({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  server: { host: '127.0.0.1', port: 5206, strictPort: true },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: false, args: ['--mute-audio'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.text().startsWith('PROBE ')) console.log(message.text());
  });
  await page.goto('http://127.0.0.1:5206/experiments/canvas-export/' + (process.env.PARITY_ONLY === '1' ? '?parityOnly' : ''));
  const result = await page.evaluate(() => globalThis.canvasExportProbe());
  if (errors.length) throw new Error(errors.join('\n'));
  const report = { browser: browser.version(), ...result };
  const destination = process.argv[2] ?? '/tmp/loom-canvas-export-probe.json';
  await writeFile(destination, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!result.passed) process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
