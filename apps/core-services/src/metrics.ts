// In-process metrics in the Prometheus text format on GET /metrics (spec section 9.2; no client
// library, same approach as the other services). Route labels are route PATTERNS (for example
// /api/v1/queues/tickets/:id), never raw URLs, and there is no tenant or user label, so the
// cardinality stays bounded. The gateway never routes /metrics (infra/traefik/dynamic/antre.yml).
type Labels = Record<string, string>;

/** Upper bounds in seconds; spans the 200 ms target of NFR-PERF-01. */
export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2.5, 5] as const;

interface PoolLike {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

interface Series {
  labels: Labels;
  buckets: number[];
  sum: number;
  count: number;
}

function key(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`)
    .join(',');
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function render(labels: Labels): string {
  const body = Object.entries(labels)
    .map(([name, value]) => `${name}="${escapeLabel(value)}"`)
    .join(',');
  return body === '' ? '' : `{${body}}`;
}

/** Upper bound on distinct label sets; beyond it new sets are folded into route="other". */
const MAX_SERIES = 500;

export class CoreMetrics {
  private readonly requests = new Map<string, { labels: Labels; value: number }>();
  private readonly durations = new Map<string, Series>();
  private readonly events = new Map<string, number>();
  private readonly pools = new Map<string, PoolLike>();

  /** Registers a pool whose size gauges are exported under the given name label. */
  addPool(name: string, pool: PoolLike): void {
    this.pools.set(name, pool);
  }

  observeRequest(method: string, route: string, status: number, seconds: number): void {
    const statusClass = `${Math.floor(status / 100)}xx`;
    let labels: Labels = { method, route, status: String(status) };
    let id = key(labels);
    if (!this.requests.has(id) && this.requests.size >= MAX_SERIES) {
      labels = { method, route: 'other', status: String(status) };
      id = key(labels);
    }
    const entry = this.requests.get(id) ?? { labels, value: 0 };
    entry.value += 1;
    this.requests.set(id, entry);

    const durationLabels: Labels = {
      method,
      route: labels.route ?? route,
      status_class: statusClass,
    };
    const durationId = key(durationLabels);
    const series = this.durations.get(durationId) ?? {
      labels: durationLabels,
      buckets: DURATION_BUCKETS.map(() => 0),
      sum: 0,
      count: 0,
    };
    DURATION_BUCKETS.forEach((bound, index) => {
      if (seconds <= bound) series.buckets[index] = (series.buckets[index] ?? 0) + 1;
    });
    series.sum += seconds;
    series.count += 1;
    this.durations.set(durationId, series);
  }

  /** Counts a published domain event by its type (a closed set from event-contracts). */
  observeEvent(eventType: string): void {
    this.events.set(eventType, (this.events.get(eventType) ?? 0) + 1);
  }

  /** Sum of all requests (tests). */
  totalRequests(): number {
    let sum = 0;
    for (const entry of this.requests.values()) sum += entry.value;
    return sum;
  }

  render(): string {
    const lines: string[] = [
      '# HELP antre_http_requests_total HTTP requests by method, route pattern, and status.',
      '# TYPE antre_http_requests_total counter',
    ];
    for (const { labels, value } of this.requests.values()) {
      lines.push(`antre_http_requests_total${render(labels)} ${value}`);
    }
    lines.push(
      '# HELP antre_http_request_duration_seconds HTTP request duration by method, route pattern, and status class.',
      '# TYPE antre_http_request_duration_seconds histogram',
    );
    for (const series of this.durations.values()) {
      DURATION_BUCKETS.forEach((bound, index) => {
        lines.push(
          `antre_http_request_duration_seconds_bucket${render({ ...series.labels, le: String(bound) })} ${series.buckets[index] ?? 0}`,
        );
      });
      lines.push(
        `antre_http_request_duration_seconds_bucket${render({ ...series.labels, le: '+Inf' })} ${series.count}`,
        `antre_http_request_duration_seconds_sum${render(series.labels)} ${series.sum}`,
        `antre_http_request_duration_seconds_count${render(series.labels)} ${series.count}`,
      );
    }
    lines.push(
      '# HELP antre_events_published_total Domain events handed to the publisher, by event type.',
      '# TYPE antre_events_published_total counter',
    );
    for (const [eventType, value] of this.events) {
      lines.push(`antre_events_published_total{event_type="${escapeLabel(eventType)}"} ${value}`);
    }
    lines.push(
      '# HELP antre_db_pool_connections PostgreSQL pool connections by state.',
      '# TYPE antre_db_pool_connections gauge',
    );
    for (const [name, pool] of this.pools) {
      const base = escapeLabel(name);
      lines.push(
        `antre_db_pool_connections{pool="${base}",state="total"} ${pool.totalCount}`,
        `antre_db_pool_connections{pool="${base}",state="idle"} ${pool.idleCount}`,
        `antre_db_pool_connections{pool="${base}",state="waiting"} ${pool.waitingCount}`,
      );
    }
    return `${lines.join('\n')}\n`;
  }
}
