import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseFfglManifest, type FfglManifest } from "../../../nodes/definitions/ffgl-manifest.ts";
import { flipRows } from "./images.ts";
import { controlsOf } from "./study.ts";
import type { FfglStudyBackend, LoadedStudyEffect, StudyFrameCost, StudyImage, StudyResult, StudyRun } from "./types.ts";

/**
 * VN91 backend (b): Loom's native FFGL host (VN85), driven directly through the study build of
 * the addon, in this process. It measures the native part of the path: the row-flip blit, the
 * plugin and the GL finish. The page's two hops (OSR capture into an IOSurface, the import back
 * into WebGPU) are measured by the desktop test, which has a page.
 */
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const source = fileURLToPath(new URL("../../../devices/native/ffgl-host.mm", import.meta.url));

interface NativeTable {
  id: string; name: string; version: string; parameters: unknown[]; loadMs: number;
  clock: { mode: "host" | "wallclock" | "none" }; instance: string;
}
interface NativeFrame { handle: Uint8Array; leaseId: string; width: number; height: number; timing: { cpuMs: number; gpuMs: number; blitMs: number } }
export interface NativeStudyAddon {
  probe(binary: string): Promise<NativeTable>;
  open(binary: string, width: number, height: number, seed?: number): Promise<NativeTable>;
  process(instance: string, surface: Uint8Array, frame: { time: number; bpm: number; barPhase: number; parameters: [number, StudyValueNative][]; pulses: number[] }): Promise<NativeFrame>;
  release(lease: string): void;
  close(instance: string): Promise<void>;
  diagnostics(): { instances: number; libraries: number; leases: number; maxRssBytes: number };
  createStudySurface(width: number, height: number, rgba: Uint8Array): Uint8Array;
  readStudySurface(handle: Uint8Array): Uint8Array;
  destroyStudySurface(handle: Uint8Array): void;
}
type StudyValueNative = number | boolean | string;

/** Builds (once per source revision) and loads the study addon from `.cache/ffgl-study/`. */
export async function loadStudyAddon(): Promise<NativeStudyAddon> {
  const revision = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 16);
  const directory = join(root, ".cache", "ffgl-study", revision);
  const addon = join(directory, "ffgl-host-study.node");
  if (!existsSync(addon)) {
    mkdirSync(directory, { recursive: true });
    const build = "../../../devices/native/ffgl-build.mjs";
    const { buildFfglHost } = (await import(build)) as { buildFfglHost(directory: string, options: { study: boolean }): string };
    buildFfglHost(directory, { study: true });
  }
  return require(addon) as NativeStudyAddon;
}

/** Plugin folders: LOOM_FFGL_PLUGIN_DIRS (colon-separated) or the development default (VN90 will feed this). */
export function studyPluginFolders(): string[] {
  const { defaultFfglPluginFolders } = require("../../ffgl-plugins.cjs") as { defaultFfglPluginFolders(o: { repoRoot: string; home: string }): string[] };
  const configured = process.env["LOOM_FFGL_PLUGIN_DIRS"];
  return configured ? configured.split(":").filter(Boolean) : defaultFfglPluginFolders({ repoRoot: root, home: homedir() });
}
export function resolveStudyPlugin(name: string): string {
  const { resolveFfglPlugins, findFfglPlugin } = require("../../ffgl-plugins.cjs") as {
    resolveFfglPlugins(folders: string[]): unknown; findFfglPlugin(resolved: unknown, name: string): { binary: string } | undefined };
  const folders = studyPluginFolders();
  const found = findFfglPlugin(resolveFfglPlugins(folders), name);
  if (!found) throw new Error(`FFGL plugin ${name} is not in ${folders.join(", ")} (set LOOM_FFGL_PLUGIN_DIRS)`);
  return found.binary;
}

export function manifestOf(table: NativeTable): FfglManifest {
  return parseFfglManifest({ format: 1, id: table.id, name: table.name, version: table.version, parameters: table.parameters });
}

export function createNativeBackend(options: { seed?: number } = {}): FfglStudyBackend {
  let addon: NativeStudyAddon | undefined;
  const ensure = async () => (addon ??= await loadStudyAddon());
  return {
    id: "native",
    label: "Loom native FFGL host (VN85)",
    async available() {
      if (process.platform !== "darwin" || process.arch !== "arm64") return { ok: false, reason: "needs Apple Silicon macOS" };
      try { await ensure(); return { ok: true }; } catch (error) { return { ok: false, reason: String(error) }; }
    },
    async load(plugin, size): Promise<LoadedStudyEffect> {
      const host = await ensure();
      const binary = resolveStudyPlugin(plugin);
      const started = performance.now();
      const table = await host.open(binary, size.width, size.height, options.seed ?? 0);
      const loadMs = performance.now() - started;
      const manifest = manifestOf(table);
      const indexOf = (name: string) => {
        const found = manifest.parameters.find(parameter => parameter.name === name);
        if (!found) throw new Error(`${plugin} has no parameter named ${name}`);
        return found.index;
      };
      let disposed = false;
      return {
        manifest, loadMs, controls: controlsOf(manifest),
        capabilities: { clock: table.clock.mode, deterministic: table.clock.mode !== "wallclock", gpuTiming: true, exactInput: true },
        async render(run: StudyRun): Promise<StudyResult> {
          if (disposed) throw new Error("Native study effect is disposed");
          const frames: StudyImage[] = [], costs: StudyFrameCost[] = [];
          let input = run.input;
          let surface = host.createStudySurface(input.width, input.height, input.rgba);
          try {
            for (let i = 0; i < run.steps.length; i++) {
              const step = run.steps[i]!;
              if (step.input && step.input !== input) {
                host.destroyStudySurface(surface);
                input = step.input;
                surface = host.createStudySurface(input.width, input.height, input.rgba);
              }
              const parameters = Object.entries(step.params ?? {}).map(([name, value]) => [indexOf(name), value] as [number, StudyValueNative]);
              const result = await host.process(table.instance, surface, { time: step.time, bpm: step.bpm, barPhase: step.barPhase,
                parameters, pulses: (step.pulses ?? []).map(indexOf) });
              try {
                if (run.capture === "each" || i === run.steps.length - 1)
                  frames.push(flipRows({ width: result.width, height: result.height, rgba: new Uint8Array(host.readStudySurface(result.handle)) }));
              } finally { host.release(result.leaseId); }
              costs.push({ cpuMs: result.timing.cpuMs, gpuMs: result.timing.gpuMs,
                hops: ["input IOSurface -> GL_TEXTURE_2D (row-flip blit)", "plugin -> output IOSurface", "glFinish"] });
            }
          } finally { host.destroyStudySurface(surface); }
          return { frames, costs };
        },
        async dispose() { if (!disposed) { disposed = true; await host.close(table.instance); } },
      };
    },
    async dispose() { /* the addon stays loaded for the process; instances are closed by their effects */ },
  };
}
