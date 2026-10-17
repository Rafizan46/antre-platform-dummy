// SQL of the users module. Every query runs in a tenant-scoped transaction; Row-Level Security is
// the tenant boundary, so these statements do not filter by tenant themselves.
import type { StaffRole, UserDto, UserRole } from '@antre/shared-types';
import type pg from 'pg';

export interface UserRow {
  id: string;
  email: string;
  role: UserRole;
  is_active: boolean;
  created_at: Date;
}

export const USER_COLUMNS = 'id, email, role, is_active, created_at';

export function toUserDto(row: UserRow): UserDto {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    is_active: row.is_active,
    created_at: row.created_at.toISOString(),
  };
}

export async function listUsers(client: pg.PoolClient): Promise<UserRow[]> {
  const result = await client.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users ORDER BY created_at, id`,
  );
  return result.rows;
}

export async function insertStaff(
  client: pg.PoolClient,
  values: { tenantId: string; email: string; passwordHash: string; role: StaffRole },
): Promise<UserRow> {
  const result = await client.query<UserRow>(
    `INSERT INTO users (tenant_id, email, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING ${USER_COLUMNS}`,
    [values.tenantId, values.email, values.passwordHash, values.role],
  );
  return result.rows[0]!;
}

/** Locks the user row; returns its role, or null when it is not visible in this tenant. */
export async function lockUserRole(client: pg.PoolClient, id: string): Promise<UserRole | null> {
  const result = await client.query<{ role: UserRole }>(
    'SELECT role FROM users WHERE id = $1 FOR UPDATE',
    [id],
  );
  return result.rows[0]?.role ?? null;
}

export async function updateStaff(
  client: pg.PoolClient,
  id: string,
  values: { role?: StaffRole; passwordHash?: string; isActive?: boolean },
): Promise<UserRow> {
  const result = await client.query<UserRow>(
    `UPDATE users
     SET role = COALESCE($2, role),
         password_hash = COALESCE($3, password_hash),
         is_active = COALESCE($4, is_active)
     WHERE id = $1
     RETURNING ${USER_COLUMNS}`,
    [id, values.role ?? null, values.passwordHash ?? null, values.isActive ?? null],
  );
  return result.rows[0]!;
}
