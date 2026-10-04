# Retained local media files

Movie, audio, and mesh file fields can retain local file references across project reopening in Chromium and Electron. Choose each file once with the new picker, then save the `.loom.json`. Reopening in the same profile and origin resolves the retained file handle and gives the existing decoder a fresh object URL.

## Cause and implementation

The previous picker stored `URL.createObjectURL(file)` directly in the node parameter. Saving preserved that temporary URL, but restarting destroyed its backing file association. JSON cannot recover an expired object URL.

The picker now stores a native `FileSystemFileHandle` in IndexedDB before committing the parameter through the existing command path. The parameter holds `loom-file:<opaque-id>/<kind>#<encoded-filename>`. Project snapshots, manual saves, and component exports derive the corresponding existing `AssetReference` records from the authored graphs. The project schema does not change, and media bytes are not copied into browser storage.

`src/app/use-file-references.ts` creates an ephemeral graph for movie, audio, and mesh decoding. It resolves static retained references, including those inside components, without changing the stored graph or compiler input. Shared references share leases. The broker revokes object URLs after the final lease releases and ignores stale asynchronous reads after replacement or disposal.

## Permission and relinking

Opening a project checks `queryPermission()` and does not initiate a permission prompt. If read access is required, the field offers **Allow access**, which calls the cached handle's `requestPermission()` directly from the user click. A missing handle or file offers **relink**, storing the selected replacement under the existing opaque identity. Failures appear as explicit field or project diagnostics; a failed storage operation does not change the document.

Chrome documents both [handle storage in IndexedDB](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access) and [permission persistence choices](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api). Permission availability depends on the browser and user grant. Electron already uses a persistent local profile and fixed renderer origin, so it uses the same retained-handle path with its existing exact-file permission policy.

## Components (T1519b, 2026-10-04)

A component never carries media bytes. A movie, audio or mesh node inside a component keeps the same retained reference, so exporting, importing and pasting a component moves only the reference. When a project is opened, or a component is imported or pasted, and a reference has no handle in this profile, the notice strip warns at that moment and names the file, the node and the component. A `blob:` URL from a component file written before export refused them gets the same warning, because it can never load. The node diagnostic stays as the lasting record.

Relink a file inside a component from the instance: the instance's Component section in the Inspector lists the missing files that instance reads, with a **relink** button. An instance that overrides an internal file lists its override, not the component's file (T1550b). Relinking stores the new handle under the reference's existing identity, so the component definition and the document do not change. Export still refuses a component that holds a session-only `blob:` URL; the refusal says to enter the component and choose the file again with the picker.

## Limits

- References belong to the browser/Electron profile and origin. Another profile, machine, or dev-server origin needs relinking. Clearing site storage removes retained handles.
- A `.loom.json` remains a document with external file references. It does not bundle files or resolve paths relative to its folder.
- Expired object URLs in existing projects cannot reveal the original local path. Select those files once with the new picker and save again.
- Hosts without File System Access keep the existing input picker, explicitly marked session-only. A failure on a supported host is reported; it does not silently switch to a temporary binding.

## Verification

Focused tests cover permission gating, storage failures, cancellation, relinking and alias refresh, stale reads, URL cleanup, inactive static bindings, component references, saved metadata, and undo. Existing movie/audio behavior tests also pass.

Two minimal end-to-end tests use real native OPFS file handles and real IndexedDB structured cloning. They save and reopen a `.loom.json`, then verify identical file bytes, fresh URLs, and rejected old URLs after Chromium reload and a full two-process Electron restart. The Electron launches use one temporary persistent profile, sandboxing, context isolation, no Node integration, and disabled GPU. All owned test processes and the temporary profile are removed afterward.

OPFS handles already have permission. These tests prove persistence and reopening, but do not exercise an external OS file picker or its permission dialogs. Those dialogs still need a manual check in the running desktop/browser UI. Permission branches and the picker-to-command boundary have focused unit coverage.

Validation uses scoped Vitest tests, the required repository gates, lint, typecheck, build, and only the two persistence E2E tests. The full test suite is deliberately not run.

Final results: 208 tests across 13 focused files passed; both persistence E2E tests passed; all 51 required gate files passed. `pnpm typecheck`, `pnpm lint`, and `pnpm build` passed. Lint reported four existing warnings, and the build reported its existing large-chunk warning. Both temporary test-server ports were verified released.
