import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PICTURE_FILE_ACCEPT, PICTURE_FILE_TAKES, pictureFileKind } from "@domain/media/picture-file.ts";
import { parseFileReference } from "@domain/media/file-reference.ts";
import type { AssetReference } from "@domain/types/graph.ts";
import { retainedFiles, type RetainedFileHandle } from "../files/retained-files.ts";
import { cx } from "../cx.ts";
import { curvePolyline } from "./curve-polyline.ts";
import type { CurvePoint } from "./curve-polyline.ts";
import styles from "./controls.module.css";

/**
 * Curve and asset parameters (T37).
 *
 * Curves display read-only; asset fields bind local media through the retained-file
 * adapter. Both follow the node's parameter manifest.
 */

export interface CurveFieldProps {
  label: string;
  value: readonly CurvePoint[];
}

export function CurveField({ label, value }: CurveFieldProps) {
  const points = curvePolyline(value);
  return (
    <div className={styles.curve}>
      <svg
        className={styles.curvePlot}
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label} curve, ${value.length} point${value.length === 1 ? "" : "s"}`}
      >
        {points === "" ? null : <polyline className={styles.curveLine} points={points} />}
      </svg>
      <span className={styles.meta}>
        {value.length} point{value.length === 1 ? "" : "s"} · read-only in v1
      </span>
    </div>
  );
}

export interface AssetFieldProps {
  label: string;
  value: string | null;
  kind: string;
  /** Absent = read-only display (the pre-T434 stub behaviour), unless `relinkOnly`. */
  onPick?: (url: string, fileName: string) => void;
  /**
   * T1519b: the field authors nothing. A pick stores the chosen file's handle under the
   * value's existing identity (`RetainedFiles.remember` with that reference) and never
   * calls `onPick` — a component instance's internals relink without the definition, or
   * the document, changing.
   */
  relinkOnly?: boolean;
}

/**
 * What the file dialog offers, keyed by the parameter's declared KIND.
 *
 * T1223 — the owner's first symptom lived here: *"If I click Choose File I can only select
 * movie files… I can't even select an image as of now."* `movieFileIn` declared kind
 * `video`, so the dialog offered `video/*` and nothing else, while the node's own
 * description claimed it played stills. `picture` is the "either" kind (§domain/media/
 * picture-file.ts owns the list); `audio`, `video` and `image` are untouched, deliberately
 * — widening one of those would let a JPEG into an audio slot.
 */
const ASSET_ACCEPT: Readonly<Record<string, string>> = {
  audio: "audio/*",
  video: "video/*",
  image: "image/*",
  picture: PICTURE_FILE_ACCEPT,
  // T1353b: Mesh File In reads glTF BINARY only; a .gltf with side files is refused.
  gltf: ".glb,model/gltf-binary",
};

/**
 * What a slot takes, in words, for the tooltip — the one place someone CHOOSING a file
 * reads before they open the dialog. `picture` says it because "no picture bound" alone
 * does not tell you an EXR will be refused (T1223, §V403).
 */
const ASSET_TAKES: Readonly<Record<string, string>> = {
  picture: PICTURE_FILE_TAKES,
};

/** Retained references and legacy object URLs carry the display name in the fragment. */
function assetDisplayName(value: string): string {
  const hash = value.indexOf("#");
  if (hash >= 0 && hash < value.length - 1) return decodeURIComponent(value.slice(hash + 1));
  return value.length > 42 ? `…${value.slice(-40)}` : value;
}

/**
 * T434: a REAL file picker — `movieFileIn` and `audioFileIn` share it.
 *
 * Chromium's picker retains a handle in the local profile. Only its durable identity
 * enters the document; decoding owns fresh session URLs. The existing input picker
 * remains session-only on hosts without File System Access.
 */
export function AssetField({ label, value, kind, onPick, relinkOnly = false }: AssetFieldProps) {
  const input = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const files = retainedFiles();
  useSyncExternalStore(files.subscribe, files.revision, files.revision);
  const parsed = useMemo(() => {
    try { return { reference: parseFileReference(value), error: null }; }
    catch (cause: unknown) {
      return { reference: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, [value]);
  const reference = parsed.reference;
  const displayedName = parsed.error === null && value !== null ? assetDisplayName(value) : "invalid file reference";
  const status = reference === null || value === null ? null : files.snapshot(value);
  const picker = (window as unknown as {
    showOpenFilePicker?: (options: { multiple: boolean; types?: readonly {
      description: string; accept: Record<string, string[]>;
    }[] }) => Promise<RetainedFileHandle[]>;
  }).showOpenFilePicker;
  const pick = (): void => {
    if (onPick === undefined && !relinkOnly) return;
    setError(null);
    if (picker === undefined) {
      if (relinkOnly) {
        setError("This browser has no File System Access, so it cannot relink a retained file.");
        return;
      }
      input.current?.click();
      return;
    }
    const accept: Record<string, string[]> | undefined = kind === "picture"
      ? { "video/*": [".mp4", ".m4v", ".mov", ".webm", ".ogv", ".mkv"],
        "image/*": [".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".bmp"] }
      : kind === "audio" ? { "audio/*": [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"] }
      : kind === "video" ? { "video/*": [".mp4", ".m4v", ".mov", ".webm", ".ogv", ".mkv"] }
      : kind === "image" ? { "image/*": [".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".bmp"] }
      : kind === "gltf" ? { "model/gltf-binary": [".glb"] } : undefined;
    // Invoke the picker synchronously inside the click's user activation.
    void picker.call(window, { multiple: false, ...(accept === undefined ? {} : { types: [{ description: label, accept }] }) })
      .then(async handles => {
        const handle = handles[0];
        if (handle === undefined) return;
        const fileKind = kind === "picture" ? (pictureFileKind(handle.name) === "video" ? "video" : "image") : kind;
        if (!["image", "video", "audio", "gltf", "binary"].includes(fileKind)) throw new Error(`Unsupported file kind: ${kind}`);
        const relink = reference !== null && (relinkOnly || status?.kind === "missing" || status?.kind === "error") ? value! : undefined;
        const stored = await files.remember(handle, fileKind as AssetReference["kind"], relink);
        if (!relinkOnly) onPick?.(stored, handle.name);
      }).catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  };
  const takes = ASSET_TAKES[kind];
  return (
    <div
      className={cx(styles.asset, "nodrag")}
      aria-label={label}
      role="group"
      /*
        T543: the session-only caveat lives HERE ALONE. Inline it fought the filename
        for one row's width and all three parts ellipsized ("no audio bo… [choose…] ·
        this session …") — the same crammed-chrome disease T498 treated. The caveat is
        true and worth saying once; the tooltip says it at every width, and the
        filename gets the row.
      */
      title={
        value === null || value === ""
          ? `No ${kind} bound. ${picker === undefined ? "A picked file lasts for this session only." : "Picked file references are retained in this local profile."}${takes === undefined ? "" : ` ${takes}`}`
          : parsed.error ?? `${displayedName} — ${reference === null ? "this session only" : "retained in this local profile"}`
      }
    >
      <span className={styles.assetName}>
        {value === null || value === "" ? `no ${kind} bound` : displayedName}
      </span>
      {onPick === undefined && !relinkOnly ? (
        <span className={styles.meta}>· read-only</span>
      ) : (
        <>
          <button
            type="button"
            className={styles.assetPick}
            onClick={pick}
          >
            {relinkOnly || status?.kind === "missing" || status?.kind === "error" ? "relink…" : "choose…"}
          </button>
          {status?.kind === "permission" ? <button type="button" className={styles.assetPick}
            onClick={() => { setError(null); void files.allow(value!).catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : String(cause));
            }); }}>
            Allow access
          </button> : null}
          <input
            ref={input}
            type="file"
            accept={ASSET_ACCEPT[kind] ?? undefined}
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file === undefined) return;
              const url = `${URL.createObjectURL(file)}#${encodeURIComponent(file.name)}`;
              onPick?.(url, file.name);
              event.currentTarget.value = "";
            }}
          />
        </>
      )}
      {error === null && parsed.error === null ? null : <span role="alert">{error ?? parsed.error}</span>}
    </div>
  );
}
