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
VNB4|.|**CONFIRMED: the desktop app cannot read ANY local file through a file handle — Movie File In, Audio File In, mesh files; "Allow access" flickers and does nothing.** Cause, measured on the pinned Electron 44.5.1 with a standalone probe (`scratchpad/fsa-probe/main.cjs`, local): once a session has a permission CHECK handler, Electron answers a file handle's status from that handler alone, as granted or denied, never "prompt". Loom's check handler (`src/desktop/file-permissions.cjs`) returns false for `fileSystem` on purpose ("checks without one must reach the explicit request below") — but a denied status makes `requestPermission()` return at once, so the REQUEST handler and its consent dialog are never reached. Probe, deny-mode: query `denied`, request `denied`, `getFile()` NotAllowedError, for a freshly chosen file AND one restored from IndexedDB; 4 check calls, 0 request calls. No-handler mode: restored handle reads `prompt`, request reaches the handler. Not the sandbox: the dialog is the main process's. `file-permissions.test.cjs` asserts check=false and then calls the request handler directly with a fake, which real Electron never does (built, tested, never composed). Likely also blocks project Save/Open through `showSaveFilePicker` handles (`project-io.ts`); untested. Reported 2026-10-04 on `pnpm desktop:preview`. Fix needs a ruling on the consent model: see the options in the pull request / chat.|T1329, T1519b, V220
VNB6|.|**A Reset pulse fired INSIDE a component is refused: `Pulse "resetPulse" fires "runtime.resetFeedback", which no track has registered.`** Reported 2026-10-04. Cause, from the code: Feedback, Echo, Cache and Slit Scan declare a `resetPulse` that fires `runtime.resetFeedback`; `parameter.pulse` asks the bus it runs on whether that command exists (`parameter-commands.ts`). The app registers it on the ROOT bus only (`useRuntimeCommands`, `app.tsx`). Diving into a component edits through a separate session bus (`openComponentSession`, `session.ts`), which registers component commands and nothing from the runtime, so every reset button inside a component refuses. Fix shape: the editing layer registers a forwarding `runtime.resetFeedback` on the session bus that addresses the viewed instance's flattened ids (`<instance>/<node>`) on the root bus — T1541b's rule, a pulse inside a definition acts on its instance. Not yet reproduced by hand; confirm the report was made while inside a component.|T1541b, V123, V220

## Needs a reproduction

id|status|report|notes
VNB1|?|**Webcam does not work in Firefox.** No upstream row mentions it. First suspect, unverified: `copyExternalImageToTexture` from a video element (`vgpu-backend.ts`). Needs: Firefox version, OS, console output.|B39
VNB2|?|**Returning to the tab lands on the default template instead of the last session.** By design edited work autosaves and wins on boot, an unedited example reopens by name, and an unedited file from disk boots to an empty canvas (`last-opened.ts`, T1164). Landing on the starter after editing would be a bug. Needs: exact steps.|T1164, T1123
VNB3|?|**Dragging panes to edges to split / insert.** The code has draggable tabs, edge strips and floating windows (V95, T494). Reported as a wish, so either it is not discoverable or it did not work. Needs: one attempt with the steps written down.|V95, T494, T739
VNB5|?|**React logs "Maximum update depth exceeded" in the dev build (Chrome, `pnpm dev`, drmbt @ `2071bb75`).** A `setState` inside a `useEffect` that re-fires every render. Seen once, 2026-10-04; steps unknown. Not reproduced on a fresh starter document or after adding a Depth node. Needs: the expanded console entry (component stack) and what was on screen.|

## Tracked upstream

id|status|topic|upstream
VN8|→|Bezier keyframe automation locked to the timeline (reference: TD's Keyframer component)|T1456b, open
VN9|→|Colour themes / skins|V17: dark-only in v1, by ruling; every colour is already a CSS token
