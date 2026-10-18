// API errors with Indonesian messages derived from the error code (ErrorCode of shared-types).
import type { ErrorCode } from '@antre/shared-types';

type Code = ErrorCode | 'NETWORK' | 'BAD_RESPONSE';

export class ApiError extends Error {
  readonly status: number;
  readonly code: Code;
  readonly details: unknown;

  constructor(status: number, code: Code, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const FIXED_MESSAGES: Record<Code, string> = {
  VALIDATION_ERROR: 'Data yang dimasukkan belum valid. Periksa kembali isian Anda.',
  UNAUTHORIZED: 'Sesi berakhir. Silakan masuk kembali.',
  INVALID_CREDENTIALS: 'Email atau kata sandi salah.',
  QUOTA_EXCEEDED: 'Kuota tiket bulan ini habis. Upgrade paket untuk melanjutkan.',
  FORBIDDEN: 'Anda tidak memiliki izin untuk tindakan ini.',
  NOT_FOUND: 'Data tidak ditemukan.',
  PAYMENT_TARGET_NOT_FOUND: 'Tujuan pembayaran tidak ditemukan.',
  ALREADY_EXISTS: 'Data sudah ada.',
  INVALID_TRANSITION: 'Tindakan tidak dapat dilakukan pada status saat ini. Data sudah diperbarui.',
  SLOT_LOCKED: 'Slot sedang ditahan pelanggan lain.',
  SLOT_TAKEN: 'Slot sudah terisi.',
  ACTIVE_TICKET_EXISTS: 'Pelanggan ini masih memiliki tiket aktif.',
  MODE_DISABLED: 'Mode layanan ini dinonaktifkan.',
  LOCATION_CLOSED: 'Lokasi sedang tutup atau ditangguhkan.',
  PAYMENT_NOT_APPLICABLE: 'Pembayaran tidak berlaku untuk data ini.',
  RATE_LIMITED: 'Terlalu banyak percobaan. Coba lagi beberapa saat.',
  INTERNAL_ERROR: 'Terjadi gangguan pada server. Coba lagi nanti.',
  NETWORK: 'Tidak dapat terhubung ke server. Periksa koneksi Anda.',
  BAD_RESPONSE: 'Respons server tidak dikenali.',
};

// The server messages of these codes are already Indonesian and more specific.
const SERVER_MESSAGE_CODES = new Set<Code>([
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'ACTIVE_TICKET_EXISTS',
  'MODE_DISABLED',
  'LOCATION_CLOSED',
]);

/** Indonesian text for an error; a suspended tenant is a FORBIDDEN with details.reason. */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Terjadi kesalahan tak terduga.';
  const reason = (error.details as { reason?: unknown } | undefined)?.reason;
  if (error.code === 'FORBIDDEN' && reason === 'TENANT_SUSPENDED') {
    return 'Akun bisnis Anda ditangguhkan. Hubungi administrator platform.';
  }
  if (SERVER_MESSAGE_CODES.has(error.code) && error.message !== '') return error.message;
  return FIXED_MESSAGES[error.code];
}

export function networkError(): ApiError {
  return new ApiError(0, 'NETWORK', FIXED_MESSAGES.NETWORK);
}

export function badResponse(status: number): ApiError {
  return new ApiError(status, 'BAD_RESPONSE', FIXED_MESSAGES.BAD_RESPONSE);
}
