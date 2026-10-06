# E40 — Wake

Something moves across a still field and leaves a burning trail behind it. The trail is
**inferred**, by subtracting the picture from its own past.

It is not drawn — nothing in this graph knows where the subject is — and it is coloured by
how long ago each pixel moved.

This is the one file in the set whose subject is *change itself*, which means no single
frame can tell you whether it works.

**It opens playing its own performer, and your footage is one number away.**

## Graph

```
noise_bed(noise, perlin4d) ────────┐
circle_orb(circle) ┄ lfo_pathx/y   ┴─► add_stand(add) ─┐ order 0
                                                        ├─► switch_pick(switch, index 0) ─┬─► cache_past(cache)
movie_clip(movieFileIn) ────────────────────────────────┘ order 1                         │      6 frames back
                                                                                          │      │
                              level_under(level, brightness 0.2) ◄────────────────────────┤      │
                                                                                          ▼      ▼
                                                             difference_moved(difference)
                                                                                  │
                                     level_gain(level, whitelevel ┄ limit_bite) ◄──┘
                                                        │
                             ┌──────────────────────────┼──────────────────────────────┐
        transform_shiftr(transform) ┄ limit_tear   (unshifted green)   transform_shiftb(transform) ┄ limit_tearn
                             └─► reorder_fuser(reorder) ─► reorder_fuseb(reorder) ◄────┘
                                                                │
                              add_born(add) ◄───────────────────┘        feedback_loop(feedback, source add_born)
                                        │  ▲                        persistence ┄ limit_hold
                                        │  └────────────────────────────┘
                                        ▼
                        lookup_paint(lookup) ◄─ ramp_palette(ramp)
                                          │
              level_under ─► add_lay(add) ◄┘ ─► level_trim(level) ─► output1

pattern_beat(audioPattern) ─► lag_smooth(valueLag) ─┬─► math_biteg ─► math_biteb ─► limit_bite(valueLimit)
                                                    ├─► math_tearg ─► math_tearb ─► limit_tear(valueLimit)
                                                    ├─► math_tearng ─► math_tearnb ─► limit_tearn(valueLimit)
                                                    └─► math_holdg ─► math_holdb ─► limit_hold(valueLimit)
```

## A Cache is a delay line; here it is an instrument

E24 reads three cache taps as an RGB delay, which uses the ring as an echo — one frame's
picture, arriving late. This file uses it to ask a different question. `cache_past` holds the
frame from six frames ago, `difference_moved` takes the absolute difference against the live one, and
what comes out is not a picture at all: it is a **motion field**, bright exactly where the
image changed and black everywhere it did not.

Every node downstream is a reading of that field rather than of the picture. That is the
whole example, and it is why `cache` earns a second appearance in the set doing something
E24 does not.

The signature of the technique is visible and worth recognising: a moving disc produces
**two** crescents, one where it arrived and one where it left. Frame differencing cannot
tell those apart — it only knows the pixel changed — and pretending otherwise would need
optical flow, which is a different and much larger thing.

## The understudy has to move, and that is not decoration

§V363 says a demo must demonstrate itself. An example whose subject is change has a harsher
version of that rule: it has **no null state that looks like anything**.

The first version of this graph used a `perlin3d` for its performer. `speed` on the Noise
node advances the *fourth* dimension, a 3D noise does not have one, and so the field never
changed — and the entire file rendered **pure black**, with every structural test in the
tree green about it. Not dim. Black.

So `noise_bed` is a `perlin4d` with a real `speed`, and the subject is `circle_orb` riding two LFOs.
The bed is nearly still **on purpose**: an earlier cut had it evolving about as fast as the
subject travelled, the detector saw motion everywhere at once, and the subject never stood
out. Something has to hold still for a wake to be a wake *on*.

`level_under` is that same source at a fifth brightness, laid back underneath at the end. It is
the context — it is what tells you the trail is being extracted from a picture rather than
generated — and it is also what keeps frame 0 off the floor while the cache ring is still
filling (§V229).

## Grade after the accumulator, so the palette axis is age

The obvious wiring puts the Lookup before the loop, and it is wrong. The loop then sums
*graded colour*: the head pins white, the tail carries no hue, and the palette is doing
nothing but tinting.

Feeding the **raw** motion into the accumulator and grading what comes out makes the ramp a
map of *how long ago a pixel moved* — fresh reads warm and white, older reads teal, oldest
falls to blue and out. So the loop closes on `add_born`, upstream of `lookup_paint`, and not on the
final output. That inverts §V471.5 for the same reason E34 inverts it: a loop closing on the
finished frame would smear the still bed along with the wake, and the bed is the thing that
must not move.

## No subtractive offset inside a float loop

This graph had a Level inside the loop with `blacklevel: 0.008`, copying E1's idiom for
terminating a trail. E1's docstring says black level "crushes the dimmest survivors to zero",
which is true in a unorm format and **false** in the `rgba16float` we actually ship.

An empty pixel went to −0.008, the loop drove it further down every frame, and the
downstream Add then came out *darker than its own base layer* — `add_lay` measured a median of
0.0000 where `level_under` alone measured 0.0666. The bed vanished completely and it read as the
compositor being broken.

Persistence is already the decay and it cannot go negative, so the node is gone rather than
fixed. E39's bloom hit the same trap from the other direction; between them they are why
§V694 is stated about black levels rather than about loops.

That rule is now a structural claim rather than a paragraph — and it went red on **this**
document within the hour, twice. `level_gain` carried a black level of 0.02, which sent a zero
pixel to −0.00917 and compounded to a −0.1835 floor inside the accumulator. `level_under`
carried 0.06, which sent a **black source pixel** to −0.064.

They were not equally bad, and the difference is the useful part. `level_gain`'s negative was
**contained**: `lookup_paint` is a Lookup, a Lookup clamps by indexing, so a negative index reads
the first stop and the value never escaped `add_born`. `level_under`'s was not — it feeds `add_lay`
directly, so it darkened the finished frame. And it was invisible here only because the
synthetic bed sits near 0.6 luma. It would have shown up the moment someone pointed `movie_clip`
at footage with real blacks, as a wake that thins over the dark parts of their video for no
visible reason, and it would have been reported as "the trails are broken on my clip".

Both are zero now; `whitelevel` and `brightness` already carried the range each was
nominally buying.

## What the audio actually does

Four gain-and-bias pairs, each ending in a `valueLimit` that states its range out loud:

- **low → `level_gain.whitelevel`**, clamped 1.6..3.2, *inverted*. A louder kick lowers the white
  point, which raises the gain, so the wake flares on the beat.
- **high → `transform_shiftr.t.x`** and **high → `transform_shiftb.t.x`**, clamped to ±0.001..0.03. Two pairs
  off one band with opposite bias, so red and blue tear apart in opposite directions and the
  hats put a chromatic edge on the trail.
- **level → `feedback_loop.persistence`**, clamped 0.92..0.972. Louder passages hold the trail
  longer, so the wake lengthens with the music instead of running at a fixed decay.

Those numbers are fitted to a **measured** field, not an estimated one, and that distinction
cost real time: `difference_moved` peaks around 0.058 when the subject crawls and around 0.756 when it
moves at performance speed — thirteen times — and a white point guessed against the wrong
one mapped the field's median to 0.86 and blew the frame white.

Swap `pattern_beat` for an `audioFileIn` and point it at a track; the pairs are already scaled for
the analyser's decibel domain, which is what the pattern node publishes in.

## Why the claims are asserted across frame pairs

A still frame of this file is evidence about a moment, not about a motion (§V681). Every
interesting property here — that the difference is against a *delayed* frame, that only the
motion enters the loop, that the bed does not smear — is a statement about correspondence
between frames, and a single rendered frame cannot see any of it. The structural claims name
the wiring; the look baseline catches drift; neither is a substitute for the other.

## The understudy, again

`switch_pick` opens on branch 0 and `movie_clip` is still in the graph, still in the plan, and still
compiled on a real device by `examples.gpu.test.ts`. Set `switch_pick.index` to 1 and drop a file
into `movie_clip` and it is your footage — and this is the graph where that matters most, because
frame differencing on real video is what the technique was invented for. A `webcam` wired as
branch 2 works the same way; E27 established the pattern.

## Numbers

Look baseline (§V643), measured by the liveness instrument at 192×108 — see
`src/examples/look-baselines.json` for the current row rather than trusting a number copied
into prose.
