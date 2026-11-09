-- =============================================================================
-- Synthetic circle content for the RETRO-I2 ownership migration (#569)
-- =============================================================================
--
-- Creates `mh_i2_seed(per_circle int, with_vectors boolean)` on a database
-- migrated to the schema BEFORE `20261108200000_i2_circles_to_groups_ownership`
-- (circles decide everything, no ownership columns) and calls nothing: the
-- caller runs `SELECT mh_i2_seed(3, false)` (the db spec) or a large
-- `per_circle` (the timing rehearsal in docs/runbooks/circles-to-groups.md).
--
-- Invented data only: four users (person-a..d@example.test), each with a
-- personal circle, and three shared circles that cover the membership edge
-- cases of the group import:
--   Circle Alpha  owner A; A circle_admin, B collaborator, C viewer
--   Circle Beta   owner B; B collaborator only (no admin: B is promoted)
--   Circle Gamma  owner D, who is NOT a member; C viewer (D added as admin)
-- Every content table gets rows in every circle (media-derived tables one row
-- per media item, the rest a few per circle).
-- =============================================================================

CREATE OR REPLACE FUNCTION mh_i2_seed(per_circle int, with_vectors boolean) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  org uuid := (SELECT id FROM organizations WHERE is_default LIMIT 1);
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); uc uuid := gen_random_uuid(); ud uuid := gen_random_uuid();
  ca uuid := gen_random_uuid(); cb uuid := gen_random_uuid(); cg uuid := gen_random_uuid();
  c record;
  wf uuid;
BEGIN
  PERFORM set_config('app.rls_bypass', 'on', true);
  INSERT INTO users (id, email, updated_at) VALUES
    (ua, 'person-a-' || ua || '@example.test', now()), (ub, 'person-b-' || ub || '@example.test', now()),
    (uc, 'person-c-' || uc || '@example.test', now()), (ud, 'person-d-' || ud || '@example.test', now());
  INSERT INTO circles (id, name, owner_id, is_personal, updated_at)
    SELECT gen_random_uuid(), 'My library', u, true, now() FROM unnest(ARRAY[ua, ub, uc, ud]) u;
  INSERT INTO circle_members (circle_id, user_id, role, updated_at)
    SELECT id, owner_id, 'circle_admin', now() FROM circles WHERE is_personal AND owner_id IN (ua, ub, uc, ud);
  INSERT INTO circles (id, name, description, owner_id, is_personal, updated_at) VALUES
    (ca, 'Circle Alpha', 'Shared circle', ua, false, now()),
    (cb, 'Circle Beta', NULL, ub, false, now()),
    (cg, 'Circle Gamma', NULL, ud, false, now());
  INSERT INTO circle_members (circle_id, user_id, role, updated_at) VALUES
    (ca, ua, 'circle_admin', now()), (ca, ub, 'collaborator', now()), (ca, uc, 'viewer', now()),
    (cb, ub, 'collaborator', now()),
    (cg, uc, 'viewer', now());

  FOR c IN SELECT id, owner_id FROM circles WHERE owner_id IN (ua, ub, uc, ud) OR id IN (ca, cb, cg) LOOP
    INSERT INTO storage_objects (id, name, size, mime_type, storage_key, updated_at, org_id, status)
      SELECT gen_random_uuid(), 'photo-' || g || '.jpg', 1000, 'image/jpeg', 'seed/' || c.id || '/' || g, now(), org, 'ready'
      FROM generate_series(1, per_circle) g;
    INSERT INTO media_items (storage_object_id, added_by_id, updated_at, type, source, original_filename, circle_id, content_hash, captured_at)
      SELECT so.id, c.owner_id, now(), 'photo', 'web', so.name, c.id, md5(so.id::text), now() - (random() * interval '900 days')
      FROM storage_objects so WHERE so.storage_key LIKE 'seed/' || c.id || '/%';
    INSERT INTO albums (added_by_id, name, updated_at, circle_id) VALUES (c.owner_id, 'Album', now(), c.id);
    INSERT INTO tags (added_by_id, name, circle_id) VALUES (c.owner_id, 'Beach', c.id), (c.owner_id, 'Family', c.id);
    INSERT INTO people (circle_id, added_by_id, name, updated_at) VALUES (c.id, c.owner_id, 'Person X', now());
    INSERT INTO faces (media_item_id, circle_id, bounding_box, provider_key, model_version, embedding)
      SELECT mi.id, c.id, '{"x":0,"y":0,"w":1,"h":1}', 'compreface', 'v1',
             CASE WHEN with_vectors THEN (SELECT array_agg(random()) FROM generate_series(1, 128) WHERE mi.id IS NOT NULL) ELSE '{}'::double precision[] END
      FROM media_items mi WHERE mi.circle_id = c.id;
    INSERT INTO media_item_embedding (media_item_id, circle_id, embedding, model, updated_at)
      SELECT mi.id, c.id,
             (SELECT array_agg(CASE WHEN with_vectors THEN random() ELSE 0.001 END)::real[] FROM generate_series(1, 1536) WHERE mi.id IS NOT NULL)::vector,
             'seed', now()
      FROM media_items mi WHERE mi.circle_id = c.id;
    INSERT INTO media_visual_embedding (media_item_id, circle_id, embedding, model)
      SELECT mi.id, c.id,
             (SELECT array_agg(CASE WHEN with_vectors THEN random() ELSE 0.001 END)::real[] FROM generate_series(1, 512) WHERE mi.id IS NOT NULL)::vector,
             'seed'
      FROM media_items mi WHERE mi.circle_id = c.id;
    INSERT INTO media_geocode_status (id, media_item_id, circle_id, updated_at)
      SELECT gen_random_uuid(), mi.id, c.id, now() FROM media_items mi WHERE mi.circle_id = c.id;
    INSERT INTO media_metadata_status (id, media_item_id, circle_id, updated_at)
      SELECT gen_random_uuid(), mi.id, c.id, now() FROM media_items mi WHERE mi.circle_id = c.id;
    INSERT INTO media_tag_status (id, media_item_id, circle_id, updated_at)
      SELECT gen_random_uuid(), mi.id, c.id, now() FROM media_items mi WHERE mi.circle_id = c.id;
    INSERT INTO media_transcripts (id, media_item_id, circle_id, text, lead_seconds, updated_at)
      SELECT gen_random_uuid(), mi.id, c.id, 'Hello', 30, now() FROM media_items mi WHERE mi.circle_id = c.id LIMIT 3;
    INSERT INTO location_suggestions (media_item_id, circle_id, lat, lng, confidence, method)
      SELECT mi.id, c.id, 9.9, -84.1, 0.9, 'interpolated' FROM media_items mi WHERE mi.circle_id = c.id LIMIT 3;
    INSERT INTO media_enhancements (media_item_id, circle_id, provider, model)
      SELECT mi.id, c.id, 'openai', 'model-x' FROM media_items mi WHERE mi.circle_id = c.id LIMIT 2;
    INSERT INTO memories (id, circle_id, type, period_key, title, title_source, period_start, period_end, item_count, generated_at, refreshed_at, updated_at)
      VALUES (gen_random_uuid(), c.id, 'on_this_day', '2026-11-08', 'On this day', 'template', now(), now(), 1, now(), now(), now());
    INSERT INTO burst_groups (circle_id) VALUES (c.id);
    INSERT INTO duplicate_groups (circle_id) VALUES (c.id);
    INSERT INTO media_enhancement_batches (circle_id, requested_count) VALUES (c.id, 2);
    INSERT INTO review_runs (circle_id, subject_type, action, threshold) VALUES (c.id, 'burst_group', 'dismiss', 50);
    INSERT INTO trash_empty_runs (circle_id) VALUES (c.id);
    INSERT INTO workflows (circle_id, name, subject_type, trigger, definition)
      VALUES (c.id, 'Workflow', 'media_item', 'manual', '{"version":1}') RETURNING id INTO wf;
    INSERT INTO workflow_runs (workflow_id, circle_id, status, trigger_type, definition_snapshot)
      VALUES (wf, c.id, 'completed', 'manual', '{"version":1}');
  END LOOP;
END $$;
