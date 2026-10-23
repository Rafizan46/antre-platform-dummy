// Penyediaan akun SUPER_ADMIN lewat jalur DB yang sah: role antre_migrator (pemilik tabel) boleh
// menulis baris users tanpa tenant. Tidak ada endpoint pendaftaran SUPER_ADMIN (FR-AUTH-02).

export const SUPERADMIN = { email: 'superadmin@antre.test', password: 'Demo-Super-123' };

/** Membuat akun, atau menyetel ulang password bila sudah ada. Mengembalikan 'created' | 'updated'. */
export async function upsertSuperAdmin(client, { email, passwordHash }) {
  const existing = await client.query(
    `SELECT id FROM users WHERE lower(email) = lower($1) AND role = 'SUPER_ADMIN'`,
    [email],
  );
  if (existing.rows.length > 0) {
    await client.query(`UPDATE users SET password_hash = $1, is_active = true WHERE id = $2`, [
      passwordHash,
      existing.rows[0].id,
    ]);
    return 'updated';
  }
  await client.query(
    `INSERT INTO users (tenant_id, email, password_hash, role) VALUES (NULL, $1, $2, 'SUPER_ADMIN')`,
    [email, passwordHash],
  );
  return 'created';
}
