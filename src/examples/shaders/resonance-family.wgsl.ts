import { RESONANCE_ENV_WGSL, RESONANCE_ROOM_WGSL } from "./resonance.wgsl.ts";

export type ResonanceHallKind = "lotus" | "monoliths" | "orrery";
const PALETTE:Record<ResonanceHallKind,string>={lotus:"vec3f(0.34,0.68,0.46)",monoliths:"vec3f(0.85,0.38,0.14)",orrery:"vec3f(0.48,0.57,0.85)"};

function replaceExact(source:string,anchor:string,replacement:string,label:string):string{
  const first=source.indexOf(anchor);
  if(first<0||source.indexOf(anchor,first+anchor.length)>=0) throw new Error(`Resonance hall expected one ${label} anchor`);
  return source.slice(0,first)+replacement+source.slice(first+anchor.length);
}

const REFLECTED_CORE=`    let centreRef=vec3f(0,-5.6,0);
    let core=sphereHit(ro,mirrorRay,centreRef,1.0);
    if(core<reflectionDepth){
      let cp=ro+mirrorRay*core-centreRef;
      let internal=0.4+fbm(cp*4.0+vec3f(0,-frameU.absTime*0.3,0));
      reflectionDepth=core;
      reflected=coreColour(cp*vec3f(1,-1,1),mirrorRay*vec3f(1,-1,1))*(0.35+pow(clamp(params.energy,0.0,1.0),1.5)*9.0+params.transient*3.0+params.beatPulse*0.8)*internal;
    }`;
const PRIMARY_CORE=`    let core=sphereHit(ro,rd,CENTRE,1.0);
    if(core<min(hit.x,geometryDepth)){
      let cp=ro+rd*core-CENTRE;
      let pattern=fbm(cp*4.0+vec3f(0,frameU.absTime*0.3,0));
      color=coreColour(cp,rd)*(0.35+pow(clamp(params.energy,0.0,1.0),1.5)*9.0+params.transient*3.0+params.beatPulse*0.8)*(0.4+pattern);
      distance=core;
    }else if(geometryDepth<hit.x && shell.a<0.999){`;

interface HallShape{count:number;halfCount:string;step:string;panel:string;oculus:string;pedestal:string}
const SHAPES:Record<ResonanceHallKind,HallShape>={
  lotus:{count:28,halfCount:"14.0",step:"0.224399475",panel:"smoothstep(0.31,0.33,fraction)*(1.0-smoothstep(0.72,0.74,fraction))*smoothstep(1.35,1.55,p.y)*(1.0-smoothstep(12.35,12.55,p.y))",oculus:"6.75",pedestal:"3.35"},
  monoliths:{count:12,halfCount:"6.0",step:"0.523598776",panel:"smoothstep(0.16,0.18,fraction)*(1.0-smoothstep(0.84,0.86,fraction))*smoothstep(0.85,1.05,p.y)*(1.0-smoothstep(12.65,12.85,p.y))",oculus:"4.65",pedestal:"4.7"},
  orrery:{count:18,halfCount:"9.0",step:"0.349065850",panel:"smoothstep(panelLeft,panelLeft+0.02,fraction)*(1.0-smoothstep(0.98-panelLeft,1.0-panelLeft,fraction))*smoothstep(1.6,1.8,p.y)*(1.0-smoothstep(panelTop-0.2,panelTop,p.y))",oculus:"7.6",pedestal:"3.15"},
};

function architecture(source:string,kind:ResonanceHallKind):string{
  const shape=SHAPES[kind];
  let next=source.replace("fn paletteWarm()->vec3f {return resonancePalette(frameU.absTime,params.paletteCycle);}",`fn paletteWarm()->vec3f{return ${PALETTE[kind]};}`);
  next=next.replaceAll("let bay=angle*12.0/3.14159265;",`let bay=angle*${shape.halfCount}/3.14159265;`);
  next=next.replaceAll("for(var i=0;i<24;i++){\n    let angle=f32(i)*0.261799388;",`for(var i=0;i<${shape.count};i++){\n    let angle=f32(i)*${shape.step};`);
  next=next.replaceAll("let panel=smoothstep(0.25,0.27,fraction)*(1.0-smoothstep(0.81,0.83,fraction))*smoothstep(1.75,1.95,p.y)*(1.0-smoothstep(12.0,12.2,p.y));",`let panel=${shape.panel};`);
  next=next.replaceAll("length(p.xz)<2.8",`length(p.xz)<${shape.pedestal}`);
  next=next.replaceAll("2.8*2.8",`${shape.pedestal}*${shape.pedestal}`);
  next=next.replaceAll("radius=5.6",`radius=${shape.oculus}`);
  if(kind==="monoliths"){
    next=next.replaceAll(".xz)>=8.45", ".xz)>=7.15");
    next=next.replaceAll("col+=warm*line(r-2.74,0.014)*1.3;","col+=warm*(line(r-4.65,0.020)+line(r-4.05,0.012)+line(r-3.45,0.016))*1.6;");
    next=next.replaceAll("let engraving=line(r-1.95,0.009)+line(r-2.12,0.006)+line(r-2.43,0.009);","let engraving=line(r-4.42,0.012)+line(r-3.78,0.008)+line(r-3.16,0.012);");
    next=next.replaceAll("for(var tier=0; tier<4; tier++)","for(var tier=0; tier<2; tier++)");
    next=next.replaceAll("let rings=line(r-5.85,0.024)+line(r-6.40,0.014)+line(r-7.05,0.014)+line(r-7.70,0.014)+line(r-8.35,0.018);","let rings=line(r-4.65,0.035)+line(r-6.15,0.010);");
    next=next.replaceAll("col+=warm*rings*(1.2+params.atmosphere*0.8+params.highs*0.25+params.beatPulse*0.2);","col+=warm*rings*0.18*(1.2+params.atmosphere*0.8+params.highs*0.25+params.beatPulse*0.2);");
  }
  if(kind==="lotus") next=next.replaceAll("paletteWarm()*beam*8.0","paletteWarm()*beam*2.5");
  if(kind==="orrery"){
    next=next.replaceAll("13.0-p.y", "18.0-p.y");
    next=next.replaceAll("(13.0-ro.y)/rd.y","(18.0-ro.y)/rd.y");
    next=next.replaceAll("(15.0-ro.y)/rd.y","(21.0-ro.y)/rd.y");
    next=next.replaceAll("let level=14.4-f32(tier)*0.35;","let level=20.25-f32(tier)*0.56;");
    next=next.replaceAll("y>14.4 && y<15.0","y>20.25 && y<21.0");
    next=next.replaceAll("let upper=14.4-f32(tier)*0.35;","let upper=20.25-f32(tier)*0.56;");
    next=next.replaceAll("y>upper-0.35 && y<upper","y>upper-0.56 && y<upper");
    next=next.replaceAll("y<13.0","y<18.0");
    next=replaceExact(next,
      "let toplight=line(p.y-12.45,0.05)*smoothstep(0.04,0.15,seam);",
      `let panelTop=15.4+1.8*step(0.5,fract(floor(bay)/3.0));
    let panelLeft=0.16+0.09*step(0.5,fract(floor(bay)*0.5));
    let toplight=line(p.y-panelTop-0.28,0.05)*smoothstep(panelLeft-0.04,panelLeft,seam);`,
      "orrery elevated panel headers");
    next=next.replaceAll("fallingWater(localUv,panelId)","fallingWater(localUv*vec2f(0.55,0.6),panelId)");
    next=next.replaceAll("if(p.y<10.8 || p.y>15.0","if(p.y<16.2 || p.y>21.0");
    next=next.replaceAll("p.y-(13.35+curls*0.45)","p.y-(19.4+curls*0.65)");
  }
  // The environment and visible architecture share restrained fixture radiance.
  next=next.replaceAll("(line(p.y-13.1,0.018)+line(p.y-14.4,0.022))*2.2", "(line(p.y-13.1,0.018)+line(p.y-14.4,0.022))*0.18");
  next=next.replaceAll("let coveGain=0.9+params.atmosphere*0.7+sweep*0.4+params.beatPulse*0.18;", "let coveGain=0.24+params.atmosphere*0.16+sweep*0.12;");
  next=next.replaceAll("col+=warm*rings*(1.2+params.atmosphere*0.8+params.highs*0.25+params.beatPulse*0.2);", "col+=warm*rings*0.2;");
  next=next.replace("  let spill=2.0/(1.0+dot(p-CENTRE,p-CENTRE));", `
  if(id==6.0){
    let angle=atan2(p.x,p.z);
    col=vec3f(0.014,0.016,0.018)*(0.5+rock);
    col+=warm*0.15*pow(max(0.0,cos(angle*${kind==="monoliths"?"12.0":kind==="lotus"?"28.0":"18.0"})),32.0);
  }
  let spill=2.0/(1.0+dot(p-CENTRE,p-CENTRE));`);
  next=next.replaceAll("exp(-(13.0-p.y)*0.7)","exp(-max(13.0-p.y,0.0)*0.7)").replaceAll("exp(-(13.0-p.y)*0.6)","exp(-max(13.0-p.y,0.0)*0.6)");
  return next;
}

function replaceShafts(source:string,kind:ResonanceHallKind):string{
  const start=source.indexOf("  // Analytic Gaussian shafts avoid undersampling thin beams in the volume march.");
  const end=source.indexOf("  let vignette=",start);
  if(start<0||end<0) throw new Error(`Resonance hall expected shaft block for ${kind}`);
  const blocks:Record<ResonanceHallKind,string>={
    lotus:`  // Petal-shaped caustic curtains descend from the broad botanical oculus.
  for(var i=0u;i<24u;i++){
    let a=f32(i)*0.174532925+sin(frameU.absTime*0.11)*0.08;
    let blade=vec2f(cos(a),sin(a));let centre=blade*(1.2+f32(i%6u)*0.42);
    let origin=ro.xz-centre-blade*(ro.y-13.0)*0.045;let direction=rd.xz-blade*rd.y*0.045;
    let denom=dot(direction,direction);if(denom>0.00001){let t=-dot(origin,direction)/denom;let v=ro+rd*t;let d=length(origin+direction*t);
      if(t>0.0&&t<distance&&v.y>0.4&&v.y<15.0){let vein=0.4+0.6*pow(noise(vec3f(f32(i),v.y*4.0-frameU.absTime,9)),4.0);let pulse=0.08+params.energy*0.45+params.highs*0.18;color+=mix(paletteWarm(),vec3f(1),0.34)*exp(-d*d/0.008)*vein*pulse*0.025;}}
  }
`,
    monoliths:`  // Tectonic columns rise behind the stones while a survey laser crosses the chamber.
  for(var i=0u;i<5u;i++){
    let x=(f32(i)-2.0)*2.05;let origin=ro.xz-vec2f(x,-2.2);let direction=rd.xz;let denom=dot(direction,direction);
    if(denom>0.00001){let t=-dot(origin,direction)/denom;let v=ro+rd*t;let d=length(origin+direction*t);if(t>0.0&&t<distance&&v.y>0.2&&v.y<14.0){let surge=0.04+params.bass*0.55+params.transient*0.35;let dust=0.25+0.75*noise(vec3f(f32(i)*3.0,v.y*1.4-frameU.absTime*2.0,2));color+=mix(paletteWarm(),vec3f(1),0.28)*exp(-d*d/0.04)*dust*surge*0.09;}}
  }
  let laserHeight=3.1+sin(frameU.absTime*0.37)*1.4;let laser=exp(-abs((ro.y+rd.y*min(distance,20.0)*0.55)-laserHeight)/0.018)*(0.05+params.highs*0.55+params.transient*0.8);color+=paletteWarm()*laser*0.04;
`,
    orrery:`  // Three slow helical light ribbons trace the moving orbital planes in the taller vault.
  for(var i=0u;i<30u;i++){
    let band=f32(i%3u);let phase=f32(i)*0.62831853+frameU.absTime*(0.08+band*0.035);let radius=1.6+band*1.15;
    let centre=vec2f(cos(phase),sin(phase))*radius;let tilt=vec2f(cos(phase+1.5708),sin(phase+1.5708))*0.055;
    let origin=ro.xz-centre-tilt*(ro.y-18.0);let direction=rd.xz-tilt*rd.y;let denom=dot(direction,direction);
    if(denom>0.00001){let t=-dot(origin,direction)/denom;let v=ro+rd*t;let d=length(origin+direction*t);if(t>0.0&&t<distance&&v.y>0.4&&v.y<21.0){let pulse=0.08+params.energy*0.55+params.highs*0.4;color+=mix(paletteWarm(),vec3f(1),0.5)*exp(-d*d/0.012)*pulse*0.018;}}
  }
`,
  };
  return source.slice(0,start)+blocks[kind]+source.slice(end);
}

export function resonanceHallRoom(kind:ResonanceHallKind):string{
  let source=architecture(RESONANCE_ROOM_WGSL,kind);
  source=replaceExact(source,REFLECTED_CORE,"",`${kind} reflected core`);
  source=replaceExact(source,PRIMARY_CORE,"    if(geometryDepth<hit.x && shell.a<0.999){",`${kind} primary core`);
  return replaceShafts(source,kind);
}
export function resonanceHallEnvironment(kind:ResonanceHallKind):string{return architecture(RESONANCE_ENV_WGSL,kind);}
