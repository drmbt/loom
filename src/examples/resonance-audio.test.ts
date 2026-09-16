import { describe, expect, it } from "vitest";
import { flattenComponents } from "../compiler/flatten.ts";
import { SILENCE } from "../domain/audio/feature-track.ts";
import { createValueGraphSession } from "../domain/channels/value-graph.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { starterComponentsView } from "./component-files.ts";
import { resonanceDocument } from "./documents/resonance.ts";

describe("Resonance musical control lanes",()=>{
  it("separates drum impulses from slow spectral motion and preserves the source bar clock",async()=>{
    expect(resonanceDocument.graph.nodes["room"]!.parameters["panelClock"]).toBe(0);
    const registry=createNodeRegistry(allNodeDefinitions).view();
    const graph=flattenComponents({graph:resonanceDocument.graph,registry,components:await starterComponentsView()}).graph;
    const session=createValueGraphSession(registry);
    const samples:Record<string,number>[]=[];
    for(let i=0;i<1200;i++) {
      const phase=i%180;
      const result=session.evaluate(graph,{timeSeconds:i/60,deltaSeconds:1/60,frameIndex:i,mode:"offline",randomSeed:75},{audio:{...SILENCE,
        level:0.3,low:i<600?0.2:0.8,lowMid:0.4,highMid:0.3,high:0.2,
        kickCount:phase===30?1:0,snareCount:phase===90?1:0,hatCount:phase===120?1:0,
      }});
      const read=(address:string)=>{
        const value=result.resolver(address,undefined as never);
        if(typeof value!=="number") throw new Error(`Missing control ${address}`);
        return value;
      };
      samples.push({low:read("body1:low"),kick:read("detail1:kickCount"),snare:read("detail1:snareCount"),hat:read("detail1:hatCount"),bar:read("clip1:bar"),phase:read("clip1:barPhase")});
    }
    // Same loudness throughout: band changes must still move the slow geometry lane.
    const low=samples.map(s=>s["low"]!);
    expect(Math.max(...low)-Math.min(...low)).toBeGreaterThan(0.15);
    expect(Math.max(...low.slice(1).map((v,i)=>Math.abs(v-low[i]!)))).toBeLessThan(0.01);
    // Isolated events excite their own decaying tails, without becoming one global pulse.
    for(const [at,channel] of [[34,"kick"],[94,"snare"],[124,"hat"]] as const) {
      const sample=samples[at]!;
      expect(sample[channel]).toBeGreaterThan(0.4);
      const future=channel==="kick"?"snare":channel==="snare"?"hat":"kick";
      expect(sample[channel]! - sample[future]!).toBeGreaterThan(0.3);
    }
    const kick=samples.map(s=>s["kick"]!);
    const peak=Math.max(...kick.slice(30,36));
    expect(peak).toBeGreaterThan(0.75);
    expect(kick[48]).toBeLessThan(0.3); // Separate hits instead of a 450 ms plateau.
    expect(samples[1199]!["bar"]).toBeGreaterThan(7);
    expect(samples[1199]!["phase"]).toBeGreaterThanOrEqual(0);
    expect(samples[1199]!["phase"]).toBeLessThan(1);
  });
});
