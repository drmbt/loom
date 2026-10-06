/** Supported real-project export: static geometry filters, explicit host input and controls. */
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadProject} from '../../src/domain/project/load.ts';
import {allNodeDefinitions} from '../../src/nodes/definitions/index.ts';
import {createNodeRegistry} from '../../src/nodes/registry/registry.ts';
import {compileGraph} from '../../src/compiler/index.ts';
import {asCompilerContext} from '../../src/compiler/types.ts';
import {nominalCapabilities} from '../../src/tests/fixtures/parity-graphs.ts';
import {isParameterSlot,staticBindingValue} from '../../src/domain/parameters/slots.ts';
import {hostNode,packagePlan} from './export.mjs';
import {VERTEX} from './shaders.mjs';
const supported=new Set(['transform','crop','flip','mirror','tile']);
const controlFields={transform:{r:['rot',Math.PI/180]},mirror:{rotate:['rotate',Math.PI/180]}};
function fail(message){throw Error(`FFGL export: ${message}`);}
function keys(value,allowed,label){
 if(!value || typeof value!=='object' || Array.isArray(value))fail(`${label} must be an object`);
 const extra=Object.keys(value).filter(k=>!allowed.includes(k));
 if(extra.length)fail(`Unsupported ${label} fields: ${extra.join(', ')}`);
}
export function compileProject(text,contract,{width,height,capabilities=nominalCapabilities()}={}) {
 const base=createNodeRegistry(allNodeDefinitions);
 const loaded=loadProject(text,{nodes:base.view()});
 if(!loaded.ok)fail(loaded.reason);
 if(loaded.newerThanApp || loaded.placeholders.length || loaded.unknownParameters.length || loaded.components.length || loaded.diagnostics.some(d=>d.severity==='error' || d.severity==='warning'))fail('Project has unknown features, components, or load errors');
 keys(contract,['schemaVersion','input','output','controls'],'contract');
 keys(contract.input,['nodeId','portId'],'input');
 keys(contract.output,['nodeId','portId'],'output');
 if(width!==undefined && (!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>4096||height>4096))fail('Dimensions must be integers in 1..4096');
 const d=loaded.document, g=d.graph;
 if(d.assets.length)fail('Assets are not supported');
 if(contract.schemaVersion!==1)fail('Unsupported export contract version');
 if(!g.nodes[contract.input?.nodeId] || contract.input.portId!=='out' || !g.nodes[contract.output?.nodeId] || contract.output.portId!=='out')fail('Input/output must identify existing out ports');
 if(contract.input.nodeId===contract.output.nodeId)fail('Input and output must differ');
 const input=g.nodes[contract.input.nodeId];
 const source=base.view().get(input.type);
 if(!source || source.inputs.length || source.outputs.length!==1 || source.outputs[0].id!=='out' || source.outputs[0].type.kind!=='texture2d')fail('Host input must replace a texture source with one out port and no inputs');
 if(Object.values(g.edges).some(e=>e.target.nodeId===input.id))fail('Host input cannot have incoming edges');
 for(const n of Object.values(g.nodes)) {
  if(n.id!==input.id && !supported.has(n.type))fail(`Unsupported node ${n.id} (${n.type})`);
  if(n.resolution && !['auto','project','input'].includes(n.resolution.mode))fail(`Unsupported resolution override on ${n.id}`);
  if(n.format && n.format.mode!=='auto')fail(`Unsupported format override on ${n.id}`);
  if(n.state && Object.keys(n.state).length)fail(`Unsupported node state on ${n.id}`);
  for(const [key,value] of Object.entries(n.parameters))if(isParameterSlot(value)&&value.mode!=='static')fail(`Dynamic parameter ${n.id}.${key} requires a native evaluator`);
  if(n.type==='transform') {
   const v=n.parameters.aspectcorrect;
   if((isParameterSlot(v)?staticBindingValue(v):v)!==false)fail(`Transform ${n.id} must disable aspect correction in this resizable profile`);
  }
 }
 if(d.settings.workingFormat!=='rgba8unorm')fail('Project must use rgba8unorm');
 const registry=createNodeRegistry(allNodeDefinitions.map(def=>def.type!==input.type?def:{...def,compile(raw){return asCompilerContext(raw).nodeId===input.id?hostNode.compile(raw):def.compile(raw);}}));
 const settings={...d.settings,...(width===undefined?{}:{outputResolution:{width,height}})};
 const compiled=compileGraph({graph:g,settings,registry:registry.view(),capabilities,sinks:[{...contract.output,kind:'output'}]});
 if(!compiled.ok || compiled.diagnostics.some(d=>d.severity==='warning'))fail(JSON.stringify(compiled.diagnostics));
 const externals=compiled.resources.filter(r=>r.kind==='externalTexture');
 if(externals.length!==1 || externals[0].sourceId!=='ffgl-input')fail('Selected output must depend on the host input');
 if(!Array.isArray(contract.controls)||contract.controls.length>2)fail('At most two numeric controls supported');
 const names=new Set(),targets=new Set();
 const controls=contract.controls.map(c=>{
  keys(c,['name','nodeId','parameter','min','max'],'control');
  const n=g.nodes[c.nodeId], mapping=controlFields[n?.type]?.[c.parameter];
  if(!mapping)fail(`Unsupported control ${c.nodeId}.${c.parameter}`);
  if(typeof c.name!=='string'||!/^[ -~]{1,15}$/.test(c.name)||names.has(c.name))fail('Control names must be unique printable ASCII, 1..15 characters');names.add(c.name);
  const key=`${c.nodeId}.${c.parameter}`;if(targets.has(key))fail('Duplicate control target');targets.add(key);
  if(!Number.isFinite(c.min)||!Number.isFinite(c.max)||c.min>=c.max)fail(`Invalid range for ${key}`);
  const def=base.view().get(n.type).parameters[c.parameter];
  if(c.min<def.min||c.max>def.max)fail(`Control range exceeds node range for ${key}`);
  const pass=compiled.passes.find(p=>p.nodeId===n.id && p.uniforms?.[mapping[0]]!==undefined);
  if(!pass)fail(`Control target is not in the selected output graph: ${key}`);
  const value=pass.uniforms[mapping[0]]/mapping[1];
  if(value<c.min||value>c.max)fail(`Saved value is outside exported range: ${key}`);
  return {name:c.name,pass:pass.id,field:mapping[0],default:(value-c.min)/(c.max-c.min),scale:(c.max-c.min)*mapping[1],offset:c.min*mapping[1]};
 });
 const pkg={...packagePlan(compiled),profile:'loom-native-static-1',output:compiled.outputs.find(o=>o.nodeId===contract.output.nodeId&&o.portId===contract.output.portId)?.resourceId,controls,vertex:VERTEX};
 if(!pkg.output)fail('Output did not materialize');
 return {package:pkg,compiled,registry,settings,document:d,contract};
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const [project,interfaceFile,out]=process.argv.slice(2);if(!project||!interfaceFile||!out)fail('Usage: project.mjs project.loom.json contract.json output-directory');
 const result=compileProject(await readFile(project,'utf8'),JSON.parse(await readFile(interfaceFile,'utf8')));
 await mkdir(out,{recursive:true});await writeFile(resolve(out,'package.json'),JSON.stringify(result.package,null,2)+'\n');
 console.log(`Exported real project: ${result.compiled.passes.length} passes, ${result.package.controls.length} controls`);
}
