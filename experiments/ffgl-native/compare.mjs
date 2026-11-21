/** Compare native host captures against the existing Loom WebGPU backend. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixture } from './export.mjs';
import { compileGraph } from '../../src/compiler/index.ts';
import { createVgpuBackend } from '../../src/runtime/backend/vgpu/vgpu-backend.ts';
import { nodeGpuHost } from '../../src/runtime/backend/vgpu/node-gpu-host.ts';

const dir=process.argv[2];if(!dir)throw Error('Pass native capture directory');
const f=await fixture(),w=96,h=48;
const backend=createVgpuBackend({host:nodeGpuHost()});
const errors=[];backend.onDiagnostic(d=>{if(d.severity==='error')errors.push(d);});
try {
 const capabilities=await backend.initialize({});
 const settings={...f.settings,outputResolution:{width:w,height:h}};
 const plan=compileGraph({graph:f.graph,settings,registry:f.registry.view(),capabilities,sinks:[{nodeId:f.ids.$transform,portId:'out',kind:'output'}]});
 if(!plan.ok)throw Error(JSON.stringify(plan.diagnostics));
 const bytes=new Uint8Array(w*h*4);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
   const sy=h-1-y,alpha=128+(x+sy)%128,i=(y*w+x)*4;
   bytes[i]=(x*7+sy*3)%alpha;bytes[i+1]=(x*2+sy*11)%alpha;bytes[i+2]=(x*13+sy*5)%alpha;bytes[i+3]=alpha;
 }
 backend.registerMediaSource('ffgl-input',{currentFrame:()=>({frameId:1,bytes})});
 const compiled=await backend.compile(plan);
 const compute=plan.passes.find(p=>p.kind==='dispatch');
 backend.updateUniforms({passId:compute.id,values:{...compute.uniforms,gain:.75,pulse:.6}});
 const output=plan.outputs.find(o=>o.nodeId===f.ids.$transform).resourceId;
 let maxError=0,different=0;
 for(let frameIndex=0;frameIndex<12;frameIndex++){
   backend.render(compiled,{frame:{timeSeconds:frameIndex/12,deltaSeconds:1/12,frameIndex,mode:'fixed-step',randomSeed:7},pointer:{x:0,y:0,buttons:0},resolution:[w,h]});
   const image=await backend.readOutput(output);
   const native=await readFile(resolve(dir,`frame-${frameIndex}.rgba`));
   if(native.length!==w*h*4)throw Error('Incorrect native capture size');
   for(let y=0;y<h;y++)for(let x=0;x<w*4;x++){
     const d=Math.abs(image.bytes[y*image.rowStride+x]-native[(h-1-y)*w*4+x]);
     maxError=Math.max(maxError,d);if(d)different++;
   }
 }
 if(errors.length)throw Error(JSON.stringify(errors));
 if(maxError>2)throw Error(`Native/Loom parity failed: maxError=${maxError}, different=${different}`);
 console.log(`PASS native/Loom parity: 12 animated 96x48 RGBA frames, max channel difference ${maxError}/255 (${different} nonidentical channels)`);
} finally {backend.dispose();}
