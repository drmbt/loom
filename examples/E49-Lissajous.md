# E49 — Lissajous

An X-Y oscilloscope, simulated by its own physics. Two sine waves into the deflection
channels — a 3:2 Lissajous figure in phosphor green, tumbling as the phase between the
channels creeps — drawn by the same `laserPath` planner the laser example runs at full
strength. A scope in X-Y mode IS a vector display: the scope is the laser with the
planner turned down, so `laserpath_scope` sets corner hold to zero (an electron beam has no
mirrors to settle) and keeps only the resampling and the scanner's clock.

## Brightness is dwell time, and nothing here paints it

The kernel samples the figure uniformly in θ, but the figure's own speed varies — a
Lissajous decelerates into its turning points — so samples crowd where the beam moves
slowly, and under additive blending crowded samples ARE brightness. The lobes glow at
their extremes exactly where a real CRT brightens, because it is the same arithmetic
the CRT does with electrons: constant energy per tick, more ticks per unit length
where the beam is slow.

## The sweep is the honest refresh rate

The plan is ~1,200 samples against the 500-point budget of 30,000 points/second at
60 fps, so the scan window sweeps the figure at its real ~25 Hz: the bright drawing
head chasing around the trace is the beam, and the tail behind it is `feedback_echo` — the
phosphor, a `feedback` loop at persistence 0.9 (1/e in ten frames, a P31 phosphor's
order of magnitude). Nothing fakes the flicker; the frame genuinely takes longer than
a display refresh, which is what §T947 means by simulating the scan rate honestly.

```
kernel_gen(pointKernel) ─► laserpath_scope(laserPath) ─► points_draw(renderPoints) ─► add_trace(add) ◄─ feedback_echo(feedback)
add_trace ─► threshold_hot(threshold) ─► blur_halo(blur) ─► add_glow(add) ─► output1
```

| Node | Type | Doing |
| --- | --- | --- |
| `kernel_gen` | `pointKernel` | the signal: x = sin(3θ + φt), y = sin(2θ), straight into clip space — a scope face is 2D |
| `laserpath_scope` | `laserPath` | the planner in scope trim: resampling on, corner hold zero, a real 30 kpps clock |
| `points_draw` | `renderPoints` | the beam spot: small soft additive splats, colour mapped from the plan's scan window |
| `add_trace` | `add` | this frame's beam over the decaying glass |
| `feedback_echo` | `feedback` | the phosphor: persistence 0.9, the tail the sweeping beam leaves behind |
| `threshold_hot` | `threshold` | only what the beam deposited may glow |
| `blur_halo` | `blur` | the glass glow, 22 px |
| `add_glow` | `add` | trace plus halo |
| `output1` | `output` | the screen |
