/** Isolated native-engine fixture. Run with the repository's alias-hooks loader. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compileGraph } from '../../src/compiler/index.ts';
import { createDomainBus } from '../../src/domain/commands/index.ts';
import { createSequentialIdFactory } from '../../src/domain/graph/ids.ts';
import { buildProjectFile } from '../../src/domain/project/project-file.ts';
import { createNodeRegistry } from '../../src/nodes/registry/registry.ts';
import { transformNode } from '../../src/nodes/definitions/transforms.ts';
import { asCompilerContext } from '../../src/compiler/types.ts';
import { nominalCapabilities, paritySettings } from '../../src/tests/fixtures/parity-graphs.ts';
import { document } from '../../src/examples/documents/builders.ts';
import { COPY, COMPUTE, DRAW, VERTEX } from './shaders.mjs';

const rgba = { kind: 'texture2d', sample: 'float', channels: 4 };
export const hostNode = {
  type: 'ffgl.probeInput', version: 1, title: 'FFGL probe input', category: 'input',
  inputs: [], outputs: [{ id: 'out', label: 'Out', type: rgba }], parameters: {},
  resolutionPolicy: { kind: 'project' }, formatPolicy: { kind: 'project' },
  compile(raw) {
    const c = asCompilerContext(raw);
    return { scratch: [{kind:'external', key:'host', sourceId:'ffgl-input', format:'rgba8unorm'}], passes: [{
      kind:'effect', id:`${c.nodeId}:input`, shader:COPY, target:c.outputs.out,
      textures:[{binding:'inputTexture', resourceId:`scratch:${c.nodeId}:host`}],
    }] };
  },
};
export const computeNode = {
  type: 'ffgl.probeCompute', version: 1, title: 'FFGL compute proof', category: 'filter',
  inputs: [{ id:'input', label:'Input', type:rgba }], outputs:[{id:'out', label:'Out',type:rgba}],
  parameters:{gain:{type:'number',label:'Gain',default:1,min:0,max:1},pulse:{type:'number',label:'Pulse',default:0,min:0,max:1}},
  resolutionPolicy:{kind:'project'},formatPolicy:{kind:'project'},
  compile(raw) {
    const c=asCompilerContext(raw), buffer=`scratch:${c.nodeId}:factor`;
    return {scratch:[{kind:'buffer',key:'factor',stride:4,capacity:4}],passes:[
      {kind:'dispatch',id:`${c.nodeId}:compute`,shader:COMPUTE,entryPoint:'main',workgroups:[1,1,1],
       buffers:[{binding:'factor',resourceId:buffer}],uniformBinding:'params',
       uniforms:{gain:c.parameters.gain,pulse:c.parameters.pulse,timeSeconds:0,pad:0}},
      {kind:'draw',id:`${c.nodeId}:apply`,shader:VERTEX+DRAW,target:c.outputs.out,topology:'triangle-list',instances:1,vertexCount:3,
       textures:[{binding:'inputTexture',resourceId:c.inputs.input[0].resourceId}],buffers:[{binding:'factor',resourceId:buffer}]},
    ]};
  },
};
export async function fixture() {
  const registry=createNodeRegistry([hostNode,computeNode,transformNode]);
  const {bus,store}=createDomainBus({registry:registry.view(),ids:createSequentialIdFactory('ffgl'),now:()=> '2026-09-16T00:00:00.000Z'});
  const result=await bus.execute('graph.applyPatch',{baseRevision:0,operations:[
    {op:'addNode',ref:'$input',type:hostNode.type,position:{x:0,y:0}},
    {op:'addNode',ref:'$compute',type:computeNode.type,position:{x:200,y:0}},
    {op:'addNode',ref:'$transform',type:'transform',position:{x:400,y:0},parameters:{r:180,aspectcorrect:false}},
    {op:'connect',source:{nodeId:'$input',portId:'out'},target:{nodeId:'$compute',portId:'input'}},
    {op:'connect',source:{nodeId:'$compute',portId:'out'},target:{nodeId:'$transform',portId:'input'}},
  ]},{actor:{kind:'human',id:'ffgl-probe'},projectId:'ffgl-probe',capabilities:[]});
  if(result.status!=='applied') throw Error(JSON.stringify(result));
  const ids=result.output.createdIds;
  const settings=paritySettings({size:64});
  const graph=store.view.getGraph();
  const compiled=compileGraph({graph,settings,registry:registry.view(),capabilities:nominalCapabilities(),sinks:[{nodeId:ids.$transform,portId:'out',kind:'output'}]});
  if(!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  return {compiled,graph,settings,registry,ids,document:document('ffgl-probe','FFGL native proof',settings,graph)};
}

// This deliberately supports only the fixture's flat f32/vec2f/vec4f uniform ABI. No
// guessed layout for other WGSL types; this is not a general reflection library.
export function packUniforms(shader, values) {
  const decl=/var<uniform>\s+(\w+)\s*:\s*(\w+)/.exec(shader);
  if(!decl) {if(values && Object.keys(values).length) throw Error('Uniform values without declaration');return null;}
  const body=new RegExp(`struct ${decl[2]}\\s*\\{([^}]+)\\}`).exec(shader)?.[1];
  if(!body) throw Error('Missing flat uniform struct');
  let offset=0;
  const fields=[];
  for(const field of body.split(',').map(x=>x.trim()).filter(Boolean)) {
    const match=/^(\w+)\s*:\s*(f32|vec2f|vec4f)$/.exec(field);
    if(!match) throw Error(`Unsupported uniform member: ${field}`);
    const [,name,type]=match, count=type==='f32'?1:type==='vec2f'?2:4;
    offset=Math.ceil(offset/count)*count;
    const value=values[name];
    if(value===undefined) throw Error(`Missing uniform value ${name}`);
    const data=Array.isArray(value)?value:[value];
    if(data.length!==count || data.some(x=>typeof x!=='number'||!Number.isFinite(x))) throw Error(`Invalid ${name}`);
    fields.push({name,offset,values:data});offset+=count;
  }
  return {binding:decl[1],size:Math.ceil(offset/4)*16,fields};
}
export function packagePlan(compiled) {
  if(!compiled.ok) throw Error('Cannot package failed compilation');
  for(const r of compiled.resources) {
    if(!['target','externalTexture','sampler','buffer'].includes(r.kind)) throw Error(`Unsupported resource ${r.id}: ${r.kind}`);
    if(r.format && r.format!=='rgba8unorm') throw Error(`Unsupported format ${r.id}: ${r.format}`);
    if(r.depth||r.msaa) throw Error(`Unsupported attachments: ${r.id}`);
  }
  const passes=compiled.passes.map(p=>{
    if(!['effect','dispatch','draw'].includes(p.kind)) throw Error(`Unsupported pass ${p.id}: ${p.kind}`);
    if(p.sharedBinding || p.blend || p.depthWrite!==undefined) throw Error(`Unsupported pass state ${p.id}`);
    const bindings=[...p.shader.matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<[^>]+>)?\s+(\w+)\s*:/g)].map(m=>({group:Number(m[1]),slot:Number(m[2]),name:m[3]}));
    if(bindings.some(b=>b.group!==0)) throw Error(`Only group 0 supported: ${p.id}`);
    return {...p,bindings,packedUniforms:packUniforms(p.shader,p.uniforms)};
  });
  return {schemaVersion:1,profile:'loom-native-probe-1',resources:compiled.resources,passes};
}
if(process.argv[1]===new URL(import.meta.url).pathname) {
  const dir=resolve(process.argv[2] ?? '.cache/ffgl-native-package');await mkdir(dir,{recursive:true});
  const f=await fixture();
  const pkg={...packagePlan(f.compiled),output:f.compiled.outputs.find(o=>o.nodeId===f.ids.$transform).resourceId,
    controls:[{name:'Gain',pass:f.compiled.passes.find(p=>p.kind==='dispatch' && p.nodeId===f.ids.$compute).id,field:'gain',default:1},{name:'Pulse',pass:f.compiled.passes.find(p=>p.kind==='dispatch' && p.nodeId===f.ids.$compute).id,field:'pulse',default:0}],
    time:{pass:f.compiled.passes.find(p=>p.kind==='dispatch' && p.nodeId===f.ids.$compute).id,field:'timeSeconds'},vertex:VERTEX};
  await writeFile(resolve(dir,'package.json'),JSON.stringify(pkg,null,2)+'\n');
  await writeFile(resolve(dir,'project.loom.json'),buildProjectFile({document:{...f.document,settings:f.settings},now:()=> '2026-09-16T00:00:00.000Z'}).text);
  console.log(`Exported ${pkg.passes.length} compiler passes, ${pkg.resources.length} resources to ${dir}`);
}
