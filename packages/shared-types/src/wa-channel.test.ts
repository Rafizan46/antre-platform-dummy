import { describe, expect, it } from 'vitest';

import { activeItemsQuerySchema, resolveLocationQuerySchema } from './index.js';

describe('WhatsApp channel internal schemas', () => {
  it('lower-cases and trims the keyword parts (FR-WA-03)', () => {
    expect(resolveLocationQuerySchema.parse({ slug: ' Klinik-Sehat ', code: 'PUSAT' })).toEqual({
      slug: 'klinik-sehat',
      code: 'pusat',
    });
  });

  it('rejects malformed slugs, codes, and unknown keys', () => {
    expect(
      resolveLocationQuerySchema.safeParse({ slug: 'klinik sehat', code: 'pusat' }).success,
    ).toBe(false);
    expect(resolveLocationQuerySchema.safeParse({ slug: 'klinik', code: '' }).success).toBe(false);
    expect(
      resolveLocationQuerySchema.safeParse({ slug: 'klinik', code: 'pusat', x: '1' }).success,
    ).toBe(false);
  });

  it('accepts only WhatsApp digits as the phone of active items', () => {
    expect(activeItemsQuerySchema.parse({ customer_phone: '6281234567890' })).toEqual({
      customer_phone: '6281234567890',
    });
    expect(activeItemsQuerySchema.safeParse({ customer_phone: '+6281234567890' }).success).toBe(
      false,
    );
  });
});
