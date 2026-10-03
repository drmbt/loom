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

/** Derive external file records from the graph, including inactive static bindings. */
export function collectFileReferences(graphs: readonly GraphDocument[]): AssetReference[] {
  const references = new Map<string, AssetReference>();
  const visit = (value: unknown): void => {
    const reference = parseFileReference(value);
    if (reference !== null) references.set(reference.assetId, reference);
    if (typeof value === "object" && value !== null) {
      for (const child of Object.values(value)) visit(child);
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
