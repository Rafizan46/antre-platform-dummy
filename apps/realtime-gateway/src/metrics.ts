// In-process counters and gauges in the Prometheus text format on GET /metrics (no client library,
// same approach as the other services). Labels have small fixed value sets; no tenant label.
type Labels = Record<string, string>;

export const METRIC_NAMES = {
  streamRequests: 'antre_rt_stream_requests_total',
  updatesReceived: 'antre_rt_updates_received_total',
  eventsSent: 'antre_rt_events_sent_total',
  clientsClosed: 'antre_rt_clients_closed_total',
  connections: 'antre_rt_connections',
  redisReady: 'antre_rt_redis_ready',
} as const;

const HELP: Record<string, string> = {
  [METRIC_NAMES.streamRequests]: 'SSE stream requests by result.',
  [METRIC_NAMES.updatesReceived]: 'Realtime messages received from Redis Pub/Sub, by kind.',
  [METRIC_NAMES.eventsSent]: 'SSE events written to clients, by event.',
  [METRIC_NAMES.clientsClosed]: 'SSE streams closed, by reason.',
  [METRIC_NAMES.connections]: 'Open SSE streams.',
  [METRIC_NAMES.redisReady]: '1 when both Redis connections are ready.',
};

const COUNTERS = [
  METRIC_NAMES.streamRequests,
  METRIC_NAMES.updatesReceived,
  METRIC_NAMES.eventsSent,
  METRIC_NAMES.clientsClosed,
];

function key(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`)
    .join(',');
}

export class Metrics {
  private readonly counters = new Map<string, Map<string, { labels: Labels; value: number }>>();
  private readonly gauges = new Map<string, () => number>();

  constructor() {
    for (const name of COUNTERS) this.counters.set(name, new Map());
  }

  increment(name: string, labels: Labels = {}, by = 1): void {
    let values = this.counters.get(name);
    if (!values) {
      values = new Map();
      this.counters.set(name, values);
    }
    const id = key(labels);
    const entry = values.get(id) ?? { labels, value: 0 };
    entry.value += by;
    values.set(id, entry);
  }

  gauge(name: string, read: () => number): void {
    this.gauges.set(name, read);
  }

  /** Sum over all label sets, or of one label set (tests). */
  total(name: string, labels?: Labels): number {
    const values = this.counters.get(name);
    if (!values) return 0;
    if (labels !== undefined) return values.get(key(labels))?.value ?? 0;
    let sum = 0;
    for (const entry of values.values()) sum += entry.value;
    return sum;
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, values] of this.counters) {
      lines.push(`# HELP ${name} ${HELP[name] ?? name}`, `# TYPE ${name} counter`);
      if (values.size === 0) lines.push(`${name} 0`);
      for (const { labels, value } of values.values()) {
        const rendered = Object.entries(labels)
          .map(([label, labelValue]) => `${label}="${labelValue}"`)
          .join(',');
        lines.push(rendered === '' ? `${name} ${value}` : `${name}{${rendered}} ${value}`);
      }
    }
    for (const [name, read] of this.gauges) {
      lines.push(
        `# HELP ${name} ${HELP[name] ?? name}`,
        `# TYPE ${name} gauge`,
        `${name} ${read()}`,
      );
    }
    return `${lines.join('\n')}\n`;
  }
}
