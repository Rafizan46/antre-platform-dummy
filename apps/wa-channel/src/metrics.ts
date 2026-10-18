// In-process counters exposed in the Prometheus text format on GET /metrics. No client library:
// counters with small fixed label sets suffice (same approach as the Notification Worker).
type Labels = Record<string, string>;

interface Counter {
  help: string;
  values: Map<string, { labels: Labels; value: number }>;
}

export const METRIC_NAMES = {
  webhookRequests: 'antre_wa_webhook_requests_total',
  inboundPublished: 'antre_wa_inbound_published_total',
  inboundDuplicates: 'antre_wa_inbound_duplicates_total',
  inboundIgnored: 'antre_wa_inbound_ignored_total',
  statusesPublished: 'antre_wa_statuses_published_total',
  conversations: 'antre_wa_conversation_messages_total',
  repliesRequested: 'antre_wa_replies_requested_total',
  rateLimited: 'antre_wa_rate_limited_total',
  retried: 'antre_wa_inbound_retried_total',
  deadLettered: 'antre_wa_inbound_dead_lettered_total',
  invalid: 'antre_wa_inbound_invalid_total',
} as const;

const HELP: Record<string, string> = {
  [METRIC_NAMES.webhookRequests]: 'Webhook POST requests by result.',
  [METRIC_NAMES.inboundPublished]: 'Inbound messages published as wa.message.received.',
  [METRIC_NAMES.inboundDuplicates]: 'Inbound messages dropped as duplicates, by stage.',
  [METRIC_NAMES.inboundIgnored]: 'Webhook entries ignored (other number, invalid sender, type).',
  [METRIC_NAMES.statusesPublished]: 'Delivery statuses published as wa.status.received.',
  [METRIC_NAMES.conversations]: 'Inbound messages handled by the conversation engine, by outcome.',
  [METRIC_NAMES.repliesRequested]: 'wa.reply.requested events published, by tenant presence.',
  [METRIC_NAMES.rateLimited]: 'Inbound messages over the per-number rate limit (FR-WA-08).',
  [METRIC_NAMES.retried]: 'Failed inbound messages moved to a retry queue.',
  [METRIC_NAMES.deadLettered]: 'Inbound messages moved to wa.inbound.dlq.',
  [METRIC_NAMES.invalid]: 'wa.inbound messages that are not valid events (rejected to the DLQ).',
};

function key(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`)
    .join(',');
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

export class Metrics {
  private readonly counters = new Map<string, Counter>();

  constructor() {
    for (const name of Object.values(METRIC_NAMES)) {
      this.counters.set(name, { help: HELP[name] ?? name, values: new Map() });
    }
  }

  increment(name: string, labels: Labels = {}, by = 1): void {
    let counter = this.counters.get(name);
    if (!counter) {
      counter = { help: name, values: new Map() };
      this.counters.set(name, counter);
    }
    const id = key(labels);
    const entry = counter.values.get(id) ?? { labels, value: 0 };
    entry.value += by;
    counter.values.set(id, entry);
  }

  /** Sum over all label sets, or of one label set (tests). */
  total(name: string, labels?: Labels): number {
    const values = this.counters.get(name)?.values;
    if (!values) return 0;
    if (labels !== undefined) return values.get(key(labels))?.value ?? 0;
    let sum = 0;
    for (const entry of values.values()) sum += entry.value;
    return sum;
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, counter] of this.counters) {
      lines.push(`# HELP ${name} ${counter.help}`, `# TYPE ${name} counter`);
      if (counter.values.size === 0) lines.push(`${name} 0`);
      for (const { labels, value } of counter.values.values()) {
        const rendered = Object.entries(labels)
          .map(([label, labelValue]) => `${label}="${escapeLabel(labelValue)}"`)
          .join(',');
        lines.push(rendered === '' ? `${name} ${value}` : `${name}{${rendered}} ${value}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}
