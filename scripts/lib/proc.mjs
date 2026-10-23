// Utilitas proses untuk dev:all / dev:stop: tree kill lintas OS, pengecekan port, prefiks berwarna.
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

const COLORS = [36, 33, 35, 32, 34, 91];

export function colorize(index, text, enabled = true) {
  return enabled ? `\u001b[${COLORS[index % COLORS.length]}m${text}\u001b[0m` : text;
}

/** Memecah aliran teks menjadi baris utuh dan memanggil onLine untuk masing-masing. */
export function lineSplitter(onLine) {
  let rest = '';
  return {
    push(chunk) {
      rest += chunk.toString('utf8');
      const lines = rest.split(/\r?\n/);
      rest = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    },
    flush() {
      if (rest !== '') onLine(rest);
      rest = '';
    },
  };
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Mematikan proses beserta anak-anaknya. Windows: taskkill /T; POSIX: grup proses (detached). */
export function killTree(pid, { force = false } = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // sudah mati
    }
  }
}

/** true bila port bebas di host tersebut. */
export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/** Menunggu URL menjawab 200; berhenti lebih awal bila `abort()` mengembalikan alasan. */
export async function waitHttp(url, { timeoutMs = 60_000, abort = () => null } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reason = abort();
    if (reason) throw new Error(reason);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 200) return;
    } catch {
      // belum siap
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`tidak siap di ${url} dalam ${timeoutMs / 1000} detik`);
}

/** Menjalankan pnpm lintas OS (npm_execpath bila ada, selain itu lewat shell di Windows). */
export function spawnPnpm(args, options) {
  const execPath = process.env.npm_execpath;
  if (execPath && /pnpm/i.test(execPath)) {
    return spawn(process.execPath, [execPath, ...args], options);
  }
  return spawn('pnpm', args, { ...options, shell: process.platform === 'win32' });
}

export function runToExit(child) {
  return new Promise((resolve) => {
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

/** Waktu start proses (ms epoch), atau null bila tidak dapat ditentukan. */
export function processStartTime(pid) {
  const result =
    process.platform === 'win32'
      ? spawnSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            `(Get-Process -Id ${Number(pid)}).StartTime.ToUniversalTime().ToString('o')`,
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
        )
      : spawnSync('ps', ['-o', 'lstart=', '-p', String(Number(pid))], {
          encoding: 'utf8',
          timeout: 15_000,
          env: { ...process.env, LC_ALL: 'C' },
        });
  if (result.status !== 0) return null;
  const time = Date.parse(result.stdout.trim());
  return Number.isNaN(time) ? null : time;
}

/**
 * Proses dengan PID tercatat masih proses yang sama bila ia mulai sebelum state ditulis
 * (PID yang dipakai ulang pasti mulai sesudahnya). slackMs menutup resolusi 1 detik `ps`.
 */
export function sameProcess(startMs, stateWrittenMs, slackMs = 2_000) {
  return startMs !== null && startMs <= stateWrittenMs + slackMs;
}
