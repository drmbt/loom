# E81 — Phone Desk

Four live controls drive a small picture, one Panel shows them, and the Panel is published
to your phone. The last stage is a Corner Pin, so the phone drags a corner of the output the way
you would fit a projection onto a wall. The network carries the same explanation in coloured
note boxes beside the nodes.

```
ramp_rings(ramp) ─► level1(level) ─► hsv_hue(hsv) ─► cornerpin1(cornerPin) ─► over_lay(over) ─► output1(output)
                                                     solid_background(solid) ─► over_lay(over)

slider_heat(slider)    drives level1 brightness
toggle_invert(toggle)  drives level1 invert
button_flash(button)   drives hsv_hue hueoffset, a quarter turn per press
xypad_warp(xyPad)      drives cornerpin1's top-right corner

slider_heat(slider) ─► panel1(panel)
toggle_invert(toggle) ─► panel1(panel)
button_flash(button) ─► panel1(panel)
xypad_warp(xyPad) ─► panel1(panel)     wired in this order, with Phone on
```

`ramp_rings` drifts slowly on its own, so the picture moves with nobody at the controls. `over_lay`
puts the pinned picture over `solid_background`, a black Solid, so everything outside the corners is black,
the way a projector shows it.

## Controls

A widget is a value node. It makes no picture; it holds one number you set by hand, and it
publishes that number under its Channel name. Drag the control on the node itself, or on the
Panel. Slider, Toggle, Button and XY Pad are all in the node library.

- `slider_heat` is a Slider from 0 to 2. Its channel is `slider_heat`, and it is the picture's brightness.
- `toggle_invert` is a Toggle, 1 when on and 0 when off. It flips the picture.
- `button_flash` is a Button. `button_flash` is 1 while you hold it, and `flashCount` counts the presses.
  Each press turns the hue a quarter.
- `xypad_warp` is an XY Pad. It publishes `warpX` and `warpY`, and drags the picture's top-right
  corner.

## Mapping a parameter to a control

Mapping starts from the parameter you want to move:

1. In the Inspector, right-click the parameter and choose **Control from Panel**. That makes
   the fitting control (a slider with the parameter's own range, a toggle for a switch, an
   XY pad for a pair), binds the parameter to it and adds it to the Panel, as one undo step.
2. To bind a control you already have, right-click the parameter and choose
   **Drive from ▸** and the control's caption.

A bound parameter shows a chip with the control's caption, such as **← Heat**; its × unbinds it.

Underneath, the binding is an expression that reads the channel: `op('slider_heat').chan.heat`. You
can type one yourself, and because it is maths you can scale or combine what a control sends.
`hsv_hue`'s Hue Offset is `op('button_flash').chan.flashCount * 90`, so every press turns the hue by a
quarter, and four presses bring it back. Each binding keeps the value the parameter had
before, so the file still renders the same picture where no controls are running.

## Mapping to a surface

`cornerpin1` is a Corner Pin. It pins the picture's four corners onto any four points of the output.
Select it and drag the pins on its preview tile until the picture fits your wall. Here the
top-right pin follows the pad: its Pin Top Right x is `op('xypad_warp').chan.warpX` and its y is
`op('xypad_warp').chan.warpY`. Pin Top Right is a pair, so **Control from Panel** on it makes an
XY pad that drives both.

## The Panel

`panel1` is the surface. A widget joins it by a wire: the widget's `out` into the Panel's
**Controls** input. Dropping a widget node onto the Panel makes the same wire. A new widget
lands in the first free spot of the Panel's board; here the board is arranged: the pad a
square on the right, `slider_heat` a bar under a "Picture" label, `toggle_invert` and `button_flash` side by side.
Press the pencil on the Panel's header, or in the Controls tab, to arrange it yourself: drag a
control to move it, drag its corner to resize it, add labels.

The Panel's body on the canvas is the same board, live: move a control there and the picture
follows. The Controls tab is a bigger view of the same Panel. The phone icon on the Panel's
header publishes it (its **Phone** switch is on here). A phone sees only published panels, and
nothing else in the project.

## Your phone

1. Start the helper with the phone door: `pnpm helper --phone`.
2. Pair it in Agent → Connections.
3. Press the phone icon on `panel1`'s header and scan the QR code with a phone on the same wifi.
4. Accept the certificate once. The phone shows the Phone Desk panel, and moving a control
   there moves it here.

A phone can also be a camera: in a Webcam node, pick the device **Phone · \<name\>**.
