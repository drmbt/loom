# E81 — Phone Desk

Four live controls drive a small picture, one Panel lays them out, and the Panel is published
to your phone. The last stage is a Corner Pin, so the phone drags a corner of the output the way
you would fit a projection onto a wall. The network carries the same explanation in coloured
note boxes beside the nodes.

```
rings1(ramp) ─► level1(level) ─► hue1(hsv) ─► pin1(cornerPin) ─► lay1(over) ─► out1(output)
                                                     bg1(solid) ─► lay1(over)

heat(slider)    drives level1 brightness
invert(toggle)  drives level1 invert
flash(button)   drives hue1 hueoffset, a quarter turn per press
warp(xyPad)     drives pin1's top-right corner

panel1(panel)   lays out heat, invert, flash and warp, with Phone on
```

`rings1` drifts slowly on its own, so the picture moves with nobody at the controls. `lay1`
puts the pinned picture over `bg1`, a black Solid, so everything outside the corners is black,
the way a projector shows it.

## Controls

A widget is a value node. It makes no picture; it holds one number you set by hand, and it
publishes that number under its Channel name. Drag the control on the node itself, or on the
Panel in the Controls pane. Slider, Toggle, Button and XY Pad are all in the node library.

- `heat` is a Slider from 0 to 2. Its channel is `heat`.
- `invert` is a Toggle, 1 when on and 0 when off.
- `flash` is a Button. `flash` is 1 while you hold it, and `flashCount` counts the presses.
- `warp` is an XY Pad. It publishes `warpX` and `warpY`.

## Mapping a parameter to a control

A parameter follows a control through an expression that reads the channel. There are two ways
to write one:

1. In the Controls pane, press **map…** under a widget, pick the node and the parameter, and
   press **map**.
2. Or type the expression into the parameter yourself: `op('heat').chan.heat`.

The expression is maths, so you can scale or combine what a control sends. `hue1`'s Hue Offset
is `op('flash').chan.flashCount * 90`, so every press turns the hue by a quarter, and four
presses bring it back. Each mapping keeps the value it had before, so the file still renders the
same picture where no controls are running.

## Mapping to a surface

`pin1` is a Corner Pin. It pins the picture's four corners onto any four points of the output.
Select it and drag the pins on its preview tile until the picture fits your wall. Here the
top-right pin follows the pad: its Pin Top Right x is `op('warp').chan.warpX` and its y is
`op('warp').chan.warpY`. The map… form only offers single numbers, so a corner is mapped by
typing the expression into each of its two fields.

## The Panel

`panel1` is what the Controls pane shows. Its Layout has one row per line:

- `# Picture` is a heading.
- `> Heat is brightness. Invert flips it.` is a note.
- `heat invert` puts those two widgets side by side.

Its **Phone** switch is on, which publishes this panel to a paired phone. A phone sees only
published panels, and nothing else in the project.

## Your phone

1. Start the helper with the phone door: `pnpm helper --phone`.
2. Pair it in Agent → Connections.
3. Press **Phone** in the Controls pane and scan the QR code with a phone on the same wifi.
4. Accept the certificate once. The phone shows the Phone Desk panel, and moving a control
   there moves it here.
