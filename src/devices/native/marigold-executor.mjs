import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { spawn as spawnProcess } from 'node:child_process';
import { createReadStream, constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readFile, rename, rm, statfs, link, unlink } from 'node:fs/promises';
import { tmpdir, totalmem } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { URL } from 'node:url';

const { AbortController } = globalThis;

const RESERVE_BYTES = 15n * 1024n ** 3n;
const MARKER = '.loom-marigold-verified.json';
const CHUNK_BYTES = 1024 * 1024;
const STDOUT_LINE_BYTES = 64 * 1024;
const NATIVE_INPUT_SIDES = [512, 768, 1024, 1280, 1536];
const MAX_NATIVE_INPUT_SIDE = 1536;

function cancelled(signal) { signal.throwIfAborted(); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function validDigest(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }

function validateManifest(value) {
  if (!value || value.version !== 1 || typeof value.bundleId !== 'string' || !value.bundleId ||
    !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 1 || !Array.isArray(value.files) || !value.files.length)
    throw new Error('Invalid trusted Marigold bundle manifest');
  const paths = new Set();
  for (const file of value.files) {
    if (!file || typeof file.path !== 'string' || !file.path || isAbsolute(file.path) ||
      file.path.includes('\\') || file.path.split('/').some(part => !part || part === '.' || part === '..') ||
      file.path === MARKER || file.path.endsWith('.incomplete') || paths.has(file.path) ||
      typeof file.url !== 'string' || new URL(file.url).protocol !== 'https:' ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 1 || !validDigest(file.sha256))
      throw new Error('Invalid trusted Marigold artifact manifest');
    paths.add(file.path);
    if (file.range || file.tensor) {
      if (!file.range || !file.tensor || !Number.isSafeInteger(file.range.start) || file.range.start < 0 ||
        !Number.isSafeInteger(file.range.end) || file.range.end < file.range.start ||
        file.tensor.name !== 'norm_out.linear.bias' || file.tensor.dtype !== 'BF16' ||
        JSON.stringify(file.tensor.shape) !== '[6144]' || !validDigest(file.tensor.sha256) ||
        file.range.end - file.range.start + 1 !== 12288)
        throw new Error('Invalid trusted Marigold bias range manifest');
    }
  }
  if (value.files.reduce((total, file) => total + file.bytes, 0) !== value.totalBytes)
    throw new Error('Marigold manifest total byte count does not match its artifacts');
  // The caller owns the trusted manifest. Snapshot it so running jobs cannot mutate it.
  return JSON.parse(JSON.stringify(value));
}

async function fileInfo(path) {
  try {
    const value = await lstat(path);
    if (!value.isFile()) throw new Error('Marigold artifact is not a regular file');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function digestFile(path, signal, hash = createHash('sha256')) {
  for await (const chunk of createReadStream(path, { highWaterMark: CHUNK_BYTES, signal })) {
    cancelled(signal);
    hash.update(chunk);
  }
  return hash;
}

function progressForFile(manifest, completed, received, onProgress) {
  onProgress({ phase: 'downloading', fraction: Math.min(1, (completed + received) / manifest.totalBytes),
    message: 'Downloading and verifying the local Marigold model…' });
}

async function readResponse(response, signal, consume) {
  if (!response.body || typeof response.body.getReader !== 'function') throw new Error('Marigold download has no readable body');
  const reader = response.body.getReader();
  let abortRead;
  const abort = () => { abortRead = reader.cancel(signal.reason); void abortRead.catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    cancelled(signal);
    while (true) {
      const { done, value } = await reader.read();
      cancelled(signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('Marigold download returned invalid bytes');
      for (let offset = 0; offset < value.byteLength; offset += CHUNK_BYTES) {
        cancelled(signal);
        await consume(value.subarray(offset, offset + CHUNK_BYTES));
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    try { if (abortRead) await abortRead; else await reader.cancel(); }
    finally { reader.releaseLock(); }
  }
}

function requireRange(response, start, end, total) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
  if (response.status !== 206 || !match || Number(match[1]) !== start || Number(match[2]) !== end ||
    Number(match[3]) <= end || (total !== undefined && Number(match[3]) !== total))
    throw new Error('Marigold download server did not honor the exact byte range');
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten < 1) throw new Error('Marigold artifact write made no progress');
    offset += bytesWritten;
  }
}

async function publishArtifact(partialPath, path) {
  // Never overwrite a cached artifact, including one created during a download.
  await link(partialPath, path);
  await unlink(partialPath);
}

async function downloadFile({ file, path, manifest, completed, fetchFn, signal, onProgress }) {
  const partialPath = `${path}.incomplete`;
  const partial = await fileInfo(partialPath);
  let received = partial?.size ?? 0;
  if (received > file.bytes) throw new Error(`Incomplete Marigold artifact has an invalid length: ${file.path}`);
  const hash = createHash('sha256');
  if (partial) await digestFile(partialPath, signal, hash);
  progressForFile(manifest, completed, received, onProgress);
  if (received < file.bytes) {
    const response = await fetchFn(file.url, { signal, headers: { 'Accept-Encoding': 'identity', ...(received ? { Range: `bytes=${received}-${file.bytes - 1}` } : {}) } });
    try {
      cancelled(signal);
      if (received) requireRange(response, received, file.bytes - 1, file.bytes);
      else if (response.status !== 200) throw new Error(`Marigold download failed with HTTP ${response.status}`);
      const length = response.headers.get('content-length');
      if (length !== null && Number(length) !== file.bytes - received)
        throw new Error('Marigold download Content-Length does not match the pinned artifact');
    } catch (error) { await response.body?.cancel(); throw error; }
    const handle = await open(partialPath, partial ? 'a' : 'wx', 0o600);
    try {
      await readResponse(response, signal, async chunk => {
        if (received + chunk.byteLength > file.bytes) throw new Error('Marigold download exceeds the pinned artifact length');
        await writeAll(handle, chunk);
        hash.update(chunk);
        received += chunk.byteLength;
        progressForFile(manifest, completed, received, onProgress);
      });
      await handle.sync();
    } finally { await handle.close(); }
  }
  cancelled(signal);
  if (received !== file.bytes || hash.digest('hex') !== file.sha256)
    throw new Error(`Marigold artifact verification failed; remove the incomplete artifact before retrying: ${file.path}`);
  await publishArtifact(partialPath, path);
}

async function downloadBias({ file, path, manifest, completed, fetchFn, signal, onProgress }) {
  if (await fileInfo(`${path}.incomplete`)) throw new Error('Incomplete Marigold bias artifact requires explicit removal before retrying');
  const { start, end } = file.range;
  const response = await fetchFn(file.url, { signal, headers: { 'Accept-Encoding': 'identity', Range: `bytes=${start}-${end}` } });
  try { cancelled(signal); requireRange(response, start, end); }
  catch (error) { await response.body?.cancel(); throw error; }
  const raw = Buffer.alloc(end - start + 1);
  let received = 0;
  await readResponse(response, signal, chunk => {
    if (received + chunk.byteLength > raw.length) throw new Error('Marigold bias range exceeds its pinned length');
    raw.set(chunk, received);
    received += chunk.byteLength;
    progressForFile(manifest, completed, received, onProgress);
  });
  if (received !== raw.length || sha256(raw) !== file.tensor.sha256) throw new Error('Marigold bias tensor verification failed');
  const json = JSON.stringify({ [file.tensor.name]: { dtype: file.tensor.dtype, shape: file.tensor.shape, data_offsets: [0, raw.length] } });
  const headerBytes = Math.ceil(Buffer.byteLength(json) / 8) * 8;
  const header = Buffer.alloc(8 + headerBytes, 0x20);
  header.writeBigUInt64LE(BigInt(headerBytes), 0);
  header.write(json, 8, 'utf8');
  const artifact = Buffer.concat([header, raw]);
  if (artifact.length !== file.bytes || sha256(artifact) !== file.sha256) throw new Error('Marigold bias artifact verification failed');
  cancelled(signal);
  const handle = await open(`${path}.incomplete`, 'wx', 0o600);
  try { await writeAll(handle, artifact); await handle.sync(); } finally { await handle.close(); }
  cancelled(signal);
  await publishArtifact(`${path}.incomplete`, path);
}

async function safeDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Marigold artifact directory is not an owned regular directory');
}

/** A trusted native worker owns one static job. No helper, MCP, renderer or GPU imports. */
export function createMarigoldExecutor({ executable, assetsDirectory, manifest: inputManifest,
  fetch: fetchFn = globalThis.fetch, spawn: spawnFn = spawnProcess, temporaryDirectory = tmpdir(),
  platform = process.platform, arch = process.arch, memoryBytes = totalmem() }) {
  const manifest = validateManifest(inputManifest);
  if (typeof executable !== 'string' || !isAbsolute(executable) || typeof assetsDirectory !== 'string' || !isAbsolute(assetsDirectory) ||
    typeof temporaryDirectory !== 'string' || !isAbsolute(temporaryDirectory))
    throw new Error('Marigold executor requires trusted absolute owner paths');
  assetsDirectory = resolve(assetsDirectory);
  let active = false;

  async function verifiedMarker() {
    let marker;
    try {
      const directoryInfo = await lstat(assetsDirectory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return false;
      const markerInfo = await fileInfo(join(assetsDirectory, MARKER));
      if (!markerInfo || markerInfo.size > 1024 * 1024) return false;
      marker = JSON.parse(await readFile(join(assetsDirectory, MARKER), 'utf8'));
    }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    if (!marker || marker.version !== 1 || marker.bundleId !== manifest.bundleId || !Array.isArray(marker.files) || marker.files.length !== manifest.files.length) return false;
    for (const [index, file] of manifest.files.entries()) {
      const cached = marker.files[index];
      let current = assetsDirectory;
      for (const part of file.path.split('/').slice(0, -1)) {
        current = join(current, part);
        let directory;
        try { directory = await lstat(current); }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
        if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
      }
      const info = await fileInfo(join(assetsDirectory, file.path));
      if (!info || !cached || cached.path !== file.path || cached.sha256 !== file.sha256 || cached.size !== file.bytes ||
        info.size !== cached.size || info.mtimeMs !== cached.mtimeMs) return false;
    }
    return true;
  }

  async function probe() {
    const base = { cached: await verifiedMarker(), bundleId: manifest.bundleId, bytes: manifest.totalBytes,
      inputSides: [...NATIVE_INPUT_SIDES], backend: 'mlx' };
    if (platform !== 'darwin' || arch !== 'arm64') return { ...base, available: false, reason: 'Marigold MLX preparation requires macOS on Apple Silicon.' };
    if (memoryBytes < 36 * 1024 ** 3) return { ...base, available: false, reason: 'Marigold MLX preparation requires at least 36 GiB of unified memory; smaller Macs have not been validated.' };
    try {
      const info = await lstat(executable);
      if (!info.isFile()) return { ...base, available: false, reason: 'Install the trusted Marigold native worker before preparing depth.' };
      await access(executable, constants.X_OK);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EACCES') return { ...base, available: false, reason: 'Install the trusted Marigold native worker before preparing depth.' };
      throw error;
    }
    return { ...base, available: true };
  }

  async function ensureAssets(signal, onProgress) {
    if (await verifiedMarker()) return;
    cancelled(signal);
    await safeDirectory(assetsDirectory);
    let needed = 0;
    for (const file of manifest.files) {
      const info = await fileInfo(join(assetsDirectory, file.path));
      const partial = !info && !file.range ? await fileInfo(join(assetsDirectory, `${file.path}.incomplete`)) : null;
      if (!info) needed += Math.max(0, file.bytes - (partial?.size ?? 0));
    }
    const disk = await statfs(assetsDirectory, { bigint: true });
    if (disk.bavail * disk.bsize < BigInt(needed) + RESERVE_BYTES) throw new Error('Marigold model acquisition needs its remaining download size plus 15 GiB of free disk space.');
    let completed = 0;
    const verified = [];
    for (const file of manifest.files) {
      cancelled(signal);
      const path = join(assetsDirectory, file.path);
      // Reject intermediate symlinks before opening a file or creating its parent.
      let current = assetsDirectory;
      for (const part of file.path.split('/').slice(0, -1)) { current = join(current, part); await safeDirectory(current); }
      const info = await fileInfo(path);
      if (info) {
        if (info.size !== file.bytes || (await digestFile(path, signal)).digest('hex') !== file.sha256)
          throw new Error(`Cached Marigold artifact is corrupt; remove it explicitly before retrying: ${file.path}`);
      } else {
        await (file.range ? downloadBias : downloadFile)({ file, path, manifest, completed, fetchFn, signal, onProgress });
      }
      const finalInfo = await fileInfo(path);
      verified.push({ path: file.path, sha256: file.sha256, size: finalInfo.size, mtimeMs: finalInfo.mtimeMs });
      completed += file.bytes;
      progressForFile(manifest, completed, 0, onProgress);
    }
    cancelled(signal);
    const markerPath = join(assetsDirectory, `${MARKER}.${randomUUID()}`);
    const handle = await open(markerPath, 'wx', 0o600);
    try {
      await writeAll(handle, Buffer.from(JSON.stringify({ version: 1, bundleId: manifest.bundleId, files: verified })));
      await handle.sync();
    } finally { await handle.close(); }
    try { await rename(markerPath, join(assetsDirectory, MARKER)); }
    finally { await rm(markerPath, { force: true }); }
  }

  function start(request, onProgress = () => {}) {
    if (active) throw new Error('Marigold native preparation is already running');
    if (!request || request.modelId !== 'marigold-v2-q4' || !NATIVE_INPUT_SIDES.includes(request.inputSide) ||
      !Number.isInteger(request.seed) || request.seed < 0 || request.seed > 0xffffffff ||
      ![request.width, request.height].every(size => Number.isInteger(size) && size >= 16 && size <= MAX_NATIVE_INPUT_SIDE && size % 16 === 0) ||
      Math.max(request.width, request.height) !== request.inputSide || !(request.rgba instanceof ArrayBuffer) ||
      request.rgba.byteLength !== request.width * request.height * 4)
      throw new Error('Invalid native Marigold preparation request');
    request = { modelId: request.modelId, width: request.width, height: request.height,
      inputSide: request.inputSide, seed: request.seed, rgba: request.rgba.slice(0) };
    active = true;
    const abort = new AbortController();
    let child;
    let childClosed;
    let killTimer;
    let cancellation;
    let cleanupError;
    const terminate = () => {
      if (!child || !childClosed) return;
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => { child.kill('SIGKILL'); }, 5000);
      killTimer.unref();
    };
    abort.signal.addEventListener('abort', terminate, { once: true });
    const result = (async () => {
      let directory;
      try {
        const capability = await probe();
        if (!capability.available) throw new Error(capability.reason);
        cancelled(abort.signal);
        await ensureAssets(abort.signal, onProgress);
        cancelled(abort.signal);
        directory = await mkdtemp(join(temporaryDirectory, 'loom-marigold-'));
        const requestPath = join(directory, 'request.json');
        const inputPath = join(directory, 'input.rgba');
        const outputPath = join(directory, 'result.f32');
        const config = { version: 1, width: request.width, height: request.height, inputSide: request.inputSide, seed: request.seed };
        const requestHandle = await open(requestPath, 'wx', 0o600);
        try { await writeAll(requestHandle, Buffer.from(JSON.stringify(config))); } finally { await requestHandle.close(); }
        const inputHandle = await open(inputPath, 'wx', 0o600);
        try { await writeAll(inputHandle, new Uint8Array(request.rgba)); } finally { await inputHandle.close(); }
        cancelled(abort.signal);
        onProgress({ phase: 'loading', message: 'Loading the local Marigold model…' });
        child = spawnFn(executable, ['--assets', assetsDirectory, '--request', requestPath, '--input', inputPath, '--output', outputPath],
          { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let metadata;
        let protocolError;
        let launchError;
        const failProtocol = error => { protocolError ??= error; terminate(); };
        childClosed = new Promise(resolveClosed => {
          child.once('error', error => { launchError = error; });
          child.once('close', (code, signal) => resolveClosed({ code, signal }));
        });
        child.stdout.on('data', chunk => {
          if (protocolError) return;
          const bytes = Buffer.from(chunk);
          // Process each segment before concatenation, keeping pending line memory bounded.
          let offset = 0;
          while (offset < bytes.length) {
            const newline = bytes.indexOf(10, offset);
            const end = newline < 0 ? bytes.length : newline;
            if (stdout.length + end - offset > STDOUT_LINE_BYTES) { failProtocol(new Error('Marigold worker stdout line exceeded 64 KiB')); return; }
            stdout = Buffer.concat([stdout, bytes.subarray(offset, end)]);
            if (newline < 0) break;
            const line = stdout.toString('utf8');
            stdout = Buffer.alloc(0);
            offset = newline + 1;
            try {
              const message = JSON.parse(line);
              if (message.kind === 'progress' && typeof message.phase === 'string' && message.phase.length <= 40 &&
                typeof message.message === 'string' && message.message.length <= 1024) {
                if (!abort.signal.aborted) onProgress({ phase: message.phase, message: message.message });
              } else if (message.kind === 'result' && !metadata) { metadata = message; }
              else throw new Error('Invalid or duplicate Marigold worker message');
            } catch (error) { failProtocol(new Error(`Invalid Marigold worker protocol: ${error.message}`)); return; }
          }
        });
        child.stderr.on('data', chunk => { const bytes = Buffer.from(chunk); stderr = Buffer.concat([stderr, bytes.subarray(-4096)]).subarray(-4096); });
        const outcome = await childClosed;
        clearTimeout(killTimer);
        childClosed = null;
        cancelled(abort.signal);
        if (launchError) throw new Error(`Could not launch the Marigold native worker: ${launchError.message}`);
        if (protocolError) throw protocolError;
        if (outcome.code !== 0) throw new Error(`Marigold native worker failed (${outcome.signal ?? outcome.code}): ${stderr.toString('utf8')}`);
        if (stdout.length) throw new Error('Marigold worker ended with an unterminated stdout message');
        if (!metadata || metadata.width !== request.width || metadata.height !== request.height || metadata.semantics !== 'relative-log')
          throw new Error('Marigold native worker returned invalid result dimensions or semantics');
        const info = await fileInfo(outputPath);
        if (!info || info.size !== request.width * request.height * 4) throw new Error('Marigold native worker returned an invalid float32 file length');
        const bytes = await readFile(outputPath);
        cancelled(abort.signal);
        const values = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        for (const value of new Float32Array(values)) {
          if (!Number.isFinite(value)) throw new Error('Marigold native worker returned nonfinite float32 samples');
        }
        const prepared = { values, width: request.width, height: request.height, semantics: 'relative-log' };
        if (metadata.measurement !== undefined) {
          const measurement = metadata.measurement;
          if (!measurement || measurement.backend !== 'mlx' || !Number.isFinite(measurement.millis) || measurement.millis < 0 ||
            !Number.isSafeInteger(measurement.peakBytes) || measurement.peakBytes < 0)
            throw new Error('Marigold native worker returned invalid performance measurements');
          prepared.measurement = { backend: 'mlx', millis: measurement.millis, peakBytes: measurement.peakBytes };
        }
        return prepared;
      } finally {
        if (childClosed) { terminate(); await childClosed; }
        clearTimeout(killTimer);
        abort.signal.removeEventListener('abort', terminate);
        try { if (directory) await rm(directory, { recursive: true, force: true }); }
        catch (error) {
          cleanupError = error;
          // eslint-disable-next-line no-unsafe-finally -- A result cannot succeed if owned retirement failed.
          throw error;
        }
        finally { active = false; }
      }
    })();
    // Retain a rejection handler even if the renderer is gone before it observes this job.
    void result.catch(() => {});
    return { result, cancel() {
      cancellation ??= (async () => {
        abort.abort(new Error('Marigold preparation cancelled'));
        // Job failure is reported by result. Cancellation reports retirement failures.
        try { await result; } catch { if (cleanupError) throw cleanupError; }
      })();
      return cancellation;
    } };
  }
  return { probe, start };
}
