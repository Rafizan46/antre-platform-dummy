// Keputusan dev:stop --down yang murni (dapat diuji): project compose mana yang boleh diturunkan.

/** Perintah docker yang ditampilkan/dijalankan untuk `down`. */
export function downCommand(composeArgs) {
  return ['docker', ...composeArgs, 'down'];
}

/**
 * Tanpa state dev:all dan tanpa COMPOSE_PROJECT_NAME eksplisit, project bawaan `antre-dev`
 * (milik pengguna) hanya diturunkan bila `--yes` diberikan.
 */
export function planDown({ state, processEnv, yes }) {
  if (state?.composeArgs) return { ok: true, composeArgs: state.composeArgs };
  const explicit = processEnv.COMPOSE_PROJECT_NAME;
  if (!explicit && !yes) {
    return {
      ok: false,
      error:
        'Tidak ada .run/state.json dan COMPOSE_PROJECT_NAME tidak diatur, jadi project bawaan "antre-dev" tidak diturunkan diam-diam. Tambahkan --yes bila memang ingin menurunkan "antre-dev", atau atur COMPOSE_PROJECT_NAME.',
    };
  }
  return {
    ok: true,
    composeArgs: ['compose', '-f', 'docker-compose.dev.yml', '-p', explicit || 'antre-dev'],
  };
}
