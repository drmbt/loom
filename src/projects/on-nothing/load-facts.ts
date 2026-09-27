import { readFileSync } from "node:fs";
import { decodeGlb, type DecodedMesh } from "../../domain/mesh/glb.ts";
import { AREAS, factsFrom, selectOf, type Area, type OnNothingFacts } from "./scene-facts.ts";

/** T1400b — node-only: read the GLB off disk and measure what the documents need. */
export function loadOnNothingFacts(glbPath: string, glbUrl: string): { facts: OnNothingFacts; glb: Uint8Array } {
  const glb = new Uint8Array(readFileSync(glbPath));
  const meshes = new Map<Area, DecodedMesh>(AREAS.map((area) => [area, decodeGlb(glb, { select: selectOf(area) })]));
  return { facts: factsFrom(glbUrl, meshes), glb };
}
