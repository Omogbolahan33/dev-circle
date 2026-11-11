-- Remove non-unique indexes that duplicate unique constraints or are covered
-- by an existing left-prefix index. Keep the unique indexes/constraints: they
-- enforce public-token and respondent integrity. The anonymous response lookup
-- always filters by survey_id and anonymous_key_hash, which the composite
-- unique index supports.
DROP INDEX IF EXISTS public.idx_users_email;
DROP INDEX IF EXISTS public.idx_circles_slug;
DROP INDEX IF EXISTS public.idx_surveys_public_token;
DROP INDEX IF EXISTS public.idx_survey_responses_survey;
DROP INDEX IF EXISTS public.idx_survey_responses_anon;
DROP INDEX IF EXISTS public.idx_engagement_user;
DROP INDEX IF EXISTS public.idx_user_gifts_user;
DROP INDEX IF EXISTS public.idx_email_templates_circle;
DROP INDEX IF EXISTS public.idx_onboarding_forms_token;
