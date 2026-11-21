/** Native scene captures against Loom's own Dawn render of the same saved scene.
 *
 *   compare-scene.mjs plan <package dir> <plan file> <WxH>…
 *   compare-scene.mjs compare <project> <interface> <plugin> <package dir> <plan file> <capture dir> [media root]
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
/** The engine's present pass, in the same order of operations: aspect-kept fit from whole texels. */
function present(source,sw,sh,w,h){
 const scale=Math.min(w/sw,h/sh),ew=Math.min(w,Math.round(sw*scale)),eh=Math.min(h,Math.round(sh*scale)),ox=Math.floor((w-ew)/2),oy=Math.floor((h-eh)/2);
 const out=new Uint8Array(w*h*4),f=Math.fround,quant=(v)=>Math.round(Math.min(1,Math.max(0,v))*255);
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
const parsePlan=(text)=>text.split('\n').map(l=>l.trim().split(/\s+/)).filter(p=>p[0]==='capture').map(p=>({name:p[1],width:Number(p[2]),height:Number(p[3]),seconds:Number(p[4]),instance:Number(p[5]??0),frame:Number(p[1].split('-f')[1])}));

const [mode,...rest]=process.argv.slice(2);
if(mode==='plan'){
 const [packageDir,planFile,...sizes]=rest;
 const pkg=JSON.parse(await readFile(resolve(packageDir,'package.json'),'utf8'));
 // Frame 0 and two later frames: the clock must arrive, and arrive as the same number Loom used.
 const lines=sizes.flatMap(size=>{const [w,h]=size.split('x').map(Number);return [0,7,23].map(frame=>`capture ${w}x${h}-f${frame} ${w} ${h} ${frame/pkg.frame.fps}`);});
 await writeFile(planFile,lines.join('\n')+'\n');
 console.log(`Wrote ${lines.length} captures to ${planFile}`);
}else if(mode==='compare'){
 const [projectPath,interfacePath,pluginName,packageDir,planFile,captureDir,mediaRootArg]=rest;
 if(!captureDir)throw Error('Usage: compare-scene.mjs compare project interface plugin package-dir plan capture-dir [media-root]');
 const {renderHeadless}=await import('../../src/tests/headless/render-harness.ts');
 const {nodeGpuHost}=await import('../../src/runtime/backend/vgpu/node-gpu-host.ts');
 const {createDomainBus}=await import('../../src/domain/commands/index.ts');
 const mediaRoot=mediaRootArg??resolve(projectPath,'../../../public');
 const scene=compileScene(await readFile(projectPath,'utf8'),JSON.parse(await readFile(interfacePath,'utf8')),pluginName);
 const pkg=JSON.parse(await readFile(resolve(packageDir,'package.json'),'utf8'));
 const plan=parsePlan(await readFile(planFile,'utf8'));
 // The saved scene with every control at the value the package declares as its default.
 // The export drops the authoring-only nodes by rule, so Loom renders the scene without them too.
 // (They draw nothing; one of them can also carry a parameter this checkout does not know, VN132.)
 const saved=scene.document.graph,gone=new Set(Object.values(saved.nodes).filter(n=>DROPPED_NODES.has(n.type)).map(n=>n.id));
 const initialGraph={...saved,nodes:Object.fromEntries(Object.entries(saved.nodes).filter(([id])=>!gone.has(id))),edges:Object.fromEntries(Object.entries(saved.edges).filter(([,e])=>!gone.has(e.source.nodeId)&&!gone.has(e.target.nodeId)))};
 const {bus,store}=createDomainBus({registry:scene.registry,initialGraph,initialSettings:scene.settings});
 const patch=await bus.execute('graph.applyPatch',{baseRevision:store.view.getRevision(),operations:scene.controls.map((c,i)=>({op:'setParameters',nodeId:c.nodeId,parameters:{[c.valueKey]:c.type==='toggle'?pkg.controls[i].default>=0.5:pkg.controls[i].default}}))},{actor:{kind:'human',id:'ffgl-parity'},projectId:scene.document.projectId,capabilities:[]});
 if(patch.status!=='applied')throw Error(`Could not set the controls: ${JSON.stringify(patch)}`);
 const pictures={};
 for(const asset of scene.assets){
  const node=scene.document.graph.nodes[asset.nodeId];
  const png=decodePng(await readFile(resolve(mediaRoot,node.parameters.file)));
  pictures[node.id]=(size)=>{if(size[0]!==png.width||size[1]!==png.height)throw Error(`${node.id}: texture ${size} is not the file's ${png.width}×${png.height}`);return png.rgba;};
 }
 const frames=[...new Set(plan.map(p=>p.frame))].sort((a,b)=>a-b);
 for(const p of plan)if(Math.abs(p.seconds-p.frame/pkg.frame.fps)>1e-12)throw Error(`Plan capture ${p.name} is not on a frame of the scene's ${pkg.frame.fps} fps clock`);
 const result=await renderHeadless({host:nodeGpuHost(),graph:store.view.getGraph(),settings:scene.settings,fps:pkg.frame.fps,frames:frames.at(-1)+1,capture:frames,animate:true,pictures,outputNodeId:scene.plugin.output.nodeId,outputPortId:scene.plugin.output.portId,sinks:[scene.plugin.output]});
 // A finding about a payload a slot only keeps (`retained`) is about the file, not about these frames:
 // the render never read it. It is counted and said; everything else Loom reports stops the comparison.
 const kept=result.findings.filter(f=>f.retained);
 if(kept.length)console.log(`note: Loom reports ${kept.length} kept payloads it never reads (e.g. ${kept[0].diagnostic.message})`);
 const said=result.findings.filter(f=>!f.retained&&f.diagnostic.severity!=='info'&&f.diagnostic.code!=='project.limit.memoryBudget');
 if(said.length)throw Error(`Loom's own render reported: ${JSON.stringify(said.map(f=>f.diagnostic))}`);
 const oracle=new Map(result.frames.map(frame=>[frame.frameIndex,frame]));
 let worst=0,count=0,differing=0,channels=0;
 for(const p of plan){
  const frame=oracle.get(p.frame);
  if(frame.width!==pkg.size[0]||frame.height!==pkg.size[1])throw Error(`Loom rendered ${frame.width}×${frame.height}; the package says ${pkg.size}`);
  const expected=present(floats(frame),frame.width,frame.height,p.width,p.height);
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
 console.log(`PASS scene parity "${pluginName}": ${count} frames (${[...new Set(plan.map(p=>`${p.width}x${p.height}`))].join(', ')}; frames ${frames.join(', ')}), worst channel difference ${worst}/255, ${(100*differing/channels).toFixed(3)}% of channels differ at all`);
}else throw Error('Usage: compare-scene.mjs plan|compare …');
