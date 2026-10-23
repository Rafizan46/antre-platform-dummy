// Daftar layar yang dipotret. Tiap langkah: key (nama berkas), profil, sesi yang dibutuhkan
// (null = anonim, 'owner', 'empty'), tingkat data antrean ('waiting' | 'called' | 'serving'),
// mode (full | viewport), dan fungsi run(ctx) yang menyiapkan UI sampai siap dipotret.

const ALL = ['desktop', 'tablet', 'phone', 'tv'];
const MAIN = ['desktop', 'tablet', 'phone'];
const DESKTOP = ['desktop'];

const DASH_READY = "document.querySelector('.metrics') && document.querySelector('h2')";
const TICKETS_READY = "document.querySelectorAll('.ticket-list li').length > 0";

async function settingsTab(ctx, tab, label, ready) {
  await ctx.page.goto(`${ctx.web}/#/pengaturan/${tab}`);
  await ctx.page.waitFor(
    `document.querySelector('.tabs a[aria-current=page]')?.textContent.trim() === ${JSON.stringify(label)}`,
    { label: `tab ${label}` },
  );
  if (ready) await ctx.page.waitFor(ready, { label: `isi tab ${label}` });
}

async function dashboard(ctx, { tickets }) {
  // Muat ulang dokumen agar sisa state (mis. dropdown terbuka) dari layar sebelumnya hilang.
  await ctx.page.goto('about:blank');
  await ctx.page.goto(`${ctx.web}/#/`);
  await ctx.page.waitFor(DASH_READY, { label: 'dashboard' });
  if (tickets) {
    await ctx.page.waitFor(TICKETS_READY, { label: 'daftar tiket' });
    // Indikator live (SSE); lanjut tanpa gagal bila belum tersambung.
    await ctx.page
      .waitFor("document.querySelector('.conn-open')", { timeout: 8_000, label: 'live' })
      .catch(() => ctx.warn('indikator live (SSE) belum tersambung saat dipotret'));
  } else {
    await ctx.page.waitFor("document.querySelector('.empty')", { label: 'dashboard kosong' });
  }
}

export const STEPS = [
  {
    key: 'login',
    title: 'Halaman login',
    profiles: MAIN,
    session: null,
    mode: 'full',
    async run(ctx) {
      await ctx.page.goto(`${ctx.web}/#/login`);
      await ctx.page.waitFor("document.querySelector('h1')?.textContent.includes('Masuk')", {
        label: 'halaman login',
      });
    },
  },
  {
    key: 'login-galat',
    title: 'Login gagal (kata sandi salah, pesan galat)',
    profiles: DESKTOP,
    session: null,
    mode: 'full',
    async run(ctx) {
      await ctx.page.goto(`${ctx.web}/#/login`);
      await ctx.page.waitFor("document.querySelector('h1')?.textContent.includes('Masuk')");
      await ctx.page.fill('Email', ctx.world.demo.owner.email);
      await ctx.page.fill('Kata sandi', 'Salah-Sandi-000');
      await ctx.page.click('Masuk');
      await ctx.page.waitFor("document.querySelector('[role=alert]')", { label: 'pesan galat' });
    },
  },
  {
    key: 'daftar',
    title: 'Registrasi bisnis',
    profiles: DESKTOP,
    session: null,
    mode: 'full',
    async run(ctx) {
      await ctx.page.goto(`${ctx.web}/#/daftar`);
      await ctx.page.waitFor("document.querySelector('h1')?.textContent.includes('Daftarkan')");
    },
  },
  {
    key: 'daftar-dropdown',
    title: 'Registrasi dengan dropdown Jenis bisnis terbuka',
    profiles: DESKTOP,
    session: null,
    mode: 'viewport',
    async run(ctx) {
      await ctx.page.goto(`${ctx.web}/#/daftar`);
      await ctx.page.waitFor("document.querySelector('h1')?.textContent.includes('Daftarkan')");
      await ctx.page.openSelect('Jenis bisnis');
      await ctx.page.waitFor("document.querySelector('.custom-select-menu')", {
        label: 'menu dropdown',
      });
    },
  },
  {
    key: 'dashboard-kosong',
    title: 'Dashboard tanpa tiket (tenant Klinik Kosong)',
    profiles: DESKTOP,
    session: 'empty',
    mode: 'full',
    async run(ctx) {
      await dashboard(ctx, { tickets: false });
    },
  },
  {
    key: 'dashboard-tiket',
    title: 'Dashboard dengan tiket menunggu',
    profiles: DESKTOP,
    session: 'owner',
    level: 'waiting',
    mode: 'full',
    async run(ctx) {
      await dashboard(ctx, { tickets: true });
    },
  },
  {
    key: 'dashboard-dipanggil',
    title: 'Dashboard dengan tiket berstatus Dipanggil',
    profiles: DESKTOP,
    session: 'owner',
    level: 'called',
    mode: 'full',
    async run(ctx) {
      await dashboard(ctx, { tickets: true });
      await ctx.page.waitFor("document.querySelector('.badge-called')", {
        label: 'status Dipanggil',
      });
    },
  },
  {
    key: 'dashboard-dilayani',
    title: 'Dashboard dengan tiket Dipanggil dan Dilayani',
    profiles: MAIN,
    session: 'owner',
    level: 'serving',
    mode: 'full',
    async run(ctx) {
      await dashboard(ctx, { tickets: true });
      await ctx.page.waitFor("document.querySelector('.badge-serving')", {
        label: 'status Dilayani',
      });
    },
  },
  {
    key: 'reservasi',
    title: 'Daftar reservasi hari ini',
    profiles: DESKTOP,
    session: 'owner',
    level: 'serving',
    mode: 'viewport',
    async run(ctx) {
      await dashboard(ctx, { tickets: true });
      await ctx.page.waitFor(
        "[...document.querySelectorAll('h2')].some((h) => h.textContent.includes('Reservasi'))",
        { label: 'judul reservasi' },
      );
      await ctx.page.eval(
        "[...document.querySelectorAll('h2')].find((h) => h.textContent.includes('Reservasi')).scrollIntoView(); true",
      );
    },
  },
  {
    key: 'dashboard-dropdown',
    title: 'Dashboard dengan dropdown loket terbuka',
    profiles: DESKTOP,
    session: 'owner',
    level: 'serving',
    mode: 'viewport',
    async run(ctx) {
      await dashboard(ctx, { tickets: true });
      await ctx.page.eval('window.scrollTo(0, 0); true');
      await ctx.page.openSelect('Loket');
      await ctx.page.waitFor("document.querySelector('.custom-select-menu')", {
        label: 'menu loket',
      });
    },
  },
  {
    key: 'dashboard-validasi',
    title: 'Validasi form tiket manual (nama kosong)',
    profiles: DESKTOP,
    session: 'owner',
    level: 'serving',
    mode: 'viewport',
    async run(ctx) {
      await dashboard(ctx, { tickets: true });
      await ctx.page.click('Buat tiket');
      await ctx.page.waitFor(
        "document.querySelector('.field-error, [aria-invalid=true], [role=alert]')",
        { label: 'pesan validasi' },
      );
      await ctx.page.eval(
        "(document.querySelector('[aria-invalid=true]') || document.querySelector('h3')).scrollIntoView({block:'center'}); true",
      );
    },
  },
  ...[
    ['layanan', 'Layanan', "document.querySelector('.card, table, ul')", MAIN],
    ['resource', 'Resource', "document.querySelector('.card, table, ul')", DESKTOP],
    ['jam', 'Jam operasional', "document.querySelector('input[type=time], table, .card')", DESKTOP],
    ['mode', 'Mode & branding', "document.querySelector('form, .card')", DESKTOP],
    ['staf', 'Staf', "document.querySelector('.card, table, ul')", DESKTOP],
    ['kiosk', 'Kiosk TV', "document.querySelector('button')", DESKTOP],
    ['langganan', 'Langganan', "document.querySelector('.card, dl, p')", DESKTOP],
  ].map(([tab, label, ready, profiles]) => ({
    key: `pengaturan-${tab}`,
    title: `Pengaturan: ${label}`,
    profiles,
    session: 'owner',
    mode: 'full',
    async run(ctx) {
      await settingsTab(ctx, tab, label, ready);
      await ctx.page.waitIdle();
    },
  })),
  {
    key: 'kiosk',
    title: 'Kiosk TV dengan panggilan terbaru',
    profiles: ALL,
    session: 'kiosk',
    level: 'serving',
    mode: 'viewport',
    async run(ctx) {
      await ctx.page.goto(
        `${ctx.web}/kiosk.html?token=${encodeURIComponent(ctx.world.kioskToken)}`,
      );
      await ctx.page.waitFor("document.querySelector('.kiosk-number')", {
        label: 'nomor di kiosk',
        timeout: 30_000,
      });
      await ctx.page.waitFor("document.querySelector('.kiosk-status-open')", {
        label: 'kiosk terhubung',
        timeout: 10_000,
      });
    },
  },
  {
    key: 'kiosk-nomor-panjang',
    title: 'Kiosk dengan nomor tiket panjang (AB-1000, hanya teks DOM diubah)',
    profiles: ['desktop', 'phone', 'tv'],
    session: 'kiosk',
    level: 'serving',
    mode: 'viewport',
    async run(ctx) {
      await STEPS.find((step) => step.key === 'kiosk').run(ctx);
      await ctx.page.eval(
        "document.querySelectorAll('.kiosk-number').forEach((e) => { e.textContent = 'AB-1000'; e.style.setProperty('--chars', '7'); }); true",
      );
    },
  },
];

export const STEP_KEYS = STEPS.map((step) => step.key);

/** Langkah terpilih beserta nomor urut tetap (nomor berasal dari posisi di daftar penuh). */
export function selectSteps(only = null, profileName = null, sizeMode = false) {
  return STEPS.map((step, index) => ({ step, number: index + 1 })).filter(
    ({ step }) =>
      (only === null || only.includes(step.key)) &&
      (sizeMode || profileName === null || step.profiles.includes(profileName)),
  );
}
