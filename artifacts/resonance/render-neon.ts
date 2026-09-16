import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resonanceDocument } from '../../src/examples/documents/resonance.ts';
import { starterComponentsView } from '../../src/examples/component-files.ts';
import { parseFeatureTrack, readFeatureFrame } from '../../src/domain/audio/feature-track.ts';
import { nodeGpuHost } from '../../src/runtime/backend/vgpu/node-gpu-host.ts';
import { renderHeadless } from '../../src/tests/headless/render-harness.ts';
import { toRgba8 } from '../../src/runtime/export/image.ts';
import { encodePng } from '../../src/runtime/export/png.ts';
const parsed=parseFeatureTrack(readFileSync('/tmp/resonance-neon-track.json','utf8'));
if(!parsed.ok) throw new Error(JSON.stringify(parsed));
const graph=structuredClone(resonanceDocument.graph);
graph.nodes.clip!.parameters.tempoMode='auto';
graph.nodes.clip!.parameters.bpm=120.1144;
const frames=690;
const result=await renderHeadless({host:nodeGpuHost(),graph,components:await starterComponentsView(),settings:{...resonanceDocument.settings,outputResolution:{width:960,height:540}},fps:30,frames,capture:Array.from({length:240},(_,i)=>450+i),animate:true,outputNodeId:'out',audio:i=>readFeatureFrame(parsed.track,900+i*2)});
if(result.diagnostics.some(d=>d.severity==='error')) throw new Error(JSON.stringify(result.diagnostics));
mkdirSync('/tmp/resonance-neon-frames',{recursive:true});
for(const f of result.frames){
 const img=toRgba8({width:f.width,height:f.height,format:f.format,bytes:f.bytes,rowStride:f.width*8},{space:result.plan.outputs.find(o=>o.nodeId==='out')!.space});
 writeFileSync(`/tmp/resonance-neon-frames/frame-${String(f.frameIndex-450).padStart(4,'0')}.png`,encodePng(img).bytes);
}
console.log('Rendered Neon Wake 30–38 s after 15 s of feature-history warmup.');
