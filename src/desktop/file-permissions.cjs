/* global require, module */
/* eslint-disable @typescript-eslint/no-require-imports */
const { isAbsolute } = require('node:path');
const { allowNavigation } = require('./policy.cjs');
const { createMediaPermissions } = require('./media-permissions.cjs');

/*
 * T1408b: a perform window (a Window Out's popup) must go fullscreen and be placed on a
 * chosen display. Both are granted ONLY to Loom's own documents: the app origin, and the
 * about:blank `loom-*` popups it opens (main.cjs denies every other popup, so an
 * about:blank page here can only be one of ours). Nothing else is widened.
 */
const DISPLAY_PERMISSIONS = new Set(['fullscreen', 'window-management']);
function displayGrant(contents, permission, requestingUrl, origin) {
  if (!DISPLAY_PERMISSIONS.has(permission) || !contents || contents.isDestroyed()) return false;
  const url = contents.getURL();
  const ours = allowNavigation(url, origin) || url === 'about:blank';
  const asker = requestingUrl === undefined || allowNavigation(requestingUrl, origin) || requestingUrl === 'about:blank';
  return ours && asker;
}

/*
 * VNB4: a file handle the user gave Loom is the consent to use it (ruling, 2026-10-05).
 *
 * Measured on Electron 44.5.1 (testing/file-access.test.cjs): once a session has a
 * permission CHECK handler, a file handle's status is that handler's answer alone, granted
 * or denied, never "prompt". That holds for a freshly picked or dropped file and for one
 * restored from storage, and undefined or null read as denied. So the earlier design,
 * which denied the check so that the request handler would ask, could not work: a denied
 * status makes requestPermission() return at once and the request handler is never called.
 * It refused every file Loom was given, including the one the user had just picked.
 *
 * A page can only hold a handle the user gave it, through a picker, a drop, or storage of
 * one of those, so holding it is the consent. Read and write are granted to Loom's own
 * document for an absolute path to a FILE. A directory is refused (Loom asks for none), and
 * so is any other origin. Protected OS paths are refused below. The price: a file chosen
 * in an earlier session opens again without asking, as a desktop app's recent files do.
 *
 * What a fileSystem check carries in 44.5.1 is narrower than the typings suggest: NO
 * webContents (null) and no requestingUrl, only the requesting origin (as a URL) and the
 * file details. The origin is therefore the guard; a webContents, should a later Electron
 * pass one, must be Loom's too.
 */
const FILE_ACCESS = new Set(['readable', 'writable']);
function fileGrant(contents, permission, requestingUrl, details, origin) {
  return permission === 'fileSystem' && allowNavigation(requestingUrl, origin) &&
    (contents === null || contents === undefined || (!contents.isDestroyed() && allowNavigation(contents.getURL(), origin))) &&
    typeof details?.filePath === 'string' && isAbsolute(details.filePath) &&
    details.isDirectory === false && FILE_ACCESS.has(details.fileAccessType);
}

function installFilePermissions({ session, origin, confirm, report, requestSystemAccess, notify }) {
  const media = createMediaPermissions({ origin, confirm, report, requestSystemAccess, notify });
  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    displayGrant(contents, permission, details?.requestingUrl ?? requestingOrigin, origin) ||
    fileGrant(contents, permission, details?.requestingUrl ?? requestingOrigin, details, origin) ||
    media.check(contents, permission, requestingOrigin, details));
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (DISPLAY_PERMISSIONS.has(permission)) {
      const granted = displayGrant(contents, permission, details?.requestingUrl, origin);
      if (!granted) report(`Denied desktop permission: ${permission}`);
      callback(granted);
      return;
    }
    if (media.handles(permission)) { media.request(contents, permission, callback, details); return; }
    // fileSystem never arrives here: its status is the check's answer above (VNB4), and a
    // denied status ends requestPermission() without a request. Anything that does arrive
    // is refused, as is every permission this file does not name.
    report(`Denied desktop permission: ${permission}`);
    callback(false);
  });
  // Never turn a protected OS path into an ordinary file grant.
  session.on('file-system-access-restricted', (_event, _details, callback) => {
    report('Denied restricted filesystem path');
    callback('deny');
  });
  return media;
}

module.exports = { installFilePermissions };
