import type { FurnaceSceneFacts } from "./scene-facts.ts";
import { wgslVec3 } from "./scene-facts.ts";

/**
 * T1354b — the MACHINE RIG: one Point Kernel that moves every loom_part of the machines mesh.
 *
 * Each vertex carries its part in `surface.w`. The kernel applies that part's own motion
 * about its REST pivot, then its parent's, then the grandparent's — child first — which is
 * exactly a hierarchy's world transform when every motion is expressed in the rest frame:
 * the roof swings on its column, and then the whole shell tilts it with the electrodes.
 * Stateless (the kernel reads the upstream rest pose every frame), so it cannot drift and
 * an offline take reproduces.
 *
 * Every motion is a reflected `Params` field — a drivable knob — so the director (§T1370b)
 * and the audio lanes move the plant through ordinary expressions. Axes are glTF's: Blender
 * (x, y, z) exported as (x, z, −y), per `tools/blender/furnace/README.md`.
 *
 * The parent table is written here from the README until §T1363b decodes `loom_parent`.
 */

type Motion =
  | { readonly kind: "translate"; readonly axis: readonly [number, number, number]; readonly param: string }
  | { readonly kind: "rotate"; readonly axis: readonly [number, number, number]; readonly param: string }
  | { readonly kind: "liftSwing"; readonly lift: string; readonly swing: string }
  | { readonly kind: "ropes"; readonly hook: string; readonly hookPart: string }
  | { readonly kind: "scroll"; readonly uv: "u" | "v"; readonly param: string };

interface RigPart {
  readonly name: string;
  readonly parent?: string;
  readonly motion: Motion;
}

const X: readonly [number, number, number] = [1, 0, 0];
const Y: readonly [number, number, number] = [0, 1, 0];
const Z: readonly [number, number, number] = [0, 0, 1];
const NEG_Z: readonly [number, number, number] = [0, 0, -1];

/** The Blender README's parts table, in glTF axes. */
const RIG: readonly RigPart[] = [
  { name: "furnace_shell", motion: { kind: "rotate", axis: Z, param: "shellTilt" } },
  { name: "furnace_roof", parent: "furnace_shell", motion: { kind: "liftSwing", lift: "roofLift", swing: "roofSwing" } },
  { name: "electrode_1", parent: "furnace_shell", motion: { kind: "translate", axis: Y, param: "electrode1" } },
  { name: "electrode_2", parent: "furnace_shell", motion: { kind: "translate", axis: Y, param: "electrode2" } },
  { name: "electrode_3", parent: "furnace_shell", motion: { kind: "translate", axis: Y, param: "electrode3" } },
  { name: "crane_bridge", motion: { kind: "translate", axis: X, param: "craneX" } },
  { name: "crane_trolley", parent: "crane_bridge", motion: { kind: "translate", axis: NEG_Z, param: "trolley" } },
  { name: "crane_hook", parent: "crane_trolley", motion: { kind: "translate", axis: Y, param: "hook" } },
  { name: "crane_ropes", parent: "crane_trolley", motion: { kind: "ropes", hook: "hook", hookPart: "crane_hook" } },
  { name: "scrap_bucket", parent: "crane_hook", motion: { kind: "rotate", axis: Z, param: "bucketSway" } },
  { name: "scrap_bucket_jaw_1", parent: "scrap_bucket", motion: { kind: "rotate", axis: Z, param: "bucketOpen" } },
  { name: "scrap_bucket_jaw_2", parent: "scrap_bucket", motion: { kind: "rotate", axis: NEG_Z, param: "bucketOpen" } },
  { name: "crane2_bridge", motion: { kind: "translate", axis: X, param: "crane2X" } },
  { name: "crane2_trolley", parent: "crane2_bridge", motion: { kind: "translate", axis: NEG_Z, param: "trolley2" } },
  { name: "crane2_hook", parent: "crane2_trolley", motion: { kind: "translate", axis: Y, param: "hook2" } },
  { name: "crane2_ropes", parent: "crane2_trolley", motion: { kind: "ropes", hook: "hook2", hookPart: "crane2_hook" } },
  { name: "ladle_car", motion: { kind: "translate", axis: X, param: "ladleCar" } },
  { name: "ladle", parent: "ladle_car", motion: { kind: "rotate", axis: Z, param: "ladleTilt" } },
  { name: "slag_pot", motion: { kind: "rotate", axis: Z, param: "slagTilt" } },
  { name: "ladle_turret", motion: { kind: "rotate", axis: Y, param: "turret" } },
  { name: "caster_rollers_1", motion: { kind: "scroll", uv: "v", param: "casting" } },
  { name: "caster_rollers_2", motion: { kind: "scroll", uv: "v", param: "casting" } },
  { name: "caster_rollers_3", motion: { kind: "scroll", uv: "v", param: "casting" } },
  { name: "caster_rollers_4", motion: { kind: "scroll", uv: "v", param: "casting" } },
  { name: "caster_rollers_5", motion: { kind: "scroll", uv: "v", param: "casting" } },
  { name: "caster_strand", motion: { kind: "scroll", uv: "u", param: "casting" } },
  { name: "conveyor_belt", motion: { kind: "scroll", uv: "u", param: "conveyor" } },
];

/** The knobs, with the retained value each one rests at and its sentence. */
export const RIG_PARAMS: ReadonlyArray<{ readonly name: string; readonly rest: number; readonly help: string }> = [
  { name: "shellTilt", rest: 0, help: "Furnace shell tilt about the rocker, radians (+ tips toward the tap)." },
  { name: "roofLift", rest: 0, help: "Roof lift, metres." },
  { name: "roofSwing", rest: 0, help: "Roof swing about its column, radians." },
  { name: "electrode1", rest: 0, help: "Electrode 1 travel, metres (negative = down into the bath)." },
  { name: "electrode2", rest: 0, help: "Electrode 2 travel, metres." },
  { name: "electrode3", rest: 0, help: "Electrode 3 travel, metres." },
  { name: "craneX", rest: 0, help: "Scrap crane bridge travel along the bay, metres." },
  { name: "trolley", rest: 0, help: "Scrap crane trolley travel across the bridge, metres." },
  { name: "hook", rest: 0, help: "Scrap crane hook height, metres (negative lowers)." },
  { name: "bucketSway", rest: 0, help: "Scrap bucket sway on the hook, radians." },
  { name: "bucketOpen", rest: 0, help: "Clamshell jaw opening, radians." },
  { name: "crane2X", rest: 0, help: "Ladle crane bridge travel, metres." },
  { name: "trolley2", rest: 0, help: "Ladle crane trolley travel, metres." },
  { name: "hook2", rest: 0, help: "Ladle crane hook height, metres." },
  { name: "ladleCar", rest: 0, help: "Ladle transfer car travel on its rails, metres." },
  { name: "ladleTilt", rest: 0, help: "Ladle pour tilt about the trunnions, radians." },
  { name: "slagTilt", rest: 0, help: "Slag pot tilt, radians." },
  { name: "turret", rest: 0, help: "Ladle turret rotation, radians." },
  { name: "casting", rest: 0, help: "Caster strand travel (uv scroll), metres." },
  { name: "conveyor", rest: 0, help: "Conveyor belt travel (uv scroll), metres." },
];

/** The attribute schema the rig kernel declares: everything it reads or moves. */
export const RIG_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "normal", type: "vec3f", qualifier: "direction", default: [0, 1, 0] },
  { name: "uv", type: "vec2f", default: [0, 0] },
  { name: "surface", type: "vec4f", default: [1, 0, 0, 0] },
]);

function vecLiteral(axis: readonly [number, number, number]): string {
  return `vec3f(${axis.map((component) => component.toFixed(1)).join(", ")})`;
}

export function rigKernel(facts: FurnaceSceneFacts): string {
  const count = Math.max(0, ...[...facts.parts.values()].map((part) => part.index)) + 1;
  const parent = new Array<number>(count).fill(0);
  const pivot = new Array<string>(count).fill("vec3f(0.0)");
  const cases: string[] = [];
  for (const rig of RIG) {
    const part = facts.parts.get(rig.name);
    if (part === undefined) throw new Error(`rigKernel: the GLB has no part "${rig.name}".`);
    pivot[part.index] = wgslVec3(part.pivot);
    if (rig.parent !== undefined) {
      const up = facts.parts.get(rig.parent);
      if (up === undefined) throw new Error(`rigKernel: part "${rig.name}" names a missing parent "${rig.parent}".`);
      parent[part.index] = up.index;
    }
    const m = rig.motion;
    const body =
      m.kind === "translate"
        ? `q.position = q.position + ${vecLiteral(m.axis)} * ctx.params.${m.param};`
        : m.kind === "rotate"
          ? `let r = axisAngle(${vecLiteral(m.axis)}, ctx.params.${m.param}); q.position = pivot + r * (q.position - pivot); q.normal = r * q.normal;`
          : m.kind === "liftSwing"
            ? `let r = axisAngle(vec3f(0.0, 1.0, 0.0), ctx.params.${m.swing}); q.position = pivot + r * (q.position - pivot) + vec3f(0.0, ctx.params.${m.lift}, 0.0); q.normal = r * q.normal;`
            : m.kind === "ropes"
              ? (() => {
                  const hook = facts.parts.get(m.hookPart);
                  if (hook === undefined) throw new Error(`rigKernel: ropes name a missing hook "${m.hookPart}".`);
                  const rest = Math.max(0.01, part.pivot[1] - hook.pivot[1]);
                  // The ropes hang from the drum: stretch along Y about the drum line so their
                  // lower ends follow the hook.
                  return `let stretch = max(0.01, (${rest.toFixed(4)} - ctx.params.${m.hook}) / ${rest.toFixed(4)}); q.position.y = pivot.y + (q.position.y - pivot.y) * stretch;`;
                })()
              : `q.uv.${m.uv === "u" ? "x" : "y"} = q.uv.${m.uv === "u" ? "x" : "y"} + ctx.params.${m.param};`;
    cases.push(`    case ${part.index}u: { ${body} }`);
  }
  const params = RIG_PARAMS.map((param) => `  ${param.name}: f32, // @default ${param.rest}  ${param.help}`).join("\n");
  return `// T1354b — the machine rig (generated by src/projects/furnace/rig-kernel.ts from the GLB).
// Each vertex's part is surface.w; its motion applies about the part's REST pivot, then its
// parent's, child first. Stateless: the rest pose is read from upstream every frame.
struct Params {
${params}
};

const RIG_PARTS: u32 = ${count}u;
const RIG_PARENT = array<u32, ${count}>(${parent.map((value) => `${value}u`).join(", ")});
const RIG_PIVOT = array<vec3f, ${count}>(${pivot.join(", ")});

fn axisAngle(axis: vec3f, angle: f32) -> mat3x3f {
  let c = cos(angle);
  let s = sin(angle);
  let t = 1.0 - c;
  let a = normalize(axis);
  return mat3x3f(
    vec3f(t * a.x * a.x + c, t * a.x * a.y + s * a.z, t * a.x * a.z - s * a.y),
    vec3f(t * a.x * a.y - s * a.z, t * a.y * a.y + c, t * a.y * a.z + s * a.x),
    vec3f(t * a.x * a.z + s * a.y, t * a.y * a.z - s * a.x, t * a.z * a.z + c),
  );
}

fn moveOne(part: u32, p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let pivot = RIG_PIVOT[part];
  switch part {
${cases.join("\n")}
    default: {}
  }
  return q;
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  var part = u32(max(p.surface.w, 0.0) + 0.5);
  // Child first, then each ancestor — at most six levels (hook ← trolley ← bridge).
  for (var level = 0u; level < 6u; level = level + 1u) {
    if (part == 0u || part >= RIG_PARTS) { break; }
    q = moveOne(part, q, ctx);
    part = RIG_PARENT[part];
  }
  return q;
}`;
}
