import { wgsl } from "./wgsl.ts";

/** Display inspection only. Both the source and checker are linear light. */
export const ALPHA_DISPLAY_WGSL = wgsl`fn displayCheckerLinear(position: vec2f, size: f32) -> vec3f {
  let cell = floor(position / max(size, 1.0));
  let odd = (u32(abs(cell.x)) + u32(abs(cell.y))) % 2u;
  return vec3f(select(0.18, 0.32, odd == 1u));
}

fn compositeCoverageLinear(colour: vec3f, alpha: f32, position: vec2f, size: f32) -> vec3f {
  // Only bounded alpha denotes coverage. Arithmetic alpha outside [0,1] displays RGB.
  if (!(alpha >= 0.0 && alpha <= 1.0) || alpha == 1.0) { return colour; }
  let checker = displayCheckerLinear(position, size);
  // Fully invisible colour may contain NaNs; it must not contaminate the checker.
  if (alpha == 0.0) { return checker; }
  return mix(checker, colour, alpha);
}`;
