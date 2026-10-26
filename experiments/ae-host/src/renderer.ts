// VN118: the Loom half of loom-previz-host. Loads a package's project once, renders any frame
// of it on Dawn with the effect's layer pixels and parameter values, and hands back the output
// target's RGBA16F bytes. No IPC here (host.ts) and no shared memory (shm.ts).
//
// Built on the seams Spike B (VN117) proved: `registerMediaSource` for the AE layers,
// `prepareMesh` for the GLB, a per-frame values-only compile pushed with `updateUniforms`,
// and exact random frame access (every frame is a pure function of time and parameters).
// It reaches into Loom internals by relative path; a stable headless entry in `src/` would
// replace these imports (see README "Upstream ask").
import { readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { cpus } from "node:os";
import { compileGraph, flattenComponents } from "../../../src/compiler/index.ts";
import type { CompiledGraph, CompileRequest } from "../../../src/compiler/index.ts";
import type { BackendCapabilities } from "../../../src/domain/types/backend.ts";
import { createComponentSystem } from "../../../src/domain/components/index.ts";
import { loadProject } from "../../../src/domain/project/index.ts";
import type { GraphNode } from "../../../src/domain/types/graph.ts";
import { frameFromClock } from "../../../src/domain/types/frame.ts";
import type { EvaluationFrame, TransportSource } from "../../../src/domain/types/frame.ts";
import { allNodeDefinitions } from "../../../src/nodes/definitions/index.ts";
import { createNodeRegistry } from "../../../src/nodes/registry/registry.ts";
import { meshSourceIdsFor, prepareMesh } from "../../../src/points/mesh.ts";
import { createVgpuBackend } from "../../../src/runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "../../../src/runtime/backend/vgpu/node-gpu-host.ts";
import { createValueGraphSession } from "../../../src/domain/channels/value-graph.ts";
import { buildMorphIndex } from "../../../src/domain/presets/morph-index.ts";
import { createUniformAnimator } from "../../../src/app/animate-parameters.ts";
import { NO_INSTANCES, NO_PAGES } from "../../../src/domain/parameters/node-references.ts";
import { createFrameDriver } from "../../../src/runtime/execution/frame-driver.ts";
import { createPointerSource } from "../../../src/runtime/execution/pointer.ts";
import type { Manifest } from "./manifest-types.ts";
import { decodePng } from "./png.ts";

/** One layer image as the effect hands it over: RGBA8, straight alpha, rows top to bottom. */
export interface LayerImage {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface RenderRequest {
  readonly frame: number;
  readonly width: number;
  readonly height: number;
  /** Manifest param id -> value (bools as 0/1). Missing ids keep the manifest default. */
  readonly params: Readonly<Record<string, number>>;
  /** Manifest input id -> image. A missing input renders black. */
  readonly inputs: Readonly<Record<string, LayerImage | undefined>>;
}

export interface RenderedFrame {
  /** RGBA16F, straight alpha, rows top to bottom, width*height*8 bytes. Valid until the next render. */
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface PrevizRenderer {
  readonly gpu: string;
  render(request: RenderRequest): Promise<RenderedFrame>;
  /** Builds the GPU program for a size ahead of the first request at it. */
  warm(width: number, height: number): Promise<void>;
  dispose(): void;
}

export interface RendererOptions {
  readonly packageDir: string;
  readonly manifest: Manifest;
  /** GPU programs kept alive at once, one per output size (each is a Dawn device). */
  readonly sizeCache?: number;
  readonly log?: (message: string) => void;
}

function assertCompiled(plan: CompiledGraph): void {
  const errors = plan.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) throw new Error(`compile: ${errors.map((d) => d.message).join("; ")}`);
}

/** Which parameter of a control node holds its value. */
const VALUE_KEY: Record<string, string> = { slider: "value", toggle: "on" };

/**
 * VN122: `<node>.<parameter>` -> the value the host always renders with, whatever the project
 * was saved with or the effect sends. Source = 0 (live): the AE layers are the source.
 */
const PINNED: Readonly<Record<string, number>> = { "stageFeeds.source": 0 };

/** A project path (`media/stage-previz/stage-r2.glb`) resolved inside the package. */
function packageMedia(packageDir: string, file: string): string {
  const flat = join(packageDir, "media", basename(file));
  if (existsSync(flat)) return flat;
  const nested = join(packageDir, file);
  if (existsSync(nested)) return nested;
  throw new Error(`package media missing: ${file} (looked for ${flat})`);
}

/** Bilinear resample of straight-alpha RGBA8 to the texture's authored extent. */
function resample(src: LayerImage, width: number, height: number, out: Uint8Array): Uint8Array {
  const { bytes, width: sw, height: sh } = src;
  const sx = sw / width, sy = sh / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.min(sh - 1, fy | 0), y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      const x0 = Math.min(sw - 1, fx | 0), x1 = Math.min(sw - 1, x0 + 1), wx = fx - x0;
      const a = (y0 * sw + x0) * 4, b = (y0 * sw + x1) * 4, c = (y1 * sw + x0) * 4, d = (y1 * sw + x1) * 4;
      const o = (y * width + x) * 4;
      for (let k = 0; k < 4; k++) {
        const top = bytes[a + k]! + (bytes[b + k]! - bytes[a + k]!) * wx;
        const bot = bytes[c + k]! + (bytes[d + k]! - bytes[c + k]!) * wx;
        out[o + k] = (top + (bot - top) * wy + 0.5) | 0;
      }
    }
  }
  return out;
}

export async function createPrevizRenderer(options: RendererOptions): Promise<PrevizRenderer> {
  const { packageDir, manifest } = options;
  const log = options.log ?? (() => {});
  const maxSizes = Math.max(1, options.sizeCache ?? 2);

  const registry = createNodeRegistry(allNodeDefinitions).view();
  const system = createComponentSystem(registry);
  const loaded = loadProject(readFileSync(join(packageDir, manifest.project), "utf8"), {
    nodes: system.nodes,
    components: system.components,
  });
  if (!loaded.ok) throw new Error(`project did not load: ${loaded.reason}`);
  const document = loaded.document;
  const fps = manifest.fps;
  const seed = document.settings.randomSeed ?? 0;

  // Meshes: decoded once, shared by every size's program.
  const glbs = new Map<string, Uint8Array>();
  const nodes = { ...document.graph.nodes } as Record<string, GraphNode>;
  const meshes = new Map<string, NonNullable<ReturnType<typeof prepareMesh>>>();
  for (const node of Object.values(nodes)) {
    if (node.type !== "meshFileIn") continue;
    const file = String(node.parameters["file"] ?? "");
    let glb = glbs.get(file);
    if (glb === undefined) glbs.set(file, (glb = new Uint8Array(readFileSync(packageMedia(packageDir, file)))));
    const mesh = prepareMesh(glb, String(node.parameters["select"] ?? ""), {}, String(node.parameters["lamps"] ?? ""), "world");
    if (mesh === null) { log(`mesh ${node.label}: nothing matched "${String(node.parameters["select"])}"`); continue; }
    meshes.set(node.id, mesh);
    nodes[node.id] = { ...node, parameters: { ...node.parameters, ...mesh.facts } } as GraphNode;
  }
  const graph = { ...document.graph, nodes };
  const components = system.components.view();
  const flattened = flattenComponents({ graph, registry, components });
  const morphs = flattened.morphs ?? buildMorphIndex({ document: graph, registry });

  // Manifest param id -> the flattened parameters it writes (VN122: PROTOCOL.md's amended ids).
  //  - `<node>`: that node's value parameter (`value` on a slider, `on` on a toggle);
  //  - `<node>.<parameter>`: that parameter. A component instance is inlined away by
  //    flattening, so its published parameter is written where flattening wrote it: every
  //    internal parameter whose published origin is (instance, parameter). A plain value
  //    replaces whatever stood there (a static number, or an expression slot handed down).
  // The node part matches a root node's name, else its id (`stageFeeds` is the id of the
  // instance named `stagefeeds1`).
  const rootNodes = Object.values(graph.nodes) as GraphNode[];
  function writesFor(id: string): { nodeId: string; key: string; bool: boolean }[] {
    const dot = id.indexOf(".");
    if (dot < 0) {
      const entry = Object.entries(flattened.graph.nodes).find(([, n]) => (n as GraphNode).label === id);
      if (entry === undefined) throw new Error(`param "${id}" names no node in the project`);
      const [nodeId, node] = entry as [string, GraphNode];
      const key = VALUE_KEY[node.type];
      if (key === undefined) throw new Error(`param "${id}" is a ${node.type}, not a slider or toggle`);
      return [{ nodeId, key, bool: node.type === "toggle" }];
    }
    const name = id.slice(0, dot), key = id.slice(dot + 1);
    const root = rootNodes.find((n) => n.label === name) ?? rootNodes.find((n) => n.id === name);
    if (root === undefined) throw new Error(`param "${id}" names no node "${name}" in the project`);
    if (flattened.graph.nodes[root.id] !== undefined) {
      if (!(key in root.parameters)) throw new Error(`param "${id}": ${root.label} has no parameter "${key}"`);
      return [{ nodeId: root.id, key, bool: false }];
    }
    const writes: { nodeId: string; key: string; bool: boolean }[] = [];
    for (const [flatId, origins] of flattened.publishedOrigins) {
      for (const [innerKey, origin] of Object.entries(origins)) {
        if (origin.nodeId === root.id && origin.key === key) writes.push({ nodeId: flatId, key: innerKey, bool: false });
      }
    }
    if (writes.length === 0) throw new Error(`param "${id}": instance ${root.label} publishes no parameter "${key}" that reaches a node`);
    return writes;
  }
  const controls = new Map<string, { nodeId: string; key: string; bool: boolean }[]>();
  for (const param of manifest.params) controls.set(param.id, writesFor(param.id));
  // VN122: parameters the host pins whatever the project was saved with. The AE layers ARE
  // the source, so Source is live (0) always: the DS and Sides switches show the layers, not
  // the test card or grid. Written on the instance's published parameter rather than the
  // slider, so a project whose instance is not wired to the slider is pinned too. A project
  // without it (another package) pins nothing.
  const pinned: { nodeId: string; key: string; bool: boolean; value: number }[] = [];
  for (const [id, value] of Object.entries(PINNED)) {
    if (controls.has(id)) throw new Error(`param "${id}" is pinned by the host and cannot be published`);
    try { for (const w of writesFor(id)) pinned.push({ ...w, value }); log(`pinned ${id} = ${value}`); }
    catch (e) { log(`not pinned: ${e instanceof Error ? e.message : String(e)}`); }
  }
  // VN121: still pictures (a Movie File In on a PNG), decoded once and fed as a constant frame.
  // Keyed by the flattened node id, which is what the node's media key is built from.
  const stills = new Map<string, LayerImage>();
  for (const [nodeId, node] of Object.entries(flattened.graph.nodes) as [string, GraphNode][]) {
    if (node.type !== "movieFileIn") continue;
    const file = String(node.parameters["file"] ?? "");
    if (/\.png$/i.test(file)) {
      const image = decodePng(new Uint8Array(readFileSync(packageMedia(packageDir, file))), `${node.label} (${basename(file)})`);
      stills.set(nodeId, image);
      log(`still ${node.label ?? nodeId}: ${basename(file)} ${image.width}x${image.height}`);
    } else if (/\.(jpe?g|webp|gif|bmp|tiff?|heic|avif|exr|hdr)$/i.test(file)) {
      throw new Error(`${node.label}: ${basename(file)} is a still the host cannot decode (PNG only)`);
    }
  }

  const outputs = Object.values(flattened.graph.nodes).filter((n) => (n as GraphNode).type === "output") as GraphNode[];
  if (outputs.length !== 1) throw new Error(`expected one Output node, found ${outputs.length}`);
  const outputNodeId = outputs[0]!.id;
  const defaults = Object.fromEntries(manifest.params.map((p) => [p.id, Number(p.default)]));

  /** The flattened graph with this request's control values (and the pinned ones) written into it. */
  function withParams(params: Readonly<Record<string, number>>): typeof flattened {
    const patched = { ...flattened.graph.nodes } as Record<string, GraphNode>;
    const write = (control: { nodeId: string; key: string; bool: boolean }, raw: number) => {
      const value = control.bool ? raw >= 0.5 : raw;
      const node = patched[control.nodeId]!;
      if (node.parameters[control.key] === value) return;
      patched[control.nodeId] = { ...node, parameters: { ...node.parameters, [control.key]: value } } as GraphNode;
    };
    for (const [id, writes] of controls) for (const w of writes) write(w, params[id] ?? defaults[id]!);
    for (const p of pinned) write(p, p.value);
    return { ...flattened, graph: { ...flattened.graph, nodes: patched } } as typeof flattened;
  }

  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  // Dawn names the driver, not the chip; on Apple silicon the chip is the CPU's model string.
  const chip = process.platform === "darwin" && process.arch === "arm64" ? cpus()[0]?.model : undefined;
  const gpuName = [chip, probe.adapter].filter(Boolean).join(" / ") || "unknown GPU";

  /** Everything that exists once per output size: a device, a compiled program, a driver. */
  interface Rig {
    readonly key: string;
    readonly width: number;
    readonly height: number;
    readonly backend: ReturnType<typeof createVgpuBackend>;
    base: CompiledGraph;
    readonly capabilities: BackendCapabilities;
    readonly outputId: string;
    readonly driver: ReturnType<typeof createFrameDriver>;
    readonly animator: ReturnType<typeof createUniformAnimator>;
    readonly pointer: ReturnType<typeof createPointerSource>;
    frame: EvaluationFrame;
    /** sourceId -> the bytes offered this render, at the texture's authored size. */
    readonly feeds: Map<string, { frameId: number; bytes: Uint8Array; size: readonly [number, number]; black: Uint8Array; scratch?: Uint8Array }>;
    /** Source ids of the stills registered on this rig's backend. */
    readonly stillsFed: Set<string>;
  }

  const rigs = new Map<string, Rig>();
  const valueSession = createValueGraphSession(registry);
  let feedFrameId = 0;

  function frameAt(index: number): EvaluationFrame {
    return frameFromClock({
      timeSeconds: index / fps,
      deltaSeconds: 1 / fps,
      frameIndex: index,
      mode: "fixed-step",
      randomSeed: seed,
      wallSeconds: index / fps,
      wallDeltaSeconds: 1 / fps,
      absFrameIndex: index,
      absTimeSeconds: index / fps,
      fps,
      subframes: 1,
    });
  }

  /**
   * Stills: one upload (constant frameId), at the texture's extent. Any other external texture
   * that nothing feeds renders black, and says so once per source. Run for every plan a rig
   * gets, so a still a structural recompile brings in is fed too.
   */
  const reportedBlack = new Set<string>();
  function feedStills(backend: Rig["backend"], plan: CompiledGraph, feeds: Rig["feeds"], fed = new Set<string>()): Set<string> {
    for (const resource of plan.resources) {
      if (resource.kind !== "externalTexture" || feeds.has(resource.sourceId) || fed.has(resource.sourceId)) continue;
      const nodeId = resource.sourceId.replace(/^media:/, "");
      const still = stills.get(nodeId);
      if (still === undefined) {
        if (reportedBlack.has(resource.sourceId)) continue;
        reportedBlack.add(resource.sourceId);
        const node = flattened.graph.nodes[nodeId] as GraphNode | undefined;
        log(`${resource.sourceId} (${node?.label ?? "?"}, ${node?.type ?? "?"}): no source, renders black`);
        continue;
      }
      const [w, h] = resource.size;
      const bytes = still.width === w && still.height === h ? still.bytes : resample(still, w, h, new Uint8Array(w * h * 4));
      backend.registerMediaSource(resource.sourceId, { currentFrame: () => ({ frameId: 1, bytes }) });
      fed.add(resource.sourceId);
    }
    return fed;
  }

  async function buildRig(width: number, height: number): Promise<Rig> {
    const settings = { ...document.settings, outputResolution: { width, height } };
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    backend.onDiagnostic((d) => { if (d.severity === "error") log(`gpu ${d.code}: ${d.message}`); });
    const capabilities = await backend.initialize({});
    // The base program is the manifest defaults with the pins written in, so the inputs'
    // feeds are in it even for a project saved with Source on the test card.
    const request: CompileRequest = { graph, settings, registry, capabilities, flattened: withParams({}) };
    const plan = compileGraph(request);
    assertCompiled(plan);
    const compiled = await backend.compile(plan);
    // The Output node's target, not the first resource the plan lists.
    const output = plan.outputs.find((o) => o.nodeId === outputNodeId && o.portId === "$target")
      ?? plan.outputs.find((o) => o.nodeId === outputNodeId);
    if (output === undefined) throw new Error(`the plan has no target for the Output node "${outputNodeId}"`);

    const feeds: Rig["feeds"] = new Map();
    for (const input of manifest.inputs) {
      const resource = plan.resources.find(
        (r): r is Extract<CompiledGraph["resources"][number], { kind: "externalTexture" }> =>
          r.kind === "externalTexture" && r.sourceId === input.mediaKey,
      );
      if (resource === undefined) { log(`input ${input.id}: ${input.mediaKey} is not in the plan (pruned?)`); continue; }
      const size = resource.size;
      const black = new Uint8Array(size[0] * size[1] * 4);
      const feed = { frameId: 0, bytes: black, size, black };
      feeds.set(input.mediaKey, feed);
      backend.registerMediaSource(input.mediaKey, { currentFrame: () => ({ frameId: feed.frameId, bytes: feed.bytes }) });
    }
    const stillsFed = feedStills(backend, plan, feeds);
    for (const [id, mesh] of meshes) {
      const ids = meshSourceIdsFor(id);
      backend.registerMediaSource(ids.points, { currentFrame: () => ({ frameId: 1, bytes: mesh.points }) });
      backend.registerMediaSource(ids.indices, { currentFrame: () => ({ frameId: 1, bytes: mesh.indices }) });
    }

    const rig: Rig = {
      key: `${width}x${height}`, width, height, backend, capabilities, base: plan, outputId: output.resourceId, stillsFed,
      animator: createUniformAnimator(), pointer: createPointerSource(), frame: frameAt(0), feeds,
      driver: undefined as never,
    };
    const transport: TransportSource = { next: () => rig.frame, reset() {}, resetAbsolute() {} } as TransportSource;
    (rig as { driver: Rig["driver"] }).driver = createFrameDriver({
      backend, transport, pointer: rig.pointer, resolution: () => [width, height],
    });
    rig.driver.setPlan(compiled);
    return rig;
  }

  async function rigFor(width: number, height: number): Promise<Rig> {
    const key = `${width}x${height}`;
    let rig = rigs.get(key);
    if (rig !== undefined) {
      rigs.delete(key);
      rigs.set(key, rig); // most recently used last
      return rig;
    }
    while (rigs.size >= maxSizes) {
      const [oldKey, old] = rigs.entries().next().value as [string, Rig];
      rigs.delete(oldKey);
      old.backend.dispose();
      log(`released the ${oldKey} program`);
    }
    const started = performance.now();
    rig = await buildRig(width, height);
    rigs.set(key, rig);
    log(`built the ${key} program in ${(performance.now() - started).toFixed(0)} ms`);
    return rig;
  }

  async function render(request: RenderRequest): Promise<RenderedFrame> {
    const rig = await rigFor(request.width, request.height);
    const index = Math.max(0, Math.round(request.frame));
    rig.frame = frameAt(index);

    // The layers: a new frameId every render, so the backend uploads what the effect sent.
    feedFrameId += 1;
    for (const input of manifest.inputs) {
      const feed = rig.feeds.get(input.mediaKey);
      if (feed === undefined) continue;
      const image = request.inputs[input.id];
      const [w, h] = feed.size;
      if (image === undefined) feed.bytes = feed.black;
      else if (image.width === w && image.height === h) feed.bytes = image.bytes.subarray(0, w * h * 4);
      else feed.bytes = resample(image, w, h, (feed.scratch ??= new Uint8Array(w * h * 4)));
      feed.frameId = feedFrameId;
    }

    // The values: value graph at this frame, values-only compile, push what moved.
    const patched = withParams(request.params);
    const settings = { ...document.settings, outputResolution: { width: rig.width, height: rig.height } };
    const evaluated = valueSession.evaluate(patched.graph as never, rig.frame as never, {
      pointer: rig.pointer.state,
      flattening: {
        morphs,
        instanceChannels: patched.instanceChannels ?? NO_INSTANCES,
        instancePages: patched.instancePages ?? NO_PAGES,
      },
    } as never);
    const next = compileGraph({
      graph, settings, registry, capabilities: rig.capabilities, flattened: patched,
      resolution: { frame: rig.frame, channels: evaluated.resolver },
    } as never);
    if (rig.animator.push(rig.backend as never, rig.base, next) === null) {
      // A structural change (a value that adds or removes a pass): rebuild the program.
      assertCompiled(next);
      log(`frame ${index}: structural change, recompiling`);
      feedStills(rig.backend, next, rig.feeds, rig.stillsFed);
      rig.driver.setPlan(await rig.backend.compile(next));
      rig.base = next;
      rig.animator.reset();
    }

    rig.driver.step();
    const out = await rig.backend.readOutput(rig.outputId);
    if (out.width !== rig.width || out.height !== rig.height || out.format !== "rgba16float") {
      throw new Error(`output is ${out.width}x${out.height} ${out.format}; expected ${rig.width}x${rig.height} rgba16float`);
    }
    return { bytes: out.bytes, width: out.width, height: out.height };
  }

  return {
    gpu: gpuName,
    render,
    async warm(width, height) { await rigFor(width, height); },
    dispose() { for (const rig of rigs.values()) rig.backend.dispose(); rigs.clear(); },
  };
}
