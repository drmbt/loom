# Flying a camera from its picture, and a camera that stays with what moves

Design for §T970 and §T1656b. 2026-10-06. No code in this note; the coverage half (§T1655b)
is built and is what section 1 describes.

The owner, twice: *"i'm still missing a way to actually change the position of the camera in
the camera node via flying around in that preview instead of manually having to deal with it"*.

## 1. What exists today

Two stores wear one interface (`PreviewOrbitStore`), and the difference between them is the
whole subject. The **inspection orbit** (`preview-orbit-store.ts`) is view state: drag, shift-drag,
wheel and, in the viewer, W A S D E Q move a camera over a synthesized picture (a pointset,
a geometry, a light, a material). It writes nothing, mints no revision and is not saved. The
**camera gizmo** (`camera-gizmo-store.ts`, §T692) takes the same gestures on a tile that is
drawn through a node's own Eye and Look At and writes those two parameters through the
parameter editor: one undo step per drag, a driven channel masked out and never written.
Before §T1655b the gizmo was offered only on a camera nothing rendered through, its own tile
did not follow the write, and the viewer's orbit was attached to a hidden canvas; all three
are fixed and gated. After it, every 3D row carries one of three answers from the compiler
(`ResolvedOutput.previewCamera`): `orbit`, `pose` (camera, projector, Render Surface and
Render Instances with no camera named), or `none` with a reason ("Framed by camera_rig." on
a Render). When this note was written the gizmo had no fly, the viewer could not move a
camera at all (it said "drag on its tile in the graph"), and a fully driven camera could
only be refused: slice 1 built those three (section 8). What still does not exist: a free
view of a Render's scene, and a command that sets a pose in one step.

## 2. How the reference tools do it

Read from the vendors' documentation on 2026-10-06 by a research pass that fetched each page
and quoted the sentence; I did not re-open the pages. READ means the sentence was seen on the
page; INFERRED is marked. Bases: TD `https://docs.derivative.ca/`, Notch
`https://manual.notch.one/2026.1/en/docs/reference/`, Blender
`https://docs.blender.org/manual/en/latest/`.

| | Fly while looking through the camera (it follows) | Fly a free view, then commit it | Keep a camera with a moving subject |
|---|---|---|---|
| **TouchDesigner** | Geometry Viewer, **Lock Camera**: "tumbling, zooming, or repositioning the view will update the camera's position to keep in sync with the view" (`Geometry_Viewer`, READ). A Camera COMP's node viewer is the one viewer whose navigation writes parameters: "Moving content inside a node viewer does not affect its transforms or parameters. Exception : Camera COMP" (`Node_Viewer`, READ). | **Save View to**: "takes the current view in the viewer and saves it out to whichever camera is selected from the menu" (`Geometry_Viewer`, READ). | Wire a COMP into the camera's top connector: "that COMP is its transform parent" (`3D_Parenting`, READ). **Parent Transform Source**: Parent (Hierarchy), Specify Parent Object, World Origin (`Camera_COMP`, READ). **Look At**: "it will continue to face that Component, even if you move it" (READ). |
| **Notch** | Not found as a statement. INFERRED weakly from the shortcut table's "Regular Camera" column that navigating a user camera moves it. | Camera node, right-click: "Camera Options > **Set To Current View**" moves the camera to the editor camera's position (`nodes/cameras/camera/`, READ). | Cameras "inherit the transformation values of parent nodes"; per channel, "Inherit the world position from the parent only, rotation and scale will be ignored"; a **Target Node** input turns the camera "to always direct the z axis towards the input" (`nodes/cameras/`, READ). |
| **Blender** | **Lock Camera to View**: "the camera becomes 'glued' to the view and will follow it around as you navigate" (`editors/3dview/sidebar.html`, READ). Walk and Fly: "When activated from a camera view, the camera will move along with you" (`navigate/walk_fly.html`, READ). | **Align Active Camera to View**, Ctrl-Alt-Numpad0: "Moves and rotates the active camera so that it matches the current viewport position and orientation" (`navigate/align.html`, READ). | Parenting; Track To; and, with a parent, **Camera Parent Lock**: "When the camera is locked to the view, the root parent is transformed rather than the camera" (`object/properties/relations.html`, READ). |

Navigation, for the gestures: TD tumbles on LMB, dollies on MMB or wheel, tracks on RMB, and
has W A S D Q E only in the `cameraViewport` palette component (READ). Notch is Alt + mouse
buttons, with no W A S D or fly found. Blender's Walk is W A S D, E Q, Shift faster, and
LMB to keep or Esc to go back (READ): a flight there is one action you accept or cancel.

Three things to take. All three tools have the one-shot commit, and two have the live lock:
they are different gestures and both are wanted. In all three, "stays with the subject" is a
PARENT, never a baked number. And Blender's parent lock states the rule section 4 needs: when
a camera has a parent, what a flown view writes is a choice, and it is stated.

## 3. The gesture

**Both, in this order: lock first, free view second.**

**Lock ("Fly camera_rig").** The viewer, whenever its picture is drawn through a camera: a
camera node, a Render or any other picture framed by one (the compiler already says which,
`through-camera`), or a node with its own Eye and Look At. The camera button in the viewer's
bar, which today is inert on these rows, becomes the toggle and NAMES THE NODE IT WILL WRITE:
"Fly camera_rig". Armed, the viewer's existing gestures write that camera through the gizmo
store: drag orbits Eye about Look At, shift-drag trucks both, the wheel dollies, W A S D E Q
translate both along the view's axes (shift is faster), which the gizmo store gains. Roll
and FOV stay parameters. The picture is the camera's own at every moment, so nothing is
falsified (§T614 holds by construction) and the cost is a uniform write per frame: no second
pass, nothing in the compiler.

- *One undo step* per drag, per wheel burst (400 ms idle, as the gizmo does now) and per
  flight: from the first fly key going down to the last coming up.
- *Before*: the bar reads "Framed by camera_rig." and the button says "Fly camera_rig".
  *After arming*: the button is lit, the readout says "Flying camera_rig: every move is an
  edit, undo steps back", and the camera's tile and every Render through it move with it.
- *Keys*, as rows of the keymap (`viewer` context, rebindable, in the shortcut editor and the
  palette): `c` toggles `viewer.flyCamera`; the fly keys are the existing `viewer.fly` rows,
  routed to the armed store. `h` LEAVES the mode and writes nothing: home must never be an
  edit, and the way back is undo. Menus-as-data: "Fly this camera in the viewer" on a camera
  node, "Fly its camera (camera_rig)" on a Render.
- *It stays findable* because the sentence that says there is no inspection camera here is
  the place the button is: one visible line, naming the camera.

This is the variant §T692 rejected for the Render's TILE, for three reasons. Each is met by
moving it to the viewer and naming the target: the tile contract (a tile gesture inspects the
node it is on) is untouched because tiles do not change; the camera reference is resolved by
the compiler and shown before the first press; and a picture with no camera has no button.

**Free view, then "Set camera from view".** The lock cannot serve one case: looking around
WITHOUT editing, which is what you want before you know where the camera should go and the
only safe thing on a rigged camera. So the viewer gets a second state on the same button
group, "Free view": the scene through an inspection camera that starts at the camera's
current world pose and FOV. It must not change what the Render outputs, so it is a VIEWPORT
ROW, the mechanism §T1311b built for raymarchers: the compiler clones the Render's draw
passes into a target nothing reads, the override writes that clone's camera uniforms, and
the row exists only while a viewer is watching it. Then one command, `camera.setPose`, from
"Set camera_rig from this view" in the bar, on the camera's menu, and on `mod+shift+c`: it
writes Eye and Look At (and FOV only if a later gesture changes it in the free view: today
none does, so framing is preserved without carrying it) as ONE patch and drops back to the
camera's own view. One undo.

- *Which camera, when several exist*: never a guess. It is the camera that frames the
  picture the viewer is showing, by name on the button; from a camera node's own menu it is
  that node.
- `camera.setPose` is also what an agent calls, and it REFUSES rather than half-writes: if
  any channel it must write is driven it changes nothing and names the channel and its mode.

## 4. A driven pose

The owner's `camera_rig` has all six channels on expressions and follows a robot travelling
3 to 8 m a second. Committing a flown view would replace six expressions with six numbers,
and the camera would stop following. Three options:

- **Refuse** (what §T1655b ships): no control, "Driven by expressions (Eye, Look At)." Honest
  and useless for the ask.
- **Bake**: replace the expressions. Destroys the rig. Not offered, by any gesture.
- **A parent frame** (§T1656b), recommended. The camera gains two parameters and its Eye and
  Look At become offsets in the frame they define:

| Parameter | Type, units | Default | Meaning |
|---|---|---|---|
| Origin | vector, scene units (the owner's metres) | 0, 0, 0 | Where the frame is. World Eye = Origin + frame · Eye; the same for Look At. |
| Heading | vector, a direction | 0, 0, 0 | The way the frame faces: its forward, which is its −z. AS BUILT, only the horizontal part is read, so the frame turns about the vertical and never tilts. Zero (or straight up or down) means axes stay the world's, so only position is inherited (Notch's "world position from the parent only"). |

  Both are ordinary drivable vectors, so the frame can be anything an expression can read: a
  channel triple, another node's Translate (`op('geometry_hull').par.translate.x`), a value
  node. The rig then lives in Origin and Heading, and Eye and Look At go back to Constant: the
  gizmo and the lock write them as they do now, in the frame, and the flown view travels with
  the subject. That is the consumer's "Free camera" case with no new mechanism.
- *What the gizmo writes with a frame set*: the same two parameters, unchanged in code,
  because it already orbits Eye about Look At in the space they are stored in. The pose it
  reads at gesture start is the local one.
- *What "Set camera from view" writes*: the free view is a world pose, so the command takes
  it into the frame as it stands on the frame being shown, then writes the local offsets, as
  one patch. This is Blender's parent-lock question answered the other way on purpose: the
  camera's OFFSET is written, never the parent, because the parent here is the rig.
- *What the tile shows*: the picture through the composed pose, as now. A camera whose Origin
  is driven and whose Eye is free has the toggle; one whose Eye and Look At are still all
  driven keeps the sentence.
- *What it costs in the compiler*: one composition where the camera payload is built
  (`scene.ts`), so every consumer of the payload's eye and matrix gets world values and none
  of them changes. Values only, so it animates as a uniform write and never rebuilds. Two
  parameters on a node definition, which reaches the catalogue walkers.
- *Not in this design*: a POINT OF A POINTSET as the parent. Point positions live in GPU
  buffers and the camera matrix is a CPU value; following one needs either a readback per
  frame (latency, and the preview path forbids readback) or the view matrix composed in every
  scene shader from a bound buffer. Filed as a row, not built on a guess.

## 5. What a Render's inspection orbit is after this

Still nothing, on purpose. A Render's tile and its output are the picture through its camera
(§T614), and that does not move. What a Render gains is around it: the sentence naming its
camera (built), the lock that flies that camera from the viewer (a document edit, named), and
the free view, which is a second target nothing downstream reads. "Inspection never writes,
and the node's output is never an inspection" survives all three.

## 6. Slices, each landable alone

(Built on 2026-10-06 as "slice 1": items 2 and 3 below, with the tile toggle's minimum
size. Items 1 and 4 are the next slice. Section 8 says what was ruled in the building.)

1. **`camera.setPose`**: the command, its refusal on a driven channel, the agent tool.
   Accepted when one call is one undo step, a refused call changes nothing and names the
   channel, and a Render through that camera changes on Dawn by the exact matrix.
2. **Lock in the viewer** ("Fly camera_rig"): the button, `c`, fly on the gizmo store, the
   readout line. Accepted in the GPU lane: viewer on a Render, arm, hold W, the camera's Eye
   moved along its view axis, the Render's tile changed, one undo restores both; `h` writes
   nothing; a driven camera has no button and keeps its sentence.
3. **Origin and Heading** (§T1656b). Accepted when a camera with a driven Origin and Constant
   offsets flies and keeps following (two frames, the offset identical, the world pose moved),
   the matrix is exact on Dawn for a non-zero Heading, and a document without the parameters
   renders byte-identical.
4. **Free view and "Set camera from view"**: the Render's viewport row, the state on the
   button, the commit. Accepted when the Render's own output is byte-identical with the free
   view on, the viewport row is absent with no viewer watching, the commit is one patch, and
   with a frame set it writes the local offset.

Left out, as row text for the lead to number:

- A camera's frame from a POINT of a pointset (position and orient attribute), composed on
  the GPU; design first, with the cost per scene shader measured.
- A Camera Select: one camera payload out of several by index or blend, so a panel's "Free
  camera" toggle switches rig and flown camera without a recompile.
- A stock-scene tile (camera, light, material, geometry, projector) whose node only READS a
  moving value, through an expression that follows time or a control, shows the values of
  the last edit made ON that node: the per-frame path and the values lane both splice
  passes and keep the base plan's rows (`frame-compile.ts`), and that tile's values are on
  its row. The fix is for the lane to re-derive the rows from the payloads it already
  captures. Found by §T1655b, which made only a write ON such a node compile in full.
- The preview program description is rebuilt when a synthesized tile's values move
  (§T1241's cost, once per edit now); push values without a rebuild.
- Tile chrome whose corner is under a node in front is hidden (§T1655b); on a document
  that overlaps its nodes, such as the owner's, a Render's sentence is then not shown at
  all. Move it to a corner that is not covered, or decide that overlap is the document's.
- Fly a projector from the viewer (it has the tile gizmo since §T1655b).
- A FOV gesture in the free view, and with it FOV travelling in the commit.

## 7. Questions for the owner

Each is a choice between named options; the first is my recommendation.

1. **How do you want to fly a camera?** `Both` (look through it and it follows; and a free
   look-around you then commit) / `Lock` only / `Free` only.
2. **Your camera_rig is on expressions. What should flying it do?** `Origin` (the camera gets
   an Origin and a Heading that your expressions drive; Eye and Look At become offsets you
   fly, and they stay with the robot) / `Refuse` (as now: it says why and does nothing).
3. **Where do you fly from?** `Viewer` (the big picture; tiles keep what they have) /
   `Tiles too` (a Render's own tile also flies its camera).
4. **While you look through a camera and fly, is every move an edit?** `Yes` (undo steps back,
   nothing to confirm) / `Confirm` (Blender's Walk: keep with a click, Esc throws it away).
5. **The free look-around draws the scene a second time while it is on. Acceptable?** `Yes` /
   `No` (then only Lock is built).
6. **At small zoom the camera button on a tile is about 5 px (alt+drag still works). Keep
   it?** `Minimum` (never smaller than about 12 px, like the node's name) / `Scale` (as now).

## 8. Slice 1 as built (2026-10-06), and what was ruled in the building

Built on the recommendations above, before the owner answered the six questions. Each rule
here is one edit to turn.

**The lock.** A viewer whose picture is drawn through a movable pose shows a button named
for the node it will write: "Fly camera_rig". It, or `c` (`viewer.flyCamera`, a keymap row
in the viewer context), arms it. Armed, the picture's drag, shift-drag, wheel and fly keys
go to a document-writing camera store and not to the inspection one. A drag never arms it,
and unarmed nothing in the viewer edits anything. `h` leaves and writes nothing. Another
subject in the viewer, or a pose that stops being movable, leaves too.

**How a held key becomes undo steps: ONE FLIGHT IS ONE STEP.** A flight runs from the first
fly key going down until the last one comes up, the pane loses focus, or (from the palette
or an agent) one discrete step is taken. However many keys were held on the way, and however
long, that is one undo. A drag is one; a run of wheel clicks that pauses for 400 ms is one.
There is no timer inside a flight: a long flight is one long step, because a pilot who flew
somewhere and wants to go back wants to go back to where they took off.

**Pace.** W A S D E Q move Eye and Look At together at 1.1 times the distance between them
a second (shift is four times that), the scale-free pace the inspection flight has. A
flight keeps that distance, so it keeps its pace; the wheel changes the distance, and is
the throttle. On the owner's rig, an offset of five metres cruises at 5.5 m/s.

**Origin and Heading.** As section 4, with three things settled:

- *Heading is read for its horizontal part only.* The frame turns about the vertical and
  never tilts. A camera following a subject up a ramp rises with it and keeps its horizon;
  and the gizmo's orbit, truck and flight are the same turn-about-the-vertical in the frame
  as in the world, so the gizmo needed no change at all. A frame that also pitches is a
  question for the owner if a shot wants it (it is a different parameter: an up vector).
- *The frame's forward is its −z*, the way a camera looks. The default camera (Eye 0, 0.5,
  3, Look At the origin) under a subject's position and heading sits three behind and half
  above it, looking where it goes: a chase camera with nothing typed.
- *No version bump and no migrate.* The Camera stays at definition version 1, as Geometry
  did for its transform (§T1588b): absent parameters resolve to their defaults and the
  defaults are the identity, float for float. A bump would mark every document with a
  camera as changed on load and force a regen of the 23 shipped examples that hold one, to
  move no stored value. Proved instead: 49 documents and 53 cameras pinned before the
  change, at three frames, identical after.

**A driven pose, three cases.** Eye and Look At all driven: no button, no gizmo, and
"Driven by expressions (Eye, Look At)."; on a Render framed by it, "Framed by camera_rig.
Driven by expressions (Eye, Look At).". Some channels driven: it flies on the rest, and
says "Stays driven: Eye x (Expression)." on the tile toggle's hover, the viewer button's,
and the readout while flying. The rig on Origin and Heading: everything a flight writes is
free, and it flies.

**The tile's toggle** holds 12 px below the zoom where it would be smaller (75 %). The
sentence a camera-less tile carries is not floored: it would be wider than its tile.

Not built here, as row text:

- **Fly a driven rig by displacing it.** A camera whose Eye and Look At are all driven and
  whose Origin is free could still be flown by writing ORIGIN: a translation added to the
  rig (Blender's parent lock, "the root parent is transformed rather than the camera"). It
  would make the owner's file flyable as it stands, for translation only (no orbit: Origin
  cannot turn the rig about its own target). Left out because it is a second write target
  with a smaller gesture set, and the sentence would have to explain which.
- **A frame that pitches and banks** (an Up or a full orientation beside Heading).
- **The editor queues a gesture's writes one behind another**, so on a loaded machine the
  document trails a flight for a moment after the key comes up (seen in the GPU lane with
  six specs in parallel). True of every drag through `ParameterEditor`; unmeasured.
- **The viewer's bar squeezes its Display picker** when the fly button's name is long.
