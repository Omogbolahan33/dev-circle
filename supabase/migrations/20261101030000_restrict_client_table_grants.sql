-- The application's table access is server-only. RLS without policies blocks
-- row access, but RLS does not govern TRUNCATE; revoke client-role table and
-- sequence privileges as a second boundary. Keep service_role and postgres
-- untouched for trusted server-side operations.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE CREATE ON SCHEMA public FROM anon, authenticated;

-- Remove any explicit column grants left after the table-level revocation.
DO $revoke_columns$
DECLARE grant_row record;
BEGIN
  FOR grant_row IN
    SELECT DISTINCT table_schema, table_name, column_name, grantee
    FROM information_schema.column_privileges
    WHERE table_schema = 'public'
      AND grantee IN ('anon', 'authenticated')
  LOOP
    EXECUTE format(
      'REVOKE SELECT (%1$I), INSERT (%1$I), UPDATE (%1$I), REFERENCES (%1$I) ON TABLE %2$I.%3$I FROM %4$I',
      grant_row.column_name, grant_row.table_schema, grant_row.table_name, grant_row.grantee
    );
  END LOOP;
END
$revoke_columns$;

-- Avoid reintroducing API-role table/sequence grants on objects created later.
-- Postgres is the application's migration/table-owner role. Restrict the
-- supabase_admin defaults too when the migration role is authorized to alter
-- them; otherwise leave them unchanged and report a notice for an operator.
DO $default_privileges$
DECLARE target_role name;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['postgres'::name, 'supabase_admin'::name]
  LOOP
    IF target_role = current_user OR pg_has_role(current_user, target_role, 'MEMBER') THEN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated',
        target_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated',
        target_role
      );
    ELSE
      RAISE NOTICE 'Skipped default privilege hardening for role %: current role is not a member', target_role;
    END IF;
  END LOOP;
END
$default_privileges$;
