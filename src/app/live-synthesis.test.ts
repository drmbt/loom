import { describe, expect, it } from "vitest";

import { compileGraph } from "@compiler/index.ts";
import type { ResolvedOutput } from "@compiler/index.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { DEFAULT_PREVIEW_VIEW, createPreviewSystem } from "@runtime/previews/index.ts";
import type { PreviewFrameCommand, PreviewRequest, PreviewRuntimeHost } from "@runtime/previews/index.ts";
import { createLiveSynthesis } from "./live-synthesis.ts";

/**
 * T1655b — A CAMERA, LIGHT OR MATERIAL TILE DRAWS ITS NODE'S NEWEST VALUES.
 *
 * Measured in the real app before this: Eye typed into the inspector, or dragged with the
 * camera gizmo, changed the document and not one pixel of the camera's own tile; the same
 * for a light's Intensity and a material's Roughness. The tiles read the INSTALLED plan's
 * rows, and a values-only edit is never a new install (T1163, §V16), so the descriptor the
 * edit minted (B176's own fix) reached nothing.
 *
 * These go through the real compiler and the real preview system and assert what the tile
 * is PUSHED, not that a function was called: the consumer of this module is a uniform block.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
} as never;

const cameraGraph = (eye: readonly number[], extra: Record<string, unknown> = {}): GraphDocument =>
  ({
    revision: 1,
    nodes: {
      cam: {
        id: "cam",
        type: "camera",
        definitionVersion: registry.get("camera")?.version ?? 1,
        position: { x: 0, y: 0 },
        parameters: { eye, ...extra },
        label: "camera_shot",
      } as never as GraphNode,
    },
    edges: {},
    groups: {},
  }) as never;

/** The camera's own row, compiled with a preview sink on it: the stock scene through its matrix. */
function rowAt(eye: readonly number[], extra: Record<string, unknown> = {}): { rows: ReadonlyArray<ResolvedOutput>; row: ResolvedOutput } {
  const compiled = compileGraph({
    graph: cameraGraph(eye, extra),
    settings: SETTINGS,
    registry,
    capabilities: CAPABILITIES,
    sinks: [{ nodeId: "cam", portId: "out", kind: "preview" as const }],
  } as never);
  const row = compiled.outputs.find((output) => output.nodeId === "cam" && output.synthesis !== undefined);
  if (row === undefined) throw new Error("the camera compiled no synthesized row");
  return { rows: compiled.outputs, row };
}

const PASS = "cam#scenePreview:out";
const matrixOf = (row: ResolvedOutput): unknown => row.synthesis?.passes.find((pass) => pass.id === PASS)?.uniforms?.["viewProjection"];

describe("T1655b — the descriptor a tile is drawn with follows a values-only edit", () => {
  it("answers the installed descriptor until there is something newer", () => {
    const installed = rowAt([0, 0.5, 3]);
    let live: ReadonlyArray<ResolvedOutput> | null = null;
    const synthesis = createLiveSynthesis(() => live);
    expect(synthesis.of(installed.row)).toBe(installed.row.synthesis);
    // An install: the live rows ARE the installed rows.
    live = installed.rows;
    expect(synthesis.of(installed.row)).toBe(installed.row.synthesis);
  });

  it("⚑ after a values-only edit, answers the EDIT's values for the row the program was built from", () => {
    const installed = rowAt([0, 0.5, 3]);
    const edit = rowAt([2, 0.5, 3]);
    // The premise: the edit moved the one value the camera tile is entirely about.
    expect(matrixOf(edit.row)).not.toEqual(matrixOf(installed.row));
    const synthesis = createLiveSynthesis(() => edit.rows);
    const answer = synthesis.of(installed.row);
    expect(answer?.passes.find((pass) => pass.id === PASS)?.uniforms?.["viewProjection"]).toEqual(matrixOf(edit.row));
  });

  it("keeps ONE identity while the values stand still, so an idle tick rebuilds nothing", () => {
    /*
     * The preview system rebuilds its program description when a descriptor's identity
     * moves (T1241, measured at ~150 ms per 5 s when it happened every tick). Every
     * values-only compile mints fresh row objects, including for the rows it did not touch,
     * so "newest object" would be a rebuild per edit of ANY parameter in the document.
     */
    const installed = rowAt([0, 0.5, 3]);
    let live = rowAt([2, 0.5, 3]).rows;
    const synthesis = createLiveSynthesis(() => live);
    const first = synthesis.of(installed.row);
    expect(synthesis.of(installed.row)).toBe(first);
    // Another edit somewhere else: new row objects, the same camera values.
    live = rowAt([2, 0.5, 3]).rows;
    expect(synthesis.of(installed.row)).toBe(first);
    // An edit that puts the camera back where the installed plan had it: the installed one.
    live = rowAt([0, 0.5, 3]).rows;
    expect(synthesis.of(installed.row)).toBe(installed.row.synthesis);
    // And a real move is a new identity, which is what makes the system push it.
    live = rowAt([4, 0.5, 3]).rows;
    expect(synthesis.of(installed.row)).not.toBe(first);
  });

  it("never hands the installed program a descriptor of a different shape", () => {
    // A live row that is not a values-only variation of the installed one (it cannot happen
    // while the frame loop only records values-only pushes, and this is what holds if it
    // does): a pass the program was not built with must not be named to it.
    const installed = rowAt([0, 0.5, 3]);
    const edit = rowAt([2, 0.5, 3]);
    const reshaped: ResolvedOutput = {
      ...edit.row,
      synthesis: {
        ...edit.row.synthesis!,
        passes: edit.row.synthesis!.passes.map((pass) => ({ ...pass, vertexCount: (pass.vertexCount ?? 0) + 3 })),
      },
    };
    const synthesis = createLiveSynthesis(() => [reshaped]);
    expect(synthesis.of(installed.row)).toBe(installed.row.synthesis);
  });

  it("⚑ THE TILE IS PUSHED THE NEW MATRIX: installed row in, edited values out, through the preview system", () => {
    const installed = rowAt([0, 0.5, 3]);
    const edit = rowAt([2, 0.5, 3]);
    let live: ReadonlyArray<ResolvedOutput> | null = installed.rows;
    const synthesis = createLiveSynthesis(() => live);

    const commands: PreviewFrameCommand[] = [];
    const host: PreviewRuntimeHost = {
      setPreviewProgram() {},
      presentPreviews(command: PreviewFrameCommand) {
        commands.push(command);
      },
    } as never;
    const system = createPreviewSystem({ host, capacity: 4 });
    const frame = (index: number): FrameEvaluationInput => ({
      timeSeconds: index / 60,
      deltaSeconds: 1 / 60,
      frameIndex: index,
      mode: "realtime",
      randomSeed: 1,
    });
    /** What `useNodePreviews` builds each tick: always from the INSTALLED row. */
    const tick = (index: number): void => {
      const row = installed.row;
      const request = {
        ref: { nodeId: "cam", portId: "out" },
        source: { resourceId: row.resourceId, size: row.size, format: row.format, space: row.space },
        rect: { x: 10, y: 10, width: 192, height: 108 },
        area: { width: 192, height: 108 },
        visible: true,
        pinned: false,
        collapsed: false,
        occluded: false,
        view: DEFAULT_PREVIEW_VIEW,
        synthesis: synthesis.of(row),
      } as PreviewRequest;
      system.update({ requests: [request], frame: frame(index), surface: { x: 0, y: 0, width: 800, height: 600 }, devicePixelRatio: 2, previewFps: 15, previewLongEdge: 192 });
    };
    const pushed = (): unknown[] =>
      commands.flatMap((command) => (command.uniforms ?? []).filter((update) => update.passId === PASS).map((update) => update.values["viewProjection"]));

    tick(0);
    expect(pushed()).toEqual([matrixOf(installed.row)]);
    // The gizmo (or the inspector) writes Eye: a values-only compile, never a new install.
    live = edit.rows;
    tick(1);
    expect(pushed()).toEqual([matrixOf(installed.row), matrixOf(edit.row)]);
    // And nothing more is pushed while nothing moves.
    tick(2);
    expect(pushed()).toHaveLength(2);
  });
});
