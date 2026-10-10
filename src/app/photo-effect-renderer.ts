import { prepareFrameCompiler } from "../compiler/frame-compile.ts";
import { flattenComponents } from "../compiler/flatten.ts";
import { graphChannelResolver } from "../domain/channels/graph-channels.ts";
import { createComponentRegistry } from "../domain/components/index.ts";
import { createUniformAnimator } from "./animate-parameters.ts";
import { targetResourceId } from "../compiler/resources.ts";
import { createDomainBus } from "../domain/commands/index.ts";
import { createGraphStore } from "../domain/graph/store.ts";
import type { ImageFraming } from "../domain/media/image-framing.ts";
import { DEFAULT_PROJECT_SETTINGS } from "../domain/types/graph.ts";
import type { FrameInputs } from "../domain/types/backend.ts";
import type { InvocationContext } from "../domain/types/commands.ts";
import { allNodeDefinitions, mediaSourceIdFor } from "../nodes/definitions/index.ts";
import { floatMapSourceIdFor } from "../nodes/definitions/float-map-in.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { createVgpuBackend, type GpuHost, type MediaSource, type MediaSourceFrame, type PresentableCanvas } from "../runtime/backend/index.ts";
import { PHOTO_ALIGNMENT_SHADER } from "./photo-mapping-effects.ts";

export interface PhotoEffectRenderRequest {
  readonly width: number;
  readonly height: number;
  readonly shader: string;
  readonly photo: MediaSourceFrame;
  readonly photoSize: readonly [number, number];
  readonly previewPhoto?: MediaSourceFrame;
  readonly previewPhotoSize?: readonly [number, number];
  readonly previewFit?: "fit" | "fill" | "stretch";
  readonly previewFraming?: ImageFraming;
  /** Registered, near-bright working depth and independent float32 mask confidence. */
  readonly depth: Float32Array;
  readonly mask: Float32Array;
  readonly mode: number;
  readonly previewOpacity: number;
  readonly testPattern?: boolean;
  readonly video?: MediaSource;
  readonly videoSize?: readonly [number, number];
}

function sizeValid(size: readonly [number, number]): boolean {
  return size.every(value => Number.isSafeInteger(value) && value > 0) && size[0] * size[1] <= 64_000_000;
}

function frameValid(frame: MediaSourceFrame, size: readonly [number, number]): boolean {
  return Number.isSafeInteger(frame.frameId) && frame.frameId >= 0 &&
    (frame.bytes === undefined ? frame.image !== undefined && frame.image !== null
      : frame.bytes instanceof Uint8Array && frame.bytes.byteLength === size[0] * size[1] * 4);
}

/** Render the existing photo-mapping previz graph in an isolated store and GPU owner. */
export async function createPhotoEffectRenderer(request: PhotoEffectRenderRequest, options: { readonly host?: GpuHost } = {}) {
  const { width, height } = request;
  if (!sizeValid([width, height]) || Math.max(width, height) > DEFAULT_PROJECT_SETTINGS.limits.maxResolution)
    throw new Error("Photo effect preview dimensions exceed the supported project limits.");
  if (!sizeValid(request.photoSize) || !frameValid(request.photo, request.photoSize)) throw new Error("Invalid photo effect preview source frame or dimensions.");
  if ((request.previewPhoto === undefined) !== (request.previewPhotoSize === undefined) ||
    (request.previewPhoto !== undefined && (!sizeValid(request.previewPhotoSize!) || !frameValid(request.previewPhoto, request.previewPhotoSize!))))
    throw new Error("Preview reference frame and dimensions must be supplied together.");
  if ((request.video === undefined) !== (request.videoSize === undefined) ||
    (request.video !== undefined && (!sizeValid(request.videoSize!) || typeof request.video.currentFrame !== "function")))
    throw new Error("Video source and dimensions must be supplied together.");
  if (request.mode === 9 && request.video === undefined && request.testPattern !== true) throw new Error("Choose a video texture to preview Mapped video.");
  if (!(request.depth instanceof Float32Array) || !(request.mask instanceof Float32Array) ||
    request.depth.length !== width * height || request.mask.length !== width * height)
    throw new Error("Photo effect preview requires registered depth and mask arrays matching its dimensions.");
  for (const value of request.depth) if (!Number.isFinite(value)) throw new Error("Photo effect preview depth must be finite.");
  for (const value of request.mask) if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Photo effect preview mask must be finite confidence in 0..1.");
  const depthBytes = new Uint8Array(request.depth.slice().buffer);
  const maskBytes = new Uint8Array(request.mask.slice().buffer);
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const store = createGraphStore({ initialSettings: { ...DEFAULT_PROJECT_SETTINGS, outputResolution: { width, height } } });
  const { bus } = createDomainBus({ store, registry });
  const humanInvocation: InvocationContext = { actor: { kind: "human", id: "photo-preview" }, projectId: "photo-preview", capabilities: [] };
  const result = await bus.execute("photoMapping.create", {
    photo: "preview.png", depth: "preview-depth.loom.exr", mask: "preview-mask.loom.exr", width, height,
    shader: request.shader, effect: request.mode, previewOpacity: request.previewOpacity, previz: true,
    patternShader: PHOTO_ALIGNMENT_SHADER, testPattern: request.testPattern ?? false,
    ...(request.video === undefined ? {} : { video: "preview-video.mp4" }),
    ...(request.previewPhoto === undefined ? {} : { previewPhoto: "preview-reference.png",
      ...(request.previewFit === undefined ? {} : { previewFit: request.previewFit }),
      ...(request.previewFraming === undefined ? {} : { previewFraming: request.previewFraming }) }),
  }, humanInvocation);
  if (result.status !== "applied") throw new Error(`Photo effect preview graph could not be created: ${result.diagnostics.map(diagnostic => diagnostic.message).join("; ")}`);
  const ids = result.output.createdIds;
  const requiredId = (ref: string) => {
    const id = ids[ref];
    if (id === undefined) throw new Error(`Photo effect preview graph did not create ${ref}.`);
    return id;
  };
  const photoSource = mediaSourceIdFor(requiredId("$photo"));
  const depthSource = floatMapSourceIdFor(requiredId("$depth"));
  const maskSource = floatMapSourceIdFor(requiredId("$mask"));
  const previewSource = request.previewPhoto === undefined ? undefined : mediaSourceIdFor(requiredId("$previewPhoto"));
  const videoSource = request.video === undefined ? undefined : mediaSourceIdFor(requiredId("$video"));
  const outputId = targetResourceId(requiredId("$previz"), "out");
  const backend = createVgpuBackend(options);
  const releases: (() => void)[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const release of releases) release();
    backend.dispose();
  };
  try {
    const capabilities = await backend.initialize({});
    const textureLimit = capabilities.limits.maxTextureDimension2D;
    if (typeof textureLimit !== "number" || !Number.isSafeInteger(textureLimit) || textureLimit < 1)
      throw new Error("Photo effect preview GPU did not report its texture size limit.");
    for (const size of [request.photoSize, ...(request.previewPhotoSize === undefined ? [] : [request.previewPhotoSize]),
      ...(request.videoSize === undefined ? [] : [request.videoSize])]) {
      if (Math.max(...size) > textureLimit) throw new Error("Photo effect preview source exceeds this GPU's texture size limit.");
    }
    const graph = store.view.getGraph();
    const flattened = flattenComponents({ graph, registry, components: createComponentRegistry({ nodes: () => registry }).view() });
    const channels = graphChannelResolver(flattened.graph, registry);
    const frames = prepareFrameCompiler({ graph, registry, settings: store.view.getSettings(), capabilities, flattened,
      sinks: [{ nodeId: requiredId("$previz"), kind: "readback" }] });
    if (!frames.uniformOnly) throw new Error(`Projection preview requires a fixed graph structure: ${frames.reason}`);
    const plan = frames.base;
    const errors = plan.diagnostics.filter(diagnostic => diagnostic.severity === "error");
    if (errors.length) throw new Error(`Photo effect preview could not compile: ${errors.map(diagnostic => diagnostic.message).join("; ")}`);
    const resources = plan.resources.map(resource => {
      if (resource.kind !== "externalTexture") return resource;
      if (resource.sourceId === photoSource) return { ...resource, size: request.photoSize };
      if (resource.sourceId === previewSource) return { ...resource, size: request.previewPhotoSize! };
      if (resource.sourceId === videoSource) return { ...resource, size: request.videoSize! };
      return resource;
    });
    const compiled = await backend.compile({ ...plan, resources });
    const animator = createUniformAnimator();
    releases.push(backend.registerMediaSource(photoSource, { currentFrame: () => request.photo, ended: true }),
      backend.registerMediaSource(depthSource, { currentFrame: () => ({ frameId: 1, bytes: depthBytes }), ended: true }),
      backend.registerMediaSource(maskSource, { currentFrame: () => ({ frameId: 1, bytes: maskBytes }), ended: true }));
    if (previewSource !== undefined) releases.push(backend.registerMediaSource(previewSource, { currentFrame: () => request.previewPhoto!, ended: true }));
    if (videoSource !== undefined) releases.push(backend.registerMediaSource(videoSource, request.video!));
    const owned = () => { if (disposed) throw new Error("Photo effect preview was disposed."); };
    return {
      draw(frame: FrameInputs) {
        owned();
        const next = frames.compileFrame({ frame: frame.frame, channels });
        if (next === null || animator.push(backend, plan, next) === null) throw new Error(`Projection preview animation changed graph structure: ${frames.reason}`);
        backend.render(compiled, frame);
      },
      present(canvas: PresentableCanvas) { owned(); return backend.present(canvas, { outputId, sizing: "source" }); },
      read() { owned(); return backend.readOutput(outputId); },
      dispose,
    };
  } catch (error) { dispose(); throw error; }
}
