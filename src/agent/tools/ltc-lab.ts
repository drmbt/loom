import { nodeNames } from "@domain/graph/names.ts";
import {
  bytesReader,
  listLtcLabTracks,
  ltcLabAudioPath,
  ltcLabTourPathFor,
  planLtcLabImport,
  sourceFromJson,
  sourceFromTar,
  type LtcLabImportReport,
  type LtcTrackSummary,
  type RangeReader,
  type SourceRead,
} from "@domain/import/ltc-lab/index.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";

import { importLtcLabInput } from "../schemas.ts";
import type { ImportLtcLabInput } from "../schemas.ts";
import { dispatchPatchCommand, failed, ok, result, type PatchToolData } from "../tool-support.ts";
import type { AgentTool, LocalFilesPort, ToolRuntime, ToolResult } from "../types.ts";

/**
 * VN100 — `import_ltc_lab`: one ltc-lab track (../ltc-lab) into the document, as ONE patch.
 *
 * The importer is `src/domain/import/ltc-lab` (pure); this is its door. It reads the show,
 * plans the track, binds the track's audio into the audio node's `file` the way
 * `attach_asset` does (an object URL with the name in the fragment), dispatches the whole
 * plan through `graph.applyPatch` (one undo step), and then sets the project's fps and
 * frame range through `project.setSettings` (a second, unless `setProjectSettings: false`).
 *
 * A `path` is read by the LOCAL HELPER's scoped port (`src/mcp/local-files.ts`). A page has
 * no such port, so in a browser-bridged session a path is refused by name and the bytes
 * come as `tarBase64`, or the show as `projectJson` (its audio is then bound by hand).
 */

export interface ImportLtcLabData {
  /** Without `trackId`: the show's tracks, nothing changed. */
  readonly tracks?: readonly LtcTrackSummary[];
  readonly patch?: PatchToolData;
  readonly names?: Readonly<Record<string, string | null>>;
  readonly audioBound?: boolean;
  readonly settingsApplied?: boolean;
  readonly startTimecode?: { readonly text: string; readonly fps: number; readonly frame: number | null };
  readonly report?: LtcLabImportReport;
}

const TOOL = "import_ltc_lab";

function base64Bytes(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

const portReader = (port: LocalFilesPort, path: string): RangeReader => ({
  size: () => port.size(path),
  read: (offset, length) => port.read(path, offset, length),
});

async function readWhole(port: LocalFilesPort, path: string): Promise<Uint8Array> {
  return port.read(path, 0, await port.size(path));
}

const utf8 = new TextDecoder("utf-8");

interface Loaded {
  readonly read: SourceRead;
  /** For a project.json on disk: the audio, read through the port once the track is known. */
  readonly audioFromDisk?: (audioDir: string, fileName: string) => Promise<Uint8Array | null>;
}

async function load(input: ImportLtcLabInput, runtime: ToolRuntime): Promise<Loaded | ToolResult<ImportLtcLabData>> {
  const given = [input.path, input.tarBase64, input.projectJson].filter((value) => value !== undefined).length;
  if (given !== 1) {
    return failed(TOOL, "ltcLab.input", "Give exactly one source: path, tarBase64, or projectJson (with tourJson).");
  }
  if (input.tarBase64 !== undefined) {
    const bytes = base64Bytes(input.tarBase64);
    if (bytes === null) return failed(TOOL, "ltcLab.input", "tarBase64 is not valid base64.");
    return { read: await sourceFromTar(bytesReader(bytes), input.trackId) };
  }
  if (input.projectJson !== undefined) return { read: sourceFromJson(input.projectJson, input.tourJson) };
  const path = input.path as string;
  const port = runtime.ports.localFiles;
  if (port === undefined) {
    return failed(TOOL, "ltcLab.input", "A path is read by the local helper only, and this session runs in a page.", {
      suggestion: "Pass the show's bytes as tarBase64, or its project.json as projectJson (and the tour as tourJson).",
    });
  }
  try {
    if (path.endsWith(".ltcshow.tar")) return { read: await sourceFromTar(portReader(port, path), input.trackId) };
    if (!path.endsWith("/project.json")) {
      return failed(TOOL, "ltcLab.input", "A path must name a .ltcshow.tar or an ltc-lab project.json.");
    }
    const project = utf8.decode(await readWhole(port, path));
    const tourPath = ltcLabTourPathFor(path);
    let tour: string | undefined;
    if (tourPath !== null) {
      try {
        tour = utf8.decode(await readWhole(port, tourPath));
      } catch {
        tour = undefined;
      }
    }
    return {
      read: sourceFromJson(project, tour),
      audioFromDisk: async (audioDir, fileName) => {
        try {
          return await readWhole(port, ltcLabAudioPath(audioDir, fileName));
        } catch {
          return null;
        }
      },
    };
  } catch (error) {
    return failed(TOOL, "ltcLab.readFailed", error instanceof Error ? error.message : "The local helper could not read the path.");
  }
}

/** Right of everything in the document, so the import lands on empty canvas. */
function freeOrigin(runtime: ToolRuntime): { x: number; y: number } {
  const nodes = Object.values(runtime.bus.store.getGraph().nodes);
  if (nodes.length === 0) return { x: 0, y: 0 };
  return { x: Math.max(...nodes.map((node) => node.position.x)) + 320, y: Math.min(...nodes.map((node) => node.position.y)) + 240 };
}

export const importLtcLab: AgentTool<ImportLtcLabInput, ImportLtcLabData> = {
  name: TOOL,
  title: "Import ltc-lab track",
  description:
    "Import ONE track of an ltc-lab show (a .ltcshow.tar, or a project.json and its tour) as one undoable patch: its audio as a timeline-locked Audio File In with the beat grid as declared tempo (named audiofile_reference when the document has no timeline reference media yet); its automation lanes on an Automation node (manual keys exact in ticks, generated onsets/level/figure lanes baked); its markers as a timeline-following Cue List over empty ltc_<marker> presets; and a note holding the start timecode and everything not imported. Then sets the project's fps and frame range to the show's unless setProjectSettings is false. Without trackId it lists the tracks and changes nothing. A path is read only by the local helper; from a page, pass tarBase64 or projectJson.",
  kind: "mutate",
  inputSchema: importLtcLabInput,
  requires: { commands: ["graph.applyPatch", "project.setSettings"] },
  capabilities: [],
  mutates: true,
  async run(input, runtime) {
    const loaded = await load(input, runtime);
    if (!("read" in loaded)) return loaded;
    const { read } = loaded;
    if (!read.ok) return failed(TOOL, "ltcLab.malformed", read.reason);
    if (input.trackId === undefined) return ok<ImportLtcLabData>(TOOL, { tracks: listLtcLabTracks(read.source) });

    const graph = runtime.bus.store.getGraph();
    const planned = planLtcLabImport(read.source, {
      trackId: input.trackId,
      origin: input.position ?? freeOrigin(runtime),
      existingNames: nodeNames(graph).keys(),
    });
    if (!planned.ok) return failed(TOOL, "ltcLab.malformed", planned.reason);
    const { plan } = planned;

    let audio = plan.audio.bytes;
    if (audio === null && loaded.audioFromDisk !== undefined && plan.audio.audioDir !== null) {
      audio = await loaded.audioFromDisk(plan.audio.audioDir, plan.audio.fileName);
    }
    let operations: readonly GraphPatchOperation[] = plan.operations;
    const audioBound = audio !== null && !runtime.dryRun;
    if (audioBound && audio !== null) {
      // The picker's shape, as attach_asset writes it: object URL + the name in the fragment.
      const url = `${URL.createObjectURL(new Blob([new Uint8Array(audio)], { type: plan.audio.mimeType }))}#${encodeURIComponent(plan.audio.fileName)}`;
      operations = operations.map((op) =>
        op.op === "addNode" && op.ref === plan.refs.audio ? { ...op, parameters: { ...op.parameters, file: url } } : op,
      );
    }

    const patched = await dispatchPatchCommand(
      TOOL,
      "graph.applyPatch",
      { baseRevision: input.baseRevision ?? (await runtime.revision()), label: `Import ltc-lab track`, operations: [...operations] },
      runtime,
    );
    const base: ImportLtcLabData = {
      ...(patched.data === null ? {} : { patch: patched.data }),
      names: plan.names,
      audioBound,
      startTimecode: plan.startTimecode,
      report: plan.report,
    };
    if (patched.status !== "ok") return result<ImportLtcLabData>(TOOL, patched.status, { ...base, settingsApplied: false }, patched);

    let settingsApplied = false;
    const diagnostics = [...patched.diagnostics];
    if (input.setProjectSettings !== false) {
      const settings = await runtime.execute<unknown>("project.setSettings", { settings: plan.settings });
      settingsApplied = settings.status === "applied";
      diagnostics.push(...settings.diagnostics);
    }
    return ok<ImportLtcLabData>(TOOL, { ...base, settingsApplied }, { diagnostics, revision: await runtime.revision(), undoGroupId: patched.undoGroupId });
  },
};

export const ltcLabTools: readonly AgentTool[] = [importLtcLab] as readonly AgentTool[];
