/** Bounded standard zlib decoding in browsers/workers and Node; no canvas or DOM. */
export async function inflateDepthBytes(bytes: Uint8Array, maximum: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Invalid depth decompression bound.");
  const stream = new DecompressionStream("deflate");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  let failed = false;
  const writing = (async () => { await writer.write(new Uint8Array(bytes)); await writer.close(); })();
  const reading = (async () => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) throw new Error("Depth image decompression exceeds its declared dimensions.");
      chunks.push(value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  })();
  try { return (await Promise.all([reading, writing]))[0]; }
  catch (error) { failed = true; throw error; }
  finally {
    if (failed) await Promise.allSettled([reader.cancel(), writer.abort()]);
    reader.releaseLock(); writer.releaseLock();
  }
}
