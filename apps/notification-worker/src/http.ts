// Health and metrics endpoints of the worker (k3s probes, Prometheus scrape):
//   GET /healthz  liveness, always 200 while the process runs
//   GET /readyz   200 when consuming notifications.wa, else 503
//   GET /metrics  Prometheus text format
import { createServer, type Server } from 'node:http';

import type { Metrics } from './metrics.js';

export interface HealthSource {
  readonly ready: boolean;
}

export function createHealthServer(worker: HealthSource, metrics: Metrics): Server {
  return createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    if (request.method !== 'GET') {
      response
        .writeHead(405, { 'content-type': 'application/json' })
        .end('{"status":"method not allowed"}');
      return;
    }
    if (path === '/healthz') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({ status: 'ok', service: 'notification-worker', consuming: worker.ready }),
        );
      return;
    }
    if (path === '/readyz') {
      response
        .writeHead(worker.ready ? 200 : 503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ status: worker.ready ? 'ready' : 'not ready' }));
      return;
    }
    if (path === '/metrics') {
      response
        .writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
        .end(metrics.render());
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' }).end('{"status":"not found"}');
  });
}
