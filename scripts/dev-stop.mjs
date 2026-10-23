// pnpm dev:stop: mematikan proses sisa dari dev:all (berdasarkan .run/state.json).
// Opsi: --down  juga menjalankan "docker compose down" (data volume tetap ada).
//       --yes   izinkan --down pada project bawaan "antre-dev" saat tidak ada state dev:all.
import { spawnSync } from 'node:child_process';

import { ROOT } from './lib/env.mjs';
import { isAlive, killTree, processStartTime, sameProcess } from './lib/proc.mjs';
import { clearState, readState } from './lib/state.mjs';
import { downCommand, planDown } from './lib/stop.mjs';

const down = process.argv.includes('--down');
const yes = process.argv.includes('--yes');
const state = readState();

if (down) {
  const plan = planDown({ state, processEnv: process.env, yes });
  if (!plan.ok) {
    console.error(`[dev:stop] ${plan.error}`);
    process.exit(1);
  }
}

/** Mematikan hanya bila PID masih proses yang dicatat dev:all (bukan PID yang dipakai ulang). */
function stopRecorded(label, pid, options) {
  if (!isAlive(pid)) return false;
  const start = processStartTime(pid);
  if (!sameProcess(start, state.writtenAt ?? 0)) {
    console.log(
      `[dev:stop] ${label} (PID ${pid}) dilewati: ${start === null ? 'waktu start tidak dapat dibaca' : 'PID sudah dipakai proses lain'}.`,
    );
    return false;
  }
  killTree(pid, options);
  console.log(`[dev:stop] ${label} (PID ${pid}) dihentikan.`);
  return true;
}

if (state === null) {
  console.log('[dev:stop] Tidak ada dev:all yang tercatat (.run/state.json tidak ada).');
} else {
  // Supervisor dulu: ia mematikan anak-anaknya sendiri (di Windows taskkill /T ikut menamatkan anak).
  const supervisor = state.supervisorPid;
  if (supervisor && supervisor !== process.pid && stopRecorded('supervisor dev:all', supervisor)) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && isAlive(supervisor)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  for (const [name, pid] of Object.entries(state.pids ?? {})) stopRecorded(name, pid);
  clearState();
}

if (down) {
  const { composeArgs } = planDown({ state, processEnv: process.env, yes });
  const command = downCommand(composeArgs);
  console.log(`[dev:stop] ${command.join(' ')} ...`);
  const result = spawnSync(command[0], command.slice(1), {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) {
    console.error('[dev:stop] docker compose down gagal (Docker menyala?).');
    process.exit(1);
  }
} else {
  console.log(
    '[dev:stop] Kontainer Docker dibiarkan menyala (tambahkan --down untuk mematikannya).',
  );
}
