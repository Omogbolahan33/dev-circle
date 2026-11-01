-- No public PostgREST RPCs are part of the server-only application access
-- model. PostgreSQL grants EXECUTE on new functions to PUBLIC by default; a
-- schema-scoped REVOKE cannot cancel that global default, so revoke it globally
-- for the application's function-creator roles, plus client-role grants in
-- public. Trusted server roles remain available to receive explicit grants.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;

DO $function_defaults$
BEGIN
  IF pg_has_role(current_user, 'supabase_admin', 'MEMBER') THEN
    ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin
      REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
    ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
      REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
  ELSE
    RAISE NOTICE 'Skipped function default hardening for supabase_admin: current role is not a member';
  END IF;
END
$function_defaults$;
