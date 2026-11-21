/** A small saved scene that uses the whole `loom-native-2` profile and needs no client media:
 *  a PNG still, Custom WGSL driven by a slider and a toggle, the frame clock, Blur at its own
 *  resolution, Add, Null, plus the authoring-only nodes the export drops. */
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {buildProjectFile} from '../../src/domain/project/project-file.ts';
import {encodePng} from '../../src/runtime/export/png.ts';
import {document} from '../../src/examples/documents/builders.ts';
import {SHARED_UNIFORMS_WGSL} from '../../src/runtime/backend/shared-uniforms.ts';
import {allNodeDefinitions} from '../../src/nodes/definitions/index.ts';

const expression=(source,held)=>({mode:'expression',bindings:{expression:{kind:'expression',source},static:{kind:'static',value:held}}});
const GRADE=`${SHARED_UNIFORMS_WGSL}
struct Params {
  gain: f32, // @default 1  Level.
  lift: f32, // @default 0  Added light.
  tint: vec2f, // @default 1, 0.5
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let c = textureSampleLevel(inputTexture, inputSampler, fract(uv + vec2f(frameU.time * 0.25, 0.0)), 0.0);
  let sweep = 0.5 + 0.5 * sin(6.2831853 * (uv.y + frameU.absTime));
  return vec4f(c.rgb * params.gain * vec3f(params.tint, sweep) + params.lift, 1.0);
}
`;
export const FIXTURE_SIZE=[96,64];
/** The still: a hard-edged colour card, so a wrong row order, channel order or decode shows. */
export function fixtureStill(){
 const [w,h]=[48,32],rgba=new Uint8Array(w*h*4);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const i=(y*w+x)*4,cell=(x>>3)+(y>>3)*6;
  rgba[i]=(cell*37+x*3)&255;rgba[i+1]=(cell*91+y*5)&255;rgba[i+2]=x<w/2?230:40;rgba[i+3]=255;
 }
 return {width:w,height:h,rgba,png:encodePng({width:w,height:h,data:rgba}).bytes};
}
export function sceneFixture(){
 const versions=new Map(allNodeDefinitions.map(d=>[d.type,d.version]));
 const node=(id,type,label,parameters={},extra={})=>({id,type,label,parameters,definitionVersion:versions.get(type),position:{x:0,y:0},...extra});
 const nodes=[
  node('s_gain','slider','slider_gain',{caption:'Gain',channel:'gain',min:0,max:2,step:0,defaultValue:1.25,value:0.3}),
  node('s_lift','slider','slider_lift',{caption:'Lift',channel:'lift',min:0,max:0.5,step:0,defaultValue:0.0625,value:0.4}),
  node('t_kill','toggle','toggle_kill',{caption:'Kill',channel:'kill',defaultOn:false,on:true}),
  node('s_spare','slider','slider_spare',{caption:'Spare',channel:'spare',min:0,max:1,step:0,defaultValue:0.5,value:0.5}),
  node('card','movieFileIn','movie_card',{file:'fixture/card.png',imageFit:'stretch'},{resolution:{mode:'fixed',width:48,height:32}}),
  node('grade','customWgsl','wgsl_grade',{source:GRADE,gain:expression("op('slider_gain').chan.gain * (1 - op('toggle_kill').chan.kill)",1),lift:expression("op('slider_lift').chan.lift / 2 + 0.03125",0),tint:[1,0.5]},{resolution:{mode:'fixed',width:FIXTURE_SIZE[0],height:FIXTURE_SIZE[1]}}),
  node('soft','blur','blur_soft',{size:6},{resolution:{mode:'fixed',width:48,height:32}}),
  node('mix','add','add_mix',{opacity:1}),
  node('final','null','null_final'),
  node('send','syphonOut','syphonout_send',{enabled:true,name:'Fixture'}),
 ];
 const wire=(from,to,port)=>({id:`e-${from}-${to}-${port}`,source:{nodeId:from,portId:'out'},target:{nodeId:to,portId:port}});
 const edges=[wire('card','grade','input'),wire('grade','soft','input'),wire('grade','mix','in1'),wire('soft','mix','in2'),wire('mix','final','in'),wire('final','send','input')];
 const graph={revision:0,nodes:Object.fromEntries(nodes.map(n=>[n.id,n])),edges:Object.fromEntries(edges.map(e=>[e.id,e])),groups:{}};
 const settings={limits:{maxBufferBytes:268435456,maxDispatch:65535,maxResolution:4096,memoryBudgetBytes:2147483648},outputResolution:{width:FIXTURE_SIZE[0],height:FIXTURE_SIZE[1]},previewFps:30,previewLongEdge:192,randomSeed:5,workingFormat:'rgba16float'};
 const text=buildProjectFile({document:document('ffgl-scene-fixture','FFGL scene fixture',settings,graph),now:()=>'2026-11-21T00:00:00.000Z'}).text;
 const contract={schemaVersion:2,plugins:[{name:'Scene Fixture',kind:'source',output:{nodeId:'final',portId:'out'}}]};
 return {text,contract,plugin:'Scene Fixture'};
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const out=resolve(process.argv[2]??'.cache/ffgl-native-scene-fixture');
 await mkdir(resolve(out,'media/fixture'),{recursive:true});
 const f=sceneFixture();
 await writeFile(resolve(out,'fixture.loom.json'),f.text);await writeFile(resolve(out,'interface.json'),JSON.stringify(f.contract,null,2)+'\n');
 await writeFile(resolve(out,'media/fixture/card.png'),fixtureStill().png);
 console.log(`Saved the scene fixture, its interface and its still to ${out} (media root: ${resolve(out,'media')})`);
}
