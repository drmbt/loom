/* global require */
/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { installNativeFfgl, validFrame } = require('./native-ffgl.cjs');

const tick = () => new Promise(resolve => require('node:timers').setImmediate(resolve));
const SESSION = 'loom-ffgl-12345678-1234-1234-1234-123456789abc';
const TABLE = { id: 'VGNP', name: 'VignettePlus', pluginType: 0, version: '1.1', apiVersion: '2.2', description: '', about: '',
  supportsSetTime: false, clock: { mode: 'host' }, parameters: [{ index: 0, name: 'Size', type: 10 }], loadMs: 3 };

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'loom-native-ffgl-'));
  const contents = join(root, 'vignette-plus', 'VignettePlus.bundle', 'Contents', 'MacOS');
  mkdirSync(contents, { recursive: true });
  const binary = join(contents, 'VignettePlus');
  writeFileSync(binary, '');
  const handlers = new Map(), calls = [], windows = [], callbacks = [];
  const owner = new EventEmitter();
  owner.mainFrame = {}; owner.isDestroyed = () => false; owner.getURL = () => 'http://127.0.0.1:5187/';
  const event = { sender: owner, senderFrame: owner.mainFrame };
  let processResult = { handle: 'out-surface', leaseId: 'ffgl-lease-1', width: 640, height: 360, sequence: 1, bottomUp: true, timing: { gpuMs: 0.5 } };
  const native = {
    probe: async path => { calls.push(['probe', path]); return { ...TABLE, binary: path }; },
    open: async (path, width, height) => { calls.push(['open', path, width, height]); return { ...TABLE, binary: path, instance: 'ffgl-instance-1' }; },
    process: async (instance, surface, frame) => { calls.push(['process', instance, surface, frame]); return processResult; },
    release: lease => { calls.push(['release', lease]); },
    close: async instance => { calls.push(['close', instance]); },
  };
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.dead = false;
      this.webContents = Object.assign(new EventEmitter(), { mainFrame: {},
        stopPainting() { calls.push(['stop']); }, startPainting() { calls.push(['start']); } });
      windows.push(this);
    }
    isDestroyed() { return this.dead; }
    async loadURL(url) { this.url = url; }
    close() { this.dead = true; this.emit('closed'); }
    destroy() { this.close(); }
  }
  const sharedTexture = {
    importSharedTexture(options) { calls.push(['import', options.textureInfo]); callbacks.push(options.allReferencesReleased);
      return { release() { calls.push(['main-release']); } }; },
    async sendSharedTexture(_options, metadata) { calls.push(['send', metadata]); },
  };
  const adapter = installNativeFfgl({ ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, BrowserWindow: Window,
    sharedTexture, native, origin: 'http://127.0.0.1:5187', folders: () => [root] });
  const invoke = (method, ...args) => handlers.get(`loom-ffgl-${method}`)(event, ...args);
  const capture = () => { const sender = windows[0].webContents; return handlers.get('loom-ffgl-frame')({ sender, senderFrame: sender.mainFrame }); };
  const paint = (width = 640, height = 360) => windows[0].webContents.emit('paint', { texture: {
    textureInfo: { pixelFormat: 'bgra', codedSize: { width, height }, handle: { ioSurface: 'in-surface' } },
    release() { calls.push(['input-release']); } } });
  return { root, binary, adapter, native, handlers, owner, event, windows, callbacks, calls, invoke, capture, paint,
    setResult: result => { processResult = result; }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('list and describe resolve through the plugin folders and never hand the page a path', async () => {
  const h = harness();
  try {
    const listed = await h.invoke('list');
    assert.deepEqual(listed, { plugins: [{ name: 'VignettePlus', folderIndex: 0, shadowed: 0 }], excluded: [], missingFolders: 0 });
    const described = await h.invoke('describe', 'VignettePlus');
    assert.equal(described.id, 'VGNP');
    assert.equal('binary' in described, false);
    assert.deepEqual(h.calls[0], ['probe', h.binary]);
    await assert.rejects(Promise.resolve().then(() => h.invoke('describe', 'Missing')), /not in any plugin folder/);
    await assert.rejects(Promise.resolve().then(() => h.invoke('describe', '../../etc/passwd')), /Invalid FFGL plugin name/);
    const stranger = { sender: Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, getURL: () => 'https://evil.example/' }) };
    stranger.senderFrame = stranger.sender.mainFrame;
    assert.throws(() => h.handlers.get('loom-ffgl-list')(stranger), /app main frame/);
  } finally { h.cleanup(); }
});

test('one frame: prepared time and parameters reach the plugin, the result reaches the page bottom-first', async () => {
  const h = harness();
  try {
    const opened = await h.invoke('open', SESSION, 'VignettePlus', 640, 360);
    assert.equal(opened.session, SESSION); assert.equal('binary' in opened.plugin, false);
    assert.deepEqual(h.calls.find(call => call[0] === 'open'), ['open', h.binary, 640, 360]);
    assert.match(h.windows[0].url, /\/src\/desktop\/inference\.html\?name=loom-ffgl-[a-f0-9-]+&width=640&height=360$/);
    assert.match(h.windows[0].options.webPreferences.preload, /ffgl-capture-preload\.cjs$/);
    const frame = { time: 1.5, bpm: 128, barPhase: 0.25, parameters: [[0, 0.75], [4, true]], pulses: [7] };
    await h.invoke('prepare', SESSION, frame);
    const ready = h.capture();
    h.paint(); await tick(); await tick();
    assert.deepEqual(h.calls.find(call => call[0] === 'process'), ['process', 'ffgl-instance-1', 'in-surface', frame]);
    // The input surface is released only after the native job settled.
    const order = h.calls.map(call => call[0]);
    assert.ok(order.indexOf('input-release') > order.indexOf('process'));
    assert.deepEqual(h.calls.find(call => call[0] === 'import')[1].handle, { ioSurface: 'out-surface' });
    const sent = h.calls.find(call => call[0] === 'send')[1];
    assert.deepEqual({ ...sent, timing: undefined }, { session: SESSION, sequence: 1, width: 640, height: 360, bottomUp: true, timing: undefined });
    // The capture page is held until the PAGE lets go of the result, then the lease returns.
    let settled = false; void ready.then(() => { settled = true; });
    await tick(); assert.equal(settled, false);
    await assert.rejects(Promise.resolve().then(() => h.invoke('prepare', SESSION, frame)), /busy/);
    h.callbacks[0]();
    assert.deepEqual(await ready, { kind: 'completed' });
    assert.deepEqual(h.calls.filter(call => call[0] === 'release'), [['release', 'ffgl-lease-1']]);
    assert.deepEqual(await h.invoke('status', SESSION), { frames: 1, busy: false, error: null, timing: { gpuMs: 0.5 } });
    await h.invoke('close', SESSION);
    assert.deepEqual(h.calls.filter(call => call[0] === 'close'), [['close', 'ffgl-instance-1']]);
    assert.equal(h.windows[0].dead, true);
    assert.deepEqual(h.adapter.diagnostics(), []);
  } finally { h.cleanup(); }
});

test('a frame without prepared time, or a changed size, is a reported fault, never a clock read', async () => {
  const h = harness();
  try {
    await h.invoke('open', SESSION, 'VignettePlus', 640, 360);
    const ready = h.capture();
    h.paint();
    await assert.rejects(ready, /without prepared time/);
    assert.equal(h.calls.some(call => call[0] === 'process'), false);
    assert.equal(h.calls.filter(call => call[0] === 'input-release').length, 1);
    await assert.rejects(Promise.resolve().then(() => h.invoke('prepare', SESSION, { time: 0, bpm: 120, barPhase: 0 })), /without prepared time/);
    await h.invoke('close', SESSION);
  } finally { h.cleanup(); }
  const sized = harness();
  try {
    await sized.invoke('open', SESSION, 'VignettePlus', 640, 360);
    await sized.invoke('prepare', SESSION, { time: 0, bpm: 120, barPhase: 0 });
    const ready = sized.capture();
    sized.paint(320, 180);
    await assert.rejects(ready, /format\/size changed/);
    await sized.invoke('close', SESSION);
  } finally { sized.cleanup(); }
});

test('open validates its arguments and a navigation retires the session through native close', async () => {
  const h = harness();
  try {
    await assert.rejects(h.invoke('open', 'bad-name', 'VignettePlus', 640, 360), /session name/);
    await assert.rejects(h.invoke('open', SESSION, 'VignettePlus', 0, 360), /extent/);
    await assert.rejects(h.invoke('open', SESSION, 'Nope', 640, 360), /not in any plugin folder/);
    await h.invoke('open', SESSION, 'VignettePlus', 640, 360);
    await assert.rejects(h.invoke('open', SESSION, 'VignettePlus', 640, 360), /cap reached/);
    h.owner.emit('did-navigate');
    for (let i = 0; i < 5; i++) await tick();
    assert.deepEqual(h.calls.filter(call => call[0] === 'close'), [['close', 'ffgl-instance-1']]);
    assert.deepEqual(h.adapter.diagnostics(), []);
  } finally { h.cleanup(); }
});

test('frame validation refuses what the addon would reject', () => {
  assert.deepEqual(validFrame({ time: 0, bpm: 120, barPhase: 0 }), { time: 0, bpm: 120, barPhase: 0, parameters: [], pulses: [] });
  assert.throws(() => validFrame({ time: Number.NaN, bpm: 120, barPhase: 0 }), /finite/);
  assert.throws(() => validFrame({ time: 0, bpm: 120, barPhase: 0, parameters: [[-1, 0]] }), /pairs/);
  assert.throws(() => validFrame({ time: 0, bpm: 120, barPhase: 0, parameters: [[0, {}]] }), /pairs/);
  assert.throws(() => validFrame({ time: 0, bpm: 120, barPhase: 0, pulses: [1.5] }), /indices/);
});
