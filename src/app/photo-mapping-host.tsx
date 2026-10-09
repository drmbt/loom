import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import { commandHolder } from "@domain/commands/command-holder.ts";
import { registerPhotoMappingCommands } from "@domain/commands/photo-mapping-commands.ts";
import { nodeIdsInput } from "@domain/commands/input-schema.ts";
import { storedStaticValue } from "@domain/parameters/slots.ts";
import { selectCreatedNodes } from "@editor/selection/select-created.ts";
import { parseFileReference } from "@domain/media/file-reference.ts";
import { PHOTO_DEPTH_INPUT_SIDES, PHOTO_MASK_INPUT_SIDES, supportsPhotoMaskSize } from "@domain/media/preparation-sizes.ts";
import { PHOTO_MASK, PHOTO_FACADE } from "@runtime/models/model-catalogue.ts";
import { FACADE_MASK_DEFAULTS, facadeMaskSettings, type FacadeMaskSettings } from "@runtime/media/facade-mask.ts";
import { linearToSrgb, srgbToLinear } from "@runtime/export/pixel-format.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { AssetField } from "@ui/controls/curve-field.tsx";
import { Button } from "@ui/primitives/button.tsx";
import { BooleanField } from "@ui/controls/boolean-field.tsx";
import { navigationHolderFor } from "./component-navigation.ts";
import { DialogRoot, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "@ui/primitives/dialog.tsx";
import { retainedFiles } from "@ui/files/retained-files.ts";
import { decodeFloatMap, type FloatMap } from "@runtime/media/float-map.ts";
import { makePreparedMap, beginMaskStroke, preparedMetadata, rasterizeFloatMap } from "@runtime/media/prepared-map.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { createPhotoPreparer, decodePreparationPhoto, savePreparedMap, type PreparationPhoto, type PreparationProgress } from "./photo-preparation.ts";
import { floatMapPhotoUrlFor } from "./use-float-map-sources.ts";
import { PHOTO_MAPPING_SHADER } from "./photo-mapping-effects.ts";
import { PhotoMappingPreview } from "./photo-mapping-preview.tsx";
import { hasMatchingPhotoAspect, previewPhotoPlacement, type PreviewImageFit } from "./photo-preview-framing.ts";
import { MEDIA_IMAGE_FIT_PARAMETERS } from "@nodes/definitions/media.ts";
import styles from "./photo-mapping-host.module.css";

declare module "@domain/types/commands.ts" {
  interface CommandMap {
    "photoMapping.prepare": { input: { nodeIds?: readonly string[] }; output: { opened: boolean } };
  }
}

interface Recipe {
  readonly photo: string;
  readonly depth: string;
  readonly mask: string;
  readonly previewPhoto: string;
  readonly previewFit: PreviewImageFit;
  readonly previewPhotoId?: string;
  readonly depthId?: string;
  readonly maskId?: string;
  readonly photoId?: string;
  readonly inputSide: number;
  readonly mode?: number;
  readonly previz?: boolean;
  readonly useMask?: boolean;
  readonly previewOpacity?: number;
}

const reloadRecipeSchema = z.object({ version: z.literal(1), photo: z.string().min(1), depth: z.string().min(1), mask: z.string(),
  previewPhoto: z.string(), previewFit: z.enum(["fit", "fill", "stretch"]), inputSide: z.number().int().positive(),
  mode: z.number().int().min(0).max(4), previz: z.boolean(), useMask: z.boolean().default(true),
  previewOpacity: z.number().min(0).max(1).default(0.35) }).strict()
  .refine(recipe => recipe.useMask === false || recipe.mask.length > 0, "A selected surface mask requires a saved map.");
const reloadRecipeKey = (runtime: AppRuntime) => `loom.photoMapping.reload.${runtime.project.projectId}`;

function value(graph: GraphDocument, nodeId: string | undefined, key: string): string {
  const read = nodeId === undefined ? undefined : storedStaticValue(graph.nodes[nodeId]?.parameters[key]);
  return typeof read === "string" ? read : "";
}

function recipeFor(graph: GraphDocument, nodeId?: string): Recipe {
  if (nodeId === undefined) return { photo: "", depth: "", mask: "", previewPhoto: "", previewFit: "stretch", inputSide: 518 };
  const node = graph.nodes[nodeId];
  if (node?.type !== "floatMapIn") throw new Error("Select a prepared Float Map In to rerun its preparation.");
  const group = Object.values(graph.groups).find(candidate => candidate.members.includes(nodeId));
  const members = group?.members ?? [nodeId];
  const depthId = members.find(id => graph.nodes[id]?.type === "floatMapIn" && value(graph, id, "interpretation") === "depth");
  const maskId = members.find(id => graph.nodes[id]?.type === "floatMapIn" && value(graph, id, "interpretation") === "mask");
  const edge = Object.values(graph.edges).find(candidate => candidate.target.nodeId === nodeId && candidate.target.portId === "picture");
  const previewId = members.find(id => graph.nodes[id]?.type === "screen");
  const referenceId = Object.values(graph.edges).find(candidate => candidate.target.nodeId === previewId
    && (candidate.target.portId === "in1" || candidate.target.portId === "in2")
    && graph.nodes[candidate.source.nodeId]?.type === "level")?.source.nodeId;
  const previewSource = Object.values(graph.edges).find(candidate => candidate.target.nodeId === referenceId && candidate.target.portId === "input")?.source.nodeId;
  const previewPhotoId = previewSource !== edge?.source.nodeId && graph.nodes[previewSource ?? ""]?.type === "movieFileIn" ? previewSource : undefined;
  const previewFit = value(graph, previewPhotoId, "imageFit") || MEDIA_IMAGE_FIT_PARAMETERS.imageFit.default;
  if (previewFit !== "fit" && previewFit !== "fill" && previewFit !== "stretch") throw new Error("Preview photo has an invalid image fit.");
  return { photo: floatMapPhotoUrlFor(graph, nodeId), depth: value(graph, depthId, "file"), mask: value(graph, maskId, "file"),
    previewPhoto: value(graph, previewPhotoId, "file"), ...(previewPhotoId === undefined ? {} : { previewPhotoId }),
    previewFit,
    ...(depthId === undefined ? {} : { depthId }), ...(maskId === undefined ? {} : { maskId }),
    ...(edge === undefined ? {} : { photoId: edge.source.nodeId }),
    inputSide: Number(value(graph, depthId, "inputSide") || "518") };
}

function useFileUrls(references: readonly string[]): readonly string[] {
  const files = useMemo(() => retainedFiles(), []);
  useSyncExternalStore(files.subscribe, files.revision, files.revision);
  const signature = JSON.stringify(references);
  useEffect(() => {
    const picked = JSON.parse(signature) as string[];
    const leases = [...new Set(picked.filter(reference => parseFileReference(reference) !== null))].map(reference => files.acquire(reference));
    return () => leases.forEach(lease => lease.release());
  }, [files, signature]);
  return references.map(reference => reference === "" ? "" : parseFileReference(reference) === null ? reference
    : files.snapshot(reference).kind === "ready" ? (files.snapshot(reference) as { url: string }).url : "");
}

function drawMaskEditor(target: HTMLCanvasElement, photo: PreparationPhoto, mask: FloatMap | null): void {
  const width = mask?.width ?? photo.bitmap.width;
  const height = mask?.height ?? photo.bitmap.height;
  const scale = Math.min(1, 768 / width, 768 / height);
  target.width = Math.max(1, Math.round(width * scale));
  target.height = Math.max(1, Math.round(height * scale));
  const context = target.getContext("2d", { willReadFrequently: true });
  if (context === null) return;
  context.drawImage(photo.bitmap, 0, 0, target.width, target.height);
  if (mask !== null) {
    const image = context.getImageData(0, 0, target.width, target.height);
    // Display sampling only. Painting and saving keep the full native float32 map.
    for (let y = 0; y < target.height; y++) for (let x = 0; x < target.width; x++) {
      const i = y * target.width + x;
      const mx = Math.min(mask.width - 1, Math.floor((x + 0.5) / target.width * mask.width));
      const my = Math.min(mask.height - 1, Math.floor((y + 0.5) / target.height * mask.height));
      const excluded = (1 - mask.values[my * mask.width + mx]!) * 0.6;
      image.data[4 * i] = image.data[4 * i]! * (1 - excluded) + 230 * excluded;
      image.data[4 * i + 1] = image.data[4 * i + 1]! * (1 - excluded) + 65 * excluded;
      image.data[4 * i + 2] = image.data[4 * i + 2]! * (1 - excluded) + 70 * excluded;
    }
    context.putImageData(image, 0, 0);
  }
}

interface MapJob {
  readonly kind: "depth" | "mask";
  readonly progress: PreparationProgress;
}

function MapProgress({ job }: { job: MapJob }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = performance.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((performance.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const { phase, fraction, message } = job.progress;
  const step = phase === "saving" ? 2 : phase === "processing" || phase === "finishing" ? 1 : 0;
  const percent = fraction === undefined ? undefined : Math.round(fraction * 100);
  const title = `${phase === "saving" ? "Saving" : phase === "downloading" ? "Downloading model for" : "Processing"} ${job.kind}`;
  return <div className={styles.processingOverlay}>
    <div className={styles.processingPanel}>
      <div className={styles.processingHeading}><span className={styles.spinner} aria-hidden="true" />
        <strong>{title}</strong><span className={styles.processingValue}>{percent === undefined ? `${elapsed}s` : `${percent}%`}</span>
      </div>
      <progress className={styles.progressTrack} aria-label={`${job.kind === "depth" ? "Depth" : "Mask"} preparation progress`}
        max={100} {...(percent === undefined ? {} : { value: percent })} />
      <div className={styles.processingSteps} aria-hidden="true">{["Prepare", "Process", "Save"].map((label, index) =>
        <span key={label} data-state={index < step ? "complete" : index === step ? "active" : "pending"}>{index < step ? "✓ " : ""}{label}</span>)}</div>
      <p className={styles.processingMessage}>{message}</p>
    </div>
  </div>;
}

function PhotoMappingEditor({ runtime, initial, close }: { runtime: AppRuntime; initial: Recipe; close: () => void }) {
  const [photoRef, setPhotoRef] = useState(initial.photo);
  const [depthRef, setDepthRef] = useState(initial.depth);
  const [maskRef, setMaskRef] = useState(initial.mask);
  const [previewPhotoRef, setPreviewPhotoRef] = useState(initial.previewPhoto);
  const [previewPhoto, setPreviewPhoto] = useState<PreparationPhoto | null>(null);
  const [previewFit, setPreviewFit] = useState<PreviewImageFit>(initial.previewFit);
  const [previewOpacity, setPreviewOpacity] = useState(initial.previewOpacity ?? 0.35);
  const [comparison, setComparison] = useState(0);
  const [savedDepth, setSavedDepth] = useState(initial.depth);
  const [savedMask, setSavedMask] = useState(initial.mask);
  const [depthPick, setDepthPick] = useState(0);
  const [maskPick, setMaskPick] = useState(0);
  const [photo, setPhoto] = useState<PreparationPhoto | null>(null);
  const [depth, setDepth] = useState<FloatMap | null>(null);
  const [mask, setMask] = useState<FloatMap | null>(null);
  const readPreviewMaps = useCallback(() => ({ depth, mask }), [depth, mask]);
  const [side, setSide] = useState(initial.inputSide);
  const [maskSide, setMaskSide] = useState(1024);
  const [maskMethod, setMaskMethod] = useState<"facade" | "background">("facade");
  const [facadeSettings, setFacadeSettings] = useState<FacadeMaskSettings>(FACADE_MASK_DEFAULTS);
  const [useMask, setUseMask] = useState(initial.useMask ?? true);
  const [mode, setMode] = useState(initial.mode ?? 0);
  const [previz, setPreviz] = useState(initial.previz ?? true);
  const [requiresReload, setRequiresReload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<MapJob | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [brush, setBrush] = useState<0 | 1>(0);
  const [radius, setRadius] = useState(18);
  const [history, setHistory] = useState<readonly FloatMap[]>([]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const stroke = useRef<{ point: { x: number; y: number }; editor: ReturnType<typeof beginMaskStroke> } | null>(null);
  const maskRefLive = useRef(mask);
  maskRefLive.current = mask;
  const preparer = useRef<ReturnType<typeof createPhotoPreparer> | null>(null);
  const loadVersions = useRef({ depth: 0, mask: 0 });
  const live = useRef(true);
  const existing = initial.depthId !== undefined || initial.maskId !== undefined;
  const [photoUrl, depthUrl, maskUrl, previewPhotoUrl] = useFileUrls([photoRef, depthRef, maskRef, previewPhotoRef]);
  useEffect(() => { live.current = true; return () => { live.current = false; preparer.current?.dispose(); preparer.current = null; }; }, []);

  useEffect(() => {
    setPhoto(null);
    if (!photoUrl) return;
    const abort = new AbortController();
    let owned: PreparationPhoto | null = null;
    void decodePreparationPhoto(photoUrl, parseFileReference(photoRef)?.name ?? "Photo", abort.signal).then(next => {
      if (abort.signal.aborted) { next.bitmap.close(); return; }
      owned = next;
      setPhoto(next);
    }).catch(cause => { if (!abort.signal.aborted) setError(String(cause instanceof Error ? cause.message : cause)); });
    return () => { abort.abort(); owned?.bitmap.close(); };
  }, [photoUrl, photoRef]);

  useEffect(() => {
    setPreviewPhoto(null);
    if (!previewPhotoUrl) return;
    const abort = new AbortController();
    let owned: PreparationPhoto | null = null;
    void decodePreparationPhoto(previewPhotoUrl, parseFileReference(previewPhotoRef)?.name ?? "Preview photo", abort.signal).then(next => {
      if (abort.signal.aborted) { next.bitmap.close(); return; }
      owned = next; setPreviewPhoto(next);
    }).catch(cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { abort.abort(); owned?.bitmap.close(); };
  }, [previewPhotoUrl, previewPhotoRef]);

  const loadMap = useCallback((url: string | undefined, kind: "depth" | "mask") => {
    const abort = new AbortController();
    if (url) {
      const version = ++loadVersions.current[kind];
      void fetch(url, { signal: abort.signal }).then(async response => {
        if (!response.ok) throw new Error(`Saved ${kind} could not be opened (${response.status}).`);
        const map = decodeFloatMap(await response.arrayBuffer());
        if (preparedMetadata(map).kind !== kind) throw new Error(`Choose a prepared ${kind} map.`);
        const facade = kind === "mask" ? facadeMaskSettings(map) : undefined;
        rasterizeFloatMap(map, kind, 1, 1);
        if (!abort.signal.aborted && loadVersions.current[kind] === version) {
          if (kind === "depth") { setDepth(map); setSide(preparedMetadata(map).inputSide); }
          else {
            setMask(map);
            const loadedSide = facade?.detailSide ?? preparedMetadata(map).inputSide;
            if (supportsPhotoMaskSize(loadedSide)) setMaskSide(loadedSide);
            setMaskMethod(facade === undefined ? "background" : "facade");
            if (facade !== undefined) setFacadeSettings({ darkCutoff: facade.darkCutoff, feather: facade.feather, excludeBlueGlass: facade.excludeBlueGlass });
          }
          setStatus(`Existing ${kind} opened · ${map.width} × ${map.height} · float32. Ready to reuse with its reference photo.`);
        }
      }).catch(cause => { if (!abort.signal.aborted && loadVersions.current[kind] === version) setError(cause instanceof Error ? cause.message : String(cause)); });
    }
    return () => abort.abort();
  }, []);
  useEffect(() => loadMap(depthUrl, "depth"), [depthUrl, depthPick, loadMap]);
  useEffect(() => loadMap(maskUrl, "mask"), [maskUrl, maskPick, loadMap]);

  useEffect(() => {
    if (canvas.current !== null && photo !== null) drawMaskEditor(canvas.current, photo, mask);
  }, [photo, mask]);

  useEffect(() => {
    const target = preview.current;
    if (target === null || photo === null || depth === null) return;
    const scale = Math.min(360 / photo.bitmap.width, 256 / photo.bitmap.height);
    target.width = Math.max(1, Math.round(photo.bitmap.width * scale));
    target.height = Math.max(1, Math.round(photo.bitmap.height * scale));
    const context = target.getContext("2d");
    if (context === null) return;
    const values = rasterizeFloatMap(depth, "depth", target.width, target.height);
    const image = context.createImageData(target.width, target.height);
    for (let i = 0; i < values.length; i++) {
      image.data[4 * i] = image.data[4 * i + 1] = image.data[4 * i + 2] = values[i]! * 255;
      image.data[4 * i + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }, [depth, photo]);

  const run = async (kind: "depth" | "mask") => {
    if (photo === null || busy || (kind === "mask" && !useMask)) return;
    loadVersions.current[kind]++;
    setBusy(true); setError(null);
    setJob({ kind, progress: { phase: "preparing", message: "Preparing your photo…" } });
    try {
      preparer.current ??= createPhotoPreparer(progress => {
        if (live.current) { setStatus(progress.message); setJob(current => current === null ? null : { ...current, progress }); }
      });
      const map = kind === "depth" ? await preparer.current.run(kind, photo, side)
        : maskMethod === "facade" ? await preparer.current.run(kind, photo, side, maskSide, facadeSettings)
        : await preparer.current.run(kind, photo, side, maskSide);
      if (!live.current) return;
      if (kind === "depth") { setDepth(map); setSavedDepth(""); }
      else { setMask(map); setSavedMask(""); setHistory([]); }
      setStatus(`${kind === "depth" ? "Depth" : "Mask"} ready · ${map.width} × ${map.height} · float32. Save it to reuse.`);
    } catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (live.current) { setBusy(false); setJob(null); } }
  };

  const save = async (kind: "depth" | "mask") => {
    const map = kind === "depth" ? depth : mask;
    if (map === null || photo === null) return;
    setBusy(true); setError(null); setStatus(`Choose where to save the ${kind} map`);
    setJob({ kind, progress: { phase: "saving", message: "Choose a file location…" } });
    try {
      const reference = await savePreparedMap(map, `${photo.name.replace(/\.[^.]+$/, "")}-${kind}`, progress => {
        if (live.current) { setStatus(progress.message); setJob(current => current === null ? null : { ...current, progress }); }
      });
      if (!live.current) return;
      if (kind === "depth") setSavedDepth(reference); else setSavedMask(reference);
      setStatus(`${kind === "depth" ? "Depth" : "Mask"} saved. Apply it to the network when ready.`);
    } catch (cause) { if (live.current && !(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (live.current) { setBusy(false); setJob(null); } }
  };

  const matches = (map: FloatMap | null) => {
    if (photo === null || map === null) return false;
    const metadata = preparedMetadata(map);
    if (metadata.source.sha256 !== photo.sha256 || metadata.source.width !== photo.bitmap.width || metadata.source.height !== photo.bitmap.height) return false;
    if (metadata.kind === "depth") return metadata.inputSide === side;
    const facade = facadeMaskSettings(map);
    if (facade !== undefined) return maskMethod === "facade" && facade.detailSide === maskSide
      && facade.darkCutoff === facadeSettings.darkCutoff && facade.feather === facadeSettings.feather && facade.excludeBlueGlass === facadeSettings.excludeBlueGlass;
    return (maskMethod === "background" || metadata.model.id === "manual") && metadata.inputSide === maskSide;
  };
  const depthReady = savedDepth !== "" && matches(depth);
  const maskReady = savedMask !== "" && matches(mask);
  const needsDepth = !existing || initial.depthId !== undefined;
  const needsMask = existing ? initial.maskId !== undefined : useMask;
  const maskCoverage = useMemo(() => {
    if (mask === null) return null;
    let covered = 0;
    for (let i = 0; i < mask.values.length; i++) if (mask.values[i]! >= 0.5) covered++;
    return covered / mask.values.length;
  }, [mask]);
  const previewFramingMatches = photo !== null && previewPhoto !== null && hasMatchingPhotoAspect(photo.bitmap, previewPhoto.bitmap);
  const previewReady = previewPhotoRef === "" || previewPhoto !== null;
  const canApply = photo !== null && (!needsDepth || depthReady) && (!needsMask || maskReady) && (!previz || previewReady);
  const nextAction = photo === null ? "Choose a reference photo to begin"
    : needsDepth && depth === null ? "Choose saved depth, or run depth"
    : needsDepth && !matches(depth) ? "Choose matching depth, or rerun for this photo and detail"
    : needsDepth && !depthReady ? needsMask ? "Save depth, then prepare the surface mask" : "Save depth to create the full-frame mapping"
    : needsMask && mask === null ? "Choose a saved mask, run mask, or start a manual mask"
    : needsMask && !matches(mask) ? "Choose a matching mask, or rerun for this photo"
    : needsMask && !maskReady ? "Check the edges, then save the mask"
    : previz && !previewReady ? "Open a preview photo, or use the reference photo"
    : existing ? "Apply the saved maps to your network" : "Create the network, then align Window Out";
  const previewAspect = photo === null ? "16 / 9" : `${photo.bitmap.width} / ${photo.bitmap.height}`;
  const photoFrameStyle = { aspectRatio: previewAspect,
    maxWidth: `${240 * (photo === null ? 16 / 9 : photo.bitmap.width / photo.bitmap.height)}px` };
  const framing = photo === null || previewPhoto === null ? null : previewPhotoPlacement(previewPhoto.bitmap, photo.bitmap, previewFit);
  const previewStyle = { aspectRatio: previewAspect,
    maxWidth: `${256 * (photo === null ? 16 / 9 : photo.bitmap.width / photo.bitmap.height)}px` };
  const mapState = (map: FloatMap | null, saved: boolean) => map === null ? "Not generated"
    : !matches(map) ? "Out of date" : saved ? "Saved" : "Ready to save";
  const apply = async () => {
    if (photo === null || busy) return;
    setBusy(true); setError(null);
    try {
      if ((!existing && (!depthReady || (needsMask && !maskReady))) ||
        (existing && ((initial.depthId !== undefined && !depthReady) || (initial.maskId !== undefined && !maskReady)))) {
        throw new Error("Save prepared maps that match the photo and detail settings before applying them.");
      }
      if (previz && !previewReady) throw new Error("Open the preview photo before creating the network.");
      let result;
      if (!existing) {
        if (typeof runtime.bus.replaceCommand !== "function") {
          // One-time bootstrap for a bus constructed before command refresh existed.
          // All required maps are already saved; retain their identities rather than rerun.
          sessionStorage.setItem(reloadRecipeKey(runtime), JSON.stringify({ version: 1, photo: photoRef, depth: savedDepth, mask: savedMask,
            previewPhoto: previewPhotoRef, previewFit, previewOpacity, inputSide: side, mode, previz, useMask }));
          setRequiresReload(true);
          throw new Error("Reload Loom once to update the live command schema. Saved mapping setup will reopen.");
        }
        registerPhotoMappingCommands(runtime.bus, { refresh: true });
        result = await runtime.bus.execute("photoMapping.create", { photo: photoRef, depth: savedDepth, ...(needsMask ? { mask: savedMask } : {}),
          width: photo.bitmap.width, height: photo.bitmap.height, shader: PHOTO_MAPPING_SHADER, effect: mode, inputSide: side, previz,
          ...(previz ? { previewOpacity } : {}),
          ...(previz && previewPhotoRef !== "" ? { previewPhoto: previewPhotoRef, previewFit } : {}) }, runtime.invocation);
      } else {
        const graph = runtime.bus.store.getGraph();
        if (initial.depthId !== undefined && value(graph, initial.depthId, "inputSide") !== String(initial.inputSide)) {
          throw new Error("Depth settings changed while preparation was open. Reopen preparation.");
        }
        const operations = [];
        for (const [nodeId, reference, map] of [[initial.depthId, savedDepth, depth], [initial.maskId, savedMask, mask]] as const) {
          if (nodeId === undefined || map === null || reference === "") continue;
          if (floatMapPhotoUrlFor(graph, nodeId) !== initial.photo) throw new Error("The reference photo changed while preparation was open. Reopen preparation.");
          if (value(graph, nodeId, "file") !== (nodeId === initial.depthId ? initial.depth : initial.mask)) {
            throw new Error("A prepared map changed while preparation was open. Reopen preparation.");
          }
          const isDepth = preparedMetadata(map).kind === "depth";
          const inputSide = String(preparedMetadata(map).inputSide);
          if (reference === value(graph, nodeId, "file") && (!isDepth || value(graph, nodeId, "inputSide") === inputSide)) continue;
          operations.push({ op: "setParameters" as const, nodeId,
            parameters: { file: reference, ...(isDepth ? { inputSide } : {}) } });
        }
        if (initial.previewPhotoId !== undefined && (previewPhotoRef !== initial.previewPhoto || previewFit !== initial.previewFit)) {
          if (value(graph, initial.previewPhotoId, "file") !== initial.previewPhoto ||
            (value(graph, initial.previewPhotoId, "imageFit") || MEDIA_IMAGE_FIT_PARAMETERS.imageFit.default) !== initial.previewFit) {
            throw new Error("Preview photo or fit changed while preparation was open.");
          }
          operations.push({ op: "setParameters" as const, nodeId: initial.previewPhotoId, parameters: { file: previewPhotoRef, imageFit: previewFit } });
        }
        if (operations.length === 0) { close(); return; }
        result = await runtime.bus.execute("graph.applyPatch", { baseRevision: graph.revision, label: "Apply prepared photo maps", operations }, runtime.invocation);
      }
      if (result.status !== "applied") throw new Error(result.diagnostics.map(diagnostic => diagnostic.message).join(" "));
      if (!existing) {
        const navigation = navigationHolderFor(runtime.bus).current;
        while (navigation !== null && navigation.getPath().length > 0) {
          const depthBefore = navigation.getPath().length;
          const jumped = await runtime.bus.execute("graph.jumpUp", {}, runtime.invocation);
          if (jumped.status !== "applied" || navigation.getPath().length >= depthBefore) {
            throw new Error("The mapping was created at project root, but the editor could not leave its component.");
          }
        }
        await selectCreatedNodes(runtime.bus, runtime.invocation, result);
        if (runtime.bus.hasCommand("view.frameSelected")) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          if (live.current) {
            const nodeIds = Object.entries(result.output.createdIds).filter(([ref]) => ref !== "$group").map(([, id]) => id);
            await runtime.bus.execute("view.frameSelected", { nodeIds }, runtime.invocation);
            if (runtime.bus.hasCommand("node.openViewer")) {
              await runtime.bus.execute("node.openViewer", { nodeIds: [result.output.createdIds[previz ? "$previz" : "$corner"]!] }, runtime.invocation);
            }
          }
        }
      }
      close();
    } catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (live.current) setBusy(false); }
  };

  const paint = (event: React.PointerEvent<HTMLCanvasElement>, first: boolean) => {
    const current = maskRefLive.current;
    if (busy || !needsMask || current === null || (!first && stroke.current === null)) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const next = { x: (event.clientX - bounds.left) / bounds.width * current.width,
      y: (event.clientY - bounds.top) / bounds.height * current.height };
    if (first) {
      if (stroke.current !== null) return;
      loadVersions.current.mask++;
      event.currentTarget.setPointerCapture(event.pointerId);
      setHistory(previous => [...previous.slice(-19), current]);
      stroke.current = { point: next, editor: beginMaskStroke(current) };
      setSavedMask("");
    }
    const active = stroke.current!;
    const painted = active.editor.paint(active.point, next, radius, brush);
    active.point = next;
    if (photo !== null) drawMaskEditor(event.currentTarget, photo, painted);
  };

  const finishStroke = () => {
    if (stroke.current === null) return;
    const painted = stroke.current.editor.finish();
    stroke.current = null;
    maskRefLive.current = painted;
    setMask(painted);
  };

  return <DialogRoot open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className={styles.dialog}>
      <DialogTitle>{existing ? "Prepare photo mapping" : "Map from photo"}</DialogTitle>
      <DialogDescription>Choose a photo, load or prepare maps, then create</DialogDescription>
      <div className={styles.body}>
      <section className={styles.photoStep} aria-label="Choose reference photo">
        <div className={styles.stepHeading}><span className={styles.stepNumber}>1</span><h2>Choose a photo</h2>
          {photo === null ? null : <span className={styles.complete}>Selected</span>}</div>
        <p className={styles.hint}>Keep the object still; photograph beside the projector lens</p>
        <div className={styles.photoColumns}>
        <section className={styles.photoCard} aria-label="Reference photograph">
        <div className={styles.cardHeading}><h3>Reference</h3><span className={styles.badge}>Depth + mask source</span></div>
        <div className={`${styles.photoPicker} ${photo === null ? styles.photoEmpty : ""}`}>
        <AssetField label="Reference photo" kind="image" value={photoRef || null}
        {...(existing || busy ? {} : { onPick: (reference: string) => {
          setPhotoRef(reference); setError(null);
        } })} />
        </div>
        <div className={styles.photoFrame} data-testid="reference-photo-frame" style={photoFrameStyle}>
          {photo === null ? <span className={styles.placeholder}>Choose your reference photo</span> : <img src={photoUrl} alt="Reference photo" />}
        </div>
        <p className={styles.hint}>Used to prepare depth and mask</p>
        {photo !== null && Math.max(photo.bitmap.width, photo.bitmap.height) > runtime.bus.store.getSettings().limits.maxResolution
          ? <p className={styles.hint} role="note">Large photo: network fits within {runtime.bus.store.getSettings().limits.maxResolution} px, keeping the full frame</p> : null}
        </section>
        <section className={styles.photoCard} aria-label="Preview photograph">
        <div className={styles.cardHeading}><h3>Preview</h3><span className={styles.badge}>Optional night photo</span></div>
        {(!existing || initial.previewPhotoId !== undefined) ? <div className={styles.photoPicker}>
          <AssetField label="Preview photo (optional)" kind="image" value={previewPhotoRef || null}
            {...(busy ? {} : { onPick: (reference: string) => { setPreviewPhotoRef(reference); setPreviewPhoto(null); setError(null); } })} />
        </div> : <p className={styles.hint}>Using the reference photo</p>}
        <div className={styles.photoFrame} data-testid="preview-photo-frame" style={photoFrameStyle}>
          {photo === null ? <span className={styles.placeholder}>Preview your photo and animated outline here</span>
            : (!needsMask || (mask !== null && matches(mask))) && (depth === null || matches(depth)) && previewReady
              ? <PhotoMappingPreview photo={photo} previewPhoto={previewPhoto} previewFit={previewFit} previewOpacity={previewOpacity} readMaps={readPreviewMaps} fullFrame={!needsMask} matching />
              : <img src={previewPhotoUrl || photoUrl} alt="Preview photo" style={{ objectFit: previewPhotoRef === "" ? "fill" : previewFit === "fill" ? "cover" : previewFit === "fit" ? "contain" : "fill" }} />}
          {comparison > 0 && photo !== null && previewPhoto !== null ? <img src={photoUrl} alt="Reference alignment overlay" className={styles.referenceOverlay} style={{ opacity: comparison / 100 }} /> : null}
        </div>
        {previewPhotoRef === "" ? <p className={styles.hint}>Using the reference until you choose a preview photo</p> : <>
          <label className={styles.previewFit}>Preview fit <select value={previewFit} disabled={busy} onChange={event => setPreviewFit(event.target.value as PreviewImageFit)}>
            <option value="fit">Fit whole image</option><option value="fill">Crop to frame</option><option value="stretch">Stretch to frame</option>
          </select></label>
          {photo !== null && previewPhoto !== null && !previewFramingMatches ? <p role="note" aria-label="Preview framing warning" className={styles.warning}>Different aspect ratio: check the fitted alignment</p> : null}
          <p className={styles.hint}>{previewFit === "fill" ? "Crop removes edges; check the fitted alignment" : previewFit === "stretch" ? "Stretch changes proportions; check the fitted alignment" : "Fit adds borders; check the fitted alignment"}</p>
          {framing !== null && previewPhoto !== null && photo !== null ? <details className={styles.framingDetails} open={!previewFramingMatches}>
            <summary>Check framing and alignment</summary>
            <div className={styles.framingGuide} role="img" aria-label="Preview framing guide" style={{ aspectRatio: `${previewPhoto.bitmap.width} / ${previewPhoto.bitmap.height}`, maxWidth: `${140 * previewPhoto.bitmap.width / previewPhoto.bitmap.height}px` }}>
              <img src={previewPhotoUrl} alt="Full preview photograph" />
              <svg className={styles.cropGuide} viewBox={`0 0 ${previewPhoto.bitmap.width} ${previewPhoto.bitmap.height}`} preserveAspectRatio="none" aria-hidden="true">
                <rect x={framing.source.x} y={framing.source.y} width={framing.source.width} height={framing.source.height} vectorEffect="non-scaling-stroke" />
              </svg>
            </div>
            <p className={styles.hint}>{previewFit === "fill" ? `Crop removes ${Math.round((1 - framing.source.width * framing.source.height / (previewPhoto.bitmap.width * previewPhoto.bitmap.height)) * 100)}% of the photo; outlined area stays`
              : previewFit === "fit" ? `Borders occupy ${Math.round((1 - framing.destination.width * framing.destination.height / (photo.bitmap.width * photo.bitmap.height)) * 100)}% of the frame; all edges stay`
              : `All edges stay; horizontal proportions ×${(photo.bitmap.width / photo.bitmap.height / (previewPhoto.bitmap.width / previewPhoto.bitmap.height)).toFixed(2)}`}</p>
            <label>Reference overlay <input type="range" min={0} max={100} value={comparison} disabled={busy} onChange={event => setComparison(Number(event.target.value))} /><output>{comparison}%</output></label>
            <p className={styles.hint}>Compare rooflines and windows; guide only</p>
          </details> : null}
          {!existing ? <Button disabled={busy} onClick={() => { setPreviewPhotoRef(""); setPreviewPhoto(null); setError(null); }}>Use reference photo</Button> : null}
        </>}
        <p className={styles.hint}>Same viewpoint and framing; used only for preview</p>
        {!existing ? <label className={styles.previewLight}>Preview light <input type="range" min={0} max={100} value={Math.round(previewOpacity * 100)} disabled={busy} onChange={event => setPreviewOpacity(Number(event.target.value) / 100)} /><output>{Math.round(previewOpacity * 100)}%</output></label> : null}
        {!existing ? <p className={styles.hint}>Lower to see more building; projector stays full strength</p> : null}
        </section>
        </div>
      </section>
      <section className={styles.preparationStep} aria-label="Prepare and save maps">
        <div className={styles.stepHeading}><span className={styles.stepNumber}>2</span><h2>Prepare and save</h2></div>
        <p className={styles.hint}>Reuse saved maps, or generate and save new ones</p>
      <div className={styles.columns}>
        {needsDepth ? <section className={styles.section} aria-label="Depth preparation">
          <div className={styles.cardHeading}><h3>Depth</h3><span className={depthReady && job?.kind !== "depth" ? styles.complete : styles.badge}>{job?.kind === "depth" ? "Working…" : mapState(depth, depthReady)}</span></div>
          <label>Detail <select value={side} disabled={busy} onChange={event => { setSide(Number(event.target.value)); setSavedDepth(""); }}>
            {PHOTO_DEPTH_INPUT_SIDES.map(size => <option key={size} value={size}>{size} × {size}</option>)}
          </select></label>
          <p className={styles.hint}>Native float32; larger sizes take more time and memory</p>
          <div className={styles.actions}>
            <Button size="md" variant={depth === null ? "outline" : "ghost"} className={depth === null ? styles.nextButton : undefined}
              disabled={photo === null || busy} onClick={() => void run("depth")}>{depth === null ? "Run depth" : "Rerun depth"}</Button>
            <Button size="md" variant="outline" className={!depthReady && depth !== null ? styles.nextButton : undefined}
              disabled={depth === null || busy || !matches(depth)} onClick={() => void save("depth")}>{depthReady ? "Save depth again…" : "Save depth…"}</Button>
          </div>
          <div className={styles.existingMap}>
            <span>Use an existing depth map</span>
            <AssetField label="Existing depth map" kind="binary" value={depthRef || null}
              {...(busy ? {} : { onPick: (reference: string) => {
                loadVersions.current.depth++; setDepth(null); setDepthRef(reference); setSavedDepth(reference);
                setDepthPick(previous => previous + 1);
                setError(null); setStatus("Opening the existing depth map…");
              } })} />
          </div>
          <figure className={styles.figure}>
            <div className={styles.previewWell} aria-busy={job?.kind === "depth"}><div className={styles.previewFrame} data-testid="depth-preview-frame" style={previewStyle}>
              <canvas ref={preview} role="img" aria-label="Depth preview" className={`${styles.preview} ${depth === null ? styles.emptyCanvas : ""}`} />
              {depth === null ? <span className={styles.placeholder}>Load or run depth to see the surface relief</span> : null}
            </div>{job?.kind === "depth" ? <MapProgress job={job} /> : null}</div>
            <figcaption className={styles.previewCaption}>{depth === null ? "Surface relief" : `${depth.width} × ${depth.height} native samples · float32`}</figcaption>
          </figure>
          <p className={styles.hint}>{depthReady ? "Depth saved and ready to reuse" : depth === null ? "Load a saved .loomf32 map, or generate one" : "Next: Save depth to keep this result"}</p>
          <p className={styles.model}>Depth Anything V2 · 94.5 MB · cached after first run</p>
          {depth !== null && photo !== null && !matches(depth) ? <p role="alert">Depth out of date: choose a matching map or rerun</p> : null}
        </section> : null}
        {(!existing || needsMask) ? <section className={styles.section} aria-label="Surface mask preparation">
          <div className={styles.cardHeading}><h3>Surface mask</h3>
            {!existing ? <label htmlFor="photo-mapping-use-mask">Use surface mask<BooleanField id="photo-mapping-use-mask" label="Use surface mask" value={useMask} onChange={setUseMask} disabled={busy} /></label> : null}
            <span className={maskReady && needsMask && job?.kind !== "mask" ? styles.complete : styles.badge}>{job?.kind === "mask" ? "Working…" : needsMask ? mapState(mask, maskReady) : "Full frame"}</span>
          </div>
          <label>Mask detail <select value={maskSide} disabled={busy || !needsMask} onChange={event => { setMaskSide(Number(event.target.value)); setSavedMask(""); }}>
            {PHOTO_MASK_INPUT_SIDES.map(size => <option key={size} value={size}>{size} × {size}</option>)}
          </select></label>
          <p className={styles.hint}>{needsMask ? maskMethod === "facade" ? "Keep walls; exclude sky, openings and reflective glass" : "Select the object and remove its background" : "Full frame · no mask file needed"}</p>
          <div className={styles.actions}>
            <Button size="md" variant={mask === null ? "outline" : "ghost"} className={mask === null ? styles.nextButton : undefined}
              disabled={photo === null || busy || !needsMask} onClick={() => void run("mask")}>{mask === null ? "Run mask" : "Rerun mask"}</Button>
            <Button size="md" variant="outline" className={!maskReady && mask !== null ? styles.nextButton : undefined}
              disabled={mask === null || busy || !needsMask || !matches(mask)} onClick={() => void save("mask")}>{maskReady ? "Save mask again…" : "Save mask…"}</Button>
          </div>
          <div className={styles.existingMap}>
            <span>Use an existing mask</span>
            <AssetField label="Existing mask map" kind="binary" value={maskRef || null}
              {...(busy || !needsMask ? {} : { onPick: (reference: string) => {
                loadVersions.current.mask++; setMask(null); setMaskRef(reference); setSavedMask(reference);
                setMaskPick(previous => previous + 1);
                setHistory([]); setError(null); setStatus("Opening the existing mask…");
              } })} />
          </div>
          <figure className={styles.figure}>
            <div className={styles.previewWell} aria-busy={job?.kind === "mask"}><div className={styles.previewFrame} data-testid="mask-preview-frame" style={previewStyle}>
              <canvas ref={canvas} role="img" aria-label={mask === null ? "Reference photo preview" : "Surface mask editor"}
                className={`${styles.preview} ${photo === null ? styles.emptyCanvas : ""} ${mask !== null ? styles.editable : ""}`}
                onPointerDown={event => paint(event, true)} onPointerMove={event => paint(event, false)}
                onPointerUp={finishStroke} onPointerCancel={finishStroke} onLostPointerCapture={finishStroke} />
              {photo === null ? <span className={styles.placeholder}>Choose a photo to see its surface</span> : null}
            </div>{job?.kind === "mask" ? <MapProgress job={job} /> : null}</div>
            <figcaption className={styles.previewCaption}>{mask === null ? "Reference photo before masking" : "Red is excluded · drag to erase or restore"}</figcaption>
          </figure>
          <label>Mask method <select value={maskMethod} disabled={busy || !needsMask} onChange={event => { setMaskMethod(event.target.value as "facade" | "background"); setSavedMask(""); }}>
            <option value="facade">Facade walls and openings</option><option value="background">Object background removal</option>
          </select></label>
          {maskMethod === "facade" ? <div className={styles.brushTools}>
            <label>Opening cutoff <input type="range" min={0} max={50} step={1} value={Math.round(linearToSrgb(facadeSettings.darkCutoff) * 100)}
              disabled={busy || !needsMask} onChange={event => { setFacadeSettings(previous => ({ ...previous, darkCutoff: srgbToLinear(Number(event.target.value) / 100) })); setSavedMask(""); }} /><output>{Math.round(linearToSrgb(facadeSettings.darkCutoff) * 100)}%</output></label>
            <label>Exclude blue glass <BooleanField label="Exclude blue glass" value={facadeSettings.excludeBlueGlass} disabled={busy || !needsMask}
              onChange={excludeBlueGlass => { setFacadeSettings(previous => ({ ...previous, excludeBlueGlass })); setSavedMask(""); }} /></label>
            <p className={styles.hint}>Check shaded walls and painted glass; restore with the brush</p>
            <p className={styles.hint}>Change exclusions, then rerun mask; depth stays saved</p>
          </div> : null}
          {mask === null ? <p className={styles.hint}>Load a saved .loomf32 mask, generate one, or paint</p> : <div className={styles.brushTools}>
            <label>Brush <select value={brush} disabled={busy || !needsMask} onChange={event => setBrush(Number(event.target.value) as 0 | 1)}><option value={0}>Erase</option><option value={1}>Restore</option></select></label>
            <label>Radius <input type="range" min={1} max={100} value={radius} disabled={busy || !needsMask} onChange={event => setRadius(Number(event.target.value))} /><span>{radius} px</span></label>
            <Button disabled={history.length === 0 || busy || !needsMask} onClick={() => { setMask(history[history.length - 1]!); setHistory(previous => previous.slice(0, -1)); setSavedMask(""); }}>Undo stroke</Button>
          </div>}
          <div className={styles.alternative}><Button disabled={photo === null || busy || !needsMask} onClick={() => {
            if (photo === null) return;
            loadVersions.current.mask++;
            const scale = Math.min(1, maskSide / photo.bitmap.width, maskSide / photo.bitmap.height);
            const width = Math.max(1, Math.round(photo.bitmap.width * scale)), height = Math.max(1, Math.round(photo.bitmap.height * scale));
            setMask(makePreparedMap(new Float32Array(width * height).fill(1), width, height, { kind: "mask", source: {
              sha256: photo.sha256, width: photo.bitmap.width, height: photo.bitmap.height }, model: { id: "manual", url: "loom:manual-mask" },
              inputSide: maskSide, registration: "stretch" })); setSavedMask(""); setHistory([]);
          }}>Start manual mask</Button><span>Paint it yourself</span></div>
          <p className={styles.model}>{maskMethod === "facade" ? `${PHOTO_FACADE.label} · ${(PHOTO_FACADE.bytes / 1024 / 1024).toFixed(1)} MB · 512 input / 64 scene mask` : `${PHOTO_MASK.label} · ${(PHOTO_MASK.bytes / 1024 / 1024).toFixed(1)} MB · cached after first run`}</p>
          {maskMethod === "facade" ? <p className={styles.hint}>Photo refinement adds detail at the selected resolution</p> : null}
          <p className={styles.hint}>Rerun mask replaces brush edits</p>
          {needsMask && maskCoverage !== null && maskCoverage < 0.01 ? <div role="alert" className={styles.warning}>
            <p>Mask covers less than 1% of the photo</p>
            <p>Use full frame or restore the surface with the brush</p>
          </div> : null}
          {needsMask && mask !== null && photo !== null && !matches(mask) ? <p role="alert">Mask out of date: choose a matching map or rerun</p> : null}
        </section> : null}
      </div>
      </section>
      <section className={styles.finishStep} aria-label="Create or update mapping">
        <div className={styles.stepHeading}><span className={styles.stepNumber}>3</span><h2>{existing ? "Update your network" : "Create in this project"}</h2></div>
        {!existing ? <label>First effect <select value={mode} disabled={busy} onChange={event => setMode(Number(event.target.value))}>
        <option value={0}>Neon contours</option><option value={1}>Prismatic sweep</option><option value={2}>Chromatic relief</option>
        <option value={3}>Surface trace</option><option value={4}>Depth reveal</option>
        </select></label> : null}
        {!existing ? <p className={styles.hint}>{[
          "Animated depth contours pick out ledges and architectural edges",
          "Colour sweeps through depth planes, revealing protrusions and recesses",
          "Grazing gold and cyan lights reveal depth relief and local shadows",
          "Depth scans follow architecture and the mask boundary, including openings",
          "Layered depth bands reveal recesses, highlights and occlusion",
        ][mode]}</p> : null}
        {!existing ? <label>Preview on reference photo <BooleanField label="Preview on reference photo" value={previz} onChange={setPreviz} disabled={busy} /></label> : null}
        {!existing && previz ? <p className={styles.hint}>Preview dims the reference so projected light stays clear</p> : null}
        <p className={styles.hint}>{canApply ? previz && !existing ? "View the effect on your photo; align Window Out to project" : "Next: align Grid Warp and Corner Pin in Window Out" : "Load saved maps or save new results to enable this step"}</p>
      </section>
      </div>
      <div className={styles.feedback}>
        <p className={styles.nextAction}>{busy ? job?.progress.message ?? "Working…" : `Next: ${nextAction}`}</p>
        {status === "" ? null : <p role="status" className={styles.status}>{status}</p>}
        {error === null ? null : <p role="alert" className={styles.error}>{error}</p>}
        {requiresReload ? <Button onClick={() => window.location.reload()}>Reload Loom</Button> : null}
      </div>
      <DialogFooter className={styles.footer}><Button size="md" onClick={close}>Close</Button>
        <Button size="md" variant="outline" className={styles.primary} disabled={busy || !canApply}
          onClick={() => void apply()}>{existing ? "Apply saved maps" : "Create mapping network"}</Button></DialogFooter>
    </DialogContent>
  </DialogRoot>;
}

/** Mounted even while closed, so the pulse and top-bar action always have a command surface. */
export function PhotoMappingHost({ runtime }: { runtime: AppRuntime }) {
  const [session, setSession] = useState<{ id: string; recipe: Recipe } | null>(null);
  useEffect(() => { setSession(null); }, [runtime.documentIdentity]);
  useEffect(() => {
    if (typeof runtime.bus.replaceCommand !== "function") return;
    registerPhotoMappingCommands(runtime.bus, { refresh: true });
    const stored = sessionStorage.getItem(reloadRecipeKey(runtime));
    if (stored !== null) {
      const { version: _version, ...recipe } = reloadRecipeSchema.parse(JSON.parse(stored));
      setSession({ id: crypto.randomUUID(), recipe });
    }
  }, [runtime]);
  const holder = useMemo(() => {
    const found = commandHolder<{ open: (recipe: Recipe) => void }>(runtime.bus, "photoMapping.prepare");
    if (!runtime.bus.hasCommand("photoMapping.prepare")) runtime.bus.registerCommand({
      name: "photoMapping.prepare", inSession: "app", inputSchema: z.object({ nodeIds: nodeIdsInput.optional() }).strict(),
      description: "Open reusable photo preparation, or rerun a prepared map.",
      handler: (input, context) => {
        try {
          if ((input.nodeIds?.length ?? 0) > 1) throw new Error("Open preparation for one Float Map In at a time.");
          const next = recipeFor(context.graph, input.nodeIds?.[0]);
          if (found.current === null) throw new Error("Photo preparation is not mounted.");
          if (!context.dryRun) found.current.open(next);
          return { status: context.dryRun ? "validated" : "applied", output: { opened: !context.dryRun }, diagnostics: [] };
        } catch (cause) { return { status: "rejected", output: { opened: false }, diagnostics: [{ severity: "error", code: "photoMapping.prepare.unavailable",
          message: cause instanceof Error ? cause.message : String(cause) }] }; }
      }, rejectionOutput: () => ({ opened: false }),
    });
    return found;
  }, [runtime.bus]);
  useEffect(() => { const surface = { open: (recipe: Recipe) => setSession({ id: crypto.randomUUID(), recipe }) }; holder.current = surface;
    return () => { if (holder.current === surface) holder.current = null; }; }, [holder]);
  return session === null ? null : <PhotoMappingEditor key={session.id} runtime={runtime} initial={session.recipe} close={() => {
    sessionStorage.removeItem(reloadRecipeKey(runtime)); setSession(null);
  }} />;
}
