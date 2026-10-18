-- Up Migration
-- S11 (T2): the Super Admin console may suspend and reactivate a tenant or a single location
-- (FR-ADMIN-01, decision S11). A suspended tenant or location keeps its data; the services refuse
-- new work for it. antre_platform_admin gets UPDATE on the suspended_at column only, through a
-- policy FOR UPDATE TO antre_platform_admin; every other privilege of the role stays read-only.
-- antre_app keeps its existing table privileges (no API lets a tenant write these columns).
ALTER TABLE tenants ADD COLUMN suspended_at timestamptz;
ALTER TABLE locations ADD COLUMN suspended_at timestamptz;

GRANT UPDATE (suspended_at) ON tenants, locations TO antre_platform_admin;

CREATE POLICY platform_admin_suspend ON tenants
    FOR UPDATE TO antre_platform_admin
    USING (true)
    WITH CHECK (true);
CREATE POLICY platform_admin_suspend ON locations
    FOR UPDATE TO antre_platform_admin
    USING (true)
    WITH CHECK (true);

-- Down Migration
DROP POLICY platform_admin_suspend ON locations;
DROP POLICY platform_admin_suspend ON tenants;
REVOKE UPDATE (suspended_at) ON tenants, locations FROM antre_platform_admin;
ALTER TABLE locations DROP COLUMN suspended_at;
ALTER TABLE tenants DROP COLUMN suspended_at;
