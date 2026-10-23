import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isAlive, processStartTime, sameProcess } from './proc.mjs';
import { downCommand, planDown } from './stop.mjs';

test('down memakai project dari state dev:all', () => {
  const composeArgs = ['compose', '-f', 'docker-compose.dev.yml', '-p', 'antre-s16'];
  assert.deepEqual(planDown({ state: { composeArgs }, processEnv: {}, yes: false }), {
    ok: true,
    composeArgs,
  });
});

test('tanpa state dan tanpa COMPOSE_PROJECT_NAME, down ditolak kecuali --yes', () => {
  const refused = planDown({ state: null, processEnv: {}, yes: false });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /--yes/);
  const allowed = planDown({ state: null, processEnv: {}, yes: true });
  assert.deepEqual(allowed.composeArgs.slice(-2), ['-p', 'antre-dev']);
});

test('COMPOSE_PROJECT_NAME eksplisit cukup tanpa --yes', () => {
  const plan = planDown({
    state: null,
    processEnv: { COMPOSE_PROJECT_NAME: 'antre-x' },
    yes: false,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.composeArgs.at(-1), 'antre-x');
});

test('perintah yang ditampilkan benar', () => {
  assert.equal(
    downCommand(['compose', '-f', 'docker-compose.dev.yml', '-p', 'p']).join(' '),
    'docker compose -f docker-compose.dev.yml -p p down',
  );
});

test('sameProcess menolak PID yang mulai setelah state ditulis atau tak diketahui', () => {
  assert.equal(sameProcess(1_000, 5_000), true);
  assert.equal(sameProcess(5_500, 5_000), true);
  assert.equal(sameProcess(9_000, 5_000), false);
  assert.equal(sameProcess(null, 5_000), false);
});

test('processStartTime membaca waktu start proses sendiri', () => {
  assert.equal(isAlive(process.pid), true);
  const start = processStartTime(process.pid);
  assert.ok(start !== null && start <= Date.now() + 2_000 && start > Date.now() - 3_600_000);
});
