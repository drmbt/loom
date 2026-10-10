import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheModelStore } from "./cache-model-store.ts";

afterEach(() => vi.unstubAllGlobals());

describe("verified model cache writes", () => {
  it("streams a large verified artifact through bounded chunks and reopens exact bytes", async () => {
    const original = new Uint8Array(33 * 1024 * 1024 + 3);
    for (let i = 0; i < original.length; i++) original[i] = i % 251;
    let saved: Response | undefined;
    const chunkLengths: number[] = [];
    vi.stubGlobal("caches", { open: async () => ({
      put: async (_key: string, response: Response) => {
        expect(response.headers.get("content-length")).toBe(String(original.byteLength));
        const reader = response.body!.getReader();
        const parts: Uint8Array[] = [];
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          parts.push(next.value); chunkLengths.push(next.value.byteLength);
        }
        saved = new Response(new Blob(parts as BlobPart[]));
      },
      match: async () => saved,
    }) });
    const store = cacheModelStore()!;
    await store.put("large-depth", original.buffer);
    expect(chunkLengths.length).toBeGreaterThan(1);
    expect(Math.max(...chunkLengths)).toBeLessThan(original.byteLength);
    const reopened = new Uint8Array((await store.get("large-depth"))!);
    expect(reopened.byteLength).toBe(original.byteLength);
    // Whole-buffer equality without creating millions of assertion objects.
    expect(Buffer.from(reopened).equals(Buffer.from(original))).toBe(true);
  });

  it("reports a failed durable write rather than treating the model as cached", async () => {
    const failure = new Error("Cache write refused");
    vi.stubGlobal("caches", { open: async () => ({ put: async () => { throw failure; } }) });
    await expect(cacheModelStore()!.put("large-depth", new ArrayBuffer(4))).rejects.toBe(failure);
  });
});
