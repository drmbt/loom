import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { externalFiles, type ExternalFile } from "@domain/components/component-file.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { createIndexedDbFileHandleStore } from "@ui/files/retained-files.ts";
import type { AppRuntime } from "./app-runtime.ts";
import type { Notice } from "./notices.tsx";

/**
 * T1519b — A FILE THAT ARRIVES AND DOES NOT OPEN HERE IS SAID AT THE MOMENT IT ARRIVES.
 *
 * Owner ruling 2026-10-04: a component references its media on the file system and warns
 * when the file is not there. The reference is the retained `loom-file:` the picker writes
 * (`docs/retained-media-files-2026-10-03.md`); its handle lives in ONE browser profile, so a
 * project opened, a component file imported or a component pasted from another profile,
 * machine or origin carries references nothing here can open. A `blob:` URL in a file
 * written before export refused them (`9999ae85`) is the same case, permanently.
 *
 * Door-agnostic on purpose: the arrivals are opening a project (a new runtime — every
 * reference in it arrives), and an import or a paste (references this document had not
 * held before). One rule covers the canvas drop, the palette, the menu and the agent
 * alike — "a reference this document had not held until now" — instead of one hook per door.
 * A reference is checked ONCE per document, so undo, a duplicate, or a dismissed warning
 * never repeats it. The node diagnostic (`use-file-references.ts`) stays the record; this
 * is the notice, in the strip where the app says what arrives without anybody asking.
 *
 * The domain only finds the references (`externalFiles`); whether one opens is a lookup in
 * this browser — IndexedDB for a handle, the page for an object URL — so it happens here.
 */

export interface ArrivingFilesOptions {
  /** Whether this profile holds a retained handle under `id`. */
  readonly hasHandle?: (id: string) => Promise<boolean>;
  /** Whether an object URL still opens in this page (one made by this session does). */
  readonly objectUrlOpens?: (url: string) => Promise<boolean>;
}

type ArrivingRuntime = Pick<AppRuntime, "bus" | "components" | "registry" | "documentIdentity">;

const handles = createIndexedDbFileHandleStore();
const defaultHasHandle = (id: string): Promise<boolean> =>
  // Storage that cannot be read holds no handle this document can use.
  handles.get(id).then((handle) => handle !== undefined, () => false);
const defaultObjectUrlOpens = (url: string): Promise<boolean> =>
  fetch(url.split("#")[0] as string).then((response) => {
    void response.body?.cancel();
    return true;
  }, () => false);

/** One graph's external files, cached by graph identity: definitions are immutable, and the root graph is scanned once per edit. */
const scans = new WeakMap<GraphDocument, ExternalFile[]>();

function placeOf(file: ExternalFile): string {
  const where = `"${file.fileName}" on "${file.nodeName}"${file.componentName === null ? "" : ` in component "${file.componentName}"`}`;
  return file.handleId === null
    ? `${where} was picked for a browser session that has ended — choose the file again`
    : `${where} is not linked in this browser — select the node, or its component instance, and choose relink in the Inspector`;
}

export function useArrivingFiles(runtime: ArrivingRuntime, options: ArrivingFilesOptions = {}): Notice | null {
  const hasHandle = options.hasHandle ?? defaultHasHandle;
  const objectUrlOpens = options.objectUrlOpens ?? defaultObjectUrlOpens;
  const [unopened, setUnopened] = useState<{ readonly identity: string; readonly files: readonly ExternalFile[] }>(
    { identity: runtime.documentIdentity, files: [] },
  );
  const seen = useRef<{ identity: string; uris: Set<string> }>({ identity: runtime.documentIdentity, uris: new Set() });

  useEffect(() => {
    const { bus, components, registry, documentIdentity } = runtime;
    // A new runtime is an opened document: everything in it arrives now.
    if (seen.current.identity !== documentIdentity) seen.current = { identity: documentIdentity, uris: new Set() };
    const uris = seen.current.uris;
    let live = true;
    const scan = (): void => {
      const graphs: { graph: GraphDocument; componentName: string | null }[] = [
        { graph: bus.store.getGraph(), componentName: null },
        ...components.all().map((each) => ({ graph: each.graph, componentName: each.name })),
      ];
      const arrived = new Map<string, ExternalFile[]>();
      for (const { graph, componentName } of graphs) {
        let found = scans.get(graph);
        if (found === undefined) {
          found = externalFiles(graph, componentName, registry);
          scans.set(graph, found);
        }
        for (const file of found) {
          if (uris.has(file.uri) && !arrived.has(file.uri)) continue;
          uris.add(file.uri);
          arrived.set(file.uri, [...(arrived.get(file.uri) ?? []), file]);
        }
      }
      if (arrived.size === 0) return;
      void Promise.all([...arrived.values()].map(async (places) => {
        const first = places[0] as ExternalFile;
        const opens = first.handleId === null ? await objectUrlOpens(first.uri) : await hasHandle(first.handleId);
        return opens ? [] : places;
      })).then((results) => {
        const missing = results.flat();
        if (!live || missing.length === 0) return;
        setUnopened((previous) => ({
          identity: documentIdentity,
          files: previous.identity === documentIdentity ? [...previous.files, ...missing] : missing,
        }));
      });
    };
    scan();
    const unsubscribeGraph = bus.store.subscribe(scan);
    const unsubscribeComponents = components.subscribe(scan);
    return () => {
      live = false;
      unsubscribeGraph();
      unsubscribeComponents();
    };
  }, [hasHandle, objectUrlOpens, runtime]);

  const dismiss = useCallback(() => setUnopened((previous) => ({ identity: previous.identity, files: [] })), []);

  return useMemo(() => {
    if (unopened.identity !== runtime.documentIdentity || unopened.files.length === 0) return null;
    const count = unopened.files.length;
    return {
      id: "unopened-files",
      tone: "warn",
      message: `${count === 1 ? "A file" : `${count} files`} this document reads cannot be opened in this browser.`,
      detail: `${unopened.files.map(placeOf).join("; ")}.`,
      actions: [{ label: "Dismiss", onSelect: dismiss }],
    };
  }, [dismiss, runtime.documentIdentity, unopened]);
}
