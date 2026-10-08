/* global require */
/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { defaultFfglPluginFolders, resolveFfglPlugins, findFfglPlugin, EXCLUDED_REASON } = require('./ffgl-plugins.cjs');

function bundle(folder, name, binary = name) {
  const directory = join(folder, `${name}.bundle`, 'Contents', 'MacOS');
  mkdirSync(directory, { recursive: true });
  if (binary) writeFileSync(join(directory, binary), 'not a real binary');
}

test('folders resolve in order: the first folder holding a name wins, later ones are shadows', () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-ffgl-plugins-'));
  try {
    const repo = join(root, 'repo'), dev = join(root, 'dev');
    bundle(repo, 'VignettePlus');
    mkdirSync(join(dev, 'vignette-plus'), { recursive: true });
    bundle(join(dev, 'vignette-plus'), 'VignettePlus');
    mkdirSync(join(dev, 'toxic-crt'), { recursive: true });
    bundle(join(dev, 'toxic-crt'), 'ToxicCRT');
    const resolved = resolveFfglPlugins([repo, join(root, 'absent'), dev]);
    assert.deepEqual(resolved.plugins.map(plugin => [plugin.name, plugin.folderIndex]), [['ToxicCRT', 2], ['VignettePlus', 0]]);
    const vignette = findFfglPlugin(resolved, 'VignettePlus');
    assert.equal(vignette.binary, join(repo, 'VignettePlus.bundle', 'Contents', 'MacOS', 'VignettePlus'));
    assert.deepEqual(vignette.shadows, [join(dev, 'vignette-plus', 'VignettePlus.bundle')]);
    assert.deepEqual(resolved.missingFolders, [join(root, 'absent')]);
    // Reordering the list is what changes the winner; nothing else does.
    assert.equal(findFfglPlugin(resolveFfglPlugins([dev, repo]), 'VignettePlus').folderIndex, 0);
    assert.equal(findFfglPlugin(resolveFfglPlugins([dev, repo]), 'VignettePlus').folder, dev);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('vision/model effects are reported as excluded with a reason, never returned', () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-ffgl-plugins-'));
  try {
    for (const name of ['ApplePersonSegmentation', 'DepthMatte5', 'BackgroundRemovalPlus', 'PoseBlocks', 'ObjectTracker', 'SubjectFollow', 'BlobTracker', 'Dither'])
      bundle(root, name);
    const resolved = resolveFfglPlugins([root]);
    assert.deepEqual(resolved.plugins.map(plugin => plugin.name), ['Dither']);
    assert.equal(resolved.excluded.length, 7);
    assert.ok(resolved.excluded.every(entry => entry.reason === EXCLUDED_REASON));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a bundle with an ambiguous or missing binary is excluded, and the binary name falls back to the only file', () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-ffgl-plugins-'));
  try {
    bundle(root, 'glitch_mosher', 'glitch_mosher');
    bundle(root, 'Renamed', 'OtherBinary');
    bundle(root, 'Empty', null);
    const resolved = resolveFfglPlugins([root]);
    assert.deepEqual(resolved.plugins.map(plugin => plugin.name), ['glitch_mosher', 'Renamed']);
    assert.match(findFfglPlugin(resolved, 'Renamed').binary, /OtherBinary$/);
    assert.deepEqual(resolved.excluded.map(entry => entry.name), ['Empty']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the development default puts the repo folder first only when it exists', () => {
  assert.deepEqual(defaultFfglPluginFolders({ repoRoot: '/r', home: '/h', exists: () => false }),
    ['/h/Documents/GitHub/drmbt-custom-fx/build/effects']);
  assert.deepEqual(defaultFfglPluginFolders({ repoRoot: '/r', home: '/h', exists: () => true }),
    ['/r/plugins/ffgl', '/h/Documents/GitHub/drmbt-custom-fx/build/effects']);
  assert.throws(() => resolveFfglPlugins('/not/a/list'), /list of paths/);
});
