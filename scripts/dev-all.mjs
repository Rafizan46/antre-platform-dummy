// pnpm dev:all: menyalakan seluruh sistem di laptop dengan satu perintah.
// Docker (Postgres, Redis, RabbitMQ) -> db:setup -> build -> 4 service + Vite web-staff -> tunggu /readyz.
// Ctrl+C mematikan semuanya. Opsi: --no-build (lewati build, pakai dist yang ada).
// Env opsional: COMPOSE_PROJECT_NAME, CORE_SERVICES_PORT, NOTIFICATION_WORKER_PORT, WA_CHANNEL_PORT,
// REALTIME_PORT, WEB_PORT, *_HOST_PORT (lihat .env.example).
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { loadEnv, ROOT } from './lib/env.mjs';
import {
  colorize,
  isAlive,
  isPortFree,
  killTree,
  lineSplitter,
  runToExit,
  spawnPnpm,
  waitHttp,
} from './lib/proc.mjs';
import { clearState, LOG_DIR, logPath, readState, writeState } from './lib/state.mjs';

const args = new Set(process.argv.slice(2));
const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const say = (message) => console.log(message);

function fail(message) {
  console.error(`\n[dev:all] GAGAL: ${message}\n`);
  process.exit(1);
}

const env = loadEnv();
const composeProject = process.env.COMPOSE_PROJECT_NAME || 'antre-dev';
const webPort = Number(process.env.WEB_PORT || 5173);
const childEnv = { ...process.env, ...env, WEB_PORT: String(webPort) };

const base = (host, port) => `http://${host}:${port}`;
const services = [
  {
    name: 'core',
    label: 'core-services',
    dir: 'apps/core-services',
    portKey: 'CORE_SERVICES_PORT',
    port: Number(env.CORE_SERVICES_PORT),
    url: base(env.CORE_SERVICES_HOST, env.CORE_SERVICES_PORT),
  },
  {
    name: 'worker',
    label: 'notification-worker',
    dir: 'apps/notification-worker',
    portKey: 'NOTIFICATION_WORKER_PORT',
    port: Number(env.NOTIFICATION_WORKER_PORT),
    url: base(env.NOTIFICATION_WORKER_HOST, env.NOTIFICATION_WORKER_PORT),
  },
  {
    name: 'wa',
    label: 'wa-channel',
    dir: 'apps/wa-channel',
    portKey: 'WA_CHANNEL_PORT',
    port: Number(env.WA_CHANNEL_PORT),
    url: base(env.WA_CHANNEL_HOST, env.WA_CHANNEL_PORT),
  },
  {
    name: 'realtime',
    label: 'realtime-gateway',
    dir: 'apps/realtime-gateway',
    portKey: 'REALTIME_PORT',
    port: Number(env.REALTIME_PORT),
    url: base(env.REALTIME_HOST, env.REALTIME_PORT),
  },
].map((service) => ({
  ...service,
  command: process.execPath,
  args: ['dist/server.js'],
  readyUrl: `${service.url}/readyz`,
}));

const viteBin = path.join(ROOT, 'apps/web-staff/node_modules/vite/bin/vite.js');
const webUrl = base('127.0.0.1', webPort);
services.push({
  name: 'web',
  label: 'web-staff (Vite)',
  dir: 'apps/web-staff',
  portKey: 'WEB_PORT',
  port: webPort,
  url: webUrl,
  command: process.execPath,
  args: [viteBin, '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
  readyUrl: `${webUrl}/`,
  env: {
    API_PROXY_TARGET: env.CORE_SERVICES_URL,
    REALTIME_PROXY_TARGET: base(env.REALTIME_HOST, env.REALTIME_PORT),
  },
});

// 1. Sudah berjalan?
const previous = readState();
if (
  previous?.supervisorPid &&
  previous.supervisorPid !== process.pid &&
  isAlive(previous.supervisorPid)
) {
  fail(
    `dev:all sudah berjalan (PID ${previous.supervisorPid}). Hentikan dulu dengan: pnpm dev:stop`,
  );
}

// 2. Docker menyala?
say('[dev:all] Memeriksa Docker ...');
const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
  encoding: 'utf8',
  timeout: 30_000,
  windowsHide: true,
});
if (docker.error || docker.status !== 0) {
  fail(
    'Docker belum menyala atau tidak ditemukan. Jalankan Docker Desktop (atau daemon Docker), tunggu sampai siap, lalu ulangi pnpm dev:all.',
  );
}

// 3. Port bentrok?
for (const service of services) {
  if (!(await isPortFree(service.port))) {
    fail(
      `Port ${service.port} (${service.label}) sudah dipakai proses lain. Hentikan prosesnya, atau ubah port lewat env ${service.portKey}, misalnya ${service.portKey}=${service.port + 1} pnpm dev:all`,
    );
  }
}

// 4. Docker compose.
const composeArgs = ['compose', '-f', 'docker-compose.dev.yml', '-p', composeProject];
say(`[dev:all] Menyalakan Postgres, Redis, RabbitMQ (project compose "${composeProject}") ...`);
const up = await runToExit(
  spawn('docker', [...composeArgs, 'up', '-d', '--wait'], {
    cwd: ROOT,
    env: childEnv,
    stdio: 'inherit',
    windowsHide: true,
  }),
);
if (up !== 0) {
  fail(
    'docker compose gagal. Bila pesannya soal "port is already allocated", ubah POSTGRES_HOST_PORT / REDIS_HOST_PORT / RABBITMQ_AMQP_HOST_PORT / RABBITMQ_MANAGEMENT_HOST_PORT.',
  );
}

// 5. Database.
say('[dev:all] Menyiapkan database (pnpm db:setup) ...');
const dbCode = await runToExit(
  spawnPnpm(['db:setup'], { cwd: ROOT, env: childEnv, stdio: 'inherit', windowsHide: true }),
);
if (dbCode !== 0) fail('pnpm db:setup gagal (lihat pesan di atas).');

// 6. Build.
if (args.has('--no-build')) {
  say('[dev:all] Build dilewati (--no-build).');
} else {
  say('[dev:all] Membangun service ...');
  const filters = services
    .filter((service) => service.name !== 'web')
    .flatMap((service) => ['--filter', `@antre/${service.label}`]);
  const buildCode = await runToExit(
    spawnPnpm([...filters, 'build'], {
      cwd: ROOT,
      env: childEnv,
      stdio: 'inherit',
      windowsHide: true,
    }),
  );
  if (buildCode !== 0) fail('Build gagal (lihat pesan di atas).');
}
for (const service of services) {
  if (service.name !== 'web' && !existsSync(path.join(ROOT, service.dir, 'dist/server.js'))) {
    fail(`${service.dir}/dist/server.js tidak ada. Jalankan tanpa --no-build.`);
  }
}
if (!existsSync(viteBin)) fail('Vite tidak ditemukan. Jalankan pnpm install.');

// 7. Jalankan proses.
mkdirSync(LOG_DIR, { recursive: true });
const running = [];
let shuttingDown = false;

function track(service, index) {
  const logFile = logPath(service.name);
  const log = createWriteStream(logFile, { flags: 'w' });
  const prefix = colorize(index, `[${service.name}]`.padEnd(11), useColor);
  const child = spawn(service.command, service.args, {
    cwd: path.join(ROOT, service.dir),
    env: { ...childEnv, ...(service.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  const entry = { service, child, log, exited: false, code: null, logFile };
  const split = lineSplitter((line) => console.log(`${prefix} ${line}`));
  const onData = (chunk) => {
    log.write(chunk);
    split.push(chunk);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.once('exit', (code, signal) => {
    entry.exited = true;
    entry.code = code ?? signal;
    split.flush();
    if (!shuttingDown) {
      console.error(
        `\n[dev:all] ${service.label} berhenti tiba-tiba (kode ${entry.code}). Log: ${logFile}`,
      );
      void shutdown(1);
    }
  });
  running.push(entry);
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  say('\n[dev:all] Mematikan semua proses ...');
  for (const entry of running) if (!entry.exited) killTree(entry.child.pid);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && running.some((entry) => !entry.exited)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const entry of running) if (!entry.exited) killTree(entry.child.pid, { force: true });
  for (const entry of running) entry.log.end();
  clearState();
  say('[dev:all] Selesai. Kontainer Docker tetap menyala; matikan dengan: pnpm dev:stop --down');
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => void shutdown(0));

services.forEach(track);
writeState({
  supervisorPid: process.pid,
  startedAt: new Date().toISOString(),
  writtenAt: Date.now(),
  composeProject,
  composeArgs,
  pids: Object.fromEntries(running.map((entry) => [entry.service.name, entry.child.pid])),
  logs: Object.fromEntries(services.map((service) => [service.name, logPath(service.name)])),
  urls: {
    core: services[0].url,
    waChannel: services[2].url,
    realtime: services[3].url,
    web: webUrl,
  },
});

// 8. Tunggu siap.
say('[dev:all] Menunggu semua service siap ...');
try {
  await Promise.all(
    running.map(async (entry) => {
      await waitHttp(entry.service.readyUrl, {
        timeoutMs: 90_000,
        abort: () =>
          entry.exited ? `${entry.service.label} berhenti saat start. Log: ${entry.logFile}` : null,
      });
      say(`[dev:all]   siap: ${entry.service.label} (${entry.service.readyUrl})`);
    }),
  );
} catch (error) {
  console.error(`\n[dev:all] GAGAL: ${error.message}`);
  await shutdown(1);
}

// 9. Ringkasan.
const kioskUrl = `${webUrl}/kiosk.html?token=<token kiosk>`;
say(`
==================== Antre siap dipakai ====================
 Web staf/owner : ${webUrl}
 Kiosk TV       : ${kioskUrl}
                  (token dibuat oleh "pnpm demo:seed" atau di Pengaturan > Token kiosk)
 API core       : ${services[0].url}/api/v1
 Webhook WA     : ${services[2].url}/api/v1/channels/wa/webhook
 Log service    : ${path.relative(ROOT, LOG_DIR)}${path.sep}*.log

 Langkah berikutnya (terminal lain):
   pnpm demo:seed                 isi tenant demo "Klinik Demo" (idempoten)
   pnpm wa 6281234567890 "ANTRE klinik-demo pusat"   simulasi pelanggan WhatsApp
   pnpm dev:stop                  hentikan sisa proses (--down: matikan Docker juga)
 Tekan Ctrl+C di sini untuk mematikan semuanya.
============================================================`);

// Menjaga proses tetap hidup; shutdown() yang mengakhiri.
setInterval(() => {}, 1 << 30);
