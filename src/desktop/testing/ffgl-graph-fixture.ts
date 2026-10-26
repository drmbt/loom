import { createGraphStore } from '../../domain/graph/store.ts';
import { createDomainBus } from '../../domain/commands/index.ts';
import { createNodeRegistry } from '../../nodes/registry/registry.ts';
import { allNodeDefinitions } from '../../nodes/definitions/index.ts';
import { mediaSourceIdFor } from '../../nodes/definitions/media.ts';
import { FFGL_INPUT_KEY, FFGL_RESULT_KEY } from '../../nodes/definitions/ffgl.ts';
import { compileGraph } from '../../compiler/index.ts';
import { scratchResourceId } from '../../compiler/resources.ts';
import { createVgpuBackend, browserGpuHost } from '../../runtime/backend/index.ts';
import { createNativeFfglSources } from '../../app/native-ffgl-sources.ts';
import { desktopFfglBridge, manifestFromDescription } from '../../devices/native-ffgl.ts';
import { displacementStackDocument } from '../../examples/documents/displacement-stack.ts';

/**
 * VN85 phase 2 gate, in the real desktop page: graph → compiler → backend → the ffgl node's
 * input copy → OSR capture → the native host (VignettePlus) → the media registry → the
 * output, read back. Test-only source and readback; everything between is the product path.
 *
 * Claims, from VignettePlus's shader (see ffgl-host.test.mjs):
 *   * identity settings: out == in, every byte, measured (any colour-path rounding is
 *     reported, not assumed away: the gate states the bound it found);
 *   * Size 0 / Softness 0: corners exactly 0 and the centre == in;
 *   * the output is upright: the input's bright top-left block is at the output's top left;
 *   * THE ONE-FRAME LAG (VN96), asserted so a fix is a deliberate test change: frame N's first
 *     render shows the plugin applied to frame N−1 (the dark frame's corners still carry the
 *     identity frame's picture), and only after frame N settles does its own result appear.
 */
const W = 640, H = 360;
type Settings = Record<string, number | boolean>;

function card(): ImageData {
  const data = new ImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    data.data[i] = Math.floor(x * 255 / (W - 1)); data.data[i + 1] = Math.floor(y * 255 / (H - 1));
    data.data[i + 2] = ((x >> 3) ^ (y >> 3)) & 1 ? 200 : 40; data.data[i + 3] = 255;
    if (x < W / 8 && y < H / 8) { data.data[i] = 255; data.data[i + 1] = 255; data.data[i + 2] = 255; }
  }
  return data;
}

export async function verifyFfglGraph() {
  const bridge = desktopFfglBridge();
  if (!bridge) throw new Error('The desktop did not install the native FFGL host (window.loomDesktop.ffgl is absent)');
  const listed = await bridge.list();
  const manifest = manifestFromDescription(await bridge.describe('VignettePlus'));
  const store = createGraphStore(), registry = createNodeRegistry(allNodeDefinitions).view();
  const { bus } = createDomainBus({ store, registry });
  const created = await bus.execute('graph.applyPatch', {
    baseRevision: store.view.getGraph().revision, label: 'FFGL graph proof', operations: [
      { op: 'addNode', ref: '$source', type: 'webcam', label: 'webcam_card', position: { x: 0, y: 0 } },
      { op: 'setNodeResolution', nodeId: '$source', resolution: { mode: 'fixed', width: W, height: H } },
      { op: 'addNode', ref: '$ffgl', type: 'ffgl', label: 'ffgl_vignette', position: { x: 300, y: 0 }, parameters: { plugin: 'VignettePlus', manifest } },
      { op: 'addNode', ref: '$output', type: 'output', position: { x: 600, y: 0 } },
      { op: 'connect', source: { nodeId: '$source', portId: 'out' }, target: { nodeId: '$ffgl', portId: 'input' } },
      { op: 'connect', source: { nodeId: '$ffgl', portId: 'out' }, target: { nodeId: '$output', portId: 'input' } },
    ],
  }, { actor: { kind: 'system', id: 'ffgl-graph-smoke' }, projectId: 'ffgl-graph-smoke', capabilities: [] });
  if (created.status !== 'applied') throw new Error(JSON.stringify(created));
  const sourceId = created.output.createdIds['$source']!, ffglId = created.output.createdIds['$ffgl']!;
  const backend = createVgpuBackend({ host: browserGpuHost() });
  const ffgl = createNativeFfglSources();
  const errors: string[] = [];
  backend.onDiagnostic(d => { if (d.severity === 'error') errors.push(d.message); });
  const pixels = card();
  const input = await createImageBitmap(pixels);
  let settings: Settings = {};
  try {
    const capabilities = await backend.initialize({});
    const graph = compileGraph({ graph: store.view.getGraph(), registry, capabilities,
      settings: { ...displacementStackDocument.settings, workingFormat: 'rgba8unorm-srgb' } });
    const failures = graph.diagnostics.filter(d => d.severity === 'error');
    if (failures.length) throw new Error(JSON.stringify(failures));
    const resources = new Set(graph.resources.map(resource => resource.id));
    for (const key of [FFGL_INPUT_KEY, FFGL_RESULT_KEY])
      if (!resources.has(scratchResourceId(ffglId, key))) throw new Error(`The compiler did not allocate the ffgl node's ${key}`);
    const plan = await backend.compile(graph);
    const output = graph.outputs.find(entry => entry.nodeId === ffglId) ?? graph.outputs[0]!;
    ffgl.track([{ nodeId: ffglId, plugin: 'VignettePlus', manifest, size: [W, H], inputResourceId: scratchResourceId(ffglId, FFGL_INPUT_KEY),
      read: () => ({ bpm: 120, value: key => settings[key] as never }) }], backend);
    const unregister = backend.registerMediaSource(mediaSourceIdFor(sourceId), { currentFrame: () => ({ image: input, frameId: 1 }) });
    const frames: Array<{ case: string; maxDiff: number; differing: number; corners?: number[][]; cornersBeforeSettle?: number[][]; topLeft?: number[] }> = [];
    try {
      const at = (bytes: Uint8Array, stride: number, x: number, y: number) => Array.from(bytes.subarray(y * stride + x * 4, y * stride + x * 4 + 4));
      const want = (x: number, y: number) => Array.from(pixels.data.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));
      let index = 0;
      for (const [name, next] of [
        ['identity', { size: 1, softness: 0.25, roundness: 0, ratio: 1, blackBG: false }],
        ['dark', { size: 0, softness: 0, roundness: 0.5, ratio: 0.5, blackBG: false }],
      ] as const) {
        settings = next;
        const frame = { frameIndex: index, timeSeconds: index / 60, deltaSeconds: 1 / 60, mode: 'offline' as const, randomSeed: 7 };
        const render = () => backend.render(plan, { frame, pointer: { x: 0, y: 0, buttons: 0 }, resolution: [W, H] });
        render();
        const corners = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]] as const;
        // VN96: before this frame settles, the output is still the PREVIOUS frame's plugin result.
        const early = index > 0 ? await backend.readOutput(output.resourceId) : undefined;
        ffgl.observe(frame);
        // A hang is a failure with the tracker's own account, never a silent stall.
        await Promise.race([ffgl.settle(index), new Promise((_, reject) => setTimeout(() =>
          reject(new Error(`FFGL frame ${index} did not settle in 20 s: ${JSON.stringify(ffgl.diagnostics())}`)), 20000))]);
        render();
        if (errors.length) throw new Error(errors.join('\n'));
        const readback = await backend.readOutput(output.resourceId);
        if (readback.width !== W || readback.height !== H) throw new Error(`FFGL output is ${readback.width}x${readback.height}`);
        let maxDiff = 0, differing = 0;
        const region = name === 'identity'
          ? { x0: 0, y0: 0, x1: W, y1: H }
          : { x0: W / 2 - 4, y0: H / 2 - 4, x1: W / 2 + 4, y1: H / 2 + 4 };
        for (let y = region.y0; y < region.y1; y++) for (let x = region.x0; x < region.x1; x++) {
          const got = at(readback.bytes, readback.rowStride, x, y), exp = want(x, y);
          for (let k = 0; k < 3; k++) { const d = Math.abs(got[k]! - exp[k]!); if (d) differing++; maxDiff = Math.max(maxDiff, d); }
        }
        const record: (typeof frames)[number] = { case: name, maxDiff, differing };
        if (name === 'dark') {
          record.corners = corners.map(([x, y]) => at(readback.bytes, readback.rowStride, x, y));
          if (early) record.cornersBeforeSettle = corners.map(([x, y]) => at(early.bytes, early.rowStride, x, y));
        } else record.topLeft = at(readback.bytes, readback.rowStride, 2, 2);
        frames.push(record);
        index++;
      }
    } finally { unregister(); }
    if (errors.length) throw new Error(errors.join('\n'));
    return { plugins: listed.plugins.length, excluded: listed.excluded.length, frames, diagnostics: ffgl.diagnostics(), format: output.format ?? null };
  } finally { input.close(); await ffgl.drain(); backend.dispose(); }
}
