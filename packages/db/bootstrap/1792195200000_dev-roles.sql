-- Up Migration
-- DEV/TEST ONLY. Simulates the one-time database-administrator setup from spec section 6.1:
-- roles plus schema privileges for the current database. Run with superuser credentials
-- (DATABASE_ADMIN_URL). Production roles are created by the database administrator with
-- secret passwords; this file is never run there. Passwords below are dev placeholders that
-- match .env.example. Idempotent: roles are created once per cluster, attributes and grants
-- are re-applied for every database.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'antre_migrator') THEN
        CREATE ROLE antre_migrator;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'antre_app') THEN
        CREATE ROLE antre_app;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'antre_platform_admin') THEN
        CREATE ROLE antre_platform_admin;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'antre_definer') THEN
        CREATE ROLE antre_definer;
    END IF;
END
$$;

-- No role bypasses RLS; cross-tenant access is granted per table by policies in the migrations.
ALTER ROLE antre_migrator WITH LOGIN NOBYPASSRLS PASSWORD 'antre_migrator_dev';
ALTER ROLE antre_app WITH LOGIN NOBYPASSRLS PASSWORD 'antre_app_dev';
ALTER ROLE antre_platform_admin WITH LOGIN NOBYPASSRLS PASSWORD 'antre_platform_admin_dev';
ALTER ROLE antre_definer WITH NOLOGIN NOBYPASSRLS;

-- antre_migrator may SET ROLE antre_definer (needed to hand over function ownership) but does
-- not inherit its privileges or policies.
GRANT antre_definer TO antre_migrator WITH INHERIT FALSE, SET TRUE;

-- antre_migrator creates the schema objects; antre_definer needs CREATE to become a function owner.
GRANT USAGE, CREATE ON SCHEMA public TO antre_migrator;
GRANT USAGE, CREATE ON SCHEMA public TO antre_definer;

-- Runtime roles only resolve objects in public (explicit in case PUBLIC lost USAGE on it).
GRANT USAGE ON SCHEMA public TO antre_app, antre_platform_admin;
