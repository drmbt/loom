import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * E79 CRUCIBLE (T1349b, second cut) — the kernels of a void full of machinery.
 *
 * The first cut put six boxes in E75's hall and the owner said so: *"not even close to the
 * reference … a hundred or two hundred animated meshes and this interesting layout"*. This
 * cut is its own scene. What the reference is, read frame by frame: a black void; a thin
 * white-hot ring near centre; large dark mechanical hulls with panel seams and lit strips
 * stacked around it at every distance, the nearest cutting the frame as silhouettes; small
 * shards streaming past; red haze that flares on the hit; one green accent light; a wide
 * lens that drifts.
 *
 * ## One grid, many bodies
 *
 * A `geometry` surface is one grid, so a kernel that wants N bodies puts them in ONE grid
 * and collapses the first and last row of each body to a point (the lotus petals' trick):
 * adjacent bodies then touch through a degenerate strip that draws nothing. Rows per body
 * are `SWARM_ROWS`, columns are four faces of nine (corners duplicated). 24 bodies per
 * node, six nodes, plus two nodes of foreground giants — ~160 hulls, each with its own
 * orbit, plane, size, tumble, plate layout and lit strips, from one hash per body.
 */
const NOISE = `
fn ihash(n:f32)->f32{return fract(sin(n*127.1)*43758.5453);}
fn mineral(p:vec3f)->f32 {
 let cell=floor(p);let f=fract(p);let u=f*f*(3.0-2.0*f);
 let n=dot(cell,vec3f(1,57,113));
 return mix(mix(mix(ihash(n),ihash(n+1.0),u.x),mix(ihash(n+57.0),ihash(n+58.0),u.x),u.y),mix(mix(ihash(n+113.0),ihash(n+114.0),u.x),mix(ihash(n+170.0),ihash(n+171.0),u.x),u.y),u.z);
}
fn rotateY(p:vec3f,a:f32)->vec3f{let c=cos(a);let s=sin(a);return vec3f(c*p.x+s*p.z,p.y,-s*p.x+c*p.z);}
fn rotateX(p:vec3f,a:f32)->vec3f{let c=cos(a);let s=sin(a);return vec3f(p.x,c*p.y-s*p.z,s*p.y+c*p.z);}
fn rotateZ(p:vec3f,a:f32)->vec3f{let c=cos(a);let s=sin(a);return vec3f(c*p.x-s*p.y,s*p.x+c*p.y,p.z);}
`;

export const SWARM_COLUMNS = 36;
export const SWARM_ROWS = 20;
export const SWARM_BODIES = 24;
export const SWARM_CAPACITY = SWARM_COLUMNS * SWARM_ROWS * SWARM_BODIES;

export const SWARM_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", default: [1, 1, 1, 1] },
  { name: "end", type: "vec3f", default: [0, 0, 0] },
  { name: "emission", type: "vec4f", default: [0, 0, 0, 1] },
  { name: "seam", type: "f32", default: [0] },
]);

/**
 * The hulls. `slot` picks a disjoint hash range per node so eight nodes are 192 different
 * bodies, not eight copies. `near`/`far` bound the orbit radius; `small`/`large` the body
 * size, drawn with a heavy tail so most are modest and a few are huge. `drift` (Tail lane)
 * pushes every orbit round; `burst` (Beat lane) lights the seams; `accent` is the share of
 * bodies carrying the green strips.
 */
export const SWARM_KERNEL = `${NOISE}
struct Params {
  slot:f32, // @default 0 Which hash range this node draws from.
  tier:f32, // @default 1 0 inner ring of modules, 1 mid teeth, 2 foreground giants.
  near:f32, // @default 8 Closest orbit radius.
  far:f32, // @default 12 Farthest orbit radius.
  small:f32, // @default 0.8 Smallest body size.
  large:f32, // @default 2.4 Largest body size.
  depthNear:f32, // @default -4 Depth band start along the lens axis.
  depthFar:f32, // @default 4 Depth band end along the lens axis.
  speed:f32, // @default 0.004 Turns per second of the whole tier about the ring axis.
  sectors:f32, // @default 16 Angular sectors the bodies snap to.
  drift:f32, // @default 0 This tier's own lane: breathes the lit strips.
  burst:f32, // @default 0 Beat lane: lights the seams.
  accent:f32, // @default 0.25 Share of bodies with green strips.
  density:f32, // @default 1 Share of this grid's bodies that exist; the rest collapse away.
  bodies:f32, // @default 24 Bodies in this grid (matches the grid rows).
};
fn process(p:Point,ctx:PointCtx)->Point{
  var q=p;
  let column=ctx.index%${SWARM_COLUMNS}u;
  let row=ctx.index/${SWARM_COLUMNS}u;
  let body=row/${SWARM_ROWS}u;
  let axial=row%${SWARM_ROWS}u;
  let id=f32(body)+ctx.params.slot*${SWARM_BODIES}.0;
  let h=array<f32,12>(ihash(id*1.3+0.1),ihash(id*2.1+0.7),ihash(id*3.7+1.9),ihash(id*5.3+2.3),ihash(id*7.1+3.1),ihash(id*1.9+4.7),ihash(id*2.9+5.3),ihash(id*4.1+6.1),ihash(id*6.7+7.9),ihash(id*8.3+8.1),ihash(id*9.1+9.7),ihash(id*11.3+0.4));
  // Along the body: rows 3..16 span the length; rows 1–2 and 17–18 lie IN the end planes
  // (an inset ring and the full profile), so the end cap is a flat face with its own normal
  // rather than a fan whose shading blends into the sides; rows 0 and 33 collapse to a point.
  let v=clamp((f32(axial)-3.0)/${SWARM_ROWS - 7}.0,0.0,1.0);
  let cap=select(1.0,0.0,axial==0u || axial==${SWARM_ROWS - 1}u);
  let inset=select(1.0,0.9,axial==1u || axial==${SWARM_ROWS - 2}u);
  // Around the body: four faces of nine columns each, the corner column DUPLICATED on both
  // faces that meet there — the surface renderer's finite differences then keep each
  // face's own hard normal instead of rounding the edge over one column. Nine, not
  // seventeen: the owner measured the app sluggish, and a slab's face needs no more.
  let face=f32(column/9u);let along=f32(column%9u)/8.0;
  // STRUCTURE, NOT NOISE. A body is a MODULE: a long slab, ribbed along its length, with
  // a recessed channel down each broad face and lit strips at regular stations. Sizes
  // come from the tier, not a heavy-tailed draw; proportions are slab-like and shared.
  let size=mix(ctx.params.small,ctx.params.large,h[4]);
  let width=size*0.42;let depth=size*(0.22+h[6]*0.1);let length=size*(1.6+h[7]*0.6);
  var x=0.0;var z=0.0;
  if(face<1.0){x=mix(-width,width,along);z=-depth;}
  else if(face<2.0){x=width;z=mix(-depth,depth,along);}
  else if(face<3.0){x=mix(width,-width,along);z=depth;}
  else{x=-width;z=mix(depth,-depth,along);}
  x*=cap*inset;z*=cap*inset;
  let broad=select(0.0,1.0,face<1.0 || (face>=2.0 && face<3.0));
  // Ribs across the length (a station every ~1/7 of it), a channel down the broad faces,
  // and a shallow chamfer at the ends: relief a light can rake across.
  let ribs=3.0+floor(h[5]*3.0);
  let rib=smoothstep(0.4,0.5,abs(fract(v*ribs)-0.5))*0.018*size;
  let channel=(1.0-smoothstep(0.1,0.16,abs(along-0.5)))*broad*0.035*size;
  let chamfer=0.0;
  let outward=normalize(vec3f(x/max(width,0.01),0.0,z/max(depth,0.01))+vec3f(0.00001,0,0));
  let rest=vec3f(x,(v-0.5)*length,z)-outward*(rib+channel+chamfer)*cap;
  // THE LAYOUT. Bodies snap to angular sectors (a designed symmetry, jittered a little),
  // sit on a tier's radius and depth band, and point at the ring: the long axis is RADIAL
  // for the teeth and the giants, tangential for the inner modules. The whole tier turns
  // slowly as one — no tumble, no per-body jitter in time.
  let sector=floor(h[3]*ctx.params.sectors);
  let angle=(sector+0.5)/ctx.params.sectors*6.283185307+(h[1]-0.5)*0.35+ctx.absTime*ctx.params.speed*6.283185307;
  // Each sector's radius breathes slowly and the giants drift in depth: life without jitter.
  let radius=mix(ctx.params.near,ctx.params.far,h[0])+sin(ctx.absTime*0.045+sector*0.7)*0.7;
  let depthAlong=mix(ctx.params.depthNear,ctx.params.depthFar,h[2])+sin(ctx.absTime*0.03+sector)*select(0.3,1.2,ctx.params.tier>1.5);
  let centre=vec3f(cos(angle)*radius,sin(angle)*radius,depthAlong);
  let radialDir=vec3f(cos(angle),sin(angle),0.0);
  let tangentDir=vec3f(-sin(angle),cos(angle),0.0);
  let axisDir=select(radialDir,tangentDir,ctx.params.tier<0.5);
  // A gentle lean out of the ring plane, fixed per body, so the teeth fan toward the lens.
  let lean=(h[8]-0.5)*0.5+select(0.3,0.0,ctx.params.tier>1.5);
  // rest's long axis is Y: roll about it, then swing it onto the axis direction.
  var local=rotateY(rest,h[10]*3.1415926*0.5);
  local=rotateZ(local,atan2(axisDir.y,axisDir.x)-1.5707963);
  local=rotateX(local,lean*select(1.0,-1.0,sin(angle)<0.0));
  // Composition is what is LEFT OUT: below 'density' a body collapses to a point inside the
  // heart and draws nothing, which is how the tunnel keeps its dark gaps.
  let present=step(ihash(id*17.3+5.5),ctx.params.density);
  q.position=(local+centre)*present;
  q.end=q.position+axisDir*(length/${SWARM_ROWS - 3}.0)*present;
  // Lit strips: a continuous emissive line down the centre of each broad face, present on
  // half the stations (a hash decides which), green on the accent bodies and amber on the
  // rest, breathing with the Tail lane. Drawn as BEAMS from the centre column of the face,
  // row to row, so the line is continuous — a per-row dot at rib borders read as a dotted
  // ladder on the coarse grid. The Beat lane lights the same line as an ember.
  let atRib=smoothstep(0.42,0.5,abs(fract(v*ribs)-0.5));
  // The lit stations chase along the body, one station every ~8 s.
  let lit=broad*step(0.5,fract(floor(v*ribs+ctx.absTime*0.12)*0.5+h[9]));
  let onStrip=lit>0.5 && column%9u==4u && axial>=3u && axial<${SWARM_ROWS - 4}u;
  q.seam=select(0.0,1.0,onStrip);
  let strip=lit*(1.0-smoothstep(0.06,0.12,abs(along-0.5)));
  let accented=h[11]<ctx.params.accent;
  let stripColour=select(vec3f(1.0,0.5,0.15),vec3f(0.2,1.0,0.5),accented)*0.7;
  let ember=vec3f(1.0,0.22,0.04)*(0.1+ctx.params.burst*2.5);
  q.emission=vec4f(ember*0.4+stripColour*(1.2+ctx.params.drift*1.6),1);
  let paint=0.14+0.1*h[5];
  let rust=mix(vec3f(0.5,0.53,0.6),vec3f(0.5,0.28,0.16),h[6]*0.45);
  q.tint=vec4f(rust*paint*(0.7+0.3*mineral(rest*1.5+id))+stripColour*strip*0.4+vec3f(0.4,0.08,0.02)*atRib*ctx.params.burst*0.3,1);
  return q;
}`;

export const SHARD_COLUMNS = 9;
export const SHARD_ROWS = 4;
export const SHARD_COUNT = 400;
export const SHARD_CAPACITY = SHARD_COLUMNS * SHARD_ROWS * SHARD_COUNT;

/**
 * The shards: a few hundred small boxes streaming outward from the ring along their own ray,
 * dark with an ember few. `rate` is the stream speed, `burst` (Beat lane) lights the embers,
 * `highs` sparkles them. No lane touches a position (§T1349b, the teleport).
 */
export const SHARD_KERNEL = `${NOISE}
struct Params {
  slot:f32, // @default 0 Which hash range this node draws from.
  rate:f32, // @default 0.05 Stream speed, spans per second.
  inner:f32, // @default 1.6 Where a shard is born.
  outer:f32, // @default 16 Where it dies.
  size:f32, // @default 0.12 Typical shard size.
  burst:f32, // @default 0 Beat lane: lights the embers.
  highs:f32, // @default 0 Hat lane: sparkle.
};
fn process(p:Point,ctx:PointCtx)->Point{
  var q=p;
  let column=ctx.index%${SHARD_COLUMNS}u;
  let row=ctx.index/${SHARD_COLUMNS}u;
  let shard=row/${SHARD_ROWS}u;
  let axial=row%${SHARD_ROWS}u;
  let id=f32(shard)+ctx.params.slot*${SHARD_COUNT}.0;
  let h0=ihash(id*1.7+0.3);let h1=ihash(id*2.3+1.1);let h2=ihash(id*3.1+2.9);let h3=ihash(id*4.7+0.7);let h4=ihash(id*5.9+3.3);let h5=ihash(id*6.1+4.1);
  let cap=select(1.0,0.0,axial==0u || axial==${SHARD_ROWS - 1}u);
  let v=select(-0.5,0.5,axial==2u);
  let around=f32(column%${SHARD_COLUMNS - 1}u)/2.0;
  let face=floor(around);let along=fract(around);
  let size=ctx.params.size*(0.4+h0*1.2);
  let w=size*(0.4+h1*0.6);let d=size*(0.3+h2*0.5);let l=size*(0.8+h3*2.5);
  var x=0.0;var z=0.0;
  if(face<1.0){x=mix(-w,w,along);z=-d;}else if(face<2.0){x=w;z=mix(-d,d,along);}else if(face<3.0){x=mix(w,-w,along);z=d;}else{x=-w;z=mix(d,-d,along);}
  let rest=vec3f(x*cap,v*l,z*cap);
  // A ray per shard — kept off the lens axis (|z| of the direction under 0.3), so the
  // stream crosses the frame beside the ring and never fills its hole — and a phase that
  // streams with time and jumps with the burst.
  let theta=h4*6.283185307;let phi=acos((h5*2.0-1.0)*0.3);
  let ray=vec3f(sin(phi)*cos(theta),cos(phi),sin(phi)*sin(theta));
  // The phase is absTime only: a lane in it made every shard jump on the hit (the owner
  // saw blocks teleport on the beat). The Beat lane lights the embers and nothing else.
  let phase=fract(h0*7.0+ctx.absTime*ctx.params.rate);
  let dist=mix(ctx.params.inner,ctx.params.outer,phase*phase);
  let tumble=h1*6.283185307;
  var local=rotateZ(rotateX(rest,tumble),h2*6.283185307+tumble*0.7);
  q.position=local+ray*dist+vec3f(sin(ctx.absTime*0.4+id)*0.15,0.0,0.0);
  let ember=step(0.82,h3);
  let glow=ember*(0.4+ctx.params.burst*4.0+ctx.params.highs*2.0)*(1.0-phase);
  q.tint=vec4f(vec3f(0.22,0.2,0.18)*(0.5+h1)+vec3f(1.0,0.3,0.06)*glow,1);
  return q;
}`;

/**
 * The post: red haze by depth and a glow about the ring, screen-space.
 *
 * The input is the shot's colour with its DEPTH packed into alpha (as E75 packs it), so
 * fog is a function of distance and the void behind everything is the far plane. The ring
 * sits at the world origin; its screen position is projected here from the same camera
 * numbers the shot uses (eye, aim, fov), so the rays converge on the ring wherever the
 * lens drifts. `pulse` (Beat lane) flares the haze; `level` breathes the fog.
 */
export const CRUCIBLE_HAZE_WGSL = `
${SHARED_UNIFORMS_WGSL}
struct Params {
  eye:vec3f, // @default 0 1 25.5 Camera eye, shared with the shot's camera.
  aim:vec3f, // @default 0 0.2 0 Camera target, shared with the shot's camera.
  fov:f32, // @default 55 Vertical field of view, degrees.
  far:f32, // @default 100 Depth packing distance.
  density:f32, // @default 0.008 Fog per world unit.
  glow:f32, // @default 0.5 Haze brightness about the ring.
  pulse:f32, // @default 0 Beat lane: flares haze and rays.
  level:f32, // @default 0.3 Slow breath of the fog.
};
@group(0) @binding(0) var inputSampler:sampler;
@group(0) @binding(1) var inputTexture:texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU:SharedFrame;
@group(0) @binding(3) var<uniform> params:Params;
@fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {
  let dims=vec2f(textureDimensions(inputTexture));
  let aspect=dims.x/max(dims.y,1.0);
  let sample=textureSampleLevel(inputTexture,inputSampler,uv,0.0);
  // The void behind everything packs as 0: read it as the far plane, not as the lens.
  let depth=select(sample.a*params.far,params.far,sample.a<0.0005);
  // Project the ring's centre (the origin) through the shot's camera.
  let f=normalize(params.aim-params.eye);
  let r=normalize(cross(f,vec3f(0,1,0)));
  let u=cross(r,f);
  let rel=-params.eye;
  let z=max(dot(rel,f),0.1);
  let t=tan(params.fov*0.00872664626);
  let centre=vec2f(0.5+dot(rel,r)/(z*t*aspect)*0.5,0.5-dot(rel,u)/(z*t)*0.5);
  let toward=(centre-uv)*vec2f(aspect,1.0);
  let dist=length(toward);
  let halo=exp(-dist*dist/0.07)*(0.25+params.pulse*1.6);
  // Fog: distance through a red medium, thicker near the ring's screen position.
  let density=params.density*(0.7+params.level*0.6);
  let fog=1.0-exp(-min(depth,params.far)*density*(0.5+halo*0.9));
  let fogColour=mix(vec3f(0.05,0.006,0.002),vec3f(0.95,0.2,0.05),clamp(halo*0.8+params.pulse*0.4,0.0,1.0))*params.glow;
  // The flare on a hit is the haze itself: a red bloom about the ring, not rays. A radial
  // smear was tried and refused — a THIN bright ring sampled at twenty taps echoes as
  // concentric arcs across the whole frame (measured at f120/f292 of the clip).
  let flare=fogColour*halo*params.pulse*0.6;
  // A vignette, and the depth stays in alpha for the DOF pass behind this one.
  let vignette=1.0-0.35*smoothstep(0.35,0.95,length((uv-0.5)*vec2f(aspect,1.0)));
  let colour=(sample.rgb*(1.0-fog)+fogColour*fog+flare)*vignette;
  return vec4f(max(colour,vec3f(0)),sample.a);
}`;

/**
 * THE CORE — a sphere of latitude BELTS. Eight belts of plates, each turning at its own
 * rate and direction (alternating, so neighbours counter-rotate), the belts SPLITTING apart
 * along the axis on the hit and closing through the punch, the whole form twisting and
 * squaring off toward a superellipsoid on the Tail lane. Plate borders are recessed and
 * carry an ember edge. Own kernel: not E75's fracture, which the owner called out.
 *
 * Grid: `CORE_COLUMNS` around × `CORE_BELT_ROWS` rows per belt × `CORE_BELTS`. Rows 1..10 of
 * a belt are its surface (rows 1 and 10 an inset lip so the belt reads as a plate with
 * thickness), rows 0 and 11 collapse onto the axis so the strip between two belts is a line
 * inside the heart and draws nothing.
 */
export const CORE_COLUMNS = 129;
export const CORE_BELT_ROWS = 12;
export const CORE_BELTS = 8;
export const CORE_CAPACITY = CORE_COLUMNS * CORE_BELT_ROWS * CORE_BELTS;
export const CORE_KERNEL = `${NOISE}
struct Params {
  radius:f32, // @default 3.3 Sphere radius at rest.
  segments:f32, // @default 14 Plates around each belt.
  spin:f32, // @default 0.05 Turns per second of the fastest belt.
  split:f32, // @default 0 Punch lane: belts split apart along the axis.
  morph:f32, // @default 0 Tail lane: twist, and sphere → superellipsoid.
  ember:f32, // @default 0 Beat lane: lights the plate edges.
};
fn process(p:Point,ctx:PointCtx)->Point{
  var q=p;
  let column=ctx.index%${CORE_COLUMNS}u;
  let row=ctx.index/${CORE_COLUMNS}u;
  let belt=f32(row/${CORE_BELT_ROWS}u);
  let axial=row%${CORE_BELT_ROWS}u;
  let onAxis=axial==0u || axial==${CORE_BELT_ROWS - 1}u;
  let lip=select(1.0,0.9,axial==1u || axial==${CORE_BELT_ROWS - 2}u);
  // Latitude: the belt's span, rows 1..10 across it; the poles stay open by 6%.
  let t=clamp((f32(axial)-1.0)/${CORE_BELT_ROWS - 3}.0,0.0,1.0);
  let theta=(0.06+(belt+t)/${CORE_BELTS}.0*0.88)*3.14159265;
  // Longitude: this belt's own turn — alternating direction, faster toward the equator —
  // plus the Tail lane's twist, which shears the belts against each other.
  let centreDistance=abs(belt-3.5)/3.5;
  let direction=select(-1.0,1.0,(u32(belt)%2u)==0u);
  let turn=ctx.absTime*ctx.params.spin*6.283185307*direction*(1.0-centreDistance*0.6)+ctx.params.morph*0.9*(belt-3.5)/3.5;
  let phi=f32(column%${CORE_COLUMNS - 1}u)/${CORE_COLUMNS - 1}.0*6.283185307+turn;
  // Sphere → superellipsoid: the exponent runs 2..4.4 with the Tail lane.
  let n=2.0+ctx.params.morph*2.4;
  let dir=vec3f(sin(theta)*cos(phi),cos(theta),sin(theta)*sin(phi));
  let norm=pow(pow(abs(dir.x),n)+pow(abs(dir.y),n)+pow(abs(dir.z),n),1.0/n);
  // Plates: recessed borders between segments and at the belt's lips.
  let seg=fract(f32(column%${CORE_COLUMNS - 1}u)/${CORE_COLUMNS - 1}.0*ctx.params.segments+belt*0.37);
  let border=1.0-smoothstep(0.0,0.08,min(seg,1.0-seg));
  let recess=border*0.06+(1.0-lip)*0.4;
  let radius=ctx.params.radius/max(norm,0.001)*(1.0-recess*0.12);
  // The split: belts move apart along the axis on the hit, outer belts furthest.
  let lift=ctx.params.split*(belt-3.5)/3.5*1.7;
  var position=dir*radius+vec3f(0.0,lift,0.0);
  if(onAxis){position=vec3f(0.0,cos(theta)*0.2+lift,0.0);}
  q.position=position;
  // Steel plates, an ember edge on the borders the Beat lane lights, hotter near the equator.
  let steel=vec3f(0.5,0.52,0.58)*(0.55+0.45*mineral(dir*6.0+belt));
  let edge=border*(0.15+ctx.params.ember*2.2)*(0.6+0.4*(1.0-centreDistance));
  q.tint=vec4f(steel*(1.0-border*0.6)+vec3f(1.0,0.3,0.06)*edge,1);
  return q;
}`;

/**
 * THE HEART — a lava sphere under the belts. A noise field flowing across the surface
 * displaces it and, where the field crests, opens into white-hot cracks; the punch lifts the
 * whole thing's heat. Seen through the belt gaps at rest, and whole when the belts split.
 */
export const HEART_COLUMNS = 97;
export const HEART_ROWS = 48;
export const HEART_CAPACITY = HEART_COLUMNS * HEART_ROWS;
export const HEART_KERNEL = `${NOISE}
struct Params {
  radius:f32, // @default 2.2 Sphere radius.
  flow:f32, // @default 0.12 Speed of the surface flow.
  heat:f32, // @default 0 Punch lane: the cracks' brightness.
};
fn process(p:Point,ctx:PointCtx)->Point{
  var q=p;
  let u=f32(ctx.index%${HEART_COLUMNS}u)/${HEART_COLUMNS - 1}.0;
  let v=f32(ctx.index/${HEART_COLUMNS}u)/${HEART_ROWS - 1}.0;
  let theta=v*3.14159265;let phi=u*6.283185307;
  let dir=vec3f(sin(theta)*cos(phi),cos(theta),sin(theta)*sin(phi));
  let flow=vec3f(ctx.absTime*ctx.params.flow,ctx.absTime*ctx.params.flow*0.6,0.0);
  let field=mineral(dir*3.0+flow)*0.6+mineral(dir*7.0-flow*1.7)*0.4;
  let bulge=(field-0.5)*0.35+ctx.params.heat*0.1;
  q.position=dir*ctx.params.radius*(1.0+bulge);
  let crack=smoothstep(0.54,0.66,field);
  let crust=vec3f(0.12,0.03,0.01)*(0.6+field);
  let lava=vec3f(1.0,0.5,0.15)*(2.0+ctx.params.heat*4.0);
  q.tint=vec4f(mix(crust,lava,crack),1);
  return q;
}`;
