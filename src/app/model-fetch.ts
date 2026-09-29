import type { DeviceClient } from "@devices/device-client.ts";
import { MODEL_NEEDS_HELPER } from "@devices/helper.ts";
import type { ModelFetch } from "@runtime/models/model-acquisition.ts";

/**
 * B232 — HOW A MODEL'S BYTES ARE FETCHED: THE BROWSER FIRST, THE LOCAL HELPER WHEN IT CANNOT.
 *
 * The owner clicked Download on Matte's Robust Video Matting and nothing happened. Its
 * weights are a GitHub release asset, and GitHub sends no `Access-Control-Allow-Origin`,
 * so the page's `fetch` rejects with `TypeError: Failed to fetch` before a byte arrives.
 * The owner ruled that the local helper fetches such models (Node has no CORS) and streams
 * them back over the device socket.
 *
 * So this is the acquisition's `fetch`, and it decides WHICH door:
 *
 *  - a descriptor marked `viaHelper` goes to the helper straight away (the reason is on
 *    the field); with no helper paired it fails with `MODEL_NEEDS_HELPER`, which names the
 *    command;
 *  - anything else tries the browser, and falls back to the helper ONLY on a network-level
 *    rejection — a `TypeError`, which is what CORS, DNS and offline all look like to a
 *    page. An HTTP status is an answer from the host and is reported as one; an abort is
 *    the user's choice. Neither is a reason to ask a second door.
 *
 * Whatever door it came through, the `Response` goes back to `model-acquisition.ts`, which
 * checks length and SHA-256 the same way on both — the helper is trusted with nothing.
 */
export interface ModelFetchDoors {
  /** The page's own fetch. */
  readonly browser: (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;
  /** The PAIRED helper's client, or null. A function: the client is rebuilt on reconnect. */
  readonly helper: () => Pick<DeviceClient, "fetchModel"> | null;
}

export function createModelFetch(doors: ModelFetchDoors): ModelFetch {
  const viaHelper = (modelId: string, signal: AbortSignal): Promise<Response> => {
    const client = doors.helper();
    if (client === null) return Promise.reject(new Error(MODEL_NEEDS_HELPER));
    return client.fetchModel(modelId, signal);
  };
  return async (url, init) => {
    if (init.descriptor.viaHelper === true) return viaHelper(init.descriptor.id, init.signal);
    try {
      return await doors.browser(url, { signal: init.signal });
    } catch (error) {
      if (!(error instanceof TypeError) || init.signal.aborted) throw error;
      // No helper paired: the browser's own words stand. A plain network failure here is
      // as likely to be "offline" as "no CORS", and only the flagged rows know which.
      if (doors.helper() === null) throw error;
      return viaHelper(init.descriptor.id, init.signal);
    }
  };
}
