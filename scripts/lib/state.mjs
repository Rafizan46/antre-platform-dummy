// Lokasi file runtime dev (.run/) dan pembacaan status yang ditulis dev:all.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ROOT } from './env.mjs';

// ANTRE_RUN_DIR memisahkan state/log/token kiosk (dipakai pnpm screenshots --start agar tidak menimpa .run milik dev:all).
export const RUN_DIR = process.env.ANTRE_RUN_DIR
  ? path.resolve(process.env.ANTRE_RUN_DIR)
  : path.join(ROOT, '.run');
export const LOG_DIR = path.join(RUN_DIR, 'logs');
export const STATE_FILE = path.join(RUN_DIR, 'state.json');

export function logPath(name) {
  return path.join(LOG_DIR, `${name}.log`);
}

export function writeState(state, file = STATE_FILE) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
}

export function readState(file = STATE_FILE) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  } catch {
    return null;
  }
}

export function clearState(file = STATE_FILE) {
  rmSync(file, { force: true });
}
