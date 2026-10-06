# A wire that snaps: design

T1639b. Owner, 2026-10-06, from a reference video: "This kind of magnetic snapping, visual snap effect glow shimmer travel and the little electric spark indicator for the magnetic range and the drop to snap range is beautiful. I want this". This note is written before the build. It is built from the reference, not from the green and red rings the canvas had.

## 1. The reference, measured

10 s, 1006 x 720, 30 fps, read at full rate (every frame cut to PNG). Frame numbers are 1-based. Lengths are video pixels in the wide view, where a port dot has a radius of about 6.5 px, port rows are 57.5 px apart and the target node is 322 x 300 px.

| What | Measured | Frames |
| --- | --- | --- |
| Range in which the arc shows | on at 86 px and at 80 px from the dot's centre, off at 102 px and at 113 px. So 90 to 100 px: about 14 dot radii, 1.7 port rows, 0.3 node widths | 9 to 11, 64 to 66 |
| Ring | radius 2.2 x the dot's, 1.5 px line with a soft halo; arrives over 2 frames (66 ms). The dot keeps its unconnected white | 10, 11 |
| Arc, main bolt | from the wire's tip to the dot's centre, 7 to 9 corners, about one every 7 px, alternating sides; 4 to 5 px off the straight line at most (8 % of a 62 px bolt); bright core about 1.2 px with a halo | 13 to 30 |
| Arc, branch | one thin dim line, leaves the bolt a little past half way and runs back towards the tip, 8 to 15 px to the upper side, 2 or 3 corners | 13 to 30 |
| Arc, redraw | a new shape every 2 frames: 15 Hz. The first shape on entering range is larger (a strike) | 13 to 30, 65 |
| Wire in flight | white, round tip at the cursor. The tip stays at the cursor in range; it does not jump to the port | all |
| Release | the wire ends on the port and has its colour along the whole length in the same frame | 31, 83 |
| Port at release | dot takes the colour and is about 15 % larger for 200 ms; two rings 6 px apart grow from 1.7 x to 5.5 x the dot's radius in 470 ms, easing out, the inner one gone first | 31 to 45 |
| Bar on the border | starts as one bar centred on the port, 43 px long at release, 75 px after 66 ms, then splits. Two bars of 45 to 60 px, bright head, fading tail, about 3 px thick on the border line | 31 to 34 |
| Travel | both ways round the border, each bar about half the perimeter, so they would meet opposite the port. Up: corner (95 px) at 0.20 s, far corner (417 px) at 0.68 s, gone at 0.87 s. Down: corner (205 px) at 0.37 s, far corner (527 px) at 0.87 s, gone at 1.0 s. Close to linear, 600 to 700 px/s, fading over the last third | 31 to 61 |
| Glow in the body | a soft patch about 50 px deep that moves with each bar, about a quarter as bright as the bar, under the text | 31 to 57 |
| Whole snap | bright part over at 0.75 s, last trace at 1.0 s | 31 to 61 |
| Node nudge | the target node is pushed about 10 px away from the wire, furthest at 130 ms, back by 400 ms with a small overshoot. Not in the lead's reading; see section 7 | 29 to 47 |
| Pulling off | a press on a connected port and the first move: the wire is white and loose in that frame, the ring arrives over 2 frames, the arc is there at once because the tip is still in range. No animation of its own | 149 to 151, 193 to 196 |

## 2. Where the effect lives, and why

Two short-lived places. Nothing is mounted while the canvas is at rest.

**In flight: React Flow's own connection line.** `connectionLineComponent` is the slot the library mounts when a connection starts and unmounts when it ends, inside the viewport, in graph coordinates, above the nodes. The component renders its SVG skeleton once (the wire, the tip, the ring, three arc paths, the refused mark) and is memoised so that it never renders again. A controller subscribes to React Flow's store with `subscribe` (no selector hook, as `KindLabelDriver` does) and writes attributes: the wire's path and the tip on a pointer move, the arc's paths 15 times a second from one `requestAnimationFrame` loop that runs only while a port is sparking. No React render per pointer move or per frame comes from this effect. A pan or a zoom writes nothing unless a wire is in flight.

Why not an overlay canvas: the wire has to be in graph space (it follows a pan, a zoom and the auto-pan during a drag for free there), it has to stack where wires already stack, and the library already owns that element's life. A canvas would be a pane-sized backing store with its own resize and device-pixel-ratio handling, to draw a 50 px spark. The SVG's cost is measured in the build (frames during a drag in range on E79, effect on against the commit before it) and reported; if that number is not in the noise the choice is reopened.

A live preview tile is painted by a canvas over the whole pane, above everything in `.react-flow`. A wire crossing a tile is hidden by it today, and the arc is hidden the same way. Ports are never under a tile.

**The snap: a box appended to the target node's wrapper, and one path in `.react-flow__viewport-portal`.** Both are created at release and removed by one timer. The box is `position: absolute; inset: 0` inside `.react-flow__node`, after the node's own element: it adds nothing to layout (section 5), paints over the node's body, and stays under the port dots (`z-index: 2`) and the low-zoom kind label (`z-index: 1`), so the bar passes behind the label's plate and behind the dots. The path is the wire's colour fill.

## 3. The range: one number

`WIRE_RANGE_PX = 48`, in `src/editor/edges/wire-range.ts`, with the rule beside it.

React Flow decides what a release connects to: the closest handle within `connectionRadius` of the pointer, then the validity rule. The canvas does not hit-test beside it. The arc is drawn from the library's own answer (`connection.toHandle` and `connection.isValid` in its store), so the arc and the release cannot disagree: there is no second distance computation. The same store value is read by a new connection and by a reconnect, so both have the same range.

48 px, not the reference's 95: Loom's dot has a radius of 3.5 px, rows are 18 px apart and a node is 178 px wide. 48 px is 14 dot radii and 2.7 rows, the reference's proportion to the dot.

**Zoom.** `connectionRadius` is in graph units. At 35 % the library's default of 20 was 7 px on screen. The rule, as the kind label has it: the range does not shrink with the canvas. Below 100 % it is 48 px on screen at every zoom; above 100 % it grows with the canvas (48 graph px, so 384 px at 800 %, where the dot is 56 px wide). In graph units that is `48 / min(zoom, 1)`, and a driver writes it to React Flow's store when the zoom changes. The ring, the arc's thickness and amplitude, the tip, and the snap's bar thickness follow the same factor, written on the effect's own element and never on an ancestor of the nodes.

The grab zone on a wire's end (`reconnectRadius`) is a different thing and stays small: 10 graph px, the library's default, so it does not take presses meant for the canvas.

## 4. What attracts, what refuses

- A port the validity rule accepts (`isValidConnection`, unchanged): the ring and the arc, in the colour of what the wire carries, which is the output port's type token (V26).
- A port of the right side that the rule refuses: a dashed ring in `--text-dim`, no arc, no colour, and after a quarter of a second in range a caption in the words the Connections panel uses for the same refusal, `takes texture2d<float,data>`. It never sparks and a release there does nothing.
- A handle that could never be the other end (an output when dragging from an output): nothing at all.

React Flow takes the closest handle whatever it is, so a refusing port that is nearer than an accepting one wins the range. That is the library's rule and it is kept: the arc says what a release will do, and moving a few pixels towards the wanted port changes it.

## 5. The snap

Played when the command that made the connection is applied (a refused patch plays nothing), 0.72 s in all, against the reference's 0.75 to 1.0 s: Loom's nodes are half the size and its motion tokens are 60 to 220 ms.

- Colour fill: the wire's curve drawn bright in the type colour, fading to the resting hairline over 0.42 s. The real edge arrives under it through the document.
- Port: two rings from 8 px to 22 px over 0.46 s; the dot 1.5 x for 0.2 s.
- Bar: one SVG rounded rectangle on the border line with `pathLength="1"`, drawn twice. Each copy is one dash of 6 % of the perimeter that starts at the port and moves half way round, one clockwise and one the other way, by a keyframed `stroke-dashoffset`. They grow from nothing in the first 90 ms, which is the single bar that splits. A wide blurred copy clipped to the node's box is the glow in the body.
- V389: every element is absolutely positioned in a box with `inset: 0`; nothing is added to the node's own element; the e2e spec compares every node's box before, during and after.
- End: one timer removes the box and the path. Nothing is left in the DOM and no animation is running. A node deleted mid-effect takes its box with it.

## 6. Pulling off and reconnecting

React Flow's reconnect: `onReconnect`, `onReconnectEnd`, edges projected `reconnectable: "target"` (an output fans out, so only the input end is grabbed; a one-socket input holds many wires and is left out). The library's grab zone is the wire's last pixels outside the dot. A press on the dot itself lands on the handle, which is above the wire, so the canvas re-aims that press at the same edge's reconnect anchor; from there it is the library's gesture. During it the edge is hidden, the wire is white, the same arc and ring show, and the release means:

- on a port that takes it: one patch (`connectDropOperations` with `moving`), then the snap;
- back on its own port: no command, and the snap, as in the reference;
- on a refusing port: nothing, the wire goes back;
- on a wire: that wire's target, as a new wire does (V14b), in one patch with its own disconnect;
- on empty canvas: `disconnect`, one undo entry.

A connection is still a command on the bus. No path there changes.

## 7. Reduced motion, and what is left out

`prefers-reduced-motion: reduce`: the ring stays, the arc is one still shape (no redraw loop), the bar and the growing rings are not created, and at release a still ring and the wire's colour show for 0.3 s and go.

Left out, on purpose:

- **The node nudge.** It moves the node's box (V389). Proposed, not built: a `transform` on the snap's own box cannot move the node, and moving the node itself is a decision for the owner.
- **The tick on the row and the status line.** Loom's rows have no tick and its nodes have their own status. A "this input is fed" mark is a proposal for the report.
- **A colour per connection.** Loom's colour is the type's.
- **The dot filling.** Loom's dots always carry their type colour; the dot pulses instead.
- **A brighter resting wire.** Edges stay the quiet hairline they are.
