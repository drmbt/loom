import { readFileSync } from "node:fs";
import { decodeGlb } from "../../domain/mesh/glb.ts";
import { MACHINES_SELECT, PLANT_SELECT, SKY_SELECT, sceneFactsFrom, type FurnaceSceneFacts, type MaterialFacts } from "./scene-facts.ts";

/** T1354b — node-only: read the GLB off disk and measure what the document needs. */
export function loadFurnaceFacts(glbPath: string, glbUrl: string): { facts: FurnaceSceneFacts; glb: Uint8Array } {
  const glb = new Uint8Array(readFileSync(glbPath));
  const plant = decodeGlb(glb, { select: PLANT_SELECT });
  const machines = decodeGlb(glb, { select: MACHINES_SELECT });
  const sky = decodeGlb(glb, { select: SKY_SELECT });
  return { facts: sceneFactsFrom(glbUrl, plant, machines, sky, glbMaterials(glb)), glb };
}

/** The GLB's material table, read from its JSON chunk: name, metallic, roughness, `loom_heat`. */
function glbMaterials(glb: Uint8Array): MaterialFacts[] {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const length = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length))) as {
    materials?: Array<{ name?: string; pbrMetallicRoughness?: { metallicFactor?: number; roughnessFactor?: number }; extras?: { loom_heat?: number } }>;
  };
  return (json.materials ?? []).map((material, index) => ({
    name: material.name ?? `material${index}`,
    metallic: material.pbrMetallicRoughness?.metallicFactor ?? 1,
    roughness: material.pbrMetallicRoughness?.roughnessFactor ?? 1,
    heat: material.extras?.loom_heat ?? 0,
  }));
}
