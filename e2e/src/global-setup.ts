// Brings the whole stack up once for all journeys and tears it down again:
//  1. a fresh database (roles + migrations), a fresh RabbitMQ vhost, and an emptied Redis database,
//     all with E2E names, so a running dev stack is never touched;
//  2. the four built services (dist) as child processes on random ports with random secrets:
//     core-services, notification-worker (sandbox WhatsApp adapter, its log file is the customer's
//     phone), wa-channel, and realtime-gateway;
//  3. a control endpoint the tests use to cut and restore the broker (a TCP proxy that sits
//     between the services and RabbitMQ), which is how the resilience journey stays safe on shared
//     infrastructure.
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bootstrapRoles,
  databaseUrls,
  dropDatabase,
  migrate,
  recreateDatabase,
} from '@antre/db/testing';
import type { TestProject } from 'vitest/node';

import {
  E2E_DATABASE,
  E2E_VHOST,
  TcpProxy,
  createVhost,
  deleteVhost,
  e2eRedisUrl,
  flushE2eRedis,
  freePort,
  readLocalUrl,
} from './infra.js';
import { startService, stopService, waitReady, type ServiceHandle } from './processes.js';
import type { StackContext } from './stack.js';

declare module 'vitest' {
  export interface ProvidedContext {
    stack: StackContext;
  }
}

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const appDir = (name: string) => path.join(REPO_ROOT, 'apps', name);
const secret = () => randomBytes(24).toString('hex');

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const logDir = mkdtempSync(path.join(tmpdir(), 'antre-e2e-'));
  mkdirSync(logDir, { recursive: true });
  const services: ServiceHandle[] = [];
  const proxy = new TcpProxy(
    readLocalUrl('RABBITMQ_URL').hostname,
    Number(readLocalUrl('RABBITMQ_URL').port || 5672),
  );
  let control: http.Server | null = null;

  const teardown = async (): Promise<void> => {
    await Promise.allSettled(services.map((service) => stopService(service)));
    if (control !== null) {
      const server = control;
      control = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await proxy.stop();
    await Promise.allSettled([dropDatabase(E2E_DATABASE), deleteVhost(E2E_VHOST), flushE2eRedis()]);
    if (process.env.E2E_KEEP_LOGS === '1') {
      console.log(`E2E service logs kept in ${logDir}`);
    } else {
      rmSync(logDir, { recursive: true, force: true });
    }
  };

  try {
    // 1. Fresh state.
    await recreateDatabase(E2E_DATABASE);
    const urls = databaseUrls(E2E_DATABASE);
    await bootstrapRoles(urls);
    await migrate(urls, 'up');
    await deleteVhost(E2E_VHOST);
    await createVhost(E2E_VHOST);
    await flushE2eRedis();

    // The services reach the broker through the proxy, on a vhost of their own.
    await proxy.start();
    const amqp = readLocalUrl('RABBITMQ_URL');
    amqp.hostname = '127.0.0.1';
    amqp.port = String(proxy.port);
    amqp.pathname = `/${encodeURIComponent(E2E_VHOST)}`;
    const amqpUrl = amqp.toString();

    // 2. Secrets and ports.
    const secrets = {
      jwt: secret(),
      serviceToken: secret(),
      paymentCallback: secret(),
      waAppSecret: secret(),
      waVerifyToken: secret(),
    };
    const [corePort, workerPort, waPort, rtPort] = await Promise.all([
      freePort(),
      freePort(),
      freePort(),
      freePort(),
    ]);
    const common = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      REDIS_URL: e2eRedisUrl(),
      RABBITMQ_URL: amqpUrl,
    };
    const coreUrl = `http://127.0.0.1:${corePort}`;
    const logFile = (name: string) => path.join(logDir, `${name}.log`);

    // 3. The services, in dependency order: core first (the others call it or its database).
    const start = async (
      name: string,
      dir: string,
      port: number,
      env: Record<string, string>,
    ): Promise<void> => {
      const handle = startService(name, appDir(dir), { ...common, ...env }, logFile(name));
      services.push(handle);
      await waitReady(handle, `http://127.0.0.1:${port}/readyz`);
    };

    await start('core-services', 'core-services', corePort, {
      DATABASE_APP_URL: urls.app,
      DATABASE_PLATFORM_ADMIN_URL: urls.platformAdmin,
      JWT_SECRET: secrets.jwt,
      WA_CHANNEL_SERVICE_TOKEN: secrets.serviceToken,
      PAYMENT_CALLBACK_SECRET: secrets.paymentCallback,
      CORE_SERVICES_HOST: '127.0.0.1',
      CORE_SERVICES_PORT: String(corePort),
    });
    await Promise.all([
      start('notification-worker', 'notification-worker', workerPort, {
        DATABASE_APP_URL: urls.app,
        WA_ADAPTER: 'sandbox',
        NOTIFICATION_WORKER_HOST: '127.0.0.1',
        NOTIFICATION_WORKER_PORT: String(workerPort),
        NOTIFICATION_RETRY_DELAYS_MS: '300,600,1200',
      }),
      start('wa-channel', 'wa-channel', waPort, {
        WA_VERIFY_TOKEN: secrets.waVerifyToken,
        WA_APP_SECRET: secrets.waAppSecret,
        WA_CHANNEL_SERVICE_TOKEN: secrets.serviceToken,
        CORE_SERVICES_URL: coreUrl,
        WA_CHANNEL_HOST: '127.0.0.1',
        WA_CHANNEL_PORT: String(waPort),
        WA_RATE_LIMIT_PER_MINUTE: '500',
        WA_INBOUND_RETRY_DELAYS_MS: '300,600,1200',
      }),
      start('realtime-gateway', 'realtime-gateway', rtPort, {
        JWT_SECRET: secrets.jwt,
        REALTIME_HOST: '127.0.0.1',
        REALTIME_PORT: String(rtPort),
        REALTIME_HEARTBEAT_MS: '5000',
      }),
    ]);

    // 4. Broker control for the resilience journey.
    const controlServer = http.createServer((request, response) => {
      const done = (status: number, body: object) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      const action =
        request.method === 'POST' && request.url === '/broker/cut'
          ? () => proxy.stop()
          : request.method === 'POST' && request.url === '/broker/restore'
            ? () => proxy.start()
            : null;
      if (action === null) return done(404, { error: 'not found' });
      action().then(
        () => done(200, { broker_up: proxy.running }),
        (error: unknown) => done(500, { error: String(error) }),
      );
    });
    await new Promise<void>((resolve) => controlServer.listen(0, '127.0.0.1', resolve));
    control = controlServer;

    project.provide('stack', {
      coreUrl,
      waUrl: `http://127.0.0.1:${waPort}`,
      realtimeUrl: `http://127.0.0.1:${rtPort}`,
      workerUrl: `http://127.0.0.1:${workerPort}`,
      controlUrl: `http://127.0.0.1:${(controlServer.address() as AddressInfo).port}`,
      workerLog: logFile('notification-worker'),
      coreLog: logFile('core-services'),
      databaseUrls: urls,
      secrets,
    });
  } catch (error) {
    await teardown();
    throw error;
  }

  return teardown;
}
