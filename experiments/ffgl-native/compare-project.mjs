/** Native captures versus fresh Loom compilation of edited saved-project parameters. */
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {compileProject} from './project.mjs';
import {createDomainBus} from '../../src/domain/commands/index.ts';
import {buildProjectFile} from '../../src/domain/project/project-file.ts';
import {createVgpuBackend} from '../../src/runtime/backend/vgpu/vgpu-backend.ts';
import {nodeGpuHost} from '../../src/runtime/backend/vgpu/node-gpu-host.ts';
const [projectPath,contractPath,dir]=process.argv.slice(2);
if(!dir)throw Error('Usage: compare-project.mjs project.loom.json interface.json capture-directory');
const text=await readFile(projectPath,'utf8'),contract=JSON.parse(await readFile(contractPath,'utf8'));
const original=compileProject(text,contract);
const {bus,store}=createDomainBus({registry:original.registry.view(),initialGraph:original.document.graph,initialSettings:original.settings});
let maxError=0,count=0;
for(const [w,h,second] of [[64,64,false],[96,48,false],[128,72,false],[64,64,true]]){
 const backend=createVgpuBackend({host:nodeGpuHost()});const errors=[];
 backend.onDiagnostic(d=>{if(d.severity==='error')errors.push(d);});
 try {
  const capabilities=await backend.initialize({});
  const bytes=new Uint8Array(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
   const sy=h-1-y,alpha=128+(x+sy)%128,i=(y*w+x)*4;
   bytes[i]=(x*7+sy*3)%alpha;bytes[i+1]=(x*2+sy*11)%alpha;bytes[i+2]=(x*13+sy*5)%alpha;bytes[i+3]=alpha;
  }
  backend.registerMediaSource('ffgl-input',{currentFrame:()=>({frameId:1,bytes})});
  for(let frameIndex=0;frameIndex<12;frameIndex++){
   const values=second?[.25,0]:[Math.fround(frameIndex/11),Math.fround((11-frameIndex)/11)];
   const result=await bus.execute('graph.applyPatch',{baseRevision:store.view.getRevision(),operations:contract.controls.map((c,i)=>({op:'setParameters',nodeId:c.nodeId,parameters:{[c.parameter]:c.min+values[i]*(c.max-c.min)}}))},{actor:{kind:'human',id:'parity'},projectId:original.document.projectId,capabilities:[]});
   if(result.status!=='applied')throw Error(JSON.stringify(result));
   const frameText=buildProjectFile({document:{...original.document,graph:store.view.getGraph()}}).text;
   const f=compileProject(frameText,contract,{width:w,height:h,capabilities});
   const compiled=await backend.compile(f.compiled);
   backend.render(compiled,{frame:{timeSeconds:frameIndex/12,deltaSeconds:1/12,frameIndex,mode:'fixed-step',randomSeed:7},pointer:{x:0,y:0,buttons:0},resolution:[w,h]});
   const image=await backend.readOutput(f.package.output);
   const native=await readFile(resolve(dir,`${second?'second':`${w}x${h}`}-${frameIndex}.rgba`));
   if(native.length!==w*h*4)throw Error('Incorrect capture size');
   let frameError=0;
   for(let y=0;y<h;y++)for(let x=0;x<w*4;x++)frameError=Math.max(frameError,Math.abs(image.bytes[y*image.rowStride+x]-native[(h-1-y)*w*4+x]));
   if(frameError>2)throw Error(`Parity failed ${w}x${h} frame ${frameIndex} second=${second}: ${frameError}/255`);
   maxError=Math.max(maxError,frameError);count++;
  }
  if(errors.length)throw Error(JSON.stringify(errors));
 }finally{backend.dispose();}
}
console.log(`PASS saved-project parity: ${count} frames, three sizes, two instances, mapped controls; max difference ${maxError}/255`);
