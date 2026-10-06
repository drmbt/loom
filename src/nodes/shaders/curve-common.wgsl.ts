/**
 * T1586b — the one rule the curve shaders share: HOW A DIRECTION IS GIVEN A SIDE.
 *
 * Curve Frames seeds a strip's first frame with it (the normal leans toward Up) and the
 * Curve node's Arc picks its bow with it (the side leans toward Bow). Both are the same
 * question — "the unit vector square to this direction that leans toward that one, and a
 * fixed world axis when the two run together" — and `src/points/curve.ts` answers it once,
 * in `seedNormal`. So the WGSL is written once too: a second copy is how the frame of an
 * arc and the arc itself would come to disagree about which side is which (§V349).
 *
 * A FRAGMENT pasted into the passes that use it, not a shader in its own right — the brand
 * (`EmittedWgsl`) is for text that reaches a pass descriptor (§T1335b).
 */
export const CURVE_SEED_WGSL = `fn perpendicular(v: vec3f, axis: vec3f) -> vec3f {
  return v - axis * dot(v, axis);
}

/* The world axis least aligned with z: X before Y before Z on a tie. */
fn leastAligned(z: vec3f) -> vec3f {
  let a = abs(z);
  if (a.x <= a.y && a.x <= a.z) { return vec3f(1.0, 0.0, 0.0); }
  if (a.y <= a.z) { return vec3f(0.0, 1.0, 0.0); }
  return vec3f(0.0, 0.0, 1.0);
}

/* A unit normal for the direction z, leaning toward wanted. */
fn seedNormal(z: vec3f, wanted: vec3f) -> vec3f {
  var normal = perpendicular(wanted, z);
  if (dot(normal, normal) < 1.0e-12) { normal = perpendicular(leastAligned(z), z); }
  return normal / sqrt(dot(normal, normal));
}`;
