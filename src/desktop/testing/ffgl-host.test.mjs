// VN85 phase 1 gate: the REAL native FFGL host addon driving REAL plugin bundles on the GPU.
// Run: tools/heavy.sh pnpm desktop:ffgl-test   (needs Apple Silicon and the plugin folders;
// fails loudly when either is missing, never skips). Plugin folders come from
// LOOM_FFGL_PLUGIN_DIRS (colon-separated) or the development default.
//
// Every pixel claim is EXACT and derived from the plugin's shader (drmbt-custom-fx
// effects/vignette-plus/ffgl/VignettePlus.cpp, effects/stylized-grain/ffgl/StylizedGrain.cpp):
//   VignettePlus: f = 1 - smoothstep(0, soft, d) with d the rounded-box SDF of the pixel.
//   * Size=1, Roundness=0, Ratio=1: hy=0.9 and |p.x| <= 0.5*aspect/4, so d <= -0.4 everywhere
//     and f is exactly 1: out == in, every byte.
//   * Size=0, Softness=0: hy=0.02, soft=0.002. A corner is ~0.9 away (d >> soft) so f is exactly
//     0: out = in*0 = (0,0,0,0), or (0,0,0,255) with BlackBG. Within 0.02 of the centre d < 0,
//     so f is exactly 1: out == in.
//   StylizedGrain: grain frame = floor(time * Speed * 48). Speed=0 makes the frame constant, so
//   two times give identical bytes; Speed=0.5 puts t=1 and t=2 in different frames.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { buildFfglHost } from '../../devices/native/ffgl-build.mjs';

const require = createRequire(import.meta.url);
const { defaultFfglPluginFolders, resolveFfglPlugins, findFfglPlugin } = require('../ffgl-plugins.cjs');
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const folders = process.env.LOOM_FFGL_PLUGIN_DIRS
  ? process.env.LOOM_FFGL_PLUGIN_DIRS.split(':').filter(Boolean)
  : defaultFfglPluginFolders({ repoRoot, home: homedir() });
const resolved = resolveFfglPlugins(folders);
const binaryOf = name => {
  const plugin = findFfglPlugin(resolved, name);
  if (!plugin) throw new Error(`FFGL plugin ${name} not found in ${folders.join(', ')} (set LOOM_FFGL_PLUGIN_DIRS)`);
  return plugin.binary;
};

const directory = mkdtempSync(join(tmpdir(), 'loom-ffgl-host-'));
const addonPath = buildFfglHost(directory, { study: true });
const host = require(addonPath);
test.after(() => rmSync(directory, { recursive: true, force: true }));

const W = 1280, H = 720;
/** A deliberately asymmetric picture, top row first (a Chromium capture's layout). */
function picture() {
  const bytes = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    bytes[i] = (x * 255 / (W - 1)) | 0; bytes[i + 1] = (y * 255 / (H - 1)) | 0; bytes[i + 2] = (x ^ y) & 255; bytes[i + 3] = 255;
  }
  return bytes;
}
/** The output surface is bottom row first (Syphon's layout, VNB13): its row y is picture row H-1-y. */
const pixel = (bytes, x, y) => [...bytes.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];
const outputPixel = (bytes, x, yFromTop) => pixel(bytes, x, H - 1 - yFromTop);
function flipRows(bytes) {
  const flipped = Buffer.alloc(bytes.length);
  for (let y = 0; y < H; y++) bytes.copy(flipped, (H - 1 - y) * W * 4, y * W * 4, (y + 1) * W * 4);
  return flipped;
}
const frame = (time, parameters = [], pulses = []) => ({ time, bpm: 120, barPhase: 0, parameters, pulses });
async function render(instance, input, request) {
  const result = await host.process(instance, input, request);
  const bytes = Buffer.from(host.readStudySurface(result.handle));
  host.release(result.leaseId);
  return { bytes, result };
}

// Literal, from VignettePlus.cpp's constructor plus the canonical preset block (ffgl-preset-morph).
const VIGNETTE_TABLE = [
  ['Size', 10, 0.5], ['Softness', 10, 0.25], ['Roundness', 10, 0.5], ['Ratio', 10, 0.5], ['BlackBG', 0, 0],
  ['Preset', 11, 0], ['Morph', 10, 0.5], ['Recall', 1, 0], ['Rescan', 1, 0], ['Snap', 0, 0], ['Curve', 11, 6],
];
const CURVES = ['Linear', 'QuadIn', 'QuadOut', 'QuadInOut', 'SineIn', 'SineOut', 'SineInOut', 'CircIn', 'CircOut',
  'CircInOut', 'ExpoIn', 'ExpoOut', 'ExpoInOut', 'Hold'];

test('probe reads VignettePlus\'s own parameter table, with no GL instance', async () => {
  const plugin = await host.probe(binaryOf('VignettePlus'));
  assert.equal(plugin.id, 'VGNP'); assert.equal(plugin.name, 'VignettePlus'); assert.equal(plugin.pluginType, 0);
  assert.deepEqual(plugin.parameters.map(p => [p.name, p.type, p.default]), VIGNETTE_TABLE);
  assert.deepEqual(plugin.parameters.map(p => p.index), VIGNETTE_TABLE.map((_, index) => index));
  assert.deepEqual(plugin.parameters[10].elements.map(e => e.name), CURVES);
  assert.ok(plugin.parameters.filter(p => p.type !== 11).every(p => p.elements.length === 0));
  assert.deepEqual(plugin.parameters[0].range, { min: 0, max: 1 });
  assert.equal(plugin.clock.mode, 'host');
  assert.deepEqual(host.diagnostics().instances, 0);
});

test('VignettePlus: identity settings return the input exactly, row-flipped into GL order', async () => {
  const source = picture();
  const input = host.createStudySurface(W, H, source);
  const plugin = await host.open(binaryOf('VignettePlus'), W, H);
  try {
    assert.equal(plugin.instance.startsWith('ffgl-instance-'), true);
    const { bytes, result } = await render(plugin.instance, input, frame(0, [[0, 1], [2, 0], [3, 1]]));
    assert.equal(result.bottomUp, true);
    assert.equal([result.width, result.height].join('x'), `${W}x${H}`);
    assert.ok(flipRows(bytes).equals(source), 'every byte of the frame equals the input');
    assert.ok(result.timing.gpuMs >= 0 && result.timing.cpuMs > 0);
  } finally { await host.close(plugin.instance); host.destroyStudySurface(input); }
});

test('VignettePlus: Size 0 / Softness 0 zeroes the corners and leaves the centre exact', async () => {
  const source = picture();
  const input = host.createStudySurface(W, H, source);
  const plugin = await host.open(binaryOf('VignettePlus'), W, H);
  try {
    const corners = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]];
    const centre = [];
    for (let y = H / 2 - 4; y < H / 2 + 4; y++) for (let x = W / 2 - 4; x < W / 2 + 4; x++) centre.push([x, y]);
    const dark = (await render(plugin.instance, input, frame(0, [[0, 0], [1, 0], [2, 0.5], [3, 0.5], [4, false]]))).bytes;
    for (const [x, y] of corners) assert.deepEqual(outputPixel(dark, x, y), [0, 0, 0, 0], `corner ${x},${y} transparent`);
    for (const [x, y] of centre) assert.deepEqual(outputPixel(dark, x, y), pixel(source, x, y), `centre ${x},${y} unchanged`);
    const black = (await render(plugin.instance, input, frame(0, [[4, true]]))).bytes;
    for (const [x, y] of corners) assert.deepEqual(outputPixel(black, x, y), [0, 0, 0, 255], `corner ${x},${y} opaque black`);
    for (const [x, y] of centre) assert.deepEqual(outputPixel(black, x, y), pixel(source, x, y));
    // The parameter the host wrote is the one the plugin holds.
    assert.equal(await host.parameter(plugin.instance, 4), 1);
    assert.equal(await host.parameter(plugin.instance, 0), 0);
  } finally { await host.close(plugin.instance); host.destroyStudySurface(input); }
});

test('StylizedGrain: the plugin\'s clock is the host\'s time (the rebind took)', async () => {
  const input = host.createStudySurface(W, H, picture());
  // A fresh instance's clock starts at its first frame's time, so these are three takes.
  const take = async (time, speed) => {
    const plugin = await host.open(binaryOf('StylizedGrain'), W, H, 7);
    try {
      assert.deepEqual(plugin.clock, { mode: 'host', steadyClock: 1, rand: 1, randomDevice: 1 });
      const index = plugin.parameters.find(p => p.name === 'Speed').index;
      return (await render(plugin.instance, input, frame(time, [[index, speed]]))).bytes;
    } finally { await host.close(plugin.instance); }
  };
  try {
    const one = await take(1, 0.5), two = await take(2, 0.5), oneAgain = await take(1, 0.5);
    assert.ok(one.equals(oneAgain), 'same host time, same bytes');
    assert.ok(!one.equals(two), 'times in different grain frames differ');
    assert.ok((await take(1, 0)).equals(await take(2, 0)), 'Speed 0: grain frame is constant, so time has no effect');
  } finally { host.destroyStudySurface(input); }
});

test('the plugin clock is a free clock: monotonic, one interval across a seek, fresh on reset', async () => {
  const input = host.createStudySurface(W, H, picture());
  const plugin = await host.open(binaryOf('VignettePlus'), W, H);
  try {
    const clocks = [];
    const at = async (time, extra = {}) => {
      const result = await host.process(plugin.instance, input, { ...frame(time), interval: 1 / 60, ...extra });
      host.release(result.leaseId); clocks.push(result.clock);
    };
    await at(5); await at(5 + 1 / 60); await at(5 + 1 / 60);   // start at the time; step; re-cook
    await at(1);                                                   // backward seek: one interval
    await at(1 + 0.1);                                             // 6 intervals of real time: kept
    await at(500);                                                 // forward jump: one interval
    await at(9, { reset: true });                                  // a new take
    const e = 1 / 60;
    const expected = [5, 5 + e, 5 + e, 5 + 2 * e, 5 + 2 * e + 0.1, 5 + 3 * e + 0.1, 9];
    clocks.forEach((clock, i) => assert.ok(Math.abs(clock - expected[i]) < 1e-9, `clock ${i}: ${clock} vs ${expected[i]}`));
    assert.throws(() => host.process(plugin.instance, input, { ...frame(0), interval: 0 }), /interval/);
  } finally { await host.close(plugin.instance); host.destroyStudySurface(input); }
});

// The frame after a seek must be the frame a normal one-interval step gives, so a simulation
// integrating dt sees neither a negative nor an exploding step. Exact: same bytes, every frame.
// LiquidWake's Mix defaults to 0 (a pass-through); at 1 its simulation reaches the output.
const SEEK_SETTINGS = { glitch_mosher: [], LiquidWake: [[0, 1]] };
for (const name of ['glitch_mosher', 'LiquidWake']) {
  test(`${name}: a backward seek and a far forward jump each step the plugin by one interval`, async () => {
    const SW = 320, SH = 180, e = 1 / 60;
    const cards = Array.from({ length: 12 }, (_, i) => {
      const bytes = Buffer.alloc(SW * SH * 4);
      for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
        const k = (y * SW + x) * 4, u = (x + i * 7) % SW;
        bytes[k] = u * 255 / SW; bytes[k + 1] = y * 255 / SH; bytes[k + 2] = ((u >> 4) ^ (y >> 4)) & 1 ? 220 : 30; bytes[k + 3] = 255;
      }
      return bytes;
    });
    const sequence = async times => {
      const plugin = await host.open(binaryOf(name), SW, SH, 3);
      const frames = [];
      try {
        for (let i = 0; i < times.length; i++) {
          const surface = host.createStudySurface(SW, SH, cards[i]);
          try {
            const result = await host.process(plugin.instance, surface, { time: times[i], bpm: 120, barPhase: 0, interval: e,
              parameters: i === 0 ? SEEK_SETTINGS[name] : [] });
            frames.push(Buffer.from(host.readStudySurface(result.handle))); host.release(result.leaseId);
          } finally { host.destroyStudySurface(surface); }
        }
      } finally { await host.close(plugin.instance); }
      return frames;
    };
    const straight = await sequence(cards.map((_, i) => 2 + i * e));
    const back = await sequence(cards.map((_, i) => (i < 6 ? 2 + i * e : (i - 6) * e)));
    const forward = await sequence(cards.map((_, i) => (i < 6 ? 2 + i * e : 1000 + (i - 6) * e)));
    for (let i = 0; i < cards.length; i++) {
      assert.ok(back[i].equals(straight[i]), `${name} frame ${i}: backward seek == straight run`);
      assert.ok(forward[i].equals(straight[i]), `${name} frame ${i}: forward jump == straight run`);
    }
    assert.ok(straight.every(bytes => bytes.some(value => value !== 0)), `${name}: no black frame`);
    assert.ok(!straight[11].equals(straight[6]), `${name}: the sequence moves`);
    assert.ok(!straight[11].equals(cards[11]), `${name}: the effect reaches the output (not a pass-through)`);
  });
}

test('a misbehaving request is an error, not a crash, and leases account exactly', async () => {
  const input = host.createStudySurface(W, H, picture());
  const plugin = await host.open(binaryOf('VignettePlus'), W, H);
  try {
    await assert.rejects(host.process(plugin.instance, input, frame(0, [[99, 1]])), /No FFGL parameter at index 99/);
    await assert.rejects(host.process(plugin.instance, input, frame(0, [], [0])), /is not an event/);
    const small = host.createStudySurface(64, 36, Buffer.alloc(64 * 36 * 4));
    await assert.rejects(host.process(plugin.instance, small, frame(0)), /size does not match/);
    host.destroyStudySurface(small);
    // Two output surfaces: a third unreleased frame is refused, not overwritten under the reader.
    const first = await host.process(plugin.instance, input, frame(0));
    const second = await host.process(plugin.instance, input, frame(0, [], [7]));
    assert.notDeepEqual([...first.handle], [...second.handle]);
    await assert.rejects(host.process(plugin.instance, input, frame(0)), /still leased/);
    host.release(first.leaseId);
    assert.throws(() => host.release(first.leaseId), /already released/);
    assert.equal(host.diagnostics().leases, 1);
    // Close with a lease outstanding: the surface stays readable until the lease is released.
    await host.close(plugin.instance);
    assert.equal(host.readStudySurface(second.handle).length, W * H * 4);
    host.release(second.leaseId);
    await assert.rejects(Promise.resolve().then(() => host.process(plugin.instance, input, frame(0))), /Unknown FFGL instance/);
  } finally { host.destroyStudySurface(input); }
  await assert.rejects(host.probe(addonPath), /Not an FFGL plugin/);
  await assert.rejects(host.open('/nonexistent/Plugin', W, H), /not found/);
  assert.deepEqual(host.diagnostics().instances, 0);
  assert.deepEqual(host.diagnostics().leases, 0);
});
