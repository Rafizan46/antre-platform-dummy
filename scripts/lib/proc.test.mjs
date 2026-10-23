import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { test } from 'node:test';

import { isAlive, isPortFree, killTree, lineSplitter, waitHttp } from './proc.mjs';

test('lineSplitter menyatukan potongan menjadi baris utuh', () => {
  const lines = [];
  const split = lineSplitter((line) => lines.push(line));
  split.push('abc');
  split.push('def\nghi\r\njk');
  assert.deepEqual(lines, ['abcdef', 'ghi']);
  split.flush();
  assert.deepEqual(lines, ['abcdef', 'ghi', 'jk']);
});

test('isPortFree mendeteksi port yang dipakai', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.equal(await isPortFree(port), false);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await isPortFree(port), true);
});

test('killTree mematikan proses', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  assert.equal(isAlive(child.pid), true);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  killTree(child.pid);
  await exited;
  assert.equal(isAlive(child.pid), false);
});

test('waitHttp berhenti lebih awal bila abort mengembalikan alasan', async () => {
  await assert.rejects(
    waitHttp('http://127.0.0.1:1/', { timeoutMs: 5000, abort: () => 'proses mati' }),
    /proses mati/,
  );
});
