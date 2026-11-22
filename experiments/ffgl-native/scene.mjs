/** Scene export, profile `loom-native-2`: a saved Loom scene to a package the native Dawn engine runs.
 *  The project loader and the compiler stay authoritative. This file only selects, checks and packs
 *  what they produce, and refuses by name whatever the profile does not cover. See README.md. */
import {URL} from 'node:url';
import console from 'node:console';
import process from 'node:process';
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
export const PACKAGE_ABI=5;
/** Nodes the engine executes. */
export const RENDER_NODES=new Set(['customWgsl','customWgslMulti','blur','add','null','output','movieFileIn']);
/** Nodes an Effect's interface may name as its input: the host's texture stands where their picture was. */
export const INPUT_NODES=new Set(['movieFileIn','syphonIn']);
/** Nodes that become plugin parameters. */
export const CONTROL_NODES=new Set(['slider','toggle']);
/** Authoring-only nodes, dropped at export by rule (SPEC-VN decision 3). */
export const DROPPED_NODES=new Set(['panel','syphonOut','presets']);
const SHARED_FRAME=[['time',0],['deltaTime',4],['frameIndex',8],['randomSeed',12],['wallTime',16],['wallDelta',20],['absTime',24],['absFrame',28],['resolution',32],['pointer',48]];
const PASS_FIELDS=new Set(['kind','id','nodeId','label','shader','target','textures','samplers','uniformBinding','uniforms','sharedBinding','sourceMap']);
/** Names the preset block and the plugin's own parameters take; a control may not use them (drmbt-custom-fx docs/KNOWLEDGE.md). */
export const RESERVED_NAMES=['Preset','Morph','Recall','Rescan','Snap','Curve','Next','Prev','Random','Host BPM','Fit'];
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
   controls.push({node:node.label??node.id,nodeId:node.id,type:'toggle',valueKey:'on',channel,caption,min:0,max:1,step:1,default:p.defaultOn===true?1:0});
   continue;
  }
  const min=numberOr(p.min,0),max=numberOr(p.max,1);
  if(!(min<max))fail(`Control ${where(node)} has an empty range ${min}..${max}`);
  const stored=numberOr(p.defaultValue,numberOr(p.value,min)),step=Math.max(0,numberOr(p.step,0));
  // Loom's slider snaps a drag to multiples of Step, so a stepped control only ever holds those.
  const snap=(v)=>Math.min(max,Math.max(min,step>0?Math.round(v/step)*step:v));
  const whole=step===1&&Number.isInteger(min)&&Number.isInteger(max);
  const hue=min===0&&max===1&&/hue/i.test(`${caption} ${channel}`);
  controls.push({node:node.label??node.id,nodeId:node.id,type:whole?'integer':hue?'hue':'slider',valueKey:'value',channel,caption,min,max,step,default:snap(stored)});
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

/** Bank prefixes for the one alphabetical Preset menu: each bank sorts together. */
const BANK_NAMES=[[/look/i,'Look'],[/palette/i,'Palette'],[/pill/i,'Pill']];
/**
 * Loom's preset banks as FFGL parameter values. A bank is a partial snapshot: only what it targets
 * is written. A picker is written whole (Arena stores one colour), so a preset that sets a hue but
 * not its saturation takes the missing channel from the control's default, and says so.
 */
function presetsOf(graph,controls,params,report){
 const out=[],index=new Map(controls.map((c,i)=>[c.node,i]));
 for(const node of Object.values(graph.nodes)){
  if(node.type!=='presets'||typeof node.parameters.presets!=='string')continue;
  let bank;try{bank=JSON.parse(node.parameters.presets);}catch{fail(`Presets ${where(node)} holds text that is not JSON`);}
  const label=node.label??node.id,prefix=BANK_NAMES.find(([pattern])=>pattern.test(label))?.[1]??label.replace(/^presets_/,'');
  for(const preset of bank.presets??[]){
   const held=new Map(),skipped=[];
   for(const [target,fields] of Object.entries(preset.values??{})){
    const at=index.get(target),control=controls[at];
    if(at===undefined){skipped.push(target);continue;}
    const raw=fields[control.valueKey];
    if(typeof raw==='number'&&Number.isFinite(raw))held.set(at,Math.min(control.max,Math.max(control.min,raw)));
    else if(typeof raw==='boolean')held.set(at,raw?1:0);
   }
   const values=[],filled=[];
   params.forEach((p,i)=>{
    if(p.quad){
     const quad=params.filter(q=>q.quad===p.quad);
     if(!quad.some(q=>q.control!==null&&held.has(q.control)))return;
     if(p.control!==null&&!held.has(p.control))filled.push(p.name);
     values.push([i,p.control!==null&&held.has(p.control)?held.get(p.control):p.default]);
    }else if(held.has(p.control))values.push([i,held.get(p.control)]);
   });
   const name=`${prefix} ${preset.name}`;
   if(!/^[A-Za-z0-9][ -~]*$/.test(name)||/[/\\:`]/.test(name))fail(`Preset "${name}" cannot be a file name`);
   if(skipped.length)report.warnings.push(`Preset "${name}" targets ${skipped.join(', ')}, which this plugin does not list; those values are left out`);
   if(filled.length)report.warnings.push(`Preset "${name}" sets part of a colour; ${filled.join(', ')} take their defaults`);
   if(values.length)out.push({name,bank:label,morphSeconds:numberOr(node.parameters.morph,0),values});
  }
 }
 const names=new Set();
 for(const p of out){if(names.has(p.name))fail(`Two presets are named "${p.name}"`);names.add(p.name);}
 return out.sort((a,b)=>a.name<b.name?-1:1);
}

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
 // A saved project may carry a component LIBRARY nothing uses (the desktop app embeds the
 // starter set). Only an instance in the graph is outside the profile.
 const builtIn=new Set(allNodeDefinitions.map(definition=>definition.type));
 const instances=Object.values(loaded.document.graph.nodes).filter(node=>!builtIn.has(node.type));
 if(instances.length)fail(`Components are outside the export profile: ${JSON.stringify(instances.map(node=>node.label??node.id))}`);
 const loadErrors=loaded.diagnostics.filter(d=>d.severity==='error');
 if(loadErrors.length)fail(`The project loads with errors: ${JSON.stringify(loadErrors)}`);
 keys(contract,['schemaVersion','plugins','controls'],'interface');
 if(contract.schemaVersion!==2)fail('Unsupported interface version (this exporter reads schemaVersion 2)');
 if(!Array.isArray(contract.plugins)||!contract.plugins.length)fail('interface.plugins must list at least one plugin');
 const plugin=contract.plugins.find(p=>p?.name===pluginName);
 if(!plugin)fail(`interface.plugins has no plugin named "${pluginName}"`);
 keys(plugin,['name','kind','code','output','present','controls','hostBpm','syphon','input','checks'],'plugin');
 if(plugin.syphon!==undefined){
  // A name publishes this plugin's own picture; {name, plugin} publishes another plugin's picture from inside this one.
  const feed=typeof plugin.syphon==='object';
  if(feed)keys(plugin.syphon,['name','plugin'],'plugin.syphon');
  const name=feed?plugin.syphon.name:plugin.syphon;
  if(typeof name!=='string'||!/^[ -~]{1,32}$/.test(name))fail(`Plugin "${plugin.name}": the syphon name must be 1 to 32 plain ASCII characters`);
  if(feed&&(plugin.syphon.plugin===plugin.name||!contract.plugins.some(p=>p?.name===plugin.syphon.plugin)))fail(`Plugin "${plugin.name}": syphon.plugin must name another plugin of this interface`);
 }
 if(plugin.present!==undefined&&!['none','srgb'].includes(plugin.present))fail(`Plugin "${plugin.name}": present "${plugin.present}" must be "none" or "srgb"`);
 keys(plugin.output,['nodeId','portId'],'plugin.output');
 if(plugin.kind!=='source'&&plugin.kind!=='effect')fail(`Plugin "${plugin.name}": kind "${plugin.kind}" must be "source" or "effect"`);
 // An Effect names the node whose picture the host's input texture replaces. A Source has no input.
 if((plugin.kind==='effect')!==(plugin.input!==undefined))fail(`Plugin "${plugin.name}": ${plugin.kind==='effect'?'an effect needs "input": {"nodeId": …}, the node the layer\'s video replaces':'a source takes no "input"'}`);
 if(plugin.input!==undefined)keys(plugin.input,['nodeId'],'plugin.input');
 const inputId=plugin.input?.nodeId??null;
 if(plugin.code!==undefined&&(typeof plugin.code!=='string'||!/^[A-Za-z0-9]{4}$/.test(plugin.code)))fail(`Plugin "${plugin.name}": code "${plugin.code}" must be four letters or digits (the FFGL plugin id)`);
 if(typeof plugin.name!=='string'||!/^[ -~]{1,16}$/.test(plugin.name))fail(`Plugin name "${plugin.name}" must be 1..16 printable ASCII characters (FFGL's limit)`);

 const document=loaded.document,graph=document.graph,settings=document.settings;
 const report={dropped:[],warnings:loaded.diagnostics.filter(d=>d.severity==='warning').map(d=>d.message),unusedControls:[]};
 const refused=[];
 for(const node of Object.values(graph.nodes)){
  if(DROPPED_NODES.has(node.type))report.dropped.push({node:node.label??node.id,type:node.type,why:'authoring-only node'});
  else if(node.id===inputId&&INPUT_NODES.has(node.type))continue;
  else if(!RENDER_NODES.has(node.type)&&!CONTROL_NODES.has(node.type))refused.push(where(node));
  if(RENDER_NODES.has(node.type)&&node.state&&Object.keys(node.state).length)refused.push(`${where(node)}: node state`);
 }
 if(refused.length)fail(`Nodes outside the ${PROFILE} profile:\n  ${refused.join('\n  ')}`);
 if(!graph.nodes[plugin.output.nodeId])fail(`Plugin "${plugin.name}": output node "${plugin.output.nodeId}" does not exist`);
 if(inputId!==null&&!INPUT_NODES.has(graph.nodes[inputId]?.type))fail(`Plugin "${plugin.name}": input node "${inputId}" must be a Movie File In or a Syphon In in the scene`);

 // `controls` is what the engine evaluates (one per Slider or Toggle); `params` is the FFGL
 // parameter list in index order. A plain entry is one parameter. A colour entry is Resolume's
 // native picker: four parameters (hue, saturation, brightness, alpha) that Arena shows as one.
 const every=controlsOf(graph),byNode=new Map(every.map(c=>[c.node,c]));
 const listed=plugin.controls??contract.controls??every.map(c=>({node:c.node}));
 if(!Array.isArray(listed))fail('interface.controls must be an array');
 const controls=[],params=[],place=new Map();
 const use=(node,what)=>{
  const control=byNode.get(node);
  if(!control)fail(`${what} names "${node}", which is not a slider or toggle in the scene`);
  if(place.has(node))fail(`Control "${node}" is listed twice`);
  place.set(node,controls.length);controls.push(control);
  return control;
 };
 const group=(entry)=>{
  if(entry.group===undefined)return null;
  if(typeof entry.group!=='string'||!/^[ -~]{1,32}$/.test(entry.group))fail(`Group "${entry.group}" must be 1..32 printable ASCII characters`);
  return entry.group;
 };
 const pending=[];
 for(const entry of listed){
  if(entry&&entry.color!==undefined){
   keys(entry,['color','hue','saturation','dims','group'],'colour control');
   if(typeof entry.color!=='string'||!/^[ -~]{1,16}$/.test(entry.color))fail(`Colour "${entry.color}" must be named in 1..16 printable ASCII characters`);
   const hue=use(entry.hue,`Colour "${entry.color}".hue`),saturation=use(entry.saturation,`Colour "${entry.color}".saturation`);
   for(const [channel,c] of [['hue',hue],['saturation',saturation]])if(c.type==='toggle'||c.min!==0||c.max!==1)fail(`Colour "${entry.color}": its ${channel} control "${c.node}" must be a slider running 0..1 (it runs ${c.min}..${c.max})`);
   const base={group:group(entry),quad:entry.color,min:0,max:1,step:0,scales:null};
   params.push({...base,name:entry.color,ffgl:'hue',control:place.get(hue.node),default:hue.default});
   params.push({...base,name:`${entry.color}_saturation`,ffgl:'saturation',control:place.get(saturation.node),default:saturation.default});
   params.push({...base,name:`${entry.color}_brightness`,ffgl:'brightness',control:null,default:1});
   params.push({...base,name:`${entry.color}_alpha`,ffgl:'alpha',control:null,default:1});
   if(entry.dims!==undefined)pending.push([params.length-2,entry.dims,entry.color]);
   continue;
  }
  keys(entry,['node','name','type','group'],'control');
  const control=use(entry.node,'interface.controls');
  if(entry.type!==undefined&&(control.type==='toggle'||!['slider','hue','integer'].includes(entry.type)))fail(`Control "${entry.node}": type "${entry.type}" is not one of slider, hue, integer (a toggle takes none)`);
  if(entry.type==='hue'&&(control.max-control.min!==1))fail(`Control "${entry.node}": a hue control must span exactly one turn (it spans ${control.min}..${control.max})`);
  const type=entry.type??control.type;
  controls[controls.length-1]={...control,caption:entry.name??control.caption,type};
  params.push({name:entry.name??control.caption,ffgl:{slider:'standard',hue:'hue',integer:'integer',toggle:'boolean'}[type],group:group(entry),quad:null,
   min:control.min,max:control.max,step:control.step,control:place.get(control.node),scales:null,default:control.default});
 }
 // A picker's brightness has no control of its own in the scene: it can dim the group's level control.
 for(const [index,node,colour] of pending){
  const at=place.get(node);
  if(at===undefined||controls[at].type==='toggle')fail(`Colour "${colour}".dims names "${node}", which must be a slider in this plugin's list`);
  if(params.some(p=>p.scales===at))fail(`Two colours dim "${node}"`);
  params[index].scales=at;
 }
 const seenNames=new Map();
 for(const p of params){
  if(p.quad&&p.ffgl!=='hue')continue; // Arena shows and stores the picker under its head name
  if(!/^[ -~]{1,16}$/.test(p.name))fail(`Control "${controls[p.control].node}": the name "${p.name}" must be 1..16 printable ASCII characters (FFGL cuts the rest off); name it in interface.controls`);
  if(RESERVED_NAMES.includes(p.name))fail(`Control "${controls[p.control].node}": the name "${p.name}" is taken by the plugin's own parameters`);
  if(seenNames.has(p.name))fail(`Controls "${seenNames.get(p.name)}" and "${controls[p.control].node}" would both be named "${p.name}"`);
  seenNames.set(p.name,controls[p.control].node);
 }
 // Arena draws a group as one collapsible region only while its parameters are neighbours.
 const closed=new Set();
 params.forEach((p,i)=>{if(i&&params[i-1].group!==p.group&&params[i-1].group!==null)closed.add(params[i-1].group);if(p.group!==null&&closed.has(p.group))fail(`Group "${p.group}" is split: its controls must be listed together`);});
 const indexOf=new Map(controls.map((c,i)=>[`${c.node}\n${c.channel}`,i]));
 const controlIndex=(name,channel)=>indexOf.get(`${name}\n${channel}`)??(controls.some(c=>c.node===name)?`"${name}" publishes no channel "${channel}"`:`"${name}" is not an exported control`);

 // The nodes this plugin's picture is made of: everything upstream of its output. A driven parameter
 // on any other node (another output's chain) is not this plugin's business and is left as saved.
 const upstream=new Set([plugin.output.nodeId]);
 for(let grew=true;grew;){grew=false;for(const edge of Object.values(graph.edges))if(upstream.has(edge.target.nodeId)&&!upstream.has(edge.source.nodeId)){upstream.add(edge.source.nodeId);grew=true;}}
 // Every driven parameter, lowered. The expression is kept; nothing is frozen.
 const parameters=[];
 for(const node of Object.values(graph.nodes)){
  if(!RENDER_NODES.has(node.type)||!upstream.has(node.id)||node.id===inputId)continue;
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
  // Two ends give the line; the points between are where a clamp, a cap or a table would show.
  const ua=probe(a),ub=probe(b),between=[0.0625,0.19,0.375,0.5,0.71,0.875,0.97].map(t=>{const at=a+(b-a)*t;return [at,probe(at)];});
  for(const pass of selected.passes){
   for(const field of Object.keys(pass.uniforms??{})){
    const va=[ua.get(pass.id)[field]].flat(),vb=[ub.get(pass.id)[field]].flat();
    va.forEach((x,component)=>{
     if(x===vb[component]&&between.every(([,u])=>[u.get(pass.id)[field]].flat()[component]===x))return;
     const scale=(vb[component]-x)/(b-a),offset=x-scale*a;
     for(const [at,u] of between){
      const got=[u.get(pass.id)[field]].flat()[component],expected=scale*at+offset;
      if(Math.abs(expected-got)>1e-9*Math.max(1,Math.abs(expected)))fail(`Parameter "${p.parameter}" of "${p.node}" reaches uniform ${pass.id}.${field} through a curve (${got} at ${at}, a straight line gives ${expected}); the profile carries straight-line mappings only`);
     }
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
 // The input node's own pass copies its media into a target. The engine fills that target from the
 // host's texture instead, at the host texture's size, so the pass and its media are left out.
 let input=null;
 for(const pass of selected.passes){
  const node=nodeOf(pass);
  if(node?.id!==inputId)continue;
  const media=baseline.resources.find(r=>r.kind==='externalTexture'&&(pass.textures??[]).some(t=>t.resourceId===r.id));
  const target=baseline.resources.find(r=>r.id===pass.target);
  if(input||!media||!target||(pass.textures??[]).length!==1)fail(`${where(node)}: the input node's media pass has an unexpected shape`);
  // The engine hands the scene the host's picture as it is. A Movie File In that fits or crops its image would not.
  if(node.type==='movieFileIn'&&node.parameters.imageFit!=='stretch')fail(`${where(node)}: as an effect's input its Image fit must be Stretch (the layer's video is taken whole)`);
  if(media.format!=='rgba8unorm-srgb')fail(`${where(node)}: its media is ${media.format}; the host's texture is read as 8-bit sRGB`);
  if(target.format!=='rgba16float')fail(`${where(node)} holds its picture as ${target.format}; as an effect's input it must be rgba16float (leave its format at the working format)`);
  input={resource:target.id,node:node.label??node.id,nodeId:node.id,size:target.size};
 }
 if(inputId!==null&&!input)fail(`Plugin "${plugin.name}": input node "${inputId}" does not reach the output, so the layer's video would show nowhere`);
 for(const pass of selected.passes){
  const node=nodeOf(pass);
  if(node?.type!=='movieFileIn'||node.id===inputId)continue;
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
  if(bakedTargets.has(pass.target)||pass.target===input?.resource)continue;
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
  resources.push({id:r.id,kind:r.id===input?.resource?'host':bakedTargets.has(r.id)?'asset':'target',size:r.size,format:r.format});
 }
 if(baseline.feedback?.length&&baseline.feedback.some(f=>JSON.stringify(f).includes(output.resourceId)))fail('The output depends on a feedback loop; feedback is outside the profile');
 const liveDrives=drives.filter(d=>live.has(d.pass)&&passes.some(p=>p.id===d.pass));
 let hostBpm=null;
 if(plugin.hostBpm!==undefined){
  keys(plugin.hostBpm,['node','default'],'plugin.hostBpm');
  const index=controls.findIndex(c=>c.node===plugin.hostBpm.node);
  if(index<0||controls[index].type==='toggle')fail(`plugin.hostBpm names "${plugin.hostBpm.node}", which is not an exported slider`);
  hostBpm={control:index,default:plugin.hostBpm.default===true};
 }
 // Extra captures the comparison takes: the defaults with the named parameters moved. Each must
 // match Loom and must not be the picture the defaults give, so a control that reaches nothing fails.
 const checks=(plugin.checks??[]).map(check=>{
  keys(check,['label','set'],'check');
  if(typeof check.label!=='string'||!/^[A-Za-z][A-Za-z0-9]{0,23}$/.test(check.label))fail(`A check's label must be letters and digits ("${check.label}")`);
  return {label:check.label,values:Object.entries(check.set??{}).map(([name,value])=>{
   const index=params.findIndex(p=>p.name===name);
   if(index<0||typeof value!=='number'||value<params[index].min||value>params[index].max)fail(`Check "${check.label}" sets "${name}" to ${value}: not a parameter of this plugin, or outside its range`);
   return [index,value];})};
 });
 const pkg={schemaVersion:2,profile:PROFILE,abi:PACKAGE_ABI,name:plugin.name,kind:plugin.kind,code:plugin.code??null,present:plugin.present??'none',
  output:output.resourceId,size:output.size,input:input&&{resource:input.resource,node:input.node,size:input.size},frame:{fps:projectFps(settings),randomSeed:settings.randomSeed??0,resolution:[settings.outputResolution.width,settings.outputResolution.height]},
  vertex:VERTEX,resources,passes,
  assets:assets.map(({id,file,size,format,source,node})=>({id,file,size,format,encoding:'deflate',source,node})),
  controls:controls.map(({node,type,channel,caption,min,max,step,default:d})=>({node,type,channel,name:caption,min,max,step,default:d})),
  params,hostBpm,checks,presets:presetsOf(graph,controls,params,report),
  parameters:parameters.map(({node,parameter,source,program})=>({node,parameter,source,program})),
  drives:liveDrives};
 if(input&&!passes.some(p=>p.textures.some(t=>t.resourceId===input.resource)))fail(`Plugin "${plugin.name}": no pass reads the input node's picture`);
 return {package:pkg,assets,report,document,settings,registry,baseline,controls,plugin,input};
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
if(process.argv[1]===new URL(import.meta.url).pathname&&process.argv[2]==='--controls'){
 // Prints the control list to paste into the interface: the controls this plugin's picture reads, in graph order.
 const [project,interfaceFile,pluginName]=process.argv.slice(3);
 if(!pluginName)fail('Usage: scene.mjs --controls project.loom.json interface.json "Plugin Name"');
 const scene=compileScene(await readFile(project,'utf8'),JSON.parse(await readFile(interfaceFile,'utf8')),pluginName);
 const unused=new Set(scene.report.unusedControls);
 console.log('[\n'+scene.controls.filter(c=>!unused.has(c.node)).map(c=>'  '+JSON.stringify({node:c.node,name:c.caption,...(c.type==='toggle'?{}:{type:c.type})})).join(',\n')+'\n]');
}else if(process.argv[1]===new URL(import.meta.url).pathname){
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
