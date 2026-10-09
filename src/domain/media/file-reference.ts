import type { AssetReference, GraphDocument } from "../types/graph.ts";

const PREFIX = "loom-file:";
const KINDS = new Set<AssetReference["kind"]>(["image", "video", "audio", "gltf", "binary"]);

/** A durable file identity. The handle itself stays in the host's local storage. */
export function createFileReference(id: string, kind: AssetReference["kind"], name: string): string {
  if (id === "" || name === "" || !KINDS.has(kind)) throw new Error("A retained file needs an identity, kind, and name.");
  return `${PREFIX}${encodeURIComponent(id)}/${kind}#${encodeURIComponent(name)}`;
}

/** Legacy URLs are untouched; malformed references to our own protocol are explicit errors. */
export function parseFileReference(value: unknown): AssetReference | null {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return null;
  const match = /^loom-file:([^/]+)\/(image|video|audio|gltf|binary)#(.+)$/.exec(value);
  if (match === null) throw new Error("Invalid retained file reference; choose the file again.");
  const id = decodeURIComponent(match[1]!);
  const name = decodeURIComponent(match[3]!);
  if (id === "" || name === "") throw new Error("Invalid retained file identity or name.");
  return { assetId: id, name, kind: match[2] as AssetReference["kind"], source: { kind: "fileHandle", handleId: id } };
}

/**
 * The parsed JSON of a parameter whose whole text is a JSON OBJECT, else null. VN106: a clip
 * track keeps its regions as one JSON text (`clipTrack.track`), and each region's `media`
 * can be a retained reference, so the references a save must list sit INSIDE that text.
 * Only a text that parses as an object counts: free text (a note, an expression) that
 * merely mentions `loom-file:` is never parsed into an asset.
 */
function jsonObjectOf(text: string): object | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Derive external file records from the graph, including inactive static bindings. */
export function collectFileReferences(graphs: readonly GraphDocument[]): AssetReference[] {
  const references = new Map<string, AssetReference>();
  const visit = (value: unknown, insideJson = false): void => {
    if (insideJson) {
      // A malformed reference inside a JSON text is that document's problem (its own
      // parser reports it), not a reason to fail the whole save.
      let reference: AssetReference | null = null;
      try {
        reference = parseFileReference(value);
      } catch {
        reference = null;
      }
      if (reference !== null) references.set(reference.assetId, reference);
    } else {
      const reference = parseFileReference(value);
      if (reference !== null) references.set(reference.assetId, reference);
      if (typeof value === "string") {
        const embedded = jsonObjectOf(value);
        if (embedded !== null) visit(embedded, true);
        return;
      }
    }
    if (typeof value === "object" && value !== null) {
      for (const child of Object.values(value)) visit(child, insideJson);
    }
  };
  for (const graph of graphs) {
    for (const node of Object.values(graph.nodes)) {
      for (const value of Object.values(node.parameters)) visit(value);
    }
  }
  return [...references.values()];
}

/** Asset metadata is derived from authored references, never from runtime object URLs. */
export function retainedProjectAssets(assets: readonly AssetReference[], graphs: readonly GraphDocument[]): AssetReference[] {
  const result = new Map(assets.map(asset => [asset.assetId, asset]));
  for (const asset of collectFileReferences(graphs)) {
    result.set(asset.assetId, { ...result.get(asset.assetId), ...asset });
  }
  return [...result.values()];
}
