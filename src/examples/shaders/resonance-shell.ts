/** Spherical Voronoi sites. The same cell owns every vertex through the entire motion. */
export const FRAGMENT_COUNT = 128;
export const SHELL_COLUMNS = 97;
export const SHELL_ROWS_PER_CELL = 32;
export const SHELL_ROWS = FRAGMENT_COUNT * SHELL_ROWS_PER_CELL;
export const SHELL_CAPACITY = SHELL_COLUMNS * SHELL_ROWS;
export const SHELL_RADIUS = 2.1;
export const SHELL_HEIGHT = 5.6;
export const MAX_DISPLACEMENT = 3.1;
let randomState = 7519;
const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 4294967296; };
export const sites: (readonly [number, number, number])[] = [];
while (sites.length < FRAGMENT_COUNT) {
  const y = 1 - 2 * random();
  const a = random() * Math.PI * 2;
  const r = Math.sqrt(1-y*y);
  const candidate = [r*Math.cos(a), y, r*Math.sin(a)] as const;
  if (sites.every(p => p.reduce((v,x,i) => v+(x-candidate[i]!)**2,0) > 0.009)) sites.push(candidate);
}
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((v, x, i) => v + x * b[i]!, 0);
const cross = (a: readonly number[], b: readonly number[]) => [a[1]!*b[2]!-a[2]!*b[1]!,a[2]!*b[0]!-a[0]!*b[2]!,a[0]!*b[1]!-a[1]!*b[0]!];
const normalized = (v: number[]) => v.map(x => x/Math.hypot(...v));
/** Exact half-space clipping in each site's gnomonic tangent plane. */
export const neighbours = sites.map((n, id) => {
  const tangent=normalized(cross(n,Math.abs(n[1])>0.9?[1,0,0]:[0,1,0]));
  const bitangent=cross(n,tangent);
  const planes=sites.map((other,j)=>({j,a:dot(tangent,other),b:dot(bitangent,other),c:1-dot(n,other)})).filter(p=>p.j!==id);
  let polygon=[[-4,-4],[4,-4],[4,4],[-4,4]];
  for(const plane of planes) {
    const output:number[][]=[];
    for(let i=0;i<polygon.length;i++) {
      const a=polygon[i]!;const b=polygon[(i+1)%polygon.length]!;
      const da=plane.a*a[0]!+plane.b*a[1]!-plane.c;
      const db=plane.a*b[0]!+plane.b*b[1]!-plane.c;
      if(da<=0) output.push(a);
      if((da<0)!==(db<0)) {
        const t=da/(da-db);
        output.push([a[0]!+(b[0]!-a[0]!)*t,a[1]!+(b[1]!-a[1]!)*t]);
      }
    }
    polygon=output;
  }
  if(polygon.length<3 || polygon.some(p=>Math.max(...p.map(Math.abs))>=3.99)) throw new Error(`Unbounded fracture cell ${id}`);
  return planes.filter(plane=>polygon.some(p=>Math.abs(plane.a*p[0]!+plane.b*p[1]!-plane.c)<1e-9)).map(p=>p.j);
});
const offsets=[0];
for(const list of neighbours) offsets.push(offsets[offsets.length-1]!+list.length);

const literal = (v: number) => v.toFixed(8);
export const SHELL_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "rest", type: "vec3f", default: [0, 0, 0] },
  { name: "radial", type: "vec3f", default: [0, 1, 0] },
  { name: "seam", type: "f32", default: [0] },
  { name: "tint", type: "vec4f", semantic: "color", default: [1, 1, 1, 1] },
]);
const ROCK_NOISE_WGSL = `fn rockHash(p:vec3f)->f32 {return fract(sin(dot(p,vec3f(127.1,311.7,74.7)))*43758.5453);}
fn rockNoise(p:vec3f)->f32 {
  let i=floor(p);let f=fract(p);let u=f*f*(3.0-2.0*f);
  return mix(mix(mix(rockHash(i),rockHash(i+vec3f(1,0,0)),u.x),mix(rockHash(i+vec3f(0,1,0)),rockHash(i+vec3f(1,1,0)),u.x),u.y),mix(mix(rockHash(i+vec3f(0,0,1)),rockHash(i+vec3f(1,0,1)),u.x),mix(rockHash(i+vec3f(0,1,1)),rockHash(i+vec3f(1,1,1)),u.x),u.y),u.z);
}
`;
/** One rigid rotation for the complete installation object; degrees around its vertical axis. */
const AXIS_ROTATION_WGSL = `
fn rotateAxis(p:vec3f,degrees:f32)->vec3f {
  let angle=degrees*0.01745329252;
  let c=cos(angle);let s=sin(angle);
  return vec3f(c*p.x+s*p.z,p.y,-s*p.x+c*p.z);
}
`;
function shellKernel(columns:number):string { return `
${AXIS_ROTATION_WGSL}
struct Params {
  rotation: f32, // @default 0 Common vertical-axis rotation in degrees.
  expansion: f32, // @default 0 Bounded audio envelope, 0 closes the shell.
  radius: f32, // @default 2.1 Resting sphere radius.
  spreadFloor: f32, // @default 0.015 Minimum share of radial travel for every cell.
  reach: f32, // @default 3.1 Maximum radial displacement.
  height: f32, // @default 5.6 Sphere centre above floor.
  fissure: f32, // @default 0.004 Fraction removed along cell boundaries.
  vibration: f32, // @default 0.01 Subordinate radial motion.
};
const SITES = array<vec3f, ${FRAGMENT_COUNT}>(
${sites.map(s => `vec3f(${s.map(literal).join(",")})`).join(",\n")});
const NEIGHBOURS = array<u32, ${neighbours.flat().length}>(${neighbours.flat().map(v => `${v}u`).join(",")});
const OFFSETS = array<u32, ${FRAGMENT_COUNT+1}>(${offsets.map(v=>`${v}u`).join(",")});
${ROCK_NOISE_WGSL}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let row = ctx.index / ${columns}u;
  let cell = row / ${SHELL_ROWS_PER_CELL}u;
  let ring = row % ${SHELL_ROWS_PER_CELL}u;
  let col = ctx.index % ${columns}u;
  let n = SITES[cell];
  let tangent = normalize(cross(n, select(vec3f(0,1,0), vec3f(1,0,0), abs(n.y) > 0.9)));
  let bitangent = cross(n, tangent);
  let angle = f32(col) / ${columns - 1}.0 * 6.283185307;
  let direction = tangent * cos(angle) + bitangent * sin(angle);
  var slope = 100.0;
  for (var j = OFFSETS[cell]; j < OFFSETS[cell+1u]; j++) {
    let other = SITES[NEIGHBOURS[j]];
    let denom = dot(direction, other);
    if (denom > 0.00001) { slope = min(slope, (1.0-dot(n,other))/denom); }
  }
  // Closed curved wedge: front pole -> outer lip -> inner lip -> back pole.
  // Consecutive collapsed pole rows make the bridges between cells zero-area.
  let radialStep = select(min(f32(ring) / 11.0,1.0), f32(31u-ring) / 11.0, ring >= 20u);
  let a = atan(slope) * clamp(radialStep,0.0,1.0) * (1.0-ctx.params.fissure);
  let spherical = n * cos(a) + direction * sin(a);
  // A shared domain warp roughens both sides of every joint identically.
  let warp=vec3f(rockNoise(spherical*13.0),rockNoise(spherical*13.0+19.0),rockNoise(spherical*13.0+37.0))-0.5;
  let unit=normalize(spherical+warp*0.045);
  let cutDepth=clamp((f32(ring)-11.0)/9.0,0.0,1.0);
  let inner=1.0-cutDepth*0.14;
  let texturePoint = unit * ctx.params.radius;
  let coarse = rockNoise(texturePoint*8.0)-0.5;
  let fine = rockNoise(texturePoint*31.0)-0.5;
  let mineralRidge=pow(1.0-abs(rockNoise(texturePoint*19.0)*2.0-1.0),4.0)-0.5;
  let cutGrain=(rockNoise(texturePoint*24.0+vec3f(cutDepth*9.0))-0.5)*0.028*sin(cutDepth*3.14159265);
  q.rest = unit * (ctx.params.radius * inner + 0.03*coarse + 0.018*fine + 0.012*mineralRidge + cutGrain);
  q.radial = n;
  q.seam = select(0.0,1.0,ring==11u);
  let identity = fract(sin(f32(cell)*127.1+7.3)*43758.5453);
  let energy = clamp(ctx.params.expansion,0.0,1.0);
  // A dense central population preserves the sphere's memory at maximum expansion.
  let allocation = mix(ctx.params.spreadFloor, 1.0, pow(identity, 2.0));
  let drift = ctx.params.vibration * sin(ctx.absTime*2.2+f32(cell)*7.1) * energy;
  let displacement = clamp(ctx.params.reach * energy * allocation + drift,0.0,ctx.params.reach);
  q.position = rotateAxis(q.rest + n * displacement,ctx.params.rotation) + vec3f(0,ctx.params.height,0);
  let grain = rockNoise(q.rest*65.0);
  let stone = (0.025 + 0.04*identity + 0.05*grain*grain) * select(1.0,1.25,ring>=11u && ring<=20u);
  q.tint = vec4f(vec3f(0.85,0.88,0.94)*stone,1);
  return q;
}`;
}
export const INNER_SHELL_COLUMNS = 49;
export const INNER_SHELL_CAPACITY = INNER_SHELL_COLUMNS * SHELL_ROWS;
export const SHELL_KERNEL = shellKernel(SHELL_COLUMNS);
export const INNER_SHELL_KERNEL = shellKernel(INNER_SHELL_COLUMNS);
export const MIRROR_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position.y = -p.position.y;
  return q;
}`;

export const DEBRIS_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0,0,0] },
  { name: "size", type: "f32", default: [0] },
  { name: "tint", type: "vec4f", semantic: "color", default: [1,1,1,1] },
  { name: "orient", type: "vec4f", default: [0,0,0,1] },
]);
// Fragment identity excludes frameIndex: pointRand deliberately draws anew each frame.
const FRAGMENT_RANDOM_WGSL = `
fn fragmentRandom(id:u32,salt:u32)->f32 {
  var state=(id ^ 75u ^ (salt*2891336453u))*747796405u+2891336453u;
  let word=((state >> ((state >> 28u)+4u)) ^ state)*277803737u;
  return f32((word >> 22u) ^ word)*(1.0/4294967296.0);
}
`;
export const DEBRIS_KERNEL = `
${AXIS_ROTATION_WGSL}
${FRAGMENT_RANDOM_WGSL}
struct Params {
  rotation: f32, // @default 0 Common vertical-axis rotation in degrees.
  expansion: f32, // @default 0 Fragment envelope.
  highs: f32, // @default 0 Fine-detail energy.
};
fn process(p:Point,ctx:PointCtx)->Point {
  var q=p;
  let id=ctx.index;
  let y=fragmentRandom(id,13u)*2.0-1.0;
  let a=fragmentRandom(id,17u)*6.283185307;
  let n=vec3f(sqrt(1.0-y*y)*cos(a),y,sqrt(1.0-y*y)*sin(a));
  let energy=clamp(ctx.params.expansion,0.0,1.0);
  let radius=2.07+energy*(0.1+2.8*fragmentRandom(id,23u));
  q.position=vec3f(0,5.6,0)+rotateAxis(n*radius,ctx.params.rotation);
  let size=0.012+pow(fragmentRandom(id,37u),4.0)*0.22;
  q.size=size*smoothstep(0.12,0.5,energy);
  let turn=sin(ctx.absTime*0.12+f32(id))*0.045*energy;
  q.orient=normalize(vec4f(n*sin(turn+f32(id)),cos(turn+f32(id))));
  let bright=select(0.085,0.50,fragmentRandom(id,39u)>0.82);
  let sparkle=select(1.0,1.0+ctx.params.highs*8.0,size<0.025);
  q.tint=vec4f(vec3f(1.0,0.86,0.64)*bright*sparkle,1);
  return q;
}`;

export const SEAM_ATTRIBUTES = JSON.stringify([
  ...JSON.parse(SHELL_ATTRIBUTES),
  { name: "end", type: "vec3f", default: [0,0,0] },
]);
export const SEAM_MIRROR_KERNEL = `fn process(p:Point,ctx:PointCtx)->Point {
  var q=p; q.position.y=-p.position.y; q.end.y=-p.end.y; return q;
}`;
/** Light on the exposed cut lip; it follows the actual deformed vertices. */
function seamKernel(columns:number):string { return `
${AXIS_ROTATION_WGSL}
${ROCK_NOISE_WGSL}
struct Params {
  rotation: f32, // @default 0 Common vertical-axis rotation in degrees.
  gain: f32, // @default 0 Energy visible at the exposed cut lip.
};
fn process(p:Point,ctx:PointCtx)->Point {
  var q=p;
  let col=ctx.index % ${columns}u;
  let next=select(ctx.index+1u,ctx.index-col,col==${columns-1}u);
  let neighbour=pointAt(next);
  q.position=p.position+rotateAxis(normalize(p.rest),ctx.params.rotation)*0.006;
  q.end=neighbour.position+rotateAxis(normalize(neighbour.rest),ctx.params.rotation)*0.006;
  let cut=0.06+pow(rockNoise(p.rest*18.0),3.0)*3.0;
  q.tint=vec4f(vec3f(1.0,0.76,0.48)*(0.003+1.8*ctx.params.gain*ctx.params.gain)*cut,1);
  return q;
}`;
}
export const SEAM_KERNEL = seamKernel(SHELL_COLUMNS);
export const INNER_SEAM_KERNEL = seamKernel(INNER_SHELL_COLUMNS);

export const CHIP_COUNT = 192;
export const CHIP_COLUMNS = 17;
export const CHIP_ROWS_PER_CELL = 9;
export const CHIP_ROWS = CHIP_COUNT * CHIP_ROWS_PER_CELL;
export const CHIP_CAPACITY = CHIP_COLUMNS * CHIP_ROWS;
/** Individually cut convex stone chips, with a closed surface instead of repeated primitives. */
export const CHIP_KERNEL = `
${AXIS_ROTATION_WGSL}
${FRAGMENT_RANDOM_WGSL}
${ROCK_NOISE_WGSL}
struct Params {
  rotation: f32, // @default 0 Common vertical-axis rotation in degrees.
  expansion: f32, // @default 0 Bounded radial expansion.
};
fn process(p:Point,ctx:PointCtx)->Point {
  var q=p;
  let row=ctx.index/${CHIP_COLUMNS}u;
  let id=row/${CHIP_ROWS_PER_CELL}u;
  let latitude=f32(row%${CHIP_ROWS_PER_CELL}u)/${CHIP_ROWS_PER_CELL-1}.0*3.14159265359;
  let longitude=f32(ctx.index%${CHIP_COLUMNS}u)/${CHIP_COLUMNS-1}.0*6.283185307;
  let unit=vec3f(sin(latitude)*cos(longitude),cos(latitude),sin(latitude)*sin(longitude));
  var radius=10.0;
  for(var face=0u;face<10u;face++) {
    let y=1.0-2.0*(f32(face)+0.5)/10.0;
    let a=f32(face)*2.39996323;
    let normal=vec3f(sqrt(1.0-y*y)*cos(a),y,sqrt(1.0-y*y)*sin(a));
    let projection=dot(unit,normal);
    if(projection>0.0){radius=min(radius,(0.54+fragmentRandom(id,face+81u)*0.25)/projection);}
  }
  let grain=(rockNoise(unit*13.0+f32(id))-0.5)*0.08;
  let local=unit*(min(radius,1.35)+grain)*vec3f(0.65+fragmentRandom(id,43u)*0.35,0.6+fragmentRandom(id,47u)*0.4,0.7+fragmentRandom(id,53u)*0.3);
  let y=fragmentRandom(id,13u)*2.0-1.0;
  let a=fragmentRandom(id,17u)*6.283185307;
  let n=vec3f(sqrt(1.0-y*y)*cos(a),y,sqrt(1.0-y*y)*sin(a));
  let tangent=normalize(cross(n,select(vec3f(0,1,0),vec3f(1,0,0),abs(n.y)>0.9)));
  let bitangent=cross(n,tangent);
  let energy=clamp(ctx.params.expansion,0.0,1.0);
  let turn=f32(id)*2.39996+sin(ctx.absTime*0.12+f32(id))*0.045*energy;
  let x=local.x*cos(turn)-local.y*sin(turn);
  let z=local.x*sin(turn)+local.y*cos(turn);
  // Secondary material is grit only; every large departing piece belongs to the fitted shell.
  let size=0.018+pow(fragmentRandom(id,37u),3.0)*0.065;
  q.size=size*smoothstep(0.12,0.5,energy);
  // Large stones travel less so their entire surface stays inside the same envelope.
  let allowedTravel=min(0.1+3.05*fragmentRandom(id,23u),5.18-size*1.39-2.07);
  q.position=vec3f(0,5.6,0)+rotateAxis(n*(2.07+energy*allowedTravel)+(tangent*x+bitangent*z+n*local.z)*q.size,ctx.params.rotation);
  let mineral=0.4+0.6*rockNoise(unit*33.0+f32(id));
  let brightness=(0.045+fragmentRandom(id,39u)*0.08)*mineral;
  // The centre-facing cut faces catch the warm internal energy.
  let innerGlow=pow(max(0.0,-local.z),2.0)*energy*0.22;
  q.tint=vec4f(vec3f(0.92,0.88,0.81)*brightness+vec3f(1,0.57,0.25)*innerGlow,1);
  return q;
}`;
