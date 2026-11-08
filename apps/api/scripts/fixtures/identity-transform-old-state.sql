-- =============================================================================
-- Synthetic pre-adoption identity data (RETRO-B2, issue #611)
-- =============================================================================
-- Loaded into a database migrated to the A5 state (the 82 app migrations, the
-- old role catalog seeded) BEFORE the stack's migrations run, so the rehearsal
-- proves what the platform migrations and the avatar migration do to representative
-- rows. Every name and address is invented (`@example.test`). Fixed uuids make the
-- verifier's output readable. Run by scripts/rehearse-identity-transform.sh.
-- =============================================================================

INSERT INTO users (id, email, display_name, provider_display_name, provider_profile_image_url, is_active, updated_at) VALUES
  ('00000000-0000-4000-8000-000000000001', 'admin.alpha@example.test',  NULL, 'Admin Alpha',  'https://img.example.test/a.jpg', true,  now()),
  ('00000000-0000-4000-8000-000000000002', 'contrib.beta@example.test', 'Beta C.', 'Contrib Beta', 'https://img.example.test/b.jpg', true,  now()),
  ('00000000-0000-4000-8000-000000000003', 'viewer.gamma@example.test', NULL, 'Viewer Gamma', NULL, true,  now()),
  ('00000000-0000-4000-8000-000000000004', 'norole.delta@example.test', NULL, 'No Role Delta', NULL, true,  now()),
  ('00000000-0000-4000-8000-000000000005', 'multi.epsilon@example.test', NULL, 'Multi Epsilon', NULL, true,  now()),
  ('00000000-0000-4000-8000-000000000006', 'off.zeta@example.test',     NULL, 'Disabled Zeta', NULL, false, now()),
  ('00000000-0000-4000-8000-000000000007', 'upload.eta@example.test',   NULL, 'Upload Eta',   NULL, true,  now()),
  ('00000000-0000-4000-8000-000000000008', 'person.theta@example.test', NULL, 'Person Theta', NULL, true,  now()),
  ('00000000-0000-4000-8000-000000000009', 'linked.iota@example.test',  NULL, 'Linked Iota',  'https://img.example.test/i.jpg', true,  now());

INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id FROM (VALUES
  ('00000000-0000-4000-8000-000000000001'::uuid, 'admin'),
  ('00000000-0000-4000-8000-000000000002'::uuid, 'contributor'),
  ('00000000-0000-4000-8000-000000000003'::uuid, 'viewer'),
  ('00000000-0000-4000-8000-000000000005'::uuid, 'admin'),
  ('00000000-0000-4000-8000-000000000005'::uuid, 'contributor'),
  ('00000000-0000-4000-8000-000000000006'::uuid, 'viewer'),
  ('00000000-0000-4000-8000-000000000007'::uuid, 'viewer'),
  ('00000000-0000-4000-8000-000000000008'::uuid, 'viewer'),
  ('00000000-0000-4000-8000-000000000009'::uuid, 'contributor')
) AS u(id, role) JOIN roles r ON r.name = u.role;

INSERT INTO user_identities (user_id, provider, provider_subject, provider_email)
SELECT id, 'google', 'sub-' || right(id::text, 3), email FROM users;

INSERT INTO user_settings (user_id, value, updated_at)
SELECT id, '{"theme":"system","profile":{"useProviderImage":true}}'::jsonb, now() FROM users WHERE email NOT LIKE 'norole%';
UPDATE user_settings SET value = value || '{"timezone":"America/Costa_Rica"}'::jsonb
WHERE user_id = '00000000-0000-4000-8000-000000000002';

-- Personal circles (the A5-era sign-up created one per user) and a person to link.
INSERT INTO circles (id, name, owner_id, is_personal, updated_at)
SELECT gen_random_uuid(), split_part(email, '@', 1) || '''s Library', id, true, now() FROM users;
INSERT INTO circle_members (circle_id, user_id, role)
SELECT c.id, c.owner_id, 'circle_admin' FROM circles c;

INSERT INTO people (id, circle_id, added_by_id, name, updated_at)
SELECT '10000000-0000-4000-8000-000000000001', c.id, u.id, 'Person A', now()
FROM users u JOIN circles c ON c.owner_id = u.id WHERE u.email = 'person.theta@example.test';

-- Profile-picture state (issue #354): upload, person-derived, and a link with the default source.
UPDATE users SET avatar_source = 'upload', avatar_storage_key = 'avatars/upload-eta.jpg', avatar_version = 'v1',
       profile_image_url = '/api/users/00000000-0000-4000-8000-000000000007/avatar?v=v1'
 WHERE id = '00000000-0000-4000-8000-000000000007';
UPDATE users SET avatar_source = 'person', avatar_storage_key = 'avatars/person-theta.jpg', avatar_version = 'v2',
       linked_person_id = '10000000-0000-4000-8000-000000000001',
       profile_image_url = '/api/users/00000000-0000-4000-8000-000000000008/avatar?v=v2'
 WHERE id = '00000000-0000-4000-8000-000000000008';
UPDATE users SET linked_person_id = '10000000-0000-4000-8000-000000000001'
 WHERE id = '00000000-0000-4000-8000-000000000009';

-- Sessions: one live, one revoked.
INSERT INTO refresh_tokens (user_id, token_hash, expires_at, revoked_at) VALUES
  ('00000000-0000-4000-8000-000000000002', 'hash-live-0001',    now() + interval '10 days', NULL),
  ('00000000-0000-4000-8000-000000000002', 'hash-revoked-0001', now() + interval '10 days', now());

-- PATs: a CLI token, and the token an Android pairing minted (linked to its device below).
INSERT INTO personal_access_tokens (id, user_id, name, token_hash, token_prefix, duration_value, duration_unit, expires_at) VALUES
  ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'MemoriaHub CLI', 'pat-hash-cli-0001', 'pat_cli0', 90, 'days', now() + interval '90 days'),
  ('20000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', 'Phone A', 'pat-hash-android-0001', 'pat_and0', 90, 'days', now() + interval '90 days');

INSERT INTO media_sync_devices (id, user_id, installation_id, name, config, pat_id, updated_at) VALUES
  ('30000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000001',
   'Phone A', '{}'::jsonb, '20000000-0000-4000-8000-000000000002', now());

-- Device codes: one pending with an Android returnUri, one approved by the CLI user.
INSERT INTO device_codes (device_code, user_code, user_id, status, client_info, scopes, expires_at, updated_at) VALUES
  ('dc-hash-pending-0001', 'ABCD1234', NULL, 'pending',
   '{"tokenType":"pat","name":"Phone A","returnUri":"memoriahub://pairing"}'::jsonb, '{}', now() + interval '10 minutes', now()),
  ('dc-hash-approved-0001', 'WXYZ5678', '00000000-0000-4000-8000-000000000002', 'approved',
   '{"tokenType":"pat","name":"MemoriaHub CLI"}'::jsonb, '{}', now() + interval '10 minutes', now());

-- Allowlist: one claimed, one pending.
INSERT INTO allowed_emails (email, added_by_id, claimed_by_id, claimed_at, notes) VALUES
  ('admin.alpha@example.test', NULL, '00000000-0000-4000-8000-000000000001', now(), 'Initial admin'),
  ('pending.kappa@example.test', '00000000-0000-4000-8000-000000000001', NULL, NULL, 'Invited');

-- A worker-node credential (stays confined to /api/nodes/*).
INSERT INTO mh_legacy_node_credentials (id, user_id, name, token_hash, token_prefix) VALUES
  ('50000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'node-1', 'nod-hash-0001', 'nod_node0');
