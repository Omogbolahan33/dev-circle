-- Dev Circle uses its trusted server-side PostgreSQL connection for table
-- access; browser clients use the application API and Supabase Storage only.
-- There are intentionally no anon/authenticated policies: direct PostgREST
-- access to public tables is not part of the product's access model. The
-- privileged table-owner connection used by the server retains access.
DO $rls$
DECLARE target record;
BEGIN
  FOR target IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', target.schemaname, target.tablename);
  END LOOP;
END
$rls$;
