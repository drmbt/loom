# Phone panel: scroll to every control without moving one, and pages (§T1607b)

2026-10-05. Owner: *"we can still scroll with touch on the page to get to all the controls
without constantly accidentally moving sliders … maybe we need multiple pages"*. Before this,
every control on the phone page was `touch-action: none` and jumped to the finger on
`pointerdown`, so a board scrolled only from its gaps. Consumer case: sentinel-bot — first one
Panel of 12 columns, now three Panels of 8 columns with every slider the full width: no gaps
at all, each tab a little taller than the screen.

## What established surfaces do

| Surface | A touch on a fader | Getting to more controls | Buttons |
|---|---|---|---|
| [TouchOSC](https://hexler.net/touchosc/manual/controls) | `Response`: "ABSOLUTE - Jump to pointer position, RELATIVE - Change relative to pointer position", per control ([Mk1](https://hexler.net/touchosc-mk1/manual/controls-reference): "the initial touch will be remembered and not trigger any change") | Pages: a Pager with a tab bar. No scrolling surface in the control reference. | Momentary, "Toggle Release", "Toggle Press" |
| [Open Stage Control](https://openstagecontrol.ammd.net/docs/widgets/properties-reference/) | Relative by default: "dragging the widget will modify it's value starting from its last value"; `snap: true` jumps. XY the same. | Tabs; a panel may scroll (`scroll`), with a `manual` mode driven by scrollbar widgets | `toggle`, `push`, `tap` |
| [MIDI Designer](https://mididesigner.com/wiki/doku.php/manual:05_controls) | Relative by default: "wherever you touch a slider or crossfader is the control's current value. Then, your touch goes up and down … from there"; "Ribbon Strip" is the absolute opt-in | Pages in banks | Toggle, Momentary |
| Lemur ([forum](https://community.midikinetics.com/viewtopic.php?p=1800)) | Absolute; "cursor mode … 'cap only'" makes the touch land on the cap; no relative fader | Containers and tabs | — |
| Android `SeekBar` ([AbsSeekBar.java](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/widget/AbsSeekBar.java)) | In a scrolling container it waits: `Math.abs(x - mTouchDownX) > mScaledTouchSlop`, then `startDrag` and `requestDisallowInterceptTouchEvent(true)`. Cancel keeps the value. | The scroll view | Click on release |
| iOS `UIScrollView` ([`delaysContentTouches`](https://developer.apple.com/documentation/uikit/uiscrollview/delayscontenttouches), [described](https://learn.microsoft.com/en-us/previous-versions/xamarin/xamarin-forms/platform/ios/scrollview-content-touches)) | A touch-down is held back (about 150 ms) until the scroll view knows it is not a scroll | The scroll view | Fire on touch-up inside; a scroll cancels the press |

Two answers recur: **the control does not act on touch-down** (relative response, or a slop
along its own axis first), and **more controls means pages**; scrolling is the native
platforms' answer. We take all three.

## What the browsers do with `touch-action`

`touch-action` is the only way to share one touch between a control and native scrolling. It
is read when the touch starts — "changes to `touch-action` will not have any impact on the
behavior of the current gesture" ([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action))
— and when the browser takes the pan the page gets `pointercancel`
([Pointer Events](https://www.w3.org/TR/pointerevents3/)).

- **Chromium** (measured: headless, touch through CDP). On `pan-y` it decides ONCE, when the
  touch leaves the slop (15 px in emulation, 8 dp on Android), by the dominant axis of the
  travel so far ([`ShouldSuppressScrolling`](https://github.com/chromium/chromium/blob/main/components/input/touch_action_filter.cc):
  `absDeltaXHint > absDeltaYHint`). Vertical: it scrolls and sends `pointercancel`. Horizontal:
  scrolling is dropped for the whole touch; a later vertical move does not bring it back.
  `pointermove` IS delivered inside the slop. `touchmove` is not, and the one that crosses
  the slop is not cancelable — `preventDefault()` cannot hold a touch the browser wants.
- **iOS Safari** (read from WebKit's source, NOT run). `pan-y` locks the x axis and cancels
  the pointer once the scroll view's pan has any y translation
  ([`axesToPreventScrollingForPanGestureInScrollView`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/ios/WKWebViewIOS.mm));
  the scroll view sets `directionalLockEnabled = YES`
  ([WKScrollView.mm](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/ios/WKScrollView.mm)),
  so a drag that starts sideways should stay the page's. Whether that holds through a long
  drag is the one thing only a real iPhone can say.

So a slider that has started moving keeps the touch in Chromium by construction. On iOS it
may lose it to a late `pointercancel`; the drag then ends at the value it has (Android's
rule), and with relative drag taking it up again costs nothing.

## Decisions

1. **Direction lock: the browser arbitrates, the script follows.** Sliders and faders are
   `touch-action: pan-y` (a vertical fader would be `pan-x`; the page draws none). The script
   takes a touch only after 12 px of travel along the control that is more than the travel
   across it — above both platforms' slop, so the browser has decided first — and writes
   nothing before. No scripted scrolling, no touch-event listeners.
2. **Relative drag, always.** Touch-down never writes. The value moves by the finger's travel
   from where the control took it, 1:1 with the track; it stops at the ends without
   remembering the overshoot; a tap on a slider does nothing. The thumb and number show the
   value, not the finger, and the control is outlined while it holds a touch. Absolute is
   not kept: per control it needs a new published property, per page it is a mode to forget,
   and nobody asked. If wanted, it is TouchOSC's per-control `Response`.
3. **XY pads keep `touch-action: none`** (both axes are theirs) and are relative too. Where a
   view scrolls AND shows a pad, a **rail** runs down the right edge: a strip that only ever
   scrolls, with a thumb showing where the page is; the board is inset so nothing lies under
   it. Rejected: a lock toggle (a mode; a locked surface on stage is a dead one) and
   two-finger scroll (two fingers on two controls is how a surface is played, and it would
   be scripted scrolling).
4. **Toggles and press buttons act on release inside** — the `click` they already listen for —
   and become `pan-y`, so the browser cancels a press that turns into a scroll. A **momentary
   Button** follows iOS: a tap is a whole press sent on release; a finger that rests 150 ms
   holds it down until it lifts. Cost: a hold starts 150 ms late, and a held finger that
   slides far enough to scroll lets go.
5. **Pages.** A board with two or more labelled sections gets a pager above the tab bar:
   `All` (the board as drawn) and a page per label. A control belongs to the nearest label
   above it that it overlaps across; a page is the box round a label and its controls, drawn
   so ITS columns fill the width. Tabs stay one per Panel (§T1517b); the pager belongs to
   the shown Panel. The phone remembers each Panel's page (`localStorage`) and, for the
   visit, how far every tab and page was scrolled. Controls under no label are on `All` only.
6. **Wheel, trackpad, mouse.** An ordinary scrolling document: no control listens for a wheel,
   and a mouse drags by the same rule.
7. **Accessibility that comes free.** Toggles, buttons, tabs and pager chips are real buttons
   (keyboard and assistive activation through `click`); chips are 44 px tall; the rail is
   `aria-hidden`. Sliders stay pointer-only, as before.

**Tabs or pages for a 31-control surface?** Prefer ONE Panel with labelled sections. The desk
keeps one board — one overview, one Phone switch, one thing to arrange — and the phone still
gets a full-width page per section, sized by how wide the section is drawn (three sections of
8 columns side by side give exactly the three screens the split gives today). Use separate
Panels when the groups are separate instruments, published or handed out on their own. Pages
cost a second row above the tabs (52 px); on a phone held sideways that row is a seventh of
the screen, and there separate Panels are the leaner surface. The split that shipped works
unchanged: the direction lock is what it was missing.

Also rejected: holding a claimed touch with `touchmove.preventDefault()` (measured useless in
Chromium); pages for legacy text-layout Panels; non-square cells on a page.

## Verified, and not

Chromium under Playwright, a touch-enabled phone context, the real door and page
(`src/tests/e2e/phone-touch.spec.ts`): the flick, the drag, the toggle, the button, the pad,
the rail, the pages, sentinel-bot's Panels as shipped. NOT verified by any test: iOS Safari
and Android Chrome on a phone — the owner's live check.
