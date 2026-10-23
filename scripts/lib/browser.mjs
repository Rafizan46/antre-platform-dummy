// Pencarian dan peluncuran browser berbasis Chromium (Chrome/Edge/Chromium) untuk pnpm screenshots.
// Bagian pencarian murni (dapat diuji); peluncuran memakai profil sementara milik skrip sendiri
// dan hanya mematikan PID yang dibuatnya.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isAlive, killTree } from './proc.mjs';

const LINUX_NAMES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'microsoft-edge-stable',
];

/** Daftar lokasi kandidat berurutan (Chrome, lalu Chromium, lalu Edge). Murni. */
export function candidateBrowserPaths(platform, env = {}) {
  if (platform === 'win32') {
    const p = path.win32;
    const roots = [
      env.PROGRAMFILES || 'C:\\Program Files',
      env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
      env.LOCALAPPDATA,
    ].filter(Boolean);
    const out = [];
    for (const root of roots)
      out.push(p.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    for (const root of roots) out.push(p.join(root, 'Chromium', 'Application', 'chrome.exe'));
    for (const root of roots)
      out.push(p.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    return out;
  }
  if (platform === 'darwin') {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Chromium.app/Contents/MacOS/Chromium',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    const roots = ['/Applications', env.HOME ? path.posix.join(env.HOME, 'Applications') : null];
    return roots.filter(Boolean).flatMap((root) => apps.map((app) => path.posix.join(root, app)));
  }
  const dirs = (env.PATH || '').split(':').filter(Boolean);
  const fixed = ['/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/google/chrome'];
  const out = [];
  for (const name of LINUX_NAMES) {
    for (const dir of [...dirs, ...fixed.filter((d) => !dirs.includes(d))]) {
      out.push(path.posix.join(dir, name));
    }
  }
  out.push('/opt/google/chrome/chrome');
  return [...new Set(out)];
}

/** CHROME_PATH dulu, lalu kandidat. Melempar Error berpesan jelas bila tidak ada. */
export function findBrowser({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
} = {}) {
  if (env.CHROME_PATH) {
    if (!exists(env.CHROME_PATH)) {
      throw new Error(`CHROME_PATH menunjuk ke berkas yang tidak ada: ${env.CHROME_PATH}`);
    }
    return { path: env.CHROME_PATH, source: 'CHROME_PATH' };
  }
  const candidates = candidateBrowserPaths(platform, env);
  const found = candidates.find((candidate) => exists(candidate));
  if (!found) {
    throw new Error(
      'Browser Chrome/Chromium/Edge tidak ditemukan. Pasang salah satunya atau atur env CHROME_PATH ' +
        'ke berkas eksekutabelnya (mis. CHROME_PATH="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"). ' +
        `Lokasi yang dicoba: ${candidates.slice(0, 6).join(', ')}${candidates.length > 6 ? ', ...' : ''}`,
    );
  }
  return { path: found, source: 'auto' };
}

/** Argumen Chrome. Port debug 0 = acak (dibaca dari DevToolsActivePort). */
export function chromeArgs({ userDataDir, width, height, root = false }) {
  return [
    '--headless=new',
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    ...(root ? ['--no-sandbox'] : []),
    'about:blank',
  ];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Meluncurkan Chrome headless berprofil sementara. Mengembalikan { pid, port, wsUrl, close }. */
export async function launchBrowser({ executable, width = 1440, height = 900 }) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'antre-shots-'));
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  const child = spawn(executable, chromeArgs({ userDataDir, width, height, root }), {
    stdio: 'ignore',
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  let exited = false;
  let spawnError = null;
  child.once('exit', () => {
    exited = true;
  });
  child.once('error', (error) => {
    exited = true;
    spawnError = error;
  });

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (child.pid) {
      killTree(child.pid);
      const deadline = Date.now() + 5_000;
      while (!exited && Date.now() < deadline) await sleep(100);
      if (isAlive(child.pid)) killTree(child.pid, { force: true });
    }
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }

  try {
    const portFile = path.join(userDataDir, 'DevToolsActivePort');
    let port = 0;
    const deadline = Date.now() + 30_000;
    while (!port) {
      if (spawnError) throw new Error(`gagal menjalankan browser: ${spawnError.message}`);
      if (exited) throw new Error('browser berhenti sebelum siap (periksa CHROME_PATH).');
      if (Date.now() > deadline) throw new Error('browser tidak siap dalam 30 detik.');
      if (existsSync(portFile)) {
        port = Number(readFileSync(portFile, 'utf8').split(/\r?\n/)[0]) || 0;
      }
      if (!port) await sleep(100);
    }
    let wsUrl = null;
    while (!wsUrl) {
      if (Date.now() > deadline) throw new Error('target halaman browser tidak muncul.');
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        wsUrl = targets.find((target) => target.type === 'page')?.webSocketDebuggerUrl ?? null;
      } catch {
        // belum siap
      }
      if (!wsUrl) await sleep(100);
    }
    return { pid: child.pid, port, wsUrl, userDataDir, close };
  } catch (error) {
    await close();
    throw error;
  }
}
