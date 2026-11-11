-- Participant segments are computed from the distinct products a member uses:
-- 0 = General / App, 1 = Single Product, 2 = Multi-Product, 3+ = Power Tester.
-- The trigger is the final guard so no client/import/admin field can override it.
CREATE OR REPLACE FUNCTION public.derive_participant_segment()
RETURNS trigger
LANGUAGE plpgsql
AS $participant_segment$
DECLARE
  product_count INTEGER;
BEGIN
  BEGIN
    SELECT COUNT(DISTINCT product) INTO product_count
    FROM jsonb_array_elements_text(
      CASE WHEN COALESCE(NEW.products, '') ~ '^\s*\['
        THEN NEW.products::jsonb ELSE '[]'::jsonb END
    ) AS p(product);
  EXCEPTION WHEN OTHERS THEN
    product_count := 0;
  END;

  NEW.segment := CASE
    WHEN product_count = 0 THEN 'General / App'
    WHEN product_count = 1 THEN 'Single Product'
    WHEN product_count = 2 THEN 'Multi-Product'
    ELSE 'Power Tester'
  END;
  RETURN NEW;
END;
$participant_segment$;

DROP TRIGGER IF EXISTS users_derive_participant_segment ON public.users;
CREATE TRIGGER users_derive_participant_segment
  BEFORE INSERT OR UPDATE OF products, segment ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.derive_participant_segment();
REVOKE ALL ON FUNCTION public.derive_participant_segment() FROM PUBLIC, anon, authenticated;

-- Recompute existing rows through the same trigger used for future writes.
UPDATE public.users SET products = products;
