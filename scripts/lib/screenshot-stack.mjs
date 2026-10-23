// Stack terisolasi untuk pnpm screenshots --start: project compose "antre-shots", port 570xx,
// state/log di .run/screenshots-stack. Tidak menyentuh stack dev pengguna.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { readEnvFile, resolveEnv, ROOT } from './env.mjs';
import { isPortFree, killTree, waitHttp } from './proc.mjs';
import { assertSafePorts, stackPorts } from './screenshot-args.mjs';

export const SHOTS_PROJECT = 'antre-shots';
export const STACK_DIR = path.join(ROOT, '.run', 'screenshots-stack');

/** Env lengkap stack terisolasi (mengabaikan .env pengguna agar URL turunan konsisten). */
export function stackEnv(ports, baseEnv = process.env) {
  const example = readEnvFile(path.join(ROOT, '.env.example'));
  const resolved = resolveEnv({
    example,
    dotenv: {},
    processEnv: {
      CORE_SERVICES_PORT: String(ports.core),
      NOTIFICATION_WORKER_PORT: String(ports.worker),
      WA_CHANNEL_PORT: String(ports.wa),
      REALTIME_PORT: String(ports.realtime),
      POSTGRES_HOST_PORT: String(ports.postgres),
      REDIS_HOST_PORT: String(ports.redis),
      RABBITMQ_AMQP_HOST_PORT: String(ports.amqp),
      RABBITMQ_MANAGEMENT_HOST_PORT: String(ports.management),
    },
  });
  return {
    ...baseEnv,
    ...resolved,
    WEB_PORT: String(ports.web),
    COMPOSE_PROJECT_NAME: SHOTS_PROJECT,
    ANTRE_RUN_DIR: STACK_DIR,
  };
}

function runSync(args, env) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    windowsHide: true,
    timeout: 180_000,
  });
}

export async function startStack({ basePort, noBuild, log }) {
  const ports = stackPorts(basePort);
  assertSafePorts(ports);
  for (const [name, port] of Object.entries(ports)) {
    if (!(await isPortFree(port))) {
      throw new Error(`Port ${port} (${name}) sudah dipakai; pilih --base-port lain.`);
    }
  }
  const env = stackEnv(ports);
  mkdirSync(STACK_DIR, { recursive: true });
  const logFile = path.join(STACK_DIR, 'dev-all.log');
  const out = createWriteStream(logFile, { flags: 'w' });
  log(`menyalakan stack terisolasi (project ${SHOTS_PROJECT}, port ${basePort}+); log: ${logFile}`);

  const child = spawn(
    process.execPath,
    [path.join(ROOT, 'scripts', 'dev-all.mjs'), ...(noBuild ? ['--no-build'] : [])],
    {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    },
  );
  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(out, { end: false });
  let exited = false;
  child.once('exit', (code) => {
    exited = code ?? 1;
  });

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    log('mematikan stack terisolasi ...');
    if (child.pid) killTree(child.pid);
    const deadline = Date.now() + 8_000;
    while (exited === false && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (child.pid) killTree(child.pid, { force: true });
    // dev:stop membaca state di STACK_DIR (ANTRE_RUN_DIR); project dipaksa lewat COMPOSE_PROJECT_NAME.
    runSync([path.join(ROOT, 'scripts', 'dev-stop.mjs'), '--down'], env);
    // Hapus volume project ini saja agar eksekusi berikutnya mulai bersih.
    spawnSync(
      'docker',
      ['compose', '-f', 'docker-compose.dev.yml', '-p', SHOTS_PROJECT, 'down', '-v'],
      { cwd: ROOT, env, stdio: 'ignore', windowsHide: true, timeout: 120_000 },
    );
    out.end();
    rmSync(STACK_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }

  try {
    const abort = () =>
      exited === false ? null : `dev:all berhenti (kode ${exited}). Log: ${logFile}`;
    const base = (port) => `http://127.0.0.1:${port}`;
    await Promise.all([
      waitHttp(`${base(ports.core)}/readyz`, { timeoutMs: 600_000, abort }),
      waitHttp(`${base(ports.wa)}/readyz`, { timeoutMs: 600_000, abort }),
      waitHttp(`${base(ports.realtime)}/readyz`, { timeoutMs: 600_000, abort }),
      waitHttp(`${base(ports.web)}/`, { timeoutMs: 600_000, abort }),
    ]);
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    web: `http://127.0.0.1:${ports.web}`,
    api: `http://127.0.0.1:${ports.core}`,
    wa: `http://127.0.0.1:${ports.wa}`,
    waSecret: env.WA_APP_SECRET,
    stop,
  };
}
