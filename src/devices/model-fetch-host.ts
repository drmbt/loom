import { modelById } from "../runtime/models/model-catalogue.ts";
import { MODEL_FETCH_CHUNK_BYTES, modelFetchStreamId } from "./device-protocol.ts";

/**
 * B232 — THE HELPER'S MODEL DOOR: A DOWNLOAD THE PAGE'S CORS RULES FORBID, MADE IN NODE.
 *
 * The owner's report was "I click Download and nothing happens" on Matte's Robust Video
 * Matting. The weights are the author's GitHub release asset, and neither github.com's 302
 * nor `release-assets.githubusercontent.com` sends `Access-Control-Allow-Origin`, so a page
 * can never read them. The owner ruled (2026-09-29) that the local helper fetches them —
 * Node has no CORS — and streams the bytes to the paired page.
 *
 * ## Not an open proxy — the one property this file exists to hold
 *
 * `start` takes a MODEL ID and looks the URL up in the model catalogue this process was
 * built with. An id that is not there is refused by name and nothing is fetched. A paired
 * page can therefore make the helper download the artefacts this build ships descriptors
 * for, and nothing else: no URL crosses the socket, so none can be smuggled in.
 *
 * It also stops at the catalogue's recorded byte count. The page checks length and SHA-256
 * on arrival and would refuse an oversized body anyway, but the helper stops PULLING at the
 * recorded size too, so a host that answers with something larger cannot turn one request
 * into an unbounded transfer through this process.
 *
 * ## One download per model, and it dies with the page
 *
 * A second `start` for a model already downloading is refused (the page's acquisition
 * already folds concurrent asks into one). `cancelAll` is the bridge's page-death path:
 * the device client went away, so nobody is left to receive the bytes.
 */

/** The slice of Node's `fetch` this uses. The real one follows redirects, which RVM needs. */
export type HelperFetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;

/** Where one download reports. Called in order; the bridge turns them into wire messages. */
export interface ModelFetchSink {
  /** The host answered 2xx: the owed reply, naming the stream. Always before any chunk. */
  opened(stream: string, total: number | null): void;
  /** Nothing will be sent, and why. The owed reply instead of `opened`. */
  refused(reason: string): void;
  chunk(stream: string, seq: number, received: number, bytes: Uint8Array): void;
  /** The last call on an opened stream: `reason` absent means complete. */
  end(stream: string, received: number, reason?: string): void;
}

export interface ModelFetchHost {
  start(modelId: unknown, sink: ModelFetchSink): void;
  /** Stops that model's download, before or after its reply. Unknown ids are ignored. */
  cancel(modelId: unknown): void;
  /** Stops every download — the device client that asked for them is gone. */
  cancelAll(): void;
}

export interface ModelFetchHostOptions {
  /** Defaults to Node's global `fetch`. Injected ONLY by tests, which must not reach GitHub. */
  readonly fetch?: HelperFetch;
  /** Bytes per chunk. Defaults to `MODEL_FETCH_CHUNK_BYTES`. */
  readonly chunkBytes?: number;
}

export function createModelFetchHost(options: ModelFetchHostOptions = {}): ModelFetchHost {
  const fetchModel: HelperFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const chunkBytes = options.chunkBytes ?? MODEL_FETCH_CHUNK_BYTES;
  const running = new Map<string, AbortController>();

  const run = async (modelId: string, url: string, limit: number, sink: ModelFetchSink): Promise<void> => {
    const controller = new AbortController();
    running.set(modelId, controller);
    const stream = modelFetchStreamId(modelId);
    let opened = false;
    let received = 0;
    try {
      const response = await fetchModel(url, { signal: controller.signal });
      if (!response.ok) {
        sink.refused(`the model host answered ${String(response.status)} ${response.statusText}`.trim());
        return;
      }
      const header = response.headers.get("content-length");
      const total = header === null ? null : Number(header);
      if (response.body === null) {
        sink.refused("the model host answered with no body");
        return;
      }
      opened = true;
      sink.opened(stream, total !== null && Number.isFinite(total) ? total : null);
      const reader = response.body.getReader();
      let pending: Uint8Array[] = [];
      let pendingBytes = 0;
      let seq = 0;
      const flush = (size: number): void => {
        const joined = new Uint8Array(pendingBytes);
        let offset = 0;
        for (const part of pending) {
          joined.set(part, offset);
          offset += part.byteLength;
        }
        let at = 0;
        while (pendingBytes - at >= size && size > 0) {
          received += size;
          sink.chunk(stream, ++seq, received, joined.subarray(at, at + size));
          at += size;
        }
        pending = at < joined.byteLength ? [joined.subarray(at)] : [];
        pendingBytes = joined.byteLength - at;
      };
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        pending.push(step.value);
        pendingBytes += step.value.byteLength;
        if (limit > 0 && received + pendingBytes > limit) {
          controller.abort();
          sink.end(stream, received, `the model host sent more than the recorded ${String(limit)} bytes`);
          return;
        }
        if (pendingBytes >= chunkBytes) flush(chunkBytes);
      }
      if (pendingBytes > 0) flush(pendingBytes);
      sink.end(stream, received);
    } catch (error) {
      const reason = controller.signal.aborted
        ? "the download was cancelled"
        : error instanceof Error
          ? error.message
          : String(error);
      if (opened) sink.end(stream, received, reason);
      else sink.refused(reason);
    } finally {
      if (running.get(modelId) === controller) running.delete(modelId);
    }
  };

  return {
    start(modelId, sink) {
      const descriptor = typeof modelId === "string" ? modelById(modelId) : undefined;
      if (descriptor === undefined) {
        sink.refused(`${JSON.stringify(modelId)} is not a model this build knows, so the helper will not fetch it.`);
        return;
      }
      if (running.has(descriptor.id)) {
        sink.refused(`${descriptor.label} is already downloading through the helper.`);
        return;
      }
      void run(descriptor.id, descriptor.url, descriptor.bytes, sink);
    },
    cancel(modelId) {
      if (typeof modelId !== "string") return;
      running.get(modelId)?.abort();
    },
    cancelAll() {
      for (const controller of running.values()) controller.abort();
    },
  };
}
