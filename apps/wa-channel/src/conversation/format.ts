// Indonesian formatting of dates, times, and amounts in conversation replies. Times are shown in
// the time zone of the location (WIB, WITA, WIT), like the Notification Worker templates.
const ZONE_LABELS: Record<string, string> = {
  'Asia/Jakarta': 'WIB',
  'Asia/Makassar': 'WITA',
  'Asia/Jayapura': 'WIT',
};

const DAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const DAYS_SHORT = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
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
const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'Mei',
  'Jun',
  'Jul',
  'Agu',
  'Sep',
  'Okt',
  'Nov',
  'Des',
];

export function zoneLabel(timeZone: string): string {
  return ZONE_LABELS[timeZone] ?? timeZone;
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    partFormatters.set(timeZone, formatter);
  }
  return formatter;
}

interface LocalParts {
  date: string;
  hour: string;
  minute: string;
}

function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    hour: value('hour'),
    minute: value('minute'),
  };
}

/** Local calendar date of `instant` at the location, YYYY-MM-DD. */
export function localDate(instant: Date, timeZone: string): string {
  return localParts(instant, timeZone).date;
}

/** `date` (YYYY-MM-DD) plus `days` calendar days. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function dateParts(date: string): { weekday: number; day: number; month: number; year: number } {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return { weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(), day, month, year };
}

/** "Sen, 20 Okt" (list row title, at most 24 characters). */
export function formatDateShort(date: string): string {
  const { weekday, day, month } = dateParts(date);
  return `${DAYS_SHORT[weekday]}, ${day} ${MONTHS_SHORT[month - 1]}`;
}

/** "20 Okt" */
export function formatDayMonth(date: string): string {
  const { day, month } = dateParts(date);
  return `${day} ${MONTHS_SHORT[month - 1]}`;
}

/** "Senin, 20 Oktober 2026" */
export function formatDateLong(date: string): string {
  const { weekday, day, month, year } = dateParts(date);
  return `${DAYS[weekday]}, ${day} ${MONTHS[month - 1]} ${year}`;
}

/** "10.45" in the location's time zone. */
export function formatClock(iso: string, timeZone: string): string {
  const { hour, minute } = localParts(new Date(iso), timeZone);
  return `${hour}.${minute}`;
}

/** "10.45 WIB" */
export function formatTime(iso: string, timeZone: string): string {
  return `${formatClock(iso, timeZone)} ${zoneLabel(timeZone)}`;
}

/** "Senin, 20 Oktober 2026 pukul 10.00 WIB" */
export function formatDateTime(iso: string, timeZone: string): string {
  return `${formatDateLong(localDate(new Date(iso), timeZone))} pukul ${formatTime(iso, timeZone)}`;
}

/** "10.00-10.30" (slot row title). */
export function formatSlot(startIso: string, endIso: string, timeZone: string): string {
  return `${formatClock(startIso, timeZone)}-${formatClock(endIso, timeZone)}`;
}

const rupiah = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });

/** "Rp50.000" */
export function formatRupiah(amount: number): string {
  return `Rp${rupiah.format(amount)}`;
}

/**
 * Cuts `text` to at most `max` UTF-16 code units (the unit of the event-contracts length checks)
 * with an ellipsis, without splitting a surrogate pair.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const char of text) {
    if (out.length + char.length > max - 1) break;
    out += char;
  }
  return `${out.trimEnd()}…`;
}

/** One-line label for a button or list row: whitespace collapsed, then clipped. */
export function truncate(text: string, max: number): string {
  return clip(text.replace(/\s+/g, ' ').trim(), max);
}
