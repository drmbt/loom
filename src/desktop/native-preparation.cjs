/* global require, module, console */
/* eslint-disable @typescript-eslint/no-require-imports */
const { randomUUID } = require('node:crypto');

/** One static preparation job; the injected executor owns processes and files. */
function installNativePreparation({ ipcMain, origin, executor }) {
  const records = new Map();
  const authorize = event => {
    if (!event.sender || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame ||
      event.sender.getURL() !== `${origin}/`) throw new Error('Native preparation requires the app main frame');
  };
  const owned = (event, id) => {
    authorize(event);
    const record = records.get(id);
    if (!record || record.owner !== event.sender || record.frame !== event.senderFrame)
      throw new Error('Native preparation job is not owned by this renderer');
    return record;
  };
  const requestFor = request => {
    const keys = ['modelId', 'inputSide', 'seed', 'width', 'height', 'rgba'];
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).length !== keys.length || keys.some(key => !Object.hasOwn(request, key)) ||
      request.modelId !== 'marigold-v2-q4' || ![512, 768, 1024, 1280, 1536].includes(request.inputSide) ||
      !Number.isInteger(request.seed) || request.seed < 0 || request.seed > 0xffffffff ||
      ![request.width, request.height].every(size => Number.isInteger(size) && size >= 16 && size <= 1536 && size % 16 === 0) ||
      Math.max(request.width, request.height) !== request.inputSide ||
      !(request.rgba instanceof ArrayBuffer) || request.rgba.byteLength !== request.width * request.height * 4)
      throw new Error('Invalid native preparation request');
    return { modelId: request.modelId, inputSide: request.inputSide, seed: request.seed,
      width: request.width, height: request.height, rgba: request.rgba };
  };
  const resultFor = (result, request) => {
    if (!result || result.width !== request.width || result.height !== request.height ||
      result.semantics !== 'relative-log' || !(result.values instanceof ArrayBuffer) ||
      result.values.byteLength !== request.width * request.height * 4)
      throw new Error('Invalid native preparation result dimensions, semantics or float32 payload');
    const values = result.values.slice(0);
    for (const value of new Float32Array(values)) {
      if (!Number.isFinite(value)) throw new Error('Native preparation result contains nonfinite float32 samples');
    }
    return { values, width: result.width, height: result.height, semantics: result.semantics };
  };
  const failed = (record, error) => {
    record.state = { kind: 'failed', reason: String(error) };
    record.error = String(error);
  };
  function cancel(record) {
    if (record.cancellation) return record.cancellation;
    record.cancelRequested = true;
    record.state = { kind: 'running', progress: { message: 'Cancelling native preparation…' } };
    record.cancellation = (async () => {
      try {
        await record.operation?.cancel();
        record.state = { kind: 'cancelled' };
      } catch (error) { failed(record, error); throw error; }
    })();
    return record.cancellation;
  }
  function close(record) {
    if (record.closing) return record.closing;
    record.closing = (async () => {
      await cancel(record);
      for (const [name, listener] of Object.entries(record.listeners)) record.owner.removeListener(name, listener);
      records.delete(record.id);
    })();
    return record.closing;
  }
  ipcMain.handle('loom-preparation-probe', event => { authorize(event); return executor.probe(); });
  ipcMain.handle('loom-preparation-start', (event, request) => {
    authorize(event);
    const validated = requestFor(request);
    if (records.size !== 0) throw new Error('Native preparation job cap reached; close the previous job first');
    const record = { id: randomUUID(), owner: event.sender, frame: event.senderFrame,
      state: { kind: 'running', progress: { message: 'Preparing native model…' } }, error: null,
      operation: null, cancelRequested: false, cancellation: null, closing: null, listeners: {} };
    records.set(record.id, record);
    const retire = () => {
      void close(record).catch(error => console.error('LOOM_NATIVE_PREPARATION_RETIRE_FAILED', String(error)));
    };
    record.listeners = { destroyed: retire, 'render-process-gone': retire, 'did-navigate': retire };
    for (const [name, listener] of Object.entries(record.listeners)) record.owner.on(name, listener);
    try {
      record.operation = executor.start(validated, progress => {
        if (!record.cancelRequested && record.state.kind === 'running') record.state = { kind: 'running', progress };
      });
      if (!record.operation || typeof record.operation.cancel !== 'function' ||
        !record.operation.result || typeof record.operation.result.then !== 'function')
        throw new Error('Native preparation executor returned an invalid owned job');
      Promise.resolve(record.operation.result).then(result => {
        if (!record.cancelRequested) record.state = { kind: 'complete', result: resultFor(result, validated) };
      }).catch(error => { if (!record.cancelRequested) failed(record, error); });
    } catch (error) { failed(record, error); }
    return record.id;
  });
  ipcMain.handle('loom-preparation-status', (event, id) => owned(event, id).state);
  ipcMain.handle('loom-preparation-cancel', (event, id) => cancel(owned(event, id)));
  ipcMain.handle('loom-preparation-close', (event, id) => close(owned(event, id)));
  return {
    dispose: () => Promise.all([...records.values()].map(close)).then(() => undefined),
    retireOwner: owner => Promise.all([...records.values()].filter(record => record.owner === owner).map(close)).then(() => undefined),
    diagnostics: () => [...records.values()].map(record => ({ id: record.id, kind: record.state.kind,
      cancelRequested: record.cancelRequested, closing: !!record.closing, error: record.error })),
  };
}
module.exports = { installNativePreparation };
