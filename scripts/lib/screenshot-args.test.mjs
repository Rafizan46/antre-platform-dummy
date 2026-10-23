import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertSafePorts,
  parseScreenshotArgs,
  shotName,
  stackPorts,
  timestamp,
} from './screenshot-args.mjs';

const KNOWN = ['login', 'kiosk'];

test('bawaan: stack dev yang berjalan', () => {
  const a = parseScreenshotArgs([], KNOWN);
  assert.equal(a.url, 'http://127.0.0.1:5173');
  assert.equal(a.api, 'http://127.0.0.1:3000');
  assert.equal(a.start, false);
  assert.equal(a.only, null);
  assert.equal(a.size, null);
});

test('opsi url, api, out, only, ukuran tunggal', () => {
  const a = parseScreenshotArgs(
    [
      '--url',
      'http://localhost:9/x',
      '--api',
      'http://h:1',
      '--out',
      'o',
      '--only',
      'login, kiosk',
      '--width',
      '800',
      '--height',
      '600',
    ],
    KNOWN,
  );
  assert.equal(a.url, 'http://localhost:9');
  assert.equal(a.api, 'http://h:1');
  assert.deepEqual(a.only, ['login', 'kiosk']);
  assert.deepEqual(a.size, { name: '800x600', width: 800, height: 600, mobile: false });
});

test('validasi: layar tak dikenal, pasangan ukuran, URL, --start dengan --url', () => {
  assert.throws(() => parseScreenshotArgs(['--only', 'xyz'], KNOWN), /tidak dikenal/);
  assert.throws(() => parseScreenshotArgs(['--width', '5'], KNOWN), /berpasangan/);
  assert.throws(() => parseScreenshotArgs(['--url', 'bukan-url'], KNOWN), /URL/);
  assert.throws(() => parseScreenshotArgs(['--url', 'ftp://a'], KNOWN), /http/);
  assert.throws(() => parseScreenshotArgs(['--start', '--url', 'http://a'], KNOWN), /--start/);
  assert.throws(() => parseScreenshotArgs(['--width', '0', '--height', '5'], KNOWN), /positif/);
  assert.throws(() => parseScreenshotArgs(['--nope'], KNOWN));
});

test('port stack terisolasi tidak menyentuh port dev pengguna', () => {
  const ports = stackPorts(57000);
  assert.equal(ports.web, 57004);
  assert.doesNotThrow(() => assertSafePorts(ports));
  assert.throws(() => assertSafePorts(stackPorts(3000)), /milik stack dev/);
});

test('penamaan berkas dan timestamp', () => {
  assert.equal(shotName(1, 'login', 'desktop'), '01-login-desktop.png');
  assert.equal(shotName(12, 'pengaturan-jam', 'phone'), '12-pengaturan-jam-phone.png');
  assert.equal(timestamp(new Date(2026, 9, 23, 4, 5, 6)), '20261023-040506');
});
