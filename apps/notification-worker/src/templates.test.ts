import { describe, expect, it } from 'vitest';

import { TEMPLATES, renderTemplate, sanitizeParameter, type TemplateName } from './templates.js';

const NAMES = Object.keys(TEMPLATES) as TemplateName[];

describe('templates', () => {
  it('cover the template names of the event catalog (spec 7.1)', () => {
    expect(NAMES.sort()).toEqual([
      'antre_booking_confirmed',
      'antre_booking_expired',
      'antre_booking_payment',
      'antre_booking_reminder',
      'antre_near_turn',
      'antre_quota_exceeded',
      'antre_quota_warning',
      'antre_subscription_activated',
      'antre_ticket_called',
      'antre_ticket_created',
    ]);
  });

  it.each(NAMES)('%s numbers its placeholders 1..n, one per variable', (name) => {
    const { body, variables } = TEMPLATES[name];
    const used = [
      ...new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]))),
    ];
    expect(used.sort((a, b) => a - b)).toEqual(variables.map((_variable, index) => index + 1));
  });

  it.each(NAMES)('%s neither starts nor ends with a placeholder (Meta rule)', (name) => {
    const { body } = TEMPLATES[name];
    expect(body.trimStart().startsWith('{{')).toBe(false);
    expect(body.trimEnd().endsWith('}}')).toBe(false);
    expect(body.length).toBeLessThanOrEqual(1024);
  });

  it('renders positional parameters and the preview text', () => {
    const message = renderTemplate(
      'antre_ticket_called',
      {
        customer_name: 'Budi',
        call_label: 'panggilan',
        ticket_number: 'A-010',
        resource_name: 'Loket 2',
        tenant_name: 'Klinik Sehat',
      },
      'id',
    );
    expect(message).toEqual({
      kind: 'template',
      name: 'antre_ticket_called',
      language: 'id',
      parameters: ['Budi', 'panggilan', 'A-010', 'Loket 2', 'Klinik Sehat'],
      preview:
        'Halo Budi, panggilan: nomor antrean Anda *A-010* sedang dipanggil di Loket 2 (Klinik Sehat).\n\n' +
        'Silakan segera menuju ke sana.',
    });
  });

  it('sanitises parameters: no newlines or tabs, no runs of spaces, never empty', () => {
    expect(sanitizeParameter('Selamat datang!\n\nKami buka\tsetiap hari    pukul 08.00')).toBe(
      'Selamat datang! Kami buka setiap hari pukul 08.00',
    );
    expect(sanitizeParameter('   ')).toBe('-');
    const long = sanitizeParameter('x'.repeat(600));
    expect(long).toHaveLength(500);
    expect(long.endsWith('...')).toBe(true);
  });
});
