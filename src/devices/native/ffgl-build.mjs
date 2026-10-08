// VN85: builds the native FFGL host addon (ffgl-host.mm). No third-party source: the FFGL ABI
// the host speaks is declared in the .mm itself, and plugin binaries are never part of a build.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';

/**
 * Compiles `ffgl-host.node` into `directory`. `study: true` adds the harness-only surface
 * helpers (createStudySurface / readStudySurface / destroyStudySurface) under LOOM_FFGL_STUDY
 * and names the file `ffgl-host-study.node`; the product addon never carries them.
 */
export function buildFfglHost(directory, { study = false } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('The FFGL host currently requires Apple Silicon macOS');
  const source = fileURLToPath(new URL('./ffgl-host.mm', import.meta.url));
  const addon = join(directory, study ? 'ffgl-host-study.node' : 'ffgl-host.node');
  const result = spawnSync('clang++', ['-std=c++17', '-fobjc-arc', '-O2', '-shared', '-undefined', 'dynamic_lookup',
    ...(study ? ['-DLOOM_FFGL_STUDY=1'] : []),
    '-I', join(dirname(process.execPath), '../include/node'),
    '-framework', 'Foundation', '-framework', 'IOSurface', '-framework', 'OpenGL',
    source, '-o', addon], { stdio: 'inherit', timeout: 120000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`FFGL host build failed: ${result.status}`);
  return addon;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, flag] = process.argv.slice(2);
  if (!directory || (flag !== undefined && flag !== '--study')) throw new Error('Usage: node src/devices/native/ffgl-build.mjs <directory> [--study]');
  console.log(buildFfglHost(resolve(directory), { study: flag === '--study' }));
}
