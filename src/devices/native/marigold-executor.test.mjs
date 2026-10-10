import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { createMarigoldExecutor } from './marigold-executor.mjs';

const { Response, AbortSignal, ReadableStream } = globalThis;

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));
const request = (inputSide = 512, height = 16) => ({ modelId: 'marigold-v2-q4', inputSide, seed: 17, width: inputSide, height,
  rgba: new Uint8Array(inputSide * height * 4).fill(255).buffer });

async function fixture(t, files = [{ path: 'transformer/weights.safetensors', data: Buffer.from('tiny pinned weights') }]) {
  const root = await mkdtemp(join(tmpdir(), 'loom-marigold-executor-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'worker');
  const assetsDirectory = join(root, 'assets');
  const temporaryDirectory = join(root, 'jobs');
  await mkdir(temporaryDirectory);
  await writeFile(executable, '#!/bin/sh\nexit 0\n');
  await chmod(executable, 0o700);
  const manifest = { version: 1, bundleId: 'marigold-v2-log-stage2-mlx-q4-v1',
    totalBytes: files.reduce((sum, file) => sum + file.data.length, 0), files: files.map(file => ({ path: file.path,
      url: `https://models.example/pinned/${file.path}`, bytes: file.data.length, sha256: digest(file.data),
      ...(file.range ? { range: file.range, tensor: file.tensor } : {}) })) };
  const fetches = [];
  const defaultFetch = async (url, options) => {
    fetches.push({ url, options });
    const file = files.find(file => url.endsWith(file.path));
    assert.ok(file, 'downloads only pinned manifest URLs');
    return new Response(file.data, { status: 200, headers: { 'content-length': String(file.data.length) } });
  };
  return { root, executable, assetsDirectory, temporaryDirectory, manifest, files, fetches,
    executor: options => createMarigoldExecutor({ executable, assetsDirectory, temporaryDirectory, manifest,
      platform: 'darwin', arch: 'arm64', memoryBytes: 36 * 1024 ** 3, fetch: defaultFetch, ...options }) };
}

function worker(options = {}) {
  const calls = [];
  const spawn = (executable, args, spawnOptions) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = signal => { child.signals.push(signal); if (options.closeOnKill !== false) setImmediate(() => child.emit('close', null, signal)); return true; };
    child.signals = [];
    const record = { executable, args, spawnOptions, child, resultWritten: false };
    calls.push(record);
    setImmediate(async () => {
      try {
        if (options.run) { await options.run(record); return; }
        const output = args[args.indexOf('--output') + 1];
        const config = JSON.parse(await readFile(args[args.indexOf('--request') + 1], 'utf8'));
        const values = new Float32Array(config.width * config.height).fill(0.375);
        if (options.nonfinite) values[7] = NaN;
        await writeFile(output, new Uint8Array(values.buffer));
        child.stdout.write(`${JSON.stringify({ kind: 'progress', phase: 'processing', message: 'Predicting depth…' })}\n`);
        child.stdout.write(`${JSON.stringify({ kind: 'result', width: config.width, height: config.height,
          semantics: 'relative-log', measurement: { backend: 'mlx', millis: 42, peakBytes: 4096 },
          outputPath: '/untrusted/result/path' })}\n`);
        record.resultWritten = true;
        if (!options.holdClose) child.emit('close', 0, null);
      } catch (error) { child.emit('error', error); child.emit('close', 1, null); }
    });
    return child;
  };
  return { calls, spawn };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 1000; attempt++) { if (await predicate()) return; await delay(5); }
  throw new Error('Worker fixture did not reach the expected state');
}

test('probe is cheap, requires an installed Apple Silicon worker, and acquires no models', async t => {
  const f = await fixture(t);
  const native = worker();
  const executor = f.executor({ spawn: native.spawn });
  assert.deepEqual(await executor.probe(), { available: true, cached: false, bundleId: f.manifest.bundleId,
    bytes: f.manifest.totalBytes, inputSides: [512, 768, 1024, 1280, 1536], backend: 'mlx' });
  assert.match((await f.executor({ platform: 'linux' }).probe()).reason, /macOS/);
  assert.match((await f.executor({ memoryBytes: 32 * 1024 ** 3 }).probe()).reason, /36 GiB/);
  await rm(f.executable);
  assert.match((await executor.probe()).reason, /Install/);
  assert.equal(f.fetches.length, 0);
  assert.equal(native.calls.length, 0);
});

for (const inputSide of [1280, 1536]) test('accepts proven ' + inputSide + '-square requests with exact bounded RGBA and float32 dimensions', async t => {
  const f = await fixture(t);
  const native = worker({ holdClose: true });
  const executor = f.executor({ spawn: native.spawn });
  const input = request(inputSide, inputSide);
  const job = executor.start(input);
  await waitFor(() => native.calls[0]?.resultWritten);
  const call = native.calls[0];
  const config = JSON.parse(await readFile(call.args[3], 'utf8'));
  assert.deepEqual(config, { version: 1, width: inputSide, height: inputSide, inputSide, seed: 17 });
  const rgba = await readFile(call.args[5]);
  assert.equal(rgba.length, inputSide * inputSide * 4);
  assert.ok(rgba.equals(Buffer.from(input.rgba)));
  call.child.emit('close', 0, null);
  const result = await job.result;
  assert.equal(result.width, inputSide);
  assert.equal(result.height, inputSide);
  assert.equal(result.values.byteLength, inputSide * inputSide * 4);
  const values = new Float32Array(result.values);
  assert.equal(values[0], 0.375);
  assert.equal(values.at(-1), 0.375);
  assert.deepEqual(await readdir(f.temporaryDirectory), []);
});

test('refuses unproved 2048 and mismatched higher-resolution payloads before acquisition or worker launch', async t => {
  const f = await fixture(t), native = worker(), executor = f.executor({ spawn: native.spawn });
  const largest = request(1536, 1536);
  const medium = request(1280, 1280);
  for (const input of [
    request(2048, 2048),
    { ...largest, rgba: new ArrayBuffer(largest.rgba.byteLength - 4) },
    { ...largest, rgba: new ArrayBuffer(largest.rgba.byteLength + 4) },
    { ...medium, rgba: new ArrayBuffer(medium.rgba.byteLength - 4) },
    { ...largest, width: 1552 },
    { ...medium, height: 1296 },
  ]) assert.throws(() => executor.start(input), /Invalid native Marigold preparation request/);
  assert.equal(f.fetches.length, 0);
  assert.equal(native.calls.length, 0);
  assert.deepEqual(await readdir(f.temporaryDirectory), []);
  await executor.start(request()).result;
  assert.equal(native.calls.length, 1, 'refused requests never occupy the native job slot');
});

test('acquisition verifies every pinned file, preserves exact RGBA, reuses a durable marker, and awaits worker retirement', async t => {
  const f = await fixture(t, [{ path: 'transformer/model.bin', data: Buffer.from('model') },
    { path: 'vae/model.bin', data: Buffer.from('vae') }]);
  const native = worker({ holdClose: true });
  const progress = [];
  const executor = f.executor({ spawn: native.spawn });
  const input = request();
  const job = executor.start(input, value => progress.push(value));
  assert.throws(() => executor.start(request()), /already running/);
  input.rgba = new ArrayBuffer(0);
  await waitFor(() => native.calls[0]?.resultWritten);
  let settled = false;
  void job.result.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false, 'a result message cannot release the still-live model process');
  const call = native.calls[0];
  assert.equal(call.executable, f.executable);
  assert.deepEqual(call.spawnOptions, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.deepEqual(call.args.filter((_, index) => index % 2 === 0), ['--assets', '--request', '--input', '--output']);
  assert.equal(call.args[1], f.assetsDirectory);
  const inputPath = call.args[5];
  const rgba = await readFile(inputPath);
  assert.equal(rgba.length, 512 * 16 * 4);
  assert.ok(rgba.every(value => value === 255));
  const config = JSON.parse(await readFile(call.args[3], 'utf8'));
  assert.deepEqual(config, { version: 1, width: 512, height: 16, inputSide: 512, seed: 17 });
  call.child.emit('close', 0, null);
  const result = await job.result;
  assert.deepEqual(Object.keys(result), ['values', 'width', 'height', 'semantics', 'measurement']);
  assert.equal(new Float32Array(result.values)[7], 0.375);
  assert.deepEqual(await readdir(f.temporaryDirectory), []);
  assert.equal((await executor.probe()).cached, true);
  assert.equal(progress.filter(value => value.phase === 'downloading').at(-1).fraction, 1);
  assert.ok(progress.every(value => !value.message.includes(f.root)));
  assert.equal(f.fetches.length, 2);
  await job.cancel();
  assert.deepEqual(call.child.signals, [], 'closing a completed job does not signal a retired process');
  const nextNative = worker();
  await f.executor({ spawn: nextNative.spawn }).start(request()).result;
  assert.equal(f.fetches.length, 2, 'the marker and file stats reuse the verified bundle without acquisition');
});

test('a cached artifact with changed bytes is explicitly rejected without download or overwrite', async t => {
  const f = await fixture(t);
  const native = worker();
  const executor = f.executor({ spawn: native.spawn });
  await executor.start(request()).result;
  const path = join(f.assetsDirectory, f.files[0].path);
  const corrupt = Buffer.alloc(f.files[0].data.length, 1);
  await writeFile(path, corrupt);
  assert.equal((await executor.probe()).cached, false);
  const job = executor.start(request());
  await assert.rejects(job.result, /Cached Marigold artifact is corrupt/);
  await job.cancel();
  assert.deepEqual(await readFile(path), corrupt);
  assert.equal(f.fetches.length, 1);
  assert.equal(native.calls.length, 1);
});

test('an interrupted direct download resumes only with the exact HTTP 206 range', async t => {
  const f = await fixture(t);
  const file = f.files[0];
  const path = join(f.assetsDirectory, file.path);
  await mkdir(join(f.assetsDirectory, 'transformer'), { recursive: true });
  await writeFile(`${path}.incomplete`, file.data.subarray(0, 5));
  const native = worker();
  const fetch = async (url, options) => {
    assert.equal(url, f.manifest.files[0].url);
    assert.equal(options.headers["Accept-Encoding"], "identity");
    assert.equal(options.headers.Range, `bytes=5-${file.data.length - 1}`);
    return new Response(file.data.subarray(5), { status: 206, headers: {
      'content-range': `bytes 5-${file.data.length - 1}/${file.data.length}`,
      'content-length': String(file.data.length - 5) } });
  };
  await f.executor({ spawn: native.spawn, fetch }).start(request()).result;
  assert.deepEqual(await readFile(path), file.data);
  await assert.rejects(lstat(`${path}.incomplete`), { code: 'ENOENT' });
});

test('range mismatch does not restart from byte zero or alter an incomplete artifact', async t => {
  const f = await fixture(t);
  const path = join(f.assetsDirectory, f.files[0].path);
  await mkdir(join(f.assetsDirectory, 'transformer'), { recursive: true });
  const partial = f.files[0].data.subarray(0, 5);
  await writeFile(`${path}.incomplete`, partial);
  let fetchCount = 0;
  const job = f.executor({ fetch: async () => { fetchCount++; return new Response(f.files[0].data); } }).start(request());
  await assert.rejects(job.result, /exact byte range/);
  assert.equal(fetchCount, 1);
  assert.deepEqual(await readFile(`${path}.incomplete`), partial);
});

function biasFile() {
  const raw = Buffer.alloc(12288, 0x42);
  const json = Buffer.from('{"norm_out.linear.bias":{"dtype":"BF16","shape":[6144],"data_offsets":[0,12288]}}');
  const header = Buffer.alloc(96, 0x20);
  header.writeBigUInt64LE(88n);
  json.copy(header, 8);
  return { path: 'auxiliary/norm_out_bias.safetensors', data: Buffer.concat([header, raw]), raw,
    range: { start: 4776, end: 17063 }, tensor: { name: 'norm_out.linear.bias', dtype: 'BF16', shape: [6144], sha256: digest(raw) } };
}

test('bias sidecar uses exactly the pinned range and validates both tensor and safetensors bytes', async t => {
  const file = biasFile();
  const f = await fixture(t, [file]);
  const native = worker();
  let count = 0;
  const fetch = async (url, options) => {
    count++;
    assert.equal(options.headers['Accept-Encoding'], 'identity');
    assert.equal(options.headers.Range, 'bytes=4776-17063');
    return new Response(file.raw, { status: 206, headers: { 'content-range': 'bytes 4776-17063/999999' } });
  };
  await f.executor({ fetch, spawn: native.spawn }).start(request()).result;
  const bytes = await readFile(join(f.assetsDirectory, file.path));
  assert.deepEqual(bytes, file.data);
  assert.equal(bytes.readBigUInt64LE(), 88n);
  assert.equal(count, 1);
});

test('bias tensor corruption cannot publish a sidecar or start a process', async t => {
  const file = biasFile();
  const f = await fixture(t, [file]);
  const native = worker();
  const job = f.executor({ fetch: async () => new Response(Buffer.alloc(12288), {
    status: 206, headers: { 'content-range': 'bytes 4776-17063/999999' } }), spawn: native.spawn }).start(request());
  await assert.rejects(job.result, /bias tensor verification failed/);
  await assert.rejects(lstat(join(f.assetsDirectory, file.path)), { code: 'ENOENT' });
  assert.equal(native.calls.length, 0);
});

test('nonfinite result samples and failed workers report errors and remove owned job files', async t => {
  const f = await fixture(t);
  const invalid = worker({ nonfinite: true });
  await assert.rejects(f.executor({ spawn: invalid.spawn }).start(request()).result, /nonfinite/);
  const failed = worker({ run: ({ child }) => { child.stderr.write('discarded-prefix' + 'x'.repeat(10000) + 'useful-tail'); child.emit('close', 7, null); } });
  const job = f.executor({ spawn: failed.spawn }).start(request());
  await assert.rejects(job.result, error => error.message.includes('failed (7)') && error.message.includes('useful-tail') &&
    error.message.length < 4300 && !error.message.includes('discarded-prefix'));
  await job.cancel();
  assert.deepEqual(await readdir(f.temporaryDirectory), []);
});

test('invalid or oversized stdout terminates the owned worker and never trusts stdout arrays', async t => {
  const f = await fixture(t);
  for (const content of ['{"kind":"result","values":[1,2,3]}\ninvalid\n', 'x'.repeat(64 * 1024 + 1)]) {
    const native = worker({ run: ({ child }) => child.stdout.write(content) });
    await assert.rejects(f.executor({ spawn: native.spawn }).start(request()).result, /protocol|64 KiB/);
    assert.deepEqual(native.calls[0].child.signals, ['SIGTERM']);
    assert.deepEqual(await readdir(f.temporaryDirectory), []);
  }
});

test('result metadata and output file must both match the requested dimensions', async t => {
  const f = await fixture(t);
  for (const failure of ['dimensions', 'length']) {
    const native = worker({ run: async ({ child, args }) => {
      await writeFile(args[args.indexOf('--output') + 1], Buffer.alloc(failure === 'length' ? 4 : 512 * 16 * 4));
      child.stdout.write(`${JSON.stringify({ kind: 'result', width: failure === 'dimensions' ? 16 : 512,
        height: 16, semantics: 'relative-log' })}\n`);
      child.emit('close', 0, null);
    } });
    await assert.rejects(f.executor({ spawn: native.spawn }).start(request()).result, /dimensions|file length/);
    assert.deepEqual(await readdir(f.temporaryDirectory), []);
  }
});

test('the real child process protocol writes and retires only its main-owned files', async t => {
  const f = await fixture(t);
  await writeFile(f.executable, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(args[args.indexOf('--request') + 1], 'utf8'));
const values = new Float32Array(config.width * config.height).fill(0.75);
fs.writeFileSync(args[args.indexOf('--output') + 1], Buffer.from(values.buffer));
process.stdout.write(JSON.stringify({kind:'progress',phase:'processing',message:'Fixture computation'})+'\\n');
process.stdout.write(JSON.stringify({kind:'result',width:config.width,height:config.height,semantics:'relative-log'})+'\\n');
`);
  await chmod(f.executable, 0o700);
  const result = await f.executor().start(request()).result;
  assert.equal(new Float32Array(result.values)[8191], 0.75);
  assert.deepEqual(await readdir(f.temporaryDirectory), []);
});

test('cancel waits for actual child close and owned temporary cleanup, then is idempotent', async t => {
  const f = await fixture(t);
  const native = worker({ holdClose: true, closeOnKill: false });
  const executor = f.executor({ spawn: native.spawn });
  const job = executor.start(request());
  await waitFor(() => native.calls[0]?.resultWritten);
  const pending = job.cancel();
  let retired = false;
  void pending.then(() => { retired = true; });
  await tick();
  assert.equal(retired, false);
  assert.deepEqual(native.calls[0].child.signals, ['SIGTERM']);
  assert.equal((await readdir(f.temporaryDirectory)).length, 1);
  native.calls[0].child.emit('close', null, 'SIGTERM');
  await pending;
  await assert.rejects(job.result, /cancelled/);
  assert.deepEqual(await readdir(f.temporaryDirectory), []);
  assert.equal(job.cancel(), pending);
});

test('cancel aborts streamed model acquisition and leaves only resumable incomplete bytes', async t => {
  const f = await fixture(t);
  let body;
  let readCancelled = false;
  const fetch = async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(new ReadableStream({ start(controller) { body = controller; }, cancel() { readCancelled = true; } }));
  };
  const native = worker();
  const executor = f.executor({ fetch, spawn: native.spawn });
  const job = executor.start(request());
  await waitFor(() => !!body);
  body.enqueue(f.files[0].data.subarray(0, 5));
  const partial = join(f.assetsDirectory, `${f.files[0].path}.incomplete`);
  await waitFor(async () => (await lstat(partial).catch(() => null))?.size === 5);
  await job.cancel();
  await assert.rejects(job.result, /cancelled/);
  assert.equal(readCancelled, true);
  assert.equal(native.calls.length, 0);
  assert.equal((await executor.probe()).cached, false);
});

test('trusted manifest paths reject traversal and symlink artifact directories', async t => {
  const f = await fixture(t);
  const manifest = { ...f.manifest, files: [{ ...f.manifest.files[0], path: '../outside' }] };
  assert.throws(() => f.executor({ manifest }), /manifest/);
  await mkdir(f.assetsDirectory);
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(f.assetsDirectory, 'transformer'));
  await assert.rejects(f.executor().start(request()).result, /owned regular directory/);
  assert.deepEqual(await readdir(outside), []);
  assert.throws(() => f.executor().start({ ...request(), width: 1024 }), /Invalid native/);
});
