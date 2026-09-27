/**
 * T1407b — motion as EXPRESSIONS for the On Nothing shots: keyed curves measured off the
 * reference frame by frame, and a handheld drift. Everything returns expression source over
 * a time variable (`abstime`, seconds), so a knob stays drivable in the app.
 */

const num = (value: number): string => (Math.abs(value) < 1e-6 ? "0" : Number(value.toFixed(5)).toString());

/**
 * A curve through `keys` ([time s, value]): each span eased with smoothstep, flat before the
 * first key and after the last. A key marked "snap" in its third slot eases the span INTO it
 * out only, for a staccato hit: fast start, soft landing.
 */
export function keyed(t: string, keys: readonly (readonly [number, number, "snap"?])[]): string {
  if (keys.length === 0) throw new Error("keyed: no keys.");
  const first = keys[0]!;
  const terms = [num(first[1])];
  for (let i = 1; i < keys.length; i += 1) {
    const [t0, v0] = keys[i - 1]!;
    const [t1, v1, kind] = keys[i]!;
    if (t1 <= t0) throw new Error(`keyed: key times must rise (${t0} → ${t1}).`);
    const delta = v1 - v0;
    if (Math.abs(delta) < 1e-9) continue;
    const x = `clamp((${t} - ${num(t0)}) / ${num(t1 - t0)}, 0, 1)`;
    const eased = kind === "snap" ? `(1 - (1 - ${x}) ^ 3)` : `(${x} ^ 2 * (3 - 2 * ${x}))`;
    terms.push(`${num(delta)} * ${eased}`);
  }
  return terms.join(" + ");
}

/**
 * A handheld drift: three incommensurate sines per axis, amplitude halving with each
 * octave, so it reads as a breathing operator rather than a wobble. `seed` decorrelates axes.
 */
export function handheld(t: string, amplitude: number, seed: number, rate = 1): string {
  const f = [0.61, 1.37, 2.93].map((value) => value * rate);
  const a = [1, 0.45, 0.18].map((value) => value * amplitude);
  return f.map((freq, index) => `sin(${t} * ${num(freq)} + ${num(seed * (index + 1) * 1.618)}) * ${num(a[index]!)}`).join(" + ");
}
