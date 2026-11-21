import test from 'node:test';
import assert from 'node:assert/strict';
import {projectFixture} from './project-fixture.mjs';
import {compileProject} from './project.mjs';
import {packUniforms} from './export.mjs';
const f=await projectFixture();
test('saved production-node project exports explicit input/output and mapped controls without rewriting source',()=>{
 const before=f.text;const x=compileProject(f.text,f.contract);
 assert.equal(x.compiled.passes.length,6);assert.equal(x.package.profile,'loom-native-static-1');
 assert.deepEqual(x.package.controls.map(c=>c.name),['Rotation','Fold angle']);
 assert.ok(Math.abs(x.package.controls[0].default-.75)<1e-12);
 assert.equal(x.package.controls[0].scale,240*Math.PI/180);
 assert.equal(x.package.controls[1].offset,-60*Math.PI/180);
 assert.equal(f.text,before);
 assert.equal(x.package.passes.find(p=>p.nodeId===f.ids.$crop).packedUniforms.size,16);
});
test('flat vec4 ABI aligns at 16 bytes',()=>{
 const p=packUniforms('struct P {a:f32,b:vec4f,c:f32}; var<uniform> p:P;',{a:1,b:[2,3,4,5],c:6});
 assert.deepEqual(p.fields.map(f=>f.offset),[0,4,8]);assert.equal(p.size,48);
});
test('rejects unknown endpoints and unsupported control targets/ranges',()=>{
 assert.throws(()=>compileProject(f.text,{...f.contract,output:{nodeId:'missing',portId:'out'}}),/existing out ports/);
 assert.throws(()=>compileProject(f.text,{...f.contract,controls:[{...f.contract.controls[0],parameter:'s'}]}),/Unsupported control/);
 assert.throws(()=>compileProject(f.text,{...f.contract,controls:[{...f.contract.controls[0],max:1000}]}),/exceeds node range/);
 assert.throws(()=>compileProject(f.text,{...f.contract,controls:[f.contract.controls[0],f.contract.controls[0]]}),/unique/);
});
test('rejects dynamic parameters, unsupported nodes, format and resize semantics explicitly',()=>{
 const changed=(edit)=>{const d=JSON.parse(f.text);edit(d);return JSON.stringify(d);};
 assert.throws(()=>compileProject(changed(d=>{d.graph.nodes[f.ids.$rotate].parameters.r={mode:'expression',bindings:{expression:{kind:'expression',source:'absTime.seconds'}}};}),f.contract),/Dynamic parameter|unknown features/);
 assert.throws(()=>compileProject(changed(d=>{d.graph.nodes[f.ids.$rotate].parameters.aspectcorrect=true;}),f.contract),/aspect correction/);
 assert.throws(()=>compileProject(changed(d=>{d.settings.workingFormat='rgba16float';}),f.contract),/rgba8unorm/);
 assert.throws(()=>compileProject(changed(d=>{d.graph.nodes[f.ids.$crop].resolution={mode:'scale',factor:.5};}),f.contract),/resolution override/);
 assert.throws(()=>compileProject(changed(d=>{d.graph.nodes[f.ids.$crop].type='noise';}),f.contract),/Unsupported node|unknown features/);
});

test('rejects contract fields it cannot execute',()=>{
 assert.throws(()=>compileProject(f.text,{...f.contract,time:{}}),/Unsupported contract fields: time/);
 assert.throws(()=>compileProject(f.text,{...f.contract,controls:[{...f.contract.controls[0],expression:'time'}]}),/Unsupported control fields/);
 assert.throws(()=>compileProject(f.text,f.contract,{width:32}),/Dimensions/);
});
