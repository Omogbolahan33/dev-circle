-- Cover foreign-key lookups identified by the Supabase database linter.
-- The session_dispatches table constraint already owns an equivalent unique
-- index, so the separately named duplicate can be removed safely.
CREATE INDEX IF NOT EXISTS idx_circle_admins_role
  ON public.circle_admins(role_id);
CREATE INDEX IF NOT EXISTS idx_email_templates_updated_by
  ON public.email_templates(updated_by);
CREATE INDEX IF NOT EXISTS idx_feedback_survey
  ON public.feedback(survey_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_submissions_decided_by
  ON public.onboarding_submissions(decided_by);
CREATE INDEX IF NOT EXISTS idx_onboarding_submissions_user
  ON public.onboarding_submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_option_lists_updated_by
  ON public.option_lists(updated_by);
CREATE INDEX IF NOT EXISTS idx_scheduled_sessions_survey
  ON public.scheduled_sessions(survey_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_sessions_circle
  ON public.scheduled_sessions(circle_id);
DROP INDEX IF EXISTS public.idx_session_dispatch_once;
