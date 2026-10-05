import type { GraphEdge, GraphNode, ProjectDocument } from "../../domain/types/graph.ts";
import type { ParameterSlot } from "../../domain/types/parameters.ts";
import { edge, node as buildNode } from "./builders.ts";
import { resonanceDocument, configureResonanceLightPass } from "./resonance.ts";
import { resonanceHallEnvironment, resonanceHallRoom, type ResonanceHallKind } from "../shaders/resonance-family.wgsl.ts";
import {
  INSTALLATION_ATTRIBUTES,
  INSTALLATION_MIRROR_KERNEL,
  MONOLITH_KERNEL,
  MONOLITH_ATTRIBUTES,
  ORRERY_KERNEL,
  ORRERY_FILAMENT_ATTRIBUTES,
  ORRERY_FILAMENT_KERNEL,
  ORRERY_FILAMENT_MIRROR_KERNEL,
  ORRERY_CORE_KERNEL,
  lotusKernel,
  lotusCoreKernel,
} from "../shaders/resonance-installations.ts";

const mappedTint:ParameterSlot={
  mode:"map",
  bindings:{static:{kind:"static",value:[1,1,1,1]},map:{kind:"map",attribute:"tint"}},
};
const energy=(retained=0.36):ParameterSlot=>({
  mode:"expression",
  bindings:{static:{kind:"static",value:retained},expression:{kind:"expression",source:"clamp(op('lag_air').chan.level * 0.7 + op('lag_body').chan.low * 0.3, 0, 1)"}},
});
const spin=(speed:number):ParameterSlot=>({
  mode:"expression",
  bindings:{static:{kind:"static",value:0},expression:{kind:"expression",source:`abstime * ${speed}`}},
});
function node(id:string,type:string,position:readonly [number,number],parameters:GraphNode["parameters"],extra:Partial<GraphNode>):GraphNode{
  return buildNode(id,type,position,{}, {...extra,parameters});
}

const RESONANCE_INSTALLATION_NODES=new Set([
  "grid","fracture","shell","mirror","reflected","debris","chipGrid","chipForm","chips","dust","dustmat","debrisMirror","chipsMirror",
  "seams","seamLight","seamMirror","seamReflection","innerGrid","innerFracture","innerShell","innerStone","innerMirror","innerReflected",
  "innerSeams","innerSeamLight","innerSeamMirror","innerSeamReflection","mineral","stone",
  "key","rim","coreBlockGrid","coreBlockForm","coreBlock","coreMirrorForm","coreMirrorBlock",
]);

function add(doc:ProjectDocument,nodes:GraphNode[],edges:GraphEdge[]):void{
  for(const entry of nodes) doc.graph.nodes[entry.id]=entry;
  for(const entry of edges) doc.graph.edges[entry.id]=entry;
}

/**
 * E76-E78 deliberately inherit E75 Resonance's complete stage pipeline: deterministic
 * audio analysis, live TimeGrid projection atlas, raster colour/depth packing, wet-floor
 * reflection, environment lighting, haze, DOF, bloom and FXAA. Only installation and
 * architecture vary. This keeps Resonance as executable reference instead of copying a
 * cheap full-screen approximation of its result.
 */
function resonanceStage(kind:ResonanceHallKind,slug:string,name:string,seed:number):ProjectDocument{
  const doc=structuredClone(resonanceDocument);
  doc.projectId=`example-${slug}`;doc.name=name;doc.settings.randomSeed=seed;
  for(const id of RESONANCE_INSTALLATION_NODES) delete doc.graph.nodes[id];
  for(const [id,entry] of Object.entries(doc.graph.edges)){
    if(RESONANCE_INSTALLATION_NODES.has(entry.source.nodeId)||RESONANCE_INSTALLATION_NODES.has(entry.target.nodeId)) delete doc.graph.edges[id];
  }
  doc.graph.nodes.room!.parameters.source=resonanceHallRoom(kind);
  doc.graph.nodes.environment!.parameters.source=resonanceHallEnvironment(kind);
  doc.graph.nodes.room!.parameters.projectionSeed=seed;
  doc.graph.nodes.room!.parameters.shaftDirection=-1;
  doc.graph.nodes.timeWall!.parameters.seed=seed;
  const camera=doc.graph.nodes.cam!;
  const cameraSpec=kind==="lotus"?{eye:[0,2.7,17],lookAt:[0,5.4,0],fov:44}:kind==="monoliths"?{eye:[0,2.2,17],lookAt:[0,5.2,0],fov:47}:{eye:[0,2.7,18],lookAt:[0,5.8,0],fov:47};
  Object.assign(camera.parameters,cameraSpec);
  Object.assign(doc.graph.nodes.room!.parameters,{eye:cameraSpec.eye,aim:cameraSpec.lookAt,fov:cameraSpec.fov});
  doc.graph.nodes.room!.parameters.exposure=kind==="lotus"?1.08:kind==="monoliths"?0.86:1.24;
  doc.graph.nodes.room!.parameters.haze=0.022;
  doc.graph.nodes.room!.parameters.panelBrightness=0.45;
  doc.graph.nodes.lens!.parameters.chromatic=0.035;
  doc.graph.nodes.shot!.parameters.environmentIntensity=0.16;
  doc.graph.nodes.room!.parameters.panelStyle=kind==="lotus"?3:kind==="monoliths"?1:4;
  doc.graph.nodes.shot!.parameters.ambientIntensity=kind==="monoliths"?0.085:kind==="lotus"?0.1:0.12;
  return doc;
}

function lotusDocument():ProjectDocument{
  const doc=resonanceStage("lotus","verdant-lotus","E76 Verdant Lotus",76);
  delete doc.graph.nodes.backLight;
  doc.graph.nodes.bloom!.parameters.strength=0.12;
  doc.graph.nodes.shot!.parameters.environmentIntensity=0.48;
  const nodes:GraphNode[]=[
    node("crystalGlass","materialGlass",[-2250,-400],{ior:1.62,roughness:0.045,thickness:0.2,absorption:[1.0,0.08,0.55,1],dispersion:0.018},{label:"material_crystalglass"}),
    node("lotusGlow","materialUnlit",[-2250,-200],{color:[0.5,0.72,0.6,1]},{label:"material_lotusglow"}),
    node("lotusKey","light",[-2850,-460],{kind:"directional",color:[0.82,1,0.89,1],intensity:3.2,shadows:true,shadowExtent:15,direction:[-0.45,-0.55,-0.7]},{label:"light_lotuskey"}),
    node("lotusRim","light",[-2550,-460],{kind:"point",color:[0.18,1,0.44,1],intensity:18.0,position:[0,7.0,-1.5]},{label:"light_lotusrim"}),
  ];
  const edges:GraphEdge[]=[];const scenes:string[]=[];
  const petalColumns=32,rowsPerPetal=18;
  const rings=[
    {id:"outer",petals:10,radius:0.72,reach:5.25,lift:3.5,rise:2.15,width:1.35,thickness:0.7,curl:0.15,phase:0.08},
    {id:"middle",petals:8,radius:0.43,reach:3.8,lift:3.5,rise:3.75,width:1.05,thickness:0.65,curl:0.06,phase:0.3},
    {id:"crown",petals:6,radius:0.18,reach:2.55,lift:3.5,rise:5.65,width:0.78,thickness:0.56,curl:0,phase:0.48},
  ] as const;
  rings.forEach((ring,index)=>{
    const grid=`${ring.id}Grid`,form=`${ring.id}Form`,mesh=`${ring.id}Mesh`,mirror=`${ring.id}Mirror`,reflection=`${ring.id}Reflection`;
    const rows=ring.petals*rowsPerPetal,capacity=petalColumns*rows;
    nodes.push(
      node(grid,"pointGrid",[-4300,index*520],{cols:petalColumns,rows,count:capacity,sizeX:2,sizeY:2},{label:`grid_${ring.id}`}),
      node(form,"pointKernel",[-4000,index*520],{capacity,attributes:INSTALLATION_ATTRIBUTES,kernel:lotusKernel(petalColumns,rowsPerPetal),petals:ring.petals,radius:ring.radius,reach:ring.reach,lift:ring.lift,rise:ring.rise,width:ring.width,thickness:ring.thickness,curl:ring.curl,invert:1,phase:ring.phase,energy:energy()},{label:`kernel_${ring.id}form`}),
      node(mesh,"geometry",[-3670,index*520],{mode:"surface",material:"material_crystalglass",tint:[1,1,1,1]},{label:`geometry_${ring.id}mesh`}),
      node(mirror,"pointKernel",[-3370,index*520+150],{capacity,attributes:INSTALLATION_ATTRIBUTES,kernel:INSTALLATION_MIRROR_KERNEL},{label:`kernel_${ring.id}mirror`}),
      node(reflection,"geometry",[-3070,index*520+150],{mode:"surface",material:"material_crystalglass",tint:[1,1,1,1]},{label:`geometry_${ring.id}reflection`}),
    );
    edges.push(edge(`${ring.id}-grid`,[grid,"out"],[form,"in"]),edge(`${ring.id}-mesh`,[form,"out"],[mesh,"points"]),edge(`${ring.id}-mirror`,[form,"out"],[mirror,"in"]),edge(`${ring.id}-reflection`,[mirror,"out"],[reflection,"points"]));
    scenes.push(`geometry_${ring.id}mesh`,`geometry_${ring.id}reflection`);

  });
  const coreColumns=65,coreRows=32,coreCapacity=coreColumns*coreRows;
  nodes.push(
    node("lotusCoreGrid","pointGrid",[-4300,5400],{cols:coreColumns,rows:coreRows,count:coreCapacity,sizeX:2,sizeY:2},{label:"grid_lotuscore"}),
    node("lotusCoreForm","pointKernel",[-4000,5400],{capacity:coreCapacity,attributes:INSTALLATION_ATTRIBUTES,kernel:lotusCoreKernel(coreColumns),height:7.0,centreZ:1.7,radius:0.45,energy:energy(0.45)},{label:"kernel_lotuscoreform"}),
    node("lotusCoreMesh","geometry",[-3670,5400],{mode:"surface",material:"material_lotusglow",tint:mappedTint},{label:"geometry_lotuscoremesh"}),
    node("lotusCoreMirror","pointKernel",[-3370,5490],{capacity:coreCapacity,attributes:INSTALLATION_ATTRIBUTES,kernel:INSTALLATION_MIRROR_KERNEL},{label:"kernel_lotuscoremirror"}),
    node("lotusCoreReflection","geometry",[-3070,5490],{mode:"surface",material:"material_lotusglow",tint:mappedTint},{label:"geometry_lotuscorereflection"}),
  );
  edges.push(edge("lotus-core-grid",["lotusCoreGrid","out"],["lotusCoreForm","in"]),edge("lotus-core-mesh",["lotusCoreForm","out"],["lotusCoreMesh","points"]),edge("lotus-core-mirror",["lotusCoreForm","out"],["lotusCoreMirror","in"]),edge("lotus-core-reflection",["lotusCoreMirror","out"],["lotusCoreReflection","points"]));
  scenes.push("geometry_lotuscoremesh","geometry_lotuscorereflection");
  // Render the actual room before transmission. The far camera-facing plate is
  // behind every real surface, so final depth compositing still owns the room.
  const plateSource=resonanceHallRoom("lotus");
  const sceneStart=plateSource.indexOf("fn sceneAt(");
  const sceneEnd=plateSource.indexOf("@fragment fn fs",sceneStart);
  if(sceneStart<0 || sceneEnd<0) throw new Error("Lotus room plate needs the sceneAt function");
  const plateRoom=plateSource.slice(0,sceneStart)+"fn sceneAt(uv:vec2f)->vec4f{return vec4f(0,0,0,1); }\n"+plateSource.slice(sceneEnd);
  const plateKernel=`struct Params{
    eye:vec3f, // @default 0 2.7 17 Camera eye.
    aim:vec3f, // @default 0 5.4 0 Camera target.
    fov:f32, // @default 44 Vertical field of view.
  };
  fn process(p:Point,ctx:PointCtx)->Point{
    var q=p;let forward=normalize(ctx.params.aim-ctx.params.eye);
    let right=normalize(cross(forward,vec3f(0,1,0)));let up=cross(right,forward);
    let x=f32(ctx.index%2u)*2.0-1.0;let y=1.0-f32(ctx.index/2u)*2.0;
    let span=90.0*tan(ctx.params.fov*0.00872664626);
    q.position=ctx.params.eye+forward*90.0+right*x*span*1.777777778+up*y*span;
    return q;
  }`;
  nodes.push(
    node("roomPlate","customWgsl",[-4300,2500],{...doc.graph.nodes.room!.parameters,source:plateRoom},{label:"wgsl_roomplate",resolution:{mode:"project"}}),
    node("plateGrid","pointGrid",[-4300,2800],{cols:2,rows:2,count:4},{label:"grid_plate"}),
    node("plateForm","pointKernel",[-4000,2800],{capacity:4,attributes:INSTALLATION_ATTRIBUTES,kernel:plateKernel,eye:[0,2.7,17],aim:[0,5.4,0],fov:44},{label:"kernel_plateform"}),
    node("plateMaterial","materialUnlit",[-3670,2500],{color:[1,1,1,1]},{label:"material_plate"}),
    node("plateMesh","geometry",[-3370,2800],{mode:"surface",material:"material_plate"},{label:"geometry_platemesh"}),
  );
  edges.push(edge("plate-video",["videoPack","out"],["roomPlate","input"]),edge("plate-texture",["roomPlate","out"],["plateMaterial","albedo"]),edge("plate-grid",["plateGrid","out"],["plateForm","in"]),edge("plate-mesh",["plateForm","out"],["plateMesh","points"]));
  scenes.unshift("geometry_platemesh");
  add(doc,nodes,edges);
  doc.graph.nodes.shot!.parameters.scenes=scenes.join(" ");
  doc.graph.nodes.shot!.parameters.lights="light_lotuskey light_lotusrim light_fill";
  configureResonanceLightPass(doc);
  return doc;
}

function monolithDocument():ProjectDocument{
  const doc=resonanceStage("monoliths","ember-monoliths","E77 Ember Monoliths",77);
  delete doc.graph.nodes.backLight;
  doc.graph.nodes.room!.parameters.exposure=0.62;
  doc.graph.nodes.shot!.parameters.ambientIntensity=0.035;
  doc.graph.nodes.bloom!.parameters.strength=0.1;
  const nodes:GraphNode[]=[
    node("faultGlow","materialUnlit",[-2250,-260],{color:[1,1,1,1]},{label:"material_faultglow"}),
    node("basalt","materialPbr",[-2550,-260],{color:[0.2,0.21,0.22,1],metallic:0.05,roughness:0.88},{label:"material_basalt"}),
    node("emberKey","light",[-2850,-540],{kind:"directional",color:[0.88,0.81,0.74,1],intensity:2.3,shadows:true,shadowExtent:18,direction:[0.7,-0.5,-0.4]},{label:"light_emberkey"}),
    node("emberRim","light",[-2550,-540],{kind:"directional",color:[1,0.64,0.32,1],intensity:3.0,direction:[-0.6,-0.1,0.8]},{label:"light_emberrim"}),
  ];
  const edges:GraphEdge[]=[];const scenes:string[]=[];
  const slabs=[
    [-5.3,-0.8,0.5,1.4,6.2,-1.2],[-3.55,-1.0,-0.38,1.45,8.7,-0.9],[-1.5,-1.25,-0.24,1.55,10.0,0.05],
    [1.5,-1.3,0.32,1.55,10.5,0.3],[3.7,-1.2,0.45,1.4,9.0,1.2],[5.5,-0.8,-0.5,1.25,6.0,1.25],
    [-4.5,1.35,-0.4,1.7,3.5,-0.65],[4.6,1.2,0.45,1.65,3.2,0.55],[2.8,-4.8,-0.35,1.25,8.6,0.1],
  ] as const;
  slabs.forEach((s,index)=>{
    const [x,z,yaw,width,height,lean]=s;const id=`slab${index}`,grid=`${id}Grid`,form=`${id}Form`,mesh=`${id}Mesh`,mirror=`${id}Mirror`,reflection=`${id}Reflection`;const capacity=129*129;
    nodes.push(node(grid,"pointGrid",[-4300,index*230],{cols:129,rows:129,count:capacity,sizeX:1,sizeY:1},{label:`grid_${id}`}),node(form,"pointKernel",[-4000,index*230],{capacity,attributes:MONOLITH_ATTRIBUTES,kernel:MONOLITH_KERNEL,x,z,yaw,width:width*1.2,depth:1.3+index%3*0.4,height,lean,phase:index,energy:energy(0.32)},{label:`kernel_${id}form`}),node(mesh,"geometry",[-3680,index*230],{mode:"surface",material:"material_basalt",tint:mappedTint},{label:`geometry_${id}mesh`}),node(mirror,"pointKernel",[-3370,index*230+90],{capacity,attributes:MONOLITH_ATTRIBUTES,kernel:INSTALLATION_MIRROR_KERNEL},{label:`kernel_${id}mirror`}),node(reflection,"geometry",[-3060,index*230+90],{mode:"surface",material:"material_basalt",tint:mappedTint},{label:`geometry_${id}reflection`}));
    const glow=`${id}Glow`;
    nodes.push(node(glow,"geometry",[-2770,index*230],{mode:"beam",endpoint:"end",material:"material_faultglow",tint:{mode:"map",bindings:{static:{kind:"static",value:[1,1,1,1]},map:{kind:"map",attribute:"emission"}}},scale:0.028,soft:1,blend:"additive",inDepthOutput:true,group:"p.fissure > 0.5"},{label:`geometry_${id}glow`}));
    edges.push(edge(`${id}-glow`,[form,"out"],[glow,"points"]));scenes.push(`geometry_${id}glow`);
    edges.push(edge(`${id}-grid`,[grid,"out"],[form,"in"]),edge(`${id}-mesh`,[form,"out"],[mesh,"points"]),edge(`${id}-mirror`,[form,"out"],[mirror,"in"]),edge(`${id}-reflection`,[mirror,"out"],[reflection,"points"]));scenes.push(`geometry_${id}mesh`,`geometry_${id}reflection`);
  });
  add(doc,nodes,edges);doc.graph.nodes.shot!.parameters.scenes=scenes.join(" ");doc.graph.nodes.shot!.parameters.lights="light_emberkey light_emberrim light_fill";
  configureResonanceLightPass(doc);
  return doc;
}

function orreryDocument():ProjectDocument{
  const doc=resonanceStage("orrery","aether-orrery","E78 Aether Orrery",78);
  delete doc.graph.nodes.backLight;
  doc.graph.nodes.room!.parameters.exposure=1.02;
  doc.graph.nodes.bloom!.parameters.strength=0.16;
  doc.graph.nodes.shot!.parameters.environmentIntensity=0.65;
  const nodes:GraphNode[]=[node("aetherGlow","materialUnlit",[-2250,-260],{color:[1,1,1,1]},{label:"material_aetherglow"}),node("aether","materialPbr",[-2550,-260],{color:[0.68,0.72,0.8,1],metallic:0.92,roughness:0.2},{label:"material_aether"}),node("aetherKey","light",[-2850,-540],{kind:"directional",color:[0.86,0.91,1,1],intensity:3.8,shadows:true,shadowExtent:16,direction:[-0.7,-0.25,-0.6]},{label:"light_aetherkey"}),node("aetherRim","light",[-2550,-540],{kind:"directional",color:[0.57,0.64,1,1],intensity:2.0,direction:[0.6,-0.4,0.4]},{label:"light_aetherrim"})];
  const edges:GraphEdge[]=[];const scenes:string[]=[];
  const rings=[[1.5,0.18,1.2,0.1,0.028,0.72],[2.25,0.24,0.9,-0.3,-0.021,0.81],[3.05,0.3,0.55,0.52,0.017,0.68],[3.95,0.34,1.5,0.2,-0.013,0.87],[4.85,0.30,0.38,0.06,0.009,0.77]] as const;
  rings.forEach((ring,index)=>{const [radius,width,pitch,roll,speed,arc]=ring;const cols=256,rows=17,capacity=cols*rows;
    for(const inset of [false,true]) {
      const id=`ring${index}${inset?"Inset":""}`,points=`${id}Points`,form=`${id}Form`,mesh=`${id}Mesh`,mirror=`${id}Mirror`,reflection=`${id}Reflection`;
      const y=index*560+(inset?260:0),thickness=0.15+index%3*0.025;
      const material=inset?"material_aetherglow":"material_aether";
      nodes.push(node(points,"pointGrid",[-4300,y],{cols,rows,count:capacity,sizeX:2,sizeY:2},{label:`grid_${id}`}),node(form,"pointKernel",[-4000,y],{capacity,attributes:INSTALLATION_ATTRIBUTES,kernel:ORRERY_KERNEL,radius:inset?radius-width+0.012:radius,width:inset?0.018:width,thickness:inset?thickness*0.48:thickness,arc,offset:index*0.17,inset:inset?1:0,pitch,yaw:index*0.37,roll,height:5.65,spin:spin(speed),energy:energy(0.3)},{label:`kernel_${id}form`}),node(mesh,"geometry",[-3680,y],{mode:"surface",material,tint:mappedTint},{label:`geometry_${id}mesh`}),node(mirror,"pointKernel",[-3370,y+90],{capacity,attributes:INSTALLATION_ATTRIBUTES,kernel:INSTALLATION_MIRROR_KERNEL},{label:`kernel_${id}mirror`}),node(reflection,"geometry",[-3060,y+90],{mode:"surface",material,tint:mappedTint},{label:`geometry_${id}reflection`}));
      edges.push(edge(`${id}-points`,[points,"out"],[form,"in"]),edge(`${id}-mesh`,[form,"out"],[mesh,"points"]),edge(`${id}-mirror`,[form,"out"],[mirror,"in"]),edge(`${id}-reflection`,[mirror,"out"],[reflection,"points"]));scenes.push(`geometry_${id}mesh`,`geometry_${id}reflection`);
    }
  });
  const columns=65,rows=32,capacity=columns*rows;
  nodes.push(node("coreGrid","pointGrid",[-4300,3200],{cols:columns,rows,count:capacity,sizeX:2,sizeY:2},{label:"grid_core"}),node("coreForm","pointKernel",[-4000,3200],{capacity,attributes:INSTALLATION_ATTRIBUTES,kernel:ORRERY_CORE_KERNEL,energy:energy(0.4)},{label:"kernel_coreform"}),node("coreMesh","geometry",[-3680,3200],{mode:"surface",material:"material_aetherglow",tint:mappedTint},{label:"geometry_coremesh"}),node("coreMirror","pointKernel",[-3370,3290],{capacity,attributes:INSTALLATION_ATTRIBUTES,kernel:INSTALLATION_MIRROR_KERNEL},{label:"kernel_coremirror"}),node("coreReflection","geometry",[-3060,3290],{mode:"surface",material:"material_aetherglow",tint:mappedTint},{label:"geometry_corereflection"}));
  edges.push(edge("core-grid",["coreGrid","out"],["coreForm","in"]),edge("core-mesh",["coreForm","out"],["coreMesh","points"]),edge("core-mirror",["coreForm","out"],["coreMirror","in"]),edge("core-reflection",["coreMirror","out"],["coreReflection","points"]));scenes.push("geometry_coremesh","geometry_corereflection");
  nodes.push(node("plasmaForm","pointKernel",[-4300,3560],{capacity:18*128,attributes:ORRERY_FILAMENT_ATTRIBUTES,kernel:ORRERY_FILAMENT_KERNEL,energy:energy(0.4)},{label:"kernel_plasmaform"}),node("plasmaMesh","geometry",[-4000,3560],{mode:"beam",endpoint:"end",material:"material_aetherglow",tint:mappedTint,scale:0.012,soft:1,blend:"additive",inDepthOutput:true},{label:"geometry_plasmamesh"}),node("plasmaMirror","pointKernel",[-3680,3560],{capacity:18*128,attributes:ORRERY_FILAMENT_ATTRIBUTES,kernel:ORRERY_FILAMENT_MIRROR_KERNEL},{label:"kernel_plasmamirror"}),node("plasmaReflection","geometry",[-3370,3560],{mode:"beam",endpoint:"end",material:"material_aetherglow",tint:mappedTint,scale:0.012,soft:1,blend:"additive",inDepthOutput:true},{label:"geometry_plasmareflection"}));
  edges.push(edge("plasma-mesh",["plasmaForm","out"],["plasmaMesh","points"]),edge("plasma-mirror",["plasmaForm","out"],["plasmaMirror","in"]),edge("plasma-reflection",["plasmaMirror","out"],["plasmaReflection","points"]));scenes.push("geometry_plasmamesh","geometry_plasmareflection");
  add(doc,nodes,edges);doc.graph.nodes.shot!.parameters.scenes=scenes.join(" ");doc.graph.nodes.shot!.parameters.lights="light_aetherkey light_aetherrim light_fill";
  configureResonanceLightPass(doc);
  return doc;
}

export const verdantLotusDocument=lotusDocument();
export const emberMonolithsDocument=monolithDocument();
export const aetherOrreryDocument=orreryDocument();
