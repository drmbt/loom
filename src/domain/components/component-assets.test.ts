import { describe, expect, it } from "vitest";
import { flattenComponents } from "../../compiler/flatten.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry, type NodeRegistryView } from "../../nodes/registry/registry.ts";
import { alice, contextFor } from "../commands/test-support.ts";
import { createDomainBus } from "../commands/index.ts";
import type { LoomBus } from "../commands/bus.ts";
import { createGraphStore, type GraphStore } from "../graph/store.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import { pictureFileUrl } from "../media/picture-file.ts";
import type { GraphComponentDefinition } from "../types/components.ts";
import { registerComponentCommands } from "./commands.ts";
import { componentNodeType } from "./component-type.ts";
import type { ComponentFileWriter } from "./file-commands.ts";
import { createComponentSystem, type ComponentRegistry } from "./registry.ts";
import { graphOf, instanceNode, node } from "./test-support.ts";

/**
 * T1492b — an exported component and the files its internals read.
 *
 * MEASURED: a node's file is a URL string in an `asset` parameter (Movie File In's `file`),
 * inside the component's own graph; there is no asset table (`ProjectDocument.assets` is
 * always `[]`). So a URL that outlives the session travels with the definition and needs
 * nothing installed, and the file is part of the component's CONTENT — the §T1395b identity
 * rule decides a clash. The one reference that cannot travel is the object URL a picked
 * file is (`blob:`), which export refuses by name.
 *
 * On the SHIPPED node set, because Movie File In is the subject. What is read back is what
 * the media loader reads: the `file` of the movie node in the FLATTENED graph of the
 * document the component arrived in (`use-media-sources` reads exactly that, T615).
 */

const ctx = contextFor(alice);

const REMOTE = "https://media.example/takes/take3.mp4";
const OTHER = "https://media.example/takes/other.mp4";
/** What the file picker writes: an object URL with the file's name in the fragment. */
const PICKED = "blob:http://localhost:5173/3f2a9c1e#take3.mp4";

interface Doc {
  store: GraphStore;
  bus: LoomBus;
  components: ComponentRegistry;
  nodes: NodeRegistryView;
}

function documentWith(
  definitions: readonly GraphComponentDefinition[],
  writeFile?: ComponentFileWriter,
  retainsPickedFiles?: boolean,
): Doc {
  const store = createGraphStore({ ids: createSequentialIdFactory("d"), now: () => "2026-10-02T00:00:00.000Z" });
  const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view(), definitions);
  const { bus } = createDomainBus({ store, registry: system.nodes });
  registerComponentCommands(bus, {
    components: system.components,
    ...(writeFile === undefined ? {} : { writeFile }),
    ...(retainsPickedFiles === undefined ? {} : { retainsPickedFiles }),
  });
  return { store, bus, components: system.components, nodes: system.nodes };
}

/**
 * A component whose internals read `file`. The Text beside the movie says "blob:" in a
 * STRING parameter — a word, not a file — which the refusal must not mistake for one.
 */
function clipReading(file: string): GraphComponentDefinition {
  return {
    componentId: "clip",
    version: 1,
    name: "Clip",
    graph: graphOf([
      node("movie", "movieFileIn", { file }, { label: "clip1" }),
      node("title", "text", { text: "blob: is only a word here" }, { label: "title1", position: { x: 0, y: 200 } }),
    ]),
    inputs: [],
    outputs: [{ externalId: "out", label: "Out", nodeId: "movie", portId: "out" }],
    parameters: [],
  };
}

/** A component that NESTS the clip. */
function reelOverClip(): GraphComponentDefinition {
  return {
    componentId: "reel",
    version: 1,
    name: "Reel",
    graph: graphOf([instanceNode("take", "clip", 1)]),
    inputs: [],
    outputs: [{ externalId: "out", label: "Out", nodeId: "take", portId: "out" }],
    parameters: [],
  };
}

async function exportedText(source: Doc, componentId: string): Promise<string> {
  const result = await source.bus.execute("component.export", { componentId, destination: "text" }, ctx);
  expect(result.status, result.diagnostics.map((d) => d.message).join("; ")).toBe("applied");
  return result.output.text as string;
}

/** The files the media loader would open in `doc`: every movie node of its flattened graph. */
function filesRead(doc: Doc): string[] {
  const flat = flattenComponents({ graph: doc.store.view.getGraph(), registry: doc.nodes, components: doc.components.view() });
  return Object.values(flat.graph.nodes)
    .filter((each) => each.type === "movieFileIn")
    .map((each) => pictureFileUrl(each.parameters.file));
}

const catalogueOf = (components: ComponentRegistry): string[] =>
  components.all().map((each) => `${each.componentId}@${each.version}:${each.name}`);

describe("component.export carries the files its internals read (T1492b)", () => {
  it("a file a nested component reads resolves in a document that never had it", async () => {
    const text = await exportedText(documentWith([clipReading(REMOTE), reelOverClip()]), "reel");

    const target = documentWith([]);
    expect(filesRead(target)).toEqual([]);
    const imported = await target.bus.execute("component.import", { text }, ctx);

    expect(imported.status, imported.diagnostics.map((d) => d.message).join("; ")).toBe("applied");
    expect(catalogueOf(target.components)).toEqual(["clip@1:Clip", "reel@1:Reel"]);
    // Two components deep, and the loader's read is the file the component was built on.
    expect(filesRead(target)).toEqual([REMOTE]);
  });

  it("REFUSES BY NAME a file picked for this session only, wherever it nests, and writes nothing", async () => {
    let writes = 0;
    const source = documentWith([clipReading(PICKED), reelOverClip()], async (file) => {
      writes += 1;
      return { kind: "saved", fileName: file.fileName };
    });

    const direct = await source.bus.execute("component.export", { componentId: "clip" }, ctx);
    expect(direct.status).toBe("rejected");
    // ONE refusal: the movie's file. The Text that merely says "blob:" is not a file.
    expect(direct.diagnostics.map((d) => d.code)).toEqual(["component.export.sessionAsset"]);
    expect(direct.diagnostics[0]?.message).toBe(
      '"Clip" was not exported: "clip1" in "Clip" reads "take3.mp4", a file picked for this session only, which no other document could open.',
    );

    // Exporting what NESTS it is refused too, naming the component that holds the node.
    const nested = await source.bus.execute("component.export", { componentId: "reel" }, ctx);
    expect(nested.status).toBe("rejected");
    expect(nested.diagnostics[0]?.message).toContain('"Reel" was not exported: "clip1" in "Clip" reads "take3.mp4"');

    // Every door: the agent's text destination hands back no bytes, a dry run says so too.
    const asText = await source.bus.execute("component.export", { componentId: "reel", destination: "text" }, ctx);
    expect(asText.status).toBe("rejected");
    expect(asText.output.text).toBeNull();
    const dry = await source.bus.execute("component.export", { componentId: "reel" }, { ...ctx, dryRun: true });
    expect(dry.status).toBe("rejected");
    expect(writes).toBe(0);
  });

  it("T1519b: the refusal names the fix — pick the file again where the picker retains it, session-only where it cannot", async () => {
    // A File System Access host: choosing the file again stores a reference to it on disk,
    // which an export carries — the person is told exactly that, and where to do it.
    const retaining = documentWith([clipReading(PICKED), reelOverClip()], undefined, true);
    const there = await retaining.bus.execute("component.export", { componentId: "reel", destination: "text" }, ctx);
    expect(there.status).toBe("rejected");
    expect(there.diagnostics[0]?.suggestion).toBe(
      'Enter "Clip" and choose "take3.mp4" again with the file picker on File of "clip1": it is then kept as a reference to the file on disk, which an export carries. Then export again.',
    );

    // A host without File System Access: picking again would mint another session URL, so
    // the advice must not send the person round that loop — it says session-only here.
    const sessionOnly = documentWith([clipReading(PICKED), reelOverClip()], undefined, false);
    const here = await sessionOnly.bus.execute("component.export", { componentId: "reel", destination: "text" }, ctx);
    expect(here.status).toBe("rejected");
    expect(here.diagnostics[0]?.suggestion).toBe(
      'This browser has no File System Access, so a picked file is session-only here and cannot be exported. Clear File on "clip1" or point it at a URL, or pick the file in Chromium or the desktop app, then export again.',
    );
    expect(here.diagnostics[0]?.suggestion).not.toContain("choose");
  });

  it("the file is the component's content: the same one is reused, a different one arrives as clip1", async () => {
    const text = await exportedText(documentWith([clipReading(REMOTE)]), "clip");

    // Same id, same file: the SAME component. Nothing installed, no duplicate.
    const same = documentWith([clipReading(REMOTE)]);
    const reused = await same.bus.execute("component.import", { text }, ctx);
    expect(reused.output.reused).toEqual([{ componentId: "clip", version: 1 }]);
    expect(catalogueOf(same.components)).toEqual(["clip@1:Clip"]);

    // Same id, a DIFFERENT file: renamed, and the placed instance reads the file that
    // arrived — while the document's own clip still reads its own.
    const clash = documentWith([clipReading(OTHER)]);
    const renamed = await clash.bus.execute("component.import", { text }, ctx);
    expect(renamed.status).toBe("applied");
    expect(catalogueOf(clash.components)).toEqual(["clip@1:Clip", "clip1@1:Clip1"]);
    expect(clash.store.view.getGraph().nodes[renamed.output.nodeId as string]?.type).toBe(componentNodeType("clip1", 1));
    expect(filesRead(clash)).toEqual([REMOTE]);
    expect(pictureFileUrl(clash.components.get("clip", 1)?.graph.nodes.movie?.parameters.file)).toBe(OTHER);
  });
});
