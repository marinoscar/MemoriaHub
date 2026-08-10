-- Retire the v0 server-side media backup feature (superseded by epic #308).
-- role_permissions.permission_id is ON DELETE CASCADE, so the Admin grants
-- for these two permissions are removed by this statement.
DELETE FROM permissions WHERE name IN ('backup:run', 'backup:read');
