export const INSTALLATION_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", default: [1, 1, 1, 1] },
]);

const NOISE = `
fn ihash(n:f32)->f32{return fract(sin(n*127.1)*43758.5453);}
fn mineral(p:vec3f)->f32 {
 let cell=floor(p);let f=fract(p);let u=f*f*(3.0-2.0*f);
 let n=dot(cell,vec3f(1,57,113));
 return mix(mix(mix(ihash(n),ihash(n+1.0),u.x),mix(ihash(n+57.0),ihash(n+58.0),u.x),u.y),mix(mix(ihash(n+113.0),ihash(n+114.0),u.x),mix(ihash(n+170.0),ihash(n+171.0),u.x),u.y),u.z);
}
fn rotateY(p:vec3f,a:f32)->vec3f{let c=cos(a);let s=sin(a);return vec3f(c*p.x+s*p.z,p.y,-s*p.x+c*p.z);}
`;

/** Closed two-sided petal strip. Degenerate first/last rows isolate adjacent petals. */
export function lotusKernel(columns: number, rowsPerPetal: number): string {
  return `${NOISE}
struct Params {
  petals:f32, // @default 12 Radial petal count.
  radius:f32, // @default 1.2 Petal root radius.
  reach:f32, // @default 2.5 Petal length.
  lift:f32, // @default 5.1 Root height.
  rise:f32, // @default 1.2 Tip rise.
  width:f32, // @default 0.72 Maximum half-width.
  thickness:f32, // @default 0.22 Crystal depth across the paired facets.
  curl:f32, // @default 0.5 Tip curl.
  invert:f32, // @default 1 Vertical orientation; -1 hangs from the ceiling.
  phase:f32, // @default 0 Angular offset.
  energy:f32, // @default 0 Audio opening amount.
};
fn process(p:Point,ctx:PointCtx)->Point{
  var q=p;
  let row=ctx.index/${columns}u;
  let petal=row/${rowsPerPetal}u;
  let axial=row%${rowsPerPetal}u;
  let t=f32(axial)/${rowsPerPetal-1}.0;
  // Four vertices per planar side repeat the adjoining edge positions. The surface
  // renderer's finite differences then keep each crystal face's own hard normal.
  let crossIndex=ctx.index%${columns}u;
  let sector=f32(crossIndex/4u)+f32(crossIndex%4u)/3.0;
  let corner=floor(sector);let blend=fract(sector);
  let a=corner*0.785398163;let b=(corner+1.0)*0.785398163;
  let crossSection=mix(vec2f(cos(a),sin(a)),vec2f(cos(b),sin(b)),blend);
  let identity=ihash(f32(petal)+17.0);
  // Piecewise linear growth makes planar crystal facets, with collapsed root/tip rows.
  let profile=max(0.0,min(t/0.58,(1.0-t)/0.42));
  let lengthScale=0.9+identity*0.16;
  let angle=f32(petal)*6.283185307/max(ctx.params.petals,1.0)+ctx.params.phase;
  let forward=(ctx.params.radius+ctx.params.reach)*t*lengthScale;
  let height=ctx.params.lift+t*ctx.params.rise*lengthScale;
  let local=vec3f(crossSection.x*ctx.params.width*profile,height+crossSection.y*ctx.params.thickness*profile,forward);
  q.position=rotateY(local,angle);
  let facet=0.5+0.5*cos(corner*1.73+f32(petal)*0.63);
  let inclusion=pow(max(0.0,1.0-abs(sin(t*41.0+sector*2.7+identity*19.0))),18.0);
  q.tint=vec4f(mix(vec3f(0.018,0.05,0.032),vec3f(0.22,0.35,0.27),facet*facet)+vec3f(0.1,0.25,0.16)*inclusion*(0.1+ctx.params.energy*0.2),1);
  return q;
}`;
}

export function lotusCoreKernel(columns:number):string{return `${NOISE}
struct Params {
  height:f32, // @default 7 Core centre height.
  radius:f32, // @default 0.45 Core radius.
  centreZ:f32, // @default 1.7 Core depth inside the crown opening.
  energy:f32, // @default 0 Audio luminance.
};
fn process(p:Point,ctx:PointCtx)->Point {
  var q=p;
  let u=f32(ctx.index%${columns}u)/${columns-1}.0;
  let v=f32(ctx.index/${columns}u)/31.0;
  let latitude=v*3.14159265;let longitude=u*6.283185307;
  let normal=vec3f(sin(latitude)*cos(longitude),cos(latitude),sin(latitude)*sin(longitude));
  q.position=normal*ctx.params.radius+vec3f(0,ctx.params.height,ctx.params.centreZ);
  let body=0.18+0.65*max(0.0,dot(normal,normalize(vec3f(-0.4,0.6,1))));
  let flow=mineral(normal*7.0+vec3f(0,ctx.absTime*0.04,0));
  let filament=pow(max(0.0,1.0-abs(flow-0.5)*12.0),4.0);
  q.tint=vec4f(vec3f(0.4,1.0,0.58)*(body+filament*0.32)*(0.65+ctx.params.energy*0.6),1);
  return q;
}`;}

export function crystalPetalKernel(columns:number,rows:number):string{return `${NOISE}
struct Params{
  angle:f32, // @default 0 Radial angle.
  radius:f32, // @default 0.4 Root radius.
  reach:f32, // @default 4 Blade length.
  lift:f32, // @default 4.5 Root height.
  rise:f32, // @default 1 Tip rise.
  width:f32, // @default 0.8 Blade half-width.
  thickness:f32, // @default 0.18 Blade half-thickness.
  curl:f32, // @default 0.5 Tip curl.
  identity:f32, // @default 0 Stable blade identity.
  energy:f32, // @default 0 Audio opening.
};
fn process(p:Point,ctx:PointCtx)->Point{
  var q=p;let t=f32(ctx.index%${columns}u)/${columns - 1}.0;let ring=f32(ctx.index/${columns}u)/${rows - 1}.0*6.283185307;
  let taper=pow(max(sin(t*3.14159265),0.0),0.72);let open=clamp(ctx.params.energy,0.0,1.0);
  let facet=0.82+0.18*cos(ring*4.0);let lateral=cos(ring)*ctx.params.width*taper*facet;
  let ridge=sin(ring)*ctx.params.thickness*taper*(0.7+0.3*cos(t*9.0+ctx.params.identity));
  let forward=ctx.params.radius+ctx.params.reach*t*(1.0+open*0.14);
  let height=ctx.params.lift+t*ctx.params.rise-t*t*ctx.params.curl+sin(t*3.14159265)*ctx.params.rise*0.22+ridge;
  q.position=rotateY(vec3f(lateral,height,forward),ctx.params.angle);
  let vein=pow(max(0.0,1.0-abs(sin(t*26.0+ring*2.0+ctx.params.identity))),18.0);
  let edge=pow(abs(cos(ring)),10.0);let variation=ihash(ctx.params.identity*37.0);
  q.tint=vec4f(vec3f(0.18,0.48,0.25)*(0.72+variation*0.35)+vec3f(0.45,1.0,0.64)*(vein*0.25+edge*0.45+open*0.12),1);
  return q;
}`;}

export const MONOLITH_ATTRIBUTES = JSON.stringify([
  ...JSON.parse(INSTALLATION_ATTRIBUTES),
  {name:"end",type:"vec3f",default:[0,0,0]},
  {name:"emission",type:"vec4f",default:[0,0,0,1]},
  {name:"fissure",type:"f32",default:[0]},
]);

export const MONOLITH_KERNEL = `${NOISE}
struct Params {
  x:f32, // @default 0 World X.
  z:f32, // @default 0 World Z.
  yaw:f32, // @default 0 Rotation in radians.
  width:f32, // @default 1.2 Slab width.
  depth:f32, // @default 0.45 Slab depth.
  height:f32, // @default 7 Slab height.
  lean:f32, // @default 0 Top displacement.
  phase:f32, // @default 0 Surface identity.
  energy:f32, // @default 0 Audio fissure energy.
};
fn process(p:Point,ctx:PointCtx)->Point{
  var q=p;
  let axial=ctx.index%129u;
  let v=clamp((f32(axial)-1.0)/126.0,0.0,1.0);
  let around=f32(ctx.index/129u)/128.0*4.0;
  let face=floor(around);
  let along=fract(around);
  var x=0.0;var z=0.0;
  if(face<1.0){x=mix(-ctx.params.width*0.5,ctx.params.width*0.5,along);z=-ctx.params.depth*0.5;}
  else if(face<2.0){x=ctx.params.width*0.5;z=mix(-ctx.params.depth*0.5,ctx.params.depth*0.5,along);}
  else if(face<3.0){x=mix(ctx.params.width*0.5,-ctx.params.width*0.5,along);z=ctx.params.depth*0.5;}
  else{x=-ctx.params.width*0.5;z=mix(ctx.params.depth*0.5,-ctx.params.depth*0.5,along);}
  let cap=select(1.0,0.0,axial==0u || axial==128u);
  x*=cap;z*=cap;
  let rest=vec3f(x,v*ctx.params.height,z);
  let strata=mineral(rest*vec3f(4,1.2,4)+ctx.params.phase*9.0);
  // Displace out of the broad faces, not mostly along their tangent.
  // The frequencies stay below the grid's sampling limit so finite-difference normals
  // recover coherent stone relief instead of aliased, nearly-flat shading.
  let ridge=mineral(rest*3.2+ctx.params.phase*9.0);
  let grain=mineral(rest*8.0+ctx.params.phase*13.0);
  let chip=(ridge-0.5)*0.08+(abs(grain-0.5)-0.25)*0.12+(mineral(rest*12.0)-0.5)*0.024;
  let outward=normalize(vec3f(x/max(ctx.params.width,0.1),0.0,z/max(ctx.params.depth,0.1))+vec3f(0.00001,0,0));
  let tectonic=(0.5+0.5*sin(ctx.absTime*0.065+ctx.params.phase*1.71))*(0.18+ihash(ctx.params.phase)*0.32);
  let faultSide=select(-1.0,1.0,sin(ctx.params.phase*4.13)>0.0);
  let split=smoothstep(0.43,0.49,v)*(0.5+0.5*sin(ctx.absTime*0.043+ctx.params.phase))*faultSide*(0.12+ihash(ctx.params.phase+9.0)*0.34);
  let topSlope=(x/max(ctx.params.width,0.1))*v*v*0.32;
  let local=vec3f(x*1.2+ctx.params.lean*v+split,v*ctx.params.height+tectonic+topSlope,z+abs(split)*0.16)+outward*chip*cap;
  q.position=rotateY(local,ctx.params.yaw)+vec3f(ctx.params.x,0.34,ctx.params.z);
  q.end=q.position+rotateY(vec3f(ctx.params.lean/126.0,ctx.params.height/126.0,0),ctx.params.yaw);
  let cornerRow=ctx.index/129u;
  q.fissure=select(0.0,1.0,axial>0u && axial<127u && (cornerRow==32u || cornerRow==96u));
  let fractureNoise=0.45+mineral(rest*7.0);
  q.emission=vec4f(vec3f(1.0,0.28,0.06)*(0.5+ctx.params.energy*3.0)*fractureNoise,1);

  let crack=pow(max(0.0,1.0-abs(sin(v*35.0+along*11.0+strata*8.0))),24.0);
  q.tint=vec4f(vec3f(0.18,0.185,0.19)*(0.32+ridge*0.9+grain*0.38)+vec3f(0.18,0.035,0.005)*crack*(0.08+ctx.params.energy*0.3),1);
  return q;
}`;

export const ORRERY_KERNEL = `${NOISE}
struct Params {
  radius:f32, // @default 3 Ring radius.
  width:f32, // @default 0.2 Radial half-width of the metal band.
  thickness:f32, // @default 0.08 Vertical half-thickness of the metal band.
  pitch:f32, // @default 0 X rotation.
  yaw:f32, // @default 0 Y rotation.
  roll:f32, // @default 0 Z rotation.
  height:f32, // @default 5.6 Centre height.
  spin:f32, // @default 0 Animated rotation.
  energy:f32, // @default 0 Audio energy.
  arc:f32, // @default 0.84 Fraction of the orbit occupied by this band.
  offset:f32, // @default 0.08 Angular start, in turns.
  inset:f32, // @default 0 Luminous inner-edge insert instead of metal.
};
fn rotX(p:vec3f,a:f32)->vec3f{let c=cos(a);let s=sin(a);return vec3f(p.x,c*p.y-s*p.z,s*p.y+c*p.z);}
fn rotZ(p:vec3f,a:f32)->vec3f{let c=cos(a);let s=sin(a);return vec3f(c*p.x-s*p.y,s*p.x+c*p.y,p.z);}
fn process(p:Point,ctx:PointCtx)->Point{
  var q=p;
  let motion=ctx.params.spin;
  let column=ctx.index%256u;
  // Duplicate each end angle and collapse the terminal cross-section to its centre.
  // Adjacent side faces then form a flat cap instead of exposing an open metal shell.
  let theta=(ctx.params.offset+clamp((f32(column)-1.0)/253.0,0.0,1.0)*ctx.params.arc)*6.283185307;
  let side=ctx.index/256u;
  // Eight beveled corners, each duplicated: the surface normal does not smear
  // across a metal edge. The seventeenth row closes the section.
  let corner=((side+1u)/2u)%8u;
  let bevel=min(ctx.params.width,ctx.params.thickness)*0.25;
  let w=ctx.params.width;let h=ctx.params.thickness;
  let profile=array<vec2f,8>(vec2f(-w+bevel,-h),vec2f(w-bevel,-h),vec2f(w,-h+bevel),vec2f(w,h-bevel),vec2f(w-bevel,h),vec2f(-w+bevel,h),vec2f(-w,h-bevel),vec2f(-w,-h+bevel));
  var radial=profile[corner].x;var vertical=profile[corner].y;
  if(column==0u || column==255u){radial=0.0;vertical=0.0;}
  let expanded=(ctx.params.radius+radial);
  var local=vec3f(cos(theta)*expanded,vertical,sin(theta)*expanded);
  local=rotX(local,ctx.params.pitch+motion);local=rotateY(local,ctx.params.yaw+motion*0.37);local=rotZ(local,ctx.params.roll-motion*0.23);
  q.position=local+vec3f(0,ctx.params.height,0);
  let brushed=0.95+0.05*mineral(vec3f(theta*30.0,f32(side)*0.12,3.0));
  let vein=pow(0.5+0.5*sin(theta*11.0+sin(theta*7.0-ctx.absTime*0.4)),6.0);
  let metal=vec3f(0.72,0.76,0.83)*brushed;
  let glow=vec3f(0.35,0.43,0.9)*(0.3+vein*(0.35+ctx.params.energy*1.0));
  q.tint=vec4f(mix(metal,glow,ctx.params.inset),1);
  return q;
}`;

export const ORRERY_FILAMENT_ATTRIBUTES=JSON.stringify([
  ...JSON.parse(INSTALLATION_ATTRIBUTES),
  {name:"end",type:"vec3f",default:[0,0,0]},
]);
export const ORRERY_FILAMENT_KERNEL=`${NOISE}
struct Params { energy:f32, // @default 0 Electrical intensity, never sphere size.
};
fn filament(t:f32,id:f32,time:f32)->vec3f {
  let a=t*6.283185307+id*2.399963;
  let latitude=sin(t*12.5663706+id*1.7)*1.2;
  let r=0.86+0.25*sin(id*4.3);
  let ripple=0.018*sin(t*180.0+id*7.1+time*2.0)+0.009*sin(t*391.0-id*3.0);
  var p=vec3f(cos(a)*cos(latitude),sin(latitude),sin(a)*cos(latitude))*(r+ripple);
  p=rotateY(p,time*0.09+id);
  return p+vec3f(0,5.65,0);
}
fn process(p:Point,ctx:PointCtx)->Point {
  var q=p;let id=f32(ctx.index/128u);let segment=ctx.index%128u;
  q.position=filament(f32(segment)/128.0,id,ctx.absTime);
  q.end=filament(f32(segment+1u)/128.0,id,ctx.absTime);
  let flash=pow(0.5+0.5*sin(id*5.1+ctx.absTime*1.7),8.0);
  q.tint=vec4f(mix(vec3f(0.24,0.35,1),vec3f(0.8,0.91,1),flash)*(1.6+flash*(1.4+ctx.params.energy*4.5)),1);
  return q;
}`;
export const ORRERY_FILAMENT_MIRROR_KERNEL=`fn process(p:Point,ctx:PointCtx)->Point {var q=p;q.position.y=-p.position.y;q.end.y=-p.end.y;return q;}`;

export const ORRERY_CORE_KERNEL=`${NOISE}
struct Params { energy:f32, // @default 0 Electrical intensity.
};
fn process(p:Point,ctx:PointCtx)->Point {
  var q=p;let latitude=f32(ctx.index/65u)/31.0*3.14159265;
  let longitude=f32(ctx.index%65u)/64.0*6.283185307;
  let unit=vec3f(sin(latitude)*cos(longitude),cos(latitude),sin(latitude)*sin(longitude));
  q.position=unit*0.63+vec3f(0,5.65,0);
  let field=mineral(unit*4.0+vec3f(0,ctx.absTime*0.12,0));
  let veins=pow(1.0-abs(sin(field*22.0+unit.y*5.0)),14.0);
  let swirl=0.08+0.18*field+veins*(0.5+ctx.params.energy*1.1);
  q.tint=vec4f(mix(vec3f(0.12,0.18,0.6),vec3f(0.65,0.8,1),veins)*swirl,1);
  return q;
}`;

export const LIFT_KERNEL = `struct Params{height:f32, // @default 5.6 Centre height.
energy:f32, // @default 0 Audio pulse.
};fn process(p:Point,ctx:PointCtx)->Point{var q=p;q.position=p.position*(1.0+ctx.params.energy*0.08)+vec3f(0,ctx.params.height,0);q.tint=vec4f(vec3f(0.42,0.48,1.0)*(0.7+ctx.params.energy*0.8),1);return q;}`;

export function sphereGridKernel(columns:number,colour:readonly [number,number,number]=[0.42,0.48,1]):string{return `struct Params{height:f32, // @default 5.6 Centre height.
radius:f32, // @default 0.8 Sphere radius.
energy:f32, // @default 0 Audio pulse.
};fn process(p:Point,ctx:PointCtx)->Point{var q=p;let u=f32(ctx.index%${columns}u)/${columns - 1}.0;let row=ctx.index/${columns}u;let v=f32(row)/31.0;let latitude=v*3.14159265;let longitude=u*6.283185307;let r=ctx.params.radius;q.position=vec3f(sin(latitude)*cos(longitude),cos(latitude),sin(latitude)*sin(longitude))*r+vec3f(0,ctx.params.height,0);q.tint=vec4f(vec3f(${colour.join(",")})*(0.7+ctx.params.energy*0.8),1);return q;}`;}

export const INSTALLATION_MIRROR_KERNEL = `fn process(p:Point,ctx:PointCtx)->Point{var q=p;q.position.y=-p.position.y;return q;}`;

export const CRYSTAL_SHELL_KERNEL = `struct Params{centreY:f32, // @default 5.0 Expansion centre height.
scale:f32, // @default 1.025 Shell expansion.
};fn process(p:Point,ctx:PointCtx)->Point{var q=p;let centre=vec3f(0,ctx.params.centreY,0);q.position=centre+(p.position-centre)*ctx.params.scale;q.tint=mix(p.tint,vec4f(0.72,1.0,0.82,1),0.28);return q;}`;

/**
 * T1349b — E79 Crucible: THE HALO. A torus standing in the XY plane so it faces the eye,
 * closed around both directions (the first/last column and row repeat their neighbour at
 * the same angle, so the surface has no seam and finite-difference normals hold up). It is
 * the scene's key light: `energy` — the Beat lane — pushes the emission from a dull red
 * ember to a white-hot flash, and the point light in the document rides the same lane, so
 * what the ring shows the hulls receive. `breath` — the Tail lane — swells the tube.
 */
export const HALO_COLUMNS = 256;
export const HALO_ROWS = 17;
export const HALO_CAPACITY = HALO_COLUMNS * HALO_ROWS;
export const HALO_KERNEL = `${NOISE}
struct Params {
  radius:f32, // @default 2.7 Ring radius.
  tube:f32, // @default 0.11 Tube radius.
  height:f32, // @default 5.6 Centre height.
  tilt:f32, // @default 0 Lean of the ring plane, radians.
  energy:f32, // @default 0 Beat lane: 0 ember, 1 white-hot.
  breath:f32, // @default 0 Tail lane: swells the tube.
};
fn process(p:Point,ctx:PointCtx)->Point{
  var q=p;
  let column=ctx.index%${HALO_COLUMNS}u;let row=ctx.index/${HALO_COLUMNS}u;
  // Repeat the seam vertex rather than leaving a gap: 255 steps close the circle exactly.
  let theta=f32(column%${HALO_COLUMNS - 1}u)/${HALO_COLUMNS - 1}.0*6.283185307;
  let phi=f32(row%${HALO_ROWS - 1}u)/${HALO_ROWS - 1}.0*6.283185307;
  // A modest swell: 12% on the hit, 25% over the tail lane — a bigger one popped (T1349b).
  let tube=ctx.params.tube*(1.0+ctx.params.breath*0.25+ctx.params.energy*0.12);
  // Ring in XY (axis along Z); the tube circle lies in the ring's radial/Z plane.
  let radial=ctx.params.radius+cos(phi)*tube;
  var local=vec3f(cos(theta)*radial,sin(theta)*radial,sin(phi)*tube);
  let c=cos(ctx.params.tilt);let sn=sin(ctx.params.tilt);
  local=vec3f(local.x,c*local.y-sn*local.z,sn*local.y+c*local.z);
  q.position=local+vec3f(0,ctx.params.height,0);
  // Heat travels round the ring: a slow moving hot spot plus fine flicker, both on absTime.
  let travel=0.6+0.4*sin(theta*3.0-ctx.absTime*0.9)+0.25*mineral(vec3f(theta*9.0,ctx.absTime*2.5,phi));
  let ember=vec3f(1.0,0.12,0.02);let hot=vec3f(1.0,0.78,0.5);
  let glow=mix(ember,hot,clamp((ctx.params.energy-0.25)*1.4,0.0,1.0))*(0.25+ctx.params.energy*8.0)*travel;
  // The inner face (phi near pi, facing the ring centre) is hotter: the light comes from the core.
  let inner=0.7+0.3*(0.5-0.5*cos(phi));
  q.tint=vec4f(glow*inner,1);
  return q;
}`;

