import { readFileSync } from "node:fs";
import { decodeGlb, type DecodedMesh } from "../../domain/mesh/glb.ts";
import { AREAS, carAreasOf, factsFrom, selectOf, type Area, type OnNothingFacts } from "./scene-facts.ts";

/** T1400b — node-only: read the GLB off disk and measure what the documents need. */
export function loadOnNothingFacts(glbPath: string, glbUrl: string): { facts: OnNothingFacts; glb: Uint8Array } {
  const glb = new Uint8Array(readFileSync(glbPath));
  const areas: Area[] = [...AREAS, ...carAreasOf(glb)];
  const meshes = new Map<Area, DecodedMesh>(areas.map((area) => [area, decodeGlb(glb, { select: selectOf(area) })]));
  return { facts: factsFrom(glbUrl, meshes), glb };
}
