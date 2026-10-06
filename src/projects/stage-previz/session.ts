import { createComponentSystem } from "../../domain/components/index.ts";
import { loadProject } from "../../domain/project/index.ts";
import { buildCheckedProjectFile, serializeCheckedProject } from "../../examples/checked-project.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { stageDocument } from "./document.ts";
import { stageFacts } from "./facts.ts";
import { applyRig } from "./rig.ts";

/**
 * Stage previz — the two texts the project's scripts write, as functions of the bytes they read.
 *
 * build.ts and upgrade.ts run as they are imported (they read `process.argv` and write files),
 * so what they write lives here, where a test can ask for it: `session.test.ts` holds the
 * committed base session to `builtSession` of the committed GLB, byte for byte, and every
 * other committed session to `upgradedSession` changing nothing.
 */

/** The address a session's Mesh File In nodes name: the GLB as the app serves it. */
export const STAGE_GLB_URL = "media/stage-previz/stage.glb";
/** Where that file is in the repository. Committed: a session opens on a fresh checkout. */
export const STAGE_GLB_PATH = "public/media/stage-previz/stage.glb";
/** The base session: generated, and checked against its source. */
export const STAGE_SESSION_PATH = "projects/stage-previz/stage-previz.loom.json";

/** What build.ts writes for a GLB: the session the source builds, through the checked save. */
export function builtSession(glb: Uint8Array): string {
  return serializeCheckedProject(stageDocument(stageFacts(glb, STAGE_GLB_URL)));
}

/**
 * What upgrade.ts writes for a session somebody saved and a GLB: the file loaded through the
 * real loader, the rig applied (rig.ts), and written back through the checked save with the
 * session's own component library, as the app's save writes it. `updatedAt` is the session's
 * own, so an upgrade that changes nothing changes no byte. Throws `DocumentRefused` when the
 * upgraded session holds anything a code save refuses, and then nothing is to be written.
 */
export function upgradedSession(text: string, glb: Uint8Array, options: { readonly reset?: readonly string[] } = {}): string {
  const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
  const loaded = loadProject(text, { nodes: system.nodes, components: system.components });
  if (!loaded.ok) throw new Error(`The session did not load: ${loaded.reason}`);
  const upgraded = applyRig(loaded.document, stageFacts(glb, STAGE_GLB_URL), options);
  return buildCheckedProjectFile({ document: upgraded, components: loaded.components, now: () => loaded.document.updatedAt }).text;
}
