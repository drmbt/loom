import { describe, expect, it } from "vitest";
import { createFileReference, parseFileReference } from "@domain/media/file-reference.ts";
import { buildProjectFile, loadProject } from "@domain/project/index.ts";
import { buildComponentFile } from "@domain/components/component-file.ts";
import { bloomComponent } from "@domain/components/test-support.ts";
import { createAppRuntime } from "./app-runtime.ts";

describe("retained media in project files", () => {
  it("saves both media references, reopens them intact, and undo restores the binding", async () => {
    const runtime = createAppRuntime({ identityStorage: null });
    try {
      const movie = createFileReference("movie-file", "video", "clip.mp4");
      const audio = createFileReference("audio-file", "audio", "track.wav");
      const added = await runtime.bus.execute("graph.applyPatch", { baseRevision: 0, operations: [
        { op: "addNode", ref: "$movie", type: "movieFileIn", position: { x: 0, y: 0 }, parameters: { file: movie } },
        { op: "addNode", ref: "$audio", type: "audioFileIn", position: { x: 0, y: 200 }, parameters: { file: audio } },
      ] }, runtime.invocation);
      expect(added.status).toBe("applied");
      expect(runtime.project.assets).toEqual([parseFileReference(movie), parseFileReference(audio)]);
      const file = buildProjectFile({ document: runtime.projectDocument() });
      expect(file.text).not.toContain("blob:");
      const loaded = loadProject(file.text, { nodes: runtime.registry });
      if (!loaded.ok) throw new Error(loaded.reason);
      expect(Object.values(loaded.document.graph.nodes).map(node => node.parameters.file)).toEqual([movie, audio]);
      expect(loaded.document.assets).toEqual(runtime.project.assets);
      const movieId = added.output.createdIds["$movie"]!;
      const replacement = createFileReference("replacement", "video", "second.mp4");
      const changed = await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), operations: [
        { op: "setParameters", nodeId: movieId, parameters: { file: replacement } },
      ] }, runtime.invocation);
      expect(changed.status).toBe("applied");
      expect(runtime.project.assets.map(asset => asset.assetId)).toContain("replacement");
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
      expect(runtime.bus.store.getGraph().nodes[movieId]!.parameters.file).toBe(movie);
      expect(runtime.project.assets.map(asset => asset.assetId)).not.toContain("replacement");
    } finally { runtime.dispose(); }
  });

  it("collects files authored inside component libraries and component exports", () => {
    const runtime = createAppRuntime({ identityStorage: null });
    try {
      const reference = createFileReference("nested-file", "video", "nested.mp4");
      const base = bloomComponent("nested", 1);
      const component = { ...base, graph: { ...base.graph, nodes: { ...base.graph.nodes,
        movie: { id: "movie", type: "movieFileIn", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { file: reference } },
      } } };
      const file = buildComponentFile({ root: component, definitions: [component], settings: runtime.settings });
      expect(file.document.assets).toEqual([parseFileReference(reference)]);
      expect(file.text).toContain(reference);
      expect(file.text).not.toContain("blob:");
    } finally { runtime.dispose(); }
  });
});
