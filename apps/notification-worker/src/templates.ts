// WhatsApp message templates of spec section 7.1 (FR-WA-07). `body` is the exact text to submit
// to Meta for approval (language "id", category UTILITY); `variables` names the positional
// parameters {{1}}..{{n}} in order. Meta rules kept here: the body neither starts nor ends with a
// parameter, and parameter values contain no newline, tab, or more than 4 consecutive spaces.
import type { TemplateMessage } from './whatsapp/adapter.js';

interface TemplateDefinition {
  variables: readonly string[];
  body: string;
}

export const TEMPLATES = {
  antre_ticket_created: {
    variables: [
      'customer_name',
      'greeting',
      'ticket_number',
      'service_name',
      'location_name',
      'people_ahead',
      'estimate',
    ],
    body:
      'Halo {{1}}, {{2}}\n\n' +
      'Nomor antrean Anda: *{{3}}*\n' +
      'Layanan: {{4}} ({{5}})\n' +
      'Antrean di depan Anda: {{6}}\n' +
      'Perkiraan giliran: {{7}}\n\n' +
      'Ketik STATUS untuk cek posisi antrean atau BATAL untuk membatalkan.',
  },
  antre_near_turn: {
    variables: [
      'customer_name',
      'tenant_name',
      'ticket_number',
      'service_name',
      'people_ahead',
      'estimate',
    ],
    body:
      'Halo {{1}}, giliran Anda di {{2}} hampir tiba.\n\n' +
      'Nomor antrean: *{{3}}* ({{4}})\n' +
      'Antrean di depan Anda: {{5}}\n' +
      'Perkiraan giliran: {{6}}\n\n' +
      'Mohon bersiap di dekat area layanan.',
  },
  antre_ticket_called: {
    variables: ['customer_name', 'call_label', 'ticket_number', 'resource_name', 'tenant_name'],
    body:
      'Halo {{1}}, {{2}}: nomor antrean Anda *{{3}}* sedang dipanggil di {{4}} ({{5}}).\n\n' +
      'Silakan segera menuju ke sana.',
  },
  antre_booking_payment: {
    variables: [
      'customer_name',
      'tenant_name',
      'service_name',
      'resource_label',
      'resource_name',
      'schedule',
      'dp_amount',
      'payment_ref',
      'qris',
      'pay_before',
    ],
    body:
      'Halo {{1}}, reservasi Anda di {{2}} menunggu pembayaran DP.\n\n' +
      'Layanan: {{3}}\n' +
      '{{4}}: {{5}}\n' +
      'Jadwal: {{6}}\n' +
      'DP: {{7}}\n' +
      'Kode pembayaran: {{8}}\n' +
      'QRIS (simulasi): {{9}}\n\n' +
      'Bayar lewat QRIS sebelum {{10}}. Setelah itu slot dilepas otomatis.',
  },
  antre_booking_cancelled: {
    variables: ['customer_name', 'tenant_name', 'service_name', 'schedule', 'payment_note'],
    body:
      'Halo {{1}}, reservasi Anda di {{2}} telah dibatalkan.\n\n' +
      'Layanan: {{3}}\n' +
      'Jadwal: {{4}}\n' +
      'Pembayaran: {{5}}\n\n' +
      'Silakan pesan ulang lewat menu Reservasi bila masih diperlukan.',
  },
  antre_booking_confirmed: {
    variables: [
      'customer_name',
      'tenant_name',
      'service_name',
      'resource_label',
      'resource_name',
      'schedule',
      'dp',
    ],
    body:
      'Halo {{1}}, reservasi Anda di {{2}} sudah terkonfirmasi.\n\n' +
      'Layanan: {{3}}\n' +
      '{{4}}: {{5}}\n' +
      'Jadwal: {{6}}\n' +
      'DP: {{7}}\n\n' +
      'Ketik STATUS untuk melihat reservasi atau BATAL untuk membatalkan.',
  },
  antre_booking_expired: {
    variables: ['customer_name', 'tenant_name', 'service_name', 'schedule', 'payment_note'],
    body:
      'Halo {{1}}, batas waktu pembayaran DP reservasi Anda di {{2}} sudah lewat, jadi slot dilepas.\n\n' +
      'Layanan: {{3}}\n' +
      'Jadwal: {{4}}\n' +
      'Pembayaran: {{5}}\n\n' +
      'Silakan pesan ulang lewat menu Reservasi bila masih diperlukan.',
  },
  antre_booking_reminder: {
    variables: [
      'customer_name',
      'tenant_name',
      'start_time',
      'service_name',
      'resource_label',
      'resource_name',
    ],
    body:
      'Halo {{1}}, pengingat dari {{2}}: reservasi Anda dimulai pukul {{3}}.\n\n' +
      'Layanan: {{4}}\n' +
      '{{5}}: {{6}}\n\n' +
      'Mohon datang tepat waktu. Ketik BATAL bila berhalangan hadir.',
  },
  antre_quota_warning: {
    variables: ['tenant_name', 'location_name', 'period', 'ticket_count', 'quota'],
    body:
      'Halo Admin {{1}}, pemakaian tiket lokasi {{2}} pada {{3}} sudah mencapai {{4}} dari {{5}} tiket paket Gratis.\n\n' +
      'Upgrade lokasi ke paket Berbayar lewat Dashboard agar antrean tetap berjalan setelah kuota habis.',
  },
  antre_quota_exceeded: {
    variables: ['tenant_name', 'quota', 'location_name', 'period'],
    body:
      'Halo Admin {{1}}, kuota {{2}} tiket paket Gratis untuk lokasi {{3}} pada {{4}} sudah habis.\n\n' +
      'Tiket baru ditolak sampai bulan berikutnya. Upgrade lokasi ke paket Berbayar lewat Dashboard untuk membuka kembali antrean.',
  },
  antre_subscription_activated: {
    variables: ['tenant_name', 'location_name', 'period_start', 'period_end', 'payment_ref'],
    body:
      'Halo Admin {{1}}, paket Berbayar untuk lokasi {{2}} sudah aktif.\n\n' +
      'Periode: {{3}} sampai {{4}}\n' +
      'Kode pembayaran: {{5}}\n\n' +
      'Terima kasih telah berlangganan Antre.',
  },
} as const satisfies Record<string, TemplateDefinition>;

export type TemplateName = keyof typeof TEMPLATES;
export type TemplateValues<N extends TemplateName> = Record<
  (typeof TEMPLATES)[N]['variables'][number],
  string
>;

const MAX_PARAMETER_LENGTH = 500;

/** Makes a value acceptable as a template parameter (Meta rejects newlines and tabs). */
export function sanitizeParameter(value: string): string {
  const flat = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  const capped =
    flat.length > MAX_PARAMETER_LENGTH ? `${flat.slice(0, MAX_PARAMETER_LENGTH - 3)}...` : flat;
  return capped === '' ? '-' : capped;
}

export function renderTemplate<N extends TemplateName>(
  name: N,
  values: TemplateValues<N>,
  language: string,
): TemplateMessage {
  const definition: TemplateDefinition = TEMPLATES[name];
  const parameters = definition.variables.map((variable) =>
    sanitizeParameter((values as Record<string, string>)[variable] ?? ''),
  );
  const preview = definition.body.replace(/\{\{(\d+)\}\}/g, (_match, index: string) => {
    return parameters[Number(index) - 1] ?? '';
  });
  return { kind: 'template', name, language, parameters, preview };
}
