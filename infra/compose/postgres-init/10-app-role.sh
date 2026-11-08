#!/bin/sh
# =============================================================================
# Creates the ORDINARY role MemoriaHub's API will connect as (RETRO-A5, #587)
# =============================================================================
#
# Row-level security (platform migration 0025) is inert for a superuser or a
# BYPASSRLS role: every policy, FORCE included, is skipped. The bootstrap login
# (`postgres` / POSTGRES_USER) is a superuser, so it must stay for
# administration only and the API must run as an ordinary role that OWNS the
# tables (FORCE ROW LEVEL SECURITY is what applies the policies to an owner).
#
# This script is idempotent and works two ways:
#   * as /docker-entrypoint-initdb.d/10-app-role.sh on the first start of an
#     EMPTY data volume (the tables do not exist yet; the ALTER OWNER loop is a
#     no-op and the migrations later run as this role);
#   * by hand on an EXISTING database, as the bootstrap superuser:
#         APP_DB_PASSWORD=... POSTGRES_DB=memoriahub PGHOST=... \
#           sh infra/compose/postgres-init/10-app-role.sh
#     which transfers ownership of every table, sequence, type and function in
#     schema public (and the schema and database) to the role.
#
# It does NOT switch the API to the role. The API keeps connecting as the
# bootstrap superuser until RETRO-D1 brings tenant-scoped storage access
# (docs/runbooks/application-role.md, "When to switch").
#
# Environment:
#   APP_DB_USER      role name (default memoriahub_app)
#   APP_DB_PASSWORD  required
#   POSTGRES_DB      database (default memoriahub)
#   PGUSER           bootstrap superuser (default postgres); PGHOST/PGPORT/PGPASSWORD as usual
# =============================================================================
set -eu

APP_DB_USER="${APP_DB_USER:-memoriahub_app}"
APP_DB_NAME="${POSTGRES_DB:-memoriahub}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"
export PGUSER="${PGUSER:-postgres}"

if [ "${APP_DB_USER}" = "postgres" ]; then
  echo "application role: APP_DB_USER is 'postgres'; nothing to do (row-level security stays inert)"
  exit 0
fi

# Extensions are created by the bootstrap superuser: the migrations need them
# (uuid-ossp, vector for embeddings, pg_trgm for text search) and a non-superuser cannot
# create an untrusted extension.
psql -v ON_ERROR_STOP=1 --dbname "${APP_DB_NAME}" <<'SQL'
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SQL

psql -v ON_ERROR_STOP=1 --dbname "${APP_DB_NAME}" \
  -v app_user="${APP_DB_USER}" -v app_password="${APP_DB_PASSWORD}" -v app_db="${APP_DB_NAME}" <<'SQL'
SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_user') AS role_exists \gset
\if :role_exists
  ALTER ROLE :"app_user" LOGIN PASSWORD :'app_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
\else
  CREATE ROLE :"app_user" LOGIN PASSWORD :'app_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
\endif

ALTER DATABASE :"app_db" OWNER TO :"app_user";
ALTER SCHEMA public OWNER TO :"app_user";
GRANT ALL ON SCHEMA public TO :"app_user";

-- psql does not interpolate :'var' inside a dollar-quoted body, so pass the name through a GUC.
SELECT set_config('memoriahub.app_role', :'app_user', false);

-- Own every relation, enum/composite type and function the migrations created.
-- (REASSIGN OWNED BY postgres is refused: the role owns pinned system objects.)
DO $$
DECLARE
  r record;
  app_role text := current_setting('memoriahub.app_role');
BEGIN
  FOR r IN
    SELECT format('ALTER %s %I.%I OWNER TO %I',
                  CASE c.relkind WHEN 'r' THEN 'TABLE' WHEN 'p' THEN 'TABLE' WHEN 'v' THEN 'VIEW'
                                 WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' END,
                  n.nspname, c.relname, app_role) AS stmt
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'a' AND d.refclassid = 'pg_class'::regclass AND c.relkind = 'S')
  LOOP
    EXECUTE r.stmt;
  END LOOP;

  FOR r IN
    SELECT format('ALTER TYPE %I.%I OWNER TO %I', n.nspname, t.typname, app_role) AS stmt
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype IN ('e', 'c', 'd')
      AND (t.typtype <> 'c' OR EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c'))
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')
  LOOP
    EXECUTE r.stmt;
  END LOOP;

  FOR r IN
    SELECT format('ALTER %s %I.%I(%s) OWNER TO %I',
                  CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
                  n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), app_role) AS stmt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE r.stmt;
  END LOOP;
END
$$;
SQL

echo "application role: ${APP_DB_USER} (NOSUPERUSER NOBYPASSRLS) owns ${APP_DB_NAME}; the API still connects as ${PGUSER} until RETRO-D1"
