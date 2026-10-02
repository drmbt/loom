# E82 — Set List

A small set you can play. Two looks sit on a layer stack, a glitch effect sits on top as its
own layer, and a Corner Pin fits the result to a surface. Three preset banks hold the
settings, a cue list holds the running order, and one Panel, the Show desk, puts it all under
your hand and on your phone. The network carries the same explanation in coloured note boxes
beside the nodes.

```
source(noise) ─► layerRings(layer) ─► layerGrid(layer) ─► layerFx(layer) ─► dim(level) ─► pin(cornerPin) ─► onBlack(over) ─► out(output)
                                                                                           black(solid) ─► onBlack(over)

look A   ringsSrc(ramp) ─► rings(hsv)                          shown by layerRings(layer), by name
look B   gridSrc(checker) ─► grid(transform)                   shown by layerGrid(layer), by name
FX       layerGrid(layer) ─► shear(displace) ─► glitch(hsv)    shown by layerFx(layer), by name
         tear(noise) ─► shear(displace)

looks(presets)   dawn, noon, riot            both looks' settings
fx(presets)      clean, dirty, acid          the glitch chain's settings
shots(presets)   open, cross, drop, out      layers on or off, their opacity, and which looks and fx presets
set(cueList)     1 open, 2 warm, 3 cross, 4 drop, 5 out

master(slider) ─► desk(panel)
keystone(slider) ─► desk(panel)     the desk also shows shots, set and layerFx, by name
```

Press GO on `desk`, or on `set` in the Inspector, and the set starts.

## Looks

A look is a picture that a layer shows. Here there are two, each a generator and one filter:
`ringsSrc` into `rings`, and `gridSrc` into `grid`. A look can be any chain of nodes, or a
component you saved from one.

`source` is the input at the bottom of the stack. It is a Noise so the file needs no hardware.
To use a camera, wire a Webcam into `layerRings` in its place. A paired phone can be that
camera: pick the device **Phone · \<name\>** in the Webcam node.

## Layers

The stack runs left to right: `source`, then `layerRings`, `layerGrid` and `layerFx`. A
Layer's input, Below, is the stack under it. What the layer adds is named in its **Picture**
field: type a node's name there and a dashed line shows the link. `layerRings` names `rings`
and `layerGrid` names `grid`. To put a different look on a layer, change the name.

- **Off is bypass.** A bypassed layer passes the stack through and its look stops rendering,
  so a layer that is off costs nothing.
- **Opacity is the fade.** At 0 the layer shows nothing, but its look still renders until you
  switch the layer off.
- **Blend** is how the picture meets the stack: `layerRings` is Screen, `layerGrid` is
  Multiply.

`layerFx` is the effect layer. The glitch chain reads the stack (`shear` displaces it row by
row using `tear`, then `glitch` shifts its colour), and `layerFx` names the end of that chain,
`glitch`. Its blend is Replace, so its Opacity is the wet/dry of the effect.

The file opens with all three layers on, the rings at 0.25 and the other two at 0. The first
cue switches the two idle layers off.

## Banks: Store and Recall

A Presets node is a bank. Its **Targets** field lists what it holds: a node name for every
setting of that node, or `node.key` for one setting. Select a bank and use its Inspector
section:

- **Store** saves the targets' current settings under a name.
- **Recall** writes a preset's settings back, all at once, as one undo step.

A preset keeps each setting exactly as it was stored. In `looks`, the preset `riot` holds an
expression for the grid's rotation, `sin(abstime * 0.7) * 45`, and recalling `riot` brings the
expression back, so the grid keeps rocking. Recalling `dawn` afterwards puts the plain number
back.

With **Morph** above zero a recall fades to its values instead of cutting. Numbers, vectors
and colours fade. A switch or a menu cuts at the start.

## Shots

A shot is a preset that sets layers and recalls presets from other banks in the same step.
The `shots` bank holds four:

| shot | layers | recalls | morph |
| --- | --- | --- | --- |
| `open` | rings on at 1, grid off, FX off | `looks` dawn, `fx` clean | 2 s |
| `cross` | grid on, fading up to 1 | nothing | 2 s |
| `drop` | rings off, FX on at 0.85 | `looks` riot, `fx` dirty | cut |
| `out` | rings on at 1, grid and FX fading to 0 | `looks` dawn | 4 s |

A layer switches on or off at the start of the shot; only its opacity fades. So `cross`
switches the grid layer on and fades it up, and `out` fades the grid and the effect down to 0
and leaves those layers on. Switching them off is the next cue's job, which here is `1 open`.

A shot's own values win over what it recalls. You write `on` and `recalls` by hand in the
bank's Presets field; that field's description gives the format.

## The cue list

`set` is the running order. Each cue names a bank and one of its presets, and can carry its
own morph time.

| cue | fires | morph | what you see |
| --- | --- | --- | --- |
| 1 open | `shots` open | 2 s, from the shot | the rings come up to full |
| 2 warm | `looks` noon | 4 s | the rings tighten and turn warmer |
| 3 cross | `shots` cross | 1 s, linear | the grid fades in over the rings |
| 4 drop | `shots` drop | cut | rings off, riot colours, the glitch on |
| 5 out | `shots` out | 4 s | back to the rings alone |

**GO** fires the next cue and moves on. **BACK** fires the cue before the current one. A cue's
morph time beats the shot's, which beats the bank's. Wrap is on, so GO after `5 out` goes
round to `1 open`. One undo takes a GO back, and the next GO fires the same cue again.

There is a GO key and a BACK key. Help lists them on its Shortcuts tab as "Cue list: GO" and
"Cue list: BACK". They act on the cue list whose Keys switch is on.

A cue can fire any preset, not only a shot: `2 warm` recalls `noon` from the `looks` bank
directly and leaves the layers alone.

## Mapping

`pin` is a Corner Pin, the last stage before the output. It pins the picture's four corners
onto your surface. Select it and drag the pins on its preview tile. `onBlack` puts the pinned
picture over `black`, so everything outside the corners is black, the way a projector shows
it.

The Keystone slider pulls the two top pins in: Pin Top Left x is
`op('keystone').chan.keystone` and Pin Top Right x is one minus that. `dim` is the master
level, and its Brightness is `op('master').chan.master`.

To send the picture to a projector, add a Window Out node, type `onBlack` into its Source field
and open its window on that screen.

## The Show desk and your phone

`desk` is a Panel. The two sliders join it by a wire into its Controls input. A bank, a layer
and a cue list have no value to wire, so they join by name: drop one on the Panel. Here the
board holds the `shots` bank as a row of buttons, `set` as GO and BACK with the current and
next cue, `layerFx` as a switch and a fader, and the Master and Keystone sliders. The pencil on
the Panel's header, or in the Controls tab, lets you move and resize them.

Its Phone switch is on, so a paired phone gets the same desk:

1. Start the helper with the phone door: `pnpm helper --phone`.
2. Pair it in Agent → Connections.
3. Press the phone icon on `desk`'s header and scan the QR code with a phone on the same wifi.
4. Accept the certificate once.

The phone sees this desk and nothing else in the project.
