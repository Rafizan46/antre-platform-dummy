import { describe, expect, it } from 'vitest';

import {
  formatDate,
  formatDateTime,
  formatPeriodMonth,
  formatRupiah,
  formatTime,
} from './format.js';

describe('format', () => {
  it('shows times in the zone of the location with its Indonesian label', () => {
    const iso = '2026-10-20T03:05:00Z';
    expect(formatTime(iso, 'Asia/Jakarta')).toBe('10.05 WIB');
    expect(formatTime(iso, 'Asia/Makassar')).toBe('11.05 WITA');
    expect(formatTime(iso, 'Asia/Jayapura')).toBe('12.05 WIT');
    expect(formatTime('2026-10-20T17:00:00Z', 'Asia/Jakarta')).toBe('00.00 WIB');
  });

  it('shows dates in Indonesian', () => {
    expect(formatDate('2026-10-20T03:00:00Z', 'Asia/Jakarta')).toBe('Selasa, 20 Oktober 2026');
    // 23:30 UTC is already the next day in Jakarta.
    expect(formatDate('2026-10-19T23:30:00Z', 'Asia/Jakarta')).toBe('Selasa, 20 Oktober 2026');
    expect(formatDateTime('2026-10-20T03:00:00Z', 'Asia/Jakarta')).toBe(
      'Selasa, 20 Oktober 2026 pukul 10.00 WIB',
    );
  });

  it('formats rupiah and the quota period', () => {
    expect(formatRupiah(50000)).toBe('Rp50.000');
    expect(formatRupiah(150000)).toBe('Rp150.000');
    expect(formatRupiah(12500.5)).toBe('Rp12.500,5');
    expect(formatPeriodMonth('2026-10-01')).toBe('Oktober 2026');
    expect(formatPeriodMonth('2027-01-01')).toBe('Januari 2027');
  });
});
