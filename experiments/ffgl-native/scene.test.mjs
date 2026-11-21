import test from 'node:test';
import assert from 'node:assert/strict';
import {sceneFixture,fixtureStill,FIXTURE_SIZE} from './scene-fixture.mjs';
import {compileScene,PROFILE} from './scene.mjs';
import {uniformLayout,bindingsOf} from './wgsl-layout.mjs';
import {lowerExpression,runProgram} from './expr.mjs';
import {decodePng} from './png.mjs';

const f=sceneFixture();
const changed=(edit)=>{const d=JSON.parse(f.text);edit(d.graph.nodes,d);return JSON.stringify(d);};
const expression=(source)=>({mode:'expression',bindings:{expression:{kind:'expression',source},static:{kind:'static',value:0}}});

test('the fixture exports its render graph, its still as a baked asset, and its controls',()=>{
 const before=f.text,{package:p,report}=compileScene(f.text,f.contract,f.plugin);
 assert.equal(f.text,before);
 assert.equal(p.profile,PROFILE);assert.deepEqual(p.size,FIXTURE_SIZE);assert.equal(p.output,'target:mix:out'); // Null passes its input through: no pass, no target.
 // The media pass is gone: its target is the baked still.
 assert.deepEqual(p.passes.map(x=>x.nodeId),['grade','soft','soft','mix']);
 assert.deepEqual(p.assets.map(a=>[a.id,a.size,a.format,a.source]),[['target:card:out',[48,32],'rgba16float','fixture/card.png']]);
 assert.equal(p.resources.find(r=>r.id==='target:card:out').kind,'asset');
 assert.deepEqual(p.resources.find(r=>r.id==='target:soft:out').size,[48,32]);
 assert.ok(p.resources.every(r=>r.kind!=='externalTexture'));
 // Defaults are the controls' declared defaults, not the values the file happened to be saved with.
 assert.deepEqual(p.controls.map(c=>[c.node,c.type,c.min,c.max,c.default]),[['slider_gain','slider',0,2,1.25],['slider_lift','slider',0,0.5,0.0625],['slider_spare','slider',0,1,0.5],['toggle_kill','toggle',0,1,0]]);
 assert.deepEqual(p.parameters.map(x=>x.program),[['c0',1,'c3','-','*'],['c1',2,'/',0.03125,'+']]);
 assert.deepEqual(p.drives,[{parameter:0,pass:'grade#grade:custom',field:'gain',component:0,scale:1,offset:0},{parameter:1,pass:'grade#grade:custom',field:'lift',component:0,scale:1,offset:0}]);
 const block=p.passes[0].uniforms;
 assert.deepEqual(block.fields.map(x=>[x.name,x.offset,x.value]),[['gain',0,[1.25]],['lift',4,[0.0625]],['tint',8,[1,0.5]]]);
 assert.equal(p.passes[0].sharedBinding,'frameU');
 assert.deepEqual(report.dropped.map(d=>d.node),['syphonout_send']);
 assert.deepEqual(report.unusedControls,['slider_spare']);
});
test('a node outside the profile fails the export by name, wherever it sits in the graph',()=>{
 const text=changed((nodes)=>{nodes.stray={...nodes.final,id:'stray',type:'flip',label:'flip_stray',parameters:{}};});
 assert.throws(()=>compileScene(text,f.contract,f.plugin),/outside the loom-native-2 profile:\s+"flip_stray" \(flip, id stray/);
});
test('an expression that is not arithmetic over exported controls is refused, naming it',()=>{
 const refuse=(source,pattern)=>assert.throws(()=>compileScene(changed((nodes)=>{nodes.grade.parameters.gain=expression(source);}),f.contract,f.plugin),pattern);
 refuse('time * 2',/Parameter "gain" of "wgsl_grade".*`time \* 2` reads "time"/s);
 refuse("sin(op('slider_gain').chan.gain)",/calls sin\(\)/);
 refuse("op('slider_gain').chan.gain % 2",/operator "%"/);
 refuse("op('wgsl_grade').par.lift",/is not a channel read/);
 refuse("op('slider_gain').chan.nope",/publishes no channel "nope"/);
 refuse("op('blur_soft').chan.x",/is not an exported control/);
 assert.throws(()=>compileScene(changed((nodes)=>{nodes.grade.parameters.gain={mode:'bind',bindings:{bind:{kind:'bind',source:'lift'},static:{kind:'static',value:1}}};}),f.contract,f.plugin),/"bind" mode|Unknown parameters/);
});
test('a parameter that reshapes the plan or bends on the way to a uniform is refused, not frozen',()=>{
 const text=changed((nodes)=>{nodes.s_spare.parameters.max=40;nodes.soft.parameters.size=expression("op('slider_spare').chan.spare");});
 assert.throws(()=>compileScene(text,f.contract,f.plugin),/Parameter "size" of "blur_soft" (changes the render plan itself|reaches uniform .* through a curve)/);
});
test('stills are PNG only, and names must fit FFGL',()=>{
 assert.throws(()=>compileScene(changed((nodes)=>{nodes.card.parameters.file='fixture/card.mov';}),f.contract,f.plugin),/"movie_card".*PNG stills only/s);
 const long={...f.contract,plugins:[{...f.contract.plugins[0],name:'Seventeen letters'}]};
 assert.throws(()=>compileScene(f.text,long,'Seventeen letters'),/1\.\.16 printable ASCII/);
 assert.throws(()=>compileScene(f.text,{...f.contract,extra:1},f.plugin),/Unsupported interface fields: extra/);
 assert.throws(()=>compileScene(f.text,{...f.contract,plugins:[{...f.contract.plugins[0],kind:'effect'}]},f.plugin),/not built yet/);
});
test('interface.controls fixes the order and the names; an unknown control is refused',()=>{
 const contract={...f.contract,controls:[{node:'toggle_kill'},{node:'slider_gain',name:'Level'},{node:'slider_lift'}]};
 const p=compileScene(f.text,contract,f.plugin).package;
 assert.deepEqual(p.controls.map(c=>c.name),['Kill','Level','Lift']);
 assert.deepEqual(p.parameters[0].program,['c1',1,'c0','-','*']);
 assert.throws(()=>compileScene(f.text,{...f.contract,controls:[{node:'slider_none'}]},f.plugin),/"slider_none", which is not a slider or toggle/);
 // A control the picture reads but the interface leaves out cannot be evaluated.
 assert.throws(()=>compileScene(f.text,{...f.contract,controls:[{node:'slider_gain'}]},f.plugin),/is not an exported control/);
});
test('uniform layout follows WGSL alignment and refuses what it cannot place',()=>{
 const shader='struct P { a: f32, // one\n b: vec3f, c: u32, d: vec2f, e: vec4f, };\n@group(0) @binding(3) var<uniform> params: P;\n@group(0) @binding(0) var s: sampler;';
 const layout=uniformLayout(shader,'params');
 assert.deepEqual(layout.fields.map(x=>[x.name,x.offset,x.scalar,x.count]),[['a',0,'f32',1],['b',16,'f32',3],['c',28,'u32',1],['d',32,'f32',2],['e',48,'f32',4]]);
 assert.equal(layout.size,64);
 assert.deepEqual(bindingsOf(shader).map(b=>[b.slot,b.name,b.uniform]),[[3,'params',true],[0,'s',false]]);
 assert.equal(uniformLayout(shader,'other'),null);
 assert.throws(()=>uniformLayout(shader.replace('vec4f','mat4x4f'),'params'),/unsupported member "e: mat4x4f"/);
});
test('the lowered program computes what the expression says',()=>{
 const {program,reads}=lowerExpression("-(op('a').chan.x - 3) / 4 + op('b').chan.y * 2",(name)=>({a:0,b:2})[name]);
 assert.deepEqual(reads,[0,2]);
 assert.equal(runProgram(program,[7,99,0.25]),-(7-3)/4+0.25*2);
});
test('the PNG decoder returns the rows it was given',()=>{
 const still=fixtureStill(),decoded=decodePng(still.png);
 assert.deepEqual([decoded.width,decoded.height],[48,32]);
 assert.deepEqual(decoded.rgba,still.rgba);
 assert.throws(()=>decodePng(new Uint8Array(64)),/not a PNG/);
});
