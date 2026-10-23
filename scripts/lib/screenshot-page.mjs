// Pembungkus halaman di atas klien CDP: navigasi, evaluasi, menunggu kondisi UI, screenshot.
import { writeFileSync } from 'node:fs';

// Pembantu dalam halaman (disuntik di setiap dokumen baru).
const HELPERS = `
window.__shots = {
  vis(e) { return !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length); },
  norm(s) { return String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase(); },
  control(label) {
    const want = this.norm(label);
    const lab = [...document.querySelectorAll('label')].find((l) => this.norm(l.textContent).includes(want));
    if (lab && (lab.control || lab.querySelector('input,select,textarea'))) {
      return lab.control || lab.querySelector('input,select,textarea');
    }
    return [...document.querySelectorAll('input,select,textarea')].find((x) =>
      this.norm(x.getAttribute('aria-label') || x.placeholder).includes(want)) || null;
  },
  setValue(label, value) {
    const el = this.control(label);
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
  button(text, scope) {
    const want = this.norm(text);
    const root = scope ? document.querySelector(scope) : document;
    if (!root) return null;
    const all = [...root.querySelectorAll('button,a,[role=tab]')].filter((b) => this.vis(b));
    const label = (b) => this.norm(b.getAttribute('aria-label') || b.textContent);
    return all.find((b) => label(b) === want) || all.find((b) => label(b).includes(want)) || null;
  },
  click(text, scope) {
    const b = this.button(text, scope);
    if (!b) return false;
    b.click();
    return true;
  },
  trigger(label) {
    const want = this.norm(label);
    const field = [...document.querySelectorAll('.field')].find((f) =>
      f.querySelector('.custom-select-trigger') && f.querySelector('label') &&
      this.norm(f.querySelector('label').textContent).includes(want));
    return field ? field.querySelector('.custom-select-trigger') : null;
  },
  openSelect(label) {
    const t = this.trigger(label);
    if (!t) return false;
    t.click();
    return true;
  },
  loading() {
    return /memuat|menghubungkan/i.test(document.body.innerText) &&
      !!document.querySelector('.loading-text, .loading-spinner');
  },
};`;

export async function createPage(cdp) {
  const inflight = new Map();
  const problems = [];
  const ignoredTypes = new Set(['EventSource', 'WebSocket', 'Ping']);

  cdp.on('Network.requestWillBeSent', (p) => {
    if (!ignoredTypes.has(p.type)) inflight.set(p.requestId, p.request?.url ?? '');
  });
  cdp.on('Network.loadingFinished', (p) => inflight.delete(p.requestId));
  cdp.on('Network.loadingFailed', (p) => inflight.delete(p.requestId));
  cdp.on('Runtime.exceptionThrown', (p) => {
    problems.push(
      `exception: ${(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').slice(0, 200)}`,
    );
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') {
      problems.push(
        `console.error: ${(p.args ?? [])
          .map((a) => a.value ?? a.description)
          .join(' ')
          .slice(0, 200)}`,
      );
    }
  });
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry?.level === 'error') {
      problems.push(`log: ${p.entry.text} ${(p.entry.url ?? '').slice(0, 120)}`);
    }
  });

  for (const domain of ['Page', 'Runtime', 'Network', 'Log']) await cdp.send(`${domain}.enable`);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const page = {
    problems,
    async setViewport({ width, height, mobile }) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: Boolean(mobile),
      });
    },
    async eval(expression) {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          `evaluasi gagal: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
        );
      }
      return result.result?.value;
    },
    /** Polling kondisi (ekspresi JS) sampai truthy; tanpa sleep buta. */
    async waitFor(expression, { timeout = 20_000, label = expression } = {}) {
      const deadline = Date.now() + timeout;
      let last;
      while (Date.now() < deadline) {
        try {
          last = await page.eval(`Boolean(${expression})`);
          if (last) return;
        } catch {
          // dokumen sedang berganti
        }
        await sleep(100);
      }
      const text = await page
        .eval('document.body ? document.body.innerText.slice(0, 300) : ""')
        .catch(() => '');
      throw new Error(`menunggu "${label}" melewati ${timeout} ms. Teks halaman: ${text}`);
    },
    /** Jaringan sepi (tanpa permintaan berjalan, kecuali SSE) selama quietMs. */
    async waitIdle({ quietMs = 400, timeout = 10_000 } = {}) {
      const deadline = Date.now() + timeout;
      let quietSince = Date.now();
      while (Date.now() < deadline) {
        if (inflight.size > 0) quietSince = Date.now();
        else if (Date.now() - quietSince >= quietMs) return;
        await sleep(50);
      }
    },
    async goto(url) {
      await cdp.send('Page.navigate', { url });
      await page.waitFor("document.readyState === 'complete'", { label: `memuat ${url}` });
    },
    async clearSession(origin) {
      await page.goto(`${origin}/robots-none.txt`).catch(() => {});
      await page.eval('sessionStorage.clear(); localStorage.clear(); true');
    },
    async fill(label, value) {
      const ok = await page.eval(
        `window.__shots.setValue(${JSON.stringify(label)}, ${JSON.stringify(value)})`,
      );
      if (!ok) throw new Error(`kolom "${label}" tidak ditemukan`);
    },
    async click(text, scope = null) {
      const ok = await page.eval(
        `window.__shots.click(${JSON.stringify(text)}, ${JSON.stringify(scope)})`,
      );
      if (!ok) throw new Error(`tombol "${text}" tidak ditemukan`);
    },
    async openSelect(label) {
      const ok = await page.eval(`window.__shots.openSelect(${JSON.stringify(label)})`);
      if (!ok) throw new Error(`dropdown "${label}" tidak ditemukan`);
    },
    /** Halaman siap: font, dua frame, tanpa indikator memuat, jaringan sepi. */
    async settle() {
      await page.waitIdle();
      await page.waitFor('!window.__shots.loading()', {
        label: 'indikator memuat hilang',
        timeout: 15_000,
      });
      await page.eval(
        'document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).then(() => true)',
      );
    },
    /** Simpan PNG. full = seluruh halaman (dibatasi 16000 px). Mengembalikan { bytes, width, height }. */
    async screenshot(file, { full = true } = {}) {
      await page.settle();
      let params = { format: 'png' };
      const metrics = await cdp.send('Page.getLayoutMetrics');
      const viewport = metrics.cssVisualViewport ?? metrics.visualViewport;
      let width = Math.ceil(viewport.clientWidth);
      let height = Math.ceil(viewport.clientHeight);
      if (full) {
        const content = metrics.cssContentSize ?? metrics.contentSize;
        width = Math.max(width, Math.ceil(content.width));
        height = Math.min(16_000, Math.max(height, Math.ceil(content.height)));
        params = {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height, scale: 1 },
        };
      }
      const { data } = await cdp.send('Page.captureScreenshot', params);
      const buffer = Buffer.from(data, 'base64');
      writeFileSync(file, buffer);
      return { bytes: buffer.length, width, height };
    },
  };
  return page;
}
