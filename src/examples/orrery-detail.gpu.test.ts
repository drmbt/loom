import { beforeAll, expect, it } from "vitest";
import { aetherOrreryDocument } from "./documents/monument-halls.ts";
import { starterComponentsView } from "./component-files.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { pointStorageId } from "../nodes/definitions/point-storage.ts";
import { kernelRegionSlice } from "../nodes/definitions/test-support.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";

let unavailable:string|undefined;
beforeAll(async()=>{unavailable=(await probeDawn()).error;},60_000);
it("keeps beveled orbit volumes disjoint and lights the core without audio-driven bobbing",async(ctx)=>{
  if(unavailable){ctx.skip();return;}
  const ids=[...Array.from({length:5},(_,i)=>`ring${i}Form`),"plasmaForm"];
  const sample=async(energy:number,plasma=true,isolated=false)=>{
    const doc=structuredClone(aetherOrreryDocument);
    for(const id of ids) doc.graph.nodes[id]!.parameters.energy=energy;
    if(!plasma) doc.graph.nodes.lightShot!.parameters.scenes=String(doc.graph.nodes.lightShot!.parameters.scenes).replace(/plasmamesh1|plasmareflection1/g,"");
    if(isolated) {
      doc.graph.nodes.shot!.parameters.scenes="coremesh1";
      doc.graph.nodes.lightShot!.parameters.scenes=`lightoccluder_coremesh1 ${plasma?"plasmamesh1":""}`;
    }
    const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph:doc.graph,settings:{...doc.settings,outputResolution:{width:320,height:180}},frames:1,outputNodeId:"out",probeBuffers:plasma&&!isolated?ids.map(pointStorageId):[]});
    expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
    const read=(id:string,name:string)=>{
      const bytes=result.buffers?.[pointStorageId(id)];
      if(!bytes) throw new Error(`Missing ${id} buffer`);
      return kernelRegionSlice(doc.graph.nodes[id]!,bytes,name).floats;
    };
    const frame=result.frames[0]!;
    const pixels=toRgba8({width:frame.width,height:frame.height,format:frame.format,bytes:frame.bytes,rowStride:frame.width*BYTES_PER_PIXEL[frame.format]},{space:result.plan.outputs.find(o=>o.nodeId==="out")!.space}).data;
    return {read,pixels};
  };
  const resting=await sample(0),peak=await sample(1),withoutCore=await sample(1,false);
  let previousOuter=0;
  for(const id of ids.slice(0,5)) {
    const position=peak.read(id,"position");
    expect(Array.from(position)).toEqual(Array.from(resting.read(id,"position")));
    let inner=Infinity,outer=0;
    for(let i=0;i<position.length;i+=4) {
      const radius=Math.hypot(position[i]!,position[i+1]!-5.65,position[i+2]!);
      expect(Number.isFinite(radius)).toBe(true);
      inner=Math.min(inner,radius);outer=Math.max(outer,radius);
    }
    expect(inner).toBeGreaterThan(previousOuter+0.05);
    previousOuter=outer;
    // Every cross-section row meets at each capped end, including bevel rows.
    for(let row=1;row<17;row++) for(const end of [0,255]) for(let axis=0;axis<3;axis++) {
      expect(position[(row*256+end)*4+axis]).toBe(position[end*4+axis]);
    }
  }
  expect(Array.from(peak.read("plasmaForm","position"))).toEqual(Array.from(resting.read("plasmaForm","position")));
  expect(Array.from(peak.read("plasmaForm","tint"))).not.toEqual(Array.from(resting.read("plasmaForm","tint")));
  const plasma=peak.read("plasmaForm","position");
  for(let i=0;i<plasma.length;i+=4) expect(Math.hypot(plasma[i]!,plasma[i+1]!-5.65,plasma[i+2]!)).toBeLessThan(1.15);
  // Free-space filaments must survive room/depth compositing, not merely exist in buffers.
  let visiblePixels=0;
  for(let y=60;y<115;y++) for(let x=130;x<190;x++) {
    const at=(y*320+x)*4;
    if(peak.pixels[at+2]!>withoutCore.pixels[at+2]!+15) visiblePixels++;
  }
  expect(visiblePixels).toBeGreaterThan(15);
  const isolated=await sample(1,true,true),nucleus=await sample(1,false,true);
  // Remove all orbit geometry, then inspect outside the opaque nucleus silhouette.
  // This fails if beams only survive where an unrelated opaque surface wrote depth.
  const eye=aetherOrreryDocument.graph.nodes.cam!.parameters.eye as number[];
  const aim=aetherOrreryDocument.graph.nodes.cam!.parameters.lookAt as number[];
  const forward=aim.map((v,i)=>v-eye[i]!);
  const length=Math.hypot(...forward);forward.forEach((v,i)=>{forward[i]=v/length;});
  const delta=[-eye[0]!,5.65-eye[1]!,-eye[2]!];
  const depth=delta.reduce((sum,v,i)=>sum+v*forward[i]!,0);
  const up=[0,-forward[2]!,forward[1]!];
  const focal=90/Math.tan(Number(aetherOrreryDocument.graph.nodes.cam!.parameters.fov)*Math.PI/360);
  const centreY=90-delta.reduce((sum,v,i)=>sum+v*up[i]!,0)*focal/depth;
  const nucleusPixels=0.63*focal/depth;
  let freeSpacePixels=0;
  for(let y=0;y<180;y++) for(let x=0;x<320;x++) {
    const radius=Math.hypot(x+0.5-160,y+0.5-centreY);
    if(radius<nucleusPixels+1.5 || radius>1.15*focal/depth+1) continue;
    const at=(y*320+x)*4;
    if(isolated.pixels[at+2]!>nucleus.pixels[at+2]!+20) freeSpacePixels++;
  }
  expect(freeSpacePixels).toBeGreaterThan(12);
},120_000);
