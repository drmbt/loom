import { compileGraph } from '../../src/compiler/index.ts';
import { createVgpuBackend } from '../../src/runtime/backend/vgpu/vgpu-backend.ts';
import { nodeGpuHost } from '../../src/runtime/backend/vgpu/node-gpu-host.ts';
import { resonanceDocument } from '../../src/examples/documents/resonance.ts';
import { starterComponentsView } from '../../src/examples/component-files.ts';
import { exampleRegistry } from '../../src/examples/runner.ts';
const mode=process.argv[2]??'shipped';
const graph=structuredClone(resonanceDocument.graph);
for(const id of ['fracture','chipForm','debris']) graph.nodes[id]!.parameters.expansion=0.7;
for(const name of ['energy','bass','mids','highs','transient','atmosphere']) graph.nodes.room!.parameters[name]=0.7;
if(mode!=='shipped' && mode!=='room-native' && mode!=='no-video-path') {graph.nodes.room!.resolution={mode:'project'};graph.nodes.shot!.parameters.antialias='none';}
if(mode==='room-native') graph.nodes.room!.resolution={mode:'project'};
if(mode==='no-fog') graph.nodes.room!.parameters.source=String(graph.nodes.room!.parameters.source).replace(/for\(var i=0u;i<40u;i\+\+\)\{[\s\S]*?\n {2}}/,'');
if(mode==='no-panels') graph.nodes.room!.parameters.source=String(graph.nodes.room!.parameters.source).replace(/fn panelContent[\s\S]*?\n}/,'fn panelContent(localUv:vec2f,panelId:f32)->vec3f {return vec3f(0); }');
if(mode==='no-audience') graph.nodes.room!.parameters.source=String(graph.nodes.room!.parameters.source).replace(/fn audience[\s\S]*?\n}/,'fn audience(ro:vec3f,rd:vec3f)->f32 {return 1000.0;}');
if(mode==='no-video-path') {
 graph.edges['atlas-room']!.source={nodeId:'depthPack',portId:'out'};
 graph.edges['video-environment']!.source={nodeId:'envSeed',portId:'out'};
 graph.nodes.room!.parameters.source=String(graph.nodes.room!.parameters.source)
 .replace('uv*vec2f(dimensions)*0.5','uv*vec2f(dimensions)')
 .replace('vec2i(dimensions/2u)-1','vec2i(dimensions)-1')
 .replace('clamp(uv*0.5,0.5/vec2f(dimensions),vec2f(0.5)-0.5/vec2f(dimensions))','uv');
}
const backend=createVgpuBackend({host:nodeGpuHost()});
const spans:Record<string,number[]>={};
const totals:number[]=[];
backend.onDiagnostic(d=>{if(d.severity==='error') throw Error(d.message);});
backend.onGpuTimings((values,frame)=>{for(const [id,ms] of Object.entries(values)) (spans[id]??=[]).push(ms);if(frame)totals.push(frame.gpuMs);});
try {
 const capabilities=await backend.initialize({});
 if(!capabilities.timestampQuery) throw Error('GPU timing unavailable');
 const plan=compileGraph({graph,settings:resonanceDocument.settings,registry:exampleRegistry(),components:await starterComponentsView(),capabilities});
 if(!plan.ok) throw Error(JSON.stringify(plan.diagnostics));
 const compiled=await backend.compile(plan);
 let start=0;
 for(let i=0;i<30;i++){
  if(i===5) start=performance.now();
  backend.render(compiled,{frame:{timeSeconds:i/60,deltaSeconds:1/60,frameIndex:i,mode:'offline',randomSeed:75},pointer:{x:0,y:0,buttons:0},resolution:[1280,720]});
  await backend.whenSettled();
 }
 await backend.whenSettled();
 const wall=performance.now()-start;
 console.log(JSON.stringify({mode,wallMsPerFrame:wall/25,passes:Object.entries(spans).map(([id,v])=>({id,ms:v.slice(5).reduce((a,b)=>a+b,0)/Math.max(1,v.length-5),n:v.length})).sort((a,b)=>b.ms-a.ms),timedSegments:totals.length},null,2));
}finally{backend.dispose();}
