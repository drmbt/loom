/** A normal editable Loom document made only of production nodes. */
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createDomainBus} from '../../src/domain/commands/index.ts';
import {createSequentialIdFactory} from '../../src/domain/graph/ids.ts';
import {buildProjectFile} from '../../src/domain/project/project-file.ts';
import {allNodeDefinitions} from '../../src/nodes/definitions/index.ts';
import {createNodeRegistry} from '../../src/nodes/registry/registry.ts';
import {paritySettings} from '../../src/tests/fixtures/parity-graphs.ts';
import {document} from '../../src/examples/documents/builders.ts';
export async function projectFixture(){
 const registry=createNodeRegistry(allNodeDefinitions);
 const {bus,store}=createDomainBus({registry:registry.view(),ids:createSequentialIdFactory('nativeproject'),now:()=> '2026-09-17T00:00:00.000Z'});
 const nodes=[['source','checker',{}],['tile','tile',{repeat:[2,3]}],['mirror','mirror',{rotate:0}],['rotate','transform',{r:180,aspectcorrect:false}],['crop','crop',{left:.1,right:.9,bottom:.05,top:.95}],['flip','flip',{flipx:true}]];
 const result=await bus.execute('graph.applyPatch',{baseRevision:0,operations:[
  ...nodes.map(([ref,type,parameters],i)=>({op:'addNode',ref:`$${ref}`,type,parameters,position:{x:i*200,y:0}})),
  ...nodes.slice(1).map(([ref],i)=>({op:'connect',source:{nodeId:`$${nodes[i][0]}`,portId:'out'},target:{nodeId:`$${ref}`,portId:'input'}})),
 ]},{actor:{kind:'human',id:'native-project'},projectId:'native-project',capabilities:[]});
 if(result.status!=='applied')throw Error(JSON.stringify(result));
 const ids=result.output.createdIds;
 const doc=document('native-project','Native FFGL transforms',paritySettings({size:64}),store.view.getGraph());
 const text=buildProjectFile({document:doc,now:()=> '2026-09-17T00:00:00.000Z'}).text;
 const contract={schemaVersion:1,input:{nodeId:ids.$source,portId:'out'},output:{nodeId:ids.$flip,portId:'out'},controls:[
  {name:'Rotation',nodeId:ids.$rotate,parameter:'r',min:0,max:240},
  {name:'Fold angle',nodeId:ids.$mirror,parameter:'rotate',min:-60,max:40},
 ]};
 return {text,contract,ids};
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const out=resolve(process.argv[2]??'.cache/ffgl-native-project');await mkdir(out,{recursive:true});
 const f=await projectFixture();await writeFile(resolve(out,'transforms.loom.json'),f.text);await writeFile(resolve(out,'interface.json'),JSON.stringify(f.contract,null,2)+'\n');
 console.log(`Saved production-node project and interface to ${out}`);
}
