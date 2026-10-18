import { describe, expect, it } from 'vitest';

import { Metrics, METRIC_NAMES, createLogger, maskPhone } from './index.js';

describe('@antre/notification-worker', () => {
  it('loads the entry module', async () => {
    await expect(import('./index.js')).resolves.toBeDefined();
  });

  it('masks recipients in logs', () => {
    expect(maskPhone('6281234567890')).toBe('628******7890');
    expect(maskPhone('12345')).toBe('*****');
  });

  it('writes structured log lines with serialised errors', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'info', write: (line) => lines.push(line) });
    log.debug({ hidden: true }, 'not written');
    log.error({ err: Object.assign(new Error('boom'), { code: 'E1' }) }, 'failed');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: 50,
      msg: 'failed',
      err: { type: 'Error', message: 'boom', code: 'E1' },
    });
  });

  it('renders counters in the Prometheus text format', () => {
    const metrics = new Metrics();
    metrics.increment(METRIC_NAMES.sent, { kind: 'template' });
    metrics.increment(METRIC_NAMES.sent, { kind: 'template' });
    metrics.increment(METRIC_NAMES.untenantedReplies);
    const text = metrics.render();
    expect(text).toContain('# TYPE antre_notifications_sent_total counter');
    expect(text).toContain('antre_notifications_sent_total{kind="template"} 2');
    expect(text).toContain('antre_wa_untenanted_replies_total 1');
    expect(text).toContain('antre_notifications_dead_lettered_total 0');
    expect(metrics.total(METRIC_NAMES.sent)).toBe(2);
  });
});
