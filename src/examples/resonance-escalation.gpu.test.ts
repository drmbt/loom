import { beforeAll, describe, expect, it } from "vitest";
import { resonanceDocument } from "./documents/resonance.ts";
import { resonancePaletteExpression } from "./shaders/resonance-palette.ts";
import { evaluateExpression } from "../domain/expressions/evaluate.ts";
import { starterComponentsView } from "./component-files.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { pointStorageId } from "../nodes/definitions/point-storage.ts";
import { kernelRegionSlice } from "../nodes/definitions/test-support.ts";
import { FRAGMENT_COUNT, MAX_DISPLACEMENT, SHELL_COLUMNS, SHELL_HEIGHT, SHELL_ROWS_PER_CELL } from "./shaders/resonance-shell.ts";

let unavailable:string|undefined;
beforeAll(async()=>{unavailable=(await probeDawn()).error;},60_000);
describe("Resonance peak escalation",()=>{
  it("visits red, violet, blue and cyan while retaining a controllable warm base",()=>{
    const sample=(seconds:number,cycle:number)=> ([0,1,2] as const).map(channel=>{
      const result=evaluateExpression(resonancePaletteExpression(channel).replaceAll("op('wgsl_room').par.paletteCycle","cycle"),{abstime:seconds,cycle});
      if(!result.ok) throw new Error(JSON.stringify(result));
      return result.value as number;
    });
    expect(sample(12,1)[0]).toBeGreaterThan(0.9);
    expect(sample(12,1)[1]).toBeLessThan(0.1);
    expect(sample(36,1)[2]).toBeGreaterThan(sample(36,1)[0]!);
    expect(sample(48,1)[0]).toBeLessThan(0.2);
    expect(sample(48,1)[2]).toBe(1);
    expect(sample(60,1)[1]).toBeGreaterThan(0.8);
    expect(sample(60,0)).toEqual(sample(0,0));
    expect(sample(84,1)).toEqual(sample(0,1));
  });
  it("moves rigid stones on transients at saturated expansion and attaches bounded arcs",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const sample=async(impulse:number,time=0,voltage=impulse,expansion=1)=>{
      const graph=structuredClone(resonanceDocument.graph);
      Object.assign(graph.nodes["fracture"]!.parameters,{expansion,impulse,vibration:0,rotation:0});
      Object.assign(graph.nodes["seams"]!.parameters,{voltage});
      const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph,settings:{...resonanceDocument.settings,outputResolution:{width:80,height:45}},frames:time===0?1:2,fps:time===0?60:1/time,outputNodeId:"out",probeBuffers:[pointStorageId("fracture"),pointStorageId("seams")]});
      expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
      const scenes=String(graph.nodes["lightShot"]!.parameters.scenes).split(" ");
      for(const label of ["geometry_seamlight","geometry_seamreflection","geometry_innerseamlight","geometry_innerseamreflection"]) {
        const index=scenes.indexOf(label);
        expect(index).toBeGreaterThanOrEqual(0);
        const draw=result.plan.passes.find(pass=>pass.id.endsWith(`lightShot:scene:${index}`)) as {
          uniforms?: Record<string,readonly number[]>;
          buffers?: readonly {binding:string}[];
        } | undefined;
        // beamWidth already carries world-space half-widths. Multiplying by the old
        // .018/.008 static width again made valid plasma buffers effectively invisible.
        expect(draw?.uniforms?.["instance"]?.[0]).toBe(1);
        expect(draw?.buffers?.some(binding=>binding.binding==="pointScales")).toBe(true);
      }
      const read=(node:string,attribute:string)=>{
        const raw=result.buffers?.[pointStorageId(node)];
        if(!raw) throw new Error(`Missing ${node} readback`);
        return kernelRegionSlice(graph.nodes[node]!,raw,attribute).floats;
      };
      return {position:read("fracture","position"),rest:read("fracture","rest"),seam:read("seams","seam"),arcStart:read("seams","position"),arcEnd:read("seams","end"),tint:read("seams","tint"),beamWidth:read("seams","beamWidth")};
    };
    const quiet=await sample(0),peak=await sample(1);
    let largestBeatTravel=0,arcs=0,coreLinks=0,neighbourLinks=0;
    const faceDistance=(point:number[])=>Math.min(...Array.from({length:FRAGMENT_COUNT},(_,cell)=>{
      const at=((cell+1)*SHELL_ROWS_PER_CELL-1)*SHELL_COLUMNS*4;
      return Math.hypot(...point.map((value,axis)=>value-peak.position[at+axis]!));
    }));
    for(let cell=0;cell<FRAGMENT_COUNT;cell++) {
      const vertex=cell*SHELL_COLUMNS*SHELL_ROWS_PER_CELL;
      const at=vertex*4;
      const motion=[0,1,2].map(axis=>peak.position[at+axis]!-quiet.position[at+axis]!);
      largestBeatTravel=Math.max(largestBeatTravel,Math.hypot(...motion));
      for(let v=0;v<SHELL_COLUMNS*SHELL_ROWS_PER_CELL;v++) {
        const i=(vertex+v)*4;
        const delta=[0,1,2].map(axis=>peak.position[i+axis]!-peak.rest[i+axis]!-(axis===1?SHELL_HEIGHT:0));
        expect(Math.hypot(...delta)).toBeLessThanOrEqual(MAX_DISPLACEMENT+0.00001);
        for(let axis=0;axis<3;axis++) expect(peak.position[i+axis]!-quiet.position[i+axis]!).toBeCloseTo(motion[axis]!,5);
      }
      const arcVertex=vertex+12*SHELL_COLUMNS;
      expect(quiet.seam[arcVertex]).toBe(0);
      if(peak.seam[arcVertex]!>0.5) {
        arcs++;
        expect(peak.beamWidth[arcVertex]!).toBeGreaterThan(0.018);
        expect(peak.beamWidth[arcVertex]!).toBeLessThanOrEqual(0.024001);
        expect(peak.beamWidth[arcVertex+SHELL_COLUMNS]!/peak.beamWidth[arcVertex]!).toBeCloseTo(5,4);
        const origin=[0,1,2].map(axis=>peak.arcStart[arcVertex*4+axis]!);
        const coreRadius=Math.hypot(...origin.map((value,axis)=>value-(axis===1?SHELL_HEIGHT:0)));
        if(Math.abs(coreRadius-0.98)<0.0001) coreLinks++;
        else {neighbourLinks++;expect(faceDistance(origin)).toBeLessThan(0.0061);}
        // Both route types terminate on the live inner-face centre, never on an outer lip.
        const end=[0,1,2].map(axis=>peak.arcEnd[(arcVertex+31)*4+axis]!);
        expect(faceDistance(end)).toBeLessThan(0.0061);
        // Warm scene keeps warm plasma, with a slight whitening rather than a complement.
        expect(peak.tint[arcVertex*4]!).toBeGreaterThan(peak.tint[arcVertex*4+2]!);
        // Consecutive lightning segments share endpoints exactly.
        for(let segment=0;segment<31;segment++) for(let axis=0;axis<3;axis++) {
          expect(peak.arcEnd[(arcVertex+segment)*4+axis]).toBe(peak.arcStart[(arcVertex+segment+1)*4+axis]);
        }
      }
    }
    expect(largestBeatTravel).toBeGreaterThan(0.35);
    expect(arcs).toBeGreaterThan(3);
    expect(arcs).toBeLessThan(12);
    expect(coreLinks).toBeGreaterThan(1);expect(neighbourLinks).toBeGreaterThan(0);
    const partial=await sample(0,0,1,0.3);
    expect(partial.seam.filter((value,index)=>index%SHELL_COLUMNS===0 && value>0.5).length).toBeGreaterThan(0);
    const next=await sample(1,1/60),later=await sample(1,4.1),sustained=await sample(0,1,1);
    let persistent=0,changedRoutes=0,sustainedArcs=0;
    for(let cell=0;cell<FRAGMENT_COUNT;cell+=13) {
      const vertex=(cell*SHELL_ROWS_PER_CELL+12)*SHELL_COLUMNS;
      if(sustained.seam[vertex]!>0.5) sustainedArcs++;
      if(peak.seam[vertex]!>0.5 && next.seam[vertex]!>0.5) {
        persistent++;
        // Consecutive rendered frames move smoothly instead of replacing the arc.
        const at=(vertex+4)*4;
        expect(Math.hypot(...[0,1,2].map(axis=>next.arcStart[at+axis]!-peak.arcStart[at+axis]!))).toBeLessThan(0.025);
        expect(Math.abs(next.tint[vertex*4]!-peak.tint[vertex*4]!)).toBeLessThan(0.1);
      }
      const end=(vertex+31)*4;
      if(Math.hypot(...[0,1,2].map(axis=>later.arcEnd[end+axis]!-peak.arcEnd[end+axis]!))>0.05) changedRoutes++;
    }
    expect(persistent).toBeGreaterThan(3);
    expect(sustainedArcs).toBeGreaterThan(3); // no kick needed once charge exists
    expect(changedRoutes).toBeGreaterThan(3);
  },120_000);
});
