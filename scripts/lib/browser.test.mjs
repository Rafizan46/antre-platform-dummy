import assert from 'node:assert/strict';
import { test } from 'node:test';

import { candidateBrowserPaths, chromeArgs, findBrowser } from './browser.mjs';

test('CHROME_PATH menang bila ada', () => {
  const found = findBrowser({
    platform: 'linux',
    env: { CHROME_PATH: '/x/chrome' },
    exists: (p) => p === '/x/chrome',
  });
  assert.deepEqual(found, { path: '/x/chrome', source: 'CHROME_PATH' });
});

test('CHROME_PATH yang tidak ada memberi pesan jelas', () => {
  assert.throws(
    () => findBrowser({ platform: 'linux', env: { CHROME_PATH: '/x' }, exists: () => false }),
    /CHROME_PATH menunjuk/,
  );
});

test('Windows: Chrome diprioritaskan lalu Edge', () => {
  const list = candidateBrowserPaths('win32', {});
  assert.match(list[0], /Google.Chrome.Application.chrome\.exe$/);
  assert.ok(list.some((p) => /msedge\.exe$/.test(p)));
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  assert.equal(findBrowser({ platform: 'win32', env: {}, exists: (p) => p === edge }).path, edge);
});

test('macOS dan Linux memiliki kandidat khas', () => {
  assert.ok(
    candidateBrowserPaths('darwin', {}).includes(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ),
  );
  const linux = candidateBrowserPaths('linux', { PATH: '/a:/b' });
  assert.ok(linux.includes('/a/chromium-browser'));
  assert.ok(linux.includes('/snap/bin/microsoft-edge'));
  const found = findBrowser({
    platform: 'linux',
    env: { PATH: '/a' },
    exists: (p) => p === '/a/chromium',
  });
  assert.equal(found.path, '/a/chromium');
});

test('tanpa browser: pesan menyebut CHROME_PATH', () => {
  assert.throws(
    () => findBrowser({ platform: 'linux', env: {}, exists: () => false }),
    /CHROME_PATH/,
  );
});

test('argumen Chrome: headless baru, profil sendiri, port acak', () => {
  const args = chromeArgs({ userDataDir: '/tmp/p', width: 10, height: 20 });
  for (const flag of [
    '--headless=new',
    '--user-data-dir=/tmp/p',
    '--remote-debugging-port=0',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
  ]) {
    assert.ok(args.includes(flag), flag);
  }
  assert.ok(!args.includes('--no-sandbox'));
  assert.ok(
    chromeArgs({ userDataDir: 'x', width: 1, height: 1, root: true }).includes('--no-sandbox'),
  );
});
