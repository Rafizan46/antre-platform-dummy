// Parser argumen, profil viewport, dan penamaan berkas untuk pnpm screenshots. Murni dan dapat diuji.
import { parseArgs } from 'node:util';

export const PROFILES = {
  desktop: { name: 'desktop', width: 1440, height: 900, mobile: false },
  tablet: { name: 'tablet', width: 768, height: 1024, mobile: true },
  phone: { name: 'phone', width: 390, height: 844, mobile: true },
  tv: { name: 'tv', width: 1920, height: 1080, mobile: false },
};
export const PROFILE_ORDER = ['desktop', 'tablet', 'phone', 'tv'];

/** Port yang tidak boleh disentuh mode --start (stack dev pengguna). */
export const PROTECTED_PORTS = [3000, 3100, 3200, 3300, 5173, 35432, 36379, 35672, 45672];

export const HELP = `Pakai: pnpm screenshots [opsi]

  --url <url>        Web staf yang sudah berjalan (bawaan http://127.0.0.1:5173)
  --api <url>        API core-services (bawaan http://127.0.0.1:3000)
  --wa <url>         WA Channel untuk webhook (bawaan dari .run/state.json atau http://127.0.0.1:3200)
  --start            Nyalakan stack terisolasi sendiri (port 570xx, project antre-shots), seed, lalu matikan
  --base-port <n>    Port dasar mode --start (bawaan 57000)
  --no-build         Mode --start: lewati build service
  --out <dir>        Folder keluaran (bawaan .run/screenshots/<timestamp>)
  --only a,b         Hanya layar tertentu (nama, mis. login,kiosk)
  --width <n> --height <n>   Satu ukuran saja untuk semua layar
  --list             Tampilkan nama layar lalu keluar
  -h, --help         Bantuan
Env: CHROME_PATH (browser), WA_APP_SECRET (tanda tangan webhook).`;

function parseUrl(label, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} bukan URL yang valid: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} harus http(s): ${value}`);
  }
  return url.origin;
}

function parsePositiveInt(label, value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0)
    throw new Error(`${label} harus bilangan bulat positif.`);
  return number;
}

/** knownSteps = nama layar valid untuk validasi --only. */
export function parseScreenshotArgs(argv, knownSteps = []) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        url: { type: 'string' },
        api: { type: 'string' },
        wa: { type: 'string' },
        start: { type: 'boolean', default: false },
        'base-port': { type: 'string' },
        'no-build': { type: 'boolean', default: false },
        out: { type: 'string' },
        only: { type: 'string' },
        width: { type: 'string' },
        height: { type: 'string' },
        list: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    throw new Error(`${error.message}\n\n${HELP}`, { cause: error });
  }
  const v = parsed.values;
  if (v.start && (v.url !== undefined || v.api !== undefined || v.wa !== undefined)) {
    throw new Error(
      '--start tidak boleh dikombinasikan dengan --url/--api/--wa (stack sendiri dipakai).',
    );
  }
  if ((v.width === undefined) !== (v.height === undefined)) {
    throw new Error('--width dan --height harus dipakai berpasangan.');
  }
  const only =
    v.only === undefined
      ? null
      : v.only
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
  if (only !== null) {
    if (only.length === 0) throw new Error('--only kosong.');
    const unknown = only.filter((name) => !knownSteps.includes(name));
    if (knownSteps.length > 0 && unknown.length > 0) {
      throw new Error(
        `Layar tidak dikenal: ${unknown.join(', ')}. Pilihan: ${knownSteps.join(', ')}`,
      );
    }
  }
  const basePort =
    v['base-port'] === undefined ? 57000 : parsePositiveInt('--base-port', v['base-port']);
  if (basePort + 13 > 65535) throw new Error('--base-port terlalu besar.');
  return {
    help: v.help,
    list: v.list,
    start: v.start,
    noBuild: v['no-build'],
    basePort,
    url: v.url === undefined ? 'http://127.0.0.1:5173' : parseUrl('--url', v.url),
    api: v.api === undefined ? 'http://127.0.0.1:3000' : parseUrl('--api', v.api),
    wa: v.wa === undefined ? null : parseUrl('--wa', v.wa),
    out: v.out ?? null,
    only,
    size:
      v.width === undefined
        ? null
        : {
            name: `${parsePositiveInt('--width', v.width)}x${parsePositiveInt('--height', v.height)}`,
            width: Number(v.width),
            height: Number(v.height),
            mobile: false,
          },
  };
}

/** Port mode --start dari port dasar. */
export function stackPorts(base) {
  return {
    core: base,
    worker: base + 1,
    wa: base + 2,
    realtime: base + 3,
    web: base + 4,
    postgres: base + 10,
    redis: base + 11,
    amqp: base + 12,
    management: base + 13,
  };
}

export function assertSafePorts(ports) {
  const clash = Object.values(ports).filter((port) => PROTECTED_PORTS.includes(port));
  if (clash.length > 0) {
    throw new Error(`Port ${clash.join(', ')} milik stack dev pengguna; pilih --base-port lain.`);
  }
}

/** 01-login-desktop.png (nomor = urutan layar, dua digit). */
export function shotName(index, key, profile) {
  return `${String(index).padStart(2, '0')}-${key}-${profile}.png`;
}

/** 20261023-141530 (waktu lokal). */
export function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}
