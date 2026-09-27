/* global require */
/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateOrigin, allowNavigation, allowPopup, webPreferences, performWindowOptions } = require('./policy.cjs');
test('only the owned loopback origin can host the development app', () => {
  assert.equal(validateOrigin('http://127.0.0.1:5187/'), 'http://127.0.0.1:5187');
  for (const value of ['https://example.com/', 'file:///app.html', 'http://127.0.0.1/',
    'http://127.0.0.1:5187/other', 'http://user@127.0.0.1:5187/', 'http://127.0.0.1.evil:5187/']) {
    assert.throws(() => validateOrigin(value));
  }
  assert.equal(allowNavigation('http://127.0.0.1:5187/', 'http://127.0.0.1:5187'), true);
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'https://example.com', 'http://127.0.0.1:5188/']) {
    assert.equal(allowNavigation(value, 'http://127.0.0.1:5187'), false);
  }
});
test('only named blank pane windows are allowed, with renderer privileges disabled', () => {
  assert.equal(allowPopup({ url: 'about:blank', frameName: 'loom-viewer' }), true);
  assert.equal(allowPopup({ url: 'https://example.com', frameName: 'loom-viewer' }), false);
  assert.equal(allowPopup({ url: 'about:blank', frameName: 'external' }), false);
  assert.equal(webPreferences.sandbox, true);
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.webSecurity, true);
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.nodeIntegrationInWorker, false);
  assert.equal(webPreferences.webviewTag, false);
});

test('T1408b: a perform window is frameless and black, fullscreen only when asked; other popups unchanged', () => {
  const name = 'loom-perform-77696e31';
  assert.deepEqual(performWindowOptions({ frameName: name, features: 'popup=yes,left=1512,top=0,width=1920,height=1080,fullscreen' }),
    { frame: false, autoHideMenuBar: true, backgroundColor: '#000000', fullscreen: true });
  assert.equal(performWindowOptions({ frameName: name, features: 'popup=yes,width=960,height=540' }).fullscreen, false);
  // A floated pane is not a perform window, and a look-alike name is not one either.
  assert.deepEqual(performWindowOptions({ frameName: 'loom-pane-viewer', features: 'popup=yes,fullscreen' }), {});
  assert.deepEqual(performWindowOptions({ frameName: 'loom-perform-x_y', features: 'fullscreen' }), {});
  // The name the app mints passes the popup gate.
  assert.equal(allowPopup({ url: 'about:blank', frameName: name }), true);
});
