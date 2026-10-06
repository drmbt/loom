import { readFileSync } from "node:fs";
import { decodeGlb } from "../../domain/mesh/glb.ts";
import { ROBOT_SELECT, kitFactsFrom, type KitFacts } from "./kit.ts";

/** T1561b — node-only: read the kit off disk and measure what the document needs. */
export function loadKit(glbPath: string, glbUrl: string): { facts: KitFacts; glb: Uint8Array } {
  const glb = new Uint8Array(readFileSync(glbPath));
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + view.getUint32(12, true)))) as { nodes?: Array<{ name?: string; extras?: Record<string, unknown> }> };
  return { facts: kitFactsFrom(glbUrl, decodeGlb(glb, { select: ROBOT_SELECT }), (select) => decodeGlb(glb, { select }), json.nodes ?? []), glb };
}
