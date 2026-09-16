import { beforeAll, describe, expect, it } from "vitest";
import { resonanceDocument } from "./documents/resonance.ts";
import { RESONANCE_ROOM_WGSL } from "./shaders/resonance.wgsl.ts";
import { starterComponentsView } from "./component-files.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { SHARED_UNIFORMS_WGSL } from "../runtime/backend/shared-uniforms.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
let unavailable:string|undefined;
beforeAll(async()=>{unavailable=(await probeDawn()).error;},60_000);
const prefix=RESONANCE_ROOM_WGSL.slice(0,RESONANCE_ROOM_WGSL.indexOf("@fragment fn fs"));
async function pixels(source:string,output:string,parameters:Record<string,number>={}) {
  const graph=structuredClone(resonanceDocument.graph);
  graph.nodes["room"]!.parameters={...graph.nodes["room"]!.parameters,...parameters,source:prefix+source};
  const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph,settings:{...resonanceDocument.settings,outputResolution:{width:256,height:4}},frames:1,outputNodeId:output});
  expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
  const f=result.frames[0]!;
  return toRgba8({width:f.width,height:f.height,format:f.format,bytes:f.bytes,rowStride:f.width*BYTES_PER_PIXEL[f.format]},{space:"linear"}).data;
}
describe("Resonance floor and lens response",()=>{
  it("floor strikes have substantial range and their bright front travels outward",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const source="\n@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {return vec4f(surface(vec3f(3.0+uv.x*4.5,0,0),vec3f(0,-1,0),1.0)*0.05,1);}";
    const quiet=await pixels(source,"room",{bass:0,energy:0,beatPosition:0.25});
    const early=await pixels(source,"room",{bass:1,energy:0,beatPosition:0.25});
    const late=await pixels(source,"room",{bass:1,energy:0,beatPosition:0.75});
    expect(early[45*4]!).toBeGreaterThan(quiet[45*4]!*3);
    expect(early[64*4]!).toBeGreaterThan(late[64*4]!*1.5);
    expect(late[192*4]!).toBeGreaterThan(early[192*4]!*1.5);
  },60_000);
  it("keeps the focus plane sharp and gently softens the distant background",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const source=(depth:number)=>`\n@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {return vec4f(vec3f(f32(u32(uv.x*256.0)%2u)),${depth});}`;
    const sharp=await pixels(source(0.173),"lens");
    const soft=await pixels(source(0.4),"lens");
    expect(sharp[128*4]).toBe(0);
    expect(sharp[129*4]).toBe(255);
    expect(soft[128*4]!).toBeGreaterThan(20);
    expect(soft[129*4]!).toBeLessThan(245);
    expect(sharp[128*4+3]).toBe(255);
    expect(soft[128*4+3]).toBe(255);
  },60_000);
  it("does not bleed a focused foreground silhouette into the blurred background",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const image=await pixels("\n@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {let rear=uv.x>=0.5;return vec4f(vec3f(select(0.0,1.0,rear)),select(0.173,0.4,rear));}","lens");
    expect(image[127*4]).toBe(0);
    expect(image[128*4]!).toBeGreaterThan(250);
  },60_000);
  it("projects actual delayed source cells, with distinct bays and a shared staging state",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const sample=async(shared:boolean)=>{
      const graph=structuredClone(resonanceDocument.graph);
      // Deterministic moving video fixture; camera hardware is deliberately not part of this test.
      graph.nodes["panelCam"]={...graph.nodes["panelCam"]!,type:"customWgsl",parameters:{source:`
${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler:sampler;
@group(0) @binding(1) var inputTexture:texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU:SharedFrame;
@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {
  return vec4f(vec3f(clamp(frameU.absTime*0.35,0.0,1.0)),1);
}`},resolution:{mode:"fixed",width:512,height:288}};
      graph.edges["fixture-feed"]={id:"fixture-feed",source:{nodeId:"envSeed",portId:"out"},target:{nodeId:"panelCam",portId:"input"}};
      graph.nodes["panelSource"]!.parameters["index"]=1;
      graph.nodes["room"]!.parameters={...graph.nodes["room"]!.parameters,panelSequence:0,panelScene:shared?0:1,panelAudio:0,panelBrightness:1,
        source:prefix+"\n@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {return vec4f(panelLight(vec2f(0.29,7),floor(uv.x*24.0)),1);}"};
      const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph,settings:{...resonanceDocument.settings,outputResolution:{width:96,height:8}},fps:30,frames:75,animate:true,outputNodeId:"room"});
      expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
      const f=result.frames[0]!;
      const image=toRgba8({width:f.width,height:f.height,format:f.format,bytes:f.bytes,rowStride:f.width*BYTES_PER_PIXEL[f.format]},{space:"linear"}).data;
      return Array.from({length:24},(_,i)=>image[(i*4+2)*4]!);
    };
    const different=await sample(false),shared=await sample(true);
    expect(Math.max(...different)-Math.min(...different)).toBeGreaterThan(20);
    expect(Math.max(...shared)-Math.min(...shared)).toBe(0);
    expect(shared[0]).toBeGreaterThan(5);
  },60_000);

  it("reveals the luminous core through the actual nested geometry at strong energy",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const graph=structuredClone(resonanceDocument.graph);
    graph.nodes["fracture"]!.parameters["expansion"]=0.7;
    graph.nodes["fracture"]!.parameters["fissure"]=0.11;
    graph.nodes["room"]!.parameters={...graph.nodes["room"]!.parameters,energy:0.7,haze:0};
    const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph,settings:{...resonanceDocument.settings,outputResolution:{width:320,height:180}},frames:1,animate:true,outputNodeId:"room"});
    expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
    const f=result.frames[0]!;
    const image=toRgba8({width:f.width,height:f.height,format:f.format,bytes:f.bytes,rowStride:f.width*BYTES_PER_PIXEL[f.format]},{space:"linear"}).data;
    let exposed=0;
    for(let y=55;y<85;y++) for(let x=148;x<172;x++) {
      const at=(y*320+x)*4;
      if(image[at]!>245 && image[at+1]!>220 && image[at+2]!>175) exposed++;
    }
    expect(exposed).toBeGreaterThan(30);
  },60_000);

  it("center-crops a square camera source without stretching a circular subject",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const graph=structuredClone(resonanceDocument.graph);
    graph.nodes["panelCam"]={...graph.nodes["panelCam"]!,type:"customWgsl",resolution:{mode:"fixed",width:400,height:400},parameters:{source:`
@group(0) @binding(0) var inputSampler:sampler;
@group(0) @binding(1) var inputTexture:texture_2d<f32>;
@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {return vec4f(vec3f(select(0.0,1.0,length(uv-0.5)<0.2)),1);}`}};
    graph.edges["fixture-feed"]={id:"fixture-feed",source:{nodeId:"envSeed",portId:"out"},target:{nodeId:"panelCam",portId:"input"}};
    const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph,settings:resonanceDocument.settings,frames:1,outputNodeId:"cameraCrop"});
    expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
    const f=result.frames[0]!;
    const img=toRgba8({width:f.width,height:f.height,format:f.format,bytes:f.bytes,rowStride:f.width*BYTES_PER_PIXEL[f.format]},{space:"linear"}).data;
    const width=Array.from({length:f.width},(_,x)=>img[(Math.floor(f.height/2)*f.width+x)*4]!).filter(v=>v>128).length;
    const height=Array.from({length:f.height},(_,y)=>img[(y*f.width+Math.floor(f.width/2))*4]!).filter(v=>v>128).length;
    expect(width).toBeGreaterThan(180);
    expect(Math.abs(width-height)).toBeLessThanOrEqual(2);
  },60_000);
  it("keeps a still video alive and slowly cycles the architectural palette",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const sample=async(source:string)=>{
      const graph=structuredClone(resonanceDocument.graph);
      graph.nodes["room"]!.parameters={...graph.nodes["room"]!.parameters,panelVideo:1,videoMotion:0.6,
        source:prefix+source};
      const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph,settings:{...resonanceDocument.settings,outputResolution:{width:96,height:64}},frames:3,capture:[0,1,2],fps:1/36,outputNodeId:"room"});
      expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
      return result.frames.map(f=>toRgba8({width:f.width,height:f.height,format:f.format,bytes:f.bytes,rowStride:f.width*BYTES_PER_PIXEL[f.format]},{space:"linear"}).data);
    };
    const moving=await sample("\n@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {return vec4f(panelContent(vec2f(uv.x*0.58,1.75+uv.y*10.45),3),1);}");
    let changed=0;
    for(let i=0;i<moving[0]!.length;i+=4) changed+=Math.abs(moving[0]![i]!-moving[1]![i]!);
    expect(changed/(96*64)).toBeGreaterThan(2);
    const palette=await sample("\n@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {return vec4f(paletteWarm(),1);}");
    expect(palette[1]![1]!).toBeLessThan(palette[0]![1]!); // Gold -> orange.
    expect(palette[2]![2]!).toBeGreaterThan(palette[2]![0]!); // Violet.
  },60_000);

});
