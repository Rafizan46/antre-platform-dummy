// Child processes of the stack: the built (dist) services, started with a test environment, whose
// output goes to a log file, and which are stopped again at teardown on Windows and Linux.
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, readFileSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface ServiceHandle {
  name: string;
  child: ChildProcess;
  logFile: string;
  log: WriteStream;
  exited: boolean;
}

/** Only the basics of the parent environment, so nothing aimed at the dev stack leaks in. */
function baseEnv(): Record<string, string> {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'HOME'];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function startService(
  name: string,
  appDir: string,
  env: Record<string, string>,
  logFile: string,
): ServiceHandle {
  const log = createWriteStream(logFile, { flags: 'a' });
  const child = spawn(process.execPath, [path.join(appDir, 'dist', 'server.js')], {
    cwd: appDir,
    env: { ...baseEnv(), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const handle: ServiceHandle = { name, child, logFile, log, exited: false };
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.on('exit', () => {
    handle.exited = true;
  });
  return handle;
}

export function tail(file: string, lines = 25): string {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

/** Polls the URL until it answers 200; fails fast when the process exits, with its log tail. */
export async function waitReady(
  handle: ServiceHandle,
  url: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle.exited) {
      throw new Error(`${handle.name} exited during startup:\n${tail(handle.logFile)}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await delay(150);
  }
  throw new Error(
    `${handle.name} was not ready at ${url} in ${timeoutMs} ms:\n${tail(handle.logFile)}`,
  );
}

export async function stopService(handle: ServiceHandle): Promise<void> {
  if (!handle.exited) {
    const exited = new Promise<void>((resolve) => handle.child.once('exit', () => resolve()));
    handle.child.kill('SIGTERM'); // graceful on Linux, immediate on Windows
    const outcome = await Promise.race([
      exited.then(() => 'exit'),
      delay(8_000).then(() => 'late'),
    ]);
    if (outcome === 'late') {
      handle.child.kill('SIGKILL');
      await exited;
    }
  }
  await new Promise<void>((resolve) => handle.log.end(() => resolve()));
}
