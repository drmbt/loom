import { resonancePaletteExpression } from "../shaders/resonance-palette.ts";
import { settings, node as buildNode, edge, graph, document, expressionSlot } from "./builders.ts";
import { SHOWCASE_BEAT, SHOWCASE_BEAT_FILE, SHOWCASE_BEAT_OFFSET_SECONDS } from "../build-showcase-beat.ts";
import { INNER_SHELL_KERNEL, INNER_SEAM_KERNEL, INNER_SHELL_COLUMNS, INNER_SHELL_CAPACITY, SHELL_KERNEL, SHELL_ATTRIBUTES, SHELL_CAPACITY, SHELL_COLUMNS, SHELL_ROWS, MIRROR_KERNEL, DEBRIS_ATTRIBUTES, DEBRIS_KERNEL, SEAM_KERNEL, SEAM_ATTRIBUTES, SEAM_MIRROR_KERNEL, CHIP_KERNEL, CHIP_COLUMNS, CHIP_ROWS, CHIP_CAPACITY } from "../shaders/resonance-shell.ts";
import { RESONANCE_ROOM_WGSL, RESONANCE_BLOOM_WGSL, RESONANCE_ENV_WGSL, RESONANCE_ROUGHNESS_WGSL, RESONANCE_DOF_WGSL, RESONANCE_ATLAS_SCENE_WGSL, RESONANCE_ATLAS_VIDEO_WGSL, RESONANCE_ATLAS_LIGHT_WGSL, RESONANCE_VIDEO_CROP_WGSL } from "../shaders/resonance.wgsl.ts";
import { FXAA_WGSL } from "../shaders/fxaa.wgsl.ts";
import type { ParameterSlot } from "../../domain/types/parameters.ts";
import type { GraphNode, ProjectDocument } from "../../domain/types/graph.ts";
function node(id: string, type: string, position: readonly [number, number], parameters: GraphNode["parameters"], extra: Partial<GraphNode>) {
  return buildNode(id, type, position, {}, { ...extra, parameters });
}
const paletteColour = Object.fromEntries((["r","g","b"] as const).map((key,i)=>[`color.${key}`,expressionSlot(resonancePaletteExpression(i as 0|1|2),[1,0.69,0.39][i]!)]));
const tint: ParameterSlot = { mode: "map", bindings: { static: { kind: "static", value: [1,1,1,1] }, map: { kind: "map", attribute: "tint" } } };
const mapped = (attribute: string, value: number | number[]): ParameterSlot => ({ mode: "map", bindings: { static: { kind: "static", value }, map: { kind: "map", attribute } } });
const expansion = "clamp(((op('body1').chan.low * 0.65 + op('body1').chan.level * 0.35) - 0.2) * 2.1 * clamp(op('presence1').chan.level * 6, 0, 1), 0, 1)";
export const resonanceDocument = document("resonance", "E75 Resonance",
  settings({ randomSeed: 75, outputResolution: { width: 1280, height: 720 } }), graph([
    node("clip", "audioFileIn", [-1600,800], {
      file: SHOWCASE_BEAT_FILE, playMode: "timeline", play: true, speed: 1, cue: false, cuePoint: 0,
      trimStart: 0, trimEnd: 0, extend: "loop", volume: 1, monitor: true,
      tempoMode: "declared", bpm: SHOWCASE_BEAT.bpm, beatsPerBar: SHOWCASE_BEAT.beatsPerBar,
      beatOffset: Math.round(SHOWCASE_BEAT_OFFSET_SECONDS*1000)/1000,
    }, {label:"clip1"}),
    node("analysis", "component:audioAnalysis@1", [-1600,500], {envelope:0.12,window:16,settle:0.4,hitDecay:160}, {label:"analysis1"}),
    node("presence", "valueLag", [-1900,800], {lag:0.6,releaseRatio:3}, {label:"presence1"}),
    node("body", "valueLag", [-1300,800], {lag:1.1,releaseRatio:3}, {label:"body1"}),
    node("detail", "valueLag", [-1000,800], {lag:0.012,releaseRatio:3}, {label:"detail1"}),
    node("air", "valueLag", [-700,800], {lag:4,releaseRatio:2}, {label:"air1"}),
    node("grid", "pointGrid", [-1600,0], {cols:SHELL_COLUMNS,rows:SHELL_ROWS,count:SHELL_CAPACITY,sizeX:2,sizeY:2}, {label:"grid1"}),
    node("fracture", "pointKernel", [-1300,0], {
      capacity:SHELL_CAPACITY,seed:75,attributes:SHELL_ATTRIBUTES,kernel:SHELL_KERNEL,
      rotation:expressionSlot("abstime * 4",0),radius:2.1,spreadFloor:0.065,reach:3.1,height:5.6,fissure:expressionSlot("0.004 + (clamp(((op('body1').chan.low * 0.65 + op('body1').chan.level * 0.35) - 0.2) * 2.1 * clamp(op('presence1').chan.level * 6, 0, 1), 0, 1)) * 0.12 + 0.032 * clamp(op('detail1').chan.snareCount * 0.6 + op('body1').chan.highMid * 0.4, 0, 1)",0.004),vibration:0.012,
      expansion:expressionSlot(expansion,0),impulse:expressionSlot("clamp(op('detail1').chan.kickCount * 0.8 + op('detail1').chan.snareCount * 0.35, 0, 1)",0),
    }, {label:"fracture1"}),
    node("shell", "geometry", [-1000,0], {mode:"surface",material:"stone1",tint}, {label:"shell1"}),
    node("mirror", "pointKernel", [-1000,280], {capacity:SHELL_CAPACITY,seed:75,attributes:SHELL_ATTRIBUTES,kernel:MIRROR_KERNEL}, {label:"mirror1"}),
    node("reflected", "geometry", [-700,280], {mode:"surface",material:"stone1",tint}, {label:"reflected1"}),
    node("debris", "pointKernel", [-1300,1200], {capacity:900,seed:75,attributes:DEBRIS_ATTRIBUTES,kernel:DEBRIS_KERNEL,paletteCycle:expressionSlot("op('room1').par.paletteCycle",1),rotation:expressionSlot("op('fracture1').par.rotation",0),expansion:expressionSlot(expansion,0),highs:expressionSlot("op('detail1').chan.hatCount",0)}, {label:"debris1"}),
    node("chipGrid", "pointGrid", [-1900,2250], {cols:CHIP_COLUMNS,rows:CHIP_ROWS,count:CHIP_CAPACITY,sizeX:2,sizeY:2}, {label:"chipgrid1"}),
    node("chipForm", "pointKernel", [-1600,2250], {capacity:CHIP_CAPACITY,seed:75,attributes:DEBRIS_ATTRIBUTES,kernel:CHIP_KERNEL,paletteCycle:expressionSlot("op('room1').par.paletteCycle",1),rotation:expressionSlot("op('fracture1').par.rotation",0),expansion:expressionSlot(expansion,0)}, {label:"chipform1"}),
    node("chips", "geometry", [-1000,1200], {mode:"surface",material:"stone1",tint}, {label:"chips1"}),
    node("dust", "geometry", [-1000,1500], {mode:"points",material:"dustmat1",tint,scale:mapped("size",1),soft:1,blend:"additive",group:"p.size < 0.025"}, {label:"dust1"}),
    node("dustmat", "materialUnlit", [-700,1500], {color:[1,1,1,1]}, {label:"dustmat1"}),
    node("debrisMirror", "pointKernel", [-700,1200], {capacity:CHIP_CAPACITY,seed:75,attributes:DEBRIS_ATTRIBUTES,kernel:MIRROR_KERNEL}, {label:"debrismirror1"}),
    node("chipsMirror", "geometry", [-400,1200], {mode:"surface",material:"stone1",tint}, {label:"chipsmirror1"}),
    node("seams", "pointKernel", [-1300,1850], {capacity:SHELL_CAPACITY,seed:75,attributes:SEAM_ATTRIBUTES,kernel:SEAM_KERNEL,voltage:expressionSlot("clamp(op('body1').chan.level * 0.65 + op('air1').chan.level * 0.7, 0, 1)",0),paletteCycle:expressionSlot("op('room1').par.paletteCycle",1),rotation:expressionSlot("op('fracture1').par.rotation",0),gain:expressionSlot("clamp(op('body1').chan.lowMid * 0.65 + op('air1').chan.level * 0.25,0,1)",0)}, {label:"seams1"}),
    node("seamLight", "geometry", [-1000,1850], {mode:"beam",endpoint:"end",material:"dustmat1",tint,scale:mapped("beamWidth",1),soft:1,blend:"additive",group:"p.seam > 0.5"}, {label:"seamlight1"}),
    node("seamMirror", "pointKernel", [-700,1850], {capacity:SHELL_CAPACITY,seed:75,attributes:SEAM_ATTRIBUTES,kernel:SEAM_MIRROR_KERNEL}, {label:"seammirror1"}),
    node("seamReflection", "geometry", [-400,1850], {mode:"beam",endpoint:"end",material:"dustmat1",tint,scale:mapped("beamWidth",1),soft:1,blend:"additive",group:"p.seam > 0.5"}, {label:"seamreflection1"}),
    node("innerGrid", "pointGrid", [-1900,2650], {cols:INNER_SHELL_COLUMNS,rows:SHELL_ROWS,count:INNER_SHELL_CAPACITY,sizeX:2,sizeY:2}, {label:"innergrid1"}),
    node("innerFracture", "pointKernel", [-1600,2650], {capacity:INNER_SHELL_CAPACITY,seed:75,attributes:SHELL_ATTRIBUTES,kernel:INNER_SHELL_KERNEL,impulse:expressionSlot("clamp(op('detail1').chan.kickCount * 0.8 + op('detail1').chan.snareCount * 0.35, 0, 1)",0),radius:1.42,spreadFloor:0.22,reach:1.7,height:5.6,vibration:0.006,rotation:expressionSlot("op('fracture1').par.rotation",0),expansion:expressionSlot("clamp((op('fracture1').par.expansion - 0.10) / 0.90, 0, 1)",0),fissure:expressionSlot("0.07 + clamp((op('fracture1').par.expansion - 0.10) / 0.90, 0, 1) * 0.12",0.07)}, {label:"innerfracture1"}),
    node("innerShell", "geometry", [-1300,2650], {mode:"surface",material:"innerstone1",tint}, {label:"innershell1"}),
    node("innerStone", "materialPbr", [-1000,2650], {color:[0.72,0.72,0.74,1],metallic:0.25,roughness:0.85}, {label:"innerstone1"}),
    node("innerMirror", "pointKernel", [-1300,2950], {capacity:INNER_SHELL_CAPACITY,seed:75,attributes:SHELL_ATTRIBUTES,kernel:MIRROR_KERNEL}, {label:"innermirror1"}),
    node("innerReflected", "geometry", [-1000,2950], {mode:"surface",material:"innerstone1",tint}, {label:"innerreflected1"}),
    node("innerSeams", "pointKernel", [-1600,3300], {capacity:INNER_SHELL_CAPACITY,seed:75,attributes:SEAM_ATTRIBUTES,kernel:INNER_SEAM_KERNEL,voltage:expressionSlot("(clamp(op('body1').chan.level * 0.65 + op('air1').chan.level * 0.7, 0, 1)) * 0.65",0),paletteCycle:expressionSlot("op('room1').par.paletteCycle",1),rotation:expressionSlot("op('innerfracture1').par.rotation",0),gain:expressionSlot("0.12 + op('innerfracture1').par.expansion * 0.88",0.12)}, {label:"innerseams1"}),
    node("innerSeamLight", "geometry", [-1300,3300], {mode:"beam",endpoint:"end",material:"dustmat1",tint,scale:mapped("beamWidth",1),soft:1,blend:"additive",group:"p.seam > 0.5"}, {label:"innerseamlight1"}),
    node("innerSeamMirror", "pointKernel", [-1000,3300], {capacity:INNER_SHELL_CAPACITY,seed:75,attributes:SEAM_ATTRIBUTES,kernel:SEAM_MIRROR_KERNEL}, {label:"innerseammirror1"}),
    node("innerSeamReflection", "geometry", [-700,3300], {mode:"beam",endpoint:"end",material:"dustmat1",tint,scale:mapped("beamWidth",1),soft:1,blend:"additive",group:"p.seam > 0.5"}, {label:"innerseamreflection1"}),
    node("mineral", "customWgsl", [-1300,-650], {source:RESONANCE_ROUGHNESS_WGSL,variation:0.55,grain:0.06}, {label:"mineral1",resolution:{mode:"fixed",width:1024,height:2048}}),
    node("stone", "materialPbr", [-700,0], {color:[0.75,0.73,0.70,1],metallic:0.18,roughness:0.9}, {label:"stone1"}),
    node("cam", "camera", [-400,280], {eye:[0,2.6,17],lookAt:[0,4.2,0],fov:50,near:0.1,far:100}, {label:"cam1"}),
    node("backLight", "light", [-1300,-280], {kind:"directional",color:[1,0.69,0.39,1],...paletteColour,intensity:1.7,shadows:true,shadowExtent:14,direction:[0.15,-0.35,1]}, {label:"backlight1"}),
    node("key", "light", [-1000,-280], {kind:"directional",color:[0.85,0.91,1,1],intensity:0.65,shadows:true,shadowExtent:14,direction:[-0.5,-0.6,-0.8]}, {label:"key1"}),
    node("rim", "light", [-700,-280], {kind:"point",color:[1,0.69,0.39,1],...paletteColour,intensity:expressionSlot("0.2 + op('body1').chan.low * 1.5 + op('detail1').chan.snareCount * 3 + op('detail1').chan.kickCount * 1.8",0.2),position:[0,5.6,-0.8]}, {label:"rim1"}),
    node("fill", "light", [-400,-280], {kind:"directional",color:[0.65,0.74,0.88,1],intensity:0.32,direction:[0.8,-0.2,0.4]}, {label:"fill1"}),
    node("envSeed", "solid", [-400,-650], {color:[0,0,0,1]}, {label:"envseed1",resolution:{mode:"fixed",width:512,height:288}}),
    node("environment", "customWgsl", [-100,-650], {
      source:RESONANCE_ENV_WGSL,exposure:1,eye:[0,2.6,17],aim:[0,4.2,0],far:100,fov:50,haze:0.045,reflection:0.65,
      ...Object.fromEntries(Object.entries({energy:0,beatPulse:0,bass:0,mids:0,highs:0,transient:0,atmosphere:0,shaftDirection:1,panelWater:1,videoMotion:0.6,videoGlitch:0.18,paletteCycle:1,panelVideo:0,panelStyle:0,coreGradient:0.65,projectionSeed:75,panelSequence:1,panelScene:1,panelBpm:112,panelClock:0,panelPosition:0,beatPosition:0,panelBars:8,panelFadeBars:2,panelBrightness:1,panelCoverage:1,panelVariety:1,panelAudio:0.35}).map(([name,value])=>[name,expressionSlot(`op('room1').par.${name}`,value)])),
    }, {label:"environment1",resolution:{mode:"fixed",width:512,height:256}}),
    node("shot", "render", [-100,0], {scenes:"shell1 reflected1 chips1 chipsmirror1 innershell1 innerreflected1 dust1 seamlight1 seamreflection1 innerseamlight1 innerseamreflection1",camera:"cam1",lights:"key1 rim1 fill1 backlight1",background:[0,0,0,0],environmentIntensity:0.5,environmentTaps:16,ambientColor:[0.6,0.64,0.7,1],ambientIntensity:0.045,antialias:"msaa",depthOutput:true}, {label:"shot1"}),
    node("lightBlock", "materialUnlit", [-1900,3750], {color:[0,0,0,1]}, {label:"lightblock1"}),
    node("coreBlockGrid", "pointGrid", [-1900,4100], {cols:65,rows:33,count:2145}, {label:"coreblockgrid1"}),
    node("coreBlockForm", "pointKernel", [-1600,4100], {capacity:2145,kernel:`fn process(p:Point,ctx:PointCtx)->Point {
      var q=p;let longitude=f32(ctx.index%65u)/64.0*6.2831853;let latitude=f32(ctx.index/65u)/32.0*3.14159265;
      q.position=vec3f(sin(latitude)*cos(longitude),cos(latitude)+5.6,sin(latitude)*sin(longitude));return q;
    }`}, {label:"coreblockform1"}),
    node("coreBlock", "geometry", [-1300,4100], {mode:"surface",material:"lightblock1"}, {label:"coreblock1"}),
    node("coreMirrorForm", "pointKernel", [-1000,4100], {capacity:2145,kernel:"fn process(p:Point,ctx:PointCtx)->Point {var q=p;q.position.y=-p.position.y;return q;}"}, {label:"coremirrorform1"}),
    node("coreMirrorBlock", "geometry", [-700,4100], {mode:"surface",material:"lightblock1"}, {label:"coremirrorblock1"}),
    // Emissive light has depth for visibility, but never replaces the opaque backdrop.
    node("lightShot", "render", [-100,350], {scenes:"",camera:"cam1",background:[0,0,0,0],antialias:"msaa",depthOutput:true}, {label:"lightshot1"}),
    node("lightAlpha", "reorder", [200,700], {outa:"one"}, {label:"lightalpha1"}),
    node("lightDepth", "mask", [500,700], {channel:"red",apply:"alpha",invert:0}, {label:"lightdepth1"}),
    node("lightPack", "customWgsl", [800,700], {source:RESONANCE_ATLAS_LIGHT_WGSL}, {label:"lightpack1",resolution:{mode:"scale",factor:2}}),
    node("lightAtlas", "add", [1400,700], {opacity:1}, {label:"lightatlas1"}),
    node("opaqueAlpha", "reorder", [200,350], {outa:"one"}, {label:"opaquealpha1"}),
    node("depthPack", "mask", [500,350], {channel:"red",apply:"alpha",invert:0}, {label:"depthpack1"}),
    // Explicit live-source selection: no capture request when the example opens.
    node("panelCam", "webcam", [200,1100], {}, {label:"panelcam1"}),
    node("panelMovie", "movieFileIn", [200,1400], {file:"",playMode:"freeRun",speed:1}, {label:"panelmovie1"}),
    node("cameraCrop", "customWgsl", [200,1750], {source:RESONANCE_VIDEO_CROP_WGSL}, {label:"cameracrop1",resolution:{mode:"fixed",width:512,height:288}}),
    node("movieCrop", "customWgsl", [500,1750], {source:RESONANCE_VIDEO_CROP_WGSL}, {label:"moviecrop1",resolution:{mode:"fixed",width:512,height:288}}),
    node("panelSource", "switch", [500,1100], {index:0}, {label:"panelsource1"}),
    node("timeWall", "component:timeGrid@1", [800,1100], {columns:12,rows:2,churn:0,span:61,spread:1,mode:3,rate:1,seed:75,glitch:0,chroma:0,crush:1,colour:[1,1,1,1],blend:0}, {label:"timewall1"}),
    node("videoPack", "customWgsl", [1100,1100], {source:RESONANCE_ATLAS_VIDEO_WGSL}, {label:"videopack1",resolution:{mode:"scale",factor:2}}),
    node("scenePack", "customWgsl", [800,350], {source:RESONANCE_ATLAS_SCENE_WGSL}, {label:"scenepack1",resolution:{mode:"scale",factor:2}}),
    node("sceneAtlas", "add", [1100,350], {opacity:1}, {label:"sceneatlas1"}),
    node("room", "customWgsl", [200,0], {
      source:RESONANCE_ROOM_WGSL,shaftDirection:1,panelWater:1,videoMotion:0.6,videoGlitch:0.18,paletteCycle:1,panelVideo:expressionSlot("min(op('panelsource1').par.index, 1)",0),panelStyle:0,coreGradient:0.65,projectionSeed:75,far:expressionSlot("op('cam1').par.far",100),
      panelClock:0,panelPosition:expressionSlot("op('clip1').chan.bar + op('clip1').chan.barPhase",0),beatPosition:expressionSlot("op('clip1').chan.beat + op('clip1').chan.beatPhase",0),
      panelSequence:1,panelScene:1,panelBpm:expressionSlot("op('clip1').par.bpm",112),panelBars:8,panelFadeBars:2,
      panelBrightness:1,panelCoverage:1,panelVariety:1,panelAudio:0.35,eye:[0,2.6,17],aim:[0,4.2,0],
      "eye.x":expressionSlot("op('cam1').par.eye.x",0),"eye.y":expressionSlot("op('cam1').par.eye.y",2.6),"eye.z":expressionSlot("op('cam1').par.eye.z",17),
      "aim.x":expressionSlot("op('cam1').par.lookAt.x",0),"aim.y":expressionSlot("op('cam1').par.lookAt.y",4.2),"aim.z":expressionSlot("op('cam1').par.lookAt.z",0),
      fov:expressionSlot("op('cam1').par.fov",50),exposure:1.1,haze:0.018,reflection:0.85,
      beatPulse:expressionSlot("clamp(op('detail1').chan.beatCount, 0, 1)",0),
      energy:expressionSlot(expansion,0), bass:expressionSlot("clamp(op('detail1').chan.kickCount * 0.8 + op('detail1').chan.beatCount * 0.2, 0, 1)",0),
      mids:expressionSlot("clamp(op('body1').chan.lowMid, 0, 1)",0),
      highs:expressionSlot("clamp(op('detail1').chan.hatCount * 0.8 + op('body1').chan.high * 0.2, 0, 1)",0),
      transient:expressionSlot("clamp(op('detail1').chan.snareCount * 0.7 + op('detail1').chan.onsetCount * 0.3, 0, 1)",0),
      atmosphere:expressionSlot("clamp(op('air1').chan.level * clamp(op('presence1').chan.level * 6, 0, 1), 0, 1)",0),
    }, {label:"room1",resolution:{mode:"project"}}),
    node("lens", "customWgsl", [500,0], {source:RESONANCE_DOF_WGSL,chromatic:expressionSlot("clamp(op('room1').par.energy * op('room1').par.energy * 0.4 + op('room1').par.transient * 0.2, 0, 0.65)",0),focusDistance:17.3,focusRange:5,strength:0.12,maxRadius:1.4,far:expressionSlot("op('cam1').par.far",100)}, {label:"lens1"}),
    node("bloom", "customWgsl", [500,-280], {source:RESONANCE_BLOOM_WGSL,threshold:0.9,strength:0.24}, {label:"bloom1",resolution:{mode:"scale",factor:0.5}}),
    node("blur", "blur", [800,-280], {size:16,filter:"gaussian",extend:"hold"}, {label:"blur1"}),
    node("glow", "add", [1100,0], {opacity:1}, {label:"glow1",resolution:{mode:"project"}}),
    node("fxaa", "customWgsl", [1400,0], {source:FXAA_WGSL,amount:1}, {label:"fxaa1",resolution:{mode:"project"}}),
    node("out", "output", [1700,0], {toneMap:"filmic"}, {label:"out1"}),
  ], [
    edge("park-panels",["envSeed","out"],["panelSource","inputs"],0),edge("camera-crop",["panelCam","out"],["cameraCrop","input"]),edge("camera-panels",["cameraCrop","out"],["panelSource","inputs"],1),edge("movie-crop",["panelMovie","out"],["movieCrop","input"]),edge("movie-panels",["movieCrop","out"],["panelSource","inputs"],2),
    edge("source-timewall",["panelSource","out"],["timeWall","picture"]),edge("timewall-pack",["timeWall","out"],["videoPack","input"]),
    edge("inner-grid",["innerGrid","out"],["innerFracture","in"]),edge("inner-shell",["innerFracture","out"],["innerShell","points"]),edge("inner-mirror",["innerFracture","out"],["innerMirror","in"]),edge("inner-reflected",["innerMirror","out"],["innerReflected","points"]),
    edge("inner-seams",["innerFracture","out"],["innerSeams","in"]),edge("inner-seam-light",["innerSeams","out"],["innerSeamLight","points"]),edge("inner-seam-mirror",["innerSeams","out"],["innerSeamMirror","in"]),edge("inner-seam-reflected",["innerSeamMirror","out"],["innerSeamReflection","points"]),edge("inner-roughness",["mineral","out"],["innerStone","roughness"]),
    edge("seed-mineral",["envSeed","out"],["mineral","input"]),edge("mineral-stone",["mineral","out"],["stone","roughness"]),
    edge("fracture-seams",["fracture","out"],["seams","in"]),edge("seams-light",["seams","out"],["seamLight","points"]),edge("seams-mirror",["seams","out"],["seamMirror","in"]),edge("seam-reflection",["seamMirror","out"],["seamReflection","points"]),
    edge("debris-dust",["debris","out"],["dust","points"]),edge("chip-grid",["chipGrid","out"],["chipForm","in"]),edge("debris-chips",["chipForm","out"],["chips","points"]),edge("debris-mirror",["chipForm","out"],["debrisMirror","in"]),edge("debris-mirror-chips",["debrisMirror","out"],["chipsMirror","points"]),
    edge("clip-analysis",["clip","out"],["analysis","audio"]),edge("clip-presence",["clip","out"],["presence","in"]),edge("analysis-body",["analysis","levels"],["body","in"]),edge("analysis-detail",["analysis","hits"],["detail","in"]),edge("analysis-air",["analysis","levels"],["air","in"]),
    edge("grid-fracture",["grid","out"],["fracture","in"]),edge("fracture-shell",["fracture","out"],["shell","points"]),
    edge("fracture-mirror",["fracture","out"],["mirror","in"]),edge("mirror-reflected",["mirror","out"],["reflected","points"]),
    edge("video-environment",["timeWall","out"],["environment","input"]),edge("environment-shot",["environment","out"],["shot","environment"]),
    edge("core-block-grid",["coreBlockGrid","out"],["coreBlockForm","in"]),edge("core-block-mesh",["coreBlockForm","out"],["coreBlock","points"]),edge("core-block-mirror",["coreBlockForm","out"],["coreMirrorForm","in"]),edge("core-block-reflected",["coreMirrorForm","out"],["coreMirrorBlock","points"]),
    edge("light-alpha",["lightShot","out"],["lightAlpha","in1"]),edge("light-color-depth",["lightAlpha","out"],["lightDepth","input"]),edge("light-depth",["lightShot","depth"],["lightDepth","mask"]),edge("light-pack",["lightDepth","out"],["lightPack","input"]),
    edge("shot-alpha",["shot","out"],["opaqueAlpha","in1"]),edge("color-depth",["opaqueAlpha","out"],["depthPack","input"]),edge("depth-pack",["shot","depth"],["depthPack","mask"]),edge("scene-pack",["depthPack","out"],["scenePack","input"]),edge("scene-atlas",["scenePack","out"],["sceneAtlas","in1"]),edge("video-atlas",["videoPack","out"],["sceneAtlas","in2"]),edge("atlas-light",["sceneAtlas","out"],["lightAtlas","in1"]),edge("light-atlas",["lightPack","out"],["lightAtlas","in2"]),edge("atlas-room",["lightAtlas","out"],["room","input"]),edge("room-lens",["room","out"],["lens","input"]),edge("lens-bloom",["lens","out"],["bloom","input"]),
    edge("bloom-blur",["bloom","out"],["blur","input"]),edge("blur-glow",["blur","out"],["glow","in1"]),edge("lens-glow",["lens","out"],["glow","in2"]),edge("glow-fxaa",["glow","out"],["fxaa","input"]),edge("fxaa-out",["fxaa","out"],["out","input"]),
  ]));

/** Split emitted light from surfaces while retaining per-fragment mesh occlusion. */
export function configureResonanceLightPass(doc: ProjectDocument): void {
  const { nodes, edges } = doc.graph;
  for (const id of Object.keys(nodes)) if (id.startsWith("lightOccluder_")) delete nodes[id];
  for (const id of Object.keys(edges)) if (id.startsWith("lightOccluder_")) delete edges[id];
  const opaque: string[] = [], emission: string[] = [], blockers: string[] = [];
  const scenes = String(nodes["shot"]!.parameters["scenes"]).split(/\s+/).filter(Boolean);
  for (const name of scenes) {
    const source = Object.values(nodes).find(n => n.label === name);
    if (source === undefined) throw new Error(`Resonance light pass cannot find ${name}`);
    if (source.parameters["blend"] === "additive") { emission.push(name); continue; }
    opaque.push(name);
    const id = `lightOccluder_${source.id}`;
    const label = `${id.toLowerCase()}1`;
    nodes[id] = {...structuredClone(source), id, label,
      position:{x:-6200,y:blockers.length*350},
      parameters:{...structuredClone(source.parameters),material:"lightblock1"}};
    for (const input of Object.values(edges).filter(e => e.target.nodeId === source.id)) {
      const key = `${id}_${input.id}`;
      edges[key] = {...structuredClone(input),id:key,target:{...input.target,nodeId:id}};
    }
    blockers.push(label);
  }
  if (nodes["coreBlock"] !== undefined) blockers.push("coreblock1", "coremirrorblock1");
  nodes["shot"]!.parameters["scenes"] = opaque.join(" ");
  nodes["lightShot"]!.parameters["scenes"] = [...blockers,...emission].join(" ");
}
configureResonanceLightPass(resonanceDocument);
