# MIDI learning in control panels

The Controls pane now maps a hardware MIDI control directly onto a slider, toggle, button, or XY pad. It reuses the application's existing Web MIDI session, decoder, and MIDI In node; it does not open another MIDI session.

## Using it

1. Open Controls in play mode and click **MIDI Learn**. Grant MIDI access when the browser asks.
2. Click the widget to map. For an XY pad, choose **Learn X** or **Learn Y**.
3. Move the hardware knob, fader, or pad. The next supported message establishes the mapping.
4. Select another widget to continue mapping, or turn **MIDI Learn** off to resume normal interaction.

The toolbar offers **Cancel learn** while waiting and **Unlink MIDI** for an existing mapping. Leaving the panel or unmounting the pane disarms learning. Arming is session state; mappings are project state and survive saving, loading, undo, and redo.

The existing decoder supports 7-bit Control Change and 14-bit pitch bend. This change does not add note, velocity, relative encoder, clock, or SysEx decoding. The toolbar displays the existing permission and device status.

## Mapping behavior

Learning creates or reuses a named MIDI In node for the captured input port and appends a mapping without replacing unrelated rows. Port IDs remain opaque strings. A slider or XY axis uses its retained Min and Max values and rests at its retained value when hardware readings are absent. A toggle uses a latched mapping; a button uses a momentary mapping and a wired Count node for its press count. X and Y can be learned and unlinked independently.

The widget's parameter slot reads the source channel through the existing expression system. Learning is one atomic domain graph patch and one undoable command. MIDI messages update the session's raw readings rather than repeatedly editing the document. Unlinking restores retained constants and preserves separately authored bindings. Source nodes are retained because other consumers may use them.

## Runtime correction

Previously, value nodes resolved their own parameters without a channel resolver, and value evaluation ordered only wired dependencies. A mapped slider could therefore display a live value while its published output stayed at the retained constant.

Value evaluation now orders active parameter references alongside wire dependencies and resolves parameters using current-frame value channels. Dependencies through nonvalue parameter owners are included; stateful nodes still evaluate once per frame. Reference dependencies are cached by immutable graph identity. A muted local source cannot be replaced by a stale external reading of the same name.

Driven panel widgets read resolved values through a shared context and poll locally at 10 Hz, updating only when their displayed values change. The pane does not subscribe the entire application to every MIDI message. Bound controls reject manual writes; an unbound XY axis remains editable.

## Verification

Focused tests cover native-session learning, actual value-graph output and downstream parameters, slider ranges, toggle edges, button counts, independent XY axes, retained values, save/load, undo/redo, cancellation, widget display, and capture without accidental manual edits. A scoped Chromium test exercises the wired grid panel using the real MIDI hook and value graph, with only the native MIDI port boundary simulated. It confirms that later MIDI messages change the live value without changing the document revision.

Repository typecheck, lint, production build, and required gate tests are run alongside these focused checks. Physical MIDI hardware and operating-system permission prompts are not exercised by the simulated-port tests. No full test suite, GPU renderer, or persistent helper instance is started for this feature.

This implements the MIDI portion of T1388b's second phase. Other widget types, OSC learning, and the remaining panel features stay open.
