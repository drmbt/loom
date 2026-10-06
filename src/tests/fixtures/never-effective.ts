import { loadProject } from "../../domain/project/index.ts";
import { serializeProjectDocument } from "../../domain/project/serialize.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { document, edge, graph, named, settings } from "../../examples/documents/builders.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";

/**
 * §T1641b — §B262'S DOCUMENT, BUILT THE WAY IT SHIPPED: by code, never through the bus.
 *
 * The bus has always refused `pow(x, 2)` (`graph.applyPatch` validates what it writes). The
 * three lamps of §B262 were object literals handed to the save path, which checks nothing,
 * so the tests that hold the rule build their document the same way: the builders, then
 * `serializeProjectDocument`, then `loadProject` on the bytes. A document assembled by
 * patches would prove the door that was never open.
 *
 * A white Solid through a Level into the Output: `brightness` is the lamp. 8×8 and
 * rgba8unorm with no display transform, so a readback is the bytes the target holds.
 */

export const LAMP = "level_lamp";
export const LAMP_OUTPUT = "output_out";

export const NEVER_EFFECTIVE_REGISTRY = createNodeRegistry(allNodeDefinitions).view();

/** The saved bytes of the lamp document, `brightness` as given, plus any other nodes. */
export function lampFile(brightness: StoredParameter, others: readonly GraphNode[] = []): string {
  const white = named("white", "solid", [0, 0], { color: [1, 1, 1, 1] });
  const lamp = named("lamp", "level", [300, 0], {}, { parameters: { brightness } });
  const out = named("out", "output", [600, 0]);
  return serializeProjectDocument(
    document(
      "t1641b-lamp",
      "T1641b lamp",
      settings({
        outputResolution: { width: 8, height: 8 },
        workingFormat: "rgba8unorm",
        colorPolicy: { workingSpace: "linear", displayTransform: "none" },
        previewLongEdge: 8,
        randomSeed: 1,
      }),
      graph(
        [white, lamp, out, ...others],
        [edge("e_white", [white.id, "out"], [lamp.id, "input"]), edge("e_lamp", [lamp.id, "out"], [out.id, "input"])],
      ),
    ),
  );
}

/** The bytes through the real load: what a render script holds before it renders. */
export function openedLamp(text: string): { readonly graph: GraphDocument; readonly settings: ProjectSettings } {
  const loaded = loadProject(text, { nodes: NEVER_EFFECTIVE_REGISTRY });
  if (!loaded.ok) throw new Error(`the lamp document did not load: ${loaded.reason}`);
  return { graph: loaded.document.graph, settings: loaded.document.settings };
}
