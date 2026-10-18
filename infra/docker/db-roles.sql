-- One-time database-administrator setup (spec section 6.1): the four Antre roles plus schema
-- privileges for the current database. Run with superuser credentials BEFORE db-migrate:
--   psql -v ON_ERROR_STOP=1 -f db-roles.sql "$DATABASE_ADMIN_URL"
-- Passwords come from the environment (psql >= 15 \getenv), never from this file:
--   ANTRE_MIGRATOR_PASSWORD, ANTRE_APP_PASSWORD, ANTRE_PLATFORM_ADMIN_PASSWORD
-- Idempotent. Same grants as packages/db/bootstrap (dev), but with real passwords. Managed
-- PostgreSQL: run it once with the provider's admin user, or apply the same statements by hand.
\getenv migrator_password ANTRE_MIGRATOR_PASSWORD
\getenv app_password ANTRE_APP_PASSWORD
\getenv admin_password ANTRE_PLATFORM_ADMIN_PASSWORD

SELECT 'CREATE ROLE ' || r FROM unnest(ARRAY['antre_migrator', 'antre_app', 'antre_platform_admin', 'antre_definer']) AS r
WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r)
\gexec

-- No role bypasses RLS; cross-tenant access is granted per table by policies in the migrations.
ALTER ROLE antre_migrator WITH LOGIN NOBYPASSRLS PASSWORD :'migrator_password';
ALTER ROLE antre_app WITH LOGIN NOBYPASSRLS PASSWORD :'app_password';
ALTER ROLE antre_platform_admin WITH LOGIN NOBYPASSRLS PASSWORD :'admin_password';
ALTER ROLE antre_definer WITH NOLOGIN NOBYPASSRLS;

-- antre_migrator may SET ROLE antre_definer (needed to hand over function ownership) but does
-- not inherit its privileges or policies.
GRANT antre_definer TO antre_migrator WITH INHERIT FALSE, SET TRUE;

-- antre_migrator creates the schema objects; antre_definer needs CREATE to become a function owner.
GRANT USAGE, CREATE ON SCHEMA public TO antre_migrator;
GRANT USAGE, CREATE ON SCHEMA public TO antre_definer;

-- Runtime roles only resolve objects in public.
GRANT USAGE ON SCHEMA public TO antre_app, antre_platform_admin;
