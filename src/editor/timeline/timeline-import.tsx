import { useState } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import { nodeNames } from "@domain/graph/names.ts";
import {
  listLtcLabTracks,
  planLtcLabImport,
  sourceFromJson,
  sourceFromTar,
  type LtcLabImportPlan,
  type LtcLabSource,
  type LtcTrackSummary,
} from "@domain/import/ltc-lab/index.ts";
import { importResolumeComposition, type ResolumeImport, type ResolumeLayout } from "@domain/import/resolume/composition.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { fileReader, freeOrigin, NOTHING_TO_IMPORT, ltcLabOperations, resolumeImportOperations, resolumeSummary } from "./import-plans.ts";
import styles from "./timeline-pane.module.css";

/**
 * VN106 — "Import Resolume…" and "Import ltc-lab…" in the timeline's toolbar.
 *
 * Each picks a file, runs the pure importer IN THE PAGE (`src/domain/import/**`), shows what
 * it found and what it leaves behind, and only on confirm applies ONE `graph.applyPatch`:
 *  - Resolume: a `.avc` → a Clip Track per proposed track (`resolumeImportOperations`).
 *  - ltc-lab: a `.ltcshow.tar` (read by ranges, so a show of gigabytes of stems is not
 *    loaded whole) or a `project.json` → pick the track → `planLtcLabImport`; the track's
 *    audio, when the archive carries it, is bound as an object URL the way `attach_asset`
 *    binds it, so it becomes the timeline's reference: the waveform and the beat grid
 *    appear. The project's fps and range follow as a second step (`project.setSettings`),
 *    as the agent tool does.
 */

export interface TimelineImportProps {
  readonly graph: GraphDocument;
  readonly bus: LoomBus;
  readonly invocation: InvocationContext;
  readonly onNotice: (notice: string | null) => void;
}

type Pending =
  | { readonly kind: "resolume"; readonly fileName: string; readonly text: string; readonly layout: ResolumeLayout; readonly imported: ResolumeImport }
  | { readonly kind: "ltc"; readonly fileName: string; readonly open: (trackId: string) => Promise<LtcLabSource | string>; readonly tracks: readonly LtcTrackSummary[]; readonly trackId: string; readonly plan: LtcLabImportPlan | null; readonly error: string | null };

function pickFile(accept: string, onFile: (file: File) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.onchange = () => {
    const picked = input.files?.[0];
    if (picked !== undefined) onFile(picked);
  };
  input.click();
}

export function TimelineImport({ graph, bus, invocation, onNotice }: TimelineImportProps) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = async (operations: GraphPatchOperation[], label: string): Promise<boolean> => {
    const result = await bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), operations, label }, invocation);
    if (result.status !== "applied") {
      onNotice(result.diagnostics[0]?.message ?? `${label} was refused.`);
      return false;
    }
    return true;
  };

  // ── Resolume ──

  const readResolume = (fileName: string, text: string, layout: ResolumeLayout): void => {
    try {
      setPending({ kind: "resolume", fileName, text, layout, imported: importResolumeComposition(text, { layout }) });
      onNotice(null);
    } catch (error) {
      onNotice(`"${fileName}": ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const onResolumeFile = (file: File): void => {
    void file.text().then((text) => readResolume(file.name, text, "sequence"));
  };

  // ── ltc-lab ──

  const plan = (source: LtcLabSource, trackId: string): { plan: LtcLabImportPlan | null; error: string | null } => {
    const planned = planLtcLabImport(source, { trackId, origin: freeOrigin(graph), existingNames: nodeNames(graph).keys() });
    return planned.ok ? { plan: planned.plan, error: null } : { plan: null, error: planned.reason };
  };
  const chooseTrack = async (state: Extract<Pending, { kind: "ltc" }>, trackId: string): Promise<void> => {
    setBusy(true);
    const source = await state.open(trackId);
    setBusy(false);
    if (typeof source === "string") {
      setPending({ ...state, trackId, plan: null, error: source });
      return;
    }
    setPending({ ...state, trackId, ...plan(source, trackId) });
  };
  const onLtcFile = (file: File): void => {
    void (async () => {
      const isJson = file.name.toLowerCase().endsWith(".json");
      const json = isJson ? await file.text() : null;
      const open = async (trackId?: string): Promise<LtcLabSource | string> => {
        const read = json !== null ? sourceFromJson(json) : await sourceFromTar(fileReader(file), trackId);
        return read.ok ? read.source : `"${file.name}": ${read.reason}`;
      };
      setBusy(true);
      const listed = await open();
      setBusy(false);
      if (typeof listed === "string") {
        onNotice(listed);
        return;
      }
      const tracks = listLtcLabTracks(listed);
      if (tracks.length === 0) {
        onNotice(`"${file.name}" holds no tracks.`);
        return;
      }
      onNotice(null);
      const state: Extract<Pending, { kind: "ltc" }> = { kind: "ltc", fileName: file.name, open, tracks, trackId: tracks[0]!.id, plan: null, error: null };
      setPending(state);
      await chooseTrack(state, tracks[0]!.id);
    })();
  };

  const confirm = async (): Promise<void> => {
    if (pending === null) return;
    setBusy(true);
    try {
      if (pending.kind === "resolume") {
        const operations = resolumeImportOperations(graph, pending.imported);
        if (operations.length === 0) {
          onNotice(NOTHING_TO_IMPORT);
        } else if (await apply(operations, `Import ${pending.fileName}`)) {
          const summary = resolumeSummary(pending.imported);
          onNotice(summary.offline > 0 ? `Imported ${summary.regions} regions on ${summary.tracks} tracks; ${summary.offline} are offline (files on disk).` : null);
        }
      } else if (pending.plan !== null) {
        const { plan: planned } = pending;
        const bytes = planned.audio.bytes;
        const url = bytes === null ? null : `${URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: planned.audio.mimeType }))}#${encodeURIComponent(planned.audio.fileName)}`;
        if (await apply(ltcLabOperations(planned, url), `Import ltc-lab ${planned.report.track.title}`)) {
          const settings = await bus.execute("project.setSettings", { settings: planned.settings, label: "ltc-lab project settings" }, invocation);
          const notes = [
            ...(url === null ? [`The show carried no audio for "${planned.audio.fileName}": drop it on the timeline to make it the reference.`] : []),
            ...(settings.status !== "applied" ? [settings.diagnostics[0]?.message ?? "The project's fps and range were not changed."] : []),
          ];
          onNotice(notes.length === 0 ? null : notes.join(" "));
        }
      }
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  return (
    <>
      <button type="button" className={styles.toggle} onClick={() => pickFile(".avc,.xml", onResolumeFile)} title="Import a Resolume composition's clips as clip tracks" data-import-resolume="">
        Resolume…
      </button>
      <button type="button" className={styles.toggle} onClick={() => pickFile(".tar,.json", onLtcFile)} title="Import an ltc-lab track: its audio, lanes and cues" data-import-ltc="">
        ltc-lab…
      </button>
      {pending !== null && (
        <div className={styles.importDialog} role="dialog" aria-label={`Import ${pending.fileName}`} data-import-dialog={pending.kind}>
          {pending.kind === "resolume" ? <ResolumePreview pending={pending} onLayout={(layout) => readResolume(pending.fileName, pending.text, layout)} /> : (
            <LtcPreview pending={pending} busy={busy} onTrack={(trackId) => void chooseTrack(pending, trackId)} />
          )}
          <div className={styles.importActions}>
            <button type="button" className={styles.toggle} onClick={() => setPending(null)}>cancel</button>
            <button
              type="button"
              className={styles.toggle}
              data-on=""
              disabled={busy || (pending.kind === "ltc" && pending.plan === null) || (pending.kind === "resolume" && pending.imported.tracks.length === 0)}
              onClick={() => void confirm()}
              data-import-confirm=""
            >
              import
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function ResolumePreview({ pending, onLayout }: { pending: Extract<Pending, { kind: "resolume" }>; onLayout: (layout: ResolumeLayout) => void }) {
  const summary = resolumeSummary(pending.imported);
  return (
    <>
      <div className={styles.importTitle}>{pending.fileName}</div>
      <label className={styles.option}>
        layout
        <select value={pending.layout} onChange={(event) => onLayout(event.target.value as ResolumeLayout)} aria-label="layout">
          <option value="sequence">sequence (each layer's clips one after another)</option>
          <option value="columns">columns (a column per time slot)</option>
        </select>
      </label>
      {summary.lines.map((line) => <p key={line} className={styles.importLine}>{line}</p>)}
      {summary.notImported.length > 0 && (
        <details className={styles.importLine}>
          <summary>not imported ({pending.imported.notImported.length})</summary>
          <ul>{summary.notImported.map((line) => <li key={line}>{line}</li>)}</ul>
        </details>
      )}
    </>
  );
}

function LtcPreview({ pending, busy, onTrack }: { pending: Extract<Pending, { kind: "ltc" }>; busy: boolean; onTrack: (trackId: string) => void }) {
  const report = pending.plan?.report;
  return (
    <>
      <div className={styles.importTitle}>{pending.fileName}</div>
      <label className={styles.option}>
        track
        <select value={pending.trackId} disabled={busy} onChange={(event) => onTrack(event.target.value)} aria-label="track">
          {pending.tracks.map((track) => <option key={track.id} value={track.id}>{track.title} ({track.startTC})</option>)}
        </select>
      </label>
      {busy && <p className={styles.importLine}>reading…</p>}
      {pending.error !== null && <p className={styles.error}>{pending.error}</p>}
      {report !== undefined && (
        <>
          <p className={styles.importLine}>
            {report.track.title}: {Math.round(report.track.durationSec)} s at {report.track.fps} fps from {report.track.startTC}
            {report.tempo === null ? ", no tempo" : `, ${report.tempo.bpm} BPM`}.
          </p>
          <p className={styles.importLine}>
            Audio: {report.audioNode.name} ({report.audioNode.why}){pending.plan?.audio.bytes === null ? " — not in this file, bind it by hand" : ""}. {report.lanes.length} lanes, {report.cues.length} cues.
          </p>
          {report.notImported.length > 0 && (
            <details className={styles.importLine}>
              <summary>not imported ({report.notImported.reduce((sum, entry) => sum + entry.count, 0)})</summary>
              <ul>{report.notImported.map((entry) => <li key={entry.what}>{entry.count} {entry.what}: {entry.why}</li>)}</ul>
            </details>
          )}
          {report.warnings.map((warning) => <p key={warning} className={styles.notice}>{warning}</p>)}
        </>
      )}
    </>
  );
}
