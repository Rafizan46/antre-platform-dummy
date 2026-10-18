// S11 migration 1792371600000_platform-admin-suspension: antre_platform_admin may write only the
// suspended_at column of tenants and locations; everything else stays read-only.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool, createTenant, type TenantFixture } from './helpers.js';

describe('platform admin suspension', () => {
  let app: pg.Pool;
  let platformAdmin: pg.Pool;
  let tenant: TenantFixture;

  beforeAll(async () => {
    app = createPool('app', 2);
    platformAdmin = createPool('platformAdmin', 2);
    tenant = await createTenant(app);
  });

  afterAll(async () => {
    await Promise.all([app.end(), platformAdmin.end()]);
  });

  it('lets antre_platform_admin set and clear suspended_at across tenants', async () => {
    const tenants = await platformAdmin.query(
      'UPDATE tenants SET suspended_at = now() WHERE id = $1 RETURNING id',
      [tenant.tenantId],
    );
    expect(tenants.rowCount).toBe(1);
    const locations = await platformAdmin.query(
      'UPDATE locations SET suspended_at = now() WHERE id = $1 RETURNING id',
      [tenant.locationId],
    );
    expect(locations.rowCount).toBe(1);
    await platformAdmin.query('UPDATE tenants SET suspended_at = NULL WHERE id = $1', [
      tenant.tenantId,
    ]);
    await platformAdmin.query('UPDATE locations SET suspended_at = NULL WHERE id = $1', [
      tenant.locationId,
    ]);
  });

  it('keeps every other column and table read-only for antre_platform_admin', async () => {
    await expect(
      platformAdmin.query(`UPDATE tenants SET name = 'x' WHERE id = $1`, [tenant.tenantId]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      platformAdmin.query('UPDATE locations SET is_active = false WHERE id = $1', [
        tenant.locationId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(platformAdmin.query('DELETE FROM tenants WHERE false')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      platformAdmin.query(`UPDATE subscriptions SET plan_code = 'PAID_LOCATION'`),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
