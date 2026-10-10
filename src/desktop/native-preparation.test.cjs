/* global require */
/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installNativePreparation } = require('./native-preparation.cjs');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => require('node:timers').setImmediate(resolve));
const request = (inputSide = 512, height = 256) => ({ modelId: 'marigold-v2-q4', inputSide, seed: 2025,
  width: inputSide, height, rgba: new ArrayBuffer(inputSide * height * 4) });
const result = () => ({ width: 512, height: 256, semantics: 'relative-log',
  values: new Float32Array(512 * 256).fill(0.25).buffer });
function harness() {
  const handlers = new Map(), tasks = [];
  const owner = new EventEmitter();
  let destroyed = false;
  owner.mainFrame = {}; owner.isDestroyed = () => destroyed;
  owner.getURL = () => 'http://127.0.0.1:5187/';
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const executor = { probe: async () => ({ available: true, inputSides: [512, 768, 1024, 1280, 1536] }),
    start(input, progress) {
      const completion = deferred();
      const task = { input, progress, completion, cancel: async () => { task.cancelled = true; } };
      tasks.push(task);
      return { result: completion.promise, cancel: () => task.cancel() };
    } };
  const adapter = installNativePreparation({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    origin: 'http://127.0.0.1:5187', executor });
  const invoke = (name, ...args) => handlers.get(`loom-preparation-${name}`)(event, ...args);
  return { handlers, owner, event, executor, tasks, adapter, invoke, destroy: () => { destroyed = true; owner.emit('destroyed'); } };
}

test('probe is explicit, owner authorized and does not start inference', async () => {
  const h = harness();
  assert.deepEqual(await h.invoke('probe'), { available: true, inputSides: [512, 768, 1024, 1280, 1536] });
  assert.equal(h.tasks.length, 0);
  h.executor.probe = async () => { throw new Error('Runtime probe failed'); };
  await assert.rejects(h.invoke('probe'), /Runtime probe failed/);
});

test('IPC forwards proven 1280 and 1536 sizes with exact bounded RGBA and finite result dimensions', async () => {
  for (const inputSide of [1280, 1536]) {
    const h = harness(), input = request(inputSide, inputSide);
    const id = h.invoke('start', input);
    assert.deepEqual(h.tasks[0].input, input);
    assert.equal(h.tasks[0].input.rgba, input.rgba);
    assert.equal(h.tasks[0].input.rgba.byteLength, inputSide * inputSide * 4);
    const values = new Float32Array(inputSide * inputSide).fill(0.25).buffer;
    h.tasks[0].completion.resolve({ width: inputSide, height: inputSide, semantics: 'relative-log', values });
    await tick();
    const state = h.invoke('status', id);
    assert.equal(state.kind, 'complete');
    assert.equal(state.result.width, inputSide);
    assert.equal(state.result.height, inputSide);
    assert.equal(state.result.values.byteLength, inputSide * inputSide * 4);
    assert.notEqual(state.result.values, values);
    assert.equal(new Float32Array(state.result.values).at(-1), 0.25);
    await h.invoke('close', id);
    assert.deepEqual(h.adapter.diagnostics(), []);
  }
});

test('IPC refuses unproved 2048 and mismatched higher-size pixels without claiming the slot', async () => {
  const h = harness(), largest = request(1536, 1536), medium = request(1280, 1280);
  for (const input of [
    request(2048, 2048),
    { ...largest, rgba: new ArrayBuffer(largest.rgba.byteLength - 4) },
    { ...largest, rgba: new ArrayBuffer(largest.rgba.byteLength + 4) },
    { ...medium, rgba: new ArrayBuffer(medium.rgba.byteLength - 4) },
    { ...largest, width: 1552 },
    { ...medium, height: 1296 },
  ]) assert.throws(() => h.invoke('start', input), /Invalid native preparation request/);
  assert.equal(h.tasks.length, 0);
  assert.deepEqual(h.adapter.diagnostics(), []);
  const valid = h.invoke('start', request());
  await h.invoke('close', valid);
});

test('rectangular input, progress and finite raw output survive a complete job', async () => {
  const h = harness(), input = request();
  const id = h.invoke('start', input);
  assert.equal(h.tasks[0].input.rgba, input.rgba);
  h.tasks[0].progress({ phase: 'transformer', message: 'Transformer block 1' });
  assert.equal(h.invoke('status', id).progress.message, 'Transformer block 1');
  const output = result(); h.tasks[0].completion.resolve(output); await tick();
  const state = h.invoke('status', id);
  assert.equal(state.kind, 'complete');
  assert.equal(state.result.semantics, 'relative-log');
  assert.deepEqual(new Float32Array(state.result.values), new Float32Array(output.values));
  assert.notEqual(state.result.values, output.values);
  await h.invoke('close', id);
  assert.deepEqual(h.adapter.diagnostics(), []);
  assert.equal(h.owner.listenerCount('did-navigate'), 0);
});

test('all IPC refuses other origins, subframes, dead renderers and foreign job owners', async () => {
  const h = harness(), id = h.invoke('start', request());
  const other = harness();
  for (const name of ['probe', 'start', 'status', 'cancel', 'close']) {
    const handler = h.handlers.get(`loom-preparation-${name}`);
    for (const event of [
      { ...h.event, senderFrame: {} },
      { ...h.event, sender: { mainFrame: h.owner.mainFrame, isDestroyed: () => true } },
      { ...h.event, sender: { mainFrame: h.owner.mainFrame, isDestroyed: () => false, getURL: () => 'http://127.0.0.1:5187/other' } },
    ]) assert.throws(() => handler(event, name === 'start' ? request() : id), /main frame/);
  }
  for (const name of ['status', 'cancel', 'close'])
    assert.throws(() => h.handlers.get(`loom-preparation-${name}`)(other.event, id), /not owned/);
  await h.invoke('close', id);
});

test('malformed recipes and unbounded or incorrectly sized image payloads never start', () => {
  const h = harness();
  for (const change of [
    { modelId: 'shell' }, { inputSide: 518 }, { seed: -1 }, { seed: 0x100000000 }, { seed: 1.5 },
    { width: 513 }, { height: 0 }, { width: 1040 }, { width: 256 },
    { rgba: new ArrayBuffer(8) }, { rgba: new Uint8Array(512 * 256 * 4) }, { executable: '/arbitrary/path' },
  ]) assert.throws(() => h.invoke('start', { ...request(), ...change }), /Invalid native preparation request/);
  assert.equal(h.tasks.length, 0);
  assert.deepEqual(h.adapter.diagnostics(), []);
});

test('cancellation retains the sole slot until process retirement and ignores late output', async () => {
  const h = harness(), id = h.invoke('start', request()), retirement = deferred();
  h.tasks[0].cancel = () => retirement.promise;
  const cancelling = h.invoke('cancel', id);
  assert.throws(() => h.invoke('start', request()), /cap reached/);
  h.tasks[0].progress({ message: 'Late progress' });
  h.tasks[0].completion.resolve(result()); await tick();
  assert.equal(h.invoke('status', id).kind, 'running');
  assert.match(h.invoke('status', id).progress.message, /Cancelling/);
  retirement.resolve(); await cancelling;
  assert.deepEqual(h.invoke('status', id), { kind: 'cancelled' });
  await h.invoke('close', id);
  const next = h.invoke('start', request()); await h.invoke('close', next);
});

test('close awaits cancellation and rejects unknown or already closed jobs', async () => {
  const h = harness(), id = h.invoke('start', request()), retirement = deferred();
  h.tasks[0].cancel = () => retirement.promise;
  let closed = false;
  const closing = h.invoke('close', id).then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  retirement.resolve(); await closing;
  assert.throws(() => h.invoke('status', id), /not owned/);
  assert.throws(() => h.invoke('close', id), /not owned/);
});

test('owner retirement, navigation, crash and destruction cancel and drain owned jobs', async () => {
  for (const trigger of ['retireOwner', 'did-navigate', 'render-process-gone', 'destroyed']) {
    const h = harness(); h.invoke('start', request());
    const retirement = deferred(); h.tasks[0].cancel = () => retirement.promise;
    const draining = trigger === 'retireOwner' ? h.adapter.retireOwner(h.owner) : (h.owner.emit(trigger), h.adapter.retireOwner(h.owner));
    assert.equal(h.adapter.diagnostics().length, 1);
    h.tasks[0].completion.resolve(result()); retirement.resolve(); await draining;
    assert.equal(h.tasks[0].cancelled, undefined);
    assert.deepEqual(h.adapter.diagnostics(), []);
    assert.equal(h.owner.listenerCount('destroyed'), 0);
  }
});

test('synchronous start errors and rejected inference are visible failures', async () => {
  for (const sync of [false, true]) {
    const h = harness();
    if (sync) h.executor.start = () => { throw new Error('Load failed'); };
    const id = h.invoke('start', request());
    if (!sync) h.tasks[0].completion.reject(new Error('Load failed'));
    await tick();
    assert.match(h.invoke('status', id).reason, /Load failed/);
    assert.equal(h.invoke('status', id).kind, 'failed');
    await h.invoke('close', id);
  }
});

test('invalid or nonfinite results fail without publishing substitute depth', async () => {
  for (const change of [
    { width: 256 }, { height: 512 }, { semantics: 'inverse-relative' }, { values: new ArrayBuffer(4) },
    { values: new Float64Array(512 * 256).buffer },
    { values: new Float32Array(512 * 256).fill(NaN).buffer },
    { values: new Float32Array(512 * 256).fill(Infinity).buffer },
  ]) {
    const h = harness(), id = h.invoke('start', request());
    h.tasks[0].completion.resolve({ ...result(), ...change }); await tick();
    const state = h.invoke('status', id);
    assert.equal(state.kind, 'failed'); assert.equal(state.result, undefined);
    await h.invoke('close', id);
  }
});

test('failed retirement remains diagnosable and cannot free the memory slot', async () => {
  const h = harness(), id = h.invoke('start', request());
  h.tasks[0].cancel = async () => { throw new Error('Process still alive'); };
  await assert.rejects(h.invoke('close', id), /Process still alive/);
  assert.match(h.adapter.diagnostics()[0].error, /Process still alive/);
  assert.throws(() => h.invoke('start', request()), /cap reached/);
});

test('main shutdown disposes retained preparation and awaits owned process retirement', async () => {
  const h = harness(); const id = h.handlers.get('loom-preparation-start')(h.event, request());
  const retired = deferred(); h.tasks[0].cancel = () => retired.promise;
  let done = false; const disposing = h.adapter.dispose().then(() => { done = true; });
  await tick(); assert.equal(done, false); assert.equal(h.adapter.diagnostics().length, 1);
  retired.resolve(); await disposing;
  assert.deepEqual(h.adapter.diagnostics(), []);
  assert.throws(() => h.handlers.get('loom-preparation-status')(h.event, id), /not owned/);
});
