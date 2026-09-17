/** One palette and transition curve for room shaders, fragment emission and scene lights. */
const COLOURS = [[1, 0.69, 0.39], [1, 0.055, 0.10], [0.95, 0.08, 0.52], [0.57, 0.16, 1], [0.12, 0.32, 1], [0.06, 0.82, 1], [0.50, 0.12, 1]] as const;
const SECONDS = 12;
export const RESONANCE_PALETTE_WGSL = `
fn resonancePalette(seconds:f32,amount:f32)->vec3f {
  let phase=seconds/${SECONDS}.0;
  let part=u32(floor(phase))%${COLOURS.length}u;
  let colours=array<vec3f,${COLOURS.length}>(${COLOURS.map(c=>`vec3f(${c.join(',')})`).join(',')});
  return mix(colours[0],mix(colours[part],colours[(part+1u)%${COLOURS.length}u],smoothstep(0.15,0.85,fract(phase))),clamp(amount,0.0,1.0));
}`;

/** The expression engine's arithmetic equivalent of the shared WGSL curve. */
export function resonancePaletteExpression(channel:0|1|2):string {
  const part=`mod(floor(abstime / ${SECONDS}), ${COLOURS.length})`;
  const t=`clamp((fract(abstime / ${SECONDS}) - 0.15) / 0.7, 0, 1)`;
  const fade=`(${t} * ${t} * (3 - 2 * ${t}))`;
  const sum=(next:boolean)=>COLOURS.map((_,i)=>`${COLOURS[(i+(next?1:0))%COLOURS.length]![channel]} * max(0, 1 - abs(${part} - ${i}))`).join(' + ');
  const base=COLOURS[0][channel];
  return `${base} + clamp(op('room1').par.paletteCycle, 0, 1) * ((1 - ${fade}) * (${sum(false)}) + ${fade} * (${sum(true)}) - ${base})`;
}
