// Test isolation for the external services: a RabbitMQ vhost created and deleted through the
// management HTTP API (RABBITMQ_MANAGEMENT_URL, credentials from RABBITMQ_URL), and a dedicated
// Redis logical database. Only local hosts are accepted, because the helpers delete data.
import { createClient } from '@redis/client';

export const TEST_VHOST = 'antre_it_wa';
/** Redis logical database of these tests (the dev stack uses database 0). */
export const TEST_REDIS_DB = 13;

function readLocalUrl(name: string): URL {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set; run the tests with "pnpm wa:test:integration".`);
  }
  const url = new URL(value);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error(`${name} must point to 127.0.0.1 or localhost, got ${url.hostname}.`);
  }
  return url;
}

function management(): { base: string; user: string; authorization: string } {
  const amqp = readLocalUrl('RABBITMQ_URL');
  const api = readLocalUrl('RABBITMQ_MANAGEMENT_URL');
  const user = decodeURIComponent(amqp.username);
  const password = decodeURIComponent(amqp.password);
  return {
    base: `${api.protocol}//${api.host}/api`,
    user,
    authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
  };
}

async function call(method: string, path: string, body?: object): Promise<Response> {
  const { base, authorization } = management();
  return fetch(`${base}${path}`, {
    method,
    headers: { authorization, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** AMQP URL of RABBITMQ_URL pointed at `vhost`. */
export function vhostUrl(vhost: string): string {
  const url = readLocalUrl('RABBITMQ_URL');
  url.pathname = `/${encodeURIComponent(vhost)}`;
  return url.toString();
}

export async function createVhost(vhost: string): Promise<void> {
  const name = encodeURIComponent(vhost);
  const created = await call('PUT', `/vhosts/${name}`, {});
  if (!created.ok) throw new Error(`create vhost ${vhost}: HTTP ${created.status}`);
  const { user } = management();
  const permitted = await call('PUT', `/permissions/${name}/${encodeURIComponent(user)}`, {
    configure: '.*',
    write: '.*',
    read: '.*',
  });
  if (!permitted.ok) throw new Error(`grant vhost ${vhost}: HTTP ${permitted.status}`);
}

export async function deleteVhost(vhost: string): Promise<void> {
  const response = await call('DELETE', `/vhosts/${encodeURIComponent(vhost)}`);
  if (!response.ok && response.status !== 404) {
    throw new Error(`delete vhost ${vhost}: HTTP ${response.status}`);
  }
}

/** REDIS_URL pointed at the test database. */
export function testRedisUrl(): string {
  const url = readLocalUrl('REDIS_URL');
  url.pathname = `/${TEST_REDIS_DB}`;
  return url.toString();
}

/** Deletes the keys this suite writes (wa:*, lock:slot:*) from the test database. */
export async function clearRedisKeys(): Promise<void> {
  const client = createClient({ url: testRedisUrl() });
  client.on('error', () => undefined);
  await client.connect();
  try {
    for (const pattern of ['wa:*', 'lock:slot:*']) {
      for await (const keys of client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        if (keys.length > 0) await client.del(keys);
      }
    }
  } finally {
    await client.close();
  }
}
