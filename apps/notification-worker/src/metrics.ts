// In-process counters exposed in the Prometheus text format on GET /metrics (spec section 9.2
// panels: DLQ, untenanted replies). No client library: counters with fixed label sets suffice.
type Labels = Record<string, string>;

interface Counter {
  help: string;
  values: Map<string, { labels: Labels; value: number }>;
}

export const METRIC_NAMES = {
  sent: 'antre_notifications_sent_total',
  duplicates: 'antre_notifications_duplicates_total',
  skipped: 'antre_notifications_skipped_total',
  retried: 'antre_notifications_retried_total',
  deadLettered: 'antre_notifications_dead_lettered_total',
  invalid: 'antre_notifications_invalid_total',
  statusUpdates: 'antre_wa_status_updates_total',
  untenantedReplies: 'antre_wa_untenanted_replies_total',
} as const;

const HELP: Record<string, string> = {
  [METRIC_NAMES.sent]: 'WhatsApp messages accepted by the provider.',
  [METRIC_NAMES.duplicates]: 'Redelivered events whose message was already sent.',
  [METRIC_NAMES.skipped]: 'Events without a recipient (e.g. staff ticket without a number).',
  [METRIC_NAMES.retried]: 'Failed attempts moved to a retry queue.',
  [METRIC_NAMES.deadLettered]: 'Messages moved to notifications.dlq.',
  [METRIC_NAMES.invalid]: 'Messages that are not valid events (rejected to the DLQ).',
  [METRIC_NAMES.statusUpdates]: 'wa.status.received events processed, by matched rows.',
  [METRIC_NAMES.untenantedReplies]: 'Replies sent for events without a tenant (not logged).',
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

  /** Sum over all label sets (tests). */
  total(name: string): number {
    let sum = 0;
    for (const entry of this.counters.get(name)?.values.values() ?? []) sum += entry.value;
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
