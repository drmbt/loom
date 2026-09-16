import { describe, expect, it } from "vitest";
import { sites, neighbours, SHELL_HEIGHT, SHELL_RADIUS, MAX_DISPLACEMENT } from "./shaders/resonance-shell.ts";
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, v, i) => sum + v * b[i]!, 0);
const cross = (a: readonly number[], b: readonly number[]) => [a[1]!*b[2]!-a[2]!*b[1]!,a[2]!*b[0]!-a[0]!*b[2]!,a[0]!*b[1]!-a[1]!*b[0]!];
const normalize = (v: number[]) => v.map(x => x / Math.hypot(...v));
describe("Resonance spherical fracture construction", () => {
  it("the accelerated neighbour set gives the same cell boundary as every site", () => {
    // A missed neighbour creates overlapping fragments; compare to the exhaustive construction.
    for (const [id,n] of sites.entries()) {
      expect(Math.hypot(...n)).toBeCloseTo(1,12);
      const tangent=normalize(cross(n,Math.abs(n[1])>0.9?[1,0,0]:[0,1,0]));
      const bitangent=cross(n,tangent);
      for(let j=0;j<192;j++) {
        const angle=j/192*Math.PI*2;
        const d=tangent.map((v,i)=>v*Math.cos(angle)+bitangent[i]!*Math.sin(angle));
        const boundary=(ids:readonly number[]) => Math.min(...ids.filter(i=>i!==id && dot(d,sites[i]!)>0.00001).map(i=>(1-dot(n,sites[i]!))/dot(d,sites[i]!)));
        expect(boundary(neighbours[id]!)).toBeCloseTo(boundary(sites.map((_,i)=>i)),10);
      }
    }
  });
  it("the full envelope clears the pedestal, ceiling and room walls", () => {
    const extent=SHELL_RADIUS+MAX_DISPLACEMENT+0.03;
    expect(SHELL_HEIGHT-extent).toBeGreaterThan(0.32);
    expect(SHELL_HEIGHT+extent).toBeLessThan(13);
    expect(extent).toBeLessThan(19);
  });
});
