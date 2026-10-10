/* global module, require */
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const { join, basename } = require('node:path');

// VN85: the ONE place an FFGL plugin is found on disk. Every caller (the desktop host, the
// study harness, and VN90's settings once it lands) passes an ordered folder list; nothing
// else scans for bundles. Plugins are identified by bundle NAME (the FFGL 4cc arrives when the
// binary is probed), so a document names "VignettePlus", never a machine's absolute path.

/**
 * Vision/CoreML/ONNX effects need models and an inference runtime the host does not provide.
 * They are reported as excluded with this reason, never silently dropped. Matched on the bundle
 * name lowercased with separators removed.
 */
const EXCLUDED_PREFIXES = ['apple', 'depth', 'backgroundremoval', 'pose', 'objecttracker', 'subjectfollow', 'blobtracker'];
const EXCLUDED_REASON = 'Vision/CoreML/ONNX effect: needs a model runtime the FFGL host does not provide';

/** The development default until VN90: the repo's own folder first (if it exists), then drmbt-custom-fx's build. */
function defaultFfglPluginFolders({ repoRoot, home, exists = fs.existsSync } = {}) {
  if (typeof repoRoot !== 'string' || typeof home !== 'string') throw new Error('Plugin folder defaults need repoRoot and home');
  const folders = [];
  const repo = join(repoRoot, 'plugins', 'ffgl');
  if (exists(repo)) folders.push(repo);
  folders.push(join(home, 'Documents', 'GitHub', 'drmbt-custom-fx', 'build', 'effects'));
  return folders;
}

function binaryOf(bundle, name, io) {
  const directory = join(bundle, 'Contents', 'MacOS');
  const named = join(directory, name);
  if (io.exists(named)) return named;
  let entries;
  try { entries = io.readdir(directory); } catch { return null; }
  const files = entries.filter(entry => !entry.startsWith('.'));
  return files.length === 1 ? join(directory, files[0]) : null;
}

/**
 * Scans `folders` in order for `*.bundle`, flat or one directory down (drmbt-custom-fx's
 * build/effects/<effect>/<Name>.bundle). The first folder that holds a name wins; a later
 * bundle of the same name is recorded in the winner's `shadows`, not returned.
 */
function resolveFfglPlugins(folders, { io = { exists: fs.existsSync, readdir: fs.readdirSync, isDirectory: path => fs.statSync(path).isDirectory() } } = {}) {
  if (!Array.isArray(folders) || folders.some(folder => typeof folder !== 'string' || !folder))
    throw new Error('FFGL plugin folders must be a list of paths');
  const plugins = new Map();
  const excluded = [];
  const missingFolders = [];
  folders.forEach((folder, folderIndex) => {
    if (!io.exists(folder)) { missingFolders.push(folder); return; }
    const bundles = [];
    for (const entry of io.readdir(folder).sort()) {
      const path = join(folder, entry);
      if (entry.endsWith('.bundle')) { bundles.push(path); continue; }
      if (entry.startsWith('.')) continue;
      let directory;
      try { directory = io.isDirectory(path); } catch { directory = false; }
      if (!directory) continue;
      for (const inner of io.readdir(path).sort()) if (inner.endsWith('.bundle')) bundles.push(join(path, inner));
    }
    for (const bundle of bundles) {
      const name = basename(bundle, '.bundle');
      const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (EXCLUDED_PREFIXES.some(prefix => key.startsWith(prefix))) {
        excluded.push({ name, bundle, folder, reason: EXCLUDED_REASON });
        continue;
      }
      const existing = plugins.get(name);
      if (existing) { existing.shadows.push(bundle); continue; }
      const binary = binaryOf(bundle, name, io);
      if (!binary) { excluded.push({ name, bundle, folder, reason: 'Bundle has no single Contents/MacOS binary' }); continue; }
      plugins.set(name, { name, bundle, binary, folder, folderIndex, shadows: [] });
    }
  });
  return { plugins: [...plugins.values()].sort((a, b) => a.name.localeCompare(b.name)), excluded, missingFolders };
}

/** The resolved plugin a document's name refers to, or undefined. */
function findFfglPlugin(resolved, name) {
  return resolved.plugins.find(plugin => plugin.name === name);
}

module.exports = { defaultFfglPluginFolders, resolveFfglPlugins, findFfglPlugin, EXCLUDED_REASON };
