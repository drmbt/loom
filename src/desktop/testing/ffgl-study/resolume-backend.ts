import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng } from "./images.ts";
import { McpClient } from "./mcp-client.ts";
import type { FfglStudyBackend, LoadedStudyEffect, StudyControl, StudyImage, StudyRegion, StudyResult, StudyRun } from "./types.ts";

/**
 * VN91 backend (a): the Resolume oracle. The plugin runs inside Resolume Arena, driven through
 * Arena's own MCP server, and its output is read back as native-pixel crops of the composition
 * (monitor.inspect, 200x112 PNG each) at the corners, the edge midpoints and the centre.
 *
 * OPT-IN: only with LOOM_FFGL_ORACLE=1 (cli.ts). SAFETY: it writes ONLY into a composition whose
 * name is LOOM_FFGL_ORACLE_COMPOSITION (default "1920 empty", a 3840x2160 empty comp), on
 * layer 1 column 1, and it never saves, opens or creates a composition (McpClient refuses).
 * Opening the study composition and restoring the show afterwards are a person's steps:
 * docs/ffgl-study-2026-10-08.md, "Re-running the Resolume oracle".
 *
 * What it cannot do, and the harness accounts for: set the plugin's time (Arena runs its own
 * clock, so only clock-free cases are compared), read the raw FFGL table (Arena presents
 * controls: an HSBA quad as one colour, names cut to 16 characters), or capture whole frames.
 */
const ARENA_NAMES: Readonly<Record<string, { effect?: string; source?: string }>> = {
  VignettePlus: { effect: "VignettePlus" },
  StylizedGrain: { effect: "StylizedGrain" },
  glitch_mosher: { effect: "glitch_mosher" },
  ToxicCRT: { effect: "CamFX ToxicCRT" },
  FigletText: { source: "Figlet ANSI Text" },
};
const SAMPLE_POINTS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [0.5, 0], [1, 0], [0, 0.5], [0.5, 0.5], [1, 0.5], [0, 1], [0.5, 1], [1, 1]];
const LINE = /^\s*(video\/(?:effect\d+|source)\/)(.+?): (.*?) \[(\w+)\](?: \(parameter: (\d+)\))?\s*$/;

interface ArenaParameter { readonly path: string; readonly name: string; readonly kind: string; readonly value: string; readonly min?: number; readonly max?: number }

export function parseArenaParameters(text: string, prefix: string): ArenaParameter[] {
  const parameters: ArenaParameter[] = [];
  for (const line of text.split("\n")) {
    const match = LINE.exec(line);
    if (!match || match[1] !== prefix) continue;
    const name = match[2]!;
    // Arena's own per-effect Opacity mixer is not a plugin parameter.
    if (prefix.startsWith("video/effect") && name === "Opacity") continue;
    const range = /\((-?[\d.]+)-(-?[\d.]+)\)/.exec(match[3]!);
    parameters.push({ path: `${match[1]}${name}`, name, kind: match[4]!, value: match[3]!,
      ...(range ? { min: Number(range[1]), max: Number(range[2]) } : {}) });
  }
  return parameters;
}
function controlOf(parameter: ArenaParameter): StudyControl {
  const range = /\((-?[\d.]+)-(-?[\d.]+)\)/.exec(parameter.value);
  const options = /\((\d+) options\)/.exec(parameter.value);
  switch (parameter.kind) {
    case "range": return { label: parameter.name, kind: "float", ...(range ? { min: Number(range[1]), max: Number(range[2]) } : {}) };
    case "boolean": return { label: parameter.name, kind: "toggle" };
    case "event": return { label: parameter.name, kind: "pulse" };
    case "choice": return { label: parameter.name, kind: "menu", ...(options ? { options: Number(options[1]) } : {}) };
    case "color": return { label: parameter.name, kind: "color" };
    case "text": case "string": return { label: parameter.name, kind: "text" };
    default: return { label: parameter.name, kind: "other" };
  }
}

export function createResolumeBackend(options: { composition?: string; settleMs?: number } = {}): FfglStudyBackend {
  const composition = options.composition ?? process.env["LOOM_FFGL_ORACLE_COMPOSITION"] ?? "1920 empty";
  const settleMs = options.settleMs ?? 400;
  const directory = fileURLToPath(new URL("../../../../.cache/ffgl-study/oracle/", import.meta.url));
  let client: McpClient | undefined;
  const connect = async () => (client ??= await McpClient.connect());
  const guard = async (mcp: McpClient) => {
    const overview = await mcp.text("composition", { action: "get" });
    const open = /Composition "([^"]+)"/.exec(overview)?.[1];
    if (open !== composition) throw new Error(`The Resolume oracle writes only into "${composition}"; Arena has "${open}" open`);
  };
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  return {
    id: "resolume",
    label: `Resolume Arena oracle (composition "${composition}")`,
    async available() {
      if (process.env["LOOM_FFGL_ORACLE"] !== "1") return { ok: false, reason: "opt-in: set LOOM_FFGL_ORACLE=1" };
      try { await guard(await connect()); return { ok: true }; } catch (error) { return { ok: false, reason: String(error) }; }
    },
    async load(plugin, size): Promise<LoadedStudyEffect> {
      const names = ARENA_NAMES[plugin];
      if (!names) throw new Error(`No Arena name recorded for ${plugin}`);
      const mcp = await connect();
      await guard(mcp);
      const started = performance.now();
      const where = { layer: 1, column: 1 };
      let cardPath: string | undefined;
      const openClip = async (card: StudyImage) => {
        mkdirSync(directory, { recursive: true });
        cardPath = join(directory, `input-${card.width}x${card.height}-${Date.now()}.png`);
        writeFileSync(cardPath, encodePng(card));
        if (names.source) await mcp.tool("clip", { action: "open", source_name: names.source, ...where, trigger: true });
        else await mcp.tool("clip", { action: "open", file_path: cardPath, ...where, effects: [names.effect], trigger: true });
        await mcp.tool("parameter", { action: "set", target: "layer", parameter: "video/opacity", value: 1, layer: 1 });
        for (let i = 0; i < 50; i++) {
          if (/connected: Connected/.test(await mcp.text("clip", { action: "get", ...where }))) return;
          await wait(100);
        }
        throw new Error(`Arena did not start the ${plugin} clip`);
      };
      const prefix = names.source ? "video/source/" : "video/effect2/";
      const describe = async () => parseArenaParameters(await mcp.text("clip", { action: "get", ...where }), prefix);
      const { testCard } = await import("./images.ts");
      await openClip(testCard(size.width, size.height));
      const parameters = await describe();
      const loadMs = performance.now() - started;
      const capture = async (): Promise<{ frame: StudyImage; coverage: StudyRegion[] }> => {
        const rgba = new Uint8Array(size.width * size.height * 4), coverage: StudyRegion[] = [];
        for (const [x, y] of SAMPLE_POINTS) {
          const result = await mcp.tool("monitor", { action: "inspect", x, y, format: "png" });
          const where = /Inspect \((\d+)x(\d+) at (\d+),(\d+) from (\d+)x(\d+)\)/.exec(result.content.map(c => c.text ?? "").join(" "));
          const image = result.content.find(c => c.type === "image" && c.data);
          if (!where || !image?.data) throw new Error("Arena's inspect returned no located image");
          if (Number(where[5]) !== size.width || Number(where[6]) !== size.height) throw new Error(`Arena's composition is ${where[5]}x${where[6]}, the study ran ${size.width}x${size.height}`);
          const crop = decodePng(Buffer.from(image.data, "base64"));
          const region = { x: Number(where[3]), y: Number(where[4]), width: crop.width, height: crop.height };
          for (let row = 0; row < crop.height; row++)
            rgba.set(crop.rgba.subarray(row * crop.width * 4, (row + 1) * crop.width * 4), ((region.y + row) * size.width + region.x) * 4);
          coverage.push(region);
        }
        return { frame: { width: size.width, height: size.height, rgba }, coverage };
      };
      return {
        loadMs, controls: parameters.map(controlOf),
        capabilities: { clock: "wallclock", deterministic: false, gpuTiming: false, exactInput: false },
        async render(run: StudyRun): Promise<StudyResult> {
          await guard(mcp);
          const frames: StudyImage[] = [];
          let coverage: StudyRegion[] = [];
          // What Arena feeds the plugin: the same clip with the effect bypassed.
          let inputSeen: StudyImage | undefined;
          if (names.effect) {
            await mcp.tool("effect", { action: "bypass", target: "clip", ...where, offset: 2, bypassed: true });
            await wait(settleMs);
            inputSeen = (await capture()).frame;
            await mcp.tool("effect", { action: "bypass", target: "clip", ...where, offset: 2, bypassed: false });
          }
          for (let i = 0; i < run.steps.length; i++) {
            const step = run.steps[i]!;
            if (step.input && i > 0) throw new Error("The Resolume oracle cannot change its input mid-run");
            for (const [name, value] of Object.entries(step.params ?? {})) {
              const parameter = parameters.find(p => p.name === name.slice(0, 16) || p.name === name);
              if (!parameter) throw new Error(`Arena shows no parameter ${name} on ${plugin}`);
              if (parameter.kind === "color") throw new Error(`Colour writes to Arena are not mapped yet (${name})`);
              // The study speaks FFGL wire values (normalised 0..1); Arena's API takes the value
              // in the range the plugin declares (Figlet's Speed is -1..1, Morph 0..10).
              const shown = parameter.kind === "range" && typeof value === "number" && parameter.min !== undefined && parameter.max !== undefined
                ? parameter.min + value * (parameter.max - parameter.min) : value;
              await mcp.tool("parameter", parameter.kind === "choice"
                ? { action: "set", target: "clip", parameter: parameter.path, choice_index: Number(value), ...where }
                : { action: "set", target: "clip", parameter: parameter.path, value: shown, ...where });
            }
            for (const name of step.pulses ?? []) {
              const parameter = parameters.find(p => p.name === name);
              if (!parameter) throw new Error(`Arena shows no event ${name} on ${plugin}`);
              await mcp.tool("parameter", { action: "set", target: "clip", parameter: parameter.path, value: true, ...where });
            }
            await wait(settleMs);
            if (run.capture === "each" || i === run.steps.length - 1) {
              const captured = await capture();
              frames.push(captured.frame); coverage = captured.coverage;
            }
          }
          return { frames, costs: frames.map(() => ({ cpuMs: Number.NaN, hops: ["Arena clip -> effect -> layer -> composition", "monitor.inspect PNG crop"] })), coverage,
            ...(inputSeen ? { inputSeen } : {}) };
        },
        async dispose() {
          await guard(mcp);
          await mcp.tool("clip", { action: "clear", ...where });
        },
      };
    },
    async dispose() { client?.close(); client = undefined; },
  };
}
