// Pembaruan folder `latest` yang selalu lengkap: run penuh (tanpa kegagalan) menggantikan seluruhnya;
// run parsial atau ada yang gagal menggabungkan per nama berkas. Manifest memuat asal tiap berkas.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const MANIFEST = 'manifest.json';

function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8'));
  } catch {
    return {};
  }
}

/** Isi index.md untuk `latest` dari manifest (diurut menurut nama berkas). Murni. */
export function renderLatestIndex(manifest) {
  const rows = Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b));
  return `${[
    '# Tangkapan layar Antre (terbaru, gabungan)',
    '',
    `Berisi ${rows.length} berkas; tiap berkas berasal dari run terakhir yang menghasilkannya.`,
    '',
    '| Berkas | Layar | Viewport | Ukuran PNG | Mode | Dibuat | Run asal |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      ([file, m]) =>
        `| ${file} | ${m.title ?? '-'} | ${m.viewport ?? '-'} | ${m.size ?? '-'} | ${m.mode ?? '-'} | ${m.createdAt ?? '-'} | ${m.run ?? '(tidak diketahui)'} |`,
    ),
  ].join('\n')}\n`;
}

/**
 * entries = hasil run [{ file, ok, title, viewport, size, mode }]. Hanya yang ok yang disalin.
 * full = run tanpa --only dan tanpa ukuran khusus.
 */
export function updateLatest({ outDir, latestDir, entries, full, runName, createdAt }) {
  const good = entries.filter((entry) => entry.ok);
  const replace = full && good.length === entries.length;
  let manifest = {};
  if (replace) {
    rmSync(latestDir, { recursive: true, force: true });
  } else {
    manifest = readManifest(latestDir);
    // Berkas lama tanpa catatan asal tetap dipertahankan dan didaftarkan.
    if (existsSync(latestDir)) {
      for (const name of readdirSync(latestDir)) {
        if (name.endsWith('.png') && !manifest[name]) {
          manifest[name] = { createdAt: statSync(path.join(latestDir, name)).mtime.toISOString() };
        }
      }
    }
  }
  mkdirSync(latestDir, { recursive: true });
  for (const entry of good) {
    cpSync(path.join(outDir, entry.file), path.join(latestDir, entry.file));
    manifest[entry.file] = {
      title: entry.title,
      viewport: entry.viewport,
      size: entry.size,
      mode: entry.mode,
      createdAt,
      run: runName,
    };
  }
  for (const name of Object.keys(manifest)) {
    if (!existsSync(path.join(latestDir, name))) delete manifest[name];
  }
  writeFileSync(path.join(latestDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(latestDir, 'index.md'), renderLatestIndex(manifest));
  return { mode: replace ? 'replace' : 'merge', files: Object.keys(manifest).sort() };
}
