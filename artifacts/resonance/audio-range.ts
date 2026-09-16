import { flattenComponents } from '../../src/compiler/flatten.ts';
import { createValueGraphSession } from '../../src/domain/channels/value-graph.ts';
import { allNodeDefinitions } from '../../src/nodes/definitions/index.ts';
import { createNodeRegistry } from '../../src/nodes/registry/registry.ts';
import { starterComponentsView } from '../../src/examples/component-files.ts';
import { resonanceDocument } from '../../src/examples/documents/resonance.ts';
import { shippedClipAudio } from '../../src/examples/shipped-clip-audio.ts';
const registry=createNodeRegistry(allNodeDefinitions).view();
const graph=flattenComponents({graph:resonanceDocument.graph,registry,components:await starterComponentsView()}).graph;
const session=createValueGraphSession(registry);
const audio=shippedClipAudio(resonanceDocument.graph,60);
const values:number[]=[];
for(let i=0;i<1920;i++) {
 const r=session.evaluate(graph,{timeSeconds:i/60,deltaSeconds:1/60,frameIndex:i,mode:'offline',randomSeed:75},{audio:audio(i)});
 const read=(s:string)=>Number(r.resolver(s,undefined as never));
 values.push(Math.max(0,Math.min(1,((read('body1:low')*.65+read('body1:level')*.35)-.2)*2.1*Math.min(1,read('presence1:level')*6))));
}
console.log(JSON.stringify({maximum:Math.max(...values),minimum:Math.min(...values),seconds:values.filter((_,i)=>i%60===0)},null,2));
