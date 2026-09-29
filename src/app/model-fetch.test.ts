import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDeviceHelper } from "@/mcp/serve.ts";
import { createDeviceDoors } from "@devices/doors.ts";
import { createDeviceClient, type DeviceClient } from "@devices/device-client.ts";
import { DEVICE_HELPER_COMMAND, MODEL_NEEDS_HELPER } from "@devices/helper.ts";
import { createModelFetchHost } from "@devices/model-fetch-host.ts";
import type { OscBridgeState } from "@domain/osc/osc-status.ts";
import {
  createModelAcquisition,
  type AcquisitionState,
  type ModelDescriptor,
  type ModelStore,
} from "@runtime/models/model-acquisition.ts";
import { MATTE_RVM } from "@runtime/models/model-catalogue.ts";
import { createModelFetch } from "./model-fetch.ts";
import { buildNotices } from "./use-model-inference.ts";

/**
 * B232 — A MODEL THE BROWSER CANNOT FETCH, FETCHED THROUGH THE LOCAL HELPER, END TO END.
 *
 * The owner clicked Download on Robust Video Matting and nothing happened: GitHub sends no
 * CORS header, so the page's fetch rejected before a byte arrived. The owner ruled the
 * helper fetches it. Every test here runs the REAL stack on both sides of the socket —
 * `createDeviceHelper` + `createDeviceDoors` (the product composition `pnpm helper
 * --devices-only` runs), the real loopback WebSocket, the real `createDeviceClient`, the real
 * `createModelFetch` and the real `createModelAcquisition` — and replaces exactly two things:
 * the page's own `fetch` (which the tests make fail the way CORS does) and where the
 * helper's Node `fetch` goes (a local HTTP server instead of GitHub, reached with the REAL
 * Node fetch, so an abort really closes a socket).
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function until(predicate: () => boolean, what: string, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function memoryStore(): ModelStore & { readonly held: Map<string, ArrayBuffer> } {
  const held = new Map<string, ArrayBuffer>();
  return {
    held,
    async get(id) {
      return held.get(id);
    },
    async put(id, bytes) {
      held.set(id, bytes);
    },
    async delete(id) {
      held.delete(id);
    },
    async list() {
      return [...held.entries()].map(([id, bytes]) => ({ id, bytes: bytes.byteLength }));
    },
  };
}

/** 600 KB of patterned bytes: three 256 KB chunks' worth, the last one short. */
const PAYLOAD = Uint8Array.from({ length: 600 * 1024 }, (_, index) => (index * 31 + 7) & 0xff);
const PAYLOAD_SHA = createHash("sha256").update(PAYLOAD).digest("hex");

/** RVM as the page knows it, but with the test payload's size and hash. Same id, same URL. */
const RVM_SMALL: ModelDescriptor = { ...MATTE_RVM, bytes: PAYLOAD.byteLength, sha256: PAYLOAD_SHA };

/** Where the helper's Node fetch actually lands. `stallAfter` holds the body open to test cancel. */
interface Upstream {
  url: string;
  /** Every request the server received. */
  readonly requests: string[];
  /** Set when a request's connection closed before its response finished. */
  closedEarly: boolean;
  body: Uint8Array;
  stallAfter: number | null;
}

async function upstream(): Promise<Upstream> {
  const state: Upstream = { url: "", requests: [], closedEarly: false, body: PAYLOAD, stallAfter: null };
  const server: Server = createServer((request, response) => {
    state.requests.push(request.url ?? "");
    response.writeHead(200, { "content-length": String(state.body.byteLength) });
    response.on("close", () => {
      if (!response.writableFinished) state.closedEarly = true;
    });
    if (state.stallAfter === null) {
      response.end(Buffer.from(state.body));
      return;
    }
    // Send a head start and then hold the connection open: only an abort ends it.
    response.write(Buffer.from(state.body.subarray(0, state.stallAfter)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  state.url = `http://127.0.0.1:${String(address.port)}/rvm.onnx`;
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return state;
}

interface Harness {
  readonly server: Upstream;
  /** Every URL the helper's fetch was asked for — the catalogue's, never the page's. */
  readonly helperAsked: string[];
  readonly client: DeviceClient;
}

/** The helper, its doors and a paired device client — `serveDevices()` minus the OS. */
async function pairedHelper(): Promise<Harness> {
  const server = await upstream();
  const helperAsked: string[] = [];
  const handoffDir = mkdtempSync(join(tmpdir(), "loom-model-fetch-"));
  cleanups.push(() => {
    rmSync(handoffDir, { recursive: true, force: true });
  });
  const helper = createDeviceHelper({
    port: 0,
    handoffDir,
    doors: createDeviceDoors({
      // The REAL model door, with its outbound fetch pointed at the local server — through
      // the real Node fetch, so a cancel is a closed socket the server can see.
      models: createModelFetchHost({
        fetch: (url, init) => {
          helperAsked.push(url);
          return globalThis.fetch(server.url, init);
        },
      }),
    }),
  });
  cleanups.push(() => {
    helper.dispose();
  });
  await until(() => helper.status().port != null, "the helper to bind a port");
  const states: OscBridgeState[] = [];
  const client = createDeviceClient({
    port: helper.status().port as number,
    client: "vitest-model-fetch",
    memory: { read: () => null, write: () => undefined, forget: () => undefined },
    autoConnect: false,
    onState: (state) => states.push(state),
    onReadings: () => undefined,
  });
  cleanups.push(() => {
    client.dispose();
  });
  client.connect(helper.pairingCode);
  await until(() => states.at(-1)?.kind === "attached", "the device role to attach");
  return { server, helperAsked, client };
}

/** The browser's fetch as a CORS-refused host makes it look: a network-level TypeError. */
function corsRefusingBrowser(): { calls: string[]; fetch: (url: string) => Promise<Response> } {
  const calls: string[] = [];
  return {
    calls,
    fetch: (url) => {
      calls.push(url);
      return Promise.reject(new TypeError("Failed to fetch"));
    },
  };
}

function acquisitionOver(
  client: DeviceClient | null,
  browser: (url: string) => Promise<Response>,
): { acquisition: ReturnType<typeof createModelAcquisition>; store: ReturnType<typeof memoryStore>; states: AcquisitionState[] } {
  const store = memoryStore();
  const states: AcquisitionState[] = [];
  const acquisition = createModelAcquisition({
    store,
    fetch: createModelFetch({ browser, helper: () => client }),
    onStateChange: (_id, state) => states.push(state),
  });
  return { acquisition, store, states };
}

describe("B232 — a model whose host refuses browsers arrives through the helper", () => {
  it("falls back on the browser's TypeError, reports real progress, verifies and caches the bytes", async () => {
    const harness = await pairedHelper();
    const browser = corsRefusingBrowser();
    const { acquisition, store, states } = acquisitionOver(harness.client, browser.fetch);
    // Unflagged, so the FALLBACK is what is exercised: the browser is tried and refused first.
    const descriptor: ModelDescriptor = { ...RVM_SMALL, viaHelper: false };

    const bytes = await acquisition.acquire(descriptor);

    expect(browser.calls).toEqual([MATTE_RVM.url]);
    // The helper fetched the CATALOGUE's URL for that id — the page never sent one.
    expect(harness.helperAsked).toEqual([MATTE_RVM.url]);
    expect(acquisition.stateOf(descriptor.id)).toEqual({ kind: "ready" });
    expect(new Uint8Array(bytes as ArrayBuffer)).toEqual(PAYLOAD);
    expect(new Uint8Array(store.held.get(descriptor.id) as ArrayBuffer)).toEqual(PAYLOAD);
    // Progress is the helper's chunks as they landed: 256 KB, 512 KB, then the rest — the
    // total from the host's content-length, carried through the reply.
    const progress = states.flatMap((state) => (state.kind === "downloading" && state.received > 0 ? [state] : []));
    expect(progress.map((state) => state.received)).toEqual([256 * 1024, 512 * 1024, PAYLOAD.byteLength]);
    expect(new Set(progress.map((state) => state.total))).toEqual(new Set([PAYLOAD.byteLength]));
  });

  it("goes straight to the helper for a descriptor marked viaHelper — no doomed browser request", async () => {
    const harness = await pairedHelper();
    const browser = corsRefusingBrowser();
    const { acquisition } = acquisitionOver(harness.client, browser.fetch);

    await acquisition.acquire(RVM_SMALL);

    expect(MATTE_RVM.viaHelper).toBe(true);
    expect(browser.calls).toEqual([]);
    expect(acquisition.stateOf(RVM_SMALL.id)).toEqual({ kind: "ready" });
  });

  it("does NOT fall back on an HTTP status: the host answered, and that answer is the reason", async () => {
    const harness = await pairedHelper();
    const { acquisition } = acquisitionOver(harness.client, async () => new Response(null, { status: 404, statusText: "Not Found" }));

    await acquisition.acquire({ ...RVM_SMALL, viaHelper: false });

    expect(acquisition.stateOf(RVM_SMALL.id)).toEqual({ kind: "failed", reason: "the server answered 404 Not Found" });
    expect(harness.helperAsked).toEqual([]);
  });
});

describe("B232 — the helper is not an open proxy, and is trusted with nothing", () => {
  it("refuses a model id the catalogue does not hold, by name, and fetches nothing", async () => {
    const harness = await pairedHelper();
    const { acquisition, store } = acquisitionOver(harness.client, corsRefusingBrowser().fetch);
    // A page-side descriptor pointing anywhere it likes: the URL never crosses the socket,
    // and the id is not the helper's to resolve.
    const stranger: ModelDescriptor = { ...RVM_SMALL, id: "not-a-model", url: harness.server.url, viaHelper: true };

    await acquisition.acquire(stranger);

    const state = acquisition.stateOf("not-a-model");
    expect(state.kind).toBe("failed");
    expect(state.kind === "failed" ? state.reason : "").toContain(`"not-a-model" is not a model this build knows`);
    expect(harness.helperAsked).toEqual([]);
    expect(harness.server.requests).toEqual([]);
    expect(store.held.size).toBe(0);
  });

  it("fails the page's SHA-256 check on a tampered byte from the helper, and caches nothing", async () => {
    const harness = await pairedHelper();
    const tampered = PAYLOAD.slice();
    tampered[123_456] = (tampered[123_456] ?? 0) ^ 0x01;
    harness.server.body = tampered;
    const { acquisition, store } = acquisitionOver(harness.client, corsRefusingBrowser().fetch);

    await acquisition.acquire(RVM_SMALL);

    const state = acquisition.stateOf(RVM_SMALL.id);
    expect(state.kind).toBe("failed");
    expect(state.kind === "failed" ? state.reason : "").toContain(`not the recorded ${PAYLOAD_SHA}`);
    expect(store.held.size).toBe(0);
  });

  it("a cancel mid-stream stops the helper's own download — the upstream socket closes", async () => {
    const harness = await pairedHelper();
    harness.server.stallAfter = 300 * 1024;
    const { acquisition, store } = acquisitionOver(harness.client, corsRefusingBrowser().fetch);

    const pending = acquisition.acquire(RVM_SMALL);
    await until(() => {
      const state = acquisition.stateOf(RVM_SMALL.id);
      return state.kind === "downloading" && state.received > 0;
    }, "the first chunk to arrive through the helper");
    acquisition.cancel(RVM_SMALL.id);

    expect(await pending).toBeUndefined();
    expect(acquisition.stateOf(RVM_SMALL.id)).toEqual({ kind: "absent" });
    expect(store.held.size).toBe(0);
    await until(() => harness.server.closedEarly, "the helper to close its upstream connection");

    // And the helper let go of it: the same model can be asked for again and completes.
    harness.server.stallAfter = null;
    await acquisition.acquire(RVM_SMALL);
    expect(acquisition.stateOf(RVM_SMALL.id)).toEqual({ kind: "ready" });
  });
});

describe("B232 — with no helper paired, the reason names the helper and its command", () => {
  it("fails with MODEL_NEEDS_HELPER when nothing is paired", async () => {
    const { acquisition } = acquisitionOver(null, corsRefusingBrowser().fetch);

    await acquisition.acquire(RVM_SMALL);

    expect(acquisition.stateOf(RVM_SMALL.id)).toEqual({ kind: "failed", reason: MODEL_NEEDS_HELPER });
    expect(MODEL_NEEDS_HELPER).toContain(DEVICE_HELPER_COMMAND);
  });

  it("the device client says the same when it exists but is not attached", async () => {
    const client = createDeviceClient({
      port: 1,
      memory: { read: () => null, write: () => undefined, forget: () => undefined },
      autoConnect: false,
      onState: () => undefined,
      onReadings: () => undefined,
    });
    cleanups.push(() => {
      client.dispose();
    });
    const { acquisition } = acquisitionOver(client, corsRefusingBrowser().fetch);

    await acquisition.acquire(RVM_SMALL);

    expect(acquisition.stateOf(RVM_SMALL.id)).toEqual({ kind: "failed", reason: MODEL_NEEDS_HELPER });
  });

  it("the banner for an absent helper-only model says it needs the helper, and stops saying so once paired", () => {
    const target = {
      nodeId: "cut1",
      channel: "cut1",
      kind: { nodeType: "matte", label: "Matte", neutralPicture: "zero everywhere", coverage: () => 0 },
      descriptor: MATTE_RVM,
      size: [8, 8],
    };
    const acquisition = { acquire: () => undefined, cancel: () => undefined };
    const states = { [MATTE_RVM.id]: { kind: "absent" } as const };

    const [unpaired] = buildNotices([target] as never, states, acquisition, false);
    expect(unpaired?.message).toBe("Matte's Robust Video Matting downloads only through the local helper.");
    expect(unpaired?.detail).toBe(MODEL_NEEDS_HELPER);

    const [paired] = buildNotices([target] as never, states, acquisition, true);
    expect(paired?.message).toBe("Matte has no model — showing zero everywhere.");
  });
});
