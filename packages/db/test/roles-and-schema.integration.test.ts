// Catalog-level checks of the migrated test database: roles, ownership, RLS flags, the closed
// list of SECURITY DEFINER functions, column privileges, and the plan seed.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool } from './helpers.js';

const TENANT_TABLES = [
  'bookings',
  'locations',
  'notification_logs',
  'operating_hours',
  'queue_tickets',
  'resources',
  'service_resources',
  'services',
  'subscriptions',
  'tenants',
  'ticket_counters',
  'usage_counters',
  'users',
];

const DEFINER_FUNCTIONS = [
  'app_auth_find_user',
  'app_due_booking_holds',
  'app_due_booking_reminders',
  'app_due_subscriptions',
  'app_find_active_by_phone',
  'app_resolve_location',
  'app_wa_update_delivery_status',
];

describe('roles and schema', () => {
  let admin: pg.Pool;
  let app: pg.Pool;

  beforeAll(() => {
    admin = createPool('admin', 2);
    app = createPool('app', 2);
  });

  afterAll(async () => {
    await Promise.all([admin.end(), app.end()]);
  });

  it('creates the four roles without BYPASSRLS; only antre_definer cannot log in', async () => {
    const { rows } = await admin.query(
      `SELECT rolname, rolcanlogin, rolbypassrls, rolsuper
       FROM pg_roles
       WHERE rolname = ANY ($1)
       ORDER BY rolname`,
      [['antre_app', 'antre_definer', 'antre_migrator', 'antre_platform_admin']],
    );
    expect(rows).toEqual([
      { rolname: 'antre_app', rolcanlogin: true, rolbypassrls: false, rolsuper: false },
      { rolname: 'antre_definer', rolcanlogin: false, rolbypassrls: false, rolsuper: false },
      { rolname: 'antre_migrator', rolcanlogin: true, rolbypassrls: false, rolsuper: false },
      { rolname: 'antre_platform_admin', rolcanlogin: true, rolbypassrls: false, rolsuper: false },
    ]);
  });

  it('lets antre_migrator SET ROLE antre_definer without inheriting its privileges', async () => {
    const { rows } = await admin.query(
      `SELECT admin_option, inherit_option, set_option
       FROM pg_auth_members
       WHERE roleid = 'antre_definer'::regrole AND member = 'antre_migrator'::regrole`,
    );
    expect(rows).toEqual([{ admin_option: false, inherit_option: false, set_option: true }]);
  });

  it('makes antre_migrator the owner of every table and forces RLS on the 13 tenant tables', async () => {
    const { rows } = await admin.query(
      `SELECT relname, pg_get_userbyid(relowner) AS owner, relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relnamespace = 'public'::regnamespace
         AND relkind = 'r'
         AND relname NOT LIKE 'pgmigrations%'
       ORDER BY relname`,
    );
    const expected = [...TENANT_TABLES, 'plans'].sort().map((name) => ({
      relname: name,
      owner: 'antre_migrator',
      relrowsecurity: name !== 'plans',
      relforcerowsecurity: name !== 'plans',
    }));
    expect(rows).toEqual(expected);
  });

  it('defines only the closed list of SECURITY DEFINER functions with the mandatory pattern', async () => {
    const { rows } = await admin.query(
      `SELECT proname,
              prosecdef,
              pg_get_userbyid(proowner) AS owner,
              proconfig,
              has_function_privilege('antre_app', oid, 'EXECUTE') AS app_can_execute,
              has_function_privilege('antre_platform_admin', oid, 'EXECUTE') AS others_can_execute
       FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace
       ORDER BY proname`,
    );
    expect(rows).toEqual(
      DEFINER_FUNCTIONS.map((name) => ({
        proname: name,
        prosecdef: true,
        owner: 'antre_definer',
        proconfig: ['search_path=pg_catalog, public, pg_temp'],
        app_can_execute: true,
        others_can_execute: false,
      })),
    );
  });

  it('grants antre_definer only the columns used by the definer functions', async () => {
    const { rows } = await admin.query(
      `SELECT table_name, privilege_type, string_agg(column_name, ',' ORDER BY column_name) AS columns
       FROM information_schema.column_privileges
       WHERE grantee = 'antre_definer'
       GROUP BY table_name, privilege_type
       ORDER BY table_name, privilege_type`,
    );
    expect(rows).toEqual([
      {
        table_name: 'bookings',
        privilege_type: 'SELECT',
        columns:
          'customer_phone,hold_expires_at,id,location_id,reminder_sent_at,start_time,status,tenant_id',
      },
      {
        table_name: 'locations',
        privilege_type: 'SELECT',
        columns: 'code,id,is_active,tenant_id,timezone',
      },
      {
        table_name: 'notification_logs',
        privilege_type: 'SELECT',
        columns: 'delivery_status,provider_message_id',
      },
      {
        table_name: 'notification_logs',
        privilege_type: 'UPDATE',
        columns: 'delivery_status,status_updated_at',
      },
      {
        table_name: 'queue_tickets',
        privilege_type: 'SELECT',
        columns: 'customer_phone,id,location_id,service_date,status,tenant_id',
      },
      {
        table_name: 'subscriptions',
        privilege_type: 'SELECT',
        columns: 'current_period_end,id,pending_expires_at,plan_code,status,tenant_id',
      },
      { table_name: 'tenants', privilege_type: 'SELECT', columns: 'id,slug' },
      {
        table_name: 'users',
        privilege_type: 'SELECT',
        columns: 'email,id,is_active,password_hash,role,tenant_id',
      },
    ]);
  });

  it('seeds the FREE and PAID_LOCATION plans, readable by antre_app', async () => {
    const { rows } = await app.query(
      `SELECT code, name, price_idr_per_month, monthly_ticket_quota FROM plans ORDER BY code`,
    );
    expect(rows).toEqual([
      { code: 'FREE', name: 'Gratis', price_idr_per_month: '0.00', monthly_ticket_quota: 100 },
      {
        code: 'PAID_LOCATION',
        name: 'Berbayar per Lokasi',
        price_idr_per_month: '150000.00',
        monthly_ticket_quota: null,
      },
    ]);
  });
});
