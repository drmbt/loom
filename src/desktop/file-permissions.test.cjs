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
  let answer;
  let fail;
  installFilePermissions({ session, origin, report: message => reports.push(message),
    requestSystemAccess: async () => true,
    notify: () => {},
    confirm: async (_contents, options) => {
      prompts.push(options);
      return new Promise((resolve, reject) => { answer = resolve; fail = reject; });
    } });
  return { session, contents, reports, prompts,
    check: (...args) => check(...args),
    request: (permission = 'fileSystem', requested = details, from = contents) => {
      const replies = [];
      request(from, permission, result => replies.push(result), requested);
      return replies;
    },
    answer: allowed => answer(allowed), fail: () => fail(new Error('dialog unavailable')),
  };
}
const tick = () => new Promise(resolve => require('node:timers').setImmediate(resolve));

test('exact file/read-write consent; isMainFrame=false is valid for current Electron fileSystem', async () => {
  for (const fileAccessType of ['readable', 'writable']) {
    const h = harness();
    assert.equal(h.check(h.contents, 'fileSystem', origin, details), false);
    const replies = h.request('fileSystem', { ...details, fileAccessType });
    await tick();
    assert.equal(h.prompts[0].detail, details.filePath);
    assert.match(h.prompts[0].message, fileAccessType === 'readable' ? /read/ : /modify/);
    assert.equal(h.prompts[0].cancelId, 0);
    assert.equal(h.prompts[0].defaultId, 0);
    assert.deepEqual(replies, []);
    h.answer(true);
    await tick();
    assert.deepEqual(replies, [true]);
    assert.equal(h.contents.listenerCount('did-start-navigation'), 0);
  }
});

test('invalid, foreign, directory and non-file permissions never open a prompt', async () => {
  const h = harness();
  for (const patch of [{ requestingUrl: 'https://example.com/' }, { requestingUrl: undefined },
    { filePath: undefined }, { filePath: 'relative.json' }, { isDirectory: true },
    { isDirectory: undefined }, { fileAccessType: 'unknown' }]) {
    assert.deepEqual(h.request('fileSystem', { ...details, ...patch }), [false]);
  }
  assert.deepEqual(h.request('media'), [false]);
  assert.deepEqual(h.request('fileSystem', details, null), [false]);
  h.contents.getURL = () => 'https://example.com/';
  assert.deepEqual(h.request(), [false]);
  await tick();
  assert.deepEqual(h.prompts, []);
});

test('deny and dialog failure reject rather than granting or throwing silently', async () => {
  for (const fail of [false, true]) {
    const h = harness();
    const replies = h.request();
    await tick();
    if (fail) h.fail(); else h.answer(false);
    await tick();
    assert.deepEqual(replies, [false]);
    assert.equal(h.reports.length, fail ? 1 : 0);
  }
});

test('navigation or destruction rejects immediately; late consent cannot grant a new document', async () => {
  for (const event of ['did-start-navigation', 'destroyed']) {
    const h = harness();
    const replies = h.request();
    await tick();
    h.contents.emit(event);
    assert.deepEqual(replies, [false]);
    h.answer(true);
    await tick();
    assert.deepEqual(replies, [false]);
    assert.equal(h.contents.listenerCount('destroyed'), 0);
  }
});

test('simultaneous prompts are denied and restricted OS paths cannot be approved', async () => {
  const h = harness();
  const first = h.request();
  assert.deepEqual(h.request(), [false]);
  await tick();
  h.answer(false);
  await tick();
  assert.deepEqual(first, [false]);
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
