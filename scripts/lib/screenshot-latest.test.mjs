import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { renderLatestIndex, updateLatest } from './screenshot-latest.mjs';

function makeRun(root, name, files) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(path.join(dir, file), content);
  return dir;
}
const entry = (file, ok = true) => ({
  file,
  ok,
  title: `T ${file}`,
  viewport: '1x1',
  size: '1 KB',
  mode: 'viewport',
});

test('run penuh menggantikan latest seluruhnya (berkas basi dihapus)', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'latest-test-'));
  try {
    const latest = path.join(root, 'latest');
    mkdirSync(latest);
    writeFileSync(path.join(latest, 'basi.png'), 'x');
    const out = makeRun(root, 'r1', { 'a.png': 'A1', 'b.png': 'B1' });
    const result = updateLatest({
      outDir: out,
      latestDir: latest,
      entries: [entry('a.png'), entry('b.png')],
      full: true,
      runName: 'r1',
      createdAt: 't1',
    });
    assert.equal(result.mode, 'replace');
    assert.deepEqual(readdirSync(latest).sort(), ['a.png', 'b.png', 'index.md', 'manifest.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run parsial menggabung per berkas dan memperbarui index', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'latest-test-'));
  try {
    const latest = path.join(root, 'latest');
    updateLatest({
      outDir: makeRun(root, 'r1', { 'a.png': 'A1', 'b.png': 'B1' }),
      latestDir: latest,
      entries: [entry('a.png'), entry('b.png')],
      full: true,
      runName: 'r1',
      createdAt: 't1',
    });
    const result = updateLatest({
      outDir: makeRun(root, 'r2', { 'b.png': 'B2' }),
      latestDir: latest,
      entries: [entry('b.png'), entry('c.png', false)],
      full: false,
      runName: 'r2',
      createdAt: 't2',
    });
    assert.equal(result.mode, 'merge');
    assert.equal(readFileSync(path.join(latest, 'a.png'), 'utf8'), 'A1');
    assert.equal(readFileSync(path.join(latest, 'b.png'), 'utf8'), 'B2');
    assert.ok(!existsSync(path.join(latest, 'c.png')));
    const index = readFileSync(path.join(latest, 'index.md'), 'utf8');
    assert.match(index, /\| a\.png .*\| t1 \| r1 \|/);
    assert.match(index, /\| b\.png .*\| t2 \| r2 \|/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run penuh dengan kegagalan menggabung agar berkas lama tetap ada', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'latest-test-'));
  try {
    const latest = path.join(root, 'latest');
    updateLatest({
      outDir: makeRun(root, 'r1', { 'a.png': 'A1', 'b.png': 'B1' }),
      latestDir: latest,
      entries: [entry('a.png'), entry('b.png')],
      full: true,
      runName: 'r1',
      createdAt: 't1',
    });
    const result = updateLatest({
      outDir: makeRun(root, 'r2', { 'a.png': 'A2' }),
      latestDir: latest,
      entries: [entry('a.png'), entry('b.png', false)],
      full: true,
      runName: 'r2',
      createdAt: 't2',
    });
    assert.equal(result.mode, 'merge');
    assert.equal(readFileSync(path.join(latest, 'b.png'), 'utf8'), 'B1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('berkas lama tanpa manifest tetap terdaftar', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'latest-test-'));
  try {
    const latest = path.join(root, 'latest');
    mkdirSync(latest);
    writeFileSync(path.join(latest, 'lama.png'), 'x');
    const result = updateLatest({
      outDir: makeRun(root, 'r1', { 'a.png': 'A' }),
      latestDir: latest,
      entries: [entry('a.png')],
      full: false,
      runName: 'r1',
      createdAt: 't1',
    });
    assert.deepEqual(result.files, ['a.png', 'lama.png']);
    assert.match(renderLatestIndex({ 'x.png': {} }), /\(tidak diketahui\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
