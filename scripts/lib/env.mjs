// Pemuatan dan penurunan env untuk skrip dev (dev:all, demo:seed). Murni dan dapat diuji.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Membaca satu file dotenv; file yang tidak ada dianggap kosong. */
export function readEnvFile(file) {
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
}

// URL yang memuat port host Docker. Bila port berubah (POSTGRES_HOST_PORT dst.) dan URL-nya tidak
// diatur eksplisit, port pada URL dari .env.example ikut diganti.
const PORT_DERIVED_URLS = [
  ['DATABASE_ADMIN_URL', 'POSTGRES_HOST_PORT'],
  ['DATABASE_MIGRATOR_URL', 'POSTGRES_HOST_PORT'],
  ['DATABASE_APP_URL', 'POSTGRES_HOST_PORT'],
  ['DATABASE_PLATFORM_ADMIN_URL', 'POSTGRES_HOST_PORT'],
  ['REDIS_URL', 'REDIS_HOST_PORT'],
  ['RABBITMQ_URL', 'RABBITMQ_AMQP_HOST_PORT'],
  ['RABBITMQ_MANAGEMENT_URL', 'RABBITMQ_MANAGEMENT_HOST_PORT'],
];

function withPort(url, port) {
  const parsed = new URL(url);
  parsed.port = String(port);
  const text = parsed.toString();
  // new URL menambahkan "/" pada URL tanpa path; kembalikan bentuk semula.
  return parsed.pathname === '/' && !url.endsWith('/') ? text.replace(/\/$/, '') : text;
}

/**
 * Prioritas: env proses > .env > .env.example. URL turunan (CORE_SERVICES_URL, URL database, dst.)
 * mengikuti port efektif bila tidak diatur eksplisit.
 */
export function resolveEnv({ example, dotenv = {}, processEnv = {} }) {
  const explicit = { ...dotenv };
  for (const key of Object.keys(example)) {
    if (processEnv[key] !== undefined && processEnv[key] !== '') explicit[key] = processEnv[key];
  }
  const env = { ...example, ...explicit };

  for (const [urlKey, portKey] of PORT_DERIVED_URLS) {
    if (explicit[urlKey] === undefined && env[urlKey] && env[portKey]) {
      env[urlKey] = withPort(env[urlKey], env[portKey]);
    }
  }
  if (explicit.CORE_SERVICES_URL === undefined) {
    env.CORE_SERVICES_URL = `http://${env.CORE_SERVICES_HOST}:${env.CORE_SERVICES_PORT}`;
  }
  return env;
}

/** Env efektif dari file repo dan env proses saat ini. */
export function loadEnv(root = ROOT, processEnv = process.env) {
  return resolveEnv({
    example: readEnvFile(path.join(root, '.env.example')),
    dotenv: readEnvFile(path.join(root, '.env')),
    processEnv,
  });
}
