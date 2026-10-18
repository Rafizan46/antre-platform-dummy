// Indonesian formatting of times, dates, and amounts for WhatsApp messages. Times are shown in
// the time zone of the location (WIB, WITA, WIT).
const ZONE_LABELS: Record<string, string> = {
  'Asia/Jakarta': 'WIB',
  'Asia/Makassar': 'WITA',
  'Asia/Jayapura': 'WIT',
};
export const DEFAULT_TIME_ZONE = 'Asia/Jakarta';

function zoneLabel(timeZone: string): string {
  return ZONE_LABELS[timeZone] ?? timeZone;
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>();
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function timeFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = timeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    timeFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('id-ID', {
      timeZone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** "10.45 WIB" */
export function formatTime(iso: string, timeZone: string): string {
  const parts = timeFormatter(timeZone).formatToParts(new Date(iso));
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  return `${hour}.${minute} ${zoneLabel(timeZone)}`;
}

/** "Senin, 20 Oktober 2026" */
export function formatDate(iso: string, timeZone: string): string {
  return dateFormatter(timeZone).format(new Date(iso));
}

/** "Senin, 20 Oktober 2026 pukul 10.00 WIB" */
export function formatDateTime(iso: string, timeZone: string): string {
  return `${formatDate(iso, timeZone)} pukul ${formatTime(iso, timeZone)}`;
}

const rupiah = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });

/** "Rp50.000" */
export function formatRupiah(amount: number): string {
  return `Rp${rupiah.format(amount)}`;
}

const MONTHS = [
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
];

/** "2026-10-01" -> "Oktober 2026" */
export function formatPeriodMonth(periodMonth: string): string {
  const [year, month] = periodMonth.split('-');
  return `${MONTHS[Number(month) - 1] ?? month} ${year}`;
}
