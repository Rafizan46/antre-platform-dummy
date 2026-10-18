import { describe, expect, it } from 'vitest';

import {
  createResourceRequestSchema,
  createServiceRequestSchema,
  formatTicketNumber,
  operatingDaySchema,
  putOperatingHoursRequestSchema,
  ticketActionRequestSchema,
  updateServiceRequestSchema,
} from './index.js';

const day = { day_of_week: 1, open_time: '08:00', close_time: '17:00' };

describe('createServiceRequestSchema', () => {
  const base = { name: 'Umum', ticket_prefix: 'A', avg_duration_min: 10 };

  it('applies defaults', () => {
    expect(createServiceRequestSchema.parse(base)).toEqual({
      ...base,
      price: 0,
      requires_dp: false,
      dp_amount: null,
      is_active: true,
    });
  });

  it('requires dp_amount exactly when requires_dp is true', () => {
    expect(createServiceRequestSchema.safeParse({ ...base, requires_dp: true }).success).toBe(
      false,
    );
    expect(createServiceRequestSchema.safeParse({ ...base, dp_amount: 5000 }).success).toBe(false);
    expect(
      createServiceRequestSchema.safeParse({ ...base, requires_dp: true, dp_amount: 5000 }).success,
    ).toBe(true);
  });

  it('rejects a bad prefix and unknown keys', () => {
    expect(createServiceRequestSchema.safeParse({ ...base, ticket_prefix: 'a' }).success).toBe(
      false,
    );
    expect(createServiceRequestSchema.safeParse({ ...base, ticket_prefix: 'ABCD' }).success).toBe(
      false,
    );
    expect(createServiceRequestSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});

describe('updateServiceRequestSchema', () => {
  it('needs at least one key and requires_dp with dp_amount together', () => {
    expect(updateServiceRequestSchema.safeParse({}).success).toBe(false);
    expect(updateServiceRequestSchema.safeParse({ requires_dp: true }).success).toBe(false);
    expect(updateServiceRequestSchema.safeParse({ dp_amount: 1000 }).success).toBe(false);
    expect(
      updateServiceRequestSchema.safeParse({ requires_dp: true, dp_amount: null }).success,
    ).toBe(false);
    expect(
      updateServiceRequestSchema.safeParse({ requires_dp: false, dp_amount: null }).success,
    ).toBe(true);
    expect(updateServiceRequestSchema.safeParse({ name: 'Baru' }).success).toBe(true);
  });
});

describe('operatingDaySchema', () => {
  it('defaults the break to null', () => {
    expect(operatingDaySchema.parse(day)).toEqual({ ...day, break_start: null, break_end: null });
  });

  it('requires open before close and a well-formed time', () => {
    expect(operatingDaySchema.safeParse({ ...day, close_time: '08:00' }).success).toBe(false);
    expect(operatingDaySchema.safeParse({ ...day, open_time: '8:00' }).success).toBe(false);
    expect(operatingDaySchema.safeParse({ ...day, close_time: '24:00' }).success).toBe(false);
  });

  it('validates the break', () => {
    const withBreak = (break_start: string | null, break_end: string | null) =>
      operatingDaySchema.safeParse({ ...day, break_start, break_end }).success;
    expect(withBreak('12:00', '13:00')).toBe(true);
    expect(withBreak('12:00', null)).toBe(false);
    expect(withBreak(null, '13:00')).toBe(false);
    expect(withBreak('13:00', '12:00')).toBe(false);
    expect(withBreak('12:00', '12:00')).toBe(false);
    expect(withBreak('07:00', '09:00')).toBe(false);
    expect(withBreak('16:00', '18:00')).toBe(false);
  });
});

describe('putOperatingHoursRequestSchema', () => {
  it('rejects a duplicate day_of_week and more than 7 days', () => {
    expect(
      putOperatingHoursRequestSchema.safeParse({ slot_interval_min: 30, days: [day, day] }).success,
    ).toBe(false);
    const eight = Array.from({ length: 8 }, (_, index) => ({ ...day, day_of_week: index % 7 }));
    expect(
      putOperatingHoursRequestSchema.safeParse({ slot_interval_min: 30, days: eight }).success,
    ).toBe(false);
    expect(
      putOperatingHoursRequestSchema.safeParse({ slot_interval_min: 30, days: [] }).success,
    ).toBe(true);
  });
});

describe('createResourceRequestSchema', () => {
  const locationId = '3f0c7a4e-6b1d-4e0a-9d52-1c2b3a4d5e6f';

  it('defaults and rejects duplicate service ids', () => {
    expect(createResourceRequestSchema.parse({ location_id: locationId, name: 'Loket 1' })).toEqual(
      {
        location_id: locationId,
        name: 'Loket 1',
        resource_type: null,
        is_active: true,
        service_ids: [],
      },
    );
    expect(
      createResourceRequestSchema.safeParse({
        location_id: locationId,
        name: 'Loket 1',
        service_ids: [locationId, locationId],
      }).success,
    ).toBe(false);
  });
});

describe('ticketActionRequestSchema', () => {
  it('accepts staff actions only', () => {
    expect(ticketActionRequestSchema.safeParse({ action: 'RECALL' }).success).toBe(true);
    expect(ticketActionRequestSchema.safeParse({ action: 'CANCEL' }).success).toBe(false);
    expect(ticketActionRequestSchema.safeParse({ action: 'CALL_NEXT' }).success).toBe(false);
  });
});

describe('formatTicketNumber', () => {
  it('pads to three digits and grows beyond', () => {
    expect(formatTicketNumber('A', 1)).toBe('A-001');
    expect(formatTicketNumber('A', 999)).toBe('A-999');
    expect(formatTicketNumber('A', 1000)).toBe('A-1000');
  });
});
