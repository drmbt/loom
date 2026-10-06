# An integer divide of the high half of a 32-bit value is wrong on Apple GPUs (B263)

2026-10-06. What was measured, whose bug it is, what Loom does about it, and two texts ready to file. Nothing has been filed.

Machine for every figure: Apple M3 Max, macOS 26.3.1 (a) (build 25D771280a), Metal. Through Dawn (the pinned `vgpu` 0.5.0, headless Node) unless a line says "pure Metal". One machine and one OS version; section 8 lists what was not tried.

## 0. The answer

- **The line.** `(x >> 16u) % 97u`, the obvious way to draw one of 97 lots from a hash. On this GPU it returned 15872 for x = 96, where the answer is 0, and a wrong value for about 500 of 512 inputs. The quotient `(x >> 16u) / 97u` is wrong the same way. The shift itself, every mask and every multiply beside it are right.
- **Both stages.** A compute kernel and a fragment shader return the same wrong values.
- **Whose bug.** Apple's. A Metal kernel with no Dawn and no Tint returns the same 15872. The Metal source Tint generates is valid, and Metal alone computes it wrong.
- **The trigger, exactly**, read from Apple's own compiler output: a 16-bit `udiv` or `urem` by a constant that is not a power of two, whose dividend is the top 16 bits of a 32-bit value (`trunc (lshr x, 16)`). The same divide of the top 15 bits (`lshr x, 17`) is right.
- **What Loom does.** A stock helper that draws the lot without a divide (`hashLot`, `// @use lot`); a compiler warning on the author's node and line for the shape; a gate that keeps it out of everything that ships; a canary and a pure-Metal reproduction under `tools/`.
- **No stock node and no shipped document has the shape.** Searched, and now gated.

## 1. The observation

The consumer (sentinel-bot) wrote, in a Material · WGSL:

```wgsl
let a = u32(pair + 0.5);
let m = ((a + 2931u) * 2654435761u) >> 16u;
```

and read back `m / 97u`, `m % 97u` and `m % 100u`. Reproduced through the real compiler and backend, the same line in a Point Kernel and in a Material · WGSL:

| a | m (GPU = CPU) | `m / 97u` GPU, CPU | `m % 97u` GPU, CPU | `m % 100u` GPU, CPU | `(m * 100u) >> 16u` | `m & 255u` |
|---|---|---|---|---|---|---|
| 5 | 35899 | 386, 370 | 63993, 9 | 59035, 99 | 54, right | 59, right |
| 6 | 10867 | 105, 112 | 682, 3 | 2767, 67 | 16, right | 115, right |
| 7 | 51370 | 499, 529 | 2967, 57 | 12170, 70 | 78, right | 170, right |
| 8 | 26338 | 217, 271 | 5289, 51 | 21538, 38 | 40, right | 226, right |
| 9 | 1305 | 612, 13 | 7477, 44 | 30841, 5 | 1, right | 25, right |

- Kernel: all 48 divide and remainder results of sixteen points differ from the CPU; `m` itself matches on all sixteen.
- Material: 386 against 370 for a = 5, which is the consumer's figure. a = 13 to 16 give 325, 719, 438 and 320 against 332, 74, 491 and 233.
- The multiply is not needed: `(x >> 16u) % 97u` on any u32 is wrong.

## 2. Whose bug it is

Three steps lie between the WGSL and the GPU. Each was read or run.

1. **Tint's Metal is right.** Dawn's `dump_shaders` toggle prints it. The shift is `((v_12 + 2931u) * 2654435761u) >> (16u & 31u)`, unsigned. A WGSL `/` becomes a helper that guards a zero divisor, as WebGPU requires, and `%` becomes that divide, a multiply and a subtract:

   ```metal
   uint tint_div(uint a, uint b) { return (a / select(b, 1u, (b == 0u))); }
   uint tint_mod(uint a, uint b) { return (a - ((a / select(b, 1u, (b == 0u))) * select(b, 1u, (b == 0u)))); }
   ```

2. **Apple's front end emits a correct program.** `xcrun -sdk macosx metal -S -emit-llvm` on that Metal gives, for the consumer's line:

   ```llvm
   %22 = lshr i32 %21, 16
   %23 = trunc i32 %22 to i16
   %24 = udiv i16 %23, 97
   %26 = urem i16 %23, 97
   ```

   Narrowing the divide to 16 bits is legal: the value fits. Read as written, this is right.

3. **The device returns garbage for it, in pure Metal too.** `tools/apple-gpu-divide-metal.swift` compiles one Metal kernel per line and runs it with the Metal API alone:

   | Kernel | x = 96 | 65536 | 6356992 | 305419896 | 2147483648 | 4294967295 | Verdict |
   |---|---|---|---|---|---|---|---|
   | `(x >> 16u) % 97u` | 15872 | 1 | 97 | 11705 | 7936 | 60 | **wrong** |
   | the CPU | 0 | 1 | 0 | 4 | 79 | 60 | |
   | `(x >> 16u) / 97u` | 0 | 0 | 1 | 48 | 337 | 675 | right |
   | `tint_div(x >> (16u & 31u), 97u)` | 512 | 0 | 0 | 603 | 256 | 675 | **wrong** |
   | the CPU | 0 | 0 | 1 | 48 | 337 | 675 | |
   | `tint_mod(x >> (17u & 31u), 97u)` | 0 | 0 | 48 | 2 | 88 | 78 | right |
   | `x % 97u` | 96 | 61 | 0 | 70 | 66 | 34 | right |

   The Metal source Dawn dumped for `(x >> 16u) / 97u`, run byte for byte by Metal alone, returned the same 512, 0, 0, 603, 256, 675.

So the fault is in Apple's Metal stack, after the front end's program. That is as far as this can be seen from outside: the step from that program to the GPU's machine code is not visible.

**Why the plain Metal quotient is right and Tint's is wrong.** Apple's output for each kernel:

| Kernel | What the front end emitted | On the device |
|---|---|---|
| `(x >> 16u) / 97u` | `udiv i32 %x, 6356992`: one 32-bit divide by 97 × 65536, no shift | right |
| `(x >> 16u) % 97u` | `lshr 16`, `trunc … to i16`, `urem i16 …, 97` | wrong |
| `tint_div(x >> (16u & 31u), 97u)` | `lshr 16`, `trunc … to i16`, `udiv i16 …, 97` | wrong |
| `tint_mod(x >> (16u & 31u), 97u)` | `lshr 16`, `trunc … to i16`, `urem i16 …, 97` | wrong |
| `(x >> 17u) % 97u` | `lshr 17`, `trunc … to i16`, `urem i16 …, 97` | right |

The plain quotient is right because the front end folds it into a 32-bit divide and the 16-bit one never exists. Through Tint's guard it is not folded, and the 16-bit divide is wrong. The remainder is wrong either way.

## 3. The trigger

**In Apple's intermediate code: a `udiv i16` or `urem i16` by a constant that is not a power of two, whose dividend is `trunc i32 (lshr i32 x, 16) to i16`.**

- The same 16-bit divide of `lshr x, 17` (15 bits), of `x & 65535` (the low half) and of a masked high half is right.
- A divisor from a buffer keeps the divide at 32 bits, and is right.
- A power of two becomes a shift, and is right.

**A hypothesis, marked as one.** This GPU's registers are addressed in 16-bit halves, and "the top 16 bits of x" is such a half. The divide-by-constant sequence appears to read the wrong bits of it. One sign: the result depends on the LOW half of x. x = 96 has a high half of 0 and returns 512 for the quotient and 15872 for the remainder; x = 0 returns 0 for both. Nothing more was established.

## 4. The shape in WGSL, as measured

`src/compiler/wgsl-high-half.cases.ts` is the table: 43 lines, each run on 512 values of x by `tools/apple-gpu-divide-canary.mjs` on 2026-10-06. `d` is 97, read from a buffer.

**Wrong** (14 lines; between 455 and 506 of 512 values each):

- `(x >> 16u) / 97u`, `% 97u`, `% 100u`, `/ 3u`, `/ 10u`, `/ 255u`, `/ 1000u`
- `(x / 65536u) % 97u` (a divide by 65536 is the same shift)
- `((x >> 8u) >> 8u) % 97u` (two shifts that add to 16)
- `u32(i32(x >> 16u) % 97)` (signed)
- `((vec2u(x, x + 1u) >> vec2u(16u)) % vec2u(97u)).x` (a vector)
- `((x * 2654435761u) >> 16u) % 97u` (the consumer's line)
- `(x >> 16u) - ((x >> 16u) / 97u) * 97u` (the remainder by hand)
- `(x >> 16u) % (97u | (d & 0u))` (the compiler folds the divisor back to 97; nothing in the text shows it)

**Right** (29 lines; 0 of 512 each):

- a power of two: `(x >> 16u) / 64u`
- a divisor from a buffer: `(x >> 16u) / d`, `(x >> 16u) % d`
- the whole word: `x / 97u`, `x % 100u`
- another shift: `>> 15u`, `>> 17u`, `>> 20u`, `>> 24u`, `>> 25u`
- the low half: `(x & 65535u) / 97u`, `(x % 65536u) / 97u`, `min(x, 65535u) / 97u`
- part of the high half: `((x >> 16u) & 255u) % 10u`, `((x >> 16u) & 4095u) % 97u`
- the middle: `((x >> 8u) & 65535u) % 97u`
- anything between the shift and the divide: `((x >> 16u) + 1u) % 97u`, `((x >> 16u) * 3u) % 97u`
- the same bits taken another way: `extractBits(x, 16u, 16u) % 97u`
- a float divide and a float remainder of `f32(x >> 16u)`
- a scale: `((x >> 16u) * 97u) >> 16u`, which is what `hashLot` is

## 5. What Loom does about it

**The helper** (`src/nodes/shaders/shared-modules.ts`). A shared module, `lot`, pulled in by `// @use lot`:

```wgsl
fn hashLot(h: u32, n: u32) -> u32 {
  return ((h >> 16u) * n) >> 16u;
}
```

- A lot in 0 .. n − 1 from any u32 hash, by a scale and not a remainder: one multiply, no divide. n up to 65536.
- Its CPU twin is `hashLotReference(hash, n)` beside it.
- `nodes/definitions/hash-lot.gpu.test.ts` holds the two equal on Dawn for 512 hashes: in a Point Kernel with n = 97, 100, 1024, 65536, 1 and a parameter; in a Custom WGSL of 32 × 16 pixels with n = 97, 1024 and one that differs per pixel.
- It is a module of its own and not part of `hash`: that text is in every shipped shader that includes the hashes, and adding to it would move all of them.
- The Point Kernel's and the Material · WGSL's descriptions name it.

**The warning** (`src/compiler/wgsl-high-half.ts`, code `compiler/wgsl-high-half-divide`). The compiler reads the text of every pass and warns once per division of the shape:

> Node "kernel_lot": \`m % 97u\` in its kernel, line 5 divides the high half of a 32-bit value by a constant. The WGSL is valid, and Apple GPUs return a wrong value for it.
>
> For a lot in 0..n-1 from a hash, add "// @use lot" and write hashLot(h, n). Otherwise take the bits with extractBits(x, 16u, 16u) before dividing; both are right on every GPU.

- **One site for every surface.** A Custom WGSL, a Material · WGSL, a kernel's code and spawn hook, a kernel's Group: each reaches a pass's text, and the pass's source map sends the position back to the author's node, parameter and line. A Material · WGSL is named, not the Render that draws it, and once, not once per pass.
- **A Geometry's Group** has no source map of its own. Its warning is on the Render that draws it, with the expression quoted.
- It rewrites nothing and refuses nothing: the code is valid and right on other GPUs.
- **What it flags**, inside one function: a `/` or `%` whose left operand is a bare high half (`(x >> 16u)`, shifts that add to 16, `(x / 65536u)`, a vector shifted by `vec2u(16u)`, any of them in `u32(…)` or `i32(…)`, or a `let` or `const` name bound to one or to another such name) and whose right operand is an integer constant that is not a power of two (a literal, `vec2u(97u)`, or a `let` or `const` name bound to a literal).
- **Held to the measured table.** For each of the 43 lines the detector's verdict must be the device's: every wrong line whose text shows why is flagged, and no right line is. One wrong line is listed as beyond it (the divisor the compiler folds).
- **What it cannot see**, being a reader of text: a high half that arrives as a function's result or argument, a `var`, and a divisor the compiler makes constant by itself. Its silence is not a measurement.

**The gate** (`src/examples/wgsl-high-half.test.ts`, on `test:gates`). Nothing that ships has the shape:

- the compiler's warning over every pass of every shipped example's plan (more than a thousand passes);
- every string anywhere in every shipped document, read as WGSL: 87 examples, the starter components and the project documents;
- the shared modules and the Render's two lit generators with their features on.

Seen red with the shape planted in the stock hash module: 45 example passes and the module walk.

**The search that preceded the gate.** Every right shift by 16 in the stock sources (9) and in the shipped documents (74) is the fold `x ^ (x >> 16u)` of a hash, whose result is a whole word. None is divided.

**The tools.**

- `node tools/apple-gpu-divide-canary.mjs`: every line of the table on this machine's device, through Dawn, against the recorded verdict. For after an OS, driver, Dawn or browser bump. Today: "the bug is here, and its shape is the recorded one (14 of 14 wrong lines are wrong, every right line is right)".
- `xcrun swift tools/apple-gpu-divide-metal.swift`: eight kernels in pure Metal. Today: 4 of 8 wrong.
- Neither is a gate. A suite must not go red because Apple fixed something.

## 6. For an Apple feedback report

**Title.** Metal: 16-bit unsigned divide and remainder by a constant return wrong values when the dividend is the high 16 bits of a 32-bit value (Apple M3 Max, macOS 26.3.1).

**Kernel.**

```metal
#include <metal_stdlib>
using namespace metal;

kernel void divide(device uint* out [[buffer(0)]],
                   const device uint* in [[buffer(1)]],
                   uint3 id [[thread_position_in_grid]]) {
  uint x = in[id.x];
  out[id.x] = (x >> 16u) % 97u;
}
```

**Expected and observed**, one thread per element:

| x | x >> 16 | expected | observed |
|---|---|---|---|
| 0 | 0 | 0 | 0 |
| 96 | 0 | 0 | **15872** |
| 65536 | 1 | 1 | 1 |
| 6356992 | 97 | 0 | **97** |
| 305419896 | 4660 | 4 | **11705** |
| 2147483648 | 32768 | 79 | **7936** |
| 4294967295 | 65535 | 60 | 60 |
| 2352562176 | 35897 | 7 | **4760** |

**Notes for the report.**

- `xcrun -sdk macosx metal -S -emit-llvm` shows `lshr i32 %x, 16`, `trunc … to i16`, `urem i16 …, 97` for this kernel, which is correct.
- `(x >> 17u) % 97u` is correct on the device (its program differs only in the shift), as are `x % 97u` and `(x >> 16u) % 64u`.
- `(x >> 16u) / 97u` is correct as written (the compiler folds it into `udiv i32 %x, 6356992`), and wrong as `a / select(b, 1u, b == 0u)` with a = x >> 16 and b = 97, where a `udiv i16` is emitted: 512 for x = 96, where the answer is 0.
- The result depends on the low 16 bits of x, which the expression does not use.
- In pure Metal only compute kernels were run. Through WebGPU (Dawn) a fragment shader returns the same wrong values as a compute shader.
- To run: `xcrun swift tools/apple-gpu-divide-metal.swift` from this repository (eight kernels, the GPU's values over the CPU's).

## 7. For a Dawn issue

**Title.** Metal backend, Apple silicon: `(x >> 16u) / C` and `(x >> 16u) % C` return wrong values for a constant C that is not a power of two (an Apple compiler bug that Tint's divide helper exposes).

**Shader.**

```wgsl
@group(0) @binding(0) var<storage, read> xs: array<u32>;
@group(0) @binding(1) var<storage, read_write> out: array<vec2u>;

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let x = xs[id.x];
  let high = x >> 16u;
  out[id.x] = vec2u(high % 97u, high / 97u);
}
```

**Expected and observed**, one invocation per element, Dawn on Metal, Apple M3 Max, macOS 26.3.1:

| x | x >> 16 | `high % 97u` observed | expected | `high / 97u` observed | expected |
|---|---|---|---|---|---|
| 0 | 0 | 0 | 0 | 0 | 0 |
| 96 | 0 | **15872** | 0 | **512** | 0 |
| 65536 | 1 | 1 | 1 | 0 | 0 |
| 6356992 | 97 | **97** | 0 | **0** | 1 |
| 305419896 | 4660 | **11705** | 4 | **603** | 48 |
| 2147483648 | 32768 | **7936** | 79 | **256** | 337 |
| 4294967295 | 65535 | 60 | 60 | 675 | 675 |
| 2352562176 | 35897 | **4760** | 7 | **321** | 370 |

**Notes for the issue.**

- The generated MSL is valid. Run by Metal alone it returns the same values, so the fault is Apple's (section 6 is the pure-Metal form).
- In plain Metal the quotient `(x >> 16u) / 97u` is right, because Apple's front end folds it into one 32-bit divide. Through `tint_div`'s `select(b, 1u, b == 0u)` it is not folded, a `udiv i16` of `trunc(lshr x, 16)` is emitted, and that is what the device gets wrong. The remainder is wrong in both forms.
- Right on the same device: a power-of-two divisor, a divisor that is not a constant, a shift by anything but 16, `extractBits(x, 16u, 16u) % 97u`, and anything between the shift and the divide.
- A fragment shader returns the same values as a compute shader.
- The same in an `i32` and in a `vec2u`.

## 8. Not checked

- Any other Apple GPU, any other macOS version, any Intel or AMD Mac.
- A browser. Chrome runs Dawn with its own version and toggles; Safari has its own WGSL compiler and so its own Metal, which may or may not form the 16-bit divide.
- A vertex stage.
- A negative `i32` dividend, and 64-bit or 8-bit forms of the same idea (the top 8 bits of a 16-bit value).
- Which of Tint's forms Apple's front end folds and which it does not, beyond the two measured.
- Why: the hypothesis of section 3 was not tested further.
- WGSL an author writes that hides the shape behind a function call. The warning does not see it; only the canary's kind of measurement would.
