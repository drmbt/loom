import { resonancePaletteExpression } from "./shaders/resonance-palette.ts";
import { evaluateExpression } from "../domain/expressions/evaluate.ts";
import { beforeAll, describe, expect, it } from "vitest";
import { RESONANCE_ROOM_WGSL } from "./shaders/resonance.wgsl.ts";
import { resonanceDocument } from "./documents/resonance.ts";
import { SHELL_COLUMNS, SHELL_ROWS_PER_CELL, FRAGMENT_COUNT, CHIP_COUNT, CHIP_COLUMNS, CHIP_ROWS_PER_CELL, MAX_DISPLACEMENT, SHELL_HEIGHT } from "./shaders/resonance-shell.ts";
import { starterComponentsView } from "./component-files.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { pointStorageId } from "../nodes/definitions/point-storage.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import { kernelRegionSlice } from "../nodes/definitions/test-support.ts";

let unavailable: string | undefined;
beforeAll(async () => { unavailable=(await probeDawn()).error; },60_000);
async function positions(expansion: number) {
  const graph=structuredClone(resonanceDocument.graph);
  graph.nodes["fracture"]!.parameters["expansion"]=expansion;
  graph.nodes["fracture"]!.parameters["vibration"]=0;
  const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph,settings:{...resonanceDocument.settings,outputResolution:{width:160,height:90}},frames:1,outputNodeId:"out",probeBuffers:[pointStorageId("fracture")]});
  expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
  const raw=result.buffers?.[pointStorageId("fracture")];
  if(raw===undefined) throw new Error("Missing fracture attribute readback");
  const read=(name:string)=>kernelRegionSlice(graph.nodes["fracture"]!,raw,name).floats;
  return {position:read("position"),rest:read("rest"),radial:read("radial")};
}
async function projectionPixels(seed: number, frames: number) {
  const graph=structuredClone(resonanceDocument.graph);
  graph.nodes["room"]!.parameters["projectionSeed"]=seed;
  graph.nodes["room"]!.parameters["mids"]=1;
  const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph,settings:{...resonanceDocument.settings,outputResolution:{width:320,height:180}},frames,fps:1,outputNodeId:"out"});
  expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
  const f=result.frames[0]!;
  const space=result.plan.outputs.find(o=>o.nodeId==="out")!.space;
  return toRgba8({width:f.width,height:f.height,format:f.format,bytes:f.bytes,rowStride:f.width*BYTES_PER_PIXEL[f.format]},{space}).data;
}
describe("Resonance GPU geometry invariants",()=>{
  it("closes exactly at rest and clamps every fragment to its fixed radial envelope",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const rest=await positions(0);
    const peak=await positions(1);
    const over=await positions(2);
    let restError=0,perpendicularError=0,rangeMin=Infinity,rangeMax=-Infinity,clampError=0,rigidError=0;
    for(let cell=0;cell<FRAGMENT_COUNT;cell++) {
      let firstDisplacement: number | undefined;
      for(let v=0;v<SHELL_COLUMNS*SHELL_ROWS_PER_CELL;v++) {
        const at=(cell*SHELL_COLUMNS*SHELL_ROWS_PER_CELL+v)*4;
        let along=0;
        const delta=[0,1,2].map(axis=>peak.position[at+axis]!-peak.rest[at+axis]!-(axis===1?SHELL_HEIGHT:0));
        for(let axis=0;axis<3;axis++) {
          const index=at+axis;
          restError=Math.max(restError,Math.abs(rest.position[index]!-rest.rest[index]!-(axis===1?SHELL_HEIGHT:0)));
          clampError=Math.max(clampError,Math.abs(peak.position[index]!-over.position[index]!));
          along+=delta[axis]!*peak.radial[index]!;
        }
        for(let axis=0;axis<3;axis++) perpendicularError=Math.max(perpendicularError,Math.abs(delta[axis]!-along*peak.radial[at+axis]!));
        rangeMin=Math.min(rangeMin,along);rangeMax=Math.max(rangeMax,along);
        if(firstDisplacement===undefined) firstDisplacement=along;
        rigidError=Math.max(rigidError,Math.abs(along-firstDisplacement));
      }
    }
    expect(restError).toBeLessThan(1e-6);
    expect(perpendicularError).toBeLessThan(2e-6);
    expect(rangeMin).toBeGreaterThanOrEqual(0);
    expect(rangeMax).toBeLessThanOrEqual(MAX_DISPLACEMENT+1e-6);
    expect(rangeMax).toBeGreaterThan(1.5);
    expect(rigidError).toBeLessThan(2e-6);
    expect(clampError).toBe(0);
    expect(Array.from(rest.rest)).toEqual(Array.from(peak.rest));
  },60_000);
  it("individual stone chips have volume and stay inside the protected envelope",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const graph=structuredClone(resonanceDocument.graph);
    graph.nodes["chipForm"]!.parameters["expansion"]=1;
    const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph,settings:{...resonanceDocument.settings,outputResolution:{width:160,height:90}},frames:1,outputNodeId:"out",probeBuffers:[pointStorageId("chipForm")]});
    expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
    const raw=result.buffers?.[pointStorageId("chipForm")];
    if(raw===undefined) throw new Error("Missing chip geometry readback");
    const positions=kernelRegionSlice(graph.nodes["chipForm"]!,raw,"position").floats;
    for(let cell=0;cell<CHIP_COUNT;cell++) {
      const lower=[Infinity,Infinity,Infinity],upper=[-Infinity,-Infinity,-Infinity];
      for(let vertex=0;vertex<CHIP_COLUMNS*CHIP_ROWS_PER_CELL;vertex++) {
        const index=(cell*CHIP_COLUMNS*CHIP_ROWS_PER_CELL+vertex)*4;
        const point=[positions[index]!,positions[index+1]!,positions[index+2]!];
        expect(Math.hypot(point[0]!,point[1]!-SHELL_HEIGHT,point[2]!)).toBeLessThan(5.2);
        for(let axis=0;axis<3;axis++){lower[axis]=Math.min(lower[axis]!,point[axis]!);upper[axis]=Math.max(upper[axis]!,point[axis]!);}
      }
      for(let axis=0;axis<3;axis++) {
        expect(upper[axis]!-lower[axis]!).toBeGreaterThan(0.015);
        expect(upper[axis]!-lower[axis]!).toBeLessThan(0.24); // Grit cannot masquerade as detached shell plates.
      }
    }
  },60_000);
  it("rotates the shell, fragments, fissures and reflections as one rigid assembly",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const ids=["fracture","chipForm","debris","seams","mirror","debrisMirror","seamMirror","innerFracture","innerMirror","innerSeams","innerSeamMirror"];
    const sample=async(rotation:number)=>{
      const graph=structuredClone(resonanceDocument.graph);
      graph.nodes["fracture"]!.parameters["rotation"]=rotation;
      for(const id of ["fracture","chipForm","debris"]) graph.nodes[id]!.parameters["expansion"]=0.8;
      const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph,settings:{...resonanceDocument.settings,outputResolution:{width:80,height:45}},frames:1,animate:true,outputNodeId:"out",probeBuffers:ids.map(pointStorageId)});
      expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
      return ids.map(id=>{
        const raw=result.buffers?.[pointStorageId(id)];
        if(raw===undefined) throw new Error(`Missing ${id} rotation readback`);
        const attributes=id==="seams"||id==="seamMirror"||id==="innerSeams"||id==="innerSeamMirror"?["position","end"]:id==="fracture"||id==="innerFracture"?["position","rest"]:["position"];
        return Object.fromEntries(attributes.map(name=>[name,kernelRegionSlice(graph.nodes[id]!,raw,name).floats]));
      });
    };
    const original=await sample(0),turned=await sample(90);
    for(let object=0;object<ids.length;object++) {
      let maxError=0;
      for(const name of Object.keys(original[object]!)) {
        const a=original[object]![name]!,b=turned[object]![name]!;
        for(let i=0;i<a.length;i+=4) {
          if(name==="rest") {
            for(let axis=0;axis<3;axis++) maxError=Math.max(maxError,Math.abs(a[i+axis]!-b[i+axis]!));
          } else {
            maxError=Math.max(maxError,Math.abs(b[i]!-a[i+2]!),Math.abs(b[i+1]!-a[i+1]!),Math.abs(b[i+2]!+a[i]!));
          }
        }
      }
      expect(maxError,ids[object]).toBeLessThan(0.00002);
    }
  },60_000);
  it("the inner fitted layer stays still at low energy, then opens within its own envelope",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const sample=async(energy:number)=>{
      const graph=structuredClone(resonanceDocument.graph);
      graph.nodes["fracture"]!.parameters["expansion"]=energy;
      graph.nodes["innerFracture"]!.parameters["vibration"]=0;
      // Isolate radial travel from the independently animated boundary shrink.
      graph.nodes["innerFracture"]!.parameters["fissure"]=0.07;
      const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph,settings:{...resonanceDocument.settings,outputResolution:{width:80,height:45}},frames:1,animate:true,outputNodeId:"out",probeBuffers:[pointStorageId("innerFracture")]});
      expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
      const raw=result.buffers?.[pointStorageId("innerFracture")];
      if(raw===undefined) throw new Error("Missing inner shell readback");
      return kernelRegionSlice(graph.nodes["innerFracture"]!,raw,"position").floats;
    };
    const rest=await sample(0),low=await sample(0.08),peak=await sample(1);
    expect(Array.from(low)).toEqual(Array.from(rest));
    let greatestTravel=0;
    for(let i=0;i<peak.length;i+=4) {
      greatestTravel=Math.max(greatestTravel,Math.hypot(peak[i]!-rest[i]!,peak[i+1]!-rest[i+1]!,peak[i+2]!-rest[i+2]!));
      expect(Math.hypot(peak[i]!,peak[i+1]!-SHELL_HEIGHT,peak[i+2]!)).toBeLessThan(3.16);
    }
    expect(greatestTravel).toBeGreaterThan(1);
    expect(greatestTravel).toBeLessThanOrEqual(1.70001);
  },60_000);

  it("fragment identities stay fixed across frames and audio changes after an hour",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const sample=async(frames:number,energy:number,offset:number)=>{
      const graph=structuredClone(resonanceDocument.graph);
      for(const id of ["chipForm","debris"]) {
        const parameters=graph.nodes[id]!.parameters;
        parameters["expansion"]=energy;
        parameters["kernel"]=String(parameters["kernel"]).replaceAll("ctx.absTime",`(ctx.absTime + ${offset}.0)`);
      }
      graph.nodes["debris"]!.parameters["highs"]=0;
      const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph,settings:{...resonanceDocument.settings,outputResolution:{width:80,height:45}},frames,fps:60,outputNodeId:"out",probeBuffers:[pointStorageId("chipForm"),pointStorageId("debris")]});
      expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
      return ["chipForm","debris"].map(id=>{
        const raw=result.buffers?.[pointStorageId(id)];
        if(raw===undefined) throw new Error(`Missing ${id} temporal readback`);
        return Object.fromEntries(["position","size","tint","orient"].map(name=>[name,kernelRegionSlice(graph.nodes[id]!,raw,name).floats]));
      });
    };
    const maxDifference=(a:Float32Array,b:Float32Array)=>a.reduce((max,v,i)=>Math.max(max,Math.abs(v-b[i]!)),0);
    for(const offset of [0,3600]) {
      const before=await sample(1,0.8,offset);
      const after=await sample(2,0.8,offset);
      const louder=await sample(2,0.81,offset);
      for(let object=0;object<2;object++) {
        expect(maxDifference(before[object]!["position"]!,after[object]!["position"]!)).toBeLessThan(0.002);
        expect(maxDifference(before[object]!["size"]!,after[object]!["size"]!)).toBe(0);
        expect(maxDifference(before[object]!["tint"]!,after[object]!["tint"]!)).toBe(0);
        expect(maxDifference(before[object]!["orient"]!,after[object]!["orient"]!)).toBeLessThan(0.002);
        expect(maxDifference(after[object]!["position"]!,louder[object]!["position"]!)).toBeLessThan(0.04);
        expect(maxDifference(after[object]!["orient"]!,louder[object]!["orient"]!)).toBeLessThan(0.002);
      }
    }
  },60_000);
  it("the core shines in front of rear fragments but stays behind front fragments",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const sample=async(depth:number)=>{
      const graph=structuredClone(resonanceDocument.graph);
      graph.nodes["depthPack"]={...graph.nodes["depthPack"]!,type:"solid",parameters:{color:[0,0,0,depth]}};
      graph.edges=Object.fromEntries(Object.entries(graph.edges).filter(([,edge])=>edge.target.nodeId!=="depthPack"));
      graph.nodes["room"]!.parameters={...graph.nodes["room"]!.parameters,energy:1,haze:0,panelBrightness:0};
      graph.nodes["room"]!.resolution={mode:"project"};
      const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph,settings:{...resonanceDocument.settings,outputResolution:{width:160,height:90}},frames:1,outputNodeId:"room"});
      expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
      const frame=result.frames[0]!;
      const pixels=toRgba8({width:frame.width,height:frame.height,format:frame.format,bytes:frame.bytes,rowStride:frame.width*BYTES_PER_PIXEL[frame.format]},{space:"linear"}).data;
      return pixels[(37*160+80)*4]!;
    };
    expect(await sample(0.10)).toBeLessThan(5);
    expect(await sample(0.30)).toBeGreaterThan(250);
  },60_000);
  it("the reflected environment follows the wall projection brightness",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const read=async(brightness:number)=>{
      const graph=structuredClone(resonanceDocument.graph);
      graph.nodes["environment"]!.parameters["panelBrightness"]=brightness;
      const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph,settings:{...resonanceDocument.settings,outputResolution:{width:160,height:90}},frames:1,outputNodeId:"environment"});
      expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
      const frame=result.frames[0]!;
      return toRgba8({width:frame.width,height:frame.height,format:frame.format,bytes:frame.bytes,rowStride:frame.width*BYTES_PER_PIXEL[frame.format]},{space:"linear"}).data;
    };
    const lit=await read(1),dark=await read(0);
    let delta=0;
    for(let i=0;i<lit.length;i+=4) delta+=lit[i]!-dark[i]!;
    expect(delta/(lit.length/4)).toBeGreaterThan(1);
  },60_000);
  it("panel content changes with both its seed and elapsed time",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const original=await projectionPixels(75,1);
    const reseeded=await projectionPixels(76,1);
    const evolved=await projectionPixels(75,4);
    let seedDelta=0,timeDelta=0,count=0;
    // Only the architecture, excluding sphere, ceiling, floor and audience.
    for(let y=55;y<120;y++) for(let x=15;x<305;x++) {
      if(x>125 && x<195) continue;
      const at=(y*320+x)*4;
      for(let c=0;c<3;c++) {seedDelta+=Math.abs(original[at+c]!-reseeded[at+c]!);timeDelta+=Math.abs(original[at+c]!-evolved[at+c]!);count++;}
    }
    expect(seedDelta/count).toBeGreaterThan(2);
    expect(timeDelta/count).toBeGreaterThan(2);
  },60_000);

  it("all six staging scenes crossfade without jumps, including low back to all-lit",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const graph=structuredClone(resonanceDocument.graph);
    graph.nodes["room"]!.resolution={mode:"project"};
    const content=RESONANCE_ROOM_WGSL.slice(0,RESONANCE_ROOM_WGSL.indexOf("@fragment fn fs"))
      .replace(/fn panelContent[\s\S]*?\n}/,"fn panelContent(localUv:vec2f,panelId:f32)->vec3f { return vec3f(1); }");
    graph.nodes["room"]!.parameters={...graph.nodes["room"]!.parameters,
      source:content+"\n@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f { return vec4f(panelLight(vec2f(0.3,6),floor(uv.x*24.0)),1); }",
      panelClock:0,panelPosition:0,panelSequence:1,panelScene:1,panelBpm:120,panelBars:8,panelFadeBars:2,panelBrightness:1,panelCoverage:1,panelAudio:0,
    };
    const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph,settings:{...resonanceDocument.settings,outputResolution:{width:24,height:1}},frames:385,capture:Array.from({length:385},(_,i)=>i),fps:4,outputNodeId:"room"});
    expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
    const values=result.frames.map(f=>toRgba8({width:f.width,height:f.height,format:f.format,bytes:f.bytes,rowStride:f.width*BYTES_PER_PIXEL[f.format]},{space:"linear"}).data);
    // Two-thirds staging remains evenly populated rather than randomly losing a whole side.
    const sparse=values[128]!; // 32 seconds, scene 3.
    expect(Array.from({length:24},(_,i)=>sparse[i*4]!).filter(v=>v>100)).toHaveLength(16);
    let maxStep=0;
    for(let i=1;i<values.length;i++) for(let bay=0;bay<24;bay++) maxStep=Math.max(maxStep,Math.abs(values[i]![bay*4]!-values[i-1]![bay*4]!));
    expect(maxStep).toBeGreaterThan(0);
    expect(maxStep).toBeLessThan(30);
    for(let bay=0;bay<24;bay++) {
      expect(values[256]![bay*4]).toBeGreaterThan(20); // Low scene retains every bay at 64 seconds.
      expect(values[256]![bay*4]).toBeLessThan(values[0]![bay*4]!*0.6);
      expect(values[384]![bay*4]).toBe(values[0]![bay*4]); // Complete 96-second cycle.
    }
  },60_000);

  for (const clock of [0,1]) it(`bar-state changes crossfade continuously with clock ${clock}`,async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const graph=structuredClone(resonanceDocument.graph);
    graph.nodes["clip"]!.parameters["bpm"]=120;
    graph.nodes["clip"]!.parameters["beatOffset"]=0;
    // Constant content isolates the staging envelope from the deliberately evolving imagery.
    graph.nodes["room"]!.resolution={mode:"project"};
    const content=RESONANCE_ROOM_WGSL.slice(0,RESONANCE_ROOM_WGSL.indexOf("@fragment fn fs"))
      .replace(/fn panelContent[\s\S]*?\n}/,"fn panelContent(localUv:vec2f,panelId:f32)->vec3f { return vec3f(1); }");
    graph.nodes["room"]!.parameters={...graph.nodes["room"]!.parameters,
      source:content+"\n@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f { return vec4f(panelLight(vec2f(0.3,6),floor(uv.x*24.0)),1); }",
      panelClock:clock,panelSequence:1,panelScene:1,panelBpm:120,panelBars:8,panelFadeBars:2,panelBrightness:1,panelCoverage:1,panelAudio:0,
    };
    if(clock===0) graph.nodes["room"]!.parameters["panelPosition"]=0; // Timeline held/reset: continuous staging must still advance.
    const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph,settings:{...resonanceDocument.settings,outputResolution:{width:240,height:4}},animate:true,frames:17,capture:[0,12,13,14,15,16],fps:1,outputNodeId:"room"});
    expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
    const pixels=result.frames.map(f=>toRgba8({width:f.width,height:f.height,format:f.format,bytes:f.bytes,rowStride:f.width*BYTES_PER_PIXEL[f.format]},{space:"linear"}).data);
    const odd=pixels.map(p=>p[15*4]!);
    const even=pixels.map(p=>p[5*4]!);
    expect(odd[0]).toBe(odd[1]);
    expect(odd[1]).toBeGreaterThan(odd[2]!);
    expect(odd[2]).toBeGreaterThan(odd[3]!);
    expect(odd[3]).toBeGreaterThan(odd[4]!);
    expect(odd[4]).toBeGreaterThan(odd[5]!);
    expect(odd[5]).toBe(0);
    expect(new Set(even).size).toBe(1);
  },60_000);

  it("matches fragment emission to the scene-light palette through the colour cycle",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    for(const [seconds,cycle] of [[36,1],[54,1],[72,1],[72,0]] as const) {
      const graph=structuredClone(resonanceDocument.graph);
      graph.nodes["room"]!.parameters["paletteCycle"]=cycle;
      graph.nodes["seams"]!.parameters["gain"]=1;
      const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph,settings:{...resonanceDocument.settings,outputResolution:{width:80,height:45}},frames:2,fps:1/seconds,animate:true,outputNodeId:"out",probeBuffers:[pointStorageId("seams")]});
      expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
      const raw=result.buffers?.[pointStorageId("seams")];
      if(raw===undefined) throw new Error("Missing seam palette readback");
      const tint=kernelRegionSlice(graph.nodes["seams"]!,raw,"tint").floats;
      const expected=([0,1,2] as const).map(channel=>{
        const value=evaluateExpression(resonancePaletteExpression(channel).replace("op('wgsl_room').par.paletteCycle","cycle"),{abstime:seconds,cycle});
        if(!value.ok) throw new Error(JSON.stringify(value));
        return value.value;
      });
      const sum=tint[0]!+tint[1]!+tint[2]!;
      const expectedSum=expected.reduce((a,b)=>a+b,0);
      for(let c=0;c<3;c++) expect(tint[c]!/sum).toBeCloseTo(expected[c]!/expectedSum,5);
    }
  },60_000);

});
