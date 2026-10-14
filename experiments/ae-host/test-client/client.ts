// VN118: plays the AE effect's side of PROTOCOL.md v1 against loom-previz-host.
//
//   node experiments/ae-host/test-client/client.ts [--host <executable>] [--package <dir>] [--out <dir>] [--frames 60]
//
// Without --host it starts the dev host (`node --import ./src/tooling/alias-hooks.ts
// experiments/ae-host/src/host.ts`) from the repo root. With --host it runs that executable
// (the SEA); LOOM_SHM_ADDON or the executable's directory supplies loom-shm.node to this
// client too, so the shipped addon is the one exercised on both sides.
//
// Checks, each asserting what differs and where:
//   (a) the DS image lands on the drape: a red DS and a green DS change the same region,
//       and that region is red-dominant in one render and green-dominant in the other;
//   (b) a parameter changes pixels (slider_orbit, toggle_talent);
//   (c) a cut input renders differently from a fed one, and darker in the DS region;
//   (d) frames requested out of order are byte-identical to the same frames in order;
//   (f) the FX pixel map PNG is decoded and fed: with Source FX = map, the real PNG and a
//       black one of the same size render the FX fixtures differently (VN121);
//   plus a resize (960x540) and the round-trip time over N frames at 1920x1080.
import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";

const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const here = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(here, "../../..");
const hostExe = arg("host");
const packageDir = resolve(arg("package", hostExe ? join(dirname(hostExe), "package") : join(here, "../package"))!);
const outDir = resolve(arg("out", join(here, "../out"))!);
const N = Number(arg("frames", "60"));
if (hostExe && !process.env["LOOM_SHM_ADDON"]) process.env["LOOM_SHM_ADDON"] = join(dirname(resolve(hostExe)), "loom-shm.node");
const { createSlot, unlinkSlot } = await import("../src/shm.ts");
mkdirSync(outDir, { recursive: true });

const manifest = JSON.parse(readFileSync(join(packageDir, "manifest.json"), "utf8"));
const W = 1920, H = 1080;

// ---------- the effect's slots ----------
const prefix = `/loomae.${process.pid}.`;
const slotNames: string[] = [];
function slot(n: number, bytes: number): Uint8Array {
  const name = `${prefix}${n}`;
  slotNames.push(name);
  return createSlot(name, bytes);
}
const SLOT = { ds: 1, sides: 2, out: 3, out2: 4 };
const dsSlot = slot(SLOT.ds, W * H * 4);
const sidesSlot = slot(SLOT.sides, W * H * 4);
const outSlot = slot(SLOT.out, W * H * 8);
const out2Slot = slot(SLOT.out2, W * H * 8);

// ---------- test images (RGBA8 straight, rows top to bottom) ----------
function fill(target: Uint8Array, w: number, h: number, f: (x: number, y: number) => [number, number, number]): Uint8Array {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = f(x, y); const o = (y * w + x) * 4;
    target[o] = r; target[o + 1] = g; target[o + 2] = b; target[o + 3] = 255;
  }
  return target;
}
/** DS test card: warm vertical bars, a white grid every 120 px, a frame-dependent band. */
const dsCard = (seed: number) => (x: number, y: number): [number, number, number] => {
  if (x % 120 < 4 || y % 120 < 4) return [255, 255, 255];
  if (Math.abs(((x + seed * 37) % W) - y * (W / H)) < 12) return [40, 255, 60];
  const bar = Math.floor(x / 240) % 2;
  return bar ? [255, 140, 20] : [200, 30, 40];
};
/** Sides test card: cyan/blue checker with a yellow centre line. */
const sidesCard = (seed: number) => (x: number, y: number): [number, number, number] => {
  if (Math.abs(y - H / 2) < 10) return [255, 230, 0];
  return (Math.floor((x + seed * 11) / 96) + Math.floor(y / 96)) % 2 ? [0, 200, 255] : [10, 40, 200];
};

// ---------- fp16 + PNG ----------
const half = new Float32Array(65536);
for (let i = 0; i < 65536; i++) {
  const s = i & 0x8000 ? -1 : 1, e = (i >> 10) & 0x1f, m = i & 0x3ff;
  half[i] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
}
function toFloat(bytes: Uint8Array): Float32Array {
  const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const f = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) f[i] = half[u16[i]!]!;
  return f;
}
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc(buf: Uint8Array): number { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 255]! ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length); const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); out.set(Buffer.from(type, "ascii"), 4); out.set(data, 8);
  dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length))); return out;
}
/** Output values are display-encoded already (PROTOCOL.md), so 8-bit is a clamp and a scale. */
function writePng(path: string, f: Float32Array, w: number, h: number): void {
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w * 4; x++) {
    raw[y * (w * 4 + 1) + 1 + x] = Math.max(0, Math.min(255, Math.round(f[y * w * 4 + x]! * 255)));
  }
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr.set([8, 6, 0, 0, 0], 8);
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]));
}

// ---------- the host ----------
/** Every host -> effect message, loosely: PROTOCOL.md v1 § Control channel. */
interface HostMessage {
  type: "hello" | "frame" | "error" | "log";
  seq: number; protocol: number; name: string; gpu: string;
  slot: number; width: number; height: number; ms: number; message: string;
}
interface Host {
  readonly child: ReturnType<typeof spawn>;
  readonly log: string[];
  /** The host's exit code once it has exited. */
  exit: number | null;
  readonly sock: Socket;
  readonly hello: HostMessage;
  readonly helloMs: number;
  send(msg: { seq: number } & Record<string, unknown>): Promise<HostMessage>;
}
/** Starts a host on a package and connects to it (VN121: the FX-map check runs two more). */
async function startHost(pkg: string, tag: string): Promise<Host> {
  const socketPath = join(process.env["TMPDIR"] ?? tmpdir(), `loomae.${process.pid}.${tag}.sock`);
  const cmd = hostExe ? resolve(hostExe) : process.execPath;
  const cmdArgs = [
    ...(hostExe ? [] : ["--import", "./src/tooling/alias-hooks.ts", "experiments/ae-host/src/host.ts"]),
    "--package", pkg, "--socket", socketPath, "--shm-prefix", prefix,
  ];
  const spawnedAt = performance.now();
  const child = spawn(cmd, cmdArgs, { cwd: hostExe ? dirname(resolve(hostExe)) : repoRoot, stdio: ["pipe", "inherit", "pipe"] });
  const log: string[] = [];
  const state = { exit: null as number | null };
  child.stderr!.setEncoding("utf8").on("data", (s: string) => { log.push(s); if (process.env["VERBOSE"]) process.stderr.write(s); });
  child.on("exit", (code) => { state.exit = code; });
  let sock: Socket | null = null;
  for (let i = 0; i < 300 && sock === null; i++) {
    sock = await new Promise<Socket | null>((ok) => {
      const s = connect(socketPath); s.once("connect", () => ok(s)); s.once("error", () => ok(null));
    });
    if (sock) break;
    if (state.exit !== null) throw new Error(`host exited ${state.exit}:\n${log.join("")}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  if (sock === null) throw new Error("host never listened");
  sock.setNoDelay(true);
  const pending = new Map<number, (m: HostMessage) => void>();
  let helloResolve: (m: HostMessage) => void;
  const hello = new Promise<HostMessage>((r) => (helloResolve = r));
  let buf = "";
  sock.setEncoding("utf8").on("data", (c: string) => {
    buf += c; let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, nl)) as HostMessage; buf = buf.slice(nl + 1);
      if (m.type === "hello") helloResolve(m);
      else if (m.type === "log") { if (process.env["VERBOSE"]) console.log(`  host log: ${m.message}`); }
      else { pending.get(m.seq)?.(m); pending.delete(m.seq); }
    }
  });
  const h = await hello;
  const helloMs = performance.now() - spawnedAt;
  if (h.protocol !== 1) throw new Error(`protocol mismatch: ${h.protocol}`);
  const connected = sock;
  return {
    child, log, sock: connected, hello: h, helloMs,
    get exit() { return state.exit; },
    send(msg) {
      return new Promise((ok, bad) => {
        pending.set(msg.seq, (m) => (m.type === "frame" ? ok(m) : bad(new Error(m.message))));
        connected.write(JSON.stringify(msg) + "\n");
      });
    },
  };
}
/** Closes the connection and waits for the host to exit (it must, PROTOCOL.md lifetime). */
async function stopHost(host: Host): Promise<boolean> {
  host.sock.end();
  const exited = await new Promise<boolean>((ok) => {
    if (host.exit !== null) return ok(true);
    const t = setTimeout(() => ok(false), 5000);
    host.child.once("exit", () => { clearTimeout(t); ok(true); });
  });
  if (!exited) host.child.kill();
  return exited;
}
const main = await startHost(packageDir, "main");
const h = main.hello, helloMs = main.helloMs;
console.log(`hello: ${JSON.stringify(h)} (${helloMs.toFixed(0)} ms after spawn)`);

let seq = 0;
const defaults = Object.fromEntries((manifest.params as { id: string; default: number | boolean }[]).map((p) => [p.id, typeof p.default === "boolean" ? (p.default ? 1 : 0) : p.default]));
interface Req { time: number; width?: number; height?: number; params?: Record<string, number>; ds?: boolean; sides?: boolean; out?: number; dsSize?: [number, number] }
function request(r: Req, host: Host = main): Promise<HostMessage> {
  const id = ++seq;
  const width = r.width ?? W, height = r.height ?? H;
  const inputs: Record<string, unknown> = {};
  if (r.ds !== false) inputs["ds"] = { slot: SLOT.ds, width: r.dsSize?.[0] ?? W, height: r.dsSize?.[1] ?? H };
  if (r.sides !== false) inputs["sides"] = { slot: SLOT.sides, width: W, height: H };
  return host.send({ type: "render", seq: id, time: r.time, width, height, params: { ...defaults, ...r.params }, inputs, output: { slot: r.out ?? SLOT.out } });
}
/** Render and copy the output out of the slot (the slot is reused by the next request). */
async function render(r: Req, name?: string, host: Host = main): Promise<{ f: Float32Array; bytes: Uint8Array; reply: HostMessage }> {
  const reply = await request(r, host);
  const view = (r.out ?? SLOT.out) === SLOT.out ? outSlot : out2Slot;
  const bytes = view.slice(0, reply.width * reply.height * 8);
  const f = toFloat(bytes);
  if (name) writePng(join(outDir, `${name}.png`), f, reply.width, reply.height);
  return { f, bytes, reply };
}

const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => { results.push({ check: name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`); };
const lum = (f: Float32Array, p: number) => 0.2126 * f[p * 4]! + 0.7152 * f[p * 4 + 1]! + 0.0722 * f[p * 4 + 2]!;
function diffMask(a: Float32Array, b: Float32Array, threshold = 0.02): Uint8Array {
  const m = new Uint8Array(a.length / 4);
  for (let p = 0; p < m.length; p++) {
    const d = Math.abs(a[p * 4]! - b[p * 4]!) + Math.abs(a[p * 4 + 1]! - b[p * 4 + 1]!) + Math.abs(a[p * 4 + 2]! - b[p * 4 + 2]!);
    m[p] = d > threshold ? 1 : 0;
  }
  return m;
}
const count = (m: Uint8Array) => m.reduce((s, v) => s + v, 0);
const bbox = (m: Uint8Array, w: number) => {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let p = 0; p < m.length; p++) if (m[p]) { const x = p % w, y = (p / w) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return `x ${x0}..${x1}, y ${y0}..${y1}`;
};

try {
  const T = 10; // seconds: frame 300
  fill(dsSlot, W, H, dsCard(0)); fill(sidesSlot, W, H, sidesCard(0));
  const t0 = performance.now();
  const base = await render({ time: T }, "base-t10");
  console.log(`first frame: ${(performance.now() - t0).toFixed(0)} ms round trip (host ${base.reply.ms} ms)`);

  // (a) DS on the drape: solid red vs solid green DS, sides unchanged.
  fill(dsSlot, W, H, () => [255, 0, 0]);
  const red = await render({ time: T }, "a-ds-red");
  fill(dsSlot, W, H, () => [0, 255, 0]);
  const green = await render({ time: T }, "a-ds-green");
  const dsMask = diffMask(red.f, green.f);
  let rg1 = 0, rg2 = 0;
  for (let p = 0; p < dsMask.length; p++) if (dsMask[p]) { rg1 += red.f[p * 4]! - red.f[p * 4 + 1]!; rg2 += green.f[p * 4]! - green.f[p * 4 + 1]!; }
  const n = count(dsMask);
  check("a: DS image appears on the drape", n > W * H * 0.01 && rg1 > 0 && rg2 < 0,
    `${n} px (${((100 * n) / (W * H)).toFixed(1)}%) change with the DS colour, region ${bbox(dsMask, W)}; mean R-G there: red DS ${(rg1 / n).toFixed(3)}, green DS ${(rg2 / n).toFixed(3)}`);

  // (b) parameters change pixels.
  fill(dsSlot, W, H, dsCard(0));
  const orbit = await render({ time: T, params: { slider_orbit: 30 } }, "b-orbit30");
  const orbitN = count(diffMask(base.f, orbit.f));
  check("b: slider_orbit -3 -> 30 changes pixels", orbitN > W * H * 0.05, `${orbitN} px differ (${((100 * orbitN) / (W * H)).toFixed(1)}%)`);
  const talent = await render({ time: T, params: { toggle_talent: 0 } }, "b-talent-off");
  const talentMask = diffMask(base.f, talent.f);
  check("b: toggle_talent off changes pixels", count(talentMask) > 100, `${count(talentMask)} px differ, region ${bbox(talentMask, W)}`);
  const back = await render({ time: T });
  check("b: back to defaults reproduces the base frame", Buffer.compare(back.bytes, base.bytes) === 0, "byte-identical after two param changes");

  // (c) a cut input vs a fed one.
  const cut = await render({ time: T, ds: false }, "c-ds-cut");
  const cutMask = diffMask(base.f, cut.f);
  let lFed = 0, lCut = 0, inDs = 0;
  for (let p = 0; p < cutMask.length; p++) if (dsMask[p]) { lFed += lum(base.f, p); lCut += lum(cut.f, p); inDs++; }
  check("c: DS cut renders differently, darker where the DS lands", count(cutMask) > W * H * 0.01 && lCut < lFed * 0.8,
    `${count(cutMask)} px differ; mean luminance in the DS region fed ${(lFed / inDs).toFixed(3)} vs cut ${(lCut / inDs).toFixed(3)}`);
  const sidesCut = await render({ time: T, sides: false }, "c-sides-cut");
  const sidesMask = diffMask(base.f, sidesCut.f);
  check("c: sides cut renders differently", count(sidesMask) > 1000, `${count(sidesMask)} px differ, region ${bbox(sidesMask, W)}`);

  // (d) random access: frame-dependent inputs, in order vs out of order.
  const times = [1, 5, 20, 33.3];
  const order = [3, 0, 2, 1];
  const inOrder: Uint8Array[] = [];
  for (let i = 0; i < times.length; i++) {
    fill(dsSlot, W, H, dsCard(i)); fill(sidesSlot, W, H, sidesCard(i));
    inOrder[i] = (await render({ time: times[i]! })).bytes;
  }
  let same = 0;
  for (const i of order) {
    fill(dsSlot, W, H, dsCard(i)); fill(sidesSlot, W, H, sidesCard(i));
    const b = (await render({ time: times[i]! }, i === 3 ? "d-t33.3" : undefined)).bytes;
    if (Buffer.compare(b, inOrder[i]!) === 0) same++;
  }
  const distinct = Buffer.compare(inOrder[0]!, inOrder[1]!) !== 0;
  check("d: out-of-order frames equal in-order ones", same === times.length && distinct, `${same}/${times.length} byte-identical (times ${times.join(", ")} s, requested in order ${order.join(",")}); frames differ from each other: ${distinct}`);

  // Resize: half resolution (AE downsampling) and back; the DS at a different size is resampled.
  fill(dsSlot, 960, 540, (x, y) => dsCard(0)(x * 2, y * 2));
  const small = await render({ time: T, width: 960, height: 540, dsSize: [960, 540] }, "e-960x540");
  const smallOk = small.reply.width === 960 && small.reply.height === 540;
  const again = await render({ time: T });
  check("e: 960x540 then 1920x1080 again", smallOk && again.reply.width === W, `half-res frame ${small.reply.width}x${small.reply.height} in ${small.reply.ms} ms host (includes building that size's program)`);

  // Round trip at 1920x1080 over N frames, inputs rewritten every frame (as the effect would).
  fill(dsSlot, W, H, dsCard(0)); fill(sidesSlot, W, H, sidesCard(0));
  const rt: number[] = [], hostMs: number[] = [];
  for (let i = 0; i < N; i++) {
    dsSlot[(i * 4097) % dsSlot.length] = i & 255; // a touch per frame; the host re-uploads every request anyway
    const s = performance.now();
    const reply = await request({ time: 20 + i / manifest.fps });
    rt.push(performance.now() - s); hostMs.push(reply.ms);
  }
  const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
  const p95 = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length * 0.95)]!;
  const timing = `round trip median ${med(rt).toFixed(1)} ms, p95 ${p95(rt).toFixed(1)} ms, host median ${med(hostMs).toFixed(1)} ms over ${N} frames at 1920x1080 (${(1000 / med(rt)).toFixed(1)} fps)`;
  console.log(timing);
  // (f) VN121: the FX pixel map (movie_fxMap, a PNG inside stageFeeds) is decoded and fed.
  // -13 ships with Source FX = 1 (test pattern) and the panel does not expose it, so the map
  // is not on screen by default. Two package copies set Source FX = 2 (the map): one with the
  // real PNG, one with an opaque black PNG of the same size, which is what the map rendered as
  // before VN121. The FX fixtures (pixel lines, strobes) must differ, and be brighter, with
  // the real map.
  {
    const project = JSON.parse(readFileSync(join(packageDir, manifest.project), "utf8"));
    const feeds = Object.values(project.graph.nodes as Record<string, { type: string; parameters: Record<string, unknown> }>)
      .find((n) => n.type.startsWith("component:stageFeeds"));
    if (feeds === undefined) throw new Error("f: no stageFeeds instance in the project");
    feeds.parameters["sourceFX"] = 2;
    const mapFile = /"file":\s*"[^"]*\/(fx-pixel-map[^"/]*\.png)"/.exec(JSON.stringify(project.componentLibrary))?.[1];
    if (mapFile === undefined) throw new Error("f: the project names no fx-pixel-map PNG");
    const png = readFileSync(join(packageDir, "media", mapFile));
    const mw = png.readUInt32BE(16), mh = png.readUInt32BE(20);
    const made: string[] = [];
    const variant = (tag: string, black: boolean): string => {
      const dir = join(process.env["TMPDIR"] ?? tmpdir(), `loomae.${process.pid}.${tag}`);
      made.push(dir);
      mkdirSync(join(dir, "media"), { recursive: true });
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
      writeFileSync(join(dir, manifest.project), JSON.stringify(project));
      for (const file of readdirSync(join(packageDir, "media"))) copyFileSync(join(packageDir, "media", file), join(dir, "media", file));
      if (black) writePng(join(dir, "media", mapFile), new Float32Array(mw * mh * 4).map((_, i) => (i % 4 === 3 ? 1 : 0)), mw, mh);
      return dir;
    };
    try {
      fill(dsSlot, W, H, dsCard(0)); fill(sidesSlot, W, H, sidesCard(0));
      const shots: Record<string, Float32Array> = {};
      for (const [tag, black] of [["fxmap", false], ["fxmap-black", true]] as const) {
        const host = await startHost(variant(tag, black), tag);
        try { shots[tag] = (await render({ time: T }, `f-${tag}`, host)).f; } finally { await stopHost(host); }
      }
      const withMap = shots["fxmap"]!, withoutMap = shots["fxmap-black"]!;
      const fxMask = diffMask(withMap, withoutMap);
      let lMap = 0, lBlack = 0;
      for (let p = 0; p < fxMask.length; p++) if (fxMask[p]) { lMap += lum(withMap, p); lBlack += lum(withoutMap, p); }
      const nFx = count(fxMask);
      check("f: the FX pixel map lights the FX fixtures (Source FX = map)", nFx > 1000 && lMap > lBlack,
        `${nFx} px differ between the real ${mapFile} (${mw}x${mh}) and a black one, region ${bbox(fxMask, W)}; mean luminance there: map ${(lMap / Math.max(1, nFx)).toFixed(3)}, black ${(lBlack / Math.max(1, nFx)).toFixed(3)}`);
    } finally {
      for (const dir of made) rmSync(dir, { recursive: true, force: true });
    }
  }

  writeFileSync(join(outDir, "results.json"), JSON.stringify({ hello: h, helloMs, results, timing: { roundTripMedian: med(rt), roundTripP95: p95(rt), hostMedian: med(hostMs), frames: N } }, null, 2));
} finally {
  // Lifetime: closing our only connection must make the host exit.
  const exited = await stopHost(main);
  check("lifetime: host exits when the last client disconnects", exited && main.exit === 0, `exit code ${main.exit}`);
  for (const name of slotNames) unlinkSlot(name);
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? `ALL ${results.length} CHECKS PASS (PNGs in ${outDir})` : `${failed.length} FAILED`);
  if (failed.length > 0) { console.log(main.log.join("")); process.exitCode = 1; }
}
