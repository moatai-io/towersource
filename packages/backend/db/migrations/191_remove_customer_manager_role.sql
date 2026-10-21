-- Remove the legacy customer_manager role from the active Tower role model.
-- Existing users and invite defaults are promoted to operator so they retain
-- operational troubleshooting access without becoming administrators.
--
-- user_customer_vms is intentionally retained for one compatibility release.
-- It is no longer consulted by active authorization code and may be removed by
-- a later cleanup migration after operators verify the migration.

UPDATE users
   SET role = 'operator'
 WHERE role = 'customer_manager';

UPDATE signup_invite_codes
   SET default_role = 'operator'
 WHERE default_role = 'customer_manager';

COMMENT ON TABLE user_customer_vms IS
  'Legacy customer_manager scope mappings retained temporarily for rollback/audit. Active authorization uses admin/operator roles only.';
