// Indonesian texts and message builders of the conversation (FR-WA-03..08, NFR-ACCS-01). Every
// interactive message also lists its options as numbered lines so the customer can answer with
// a number (FR-WA-07). Builders respect the limits of the wa.reply.requested contract: text body
// 4096, interactive body 1024, at most 3 buttons (title 20), list of at most 10 rows (title 24,
// description 72), list button 20.
import type { EventData } from '@antre/event-contracts';

import type { CoreBooking, CoreTicket } from '../core-client.js';
import {
  clip,
  formatClock,
  formatDateTime,
  formatDayMonth,
  formatRupiah,
  formatTime,
  localDate,
  truncate,
} from './format.js';
import type { MenuOption } from './session.js';

export type WaMessage = EventData<'wa.reply.requested'>['message'];

export const LIMITS = {
  text: 4096,
  body: 1024,
  buttons: 3,
  buttonTitle: 20,
  rows: 10,
  rowTitle: 24,
  rowDescription: 72,
  listButton: 20,
} as const;

export const TEXT = {
  scanQr:
    'Halo! Untuk mengambil antrean atau membuat reservasi, silakan pindai (scan) kode QR Antre yang terpasang di lokasi usaha. ' +
    'Chat akan terbuka dengan pesan seperti "ANTRE nama-usaha kode-lokasi"; kirim pesan itu untuk mulai.\n\n' +
    'Ketik STATUS untuk melihat antrean atau reservasi aktif Anda, atau BATAL untuk membatalkannya.',
  unknownLocation:
    'Maaf, kode lokasi pada pesan Anda tidak kami kenali atau lokasinya sedang tidak aktif. ' +
    'Pastikan Anda memindai QR yang terpasang di lokasi usaha, lalu kirim pesannya tanpa diubah.',
  help:
    'Perintah yang dapat Anda ketik kapan saja:\n' +
    'MENU - kembali ke menu utama\n' +
    'STATUS - cek antrean dan reservasi aktif\n' +
    'BATAL - batalkan antrean atau reservasi\n' +
    'BANTUAN - tampilkan bantuan ini\n' +
    'STOP - akhiri sesi percakapan\n\n' +
    'Untuk memulai, pindai QR Antre yang terpasang di lokasi usaha.',
  stopped:
    'Sesi percakapan Anda telah diakhiri. Notifikasi untuk antrean atau reservasi yang masih aktif tetap dikirim; ' +
    'ketik BATAL bila ingin membatalkannya. Pindai QR di lokasi untuk memulai lagi.',
  unsupported:
    'Maaf, kami hanya dapat membaca pesan teks dan pilihan menu. Ketik MENU untuk melihat menu atau BANTUAN untuk bantuan.',
  rateLimited:
    'Anda mengirim terlalu banyak pesan dalam waktu singkat. Mohon tunggu sekitar satu menit sebelum mengirim pesan lagi.',
  noActiveItems: 'Anda tidak memiliki antrean atau reservasi yang aktif saat ini.',
  serviceTrouble:
    'Maaf, layanan kami sedang mengalami gangguan sehingga pesan Anda belum dapat diproses. Silakan coba lagi beberapa saat lagi.',
  // FR-WA-04 (402 QUOTA_EXCEEDED).
  queueQuota:
    'Maaf, antrean online di lokasi ini sedang tidak tersedia. Silakan menghubungi petugas di lokasi.',
  bookingQuota:
    'Maaf, reservasi online di lokasi ini sedang tidak tersedia. Silakan menghubungi petugas di lokasi.',
  locationClosed:
    'Maaf, lokasi sedang tutup sehingga antrean belum dapat diambil. Silakan coba lagi pada jam operasional.',
  bookingClosed: 'Maaf, lokasi ini sedang tidak menerima reservasi.',
  walkinDisabled: 'Antrean langsung tidak tersedia di lokasi ini.',
  bookingDisabled: 'Reservasi tidak tersedia di lokasi ini.',
  noServices: 'Belum ada layanan yang dapat dipilih di lokasi ini.',
  serviceGone: 'Layanan itu sudah tidak tersedia. Silakan pilih layanan lain.',
  noSlotsWeek:
    'Belum ada slot kosong untuk layanan itu dalam 7 hari ke depan. Silakan pilih layanan lain.',
  slotTaken: 'Maaf, slot itu baru saja diambil pelanggan lain. Silakan pilih slot lain.',
  dayFull: 'Slot pada tanggal itu sudah habis. Silakan pilih tanggal lain.',
  notCancellableAnymore:
    'Antrean atau reservasi itu tidak dapat dibatalkan lagi karena statusnya sudah berubah. Ketik STATUS untuk melihat status terbaru.',
  notCancellable:
    'Antrean Anda sedang dipanggil atau dilayani sehingga tidak dapat dibatalkan lewat WhatsApp. Silakan menghubungi petugas di lokasi.',
  requestFailed: 'Maaf, permintaan Anda belum dapat diproses. Ketik MENU untuk mencoba lagi.',
  backToMenu: 'Pilihan tidak dikenali beberapa kali, jadi kami kembalikan Anda ke menu utama.',
  menuFooter:
    'Balas dengan angka pilihan. Ketik STATUS untuk cek antrean, BATAL untuk membatalkan, atau BANTUAN untuk bantuan.',
  listFooter: 'Balas dengan angka pilihan. Ketik MENU untuk kembali ke menu utama.',
  cancelFooter: 'Balas dengan angka pilihan. Ketik MENU untuk kembali.',
} as const;

export function invalidOptionText(count: number): string {
  return count === 1
    ? 'Pilihan tidak dikenali. Balas dengan angka 1 atau tekan pilihan di bawah.'
    : `Pilihan tidak dikenali. Balas dengan angka 1 sampai ${count}, atau tekan salah satu pilihan.`;
}

export function textMessage(body: string): WaMessage {
  return { kind: 'text', body: clip(body, LIMITS.text) };
}

/** Body text = notice, intro, numbered options, footer; the numbered lines are never clipped. */
function optionsBody(
  intro: string,
  footer: string,
  options: MenuOption[],
  notice: string | null,
): string {
  const lines = options.map((option, index) => `${index + 1}. ${option.label}`).join('\n');
  const tail = [lines, footer].filter((part) => part !== '').join('\n\n');
  const head = [notice, intro].filter((part): part is string => part !== null && part !== '');
  const budget = LIMITS.body - tail.length - 2;
  const headText = head.length === 0 || budget <= 0 ? '' : clip(head.join('\n\n'), budget);
  return clip(headText === '' ? tail : `${headText}\n\n${tail}`, LIMITS.body);
}

/**
 * Buttons for up to 3 short options, a list otherwise. `options` must hold 1 to 10 entries; a
 * longer list is paged by the caller ("Berikutnya" row).
 */
export function optionsMessage(
  prompt: { intro: string; footer: string },
  options: MenuOption[],
  notice: string | null = null,
): WaMessage {
  if (options.length === 0 || options.length > LIMITS.rows) {
    throw new Error(`optionsMessage needs 1 to ${LIMITS.rows} options, got ${options.length}`);
  }
  const body = optionsBody(prompt.intro, prompt.footer, options, notice);
  if (
    options.length <= LIMITS.buttons &&
    options.every((option) => option.title.length <= LIMITS.buttonTitle)
  ) {
    return {
      kind: 'buttons',
      body,
      buttons: options.map((option) => ({ id: option.id, title: option.title })),
    };
  }
  return {
    kind: 'list',
    body,
    button_text: 'Pilih',
    rows: options.map((option) => ({
      id: option.id,
      title: truncate(option.title, LIMITS.rowTitle),
      ...(option.description === undefined
        ? {}
        : { description: truncate(option.description, LIMITS.rowDescription) }),
    })),
  };
}

/** A page of `items`: all when they fit in one list, else 9 per page plus a "next" row. */
export function paginate<T>(
  items: T[],
  page: number,
): { items: T[]; hasMore: boolean; page: number } {
  if (items.length <= LIMITS.rows) return { items, hasMore: false, page: 0 };
  const size = LIMITS.rows - 1;
  const current = Math.max(0, Math.min(page, Math.floor((items.length - 1) / size)));
  const start = current * size;
  return {
    items: items.slice(start, start + size),
    hasMore: start + size < items.length,
    page: current,
  };
}

// Status of tickets and bookings (FR-WA-06)

export interface StatusContext {
  tenantName: string;
  locationName: string;
  timeZone: string;
  showEstimate: boolean;
  resourceLabel: string | null;
}

export function ticketLine(ticket: CoreTicket, context: StatusContext): string {
  const head = `Antrean *${ticket.ticket_number}* (${ticket.service_name})`;
  switch (ticket.status) {
    case 'WAITING': {
      const ahead = ticket.people_ahead ?? 0;
      const estimate =
        context.showEstimate && ticket.estimated_serve_time !== null
          ? `, perkiraan giliran sekitar pukul ${formatTime(ticket.estimated_serve_time, context.timeZone)}`
          : '';
      return `${head}: menunggu, ${ahead} antrean di depan Anda${estimate}.`;
    }
    case 'CALLED':
      return `${head}: sedang dipanggil${ticket.resource_name ? ` di ${ticket.resource_name}` : ''}. Silakan segera menuju ke sana.`;
    case 'SERVING':
      return `${head}: sedang dilayani${ticket.resource_name ? ` di ${ticket.resource_name}` : ''}.`;
    default:
      return `${head}: ${ticket.status.toLowerCase()}.`;
  }
}

export function bookingLine(booking: CoreBooking, context: StatusContext): string {
  const label = context.resourceLabel ?? 'Tempat';
  const head = `Reservasi ${booking.service_name} (${label}: ${booking.resource_name}), ${formatDateTime(booking.start_time, context.timeZone)}`;
  if (booking.status === 'PENDING_PAYMENT') {
    const amount = booking.dp_amount === null ? '' : ` ${formatRupiah(booking.dp_amount)}`;
    const deadline =
      booking.hold_expires_at === null
        ? ''
        : ` sebelum ${formatTime(booking.hold_expires_at, context.timeZone)}`;
    const ref = booking.payment_ref === null ? '' : ` (kode pembayaran ${booking.payment_ref})`;
    return `${head}: menunggu pembayaran DP${amount}${deadline}${ref}.`;
  }
  if (booking.status === 'CONFIRMED') {
    const dp =
      booking.payment_status === 'PAID' && booking.dp_amount !== null
        ? `, DP ${formatRupiah(booking.dp_amount)} lunas`
        : '';
    return `${head}: terkonfirmasi${dp}.`;
  }
  return `${head}: ${booking.status.toLowerCase()}.`;
}

export interface StatusEntry {
  context: StatusContext;
  ticket?: CoreTicket;
  booking?: CoreBooking;
}

export function statusText(entries: StatusEntry[]): string {
  const lines = entries.map((entry, index) => {
    const where = `${entry.context.tenantName} - ${entry.context.locationName}`;
    const detail =
      entry.ticket !== undefined
        ? ticketLine(entry.ticket, entry.context)
        : bookingLine(entry.booking!, entry.context);
    return `${index + 1}. ${where}\n${detail}`;
  });
  return `Status antrean dan reservasi Anda:\n\n${lines.join('\n\n')}\n\nKetik BATAL untuk membatalkan.`;
}

/** Short list row title and full label of a cancellable item. */
export function cancelOption(entry: StatusEntry): { title: string; label: string } {
  if (entry.ticket !== undefined) {
    return {
      title: `Antrean ${entry.ticket.ticket_number}`,
      label: `Antrean ${entry.ticket.ticket_number} (${entry.ticket.service_name}) di ${entry.context.tenantName}`,
    };
  }
  const booking = entry.booking!;
  return {
    // "Reservasi 20 Okt 10.00" (at most 24 characters).
    title: `Reservasi ${formatDayMonth(localDate(new Date(booking.start_time), entry.context.timeZone))} ${formatClock(booking.start_time, entry.context.timeZone)}`,
    label: `Reservasi ${booking.service_name} di ${entry.context.tenantName}, ${formatDateTime(booking.start_time, entry.context.timeZone)}`,
  };
}
