import { readFileSync } from "node:fs";
import { decodeGlb } from "../../domain/mesh/glb.ts";
import { MACHINES_SELECT, PLANT_SELECT, sceneFactsFrom, type FurnaceSceneFacts } from "./scene-facts.ts";

/** T1354b — node-only: read the GLB off disk and measure what the document needs. */
export function loadFurnaceFacts(glbPath: string, glbUrl: string): { facts: FurnaceSceneFacts; glb: Uint8Array } {
  const glb = new Uint8Array(readFileSync(glbPath));
  const plant = decodeGlb(glb, { select: PLANT_SELECT });
  const machines = decodeGlb(glb, { select: MACHINES_SELECT });
  return { facts: sceneFactsFrom(glbUrl, plant, machines), glb };
}
