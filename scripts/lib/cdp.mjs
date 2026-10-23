// Klien Chrome DevTools Protocol minimal di atas WebSocket bawaan Node 22 (tanpa dependensi).
// WebSocketImpl dapat diganti (tes memakai WebSocket tiruan).

export async function connectCdp(
  url,
  { WebSocketImpl = globalThis.WebSocket, timeoutMs = 30_000 } = {},
) {
  if (typeof WebSocketImpl !== 'function') {
    throw new Error('WebSocket bawaan tidak tersedia. Pakai Node 22.13 atau lebih baru.');
  }
  const ws = new WebSocketImpl(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error(`gagal terhubung ke CDP ${url}`)), {
      once: true,
    });
  });

  let nextId = 0;
  let closed = false;
  const pending = new Map();
  const listeners = new Map();

  function failAll(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new Error(`CDP ${entry.method}: ${message.error.message ?? 'galat'}`));
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method) {
      for (const handler of [...(listeners.get(message.method) ?? [])])
        handler(message.params ?? {});
    }
  });
  ws.addEventListener('close', () => {
    closed = true;
    failAll(new Error('koneksi CDP tertutup'));
  });

  function send(method, params = {}) {
    if (closed) return Promise.reject(new Error('koneksi CDP tertutup'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method}: tidak ada jawaban dalam ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Berlangganan event; mengembalikan fungsi berhenti. */
  function on(method, handler) {
    const set = listeners.get(method) ?? new Set();
    set.add(handler);
    listeners.set(method, set);
    return () => set.delete(handler);
  }

  function close() {
    closed = true;
    failAll(new Error('koneksi CDP ditutup'));
    try {
      ws.close();
    } catch {
      // sudah tertutup
    }
  }

  return { send, on, close };
}
