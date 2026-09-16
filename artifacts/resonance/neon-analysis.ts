import { readFileSync, writeFileSync } from 'node:fs';
import { analyseOffline } from '../../src/app/audio-offline-analysis.ts';
import { AUDIO_DETECTOR_DEFAULTS } from '../../src/nodes/definitions/audio.ts';
import { readFeatureFrame, serializeFeatureTrack } from '../../src/domain/audio/feature-track.ts';
import { flattenComponents } from '../../src/compiler/flatten.ts';
import { createValueGraphSession } from '../../src/domain/channels/value-graph.ts';
import { allNodeDefinitions } from '../../src/nodes/definitions/index.ts';
import { createNodeRegistry } from '../../src/nodes/registry/registry.ts';
import { starterComponentsView } from '../../src/examples/component-files.ts';
import { resonanceDocument } from '../../src/examples/documents/resonance.ts';
const bytes=readFileSync('/tmp/resonance-neon-wake.f32');
const pcm=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4);
const analysis=analyseOffline(pcm,48000,60,AUDIO_DETECTOR_DEFAULTS);
writeFileSync('/tmp/resonance-neon-track.json',serializeFeatureTrack(analysis.track));
const registry=createNodeRegistry(allNodeDefinitions).view();
const graph=flattenComponents({graph:resonanceDocument.graph,registry,components:await starterComponentsView()}).graph;
const session=createValueGraphSession(registry);
const buckets:Record<string,number[]>[]=[];
for(let i=0;i<Math.floor(pcm.length/800);i++) {
 const audio=readFeatureFrame(analysis.track,i);
 const r=session.evaluate(graph,{timeSeconds:i/60,deltaSeconds:1/60,frameIndex:i,mode:'offline',randomSeed:75},{audio});
 const read=(s:string)=>Number(r.resolver(s,undefined as never));
 const bucket=buckets[Math.floor(i/600)]??(buckets[Math.floor(i/600)]={});
 for(const [name,v] of Object.entries({raw:audio.level,kicks:audio.kickCount,snares:audio.snareCount,hats:audio.hatCount,kick:read('detail1:kickCount'),snare:read('detail1:snareCount'),body:Math.max(0,Math.min(1,((read('body1:low')*.65+read('body1:level')*.35)-.2)*2.1*Math.min(1,read('presence1:level')*6)))})) (bucket[name]??=[]).push(v??0);
}
const summary={tempo:analysis.tempo,bar:analysis.bar,detector:AUDIO_DETECTOR_DEFAULTS,seconds:buckets.map((b,i)=>({start:i*10,...Object.fromEntries(Object.entries(b).map(([k,v])=>[k,{min:Math.min(...v),max:Math.max(...v),mean:v.reduce((a,b)=>a+b,0)/v.length}]))}))};
writeFileSync('/tmp/resonance-neon-analysis.json',JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
