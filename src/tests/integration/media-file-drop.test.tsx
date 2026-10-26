// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { KeymapProvider } from "@editor/keymap/index.ts";
import { movieWithCodec } from "@editor/media-drop/testing.ts";
import { conformsToKind } from "@domain/graph/node-kinds.ts";
import type { CommandStatus } from "@domain/types/commands.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { AppRuntimeContext } from "../../app/app-context.ts";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import { GraphPane } from "../../app/graph-pane.tsx";
import type { GraphActions } from "../../app/graph-pane.tsx";

/**
 * VN99 — video, still and audio files dropped on the canvas, through the real pane, the
 * real app runtime and the real bus. What is asserted is what the document holds after the
 * drop (the node, its file, its name, its play mode) and what one undo leaves.
 *
 * jsdom has no File System Access and no IndexedDB, so the drop takes the session `blob:`
 * fallback here; the retained-handle path is `media-drop.test.ts`'s.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
  const url = URL as unknown as { createObjectURL?: (blob: Blob) => string };
  let minted = 0;
  url.createObjectURL ??= () => `blob:test/${++minted}`;
});
afterEach(cleanup);

type Refusal = { status: CommandStatus; diagnostics: RuntimeDiagnostic[] };

function newRuntime(): AppRuntime {
  return createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester" } });
}

async function mountCanvas(runtime: AppRuntime) {
  const refusals: Refusal[] = [];
  const view = await act(async () =>
    render(
      <AppRuntimeContext.Provider value={runtime}>
        <KeymapProvider bus={runtime.bus} invocationContext={runtime.invocation}>
          <GraphPane
            selection={[]}
            onSelectionChange={() => {}}
            onHoveredNodeChange={() => {}}
            portDrag={null}
            onPortDragChange={() => {}}
            onPatchResult={() => {}}
            onCommandRefused={(result) => refusals.push(result)}
            actionsRef={createRef<GraphActions | null>()}
          />
        </KeymapProvider>
      </AppRuntimeContext.Provider>,
    ),
  );
  const surface = view.container.querySelector('[data-keymap-context="graph"]');
  if (surface === null) throw new Error("expected the graph surface");
  return { surface, refusals };
}

async function drop(surface: Element, ...files: File[]): Promise<boolean> {
  let notPrevented = true;
  const dataTransfer = { dropEffect: "none", effectAllowed: "all", files, types: ["Files"], getData: () => "", setData: () => {} };
  await act(async () => {
    notPrevented = fireEvent.drop(surface, { dataTransfer, clientX: 40, clientY: 30 });
    for (let tick = 0; tick < 6; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return notPrevented;
}

const nodesOf = (runtime: AppRuntime) =>
  Object.values(runtime.bus.store.getGraph().nodes).sort((a, b) => a.position.x - b.position.x);

describe("dropping media files on the canvas (VN99)", () => {
  it("a video, a still and an audio file become three nodes side by side, in one undoable patch", async () => {
    const runtime = newRuntime();
    const before = runtime.bus.store.getGraph();
    const { surface, refusals } = await mountCanvas(runtime);

    const prevented = !(await drop(
      surface,
      new File([movieWithCodec("avc1")], "Opening Shot.mp4", { type: "video/mp4" }),
      new File(["\u0089PNG"], "logo.png", { type: "image/png" }),
      new File(["RIFF"], "kick loop.wav", { type: "audio/wav" }),
    ));

    expect(prevented).toBe(true);
    expect(refusals).toEqual([]);
    const nodes = nodesOf(runtime);
    expect(nodes.map((node) => [node.type, node.label])).toEqual([
      ["movieFileIn", "movie_opening_shot"],
      ["movieFileIn", "movie_logo"],
      ["audioFileIn", "audiofile_kick_loop"],
    ]);
    expect(nodes.every((node) => conformsToKind(node.label ?? "", node.type === "audioFileIn" ? "audiofile" : "movie"))).toBe(true);
    // Each holds its own file, by the name the picker would have written into the fragment.
    expect(nodes.map((node) => String(node.parameters["file"]).split("#")[1])).toEqual([
      "Opening%20Shot.mp4",
      "logo.png",
      "kick%20loop.wav",
    ]);
    // Locked to the timeline; a still has no transport, so it keeps the default.
    expect(nodes.map((node) => node.parameters["playMode"])).toEqual(["timeline", "freeRun", "timeline"]);
    // Side by side at one height.
    expect(new Set(nodes.map((node) => node.position.y)).size).toBe(1);
    expect(nodes[1]!.position.x).toBeGreaterThan(nodes[0]!.position.x);

    // ONE undo takes the whole drop away.
    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    });
    expect(Object.keys(runtime.bus.store.getGraph().nodes)).toEqual(Object.keys(before.nodes));
  });

  it("refuses a ProRes .mov by codec, saying transcode first, and still makes the playable file of the same drop", async () => {
    const runtime = newRuntime();
    const { surface, refusals } = await mountCanvas(runtime);

    await drop(
      surface,
      new File([movieWithCodec("apcn")], "master.mov", { type: "video/quicktime" }),
      new File(["ID3"], "track.mp3", { type: "audio/mpeg" }),
    );

    expect(nodesOf(runtime).map((node) => node.label)).toEqual(["audiofile_track"]);
    const diagnostics = refusals.flatMap((each) => each.diagnostics);
    expect(diagnostics.map((each) => each.code)).toEqual(["media.drop.transcodeFirst"]);
    expect(diagnostics[0]!.message).toContain("Apple ProRes 422 (apcn)");
    expect(diagnostics[0]!.message).toContain("Transcode it first");
  });
});
