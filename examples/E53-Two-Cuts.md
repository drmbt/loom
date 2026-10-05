# E53 — Two Cuts

The same subject, cut two ways, side by side: a diptych comparing the two answers this
catalogue has to "separate the person from the background". LEFT, warm: the Matte node.
RIGHT, cool: the Person Mask. One source, one flip, two philosophies.

## The comparison, honestly costed

`matte1(matte)` is a **downloaded model** — MODNet or RVM through onnxruntime, hash-pinned
and reproducible (§V858), producing a **soft alpha** with hair-level detail at ~30 ms
in-page on WebGPU (slower without cross-origin isolation; the node reports its regime).
`personmask_seg(personMask)` is the **operating system's own** Vision segmentation over the local
helper — a **hard class mask**, zero weights, zero download, nothing to verify, 20–35 ms
helper-side, macOS only. Neither is "better": one is reproducible and portable, the other
is instant to adopt and answers with the OS's own idea of a person. Put both on one frame
and the edge quality, the latency and the failure modes stop being prose.

## Both coverages are spent

Each side's haze saturates with **its own** cut's coverage — `matte1:coverage` warms the
left, `personmask_seg:coverage` cools the right — so "found nobody" is a value on both sides, and a
DISAGREEMENT between the two cuts shows as a saturation imbalance across the seam before
anyone squints at edges.

## Shipped look, and the flip

The default source is the deterministic understudy (`switch_src(switch)` at 0), which contains
no person: both cuts honestly find nobody, both keys go dark, and what ships is the
two-tone animated diptych with the stand-in glowing through at low brightness on both
sides. Flip `switch_src` to 1 with a webcam to appear twice at once — the left half also wants
the matte model downloaded (the node's notice offers it), the right half wants the local
helper (`pnpm helper`) on macOS. Each half degrades alone: whichever cut is unavailable
goes dark on its side and says why, while the other keeps cutting.

Nodes: `noise_bed(noise)` → `switch_src(switch)` ← `webcam1(webcam)`; `switch_src` → `matte1(matte)` →
`multiply_keyM(multiply)` ← `switch_src`; `switch_src` → `personmask_seg(personMask)` → `multiply_keyV(multiply)` ← `switch_src`;
`switch_src` → `level_dim(level)`; `noise_hazeW(noise)` → `level_washW(hsv)`; `noise_hazeC(noise)` → `level_washC(hsv)`;
`level_washW` → `add_baseL(add)` ← `level_dim`; `level_washC` → `add_baseR(add)` ← `level_dim`; `multiply_keyM` →
`over_leftC(over)` ← `add_baseL`; `multiply_keyV` → `over_rightC(over)` ← `add_baseR`; `ramp_gateL(ramp)`,
`ramp_gateR(ramp)` gate the halves through `multiply_halfL(multiply)` / `multiply_halfR(multiply)` into
`add_sum(add)` → `output1(output)`.
