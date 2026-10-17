// RabbitMQ test isolation: every integration run uses its own virtual hosts, created and deleted
// through the management HTTP API (RABBITMQ_MANAGEMENT_URL, credentials from RABBITMQ_URL), so
// the dev vhost "/" and its queues are never touched.
export const TEST_VHOST = 'antre_it_notif';
/** Created only by the "broker comes back" test, to start with a refused connection. */
export const LATE_VHOST = 'antre_it_notif_late';

function readLocalUrl(name: string): URL {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set; run the tests with "pnpm notif:test:integration".`);
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
