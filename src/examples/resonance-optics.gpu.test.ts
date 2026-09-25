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
async function pixels(source:string,output:string,parameters:Record<string,number>={},lensParameters:Record<string,number>={}) {
  const graph=structuredClone(resonanceDocument.graph);
  Object.assign(graph.nodes["lens"]!.parameters,lensParameters);
  graph.nodes["room"]!.parameters={...graph.nodes["room"]!.parameters,...parameters,source:prefix+source};
  const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph,settings:{...resonanceDocument.settings,outputResolution:{width:256,height:4}},frames:1,outputNodeId:output});
  expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
  const f=result.frames[0]!;
  return toRgba8({width:f.width,height:f.height,format:f.format,bytes:f.bytes,rowStride:f.width*BYTES_PER_PIXEL[f.format]},{space:"linear"}).data;
}
// GPU captures above are display encoded. Spatial energy assertions use linear light.
function linearByte(value:number):number {
  const v=value/255;
  return 255*(v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4));
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
  it("bass strikes illuminate stone beside a floor fixture without lifting distant blacks",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const source="\n@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {return vec4f(surface(vec3f(select(3.9,9.0,uv.x>0.5),0,0.2),vec3f(0,-1,0),1.0),1);}";
    const quiet=await pixels(source,"room",{bass:0,energy:0,beatPosition:0});
    const strike=await pixels(source,"room",{bass:1,energy:0,beatPosition:0});
    expect(strike[0]!-quiet[0]!).toBeGreaterThan(12);
    expect(Math.abs(strike[200*4]!-quiet[200*4]!)).toBeLessThanOrEqual(1);
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

  it("adds soft arcs without darkening the room, core or floor behind their footprint",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const capture=async(enabled:boolean)=>{
      const graph=structuredClone(resonanceDocument.graph);
      Object.assign(graph.nodes["fracture"]!.parameters,{expansion:0.8,rotation:0,vibration:0});
      Object.assign(graph.nodes["seams"]!.parameters,{voltage:1,gain:0.8,rotation:0});
      Object.assign(graph.nodes["innerSeams"]!.parameters,{voltage:0.65,gain:0.8,rotation:0});
      Object.assign(graph.nodes["room"]!.parameters,{energy:0.6,bass:0.4,haze:0.018});
      if(!enabled) {
        for(const id of ["shot","lightShot"]) {
          graph.nodes[id]!.parameters["scenes"]=String(graph.nodes[id]!.parameters["scenes"]).split(" ").filter(label=>
            Object.values(graph.nodes).find(n=>n.label===label)?.parameters["blend"]!=="additive").join(" ");
        }
      }
      const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph,settings:{...resonanceDocument.settings,outputResolution:{width:160,height:120}},frames:1,outputNodeId:"room"});
      expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
      const f=result.frames[0]!;
      return toRgba8({width:f.width,height:f.height,format:f.format,bytes:f.bytes,rowStride:f.width*BYTES_PER_PIXEL[f.format]},{space:"linear"}).data;
    };
    const baseline=await capture(false),lit=await capture(true);
    let brighter=0,worst=0;
    for(let i=0;i<baseline.length;i+=4){
      let gain=0;
      for(let c=0;c<3;c++){const delta=lit[i+c]!-baseline[i+c]!;worst=Math.min(worst,delta);gain+=delta;}
      if(gain>6) brighter++;
    }
    expect(worst).toBeGreaterThanOrEqual(-1);
    expect(brighter).toBeGreaterThan(20);
  },120_000);

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

  it("advects the water downward and keeps it visible under a dark video projection",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const sample=async(travel:boolean,projection:boolean,water=1)=>{
      const graph=structuredClone(resonanceDocument.graph);
      const source=projection?
        "return vec4f(panelContent(vec2f(uv.x*0.58,2.0+uv.y*9.0),3),1);":
        `let seed=hash(vec3f(3,params.projectionSeed,83));let offset=${travel?"frameU.absTime*(1.15+seed*0.4)":"0.0"};return vec4f(vec3f(fallingWater(vec2f(uv.x*0.58,2.0+uv.y*9.0-offset),3).z),1);`;
      graph.nodes["room"]!.parameters={...graph.nodes["room"]!.parameters,panelVideo:1,videoMotion:0,videoGlitch:0,panelWater:water,paletteCycle:0,
        source:prefix+"\n@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {"+source+"}"};
      const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph,settings:{...resonanceDocument.settings,outputResolution:{width:64,height:64}},frames:2,capture:[0,1],fps:2,outputNodeId:"room"});
      expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
      return result.frames.map(f=>toRgba8({width:f.width,height:f.height,format:f.format,bytes:f.bytes,rowStride:f.width*BYTES_PER_PIXEL[f.format]},{space:"linear"}).data);
    };
    const following=await sample(true,false),stationary=await sample(false,false);
    let followingDelta=0,stationaryDelta=0;
    for(let i=0;i<following[0]!.length;i+=4){
      followingDelta+=Math.abs(following[0]![i]!-following[1]![i]!);
      stationaryDelta+=Math.abs(stationary[0]![i]!-stationary[1]![i]!);
    }
    expect(followingDelta/4096).toBeLessThan(0.1);
    expect(stationaryDelta/4096).toBeGreaterThan(5);
    const wet=await sample(false,true),dry=await sample(false,true,0);
    const red=(p:Uint8Array)=>Array.from(p).filter((_,i)=>i%4===0).reduce((a,b)=>a+b,0)/4096;
    expect(red(wet[0]!)).toBeGreaterThan(15);
    expect(red(dry[0]!)).toBe(0);
  },60_000);

  it("adds bounded subpixel colour separation with a true zero-intensity identity",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const edge="\n@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {return vec4f(vec3f(select(0.0,1.0,uv.x>0.8)),0.173);}";
    const off=await pixels(edge,"lens",{}, {chromatic:0,strength:0});
    const on=await pixels(edge,"lens",{}, {chromatic:0.75,strength:0});
    const capped=await pixels(edge,"lens",{}, {chromatic:4,strength:0});
    expect(on).toEqual(capped);
    let split=0;
    for(let x=0;x<256;x++) {
      expect(off[x*4]).toBe(off[x*4+2]);
      split=Math.max(split,Math.abs(on[x*4]!-on[x*4+2]!));
      if(x<202 || x>208) expect(on[x*4]).toBe(off[x*4]);
    }
    expect(split).toBeGreaterThan(30);
    const flat="\n@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {return vec4f(0.2,0.3,0.4,0.173);}";
    expect(await pixels(flat,"lens",{}, {chromatic:0.75,strength:0})).toEqual(await pixels(flat,"lens",{}, {chromatic:0,strength:0}));
  },60_000);

  it("opaque reflected fragments replace the room behind them instead of adding it",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const sample=async(brightness:number)=>{
      const graph=structuredClone(resonanceDocument.graph);
      // An opaque near reflection covers the floor pixels; changing the room behind it must be invisible.
      const source=RESONANCE_ROOM_WGSL.replace(/fn sceneAt\(uv:vec2f\)->vec4f \{[\s\S]*?\n\}/,
        "fn sceneAt(uv:vec2f)->vec4f {return vec4f(0.12,0.09,0.06,0.18);}");
      graph.nodes["room"]!.parameters={...graph.nodes["room"]!.parameters,source,haze:0,energy:0,highs:0,transient:0,beatPulse:0,panelBrightness:brightness,panelSequence:0,panelScene:0};
      const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph,settings:{...resonanceDocument.settings,outputResolution:{width:64,height:64}},frames:1,outputNodeId:"room"});
      expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
      const f=result.frames[0]!;
      return toRgba8({width:f.width,height:f.height,format:f.format,bytes:f.bytes,rowStride:f.width*BYTES_PER_PIXEL[f.format]},{space:"linear"}).data;
    };
    const dark=await sample(0),bright=await sample(8);
    let difference=0;
    for(let y=52;y<64;y++) for(let x=0;x<64;x++) for(let c=0;c<3;c++) difference=Math.max(difference,Math.abs(dark[(y*64+x)*4+c]!-bright[(y*64+x)*4+c]!));
    expect(difference).toBeLessThanOrEqual(1);
  },60_000);

  it("confines the ceiling veil to the aperture and builds density with atmosphere",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const source="\n@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {return vec4f(ceilingVeil(vec3f(uv.x*10.0,13.55,0)),ceilingVeil(vec3f(uv.x*10.0,7,0)),0,1);}";
    const quiet=await pixels(source,"room",{atmosphere:0});
    const full=await pixels(source,"room",{atmosphere:1});
    let quietSum=0,fullSum=0;
    for(let x=0;x<256;x++){
      quietSum+=quiet[x*4]!;fullSum+=full[x*4]!;
      expect(full[x*4+1]).toBe(0);
      if(x>220) expect(full[x*4]).toBe(0);
    }
    expect(fullSum).toBeGreaterThan(quietSum*1.5);
  },60_000);

  it("moves shaft accents upward by default, supports reversal and hold, and accelerates at peaks",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const source="\n@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {return vec4f(shaftPacket(uv.x*12.0,0),shaftPacket(uv.x*12.0,1),0,1);}";
    const crest=(image:Uint8Array|Uint8ClampedArray,channel=0)=>{
      let best=0;for(let x=1;x<256;x++) if(image[x*4+channel]!>image[best*4+channel]!) best=x;return best;
    };
    const low=await pixels(source,"room",{energy:0.1,beatPosition:10});
    const lowLater=await pixels(source,"room",{energy:0.1,beatPosition:11});
    const high=await pixels(source,"room",{energy:0.9,beatPosition:10});
    const highLater=await pixels(source,"room",{energy:0.9,beatPosition:11});
    const slow=crest(lowLater)-crest(low),fast=crest(highLater)-crest(high);
    expect(slow).toBeGreaterThan(7);expect(slow).toBeLessThan(14);
    expect(fast).toBeGreaterThan(slow*2.4);expect(fast).toBeLessThan(slow*3.2);
    expect(Math.abs(crest(high)-crest(high,1))).toBeGreaterThan(20);
    const down=await pixels(source,"room",{energy:0.9,beatPosition:10,shaftDirection:-1});
    const downLater=await pixels(source,"room",{energy:0.9,beatPosition:11,shaftDirection:-1});
    expect(crest(down)-crest(downLater)).toBeGreaterThan(20);
    const held=await pixels(source,"room",{energy:0.9,beatPosition:10,shaftDirection:0});
    const heldLater=await pixels(source,"room",{energy:0.9,beatPosition:11,shaftDirection:0});
    expect(heldLater).toEqual(held);
    const boundary=await pixels(source,"room",{energy:0.5,beatPosition:10.9999});
    const next=await pixels(source,"room",{energy:0.5,beatPosition:11.0001});
    expect(Math.max(...Array.from(boundary,(value,i)=>Math.abs(value-next[i]!)))).toBeLessThanOrEqual(1);
  },60_000);

  it("disables travelling shaft accents with a closed shell even under maximum percussion",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const source="\n@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {let strand=u32(floor(uv.x*56.0));return vec4f(shaftAccent(strand)+shaftPulseGain(),shaftBulbWidth(0.02,1.0)-0.02,shaftBaseGain()+shaftVolumeGain(),1);}";
    const closed=await pixels(source,"room",{energy:0,bass:0,highs:0,transient:0,beatPulse:0});
    const hit=await pixels(source,"room",{energy:0,bass:1,highs:1,transient:1,beatPulse:1});
    const open=await pixels(source,"room",{energy:0.9,bass:1,highs:1,transient:1,beatPulse:1});
    expect(hit).toEqual(closed);
    for(let x=0;x<256;x++){expect(hit[x*4]).toBe(0);expect(hit[x*4+1]).toBe(0);}
    expect(linearByte(hit[2]!)).toBeLessThan(4);
    expect(open[0]!).toBeGreaterThan(100);expect(open[1]!).toBeGreaterThan(0);
    expect(open[2]!).toBeGreaterThan(hit[2]!*3);
  },60_000);

  it("keeps low-energy shaft accents sparse and faint even on percussion, then builds density",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const source="\n@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {let strand=u32(floor(uv.x*56.0));return vec4f(shaftAccent(strand),shaftPulseGain()*0.25,0,1);}";
    const quiet=await pixels(source,"room",{energy:0.1,bass:1,transient:1,beatPulse:1});
    const full=await pixels(source,"room",{energy:0.9,bass:1,transient:1,beatPulse:1});
    const active=(image:Uint8Array|Uint8ClampedArray)=>Array.from({length:56},(_,i)=>image[Math.floor((i+0.5)*256/56)*4]!).filter(v=>v>128).length;
    expect(active(quiet)).toBe(1);expect(active(full)).toBe(4);
    expect(linearByte(quiet[1]!)).toBeLessThan(8);
    expect(linearByte(full[1]!)).toBeGreaterThan(linearByte(quiet[1]!)*10);
    expect(linearByte(full[1]!)).toBeLessThan(80);
  },60_000);

  it("bounds shaft bulb width and preserves the palette instead of whitening accents",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const source="\n@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {return vec4f(shaftBulbWidth(0.02,1.0),shaftBulbWidth(0.02,0.0),0,1);}";
    const quiet=await pixels(source,"room",{energy:0.1});
    const middle=await pixels(source,"room",{energy:0.55});
    const high=await pixels(source,"room",{energy:0.9});
    expect(linearByte(quiet[0]!)/255).toBeLessThan(0.027);
    expect(linearByte(high[0]!)/255).toBeGreaterThan(0.04);
    expect(linearByte(high[0]!)/255).toBeLessThan(0.048);
    // The visible swell must already read when the shell is partly open, rather
    // than existing only as a nearly invisible highlight until maximum expansion.
    expect(linearByte(middle[0]!)).toBeGreaterThan(linearByte(middle[1]!)*1.5);
    expect(quiet[1]).toBe(high[1]);
    expect(RESONANCE_ROOM_WGSL).toContain("shaftAccentColour()*bulb*shaftPulseGain()");
    expect(RESONANCE_ROOM_WGSL).toContain("shaftAccentColour()*travelling");
  },60_000);

  it("fades shaft ends and surface intersections continuously without interior cutoffs",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const source="\n@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {return vec4f(shaftEnvelope(uv.x*16.0,0.32),shaftVisibility(uv.x*4.0-2.0,1.0),0,1);}";
    const values=Array.from(await pixels(source,"room"),linearByte);
    expect(values[0]).toBe(0);
    expect(values[255*4]).toBe(0);
    expect(values[128*4]).toBe(255);
    for(let x=1;x<256;x++) {
      expect(Math.abs(values[x*4]!-values[(x-1)*4]!)).toBeLessThanOrEqual(12);
      expect(values[x*4+1]!).toBeGreaterThanOrEqual(values[(x-1)*4+1]!);
      // Smoothstep slope is at most 2 linear bytes/sample; display quantization adds up to 2.3.
      expect(values[x*4+1]!-values[(x-1)*4+1]!).toBeLessThanOrEqual(5);
      if(x>42 && x<204) expect(values[x*4]!).toBeGreaterThan(75);
    }
    expect(values[1]).toBe(0);
    expect(values[255*4+1]).toBe(255);
  },60_000);

  it("preserves visible beam pixels when skipping negligible Gaussian tails",async(ctx)=>{
    if(unavailable){ctx.skip();return;}
    const sample=async(bounded:boolean)=>{
      const graph=structuredClone(resonanceDocument.graph);
      // Keep identical shader arithmetic on both sides; a test-only uniform switches
      // the cull instead of asking the GPU compiler to optimize two different modules.
      const source=RESONANCE_ROOM_WGSL.replace("struct Params {","struct Params {\n  testTailCull:f32, // @default 1\n")
        .replace(" && d*d<tailVariance*20.0"," && (params.testTailCull<0.5 || d*d<tailVariance*20.0)");
      graph.nodes["room"]!.parameters={...graph.nodes["room"]!.parameters,source,testTailCull:bounded?1:0,energy:1,highs:1,beatPulse:1,atmosphere:1};
      const result=await renderHeadless({host:nodeGpuHost(),components:await starterComponentsView(),graph,settings:{...resonanceDocument.settings,outputResolution:{width:320,height:180}},frames:2,capture:[0,1],fps:1/72,animate:true,outputNodeId:"out"});
      expect(result.diagnostics.filter(d=>d.severity==="error")).toEqual([]);
      return result.frames.map(f=>toRgba8({width:f.width,height:f.height,format:f.format,bytes:f.bytes,rowStride:f.width*BYTES_PER_PIXEL[f.format]},{space:result.plan.outputs.find(o=>o.nodeId==="out")!.space}).data);
    };
    const bounded=await sample(true),full=await sample(false);
    for(let frame=0;frame<bounded.length;frame++) {
      let total=0,max=0;
      for(let i=0;i<bounded[frame]!.length;i++) {const difference=Math.abs(bounded[frame]![i]!-full[frame]![i]!);total+=difference;max=Math.max(max,difference);}
      expect(max,`tail cull frame ${frame}`).toBeLessThanOrEqual(1);
      expect(total/bounded[frame]!.length).toBeLessThan(0.001);
    }
  },60_000);

});
