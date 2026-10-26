// VN118: loom-previz-host, the Loom side of PROTOCOL.md v1.
//
//   loom-previz-host --package <dir> --socket <path> --shm-prefix <prefix>
//
// Listens on a Unix socket (NDJSON), maps the effect's POSIX shm slots, renders each request
// on Dawn (serialised: one GPU queue) and writes RGBA16F straight-alpha frames into the
// output slot. Exits when the last client disconnects or stdin closes.
import { createServer, type Socket } from "node:net";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createPrevizRenderer, type LayerImage, type PrevizRenderer } from "./renderer.ts";
import { SlotMap } from "./shm.ts";
import { PROTOCOL_VERSION, type Manifest } from "./manifest-types.ts";

function args(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, v] = a.includes("=") ? a.slice(2).split(/=(.*)/s) : [a.slice(2), argv[++i]];
      out[k!] = v ?? "";
    }
  }
  return out;
}

const started = performance.now();
const opts = args(process.argv.slice(2));
const packageDir = opts["package"] ?? process.env["LOOM_AE_PACKAGE"];
const socketPath = opts["socket"];
const prefix = opts["shm-prefix"];
if (!packageDir || !socketPath || !prefix) {
  process.stderr.write("usage: loom-previz-host --package <dir> --socket <path> --shm-prefix <prefix>\n");
  process.exit(2);
}

const stderrLog = (message: string) => process.stderr.write(`[loom-previz-host] ${message}\n`);
const manifest = JSON.parse(readFileSync(join(packageDir, "manifest.json"), "utf8")) as Manifest;
if (manifest.protocol !== PROTOCOL_VERSION) {
  stderrLog(`manifest protocol ${manifest.protocol}, host speaks ${PROTOCOL_VERSION}`);
  process.exit(3);
}

const clients = new Set<Socket>();
let everConnected = false;
function broadcastLog(message: string): void {
  stderrLog(message);
  const line = JSON.stringify({ type: "log", message }) + "\n";
  for (const c of clients) c.write(line);
}

let renderer: PrevizRenderer | undefined;
const ready: Promise<PrevizRenderer> = createPrevizRenderer({
  packageDir,
  manifest,
  sizeCache: Number(process.env["LOOM_HOST_SIZE_CACHE"] ?? 2),
  log: broadcastLog,
}).then(async (r) => {
  renderer = r;
  await r.warm(manifest.defaultSize[0], manifest.defaultSize[1]);
  stderrLog(`ready on ${r.gpu} in ${(performance.now() - started).toFixed(0)} ms`);
  return r;
});
ready.catch((error) => {
  stderrLog(`startup failed: ${error instanceof Error ? error.stack : String(error)}`);
  // Clients get an error per request; keep running so the effect can read the reason.
});

const slots = new SlotMap(prefix);

/** The one GPU queue: requests from every client run one at a time, in arrival order. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

interface RenderMessage {
  type: "render";
  seq: number;
  time: number;
  width: number;
  height: number;
  params?: Record<string, number | boolean>;
  inputs?: Record<string, { slot: number; width: number; height: number }>;
  output: { slot: number };
}

function positiveInt(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > 16384) throw new Error(`${what} must be a positive integer, got ${String(v)}`);
  return v;
}

async function handleRender(msg: RenderMessage): Promise<object> {
  const t0 = performance.now();
  const width = positiveInt(msg.width, "width");
  const height = positiveInt(msg.height, "height");
  if (typeof msg.time !== "number" || !Number.isFinite(msg.time)) throw new Error("time must be a finite number");
  if (!msg.output || typeof msg.output.slot !== "number") throw new Error("output.slot missing");
  const r = renderer ?? (await ready);

  const inputs: Record<string, LayerImage> = {};
  for (const [id, ref] of Object.entries(msg.inputs ?? {})) {
    if (!manifest.inputs.some((i) => i.id === id)) continue;
    const w = positiveInt(ref.width, `inputs.${id}.width`);
    const h = positiveInt(ref.height, `inputs.${id}.height`);
    inputs[id] = { bytes: slots.view(ref.slot, w * h * 4), width: w, height: h };
  }
  const params: Record<string, number> = {};
  for (const [id, v] of Object.entries(msg.params ?? {})) params[id] = typeof v === "boolean" ? (v ? 1 : 0) : Number(v);

  const frame = await r.render({ frame: Math.round(msg.time * manifest.fps), width, height, params, inputs });
  const out = slots.view(msg.output.slot, width * height * 8);
  out.set(frame.bytes);
  return { type: "frame", seq: msg.seq, slot: msg.output.slot, width, height, ms: Math.round((performance.now() - t0) * 10) / 10 };
}

function onConnection(socket: Socket): void {
  clients.add(socket);
  everConnected = true;
  socket.setNoDelay(true);
  const send = (o: object) => { if (!socket.destroyed) socket.write(JSON.stringify(o) + "\n"); };
  void ready.then(
    (r) => send({ type: "hello", protocol: PROTOCOL_VERSION, name: manifest.name, gpu: r.gpu }),
    (e) => send({ type: "hello", protocol: PROTOCOL_VERSION, name: manifest.name, gpu: "unavailable", error: String(e instanceof Error ? e.message : e) }),
  );

  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    let nl: number;
    while ((nl = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (line === "") continue;
      let msg: RenderMessage | { type: string; seq?: number; message?: unknown };
      try { msg = JSON.parse(line); } catch { send({ type: "log", message: `unparseable line: ${line.slice(0, 80)}` }); continue; }
      if (msg.type === "render") {
        const render = msg as RenderMessage;
        serial(() => handleRender(render)).then(send, (e) => send({ type: "error", seq: msg.seq, message: e instanceof Error ? e.message : String(e) }));
      } else if (msg.type === "log") {
        stderrLog(`client: ${String((msg as { message?: unknown }).message)}`);
      } else {
        send({ type: "error", seq: msg.seq, message: `unknown message type "${String(msg.type)}"` });
      }
    }
  });
  const gone = () => {
    if (!clients.delete(socket)) return;
    if (clients.size === 0 && everConnected) shutdown("last client disconnected");
  };
  socket.on("close", gone);
  socket.on("error", (e) => { stderrLog(`client error: ${e.message}`); gone(); });
}

if (existsSync(socketPath)) unlinkSync(socketPath); // a stale socket from a host that died
const server = createServer(onConnection);
server.listen(socketPath, () => stderrLog(`listening on ${socketPath}`));
server.on("error", (e) => { stderrLog(`socket: ${e.message}`); process.exit(4); });

let exiting = false;
function shutdown(why: string): void {
  if (exiting) return;
  exiting = true;
  stderrLog(`exiting: ${why}`);
  server.close();
  try { unlinkSync(socketPath!); } catch { /* already gone */ }
  // Let an in-flight render finish its reply, then release the GPU.
  void queue.finally(() => {
    renderer?.dispose();
    process.exit(0);
  });
}

// Orphan safety: the effect keeps our stdin open; EOF means the parent is gone.
process.stdin.on("end", () => shutdown("stdin closed"));
process.stdin.on("error", () => shutdown("stdin error"));
process.stdin.resume();
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
