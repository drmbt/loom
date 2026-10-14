#!/bin/bash
# VN118: builds loom-previz-host as a Node single executable application (SEA).
#
#   experiments/ae-host/sea/build.sh        (from the repo root; heavy: run through tools/heavy.sh)
#
# Output, all under experiments/ae-host/dist/ (gitignored):
#   loom-previz-host   official Node 24 + the bundled host, ad-hoc signed
#   dawn.node          Dawn (webgpu@0.4.0's addon), thinned to arm64, ad-hoc signed
#   loom-shm.node      the POSIX shm addon (native/loom_shm.c), ad-hoc signed
#   package/           manifest.json, project.loom.json, media/
#
# Needs experiments/ae-host/.cache/node24 (the official nodejs.org darwin-arm64 tarball,
# checksum-verified; see README) and .cache/tools/node_modules/postject.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HERE="$ROOT/experiments/ae-host"
CACHE="$HERE/.cache"
DIST="$HERE/dist"
NODE24="$CACHE/node24/bin/node"
POSTJECT="$CACHE/tools/node_modules/postject/dist/cli.js"
ESBUILD="$ROOT/node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/bin/esbuild"
DAWN="$ROOT/node_modules/.pnpm/webgpu@0.4.0/node_modules/webgpu/dist/darwin-universal.dawn.node"
[ -x "$NODE24" ] || { echo "missing $NODE24 (see README: Node 24 download)"; exit 1; }
[ -f "$POSTJECT" ] || { echo "missing postject: $CACHE/node24/bin/npm install --prefix $CACHE/tools postject@1.0.0-alpha.6"; exit 1; }
"$NODE24" -e 'process.exit(process.versions.node.startsWith("24.") ? 0 : 1)'

rm -rf "$DIST"; mkdir -p "$DIST"
t0=$(date +%s)

echo "== package"
(cd "$ROOT" && "$NODE24" --experimental-strip-types --no-warnings experiments/ae-host/manifest/build-package.ts --out "$DIST/package")

echo "== shm addon"
clang -O2 -Wall -shared -undefined dynamic_lookup -arch arm64 -mmacosx-version-min=13.0 \
  -I "$CACHE/node24/include/node" "$HERE/native/loom_shm.c" -o "$DIST/loom-shm.node"

echo "== bundle"
# SEA prelude (esbuild --banner). The bundle is CommonJS, where `import.meta.url` does not
# exist; it is defined as the executable's own URL so modules that build a require from it
# (@vgpu/adapter-node's Dawn loader) get one rooted beside the executable. Dawn is pointed at
# through that loader's documented override, VGPU_DAWN_BINARY: dawn.node ships next to
# loom-previz-host. (A SEA's own `require` sees builtins only; createRequire does not.)
BANNER='var __loomMetaUrl=require("node:url").pathToFileURL(process.execPath).href;if(!process.env.VGPU_DAWN_BINARY)process.env.VGPU_DAWN_BINARY=require("node:path").join(require("node:path").dirname(process.execPath),"dawn.node");'
# The bundle is named without a .js/.cjs extension so the repo's `eslint .` never scans
# 1.6 MB of minified output (experiments/ is linted; only the root dist/ is ignored).
"$ESBUILD" "$HERE/src/host.ts" --bundle --platform=node --format=cjs --target=node24 \
  --tsconfig="$ROOT/tsconfig.app.json" --define:import.meta.url=__loomMetaUrl \
  --banner:js="$BANNER" \
  --minify --legal-comments=none --log-level=warning \
  --metafile="$DIST/meta.json" --outfile="$DIST/host.bundle"

echo "== SEA"
cat > "$DIST/sea-config.json" <<JSON
{ "main": "$DIST/host.bundle", "output": "$DIST/sea-prep.blob", "disableExperimentalSEAWarning": true, "useCodeCache": true }
JSON
"$NODE24" --experimental-sea-config "$DIST/sea-config.json"
cp "$NODE24" "$DIST/loom-previz-host"
chmod u+w "$DIST/loom-previz-host"
codesign --remove-signature "$DIST/loom-previz-host"
"$NODE24" "$POSTJECT" "$DIST/loom-previz-host" NODE_SEA_BLOB "$DIST/sea-prep.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --macho-segment-name NODE_SEA
codesign --sign - --force "$DIST/loom-previz-host"

echo "== dawn.node"
lipo "$DAWN" -thin arm64 -output "$DIST/dawn.node"
codesign --sign - --force "$DIST/dawn.node" "$DIST/loom-shm.node"

rm -f "$DIST/sea-prep.blob" "$DIST/sea-config.json"
# meta.json (esbuild metafile) and host.bundle stay for inspection; neither ships.
echo "== done in $(( $(date +%s) - t0 )) s"
ls -la "$DIST" "$DIST/package" "$DIST/package/media"
