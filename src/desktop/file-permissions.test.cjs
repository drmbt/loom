/* global require */
/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { resolve } = require('node:path');
const { installFilePermissions } = require('./file-permissions.cjs');

const origin = 'http://127.0.0.1:5187';
const details = { requestingUrl: `${origin}/`, isMainFrame: false,
  filePath: resolve('test-project.loom.json'), isDirectory: false, fileAccessType: 'writable' };
function harness() {
  const session = new EventEmitter();
  let request;
  let check;
  session.setPermissionRequestHandler = handler => { request = handler; };
  session.setPermissionCheckHandler = handler => { check = handler; };
  const contents = new EventEmitter();
  contents.getURL = () => `${origin}/`;
  contents.isDestroyed = () => false;
  const reports = [];
  const prompts = [];
  installFilePermissions({ session, origin, report: message => reports.push(message),
    requestSystemAccess: async () => true,
    notify: () => {},
    confirm: async (_contents, options) => { prompts.push(options); return false; } });
  return { session, contents, reports, prompts,
    check: (...args) => check(...args),
    request: (permission = 'fileSystem', requested = details, from = contents) => {
      const replies = [];
      request(from, permission, result => replies.push(result), requested);
      return replies;
    },
  };
}
const tick = () => new Promise(resolve => require('node:timers').setImmediate(resolve));

/*
 * VNB4: a fileSystem CHECK is the whole decision (Electron 44.5.1 never reaches the request
 * handler for one), and it arrives with NO webContents and no requestingUrl: just the
 * requesting origin, as a URL, and the file details. These are that shape exactly, as
 * logged from real Electron; testing/file-access.test.cjs runs the same handler in Electron.
 */
const fileCheck = { fileAccessType: 'readable', filePath: resolve('clip.mov'), isDirectory: false, isMainFrame: false };

test('VNB4: a file Loom was given is readable and writable, in the shape Electron sends', () => {
  const h = harness();
  for (const fileAccessType of ['readable', 'writable']) {
    assert.equal(h.check(null, 'fileSystem', `${origin}/`, { ...fileCheck, fileAccessType }), true);
  }
  // A webContents, should a later Electron pass one, must be Loom's too.
  assert.equal(h.check(h.contents, 'fileSystem', `${origin}/`, fileCheck), true);
  const foreign = new EventEmitter();
  foreign.getURL = () => 'https://example.com/';
  foreign.isDestroyed = () => false;
  assert.equal(h.check(foreign, 'fileSystem', `${origin}/`, fileCheck), false);
  h.contents.isDestroyed = () => true;
  assert.equal(h.check(h.contents, 'fileSystem', `${origin}/`, fileCheck), false);
  assert.deepEqual(h.prompts, []);
});

test('VNB4: another origin, a directory, a relative or missing path and an unknown access are refused', () => {
  const h = harness();
  for (const requestingOrigin of ['https://example.com/', 'http://127.0.0.1:5188/', '', undefined]) {
    assert.equal(h.check(null, 'fileSystem', requestingOrigin, fileCheck), false, String(requestingOrigin));
  }
  for (const patch of [{ isDirectory: true }, { isDirectory: undefined }, { filePath: 'relative.mov' },
    { filePath: undefined }, { fileAccessType: 'unknown' }, { fileAccessType: undefined }]) {
    assert.equal(h.check(null, 'fileSystem', `${origin}/`, { ...fileCheck, ...patch }), false, JSON.stringify(patch));
  }
  assert.equal(h.check(null, 'fileSystem', `${origin}/`, undefined), false);
  // Only fileSystem is widened: another permission with the same details is not.
  assert.equal(h.check(null, 'geolocation', `${origin}/`, fileCheck), false);
});

test('a fileSystem request that reaches the request handler is refused without a prompt', async () => {
  const h = harness();
  assert.deepEqual(h.request('fileSystem', { ...details, fileAccessType: 'readable' }), [false]);
  assert.deepEqual(h.request('fileSystem', details, null), [false]);
  assert.deepEqual(h.request('geolocation'), [false]);
  await tick();
  assert.deepEqual(h.prompts, []);
  assert.equal(h.reports.length, 3);
});

test('restricted OS paths are denied', () => {
  const h = harness();
  let action;
  h.session.emit('file-system-access-restricted', {}, {}, result => { action = result; });
  assert.equal(action, 'deny');
});

test('T1408b: fullscreen and window-management are granted to Loom documents only', async () => {
  const h = harness();
  const ask = async (contents, permission, requestingUrl) => h.request(permission, { requestingUrl }, contents)[0];
  // The editor, and an about:blank loom-* popup (main.cjs denies any other popup).
  assert.equal(await ask(h.contents, 'fullscreen', `${origin}/`), true);
  assert.equal(await ask(h.contents, 'window-management', `${origin}/`), true);
  const popup = new EventEmitter();
  popup.getURL = () => 'about:blank';
  popup.isDestroyed = () => false;
  assert.equal(await ask(popup, 'fullscreen', 'about:blank'), true);
  // A foreign document never gets either, and nothing else is widened.
  const foreign = new EventEmitter();
  foreign.getURL = () => 'https://example.com/';
  foreign.isDestroyed = () => false;
  assert.equal(await ask(foreign, 'fullscreen', 'https://example.com/'), false);
  assert.equal(await ask(h.contents, 'window-management', 'https://example.com/'), false);
  assert.equal(await ask(h.contents, 'geolocation', `${origin}/`), false);
  // The CHECK side (navigator.permissions.query) agrees with the request side.
  assert.equal(h.check(h.contents, 'window-management', origin, { requestingUrl: `${origin}/` }), true);
  assert.equal(h.check(foreign, 'window-management', 'https://example.com', { requestingUrl: 'https://example.com/' }), false);
});
