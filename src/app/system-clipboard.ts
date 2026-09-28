import { LOOM_CLIPBOARD_TYPE } from "@domain/commands/loom-clipboard.ts";
import type { SystemClipboard } from "@domain/commands/loom-clipboard.ts";

/**
 * The browser's clipboard as the domain's `SystemClipboard` (§T1393b).
 *
 * WRITE puts plain text AND Loom's payload on the clipboard in one item: the text is what a
 * text field pastes (a reference, a value, or a node copy's JSON), the payload travels
 * under Chrome's web custom format (`web application/x-loom+json`) so another Loom window
 * reads the whole copy. Where `ClipboardItem`/custom formats are unavailable it falls back
 * to the text alone — which for a node copy IS the payload, so node pastes still cross
 * windows.
 *
 * READ tries the payload slot first and the text second. Both are best effort: the first
 * read asks the user for clipboard permission, and a refusal reads as "nothing there", so
 * the paste falls back to this window's own clipboard rather than failing.
 */
export function createBrowserSystemClipboard(host: typeof globalThis = globalThis): SystemClipboard {
  const clipboard = (): Clipboard | undefined => host.navigator?.clipboard;
  const Item = (host as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  return {
    write(text, loom) {
      const target = clipboard();
      if (target === undefined) return;
      const plain = (): void => void target.writeText(text).catch(() => undefined);
      if (loom === undefined || Item === undefined || typeof target.write !== "function") {
        plain();
        return;
      }
      try {
        const item = new Item({
          "text/plain": new Blob([text], { type: "text/plain" }),
          [LOOM_CLIPBOARD_TYPE]: new Blob([loom], { type: LOOM_CLIPBOARD_TYPE.replace(/^web /, "") }),
        });
        void target.write([item]).catch(plain);
      } catch {
        plain();
      }
    },
    async read() {
      const target = clipboard();
      if (target === undefined) return { text: null, loom: null };
      if (typeof target.read === "function") {
        try {
          const items = await target.read();
          let text: string | null = null;
          let loom: string | null = null;
          for (const item of items) {
            if (loom === null && item.types.includes(LOOM_CLIPBOARD_TYPE)) loom = await (await item.getType(LOOM_CLIPBOARD_TYPE)).text();
            if (text === null && item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text();
          }
          return { text, loom };
        } catch {
          // A custom-format read can be refused where text is not; try the text alone.
        }
      }
      try {
        return { text: await target.readText(), loom: null };
      } catch {
        return { text: null, loom: null };
      }
    },
  };
}
