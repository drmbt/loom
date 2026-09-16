import { writeFileSync, mkdirSync } from 'node:fs';
import { resonanceDocument } from '../../src/examples/documents/resonance.ts';
import { nodeGpuHost } from '../../src/runtime/backend/vgpu/node-gpu-host.ts';
import { renderHeadless } from '../../src/tests/headless/render-harness.ts';
import { starterComponentsView } from '../../src/examples/component-files.ts';
import { shippedClipAudio } from '../../src/examples/shipped-clip-audio.ts';
import { toRgba8 } from '../../src/runtime/export/image.ts';
import { encodePng } from '../../src/runtime/export/png.ts';
const output=process.argv[3] ?? 'out';
const graph=structuredClone(resonanceDocument.graph);
const video=process.argv[2]==='video';
if(video) graph.nodes.panelSource!.parameters.index=1;
const sweep=process.argv[2]==='sweep';
const motion=process.argv[2]==='motion';
const live=process.argv[2]==='audio'||motion||sweep;
const fps=sweep?15:motion?30:60;
if(motion) mkdirSync('/tmp/resonance-motion',{recursive:true});
const energy=Number(video ? 0.7 : live ? 0 : process.argv[2] ?? '0.75');
if(!live){
graph.nodes.room!.parameters.panelSequence=0;
graph.nodes.room!.parameters.panelScene=1;
graph.nodes.fracture!.parameters.expansion=energy;
graph.nodes.fracture!.parameters.fissure=0.004+energy*0.152;
graph.nodes.seams!.parameters.gain=energy;
graph.nodes.rim!.parameters.intensity=0.2+energy*3.8;
graph.nodes.debris!.parameters.expansion=energy;
graph.nodes.chipForm!.parameters.expansion=energy;
graph.nodes.debris!.parameters.highs=energy;
for(const name of ['energy','bass','mids','highs','transient','atmosphere']) graph.nodes.room!.parameters[name]=energy;
}
const result=await renderHeadless({host:nodeGpuHost(),graph,settings:{...resonanceDocument.settings,outputResolution:{width:motion||sweep?960:1280,height:motion||sweep?540:720}},fps,frames:video?90:sweep?1441:motion?180:live?361:1,capture:video?[89]:sweep?[0,180,225,240,420,465,480,660,705,720,900,945,960,1140,1185,1200,1380,1425,1440]:motion?Array.from({length:180},(_,i)=>i):live?[0,60,180,360]:[0],outputNodeId:output,animate:true,components:await starterComponentsView(),audio:shippedClipAudio(graph,fps)});
const errors=result.diagnostics.filter(d=>d.severity==='error');
if(errors.length) throw Error(JSON.stringify(errors,null,2));
for(const f of result.frames){
const img=toRgba8({width:f.width,height:f.height,format:f.format,bytes:f.bytes,rowStride:f.width*8},{space:result.plan.outputs.find(o=>o.nodeId===output)!.space});
const png=encodePng(img);
writeFileSync(motion?`/tmp/resonance-motion/frame-${String(f.frameIndex).padStart(4,'0')}.png`:`artifacts/resonance/${output}-${video?'video-test-card':sweep?'sweep-'+f.frameIndex:live?'audio-'+f.frameIndex:'energy-'+energy}.png`,png.bytes);
}
console.log('rendered',live?'audio':energy);
