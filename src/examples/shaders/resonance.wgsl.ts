import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/** Architecture and participating light around the rasterised, attribute-driven shell. */
const RESONANCE_ROOM_BINDINGS = `
${SHARED_UNIFORMS_WGSL}
struct Params {
  energy: f32, // @default 0 Shell energy.
  beatPulse: f32, // @default 0 Softened tempo pulse, independent of fragment travel.
  bass: f32, // @default 0 Floor pulse energy.
  mids: f32, // @default 0 Wall projection energy.
  highs: f32, // @default 0 Fine light and dust energy.
  transient: f32, // @default 0 Short internal light impulse.
  atmosphere: f32, // @default 0 Slow atmosphere envelope.
  eye: vec3f, // @default 0 2.6 17 Camera position shared with the geometry camera.
  aim: vec3f, // @default 0 4.2 0 Camera target shared with the geometry camera.
  far: f32, // @default 100 Camera far plane for the packed linear view depth.
  fov: f32, // @default 50 Vertical field of view in degrees.
  videoMotion: f32, // @default 0.6 Evolving luminous pattern over video.
  videoGlitch: f32, // @default 0.18 Bounded staggered scanline offsets.
  paletteCycle: f32, // @default 1 Slow amber, orange and violet lighting cycle.
  panelVideo: f32, // @default 0 1 projects the connected TimeGrid video cells.
  panelStyle: f32, // @default 0 0 slowly morphs; 1 water, 2 mineral, 3 caustics, 4 constellation.
  coreGradient: f32, // @default 0.65 Colour variation around the warm-white energy centre.
  projectionSeed: f32, // @default 75 Independent, reproducible wall-panel identities.
  panelSequence: f32, // @default 1 1 advances the bar scenes; 0 holds the selected scene.
  panelScene: f32, // @default 1 0 shared, 1 different, 2 alternating, 3 two-thirds, 4 dim, 5 low (dark when held).
  panelClock: f32, // @default 0 1 follows supplied musical bars; 0 uses the independent tempo clock.
  panelPosition: f32, // @default 0 Musical bar plus fractional bar phase, from the audio source.
  beatPosition: f32, // @default 0 Musical beat plus fractional beat phase.
  panelBpm: f32, // @default 112 Sequencer tempo; does not depend on detected audio.
  panelBars: f32, // @default 8 Four-beat bars per scene.
  panelFadeBars: f32, // @default 2 Crossfade length in bars, at the end of each scene.
  panelBrightness: f32, // @default 1 Master projection brightness.
  panelCoverage: f32, // @default 1 Fraction of bays allowed to light; fades by stable rank.
  panelVariety: f32, // @default 1 0 shares content, 1 gives each panel its own content.
  panelAudio: f32, // @default 0.35 Optional mid-band brightness influence; 0 is independent.
  exposure: f32, // @default 1 Scene radiance multiplier.
  haze: f32, // @default 0.045 Scattering density.
  reflection: f32, // @default 0.65 Floor polish.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
`;

const RESONANCE_ARCHITECTURE_WGSL = `
fn paletteWarm()->vec3f {
  let phase=frameU.absTime/36.0;
  let part=u32(floor(phase))%3u;
  let colours=array<vec3f,3>(vec3f(1.0,0.69,0.39),vec3f(1.0,0.29,0.065),vec3f(0.57,0.28,1.0));
  return mix(colours[0],mix(colours[part],colours[(part+1u)%3u],smoothstep(0.15,0.85,fract(phase))),clamp(params.paletteCycle,0.0,1.0));
}
const CENTRE = vec3f(0,5.6,0);
fn hash(p: vec3f) -> f32 { return fract(sin(dot(p,vec3f(127.1,311.7,74.7)))*43758.5453); }
fn noise(p: vec3f) -> f32 {
  let i=floor(p); let f=fract(p); let u=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i),hash(i+vec3f(1,0,0)),u.x),mix(hash(i+vec3f(0,1,0)),hash(i+vec3f(1,1,0)),u.x),u.y),
  mix(mix(hash(i+vec3f(0,0,1)),hash(i+vec3f(1,0,1)),u.x),mix(hash(i+vec3f(0,1,1)),hash(i+vec3f(1,1,1)),u.x),u.y),u.z);
}
fn fbm(p:vec3f)->f32 {return noise(p)*0.55+noise(p*2.03)*0.27+noise(p*4.11)*0.12+noise(p*8.23)*0.06;}
fn energyGradient(p:vec3f)->vec3f {
  let height=smoothstep(-1.3,1.3,p.y-CENTRE.y);
  return mix(vec3f(1.0,0.26,0.06),vec3f(0.34,0.42,1.0),height);
}
fn coreColour(local:vec3f,ray:vec3f)->vec3f {
  let facing=pow(max(0.0,dot(normalize(local),-ray)),5.0);
  let edge=mix(paletteWarm(),energyGradient(local+CENTRE),clamp(params.coreGradient,0.0,1.0));
  return mix(edge,vec3f(1.0,0.91,0.73),facing*0.88);
}
fn line(x:f32,width:f32)->f32 {return exp(-abs(x)/width);}
// Analytic room intersections: x is distance, y is surface identity.
fn roomHit(ro:vec3f,rd:vec3f)->vec2f {
  var hit=vec2f(1000,0);
  if(rd.y < -0.00001) {hit=vec2f(-ro.y/rd.y,1);}
  if(rd.y > 0.00001) {
    let t=(13.0-ro.y)/rd.y;
    if(length((ro+rd*t).xz)>=8.45){hit=vec2f(t,2);}
    let roof=(15.0-ro.y)/rd.y;
    if(length((ro+rd*roof).xz)<5.85){hit=vec2f(roof,2);}
    for(var tier=0; tier<4; tier++) {
      let inner=5.85+f32(tier)*0.65;
      let level=14.4-f32(tier)*0.35;
      let distance=(level-ro.y)/rd.y;
      let radius=length((ro+rd*distance).xz);
      if(distance>0.0 && distance<hit.x && radius>=inner && radius<inner+0.65){hit=vec2f(distance,2);}
    }
  }
  let a=dot(rd.xz,rd.xz); let b=dot(ro.xz,rd.xz); let c=dot(ro.xz,ro.xz)-361.0;
  let d=b*b-a*c;
  if(d>0.0 && a>0.00001){let t=(-b+sqrt(d))/a;if(t>0.0 && t<hit.x){hit=vec2f(t,3);}}
  // Low pedestal: the full protected explosion envelope is above this.
  if(rd.y < -0.00001){let t=(0.32-ro.y)/rd.y;let p=ro+rd*t;if(t>0 && t<hit.x && length(p.xz)<2.8){hit=vec2f(t,4);}}
  let bp=dot(ro.xz,rd.xz); let cp=dot(ro.xz,ro.xz)-2.8*2.8;let dp=bp*bp-a*cp;
  if(dp>0 && a>0.00001){let t=(-bp-sqrt(dp))/a;let y=ro.y+rd.y*t;if(t>0 && t<hit.x && y>=0 && y<0.32){hit=vec2f(t,5);}}
  // Peripheral audience terraces leave the central explosion volume unobstructed.
  for(var stepIndex=0;stepIndex<4;stepIndex++){
    let radius=13.0+f32(stepIndex)*1.4;
    let top=0.25*f32(stepIndex+1);
    if(rd.y< -0.00001){let t=(top-ro.y)/rd.y;let q=ro+rd*t;if(t>0 && t<hit.x && length(q.xz)>radius && q.z<2.0){hit=vec2f(t,8);}}
    let disc=b*b-a*(dot(ro.xz,ro.xz)-radius*radius);
    if(disc>0 && a>0.00001){let t=(-b+sqrt(disc))/a;let y=ro.y+rd.y*t;if(t>0 && t<hit.x && y>top-0.25 && y<top && (ro+rd*t).z<2.0){hit=vec2f(t,8);}}
  }
  // Deep oculus reveal, between the main ceiling and its recessed upper aperture.
  let innerD=b*b-a*(dot(ro.xz,ro.xz)-5.85*5.85);
  if(innerD>0.0 && a>0.00001){
    let t=(-b+sqrt(innerD))/a;let y=ro.y+rd.y*t;
    if(t>0.0 && t<hit.x && y>14.4 && y<15.0){hit=vec2f(t,6);}
  }
  // Vertical bronze risers separate the recessed ceiling tiers.
  for(var tier=0; tier<4; tier++) {
    let radius=6.5+f32(tier)*0.65;
    let upper=14.4-f32(tier)*0.35;
    let disc=b*b-a*(dot(ro.xz,ro.xz)-radius*radius);
    if(disc>0.0 && a>0.00001){
      let t=(-b+sqrt(disc))/a;let y=ro.y+rd.y*t;
      if(t>0.0 && t<hit.x && y>upper-0.35 && y<upper){hit=vec2f(t,6);}
    }
  }
  // Structural wall piers project into the room; they are not painted stripes.
  for(var i=0;i<24;i++){
    let angle=f32(i)*0.261799388;
    let centre=vec2f(sin(angle),cos(angle))*18.65;
    let delta=ro.xz-centre;let pb=dot(delta,rd.xz);
    let pd=pb*pb-a*(dot(delta,delta)-0.32*0.32);
    if(pd>0.0 && a>0.00001){let t=(-pb-sqrt(pd))/a;let y=ro.y+t*rd.y;if(t>0.0 && t<hit.x && y>0.0 && y<13.0){hit=vec2f(t,7);}}
  }
  return hit;
}

fn projectionFamily(kind:u32,uv:vec2f,seed:f32,clock:f32)->vec3f {
  let p=vec3f(uv.x*8.0,uv.y*0.65+clock,seed*43.0);
  if(kind==0u){
    let warp=vec3f(fbm(p*0.8),noise(p*0.7+19.0),noise(p*0.6+37.0));
    let cloud=fbm(p*1.2+warp*2.8);
    let threads=pow(1.0-abs(2.0*noise(p*vec3f(6,0.7,3)+warp*3.0)-1.0),12.0);
    let foam=pow(noise(p*vec3f(12,5,9)+warp*4.0),4.0);
    let fine=pow(noise(p*vec3f(35,15,23)),5.0);
    return vec3f(0.42,0.49,0.56)*(0.04+threads*0.3+foam*1.5+fine*0.7)*smoothstep(0.25,0.8,cloud);
  }
  if(kind==1u){
    let stone=vec3f(uv.x*10.0,uv.y*0.9,seed*31.0+clock*0.07);
    let domain=fbm(stone*0.8);
    let veins=pow(1.0-abs(2.0*fbm(stone*1.7+domain*4.0)-1.0),20.0);
    let strata=0.5+0.5*sin(uv.y*2.1+domain*13.0+clock*0.12);
    return vec3f(0.15,0.18,0.20)*domain*0.08+mix(vec3f(0.40,0.50,0.48),vec3f(0.65,0.38,0.17),strata)*veins*0.5;
  }
  if(kind==2u){
    let sheet=vec2f(uv.x*11.0,uv.y*0.9);
    let bend=sin(sheet.y*1.2+clock*0.35+seed*9.0)*1.3;
    let crossing=sin(sheet.x*1.8+bend+clock*0.2)*sin(sheet.y*1.1-sheet.x*0.7-clock*0.25);
    let caustic=pow(1.0-abs(crossing),18.0);
    let envelope=0.25+0.75*noise(vec3f(sheet*0.6,clock*0.12+seed*31.0));
    return mix(vec3f(0.16,0.36,0.43),vec3f(0.55,0.62,0.65),caustic)*caustic*envelope*0.4;
  }
  let grid=vec2f(uv.x*28.0,uv.y*3.5+clock*0.25);
  let cell=floor(grid);let local=fract(grid);
  let h=hash(vec3f(cell,seed*31.0));
  let centre=vec2f(0.2+0.6*h,0.2+0.6*hash(vec3f(cell,seed*47.0)));
  let d=dot(local-centre,local-centre);
  let star=(exp(-d*150.0)+exp(-d*16.0)*0.06)*smoothstep(0.66,0.9,h);
  let ribbon=pow(0.5+0.5*sin(uv.x*18.0+sin(uv.y*0.7+clock*0.2)*2.5+seed*7.0),16.0)*0.025;
  return vec3f(0.37,0.44,0.64)*(star*0.85+ribbon);
}
fn panelContent(localUv:vec2f,panelId:f32)->vec3f {
  if(params.panelVideo>0.5){
    // Each architectural bay samples one complete delayed cell, never a strip across cells.
    let cell=u32(panelId)%24u;
    let corner=vec2f(f32(cell%12u),f32(cell/12u));
    let panelUv=vec2f(localUv.x/0.58,1.0-(localUv.y-1.75)/10.45);
    // TimeGrid's 12x2 cells are portrait crops: (512/288)*(2/12).
    // The physical bay is (19*pi/12*0.58) / 10.45 wide/high.
    let crop=vec2f(0.9315,1.0);
    let cadence=frameU.absTime*max(params.panelBpm,1.0)/30.0;
    let stagger=f32(cell%8u)/8.0;
    let tick=cadence-stagger;
    let phase=fract(tick);
    let accent=exp(-phase*9.0);
    let identity=hash(vec3f(f32(cell),params.projectionSeed,61));
    let scan=exp(-pow((panelUv.y-fract(frameU.absTime*0.075+identity))/0.04,2.0));
    let slice=step(0.76,sin(panelUv.y*71.0+floor(tick)*2.3));
    let tear=select(0.0,1.0,(u32(max(floor(tick),0.0))+cell)%7u==0u);
    let shift=vec2f(slice*tear*accent*params.videoGlitch*0.045,0);
    let local=clamp(vec2f(0.5)+(panelUv-0.5)*crop+shift,vec2f(0.025),vec2f(0.975));
    let uv=(corner+local)/vec2f(12,2);
    let centre=dot(panelVideoAt(uv),vec3f(0.2126,0.7152,0.0722));
    let dx=dot(panelVideoAt((corner+clamp(local+vec2f(0.018,0),vec2f(0.025),vec2f(0.975)))/vec2f(12,2)),vec3f(0.2126,0.7152,0.0722))-centre;
    let dy=dot(panelVideoAt((corner+clamp(local+vec2f(0,0.018),vec2f(0.025),vec2f(0.975)))/vec2f(12,2)),vec3f(0.2126,0.7152,0.0722))-centre;
    let luminance=pow(max(centre,0.0),0.55);
    let contour=pow(1.0-abs(fract(luminance*7.0)*2.0-1.0),10.0)*smoothstep(0.035,0.12,luminance);
    let edges=smoothstep(0.008,0.11,length(vec2f(dx,dy)));
    let body=smoothstep(0.07,0.65,luminance)*0.16;
    let ribbons=pow(0.5+0.5*sin(panelUv.x*13.0+sin(panelUv.y*8.0-frameU.absTime*0.4+identity*6.0)*2.0),12.0);
    let overlay=(scan*0.13+ribbons*0.065)*(0.55+accent*0.45)*params.videoMotion;
    let grade=mix(paletteWarm(),vec3f(1),0.06);
    return grade*((body+edges*0.65+contour*0.25)*(0.88+accent*0.18)+overlay);
  }
  let seed=hash(vec3f(panelId,params.projectionSeed,11));
  let identity=hash(vec3f(panelId,params.projectionSeed,37));
  let clock=frameU.absTime*(0.26+seed*0.43);
  let phase=frameU.absTime*0.035+identity*4.0;
  let selected=u32(clamp(floor(params.panelStyle),0.0,4.0));
  let first=select(u32(floor(phase))%4u,selected-1u,selected>0u);
  let next=select((first+1u)%4u,first,selected>0u);
  let blend=select(smoothstep(0.25,0.85,fract(phase)),0.0,selected>0u);
  var projected=projectionFamily(first,localUv,seed,clock);
  if(blend>0.0){projected=mix(projected,projectionFamily(next,localUv,seed,clock),blend);}
  let footlight=0.4+1.0*exp(-max(localUv.y-1.75,0.0)*0.7);
  return mix(projected,projected*paletteWarm()*1.25,params.paletteCycle*0.55)*(0.5+identity)*footlight;
}
fn panelSceneState(panelId:f32,scene:u32)->vec3f {
  // Opacity, independent-content share, brightness. No configuration changes texture time.
  if(scene==0u){return vec3f(1,0,1);}
  if(scene==1u){return vec3f(1,1,1);}
  if(scene==2u){return vec3f(select(0.0,1.0,u32(panelId)%2u==0u),1,1);}
  if(scene==3u){return vec3f(select(0.0,1.0,(u32(panelId)+u32(params.projectionSeed))%3u!=0u),1,1);}
  if(scene==4u){return vec3f(1,0,0.22);}
  return vec3f(1,1,select(0.0,0.18,params.panelSequence>0.5));
}
fn panelLight(localUv:vec2f,panelId:f32)->vec3f {
  let selected=u32(clamp(floor(params.panelScene),0.0,5.0));
  let period=max(params.panelBars,0.25)*4.0*60.0/max(params.panelBpm,1.0);
  let phase=select(frameU.absTime/period,params.panelPosition/max(params.panelBars,0.25),params.panelClock>0.5);
  let automatic=params.panelSequence>0.5;
  let current=(selected+select(0u,u32(floor(phase)),automatic))%6u;
  let following=select(current,(current+1u)%6u,automatic);
  let fadeFraction=clamp(params.panelFadeBars/max(params.panelBars,0.25),0.01,1.0);
  let blend=select(0.0,smoothstep(1.0-fadeFraction,1.0,fract(phase)),automatic);
  let previousState=panelSceneState(panelId,current);
  let to=panelSceneState(panelId,following);
  let variety=clamp(params.panelVariety,0.0,1.0);
  let firstVisible=previousState.x*previousState.z>0.0;
  let secondVisible=to.x*to.z>0.0;
  if(!firstVisible && !secondVisible){return vec3f(0);}
  var sharedContent=vec3f(0);var distinct=vec3f(0);
  if((firstVisible && previousState.y*variety<1.0) || (secondVisible && to.y*variety<1.0)){sharedContent=panelContent(localUv,0.0);}
  if((firstVisible && previousState.y*variety>0.0) || (secondVisible && to.y*variety>0.0)){distinct=panelContent(localUv,panelId+1.0);}
  let first=mix(sharedContent,distinct,previousState.y*variety)*previousState.x*previousState.z;
  let second=mix(sharedContent,distinct,to.y*variety)*to.x*to.z;
  let rank=hash(vec3f(panelId,params.projectionSeed,97))*0.9;
  let coverage=smoothstep(rank,rank+0.1,clamp(params.panelCoverage,0.0,1.0));
  let brightness=max(params.panelBrightness,0.0)*(0.75+params.panelAudio*params.mids*0.75);
  return mix(first,second,blend)*coverage*brightness;
}

fn surface(p:vec3f,rd:vec3f,id:f32)->vec3f {
  let r=length(p.xz);
  let rock=fbm(p*2.3);
  let fine=noise(p*51.0);
  let warm=paletteWarm();
  var col=vec3f(0.014,0.013,0.012)*(0.6+rock);
  if(id==8.0){
    col=vec3f(0.007,0.008,0.01)*(0.6+rock);
    let seam=abs(fract((r-13.0)/1.4+0.5)-0.5);
    col+=paletteWarm()*line(seam,0.007)*line(fract(p.y*4.0),0.04)*0.08;
    let angle=atan2(p.x,p.z);
    let fixture=pow(max(0.0,cos(angle*24.0)),110.0);
    col+=paletteWarm()*fixture*line(p.y-0.75,0.05)*0.8;
  } else if(id==6.0){
    col=vec3f(0.032,0.021,0.012)*(0.4+rock);
    col+=paletteWarm()*(line(p.y-13.1,0.018)+line(p.y-14.4,0.022))*2.2;
    col*=0.5+0.5*smoothstep(0.01,0.05,abs(sin(atan2(p.x,p.z)*28.0)));
  } else if(id==7.0){
    col=vec3f(0.006,0.006,0.007)*(0.5+rock);
    col+=paletteWarm()*0.025*exp(-(13.0-p.y)*0.5)*(0.2+fine);
    col+=paletteWarm()*0.018*exp(-p.y*1.2);
  } else if(id==3.0){
    let angle=atan2(p.x,p.z);
    let bay=angle*12.0/3.14159265;
    let fraction=fract(bay);
    let seam=min(fraction,1.0-fraction);
    let pillar=1.0-smoothstep(0.04,0.14,seam);
    let mineral=fbm(p*vec3f(7.0,0.65,7.0));
    let strata=pow(1.0-abs(2.0*noise(p*vec3f(18.0,1.2,18.0)+mineral*3.0)-1.0),10.0);
    let illumination=0.12+0.9*exp(-(13.0-p.y)*0.7)+0.5*exp(-p.y*1.3);
    col=vec3f(0.018,0.016,0.014)*(0.3+rock*0.8)*(1.0-0.7*pillar)*illumination;
    let toplight=line(p.y-12.45,0.05)*smoothstep(0.04,0.15,seam);
    let fixture=hash(vec3f(floor(bay),2,7));
    let stripHeight=smoothstep(0.6+fixture*2.0,1.3+fixture*2.0,p.y)*(1.0-smoothstep(5.0+fixture*5.0,6.0+fixture*5.0,p.y));
    let strip=line(fraction-0.12,0.0018)*stripHeight;
    // A slow architectural chase is separate from the percussion accents.
    let lightPhrase=frameU.absTime*max(params.panelBpm,1.0)/60.0*0.19634954;
    let sweep=pow(0.5+0.5*sin(lightPhrase-floor(bay)*0.7),3.0);
    let stripGain=0.22+sweep*1.5+params.transient*(0.3+fixture*0.7);
    let coveGain=0.9+params.atmosphere*0.7+sweep*0.4+params.beatPulse*0.18;
    col+=warm*(toplight*coveGain+strip*stripGain);
    // The moving fixtures illuminate the adjacent stone, including its reflection environment.
    let stripWash=exp(-abs(fraction-0.12)*32.0)*stripHeight;
    col+=warm*stripWash*stripGain*0.055*(0.25+mineral+strata);
    col+=warm*0.065*coveGain*exp(-(13.0-p.y)*0.6)*(0.1+mineral*0.7+strata*1.2);
    col+=vec3f(0.014,0.016,0.018)*strata*illumination;
    col+=warm*0.16*exp(-p.y*0.65)*pow(max(0.0,cos(fraction*6.2831853)),6.0);
    let panelId=floor(bay)+12.0;
    let panel=smoothstep(0.25,0.27,fraction)*(1.0-smoothstep(0.81,0.83,fraction))*smoothstep(1.75,1.95,p.y)*(1.0-smoothstep(12.0,12.2,p.y));
    if(panel>0.0){col+=panel*panelLight(vec2f(fraction-0.25,p.y),panelId);}
    col*=0.8+0.3*fine;
    let footing=1.0-smoothstep(0.65,0.85,p.y);
    col=mix(col,vec3f(0.008,0.007,0.006)*(0.5+rock),footing);
    col+=paletteWarm()*line(p.y-0.22,0.025)*0.6;

  } else if(id==2.0){
    col=vec3f(0.012,0.008,0.005)*(0.55+rock);
    let aperture=smoothstep(5.7,5.85,r);
    col*=aperture;
    let rings=line(r-5.85,0.024)+line(r-6.40,0.014)+line(r-7.05,0.014)+line(r-7.70,0.014)+line(r-8.35,0.018);
    col+=warm*rings*(1.2+params.atmosphere*0.8+params.highs*0.25+params.beatPulse*0.2);
    col+=warm*0.12*line(r-6.0,0.55);
    let radial=abs(sin(atan2(p.x,p.z)*32.0));
    col*=0.3+0.7*smoothstep(0.01,0.08,radial);
  } else if(id==1.0){
    let course=floor(p.z/1.4);
    let joints=abs(fract(vec2f((p.x+select(0.0,0.55,i32(course)%2==0))/1.1,p.z/1.4)+0.5)-0.5);
    let slab=min(joints.x,joints.y);
    let slabId=vec3f(floor((p.x+select(0.0,0.55,i32(course)%2==0))/1.1),course,17);
    let stoneVeins=pow(1.0-abs(2.0*fbm(p*2.7+rock*4.0)-1.0),12.0);
    col=vec3f(0.014,0.012,0.010)*(0.35+rock+stoneVeins*0.7)*(0.6+hash(slabId)*0.8)*smoothstep(0.002,0.012,slab);
    let rings=line(r-3.4,0.018)+line(r-3.8,0.025)+line(r-4.8,0.018)+line(r-4.95,0.012);
    let wave=pow(max(0.0,sin(r*3.4-params.beatPosition*6.2831853)),18.0)*exp(-max(r-3.0,0.0)*0.5);
    let strike=pow(clamp(params.bass,0.0,1.0),1.5);
    col+=warm*rings*(0.35+strike*11.0);
    let ringFront=3.0+fract(params.beatPosition)*4.5;
    let travelling=exp(-pow((r-ringFront)/0.15,2.0))*smoothstep(2.8,3.2,r)*(1.0-smoothstep(6.2,7.5,r));
    col+=warm*(wave*0.35+travelling*1.4)*strike;
  } else {
    col=vec3f(0.024,0.017,0.01)*(0.5+rock)+warm*0.012;
    if(id==4.0){col+=warm*line(r-2.74,0.014)*1.3;}
    if(id==5.0){col+=warm*line(p.y-0.28,0.014)*2.0;col*=0.55+fine*0.45;}
  }
  let spill=2.0/(1.0+dot(p-CENTRE,p-CENTRE));
  col+=warm*spill*(0.1+params.energy*0.25)*rock;
  return col;
}
`;

export const RESONANCE_ROOM_WGSL = `
${RESONANCE_ROOM_BINDINGS}
fn panelVideoAt(uv:vec2f)->vec3f {return textureSampleLevel(inputTexture,inputSampler,vec2f(0.5,0)+uv*0.5,0.0).rgb;}
${RESONANCE_ARCHITECTURE_WGSL}
fn sphereHit(ro:vec3f,rd:vec3f,centre:vec3f,r:f32)->f32 {
  let oc=ro-centre;let b=dot(oc,rd);let d=b*b-dot(oc,oc)+r*r;
  if(d<0.0){return 1000.0;}let t=-b-sqrt(d);return select(1000.0,t,t>0.0);
}
fn capsuleHit(ro:vec3f,rd:vec3f,a:vec3f,b:vec3f,r:f32)->f32 {
  let ba=b-a;let oa=ro-a;let baba=dot(ba,ba);let bard=dot(ba,rd);let baoa=dot(ba,oa);
  let k2=baba-bard*bard;let k1=baba*dot(oa,rd)-baoa*bard;
  let k0=baba*dot(oa,oa)-baoa*baoa-r*r*baba;let h=k1*k1-k2*k0;
  if(h>0.0 && abs(k2)>0.00001){let t=(-k1-sqrt(h))/k2;let y=baoa+t*bard;if(t>0.0 && y>0.0 && y<baba){return t;}}
  return min(sphereHit(ro,rd,a,r),sphereHit(ro,rd,b,r));
}
// Elliptical tapered clothing volumes retain angular hems and shoulders in silhouette.
fn coatHit(ro:vec3f,rd:vec3f,base:vec3f,bottom:f32,top:f32,hem:f32,shoulder:f32)->f32 {
  let o=(ro-base)*vec3f(1,1,1.5);let d=rd*vec3f(1,1,1.5);
  let slope=(shoulder-hem)/(top-bottom);
  let radius=hem+slope*(o.y-bottom);
  let a=dot(d.xz,d.xz)-slope*slope*d.y*d.y;
  let b=dot(o.xz,d.xz)-radius*slope*d.y;
  let c=dot(o.xz,o.xz)-radius*radius;
  let discriminant=b*b-a*c;
  var hit=1000.0;
  if(discriminant>=0.0 && abs(a)>0.000001){
    let t=(-b-sqrt(discriminant))/a;
    let y=o.y+t*d.y;
    if(t>0.0 && y>=bottom && y<=top){hit=t;}
  }
  if(abs(d.y)>0.000001){
    let lower=(bottom-o.y)/d.y;let upper=(top-o.y)/d.y;
    if(lower>0.0 && length((o+d*lower).xz)<hem){hit=min(hit,lower);}
    if(upper>0.0 && length((o+d*upper).xz)<shoulder){hit=min(hit,upper);}
  }
  return hit;
}
fn audience(ro:vec3f,rd:vec3f)->f32 {
  var closest=1000.0;
  for(var i=0u;i<29u;i++){
    let h=hash(vec3f(f32(i),13,2));
    let a=f32(i)*2.39996;
    let r=10.0+6.0*h;
    let terrace=select(0.0,0.25*clamp(floor((r-13.0)/1.4+1.0),0.0,4.0),sin(a)*r<2.0);
    var base=vec3f(cos(a)*r,terrace,sin(a)*r);
    if(i==27u){base=vec3f(-4.7,0,9.6);}
    if(i==28u){base=vec3f(4.9,0,10.4);}
    if(i<27u && base.z>6.0 && abs(base.x)<8.0){continue;}
    // Conservative body bound rejects pixels outside this person's entire silhouette.
    let boundOffset=ro-(base+vec3f(0,0.9,0));
    let boundAlong=dot(boundOffset,rd);
    if(boundAlong*boundAlong-dot(boundOffset,boundOffset)+1.21<0.0){continue;}
    let height=1.35+h*0.43;
    closest=min(closest,sphereHit(ro,rd,base+vec3f(0,height,0),0.085));
    let longCoat=i>=27u || h>0.65;
    closest=min(closest,coatHit(ro,rd,base,select(0.68,0.33,longCoat),height-0.18,select(0.14,0.23,longCoat),0.17));
    closest=min(closest,capsuleHit(ro,rd,base+vec3f(0,height-0.18,0),base+vec3f(0,height-0.08,0),0.05));
    closest=min(closest,capsuleHit(ro,rd,base+vec3f(-0.18,height-0.27,0),base+vec3f(-0.22,0.76,0.02),0.055));
    closest=min(closest,capsuleHit(ro,rd,base+vec3f(0.18,height-0.27,0),base+vec3f(0.24,0.80,0.04),0.055));
    closest=min(closest,capsuleHit(ro,rd,base+vec3f(-0.09,0.06,0.03),base+vec3f(-0.07,0.73,0),0.055));
    closest=min(closest,capsuleHit(ro,rd,base+vec3f(0.10,0.06,-0.03),base+vec3f(0.07,0.73,0),0.055));
  }
  return closest;
}
fn sceneAt(uv:vec2f)->vec4f {
  let dimensions=textureDimensions(inputTexture);
  let pixel=clamp(vec2i(uv*vec2f(dimensions)*0.5),vec2i(0),vec2i(dimensions/2u)-1);
  // Colour may interpolate; depth must not invent a surface between front and back faces.
  let colour=textureSampleLevel(inputTexture,inputSampler,clamp(uv*0.5,0.5/vec2f(dimensions),vec2f(0.5)-0.5/vec2f(dimensions)),0.0).rgb;
  let depth=textureLoad(inputTexture,pixel,0).a;
  return vec4f(colour,depth);
}
@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {
  let forward=normalize(params.aim-params.eye);
  let right=normalize(cross(forward,vec3f(0,1,0)));let up=cross(right,forward);
  let screen=vec2f(uv.x*2.0-1.0,1.0-uv.y*2.0);
  let aspect=frameU.resolution.x/frameU.resolution.y;
  let rd=normalize(forward+(right*screen.x*aspect+up*screen.y)*tan(params.fov*0.0087266463));
  let ro=params.eye;let hit=roomHit(ro,rd);let p=ro+rd*hit.x;
  var color=surface(p,rd,hit.y);
  var shell=sceneAt(uv);
  let geometryDepth=shell.a*params.far/max(dot(rd,forward),0.0001);
  var visibleGeometry=false;
  var distance=hit.x;
  let floor=hit.y==1.0;
  if(floor){
    let rough=fbm(p*vec3f(4.0,1.0,18.0));
    let ripple=p*vec3f(1.8,1,5.5);
    let slopeX=(noise(ripple+vec3f(0.08,0,0))-noise(ripple-vec3f(0.08,0,0)))*0.06;
    let slopeZ=(noise(ripple+vec3f(0,0,0.08))-noise(ripple-vec3f(0,0,0.08)))*0.05;
    let micro=noise(p*vec3f(15,1,21))-0.5;
    let normal=normalize(vec3f(slopeX+micro*0.01,1,slopeZ+micro*0.012));
    let refl=reflect(rd,normal);let rh=roomHit(p+vec3f(0,0.003,0),refl);
    var reflected=surface(p+refl*rh.x,refl,rh.y);
    if(audience(p+vec3f(0,0.003,0),refl)<rh.x){reflected=vec3f(0.003);}
    let fresnel=0.20+0.80*pow(1.0-abs(rd.y),5.0);
    let wet=0.12+0.88*smoothstep(0.35,0.68,fbm(p*vec3f(0.5,1,1.3)));
    color+=reflected*params.reflection*fresnel*wet;
    let toLight=normalize(CENTRE-p);
    let halfway=normalize(toLight-rd);
    let polish=pow(max(0.0,dot(normal,halfway)),220.0);
    let smear=pow(max(0.0,dot(normal,halfway)),35.0);
    color+=paletteWarm()*(polish*4.5+smear*0.12)*(0.4+params.energy)*wet;
    let vein=pow(1.0-abs(sin(fbm(p*1.3)*23.0)),18.0);
    color+=vec3f(0.014)*vein*(0.5+noise(p*30.0));
    let distorted=uv+vec2f(slopeX*0.14,slopeZ*0.12);
    shell=sceneAt(distorted);
    let reflectedDepth=shell.a*params.far/max(dot(rd,forward),0.0001);
    let centreRef=vec3f(0,-5.6,0);
    let core=sphereHit(ro,rd,centreRef,1.0);
    if(core<reflectedDepth){
      let cp=ro+rd*core-centreRef;
      let internal=0.4+fbm(cp*4.0+vec3f(0,-frameU.absTime*0.3,0));
      color+=coreColour(cp*vec3f(1,-1,1),rd*vec3f(1,-1,1))*(0.35+pow(clamp(params.energy,0.0,1.0),1.5)*9.0+params.transient*3.0+params.beatPulse*0.8)*internal*params.reflection*fresnel*wet;
    }else if(shell.a<0.999){
      color+=shell.rgb*params.reflection*fresnel*wet;
    }
  }else{
    let core=sphereHit(ro,rd,CENTRE,1.0);
    if(core<min(hit.x,geometryDepth)){
      let cp=ro+rd*core-CENTRE;
      let pattern=fbm(cp*4.0+vec3f(0,frameU.absTime*0.3,0));
      color=coreColour(cp,rd)*(0.35+pow(clamp(params.energy,0.0,1.0),1.5)*9.0+params.transient*3.0+params.beatPulse*0.8)*(0.4+pattern);
      distance=core;
    }else if(geometryDepth<hit.x && shell.a<0.999){
      color=shell.rgb;
      distance=geometryDepth;
      visibleGeometry=true;
    }
  }
  let person=audience(ro,rd);
  if(person<distance){color=vec3f(0.006,0.005,0.004);distance=person;}
  // Single scattering integrated along the visible ray, stopped by opaque geometry.
  let dt=min(distance,45.0)/40.0;
  var scatter=vec3f(0);var transmission=1.0;
  for(var i=0u;i<40u;i++){
    let t=(f32(i)+0.5)*dt;let v=ro+rd*t;
    let radial=length(v.xz);
    let fog=params.haze*(0.45+params.atmosphere*0.6)*(0.55+0.45*noise(v*0.4+vec3f(frameU.absTime*0.03,0,0)));
    var beam=0.0;
    if(radial<5.0){
      let shaftShape=exp(-radial*radial*0.16)*(1.0-smoothstep(4.0,5.0,radial));
      let curtains=0.55+0.45*noise(vec3f(v.x*1.6,v.y*0.22-frameU.absTime*0.09,v.z*1.6));
      beam=shaftShape*curtains*(0.008+params.energy*params.energy*0.22)*(0.6+params.highs)*smoothstep(0.1,1.2,v.y);
    }
    let toCore=length(v-CENTRE);
    let glow=(0.035+params.energy*params.energy*7.0+params.transient*1.5)*exp(-toCore*0.3)/(0.3+toCore*toCore);
    // Local fog occupies small volumes. Do not evaluate its octave noise throughout the hall.
    var groundFog=0.0;
    if(v.y<3.5){groundFog=exp(-max(v.y,0.0)*1.2)*0.18*pow(fbm(v*0.9+vec3f(frameU.absTime*0.04,0,0)),2.0);}
    var wallMist=0.0;
    if(abs(radial-16.8)<5.0 && abs(v.y-1.7)<3.5 && v.z<5.0){
      let plumes=smoothstep(0.35,0.72,noise(vec3f(v.x*0.38,frameU.absTime*0.025,v.z*0.38)));
      wallMist=exp(-pow((radial-16.8)/2.0,2.0))*exp(-pow((v.y-1.7)/1.25,2.0))*pow(fbm(v*1.2+vec3f(frameU.absTime*0.08,0,0)),2.0)*20.0*plumes*(1.0-smoothstep(1.0,5.0,v.z));
    }
    scatter+=transmission*fog*dt*(paletteWarm()*beam*8.0+mix(paletteWarm(),energyGradient(v),params.coreGradient*0.5)*glow*5.0+vec3f(0.45,0.48,0.50)*(groundFog+wallMist));
    transmission*=exp(-fog*dt*0.30);
  }
  let foregroundOcclusion=select(1.0,0.12,visibleGeometry);
  color=color*transmission+scatter*foregroundOcclusion;
  // Analytic Gaussian shafts avoid undersampling thin beams in the volume march.
  for(var i=0u;i<56u;i++){
    let h=hash(vec3f(f32(i),19,3));let a=f32(i)*2.399963;
    let centre=vec2f(cos(a),sin(a))*sqrt(h)*mix(1.75,3.0,step(0.9,h));
    let denom=dot(rd.xz,rd.xz);
    if(denom>0.00001){
      let t=-dot(ro.xz-centre,rd.xz)/denom;
      let v=ro+rd*t;let d=length(v.xz-centre);
      let width=0.008+params.energy*0.012+0.021*hash(vec3f(f32(i),4,8));
      if(t>0.0 && t<distance && v.y>0.1 && v.y<15.0){
        let vertical=select(smoothstep(7.0,9.0,v.y),1.0,i<8u);
        let flow=v.y-frameU.absTime*(0.3+h*0.4);
        let breakup=0.005+4.0*pow(noise(vec3f(f32(i)*5.0,flow*1.2,0)),5.0);
        let fine=0.3+0.7*noise(vec3f(f32(i)*11.0,flow*15.0,3));
        let pulse=(0.08+params.energy*params.energy*1.1+params.highs*0.25+params.beatPulse*0.25)*vertical*breakup*fine;
        let veil=select(0.0,exp(-d*d/0.065)*0.045,i<12u);
        color+=mix(paletteWarm(),vec3f(1),0.45)*pulse*(exp(-d*d/(width*width))*0.14+exp(-d*d/(width*width*170.0))*0.013+veil);
      }
    }
  }
  let vignette=1.0-0.20*dot(screen*vec2f(0.75,1),screen*vec2f(0.75,1));
  // Carry visible ray depth to the lens pass; presentation restores opaque alpha.
  return vec4f(max((color-vec3f(0.006))*1.08*params.exposure*vignette,vec3f(0)),clamp(distance/params.far,0.0,1.0));
}`;

export const RESONANCE_BLOOM_WGSL = `
struct Params {
  strength: f32, // @default 0.35 Scattered highlight energy.
  threshold: f32, // @default 0.8 Highlight extraction threshold.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;
@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {
  let base=textureSampleLevel(inputTexture,inputSampler,uv,0.0).rgb;
  let brightness=max(base.r,max(base.g,base.b));
  let knee=max(params.threshold*0.5,0.0001);
  let soft=clamp(brightness-params.threshold+knee,0.0,2.0*knee);
  let contribution=max(brightness-params.threshold,soft*soft/(4.0*knee))/max(brightness,0.0001);
  return vec4f(base*contribution*params.strength,1);
}`;

/** The installation's light sources as an equirectangular reflection environment. */
export const RESONANCE_ENV_WGSL = `
${RESONANCE_ROOM_BINDINGS}
fn panelVideoAt(uv:vec2f)->vec3f {return textureSampleLevel(inputTexture,inputSampler,uv,0.0).rgb;}
${RESONANCE_ARCHITECTURE_WGSL}
@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {
  let azimuth=(uv.x-0.5)*6.283185307;
  let elevation=uv.y*3.14159265;
  let rd=vec3f(sin(elevation)*sin(azimuth),cos(elevation),-sin(elevation)*cos(azimuth));
  let hit=roomHit(CENTRE,rd);
  return vec4f(surface(CENTRE+rd*hit.x,rd,hit.y)*params.exposure,1);
}`;

/** Mineral-scale roughness travels with the surface UVs rather than the camera. */
export const RESONANCE_ROUGHNESS_WGSL = `
struct Params {
  variation:f32, // @default 0.55 Difference between polished mineral and rough stone.
  grain:f32, // @default 0.06 Fine roughness variation.
};
@group(0) @binding(0) var inputSampler:sampler;
@group(0) @binding(1) var inputTexture:texture_2d<f32>;
@group(0) @binding(2) var<uniform> params:Params;
fn hash(p:vec2f)->f32{return fract(sin(dot(p,vec2f(127.1,311.7)))*43758.5453);}
fn noise(p:vec2f)->f32{
  let i=floor(p);let f=fract(p);let u=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2f(1,0)),u.x),mix(hash(i+vec2f(0,1)),hash(i+vec2f(1,1)),u.x),u.y);
}
@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {
  let mineral=noise(uv*vec2f(12,288));
  let grain=noise(uv*vec2f(512,1024));
  let roughness=clamp(0.42+params.variation*mineral+params.grain*(grain-0.5),0.2,1.0);
  return vec4f(vec3f(roughness),1);
}`;


/** Small depth-aware lens blur. The protected central volume remains in focus. */
export const RESONANCE_DOF_WGSL = `
struct Params {
  focusDistance:f32, // @default 17.3 Distance to the suspended sphere.
  focusRange:f32, // @default 5 Half-width of the sharp depth range.
  strength:f32, // @default 0.12 Blur pixels per world unit beyond the sharp range.
  maxRadius:f32, // @default 1.4 Maximum blur radius in output pixels.
  far:f32, // @default 100 Depth packing distance from the camera.
};
@group(0) @binding(0) var inputSampler:sampler;
@group(0) @binding(1) var inputTexture:texture_2d<f32>;
@group(0) @binding(2) var<uniform> params:Params;
@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {
  let centre=textureSampleLevel(inputTexture,inputSampler,uv,0.0);
  let depth=centre.a*params.far;
  let radius=clamp((abs(depth-params.focusDistance)-params.focusRange)*params.strength,0.0,params.maxRadius);
  if(radius<0.05){return vec4f(centre.rgb,1);}
  let pixel=1.0/vec2f(textureDimensions(inputTexture));
  var sum=centre.rgb*2.0;var weight=2.0;
  for(var i=0u;i<8u;i++){
    let angle=f32(i)*0.7853981634;
    let sample=textureSampleLevel(inputTexture,inputSampler,uv+vec2f(cos(angle),sin(angle))*radius*pixel,0.0);
    // Reject other depth layers so foreground silhouettes do not bleed into the room.
    let w=1.0-smoothstep(0.5,2.0,abs(sample.a*params.far-depth));
    sum+=sample.rgb*w;weight+=w;
  }
  return vec4f(sum/weight,1);
}`;

// Two disjoint quadrants preserve every native scene texel and its unfiltered depth.
// Add is RGBA arithmetic, so neither pack premultiplies the depth stored in alpha.
function atlasPack(right:boolean):string {return `
@group(0) @binding(0) var inputSampler:sampler;
@group(0) @binding(1) var inputTexture:texture_2d<f32>;
@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {
  let local=(uv-vec2f(${right?"0.5":"0.0"},0))*2.0;
  if(any(local<vec2f(0)) || any(local>=vec2f(1))){return vec4f(0);}
  let dims=textureDimensions(inputTexture);
  return textureLoad(inputTexture,clamp(vec2i(local*vec2f(dims)),vec2i(0),vec2i(dims)-1),0);
}`;}
export const RESONANCE_ATLAS_SCENE_WGSL=atlasPack(false);
export const RESONANCE_ATLAS_VIDEO_WGSL=atlasPack(true);

/** Preserve source proportions before the switch normalizes video resolution. */
export const RESONANCE_VIDEO_CROP_WGSL=`
${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler:sampler;
@group(0) @binding(1) var inputTexture:texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU:SharedFrame;
@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {
  let dims=vec2f(textureDimensions(inputTexture));
  let sourceAspect=dims.x/dims.y;
  let outputAspect=16.0/9.0;
  let crop=vec2f(min(1.0,outputAspect/sourceAspect),min(1.0,sourceAspect/outputAspect));
  return textureSampleLevel(inputTexture,inputSampler,vec2f(0.5)+(uv-0.5)*crop,0.0);
}`;
