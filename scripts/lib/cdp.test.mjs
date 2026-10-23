import assert from 'node:assert/strict';
import { test } from 'node:test';

import { connectCdp } from './cdp.mjs';

class FakeWebSocket {
  static last;
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.handlers = {};
    FakeWebSocket.last = this;
    Promise.resolve().then(() => this.emit('open', {}));
  }
  addEventListener(type, handler) {
    (this.handlers[type] ??= []).push(handler);
  }
  emit(type, event) {
    for (const handler of this.handlers[type] ?? []) handler(event);
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  reply(message) {
    this.emit('message', { data: JSON.stringify(message) });
  }
  close() {
    this.emit('close', {});
  }
}

test('send mengorelasikan jawaban dengan id', async () => {
  const cdp = await connectCdp('ws://x', { WebSocketImpl: FakeWebSocket });
  const ws = FakeWebSocket.last;
  const first = cdp.send('A.one', { a: 1 });
  const second = cdp.send('B.two');
  assert.deepEqual(ws.sent[0], { id: 1, method: 'A.one', params: { a: 1 } });
  ws.reply({ id: 2, result: { v: 2 } });
  ws.reply({ id: 1, result: { v: 1 } });
  assert.deepEqual(await first, { v: 1 });
  assert.deepEqual(await second, { v: 2 });
});

test('error CDP menolak promise dengan nama metode', async () => {
  const cdp = await connectCdp('ws://x', { WebSocketImpl: FakeWebSocket });
  const pending = cdp.send('Page.bad');
  FakeWebSocket.last.reply({ id: 1, error: { message: 'nope' } });
  await assert.rejects(pending, /Page\.bad: nope/);
});

test('event dikirim ke pendengar dan dapat dihentikan', async () => {
  const cdp = await connectCdp('ws://x', { WebSocketImpl: FakeWebSocket });
  const got = [];
  const off = cdp.on('E.ev', (p) => got.push(p));
  FakeWebSocket.last.reply({ method: 'E.ev', params: { n: 1 } });
  off();
  FakeWebSocket.last.reply({ method: 'E.ev', params: { n: 2 } });
  assert.deepEqual(got, [{ n: 1 }]);
});

test('timeout dan penutupan koneksi menolak permintaan tertunda', async () => {
  const cdp = await connectCdp('ws://x', { WebSocketImpl: FakeWebSocket, timeoutMs: 20 });
  await assert.rejects(cdp.send('Slow.call'), /tidak ada jawaban/);
  const pending = cdp.send('Other.call');
  FakeWebSocket.last.close();
  await assert.rejects(pending, /tertutup/);
  await assert.rejects(cdp.send('After.close'), /tertutup/);
});

test('tanpa WebSocket: pesan menyebut Node 22', async () => {
  await assert.rejects(connectCdp('ws://x', { WebSocketImpl: null }), /Node 22/);
});
