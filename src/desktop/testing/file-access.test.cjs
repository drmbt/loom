// VNB4 — file handles through Loom's real permission handlers, in real Electron.
//
//   ./node_modules/.bin/electron src/desktop/testing/file-access.test.cjs
//
// Loom's own `installFilePermissions` goes on the default session; a page served from Loom's
// origin is handed a REAL FileSystemFileHandle by a CDP drag-and-drop (a native file picker
// cannot be driven from a test, and Electron answers a dropped handle exactly as a picked
// one — both are a user's gesture), then the same handle restored from IndexedDB after a
// reload, as a reopened project restores its media. It must read and write both, with no
// dialog. A directory and a page from another origin must be refused. Exits non-zero on
// any failure. The unit test beside the handler (file-permissions.test.cjs) calls the
// handlers directly; this is the one that proves Electron composes them the way they assume.
/* global require */
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const console = require('node:console');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const process = require('node:process');
const { setTimeout } = require('node:timers');
const { URL } = require('node:url');
const { installFilePermissions } = require('../file-permissions.cjs');

const PAGE = `<!doctype html><body style="margin:0;width:100vw;height:100vh"><script>
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', async e => { e.preventDefault();
  try { window.h = await e.dataTransfer.items[0].getAsFileSystemHandle(); window.dropped = window.h.kind; }
  catch (err) { window.dropped = 'ERR ' + err.name; } });
const idb = () => new Promise((res, rej) => { const r = indexedDB.open('vnb4', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('h'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
window.save = async () => { const db = await idb(); await new Promise((res, rej) => { const t = db.transaction('h', 'readwrite');
  t.objectStore('h').put(window.h, 'k'); t.oncomplete = res; t.onerror = () => rej(t.error); }); return 'saved'; };
window.load = async () => { const db = await idb(); window.h = await new Promise((res, rej) => {
  const q = db.transaction('h').objectStore('h').get('k'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); return window.h ? 'loaded' : 'none'; };
window.read = async () => { const out = { query: await window.h.queryPermission({ mode: 'read' }) };
  try { out.text = await (await window.h.getFile()).text(); } catch (e) { out.text = 'ERR ' + e.name; } return out; };
window.write = async text => { try { const w = await window.h.createWritable(); await w.write(text); await w.close(); return 'ok'; }
  catch (e) { return 'ERR ' + e.name; } };
window.list = async () => { try { const names = []; for await (const name of window.h.keys()) names.push(name); return names.join(','); }
  catch (e) { return 'ERR ' + e.name; } };
</script></body>`;

const failures = [];
const prompts = [];
const reports = [];
const check = (label, fn) => { try { fn(); console.log(`ok   ${label}`); } catch (error) { failures.push(label); console.log(`FAIL ${label}\n     ${error.message.split('\n').join('\n     ')}`); } };

function serve() {
  const server = http.createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end(PAGE); });
  return new Promise(done => server.listen(0, '127.0.0.1', () => done({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

async function drop(win, target) {
  const debug = win.webContents.debugger;
  if (!debug.isAttached()) debug.attach('1.3');
  const data = { items: [], files: [target], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await debug.sendCommand('Input.dispatchDragEvent', { type, x: 50, y: 50, data });
  for (let tries = 0; tries < 50; tries += 1) {
    const dropped = await win.webContents.executeJavaScript('window.dropped', true);
    if (dropped !== undefined) return dropped;
    await new Promise(done => setTimeout(done, 20));
  }
  return 'timeout';
}

setTimeout(() => { console.error('file-access test watchdog'); app.exit(2); }, 30000);

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-file-access-'));
  const file = path.join(dir, 'clip.txt');
  const folder = path.join(dir, 'media');
  fs.writeFileSync(file, 'hello');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'inside.txt'), 'x');
  const ours = await serve();
  const foreign = await serve();
  installFilePermissions({
    session: session.defaultSession, origin: new URL(ours.url).origin,
    confirm: async (_contents, options) => { prompts.push(options.message); return false; },
    report: message => reports.push(message), requestSystemAccess: async () => true, notify: () => {},
  });
  const open = async url => {
    const win = new BrowserWindow({ width: 400, height: 300, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    await win.loadURL(url);
    return win;
  };
  const js = (win, code) => win.webContents.executeJavaScript(code, true);

  const win = await open(ours.url);
  const dropped = await drop(win, file);
  check('a dropped file arrives as a file handle', () => assert.equal(dropped, 'file'));
  const fresh = await js(win, 'window.read()');
  check('the handle just given is readable, with no dialog', () => assert.deepEqual(fresh, { query: 'granted', text: 'hello' }));
  const wrote = await js(win, "window.write('changed')");
  check('the handle just given is writable (Save to a picked file)', () => {
    assert.equal(wrote, 'ok');
    assert.equal(fs.readFileSync(file, 'utf8'), 'changed');
  });
  await js(win, 'window.save()');
  await win.loadURL(ours.url);
  await js(win, 'window.load()');
  const restored = await js(win, 'window.read()');
  check('the same handle restored from storage after a reload reads again (a reopened project relinks its media)', () =>
    assert.deepEqual(restored, { query: 'granted', text: 'changed' }));

  await win.loadURL(ours.url);
  const folderDrop = await drop(win, folder);
  const listed = folderDrop === 'directory' ? await js(win, 'window.list()') : `not a directory: ${folderDrop}`;
  check('a dropped directory is refused', () => {
    assert.equal(folderDrop, 'directory');
    assert.equal(listed, 'ERR NotAllowedError');
  });

  const away = await open(foreign.url);
  const foreignDrop = await drop(away, file);
  const foreignRead = foreignDrop === 'file' ? await js(away, 'window.read()') : { query: `no handle: ${foreignDrop}` };
  check('a page from another origin is refused the same file', () => {
    assert.equal(foreignDrop, 'file');
    assert.deepEqual(foreignRead, { query: 'denied', text: 'ERR NotAllowedError' });
  });

  check('no consent dialog was ever raised', () => assert.deepEqual(prompts, []));
  console.log(`${failures.length === 0 ? 'PASS' : 'FAIL'} file-access (Electron ${process.versions.electron})${reports.length ? `; reports: ${reports.join(' | ')}` : ''}`);
  ours.server.close();
  foreign.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  app.exit(failures.length === 0 ? 0 : 1);
});
