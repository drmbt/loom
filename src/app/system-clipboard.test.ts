import { describe, expect, it } from "vitest";
import { LOOM_CLIPBOARD_TYPE } from "@domain/commands/loom-clipboard.ts";
import { createBrowserSystemClipboard } from "./system-clipboard.ts";

/**
 * §T1393b — the browser adapter puts BOTH forms on the clipboard in one item, and reads
 * Loom's slot back. A stand-in `navigator.clipboard` and `ClipboardItem` record what the
 * page hands the browser, which is what another window will read.
 */

class FakeItem {
  readonly data: Record<string, Blob>;
  constructor(data: Record<string, Blob>) {
    this.data = data;
  }
  get types(): string[] {
    return Object.keys(this.data);
  }
  getType(type: string): Promise<Blob> {
    return Promise.resolve(this.data[type] as Blob);
  }
}

function host(options: { refuseRead?: boolean } = {}) {
  let items: FakeItem[] = [];
  let plain: string | null = null;
  const clipboard = {
    write: async (next: FakeItem[]) => {
      items = next;
    },
    writeText: async (text: string) => {
      plain = text;
      items = [];
    },
    read: async () => {
      if (options.refuseRead === true) throw new Error("NotAllowedError");
      return items;
    },
    readText: async () => plain ?? "",
  };
  return { host: { navigator: { clipboard }, ClipboardItem: FakeItem } as unknown as typeof globalThis, items: () => items };
}

describe("the browser system clipboard", () => {
  it("writes the text and Loom's payload in one item, and reads the payload back", async () => {
    const fake = host();
    const clipboard = createBrowserSystemClipboard(fake.host);
    clipboard.write("op('lfo1').chan.value", '{"loom-clipboard":1}');
    await Promise.resolve();
    expect(fake.items()[0]?.types).toEqual(["text/plain", LOOM_CLIPBOARD_TYPE]);
    expect(await clipboard.read?.()).toEqual({ text: "op('lfo1').chan.value", loom: '{"loom-clipboard":1}' });
  });

  it("falls back to the text alone when the rich read is refused", async () => {
    const fake = host({ refuseRead: true });
    const clipboard = createBrowserSystemClipboard(fake.host);
    clipboard.write("7");
    await Promise.resolve();
    expect(await clipboard.read?.()).toEqual({ text: "7", loom: null });
  });
});
