/** Scene export, profile `loom-native-2`: a saved Loom scene to a package the native Dawn engine runs.
 *  The project loader and the compiler stay authoritative. This file only selects, checks and packs
 *  what they produce, and refuses by name whatever the profile does not cover. See README.md. */
import {readFile,mkdir,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {resolve,extname} from 'node:path';
import {loadProject} from '../../src/domain/project/load.ts';
import {allNodeDefinitions} from '../../src/nodes/definitions/index.ts';
import {createNodeRegistry} from '../../src/nodes/registry/registry.ts';
import {compileGraph} from '../../src/compiler/index.ts';
import {nominalCapabilities} from '../../src/tests/fixtures/parity-graphs.ts';
import {isParameterSlot} from '../../src/domain/parameters/slots.ts';
import {projectFps} from '../../src/domain/types/graph.ts';
import {VERTEX} from './shaders.mjs';
import {bindingsOf,uniformLayout} from './wgsl-layout.mjs';
import {lowerExpression,runProgram} from './expr.mjs';
import {decodePng} from './png.mjs';

export const PROFILE='loom-native-2';
/** Bumped whenever the engine must read the package differently. The engine refuses any other value. */
export const PACKAGE_ABI=1;
/** Nodes the engine executes. */
export const RENDER_NODES=new Set(['customWgsl','customWgslMulti','blur','add','null','output','movieFileIn']);
/** Nodes that become plugin parameters. */
export const CONTROL_NODES=new Set(['slider','toggle']);
/** Authoring-only nodes, dropped at export by rule (SPEC-VN decision 3). */
export const DROPPED_NODES=new Set(['panel','syphonOut','presets']);
const SHARED_FRAME=[['time',0],['deltaTime',4],['frameIndex',8],['randomSeed',12],['wallTime',16],['wallDelta',20],['absTime',24],['absFrame',28],['resolution',32],['pointer',48]];
const PASS_FIELDS=new Set(['kind','id','nodeId','label','shader','target','textures','samplers','uniformBinding','uniforms','sharedBinding','sourceMap']);
const fail=(message)=>{throw Error(`FFGL export: ${message}`);};
const where=(node)=>`"${node.label??node.id}" (${node.type}, id ${node.id}, at the root)`;
const numberOr=(value,fallback)=>typeof value==='number'&&Number.isFinite(value)?value:fallback;

function keys(value,allowed,label){
 if(!value||typeof value!=='object'||Array.isArray(value))fail(`${label} must be an object`);
 const extra=Object.keys(value).filter(k=>!allowed.includes(k));
 if(extra.length)fail(`Unsupported ${label} fields: ${extra.join(', ')}`);
}
/** Every slider and toggle, as the channel carries it: clamped into Min..Max, not snapped to Step. */
function controlsOf(graph){
 const controls=[];
 for(const node of Object.values(graph.nodes)){
  if(!CONTROL_NODES.has(node.type))continue;
  const p=node.parameters;
  for(const [key,value] of Object.entries(p))if(isParameterSlot(value)&&value.mode!=='static')fail(`Control ${where(node)} has a driven "${key}"; an exported control must hold plain values`);
  const channel=typeof p.channel==='string'&&/^[A-Za-z_]\w*$/.test(p.channel)?p.channel:'value';
  const caption=typeof p.caption==='string'&&p.caption.trim()?p.caption.trim():channel;
  if(node.type==='toggle'){
   controls.push({node:node.label??node.id,nodeId:node.id,type:'toggle',valueKey:'on',channel,caption,min:0,max:1,default:p.defaultOn===true?1:0});
   continue;
  }
  const min=numberOr(p.min,0),max=numberOr(p.max,1);
  if(!(min<max))fail(`Control ${where(node)} has an empty range ${min}..${max}`);
  const stored=numberOr(p.defaultValue,numberOr(p.value,min));
  controls.push({node:node.label??node.id,nodeId:node.id,type:'slider',valueKey:'value',channel,caption,min,max,default:Math.min(max,Math.max(min,stored))});
 }
 const names=new Set();
 for(const c of controls){if(names.has(c.node))fail(`Two controls are named "${c.node}"`);names.add(c.node);}
 return controls;
}
function compile(graph,settings,registry,output){
 const compiled=compileGraph({graph,settings,registry,capabilities:nominalCapabilities(),sinks:[{...output,kind:'output'}]});
 if(!compiled.ok)fail(`The scene does not compile: ${JSON.stringify(compiled.diagnostics.filter(d=>d.severity==='error'))}`);
 return compiled;
}
/** The passes that feed `outputId`, in plan order, and the resources they touch. */
function closure(compiled,outputId){
 const writers=new Map();
 for(const pass of compiled.passes){
  if(pass.target===undefined)continue;
  if(writers.has(pass.target))fail(`Resource ${pass.target} is written by more than one pass (${writers.get(pass.target).id}, ${pass.id}); feedback and layered targets are outside the profile`);
  writers.set(pass.target,pass);
 }
 const used=new Set(),resources=new Set();
 const visit=(id)=>{
  if(resources.has(id))return;resources.add(id);
  const pass=writers.get(id);if(!pass)return;
  used.add(pass.id);
  for(const t of pass.textures??[])visit(t.resourceId);
  for(const s of pass.samplers??[])resources.add(s.resourceId);
 };
 visit(outputId);
 return {passes:compiled.passes.filter(p=>used.has(p.id)),resources:compiled.resources.filter(r=>resources.has(r.id))};
}
const uniformSnapshot=(compiled)=>new Map(compiled.passes.map(p=>[p.id,p.uniforms??{}]));
/** Shape of a plan with the uniform VALUES left out: two plans with the same shape differ only in numbers. */
const shapeOf=(compiled)=>JSON.stringify([compiled.resources,compiled.passes.map(({uniforms,...rest})=>[rest,Object.keys(uniforms??{})])]);

/**
 * Compiles one plugin of the contract. Pure (no GPU, no files): `package.assets` lists what
 * `bakeAssets` must still produce.
 */
export function compileScene(text,contract,pluginName){
 const registry=createNodeRegistry(allNodeDefinitions).view();
 const loaded=loadProject(text,{nodes:registry});
 if(!loaded.ok)fail(loaded.reason);
 if(loaded.newerThanApp)fail('The project was saved by a newer Loom than this checkout');
 if(loaded.placeholders.length)fail(`Unknown node types: ${JSON.stringify(loaded.placeholders)}`);
 if(loaded.unknownParameters.length)fail(`Unknown parameters: ${JSON.stringify(loaded.unknownParameters)}`);
 if(loaded.components.length)fail('Components are outside the export profile');
 const loadErrors=loaded.diagnostics.filter(d=>d.severity==='error');
 if(loadErrors.length)fail(`The project loads with errors: ${JSON.stringify(loadErrors)}`);
 keys(contract,['schemaVersion','plugins','controls'],'interface');
 if(contract.schemaVersion!==2)fail('Unsupported interface version (this exporter reads schemaVersion 2)');
 if(!Array.isArray(contract.plugins)||!contract.plugins.length)fail('interface.plugins must list at least one plugin');
 const plugin=contract.plugins.find(p=>p?.name===pluginName);
 if(!plugin)fail(`interface.plugins has no plugin named "${pluginName}"`);
 keys(plugin,['name','kind','code','output'],'plugin');
 keys(plugin.output,['nodeId','portId'],'plugin.output');
 if(plugin.kind!=='source')fail(`Plugin "${plugin.name}": kind "${plugin.kind}" is not built yet (only "source")`);
 if(typeof plugin.name!=='string'||!/^[ -~]{1,16}$/.test(plugin.name))fail(`Plugin name "${plugin.name}" must be 1..16 printable ASCII characters (FFGL's limit)`);

 const document=loaded.document,graph=document.graph,settings=document.settings;
 const report={dropped:[],warnings:loaded.diagnostics.filter(d=>d.severity==='warning').map(d=>d.message),unusedControls:[]};
 const refused=[];
 for(const node of Object.values(graph.nodes)){
  if(DROPPED_NODES.has(node.type))report.dropped.push({node:node.label??node.id,type:node.type,why:'authoring-only node'});
  else if(!RENDER_NODES.has(node.type)&&!CONTROL_NODES.has(node.type))refused.push(where(node));
  if(RENDER_NODES.has(node.type)&&node.state&&Object.keys(node.state).length)refused.push(`${where(node)}: node state`);
 }
 if(refused.length)fail(`Nodes outside the ${PROFILE} profile:\n  ${refused.join('\n  ')}`);
 if(!graph.nodes[plugin.output.nodeId])fail(`Plugin "${plugin.name}": output node "${plugin.output.nodeId}" does not exist`);

 let controls=controlsOf(graph);
 if(contract.controls!==undefined){
  if(!Array.isArray(contract.controls))fail('interface.controls must be an array');
  const byNode=new Map(controls.map(c=>[c.node,c]));
  controls=contract.controls.map(entry=>{
   keys(entry,['node','name'],'control');
   const control=byNode.get(entry.node);
   if(!control)fail(`interface.controls names "${entry.node}", which is not a slider or toggle in the scene`);
   return {...control,...(entry.name===undefined?{}:{caption:entry.name})};
  });
 }
 const indexOf=new Map(controls.map((c,i)=>[`${c.node}\n${c.channel}`,i]));
 const controlIndex=(name,channel)=>indexOf.get(`${name}\n${channel}`)??(controls.some(c=>c.node===name)?`"${name}" publishes no channel "${channel}"`:`"${name}" is not an exported control`);

 // Every driven parameter, lowered. The expression is kept; nothing is frozen.
 const parameters=[];
 for(const node of Object.values(graph.nodes)){
  if(!RENDER_NODES.has(node.type))continue;
  for(const [key,slot] of Object.entries(node.parameters)){
   if(!isParameterSlot(slot)||slot.mode==='static')continue;
   const source=slot.bindings?.expression?.source;
   if(slot.mode!=='expression'||typeof source!=='string')fail(`Parameter "${key}" of ${where(node)} is in "${slot.mode}" mode; the profile takes static values and expressions`);
   let lowered;
   try{lowered=lowerExpression(source,controlIndex);}catch(error){fail(`Parameter "${key}" of ${where(node)}: expression \`${source}\` ${error.message}`);}
   parameters.push({nodeId:node.id,node:node.label??node.id,parameter:key,source,...lowered});
  }
 }
 const withValues=(values)=>({...graph,nodes:Object.fromEntries(Object.values(graph.nodes).map(node=>{
  const mine=parameters.map((p,i)=>[p,i]).filter(([p])=>p.nodeId===node.id);
  return [node.id,mine.length?{...node,parameters:{...node.parameters,...Object.fromEntries(mine.map(([p,i])=>[p.parameter,values[i]]))}}:node];
 }))});
 const defaults=controls.map(c=>c.default);
 const valueAt=(p,controlValues)=>{const v=runProgram(p.program,controlValues);if(!Number.isFinite(v))fail(`Parameter "${p.parameter}" of "${p.node}": \`${p.source}\` has no finite value`);return v;};
 const atDefaults=parameters.map(p=>valueAt(p,defaults));
 const baseline=compile(withValues(atDefaults),settings,registry,plugin.output);
 const output=baseline.outputs.find(o=>o.nodeId===plugin.output.nodeId&&o.portId===plugin.output.portId);
 if(!output)fail(`Plugin "${plugin.name}": output ${plugin.output.nodeId}.${plugin.output.portId} did not materialize`);
 const selected=closure(baseline,output.resourceId);
 const live=new Set(selected.passes.map(p=>p.id));

 // Which uniform fields each parameter moves, and how: measured on the compiler, never assumed.
 const baseShape=shapeOf(baseline),drives=[];
 parameters.forEach((p,index)=>{
  const reach=new Set([atDefaults[index]]);
  for(const corner of [controls.map(c=>c.min),controls.map(c=>c.max)]){
   const v=runProgram(p.program,corner);if(Number.isFinite(v))reach.add(v);
   for(const i of p.reads){const one=[...defaults];one[i]=corner[i];const w=runProgram(p.program,one);if(Number.isFinite(w))reach.add(w);}
  }
  const a=Math.min(...reach),b=Math.max(...reach);
  p.range=[a,b];
  if(a===b)return;
  const probe=(v)=>{const values=[...atDefaults];values[index]=v;const c=compile(withValues(values),settings,registry,plugin.output);
   if(shapeOf(c)!==baseShape)fail(`Parameter "${p.parameter}" of "${p.node}" changes the render plan itself between ${a} and ${b} (not only a uniform value); it cannot be driven per frame`);
   return uniformSnapshot(c);};
  const ua=probe(a),ub=probe(b),mid=a+(b-a)*0.375,um=probe(mid);
  for(const pass of selected.passes){
   for(const field of Object.keys(pass.uniforms??{})){
    const va=[ua.get(pass.id)[field]].flat(),vb=[ub.get(pass.id)[field]].flat(),vm=[um.get(pass.id)[field]].flat();
    va.forEach((x,component)=>{
     if(x===vb[component])return;
     const scale=(vb[component]-x)/(b-a),offset=x-scale*a,expected=scale*mid+offset;
     if(Math.abs(expected-vm[component])>1e-9*Math.max(1,Math.abs(expected)))fail(`Parameter "${p.parameter}" of "${p.node}" reaches uniform ${pass.id}.${field} through a curve (${vm[component]} at ${mid}, a straight line gives ${expected}); the profile carries straight-line mappings only`);
     drives.push({parameter:index,pass:pass.id,field,component,scale,offset});
    });
   }
  }
 });
 const usedParameters=new Set(drives.map(d=>d.parameter));
 const usedControls=new Set(parameters.flatMap((p,i)=>usedParameters.has(i)?p.reads:[]));
 report.unusedControls=controls.filter((_,i)=>!usedControls.has(i)).map(c=>c.node);

 const nodeOf=(pass)=>graph.nodes[pass.nodeId];
 const assets=[],bakedTargets=new Set();
 for(const pass of selected.passes){
  const node=nodeOf(pass);
  if(node?.type!=='movieFileIn')continue;
  const file=node.parameters.file;
  if(typeof file!=='string'||!file)fail(`${where(node)} has no still image; a movie source needs a file`);
  if(extname(file).toLowerCase()!=='.png')fail(`${where(node)} reads "${file}"; the profile packages PNG stills only (movies and other formats are refused)`);
  const media=baseline.resources.find(r=>r.kind==='externalTexture'&&(pass.textures??[]).some(t=>t.resourceId===r.id));
  const target=baseline.resources.find(r=>r.id===pass.target);
  if(!media||!target)fail(`${where(node)}: its media pass has an unexpected shape`);
  bakedTargets.add(target.id);
  assets.push({id:target.id,node:node.label??node.id,nodeId:node.id,source:file,mediaSize:media.size,size:target.size,format:target.format,file:`assets/${node.id.replace(/[^\w-]/g,'_')}.${target.format}.deflate`});
 }
 const passes=[];
 for(const pass of selected.passes){
  if(bakedTargets.has(pass.target))continue;
  const node=nodeOf(pass),label=node?where(node):pass.id;
  if(pass.kind!=='effect')fail(`Pass ${pass.id} of ${label} is a "${pass.kind}" pass; the profile runs fullscreen effect passes`);
  const extra=Object.keys(pass).filter(k=>!PASS_FIELDS.has(k));
  if(extra.length)fail(`Pass ${pass.id} of ${label} uses ${extra.join(', ')}, which the profile does not run`);
  for(const t of pass.textures??[]){
   const more=Object.keys(t).filter(k=>!['binding','resourceId','sampled'].includes(k));
   if(more.length)fail(`Pass ${pass.id} of ${label} binds ${t.binding} with ${more.join(', ')} (history, layers and slices are outside the profile)`);
  }
  const bindings=bindingsOf(pass.shader);
  if(bindings.some(b=>b.group!==0))fail(`Pass ${pass.id} of ${label} uses a bind group other than 0`);
  let uniforms=null;
  if(pass.uniformBinding!==undefined){
   const layout=uniformLayout(pass.shader,pass.uniformBinding);
   if(!layout)fail(`Pass ${pass.id} of ${label} names uniform "${pass.uniformBinding}" but its shader declares none`);
   uniforms={...layout,fields:layout.fields.map(f=>{
    const value=[(pass.uniforms??{})[f.name]].flat();
    if(value.length!==f.count||value.some(x=>typeof x!=='number'||!Number.isFinite(x)))fail(`Pass ${pass.id} of ${label}: uniform "${f.name}" has no ${f.count}-component value in the plan`);
    return {...f,value};
   })};
   const unknown=Object.keys(pass.uniforms??{}).filter(k=>!layout.fields.some(f=>f.name===k));
   if(unknown.length)fail(`Pass ${pass.id} of ${label}: plan values ${unknown.join(', ')} have no struct member`);
  }else if(pass.uniforms&&Object.keys(pass.uniforms).length)fail(`Pass ${pass.id} of ${label} has uniform values but no uniform binding`);
  if(pass.sharedBinding!==undefined){
   const shared=uniformLayout(pass.shader,pass.sharedBinding);
   if(!shared||shared.size!==64||JSON.stringify(shared.fields.map(f=>[f.name,f.offset]))!==JSON.stringify(SHARED_FRAME))fail(`Pass ${pass.id} of ${label}: its shared frame block is not the SharedFrame layout this engine fills`);
  }
  const named=new Set([...(pass.textures??[]).map(t=>t.binding),...(pass.samplers??[]).map(s=>s.binding),...(pass.uniformBinding?[pass.uniformBinding]:[]),...(pass.sharedBinding?[pass.sharedBinding]:[])]);
  const unmapped=bindings.filter(b=>!named.has(b.name));
  if(unmapped.length)fail(`Pass ${pass.id} of ${label}: shader bindings ${unmapped.map(b=>b.name).join(', ')} have nothing bound`);
  passes.push({id:pass.id,nodeId:pass.nodeId,label:pass.label??'',shader:pass.shader,target:pass.target,
   textures:(pass.textures??[]).map(t=>({binding:t.binding,resourceId:t.resourceId})),samplers:(pass.samplers??[]).map(s=>({binding:s.binding,resourceId:s.resourceId})),
   bindings:bindings.map(({group,slot,name})=>({group,slot,name})),uniformBinding:pass.uniformBinding??null,sharedBinding:pass.sharedBinding??null,uniforms});
 }
 const needed=new Set(passes.flatMap(p=>[p.target,...p.textures.map(t=>t.resourceId),...p.samplers.map(s=>s.resourceId)]));
 const resources=[];
 for(const r of selected.resources){
  if(!needed.has(r.id))continue;
  if(r.kind==='sampler'){
   if(r.filter!=='linear'||r.addressMode!=='clamp-to-edge')fail(`Sampler ${r.id} (${r.filter}, ${r.addressMode}) is outside the profile`);
   resources.push({id:r.id,kind:'sampler',filter:r.filter,addressMode:r.addressMode});continue;
  }
  if(r.kind!=='target')fail(`Resource ${r.id} is a "${r.kind}"; the profile holds render targets, baked stills and samplers (feedback rings and buffers are refused)`);
  const more=Object.keys(r).filter(k=>!['kind','id','size','format','label'].includes(k));
  if(more.length)fail(`Target ${r.id} uses ${more.join(', ')}, which the profile does not allocate`);
  if(!['rgba16float','rgba8unorm'].includes(r.format))fail(`Target ${r.id} is ${r.format}; the profile renders rgba16float and rgba8unorm`);
  resources.push({id:r.id,kind:bakedTargets.has(r.id)?'asset':'target',size:r.size,format:r.format});
 }
 if(baseline.feedback?.length&&baseline.feedback.some(f=>JSON.stringify(f).includes(output.resourceId)))fail('The output depends on a feedback loop; feedback is outside the profile');
 const liveDrives=drives.filter(d=>live.has(d.pass)&&passes.some(p=>p.id===d.pass));
 const pkg={schemaVersion:2,profile:PROFILE,abi:PACKAGE_ABI,name:plugin.name,kind:plugin.kind,
  output:output.resourceId,size:output.size,frame:{fps:projectFps(settings),randomSeed:settings.randomSeed??0,resolution:[settings.outputResolution.width,settings.outputResolution.height]},
  vertex:VERTEX,resources,passes,
  assets:assets.map(({id,file,size,format,source,node})=>({id,file,size,format,encoding:'deflate',source,node})),
  controls:controls.map(({node,type,channel,caption,min,max,default:d})=>({node,type,channel,name:caption,min,max,default:d})),
  parameters:parameters.map(({node,parameter,source,program})=>({node,parameter,source,program})),
  drives:liveDrives};
 return {package:pkg,assets,report,document,settings,registry,baseline,controls,plugin};
}

/** One Loom render of the baseline plan with the real stills, read back per baked target. Needs Dawn. */
export async function bakeAssets(scene,{mediaRoot}){
 const {createVgpuBackend}=await import('../../src/runtime/backend/vgpu/vgpu-backend.ts');
 const {nodeGpuHost}=await import('../../src/runtime/backend/vgpu/node-gpu-host.ts');
 const backend=createVgpuBackend({host:nodeGpuHost()}),errors=[];
 backend.onDiagnostic(d=>{if(d.severity==='error')errors.push(d);});
 const blobs=[];
 try{
  await backend.initialize({});
  for(const r of scene.baseline.resources){
   if(r.kind!=='externalTexture')continue;
   const asset=scene.assets.find(a=>r.sourceId===`media:${a.nodeId}`);
   // A still outside this plugin's graph still has to hold something; it is never read back.
   let bytes=new Uint8Array(r.size[0]*r.size[1]*4);
   if(asset){
    const png=decodePng(await readFile(resolve(mediaRoot,asset.source)));
    if(png.width!==r.size[0]||png.height!==r.size[1])fail(`"${asset.node}" is set to ${r.size[0]}×${r.size[1]} but ${asset.source} is ${png.width}×${png.height}; the profile packages stills at their own size`);
    bytes=png.rgba;
   }
   backend.registerMediaSource(r.sourceId,{currentFrame:()=>({frameId:1,bytes})});
  }
  const compiled=await backend.compile(scene.baseline);
  const frame={timeSeconds:0,deltaSeconds:1/scene.package.frame.fps,frameIndex:0,mode:'fixed-step',randomSeed:scene.package.frame.randomSeed};
  backend.render(compiled,{frame,pointer:{x:0,y:0,buttons:0},resolution:scene.package.frame.resolution});
  for(const asset of scene.assets){
   const image=await backend.readOutput(asset.id);
   const texel={rgba16float:8,rgba8unorm:4}[image.format];
   if(image.format!==asset.format||image.width!==asset.size[0]||image.height!==asset.size[1]||!texel)fail(`Baked still ${asset.id} read back as ${image.width}×${image.height} ${image.format}`);
   const raw=new Uint8Array(image.width*image.height*texel);
   for(let y=0;y<image.height;y++)raw.set(image.bytes.subarray(y*image.rowStride,y*image.rowStride+image.width*texel),y*image.width*texel);
   blobs.push({...asset,raw,packed:deflateRawSync(raw,{level:6}),sha256:createHash('sha256').update(raw).digest('hex')});
  }
  if(errors.length)fail(`Loom reported errors while baking stills: ${JSON.stringify(errors)}`);
 }finally{backend.dispose();}
 return blobs;
}

/** Writes `<out>/package.json`, `<out>/assets/*` and `<out>/report.json`. */
export async function writeScene(scene,blobs,out){
 await rm(resolve(out,'assets'),{recursive:true,force:true});await mkdir(resolve(out,'assets'),{recursive:true});
 const pkg={...scene.package,assets:scene.package.assets.map(a=>{const b=blobs.find(x=>x.id===a.id);return {...a,byteLength:b.raw.length,sha256:b.sha256};})};
 for(const b of blobs)await writeFile(resolve(out,b.file),b.packed);
 await writeFile(resolve(out,'package.json'),JSON.stringify(pkg,null,1)+'\n');
 await writeFile(resolve(out,'report.json'),JSON.stringify(scene.report,null,1)+'\n');
 return pkg;
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const [project,interfaceFile,pluginName,out,mediaRoot]=process.argv.slice(2);
 if(!out)fail('Usage: scene.mjs project.loom.json interface.json "Plugin Name" output-directory [media-root]');
 const scene=compileScene(await readFile(project,'utf8'),JSON.parse(await readFile(interfaceFile,'utf8')),pluginName);
 const blobs=await bakeAssets(scene,{mediaRoot:mediaRoot??resolve(project,'../../../public')});
 const pkg=await writeScene(scene,blobs,resolve(out));
 console.log(`Exported "${pkg.name}": ${pkg.passes.length} passes, ${pkg.assets.length} baked stills (${(blobs.reduce((n,b)=>n+b.packed.length,0)/1048576).toFixed(1)} MiB packed, ${(blobs.reduce((n,b)=>n+b.raw.length,0)/1048576).toFixed(1)} MiB on the GPU), ${pkg.controls.length} controls, ${pkg.drives.length} driven uniforms`);
 for(const d of scene.report.dropped)console.log(`  dropped ${d.node} (${d.type}): ${d.why}`);
 for(const w of scene.report.warnings)console.log(`  warning: ${w}`);
 if(scene.report.unusedControls.length)console.log(`  controls this plugin's picture never reads: ${scene.report.unusedControls.join(', ')}`);
}
