# SPEC-VN — drmbt contributor board

Vincent Naples' (drmbt) working board for contributions to Loom. It exists so contributor
work never mints numbers in `SPEC.md`, which the upstream main session owns.

- **Prefix:** tasks are `VN<n>`, bugs are `VNB<n>`. Numbers are never reused.
- **Upstream rows are cited, never copied.** If upstream already tracks something, the row
  here is a pointer (`→ T1456b`) and the work happens there.
- **Commit subjects carry the VN id**, e.g. `VN1: Save as component on the canvas menu`.
- **A pull request description repeats its row**, so upstream can file it under a canonical
  T/B number if it wants one.
- Status: `.` open · `~` in progress · `x` landed (with commit hash) · `?` needs a
  reproduction before it is a task · `→` tracked upstream.

Source of the first batch: a hands-on session on 2026-10-03 (hosted build + local clone).

## Tasks

id|status|task|cites
VN1|x|**LANDED `76cd8b1e` on `drmbt`: the canvas menu gains a Component submenu ("Save selection as component…", "Import component…"); the component bar moves to `--z-canvas-chrome` so preview tiles no longer cover it.** Original report: "Save as component" is hard to find, and its naming prompt hides. Right-clicking the canvas with nodes selected offers "Import component…" and nothing about making one; the gesture lives only on the NODE menu's Component submenu and on `Shift+C`. The naming prompt it opens is a bar at the top of the graph pane that draws UNDER node preview tiles. Wanted: (a) the canvas menu offers it when there is a selection; (b) the prompt is drawn above previews.|T423, V78
VN2|.|**Browser back/forward leaves the app.** A trackpad swipe or a mouse back button navigates away from Loom mid-session. Only `overscroll-behavior: none` exists today; there is no history guard and no leave prompt. Wanted: back/forward cannot discard a session by accident.|
VN3|.|**Context menu and add-node dialog spawn position.** Both open offset from the cursor so the pointer is not over the first useful row / the fuzzy filter. Wanted: open with the search field or first row under the pointer, clamped to the viewport.|
VN6|.|**Wiring and navigation gestures missing against TD / ComfyUI.** No hotkey to insert a Null on a wire or after the selection; no dedicated disconnect gesture; no "split off this output"; no highlight of compatible sockets while dragging a wire. Splice-by-drop (V14d) and replace-on-occupied (V14a) already exist.|V14a, V14d
VN7|.|**Preset interpolation beyond four fixed curves.** Morph offers linear / smooth / in / out. Reference: Hive's preset system and our Resolume FFGL preset interpolation (custom curves, per-parameter offsets and delays). A design note first, not a build.|T1497b
VN10|.|**A component has no panel of its own.** TD associates a panel (and a render texture) with a COMP. Loom's Panel node is a control surface, and an instance shows a preview tile, but a component cannot carry its own control layout. Design question for upstream before any build.|T1512b, V548

## Needs a reproduction

id|status|report|notes
VNB1|?|**Webcam does not work in Firefox.** No upstream row mentions it. First suspect, unverified: `copyExternalImageToTexture` from a video element (`vgpu-backend.ts`). Needs: Firefox version, OS, console output.|B39
VNB2|?|**Returning to the tab lands on the default template instead of the last session.** By design edited work autosaves and wins on boot, an unedited example reopens by name, and an unedited file from disk boots to an empty canvas (`last-opened.ts`, T1164). Landing on the starter after editing would be a bug. Needs: exact steps.|T1164, T1123
VNB3|?|**Dragging panes to edges to split / insert.** The code has draggable tabs, edge strips and floating windows (V95, T494). Reported as a wish, so either it is not discoverable or it did not work. Needs: one attempt with the steps written down.|V95, T494, T739

## Tracked upstream

id|status|topic|upstream
VN8|→|Bezier keyframe automation locked to the timeline (reference: TD's Keyframer component)|T1456b, open
VN9|→|Colour themes / skins|V17: dark-only in v1, by ruling; every colour is already a CSS token
