# Screen In — Chrome tab, window and screen capture

Add **Screen In** from the input library, select it, and click **Share tab/window** in the inspector. Choose the video tab, another window, or a screen in Chrome's picker. Connect **Out** to any texture consumer. **Stop sharing** releases the capture; **Share another** replaces it once the new source is ready. Chrome's own Stop sharing control is also observed.

Capture is video-only. It does not capture tab audio, require OBS, or use the native device helper. Every new capture requires a user click. Opening an inspector or restoring a saved project never opens a picker. The chosen surface and browser permission are not saved in the project. A live source is marked non-reproducible for offline rendering.

The browser adapter calls `getDisplayMedia` before its first await, requests 30 fps, prefers a browser tab, and enables Chrome's surface-switching control. These are picker hints: windows and screens remain available. The API requires HTTPS or localhost and user activation. See [Chrome's screen-sharing controls](https://developer.chrome.com/docs/web-platform/screen-sharing-controls).

## Runtime and ownership

`screenInNode` reuses `compileMedia`, the existing `media:<nodeId>` external texture registration, and `createVideoMediaSource`. The browser video element goes directly to the existing GPU upload path. There is no CPU pixel copy, new render loop, or upload identity increment on render ticks. Only decoded video frames advance the source identity.

`useScreenSources` owns capture sessions separately from graph serialization and GPU-device lifetime. It registers when a backend becomes available and reattaches after device replacement without prompting again. Source storage follows actual decoded video dimensions at the backend's frame prelude. Chrome source switches and window resizes update that storage without overwriting Common output resolution.

In **Common**, set the output Resolution separately from **Image fit**. Fit preserves the entire image and its aspect, using transparent margins as needed. Fill crops centrally to fill the output. Stretch fills without preserving aspect. Fit is the default for Screen In, Webcam and Movie File In.

Stop, browser-ended sharing, mute, bypass, node removal, project replacement, component removal, unmount, and page exit release owned tracks, video callbacks, event listeners and source registrations. Late picker results are stopped rather than attached to a retired node or project. A refused replacement leaves the current source running and reports the refusal. Registration failures surface diagnostics; no alternative capture path is introduced.

The shared backend's existing last-frame retention policy applies after sharing ends. Screen In's inspector explicitly shows that sharing ended and offers Share again.

## Verification

Focused tests exercise capture preparation and cleanup, synchronous picker invocation, preservation of Common output dimensions, decoded-frame identity, pending Stop, overlapping picker results, re-share refusal and replacement, browser-ended sharing, mute/bypass/removal, project changes, backend recovery, page exit and registration failure diagnostics. UI tests exercise the actual inspector section and flattened component ids. Backend regressions verify full-source upload at a smaller output resolution, resize/rebinding, reuse, recovery and explicit device limits.

The Chrome browser test uses a real `canvas.captureStream()` video stream behind a picker stub. It verifies the reachable library/inspector flow, activation, capture options, stop/re-share/browser-ended cleanup and reload behavior. The native picker and desktop/window permissions are not automated. A physical picker selection remains the manual check; pixel rendering is covered by the existing media upload path rather than a new GPU benchmark.

No broad native GPU suite is run for this feature. Three bounded 16×16 GPU frames verify actual Fit/Fill/Stretch shader pixels; each device is immediately disposed. Test browsers and owned dev servers must close after the bounded browser proof.
