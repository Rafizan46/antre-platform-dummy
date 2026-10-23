// pnpm screenshots: tangkapan layar PNG seluruh UI Antre lewat Chrome/Edge headless (CDP).
// Lihat `pnpm screenshots --help`. Hasil: .run/screenshots/<timestamp>/ (+ index.md) dan .../latest/.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { findBrowser, launchBrowser } from './lib/browser.mjs';
import { connectCdp } from './lib/cdp.mjs';
import { loadEnv, ROOT } from './lib/env.mjs';
import {
  HELP,
  PROFILES,
  PROFILE_ORDER,
  parseScreenshotArgs,
  shotName,
  timestamp,
} from './lib/screenshot-args.mjs';
import { updateLatest } from './lib/screenshot-latest.mjs';
import { createPage } from './lib/screenshot-page.mjs';
import { STEPS, STEP_KEYS, selectSteps } from './lib/screenshot-steps.mjs';
import { startStack } from './lib/screenshot-stack.mjs';
import { prepareWorld } from './lib/screenshot-world.mjs';
import { readState } from './lib/state.mjs';

const MIN_BYTES = 4_000;
const log = (message) => console.log(`[screenshots] ${message}`);

function fail(message) {
  console.error(`\n[screenshots] GAGAL: ${message}\n`);
  process.exit(1);
}

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  fail(
    `Node ${process.versions.node} terlalu lama; butuh ^22.13.0 (WebSocket bawaan). Lihat engines di package.json.`,
  );
}

let args;
try {
  args = parseScreenshotArgs(process.argv.slice(2), STEP_KEYS);
} catch (error) {
  fail(error.message);
}
if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (args.list) {
  for (const [index, step] of STEPS.entries()) {
    console.log(
      `${String(index + 1).padStart(2, '0')} ${step.key.padEnd(22)} ${step.profiles.join(',')}  ${step.title}`,
    );
  }
  process.exit(0);
}

let browser = null;
let cdp = null;
let stack = null;
let cleaning = false;

async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  try {
    cdp?.close();
  } catch {
    // abaikan
  }
  await browser?.close().catch(() => {});
  await stack?.stop().catch(() => {});
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(signal, () => {
    log('dihentikan; membersihkan ...');
    void cleanup().finally(() => process.exit(130));
  });
}

const results = [];
const warnings = [];
let page = null;

async function main() {
  const executable = findBrowser();
  log(`browser: ${executable.path} (${executable.source})`);

  let web = args.url;
  let apiBase = args.api;
  const env = loadEnv();
  let waBase = args.wa ?? readState()?.urls?.waChannel ?? `http://127.0.0.1:${env.WA_CHANNEL_PORT}`;
  let waSecret = process.env.WA_APP_SECRET ?? env.WA_APP_SECRET;

  if (args.start) {
    stack = await startStack({ basePort: args.basePort, noBuild: args.noBuild, log });
    web = stack.web;
    apiBase = stack.api;
    waBase = stack.wa;
    waSecret = stack.waSecret;
  } else {
    log(`memakai stack berjalan: web ${web}, api ${apiBase} (tidak ada yang dimatikan)`);
  }

  const world = await prepareWorld({ apiBase, waBase, waSecret, log });

  const profiles = args.size ? [args.size] : PROFILE_ORDER.map((name) => PROFILES[name]);
  const stamp = timestamp();
  const outDir = path.resolve(args.out ?? path.join(ROOT, '.run', 'screenshots', stamp));
  mkdirSync(outDir, { recursive: true });

  browser = await launchBrowser({
    executable: executable.path,
    width: profiles[0].width,
    height: profiles[0].height,
  });
  cdp = await connectCdp(browser.wsUrl);
  page = await createPage(cdp);

  let session = null; // null | 'owner' | 'empty'
  async function ensureSession(kind) {
    if (kind === 'kiosk') return;
    if (kind === session) return;
    await page.clearSession(web);
    session = null;
    if (kind === null) return;
    const user = kind === 'owner' ? world.demo.owner : world.empty.owner;
    await page.goto(`${web}/#/login`);
    await page.waitFor("document.querySelector('h1')?.textContent.includes('Masuk')");
    await page.fill('Email', user.email);
    await page.fill('Kata sandi', user.password);
    await page.click('Masuk');
    await page.waitFor("document.querySelector('.metrics')", { label: `login ${kind}` });
    session = kind;
  }

  for (const profile of profiles) {
    const steps = selectSteps(args.only, profile.name, args.size !== null);
    if (steps.length === 0) continue;
    await page.setViewport(profile);
    session = 'unknown';
    for (const { step, number } of steps) {
      const file = shotName(number, step.key, profile.name);
      const started = Date.now();
      try {
        await ensureSession(step.session);
        if (step.level) await world.ensure(step.level);
        await step.run({ page, web, world, warn: (text) => warnings.push(`${file}: ${text}`) });
        const url = await page.eval('location.href');
        const shot = await page.screenshot(path.join(outDir, file), { full: step.mode === 'full' });
        const hasLogin =
          step.session !== null && step.key !== 'login'
            ? await page.eval(
                "!!document.querySelector('h1') && document.querySelector('h1').textContent.includes('Masuk ke Antre')",
              )
            : false;
        if (shot.bytes < MIN_BYTES)
          throw new Error(`PNG terlalu kecil (${shot.bytes} B), kemungkinan kosong`);
        if (hasLogin)
          throw new Error('layar login tertinggal pada halaman yang seharusnya terautentikasi');
        results.push({
          file,
          step,
          profile,
          url: url.replace(/token=[^&#]+/, 'token=***'),
          ...shot,
          ok: true,
          ms: Date.now() - started,
        });
        log(`ok   ${file} (${shot.width}x${shot.height}, ${(shot.bytes / 1024).toFixed(0)} KB)`);
      } catch (error) {
        results.push({
          file,
          step,
          profile,
          ok: false,
          error: error.message,
          ms: Date.now() - started,
        });
        log(`GAGAL ${file}: ${error.message.split('\n')[0]}`);
      }
    }
  }

  warnings.push(...world.warnings);
  const lines = [
    '# Tangkapan layar Antre',
    '',
    `- Waktu: ${new Date().toISOString()}`,
    `- Web: ${web}`,
    `- API: ${apiBase}`,
    `- Browser: ${executable.path}`,
    `- Mode: ${args.start ? 'stack terisolasi (--start)' : 'stack berjalan (--url/--api)'}`,
    '',
    '| Berkas | Layar | Viewport | Ukuran PNG | Mode | URL | Status |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...results.map((r) =>
      r.ok
        ? `| ${r.file} | ${r.step.title} | ${r.profile.width}x${r.profile.height} (${r.profile.name}) | ${r.width}x${r.height}, ${(r.bytes / 1024).toFixed(0)} KB | ${r.step.mode === 'full' ? 'halaman penuh' : 'viewport'} | ${r.url} | ok |`
        : `| ${r.file} | ${r.step.title} | ${r.profile.width}x${r.profile.height} (${r.profile.name}) | - | - | - | GAGAL: ${r.error.split('\n')[0].replace(/\|/g, '/')} |`,
    ),
  ];
  if (warnings.length > 0) lines.push('', '## Peringatan', '', ...warnings.map((w) => `- ${w}`));
  if (page.problems.length > 0) {
    lines.push(
      '',
      '## Galat konsol/jaringan browser',
      '',
      ...[...new Set(page.problems)].slice(0, 30).map((p) => `- ${p}`),
    );
  }
  writeFileSync(path.join(outDir, 'index.md'), `${lines.join('\n')}\n`);

  if (args.out === null) {
    const latest = path.join(ROOT, '.run', 'screenshots', 'latest');
    const update = updateLatest({
      outDir,
      latestDir: latest,
      full: args.only === null && args.size === null,
      runName: path.basename(outDir),
      createdAt: new Date().toISOString(),
      entries: results.map((r) => ({
        file: r.file,
        ok: r.ok,
        title: r.step.title,
        viewport: `${r.profile.width}x${r.profile.height} (${r.profile.name})`,
        size: r.ok ? `${r.width}x${r.height}, ${(r.bytes / 1024).toFixed(0)} KB` : undefined,
        mode: r.step.mode === 'full' ? 'halaman penuh' : 'viewport',
      })),
    });
    log(
      `latest ${update.mode === 'replace' ? 'diganti penuh' : 'digabung'}: ${update.files.length} berkas`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} tangkapan layar tersimpan di ${outDir}`,
  );
  console.log(`Indeks: ${path.join(outDir, 'index.md')}`);
  for (const w of warnings) console.log(`peringatan: ${w}`);
  return failed.length === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error(`\n[screenshots] GAGAL: ${error.message}\n`);
} finally {
  await cleanup();
}
process.exit(code);
