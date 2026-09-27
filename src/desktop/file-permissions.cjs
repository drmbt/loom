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

function installFilePermissions({ session, origin, confirm, report, requestSystemAccess, notify }) {
  const pending = new WeakSet();
  const media = createMediaPermissions({ origin, confirm, report, requestSystemAccess, notify });
  // No broad grant cache. Chromium owns its document/path-scoped grants; checks
  // without one must reach the explicit request below, never auto-approve.
  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    displayGrant(contents, permission, details?.requestingUrl ?? requestingOrigin, origin) ||
    media.check(contents, permission, requestingOrigin, details));
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (DISPLAY_PERMISSIONS.has(permission)) {
      const granted = displayGrant(contents, permission, details?.requestingUrl, origin);
      if (!granted) report(`Denied desktop permission: ${permission}`);
      callback(granted);
      return;
    }
    if (media.handles(permission)) { media.request(contents, permission, callback, details); return; }
    if (permission !== 'fileSystem' || !contents || contents.isDestroyed() ||
        !allowNavigation(contents.getURL(), origin) ||
        !allowNavigation(details?.requestingUrl, origin) ||
        typeof details.filePath !== 'string' || !isAbsolute(details.filePath) ||
        details.isDirectory !== false ||
        !['readable', 'writable'].includes(details.fileAccessType) || pending.has(contents)) {
      report(`Denied desktop permission: ${permission}`);
      callback(false);
      return;
    }
    // Electron reports isMainFrame=false for fileSystem even for the main frame.
    // Validate both URLs instead. Any navigation revokes this outstanding prompt.
    let settled = false;
    const settle = granted => {
      if (settled) return;
      settled = true;
      pending.delete(contents);
      contents.removeListener('did-start-navigation', revoke);
      contents.removeListener('destroyed', revoke);
      callback(granted);
    };
    const revoke = () => settle(false);
    pending.add(contents);
    contents.on('did-start-navigation', revoke);
    contents.once('destroyed', revoke);
    void Promise.resolve().then(() => {
      if (settled) return false;
      return confirm(contents, {
        title: 'Loom file access',
        message: details.fileAccessType === 'writable' ? 'Allow Loom to modify this file?' : 'Allow Loom to read this file?',
        detail: details.filePath,
        buttons: ['Deny', 'Allow'], defaultId: 0, cancelId: 0, noLink: true,
      });
    }).then(allowed => settle(allowed === true && !contents.isDestroyed() &&
      allowNavigation(contents.getURL(), origin)), error => {
      report(`File permission dialog failed: ${String(error)}`);
      settle(false);
    });
  });
  // Never turn a protected OS path into an ordinary file grant.
  session.on('file-system-access-restricted', (_event, _details, callback) => {
    report('Denied restricted filesystem path');
    callback('deny');
  });
  return media;
}

module.exports = { installFilePermissions };
