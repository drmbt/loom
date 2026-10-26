/* global require, module, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports */
const { join } = require('node:path');
const timers = require('node:timers');
const { webPreferences } = require('./policy.cjs');
const { resolveFfglPlugins, findFfglPlugin } = require('./ffgl-plugins.cjs');

// VN85: the Electron-main half of the native FFGL host. The shape is native-inference.cjs's
// (person-mask's Vision path), because the problem is the same: a graph texture goes out to
// native code and a processed texture comes back.
//
//   page ──ImageBitmap──▶ hidden capture window (inference.html, offscreen, useSharedTexture)
//        paint ──IOSurface──▶ ffgl-host addon: row-flip blit → plugin → output IOSurface
//        importSharedTexture ──sendSharedTexture──▶ page (VideoFrame, bottom row first)
//
// One frame is in flight per session: the capture page's frameReady() settles only when the
// page has released the previous result (all references released → native.release(lease)).
// Time, BPM and parameters for a frame arrive BEFORE its bitmap, through `prepare`; the host
// never reads a clock of its own. Plugin binaries are found only through resolveFfglPlugins.
const SESSION = /^loom-ffgl-[a-f0-9-]{36}$/;
const PLUGIN_NAME = /^[A-Za-z0-9_.+ -]{1,64}$/;

function validFrame(frame) {
  if (!frame || typeof frame !== 'object') throw new Error('An FFGL frame needs time, bpm and barPhase');
  const { time, bpm, barPhase, parameters = [], pulses = [] } = frame;
  if (![time, bpm, barPhase].every(Number.isFinite)) throw new Error('FFGL time, bpm and barPhase must be finite numbers');
  if (!Array.isArray(parameters) || parameters.length > 4096 || !parameters.every(entry => Array.isArray(entry) && entry.length === 2 &&
      Number.isSafeInteger(entry[0]) && entry[0] >= 0 &&
      (Number.isFinite(entry[1]) || typeof entry[1] === 'boolean' || (typeof entry[1] === 'string' && entry[1].length <= 4096))))
    throw new Error('FFGL parameters must be [index, number | boolean | string] pairs');
  if (!Array.isArray(pulses) || pulses.length > 4096 || !pulses.every(index => Number.isSafeInteger(index) && index >= 0))
    throw new Error('FFGL pulses must be parameter indices');
  return { time, bpm, barPhase, parameters, pulses };
}
/** What the page may know about a plugin: its table and identity, never the binary's path. */
function publicDescription(described) {
  const { id, name, pluginType, version, apiVersion, description, about, supportsSetTime, clock, parameters, loadMs } = described;
  return { id, name, pluginType, version, apiVersion, description, about, supportsSetTime, clock, parameters, loadMs };
}

function installNativeFfgl({ ipcMain, BrowserWindow, sharedTexture, native, origin, folders, maxSessions = 8 }) {
  if (typeof folders !== 'function') throw new Error('Native FFGL needs a plugin-folder source');
  if (typeof origin !== 'string' || !/^https?:\/\/[^/]+$/.test(origin)) throw new Error('Native FFGL requires an exact HTTP origin');
  const records = new Map();
  const authorize = event => {
    if (!event.sender || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame || event.sender.getURL() !== `${origin}/`)
      throw new Error('Native FFGL requires the app main frame');
  };
  const owned = (event, name) => {
    authorize(event);
    const record = records.get(name);
    if (!record || record.owner !== event.sender || record.frame !== event.senderFrame)
      throw new Error('Native FFGL session is not owned by this renderer');
    return record;
  };
  const binaryFor = plugin => {
    if (typeof plugin !== 'string' || !PLUGIN_NAME.test(plugin)) throw new Error('Invalid FFGL plugin name');
    const found = findFfglPlugin(resolveFfglPlugins(folders()), plugin);
    if (!found) throw new Error(`FFGL plugin ${plugin} is not in any plugin folder`);
    return found.binary;
  };
  const changed = record => { for (const fn of [...record.waiters]) fn(); };
  const fault = (record, error) => {
    record.error ??= String(error);
    timers.clearTimeout(record.pending?.timer);
    record.pending?.reject(error instanceof Error ? error : new Error(String(error)));
    record.pending = null;
    changed(record);
  };
  const completed = record => {
    if (record.busy || record.lease || record.quarantined) return;
    timers.clearTimeout(record.pending?.timer);
    record.pending?.resolve({ kind: 'completed' }); record.pending = null;
    changed(record);
  };
  function release(record, lease) {
    if (lease.releasing) { fault(record, new Error('Duplicate native FFGL GPU release')); return; }
    lease.releasing = true;
    try {
      native.release(lease.result.leaseId);
      if (record.lease === lease) record.lease = null;
      completed(record);
    } catch (error) { record.quarantined = true; fault(record, error); }
  }
  function close(record) {
    if (record.closing) return record.closing;
    record.closed = true;
    if (record.window && !record.window.isDestroyed()) record.window.webContents.stopPainting();
    if (!record.busy && !record.lease) {
      timers.clearTimeout(record.pending?.timer);
      record.pending?.resolve({ kind: 'closed' }); record.pending = null;
    }
    record.closing = (async () => {
      await record.opening?.catch(() => undefined);
      await new Promise((resolve, reject) => {
        const done = error => { timers.clearTimeout(timer); record.waiters.delete(check); if (error) reject(error); else resolve(); };
        const check = () => {
          if (record.quarantined) done(new Error(record.error ?? 'Native FFGL retains uncertain GPU leases'));
          else if (!record.busy && !record.lease) done();
        };
        const timer = timers.setTimeout(() => done(new Error('Native FFGL GPU drainage timed out')), 15000);
        record.waiters.add(check); check();
      });
      if (record.instance) await native.close(record.instance);
      if (record.window && !record.window.isDestroyed()) record.window.close();
      for (const [event, listener] of Object.entries(record.listeners)) record.owner.removeListener(event, listener);
      records.delete(record.name);
    })();
    return record.closing;
  }
  async function processPaint(record, texture) {
    const contents = record.contents;
    contents.stopPainting(); timers.clearTimeout(record.pending.timer); record.busy = true;
    let lease, inputDone = false;
    try {
      const info = texture.textureInfo;
      if (info.pixelFormat !== 'bgra' || info.codedSize.width !== record.width || info.codedSize.height !== record.height)
        throw new Error('Native FFGL capture format/size changed');
      if (!record.next) throw new Error('Native FFGL frame arrived without prepared time and parameters');
      const request = record.next; record.next = null;
      // The input surface is borrowed for the whole native job, released only once it settles.
      const result = await native.process(record.instance, info.handle.ioSurface, request);
      inputDone = true; texture.release();
      lease = { result, imported: null, entered: false, releasing: false };
      record.lease = lease;
      if (record.closed) { release(record, lease); return; }
      if (result.width !== record.width || result.height !== record.height) throw new Error('Native FFGL result extent changed');
      lease.entered = true;
      lease.imported = sharedTexture.importSharedTexture({ textureInfo: {
        pixelFormat: 'bgra', codedSize: { width: result.width, height: result.height },
        colorSpace: { primaries: 'bt709', transfer: 'srgb', matrix: 'rgb', range: 'full' },
        handle: { ioSurface: result.handle },
      }, allReferencesReleased: () => { release(record, lease); } });
      if (lease.releasing) throw new Error('Native FFGL result released before transfer');
      await sharedTexture.sendSharedTexture({ frame: record.frame, importedSharedTexture: lease.imported },
        { session: record.name, sequence: result.sequence, width: result.width, height: result.height,
          bottomUp: result.bottomUp === true, timing: result.timing });
      record.frames++;
      record.timing = result.timing;
    } catch (error) {
      if (!inputDone) texture.release();
      if (lease && !lease.entered) release(record, lease);
      if (lease?.entered && !lease.imported && !lease.releasing) record.quarantined = true;
      fault(record, error);
    } finally {
      if (lease?.imported) {
        try { lease.imported.release(); }
        catch (error) { record.quarantined = true; fault(record, error); }
      }
      record.busy = false;
      completed(record);
    }
  }

  ipcMain.handle('loom-ffgl-list', event => {
    authorize(event);
    const resolved = resolveFfglPlugins(folders());
    return { plugins: resolved.plugins.map(({ name, folderIndex, shadows }) => ({ name, folderIndex, shadowed: shadows.length })),
      excluded: resolved.excluded.map(({ name, reason }) => ({ name, reason })), missingFolders: resolved.missingFolders.length };
  });
  ipcMain.handle('loom-ffgl-describe', async (event, plugin) => {
    authorize(event);
    return publicDescription(await native.probe(binaryFor(plugin)));
  });
  ipcMain.handle('loom-ffgl-open', async (event, name, plugin, width, height) => {
    authorize(event);
    if (typeof name !== 'string' || !SESSION.test(name)) throw new Error('Invalid native FFGL session name');
    if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 8192)) throw new Error('Invalid native FFGL extent');
    if (records.has(name) || records.size >= maxSessions) throw new Error('Native FFGL session cap reached');
    const binary = binaryFor(plugin);
    const record = { name, owner: event.sender, frame: event.senderFrame, plugin, width, height, instance: null, window: null,
      contents: null, opening: null, closing: null, busy: false, closed: false, quarantined: false, lease: null, pending: null,
      next: null, error: null, waiters: new Set(), frames: 0, timing: null, listeners: {} };
    records.set(name, record);
    const leave = () => { void close(record).catch(error => fault(record, error)); };
    record.listeners = { destroyed: leave, 'render-process-gone': leave, 'did-navigate': leave };
    for (const [eventName, listener] of Object.entries(record.listeners)) record.owner.on(eventName, listener);
    let described;
    record.opening = (async () => {
      described = await native.open(binary, width, height);
      record.instance = described.instance;
      if (record.closed) return;
      const window = new BrowserWindow({ width, height, show: false, useContentSize: true,
        webPreferences: { ...webPreferences, preload: join(__dirname, 'ffgl-capture-preload.cjs'), backgroundThrottling: false,
          offscreen: { useSharedTexture: true, sharedTexturePixelFormat: 'argb', deviceScaleFactor: 1 } } });
      record.window = window;
      const contents = window.webContents;
      record.contents = contents;
      contents.stopPainting();
      window.once('closed', leave);
      contents.on('render-process-gone', leave);
      contents.on('paint', event => {
        const texture = event.texture;
        if (!texture) { if (record.pending) fault(record, new Error('Native FFGL capture returned no GPU texture')); return; }
        if (!record.pending || record.closed || record.busy || record.error) { texture.release(); return; }
        void processPaint(record, texture);
      });
      await window.loadURL(`${origin}/src/desktop/inference.html?name=${name}&width=${width}&height=${height}`);
    })();
    try { await record.opening; return { session: name, plugin: publicDescription(described) }; }
    catch (error) {
      fault(record, error);
      if (record.instance) await native.close(record.instance).catch(() => undefined);
      if (record.window && !record.window.isDestroyed()) record.window.destroy();
      for (const [eventName, listener] of Object.entries(record.listeners)) record.owner.removeListener(eventName, listener);
      records.delete(name); throw error;
    }
  });
  ipcMain.handle('loom-ffgl-prepare', (event, name, frame) => {
    const record = owned(event, name);
    if (record.error) throw new Error(record.error);
    if (record.closed) throw new Error('Native FFGL session is closed');
    if (record.pending || record.busy || record.lease) throw new Error('Native FFGL session is busy');
    record.next = validFrame(frame);
  });
  ipcMain.handle('loom-ffgl-frame', event => {
    const record = [...records.values()].find(entry => entry.contents === event.sender);
    if (!record || record.closed || event.senderFrame !== event.sender.mainFrame) throw new Error('Unknown native FFGL capture frame');
    if (record.error) throw new Error(record.error);
    if (record.pending || record.busy || record.lease) throw new Error('Native FFGL capture is busy');
    return new Promise((resolve, reject) => {
      record.pending = { resolve, reject, timer: timers.setTimeout(() => {
        event.sender.stopPainting();
        fault(record, new Error('Native FFGL GPU capture timed out before submission'));
      }, 15000) };
      // As native-inference: resume the GPU consumer; the capture page already drew the bitmap.
      event.sender.startPainting();
    });
  });
  ipcMain.handle('loom-ffgl-status', (event, name) => {
    const record = owned(event, name);
    return { frames: record.frames, busy: record.busy || Boolean(record.lease), error: record.error, timing: record.timing };
  });
  ipcMain.handle('loom-ffgl-close', (event, name) => {
    authorize(event);
    if (!records.has(name)) return undefined;
    return close(owned(event, name));
  });
  return {
    retireOwner: owner => Promise.all([...records.values()].filter(record => record.owner === owner).map(close)),
    diagnostics: () => [...records.values()].map(record => ({ name: record.name, plugin: record.plugin, busy: record.busy,
      frames: record.frames, resultHeld: Boolean(record.lease), closed: record.closed, error: record.error })),
  };
}
module.exports = { installNativeFfgl, validFrame };
