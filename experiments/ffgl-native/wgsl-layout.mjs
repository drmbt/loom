/** WGSL uniform-struct layout for the types Loom's effect passes use. Anything else is refused by name:
 *  a guessed offset is a wrong picture, not an error. */
const TYPES={f32:[4,4,'f32',1],i32:[4,4,'i32',1],u32:[4,4,'u32',1],vec2f:[8,8,'f32',2],vec3f:[12,16,'f32',3],vec4f:[16,16,'f32',4],
 'vec2<f32>':[8,8,'f32',2],'vec3<f32>':[12,16,'f32',3],'vec4<f32>':[16,16,'f32',4]};
const strip=(code)=>code.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'');
/** Every `@group(g) @binding(b) var… name: Type` in the shader. */
export function bindingsOf(shader){
 return [...strip(shader).matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)\s*var(<[^>]+>)?\s+(\w+)\s*:\s*([\w<>]+)/g)]
  .map(m=>({group:Number(m[1]),slot:Number(m[2]),name:m[4],type:m[5],uniform:m[3]==='<uniform>'}));
}
/** Byte layout of the struct behind the uniform variable `name`, or null when the shader declares none. */
export function uniformLayout(shader,name){
 const code=strip(shader);
 const declared=bindingsOf(shader).find(b=>b.uniform&&b.name===name);
 if(!declared)return null;
 const body=new RegExp(`struct\\s+${declared.type}\\s*\\{([^}]*)\\}`).exec(code)?.[1];
 if(body===undefined)throw Error(`Uniform ${name}: struct ${declared.type} not found`);
 let offset=0,align=1;const fields=[];
 for(const member of body.split(',').map(x=>x.trim()).filter(Boolean)){
  const match=/^(\w+)\s*:\s*([\w<>]+)$/.exec(member);
  const type=match&&TYPES[match[2]];
  if(!type)throw Error(`Uniform ${name}: unsupported member "${member}" in struct ${declared.type}`);
  const [size,alignment,scalar,count]=type;
  offset=Math.ceil(offset/alignment)*alignment;align=Math.max(align,alignment);
  fields.push({name:match[1],offset,scalar,count});offset+=size;
 }
 if(!fields.length)throw Error(`Uniform ${name}: struct ${declared.type} is empty`);
 // A uniform buffer binding is sized in whole 16-byte rows on every backend this targets.
 return {binding:name,struct:declared.type,size:Math.ceil(Math.ceil(offset/align)*align/16)*16,fields};
}
