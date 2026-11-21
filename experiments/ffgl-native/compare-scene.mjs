/** Native scene captures against Loom's own Dawn render of the same saved scene.
 *
 *   compare-scene.mjs plan <project> <interface> <plugin> <package dir> <plan file> [<WxH>…]
 *   compare-scene.mjs compare <project> <interface> <plugin> <package dir> <plan file> <capture dir> [media root]
 *
 * `plan` writes the harness script (and `<plan file>.json`, what each capture must show): every
 * declared parameter read back through the FFGL ABI, the defaults, three sweeps with every control
 * moved at once (two of them on two instances alive together), the host tempo taking over the
 * scene's tempo control, a walk through time, and the three fit modes at the extra host sizes.
 *
 * The oracle is `renderHeadless` (the frame driver, the value graph and the animator the app runs)
 * on the saved project, with control values written through domain commands. It never reads the
 * package's lowered expressions or its driven-uniform table, so a wrong lowering shows as a wrong pixel. */
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {compileScene,DROPPED_NODES} from './scene.mjs';
import {decodePng} from './png.mjs';

const TOLERANCE=1; // of 255, per channel: the bound the native experiment has held since VN21.
const half=(()=>{const table=new Float32Array(65536);for(let h=0;h<65536;h++){const s=h&0x8000?-1:1,e=(h>>10)&31,m=h&1023;table[h]=e===0?s*m*2**-24:e===31?(m?NaN:s*Infinity):s*(1+m/1024)*2**(e-15);}return table;})();
/** A Loom readback as float RGBA rows, top row first. */
function floats(frame){
 const n=frame.width*frame.height*4,out=new Float32Array(n);
 if(frame.format==='rgba16float'){const words=new Uint16Array(frame.bytes.buffer,frame.bytes.byteOffset,n);for(let i=0;i<n;i++)out[i]=half[words[i]];}
 else if(frame.format==='rgba8unorm'){for(let i=0;i<n;i++)out[i]=frame.bytes[i]/255;}
 else throw Error(`Oracle output is ${frame.format}`);
 return out;
}
/** The engine's present pass, in the same order of operations: the scene placed from whole texels. */
function present(source,sw,sh,w,h,fit){
 const f=Math.fround,quant=(v)=>Math.round(Math.min(1,Math.max(0,v))*255);
 const sx0=w/sw,sy0=h/sh,scale=fit==='fill'?Math.max(sx0,sy0):Math.min(sx0,sy0);
 let ew=fit==='stretch'?w:Math.round(sw*scale),eh=fit==='stretch'?h:Math.round(sh*scale);
 if(fit==='fit'){ew=Math.min(ew,w);eh=Math.min(eh,h);}
 const ox=Math.floor((w-ew)/2),oy=Math.floor((h-eh)/2),out=new Uint8Array(w*h*4);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const px=x+0.5-ox,py=y+0.5-oy;
  if(px<0||py<0||px>=ew||py>=eh)continue;
  const sx=f(f(f(px/ew)*sw)-0.5),sy=f(f(f(py/eh)*sh)-0.5),bx=Math.floor(sx),by=Math.floor(sy),fx=f(sx-bx),fy=f(sy-by);
  const ax=Math.min(sw-1,Math.max(0,bx)),ay=Math.min(sh-1,Math.max(0,by)),cx=Math.min(sw-1,Math.max(0,bx+1)),cy=Math.min(sh-1,Math.max(0,by+1));
  for(let c=0;c<4;c++){
   const top=f(source[(ay*sw+ax)*4+c]*(1-fx)+source[(ay*sw+cx)*4+c]*fx),bottom=f(source[(cy*sw+ax)*4+c]*(1-fx)+source[(cy*sw+cx)*4+c]*fx);
   out[(y*w+x)*4+c]=quant(f(top*(1-fy)+bottom*fy));
  }
 }
 return out;
}
const FFGL_TYPE={slider:10,hue:200,integer:13,toggle:0},FIT=['fit','fill','stretch'],FRAMES=[0,7,23];
const random=(seed)=>()=>{seed=(seed+0x6d2b79f5)|0;let t=Math.imul(seed^(seed>>>15),1|seed);t=(t+Math.imul(t^(t>>>7),61|t))^t;return ((t^(t>>>14))>>>0)/4294967296;};
/** Every control somewhere else in its range, on a value an FFGL float carries exactly. */
function sweep(controls,seed){
 const next=random(seed);
 return controls.map(c=>{
  const u=0.08+0.84*next();
  if(c.type==='toggle')return 0; // a toggle that kills the output would leave nothing to compare
  const v=c.min+u*(c.max-c.min);
  return Math.fround(c.step>0?Math.min(c.max,Math.max(c.min,Math.round(v/c.step)*c.step)):v);
 });
}
const [mode,projectPath,interfacePath,pluginName,packageDir,planFile,...rest]=process.argv.slice(2);
if(mode!=='plan'&&mode!=='compare'||!planFile)throw Error('Usage: compare-scene.mjs plan|compare project interface plugin package-dir plan-file …');
const pkg=JSON.parse(await readFile(resolve(packageDir,'package.json'),'utf8'));
if(mode==='plan'){
 const controls=pkg.controls,n=controls.length,fps=pkg.frame.fps,[sw,sh]=pkg.size,lines=[],captures=[];
 const hostBpmIndex=pkg.hostBpm?n:-1,fitIndex=n+(pkg.hostBpm?1:0);
 lines.push(`params ${fitIndex+1}`);
 controls.forEach((c,i)=>lines.push(`param ${i} ${FFGL_TYPE[c.type]} ${c.default} ${c.type==='hue'||c.type==='toggle'?'0 1':`${c.min} ${c.max}`} ${c.name}`));
 if(pkg.hostBpm)lines.push(`param ${hostBpmIndex} 0 ${pkg.hostBpm.default?1:0} 0 1 Host BPM`);
 lines.push(`param ${fitIndex} 11 0 0 1 Fit`);
 const defaults=controls.map(c=>c.default),a=sweep(controls,11),b=sweep(controls,23),c=sweep(controls,37);
 let instance=0;
 /** One instance walked through `frames`, capturing each. `state` is what Loom is told; `native` what the plugin is. */
 const run=(label,w,h,state,frames,{fit=0,native=state,beat=null}={})=>{
  const id=instance++;
  native.forEach((v,i)=>{if(v!==defaults[i])lines.push(`set ${id} ${i} ${v}`);});
  if(fit)lines.push(`set ${id} ${fitIndex} ${fit}`);
  if(beat!==null){lines.push(`set ${id} ${hostBpmIndex} 1`);lines.push(`beat ${id} ${beat} 0`);}
  const queue=[];
  for(let frame=0;frame<=frames.at(-1);frame++){
   if(frames.includes(frame)){const name=`${label}-${w}x${h}-f${frame}`;queue.push(`capture ${name} ${w} ${h} ${frame/fps} ${id}`);captures.push({name,width:w,height:h,frame,state,fit:FIT[fit],label});}
   else queue.push(`step ${id} ${w} ${h} ${frame/fps}`);
  }
  return {id,queue};
 };
 const flush=(...runs)=>{ // interleaved: the instances are alive together
  for(let i=0;i<Math.max(...runs.map(r=>r.queue.length));i++)for(const r of runs)if(r.queue[i])lines.push(r.queue[i]);
  for(const r of runs)lines.push(`close ${r.id}`);
 };
 flush(run('defaults',sw,sh,defaults,FRAMES));
 flush(run('sweepA',sw,sh,a,FRAMES));
 flush(run('pairB',sw,sh,b,FRAMES),run('pairC',sw,sh,c,FRAMES));
 if(pkg.hostBpm){
  // Loom is told the tempo control holds the host's tempo; the plugin keeps another value there and takes the host's.
  const tempo=controls[pkg.hostBpm.control],bpm=Math.fround(Math.round(tempo.min+0.62*(tempo.max-tempo.min))),state=[...a];
  state[pkg.hostBpm.control]=bpm;
  flush(run('hostbpm',sw,sh,state,FRAMES,{native:a,beat:bpm}));
 }
 for(const size of rest){
  const [w,h]=size.toLowerCase().split('x').map(Number);
  if(!(w>0&&h>0))throw Error(`Bad host size "${size}"`);
  flush(run('defaults',w,h,defaults,[0,7]));
  for(const fit of [1,2])flush(run(`sweepA-${FIT[fit]}`,w,h,a,[7],{fit}));
 }
 // Not compared with Loom: two live instances must share one copy of the stills, and what a frame costs.
 const first=instance++,second=instance++;
 lines.push('footprint before',`step ${first} ${sw} ${sh} 0`,'footprint one-instance','mark-log',`step ${second} ${sw} ${sh} 0`);
 if(pkg.assets.length)lines.push('expect-log stills 0 bytes uploaded');
 lines.push('footprint two-instances',`bench ${first} 1920 1080 120`,`bench ${first} 3840 2160 120`,`close ${first}`,`close ${second}`);
 // Opening and closing an instance must give its memory back: the fifth one may not sit far above the second.
 for(let cycle=0;cycle<5;cycle++){const id=instance++;lines.push(`step ${id} ${sw} ${sh} 0`,`step ${id} ${sw} ${sh} ${1/fps}`,`footprint cycle-${cycle}`,`close ${id}`);}
 lines.push('expect-growth cycle-1 cycle-4 25');
 await writeFile(planFile,lines.join('\n')+'\n');
 await writeFile(`${planFile}.json`,JSON.stringify({plugin:pluginName,captures},null,1)+'\n');
 console.log(`Wrote ${captures.length} captures on ${instance} instances and ${fitIndex+1} parameter checks to ${planFile}`);
}else{
 const [captureDir,mediaRootArg]=rest;
 if(!captureDir)throw Error('Usage: compare-scene.mjs compare project interface plugin package-dir plan-file capture-dir [media-root]');
 const {renderHeadless}=await import('../../src/tests/headless/render-harness.ts');
 const {nodeGpuHost}=await import('../../src/runtime/backend/vgpu/node-gpu-host.ts');
 const {createDomainBus}=await import('../../src/domain/commands/index.ts');
 const mediaRoot=mediaRootArg??resolve(projectPath,'../../../public');
 const scene=compileScene(await readFile(projectPath,'utf8'),JSON.parse(await readFile(interfacePath,'utf8')),pluginName);
 const plan=JSON.parse(await readFile(`${planFile}.json`,'utf8')).captures;
 // The export drops the authoring-only nodes by rule, so Loom renders the scene without them too.
 // (They draw nothing; one of them can also carry a parameter this checkout does not know, VN132.)
 const saved=scene.document.graph,gone=new Set(Object.values(saved.nodes).filter(n=>DROPPED_NODES.has(n.type)).map(n=>n.id));
 const initialGraph={...saved,nodes:Object.fromEntries(Object.entries(saved.nodes).filter(([id])=>!gone.has(id))),edges:Object.fromEntries(Object.entries(saved.edges).filter(([,e])=>!gone.has(e.source.nodeId)&&!gone.has(e.target.nodeId)))};
 const pictures={};
 for(const asset of scene.assets){
  const node=scene.document.graph.nodes[asset.nodeId];
  const png=decodePng(await readFile(resolve(mediaRoot,node.parameters.file)));
  pictures[node.id]=(size)=>{if(size[0]!==png.width||size[1]!==png.height)throw Error(`${node.id}: texture ${size} is not the file's ${png.width}×${png.height}`);return png.rgba;};
 }
 const states=new Map();
 for(const p of plan){const key=JSON.stringify(p.state);if(!states.has(key))states.set(key,[]);states.get(key).push(p);}
 let worst=0,count=0,differing=0,channels=0,kept=0;
 for(const [key,group] of states){
  const state=JSON.parse(key);
  if(state.length!==scene.controls.length)throw Error('The plan was written for another export of this scene');
  // Each state is the saved scene with its controls written through a domain command.
  const {bus,store}=createDomainBus({registry:scene.registry,initialGraph,initialSettings:scene.settings});
  const patch=await bus.execute('graph.applyPatch',{baseRevision:store.view.getRevision(),operations:scene.controls.map((c,i)=>({op:'setParameters',nodeId:c.nodeId,parameters:{[c.valueKey]:c.type==='toggle'?state[i]>=0.5:state[i]}}))},{actor:{kind:'human',id:'ffgl-parity'},projectId:scene.document.projectId,capabilities:[]});
  if(patch.status!=='applied')throw Error(`Could not set the controls: ${JSON.stringify(patch)}`);
  const frames=[...new Set(group.map(p=>p.frame))].sort((x,y)=>x-y);
  const result=await renderHeadless({host:nodeGpuHost(),graph:store.view.getGraph(),settings:scene.settings,fps:pkg.frame.fps,frames:frames.at(-1)+1,capture:frames,animate:true,pictures,outputNodeId:scene.plugin.output.nodeId,outputPortId:scene.plugin.output.portId,sinks:[scene.plugin.output]});
  // A finding about a payload a slot only keeps (`retained`) is about the file, not about these frames:
  // the render never read it. It is counted and said; everything else Loom reports stops the comparison.
  kept=Math.max(kept,result.findings.filter(f=>f.retained).length);
  const said=result.findings.filter(f=>!f.retained&&f.diagnostic.severity!=='info'&&f.diagnostic.code!=='project.limit.memoryBudget');
  if(said.length)throw Error(`Loom's own render reported: ${JSON.stringify(said.map(f=>f.diagnostic))}`);
  const oracle=new Map(result.frames.map(frame=>[frame.frameIndex,floats(frame)]));
  const [sw,sh]=[result.frames[0].width,result.frames[0].height];
  if(sw!==pkg.size[0]||sh!==pkg.size[1])throw Error(`Loom rendered ${sw}×${sh}; the package says ${pkg.size}`);
  for(const p of group){
   const expected=present(oracle.get(p.frame),sw,sh,p.width,p.height,p.fit);
   const native=await readFile(resolve(captureDir,`${p.name}.rgba`));
   if(native.length!==p.width*p.height*4)throw Error(`Capture ${p.name} has the wrong size`);
   let frameWorst=0,lit=0;
   for(let y=0;y<p.height;y++)for(let x=0;x<p.width*4;x++){
    const e=expected[y*p.width*4+x],d=Math.abs(e-native[(p.height-1-y)*p.width*4+x]); // GL reads bottom row first.
    if(d>frameWorst)frameWorst=d;if(d)differing++;if(e>8&&x%4!==3)lit++;
   }
   channels+=p.width*p.height*4;
   // A black frame matches a black frame: the comparison has to be looking at a picture.
   if(lit<p.width*p.height*0.05)throw Error(`Capture ${p.name}: Loom's frame is almost entirely black (${lit} lit channels); nothing would be proven`);
   if(frameWorst>TOLERANCE)throw Error(`Parity failed for ${p.name}: worst channel difference ${frameWorst}/255`);
   worst=Math.max(worst,frameWorst);count++;
  }
 }
 // The sweeps have to be different pictures, or moving every control proved nothing.
 const first=(label)=>plan.find(p=>p.label===label),same=async(x,y)=>Buffer.compare(await readFile(resolve(captureDir,`${x.name}.rgba`)),await readFile(resolve(captureDir,`${y.name}.rgba`)))===0;
 for(const [x,y] of [['defaults','sweepA'],['sweepA','pairB'],['pairB','pairC']])if(first(x)&&first(y)&&await same(first(x),first(y)))throw Error(`The ${x} and ${y} captures are the same picture; the controls reach nothing`);
 if(kept)console.log(`note: Loom reports ${kept} kept payloads it never reads in this file (static fallbacks an expression slot cannot take)`);
 console.log(`PASS scene parity "${pluginName}": ${count} captures, ${states.size} control states, sizes ${[...new Set(plan.map(p=>`${p.width}x${p.height}`))].join(', ')}, worst channel difference ${worst}/255, ${(100*differing/channels).toFixed(3)}% of channels differ at all`);
}
