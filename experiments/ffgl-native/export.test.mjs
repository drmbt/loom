import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, packagePlan, packUniforms } from './export.mjs';

test('uses compiler identities and retains real Transform and compute shaders', async () => {
  const { compiled } = await fixture();
  const pkg = packagePlan(compiled);
  assert.deepEqual(pkg.passes.map(p => p.kind), ['effect', 'dispatch', 'draw', 'effect']);
  assert.match(pkg.passes.at(-1).shader, /invTransform2/);
  assert.equal(pkg.passes.at(-1).uniforms.rot, Math.PI);
  assert.match(pkg.passes[1].id, /#/); // Compiler normalization must survive export.
  assert.equal(pkg.passes[1].packedUniforms.fields.find(f => f.name === 'gain').values[0], 1);
});

test('rejects unsupported temporal resources and pass families', async () => {
  const { compiled } = await fixture();
  assert.throws(() => packagePlan({ ...compiled, resources: [...compiled.resources, {kind:'ring',id:'history'}] }), /Unsupported resource history/);
  assert.throws(() => packagePlan({ ...compiled, passes: [...compiled.passes, {kind:'swap',id:'temporal'}] }), /Unsupported pass temporal/);
});

test('uniform ABI aligns vectors and refuses types or missing values it cannot encode', () => {
  const shader='struct Params {a:f32,b:vec2f,c:f32}; @group(0) @binding(0) var<uniform> params:Params;';
  const packed=packUniforms(shader,{a:1,b:[2,3],c:4});
  assert.deepEqual(packed.fields.map(f=>f.offset),[0,2,4]);
  assert.equal(packed.size,32);
  assert.throws(()=>packUniforms(shader,{a:1,b:[2,3]}),/Missing uniform value c/);
  assert.throws(()=>packUniforms(shader.replace('vec2f','mat4x4f'),{a:1,b:[2,3],c:4}),/Unsupported uniform member/);
  assert.throws(()=>packUniforms(shader,{a:NaN,b:[2,3],c:4}),/Invalid a/);
});
