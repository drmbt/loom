import process from 'node:process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, cp, rm, rename, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { Buffer } from 'node:buffer';
import { Console } from 'node:console';
import { fileURLToPath, URL } from 'node:url';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { artifactDigest } from './build-cache.mjs';

// Archives, not package resolution: the audited port, MLX core and its C bridge
// must move together. Nothing in this build downloads model weights.
const sources = [
  ['marigold', 'mnmly/mlx-swift-marigold-v2', 'f831354b69b2c683757bed567bf1395ceb826eb6', '208ba4c491cd2e8f0ff7a6faa97d29984cfcfadea036cc6dc466b17a0fdcbb3f'],
  ['mlx-swift', 'ml-explore/mlx-swift', 'ea8a179690170ca891a97bc0473198ab1ecda5f4', '299847e295c6ed20bc4e8ee1649173691ba79ab1c7e66c5c555f5ed802a0ffa5'],
  ['mlx', 'ml-explore/mlx', '1f8e74e3f12f31365464a6867c6579f0e9b29d85', 'cb988a5bdc38c798918d042b9b1c6edda3ccc5f23a2155138d3aa5c1b2acc301'],
  ['mlx-c', 'ml-explore/mlx-c', 'c74db5307cc8ce122f48d97ef951b30578674e7f', 'f7fe562edb84da59f7d6226772a51c57bdc931503fcd0ae63c078d7390d3510b'],
  ['swift-numerics', 'apple/swift-numerics', '0c0290ff6b24942dadb83a929ffaaa1481df04a2', 'd245f3fb06086ad0ea493b40d0a1058f17529344b5fd52ca4a7f4271240810c8'],
];
const { fetch } = globalThis;
const console = new Console(process.stdout, process.stderr);
const here = fileURLToPath(new URL('.', import.meta.url));
const repository = resolve(here, '../../..');
const directory = process.env.LOOM_MARIGOLD_DIRECTORY ?? join(repository, '.cache/marigold-v2');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Marigold MLX builds require macOS on Apple Silicon.');
if (!directory.startsWith('/')) throw new Error('LOOM_MARIGOLD_DIRECTORY must be absolute.');
const runtime = join(directory, 'runtime');
const work = join(directory, 'build');
const archives = join(directory, 'archives');
const digest = value => createHash('sha256').update(value).digest('hex');
const patch = await readFile(join(repository, 'patches/marigold-v2-mlx-q4.patch'));
const runner = await readFile(join(here, 'marigold/Runner.swift'));
const builder = await readFile(fileURLToPath(import.meta.url));
const fingerprint = digest(JSON.stringify(sources) + digest(patch) + digest(runner) + digest(builder));

function command(program, args, cwd, capture = false) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(program, args, { cwd, shell: false, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    let output = '';
    if (capture) child.stdout.on('data', bytes => { output += bytes; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolveCommand(output.trim()) : reject(new Error(`${program} failed (${code})`)));
  });
}
const toolchain = await command('xcrun', ['swift', '--version'], repository, true);
// A changed compiler or binary requires a rebuild, not an optimistic cache hit.
let cached;
try { cached = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (cached?.fingerprint === fingerprint && cached?.toolchain === toolchain) {
  if (artifactDigest(runtime) !== cached.artifactDigest) throw new Error('Cached Marigold runtime changed. Remove runtime.json explicitly before rebuilding.');
  await access(join(runtime, 'loom-marigold'), constants.X_OK);
  console.log(`Marigold worker verified: ${runtime}`);
} else {
  await mkdir(archives, { recursive: true });
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const directories = new Map();
  for (const [name, repo, revision, sha256] of sources) {
    const path = join(archives, `${name}-${revision}.tar.gz`);
    let bytes;
    try { bytes = await readFile(path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (bytes === undefined) {
      console.log(`Downloading pinned ${name} source…`);
      const response = await fetch(`https://codeload.github.com/${repo}/tar.gz/${revision}`);
      if (!response.ok) throw new Error(`${name} source download failed (${response.status})`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (digest(bytes) !== sha256) throw new Error(`${name} source digest differs from the audited archive`);
      await writeFile(path, bytes, { flag: 'wx' });
    }
    if (digest(bytes) !== sha256) throw new Error(`Cached ${name} source is corrupt`);
    const destination = join(work, name);
    await mkdir(destination);
    await command('tar', ['-xzf', path, '--strip-components=1', '-C', destination], repository);
    directories.set(name, destination);
  }
  const source = directories.get('marigold');
  const mlx = directories.get('mlx-swift');
  await cp(directories.get('mlx'), join(mlx, 'Source/Cmlx/mlx'), { recursive: true });
  await cp(directories.get('mlx-c'), join(mlx, 'Source/Cmlx/mlx-c'), { recursive: true });
  const manifestPath = join(mlx, 'Package.swift');
  const manifest = await readFile(manifestPath, 'utf8');
  const dependency = /\.package\(url: "https:\/\/github.com\/apple\/swift-numerics", from: "[^"]+"\)/;
  if (!dependency.test(manifest)) throw new Error('Pinned MLX Swift numerics dependency changed');
  await writeFile(manifestPath, manifest.replace(dependency, '.package(path: "../swift-numerics")'));
  await rm(join(source, 'Package.resolved'), { force: true });
  await command('patch', ['--batch', '-p1', '-i', join(repository, 'patches/marigold-v2-mlx-q4.patch')], source);
  await mkdir(join(source, 'LoomRunner'));
  await writeFile(join(source, 'LoomRunner/Runner.swift'), runner);
  await writeFile(join(source, 'Package.swift'), `// swift-tools-version: 6.3
import PackageDescription
let package = Package(name: "LoomMarigold", platforms: [.macOS(.v14)],
 products: [.executable(name: "loom-marigold", targets: ["LoomMarigold"])],
 dependencies: [.package(path: "../mlx-swift")], targets: [
 .target(name: "MLXMarigoldV2", dependencies: [.product(name: "MLX", package: "mlx-swift"), .product(name: "MLXNN", package: "mlx-swift")], path: "Sources/MLXMarigoldV2"),
 .executableTarget(name: "LoomMarigold", dependencies: ["MLXMarigoldV2", .product(name: "MLX", package: "mlx-swift")], path: "LoomRunner")
 ], swiftLanguageModes: [.v6])
`);
  const derived = join(directory, 'derived');
  await command('xcodebuild', ['-quiet', '-scheme', 'LoomMarigold', '-configuration', 'Release', '-destination', 'platform=macOS,arch=arm64',
    '-derivedDataPath', derived, '-disableAutomaticPackageResolution', '-clonedSourcePackagesDirPath', join(work, 'packages'),
    'CODE_SIGNING_ALLOWED=NO', 'build'], source);
  const release = join(derived, 'Build/Products/Release');
  const pending = join(directory, 'runtime.pending');
  await rm(pending, { recursive: true, force: true });
  await mkdir(pending);
  await cp(join(release, 'loom-marigold'), join(pending, 'loom-marigold'));
  await cp(join(release, 'mlx-swift_Cmlx.bundle'), join(pending, 'mlx-swift_Cmlx.bundle'), { recursive: true });
  await cp(join(source, 'LICENSE'), join(pending, 'Marigold-Swift-LICENSE'));
  await cp(join(source, 'NOTICE'), join(pending, 'Marigold-Swift-NOTICE'));
  for (const name of ['mlx-swift', 'mlx', 'mlx-c', 'swift-numerics'])
    await cp(join(directories.get(name), name === 'swift-numerics' ? 'LICENSE.txt' : 'LICENSE'), join(pending, `${name}-LICENSE`));
  const probe = JSON.parse(await command(join(pending, 'loom-marigold'), ['--probe'], repository, true));
  if (probe.protocol !== 1 || probe.runtime !== 'mlx-swift' || probe.quantization !== 'mixed-q4-q8-group64') throw new Error('Built worker protocol differs from the desktop contract');
  await rm(runtime, { recursive: true, force: true });
  await rename(pending, runtime);
  await writeFile(join(directory, 'runtime.json'), JSON.stringify({ version: 1, fingerprint, toolchain, artifactDigest: artifactDigest(runtime) }, null, 2) + '\n');
  console.log(`Marigold worker built: ${runtime}`);
}
