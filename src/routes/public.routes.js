const express = require('express');
const db = require('../db');
const { uuid, parseJSON } = require('../utils/helpers');
const { rateLimit } = require('../middleware/rateLimit');
const surveyForm = require('../services/surveyForm');
const verbatims = require('../services/verbatims');
const circles = require('../services/circles');

const router = express.Router();

// ─── Answering without an account ───────────────────────────
// A survey can be addressed to whoever holds its link. That is the only way to
// ask the people you most need to hear from — developers who bounced off the
// sandbox before they ever registered, a room at a meetup, a partner's own
// users — and it is also the only part of this API that a stranger can reach.
//
// So the rules here are narrower than anywhere else:
//
//   · The token is the whole of the authorisation, and it only ever opens one
//     survey. There is no endpoint here that takes a survey id.
//   · A caller sees what a respondent needs and nothing about how the survey
//     is run — no targeting, no circle, no counts. That is enforced by
//     forPublic() listing what to include, so a column added later is private
//     by default rather than newly published.
//   · Everything is rate limited by address, because there is no account to
//     limit by.
//   · Nothing here identifies the person. No account is created, and the
//     response carries no name — which is the promise the word "anonymous"
//     makes to whoever answers.

// Enough for a person filling in a form, and nowhere near enough to enumerate
// tokens or flood a survey with submissions.
const opening = rateLimit({ name: 'public-survey', windowMs: 60_000, max: 30 });
const writing = rateLimit({ name: 'public-answer', windowMs: 60_000, max: 60 });

// The survey behind a link, or nothing. Every reason for "nothing" answers the
// same way: a token that never existed, one whose survey has been closed, and
// one that has expired are indistinguishable from outside, so the endpoint
// cannot be used to learn which tokens are real.
function openSurvey(token) {
  if (!token || typeof token !== 'string' || token.length < 16) return null;

  const survey = db.prepare(`
    SELECT * FROM surveys
    WHERE public_token = ? AND target_type = ? AND status = 'active'
  `).get(token, surveyForm.ANONYMOUS);

  if (!survey) return null;
  if (survey.expires_at && new Date(survey.expires_at.replace(' ', 'T')) < new Date()) return null;
  return survey;
}

const gone = res => res.status(404).json({
  error: 'This survey is not open. The link may have expired, or it may have closed.'
});

// The response a key belongs to. Looked up by the hash, so the key itself is
// never stored — a copy of this database does not hand over the ability to
// alter anyone's answers.
function responseFor(survey, key) {
  if (!key) return null;
  return db.prepare(`
    SELECT * FROM survey_responses
    WHERE survey_id = ? AND anonymous_key_hash = ? AND respondent_kind = 'anonymous'
  `).get(survey.id, surveyForm.hashKey(key));
}

// GET /api/public/surveys/:token — what the link opens
router.get('/surveys/:token', opening, (req, res) => {
  const survey = openSurvey(req.params.token);
  if (!survey) return gone(res);

  res.json({
    survey: {
      ...surveyForm.forPublic(survey),
      // Resolved on the way out, exactly as it is for a member, so the page
      // answering it needs no idea that a circle exists
      theme: surveyForm.themes.resolve(
        surveyForm.hydrate(survey).theme,
        parseJSON(circles.byId(survey.circle_id)?.survey_theme, null)
      )
    }
  });
});

// POST /api/public/surveys/:token/start
// Begins a submission and hands back the key that owns it. A caller that
// already holds a key gets its answers back instead of a second blank
// submission, so a refreshed tab is not a new respondent.
router.post('/surveys/:token/start', writing, (req, res) => {
  const survey = openSurvey(req.params.token);
  if (!survey) return gone(res);

  const existing = responseFor(survey, req.body?.response_key);
  if (existing) {
    if (existing.completed_at) {
      return res.status(409).json({ error: 'You have already answered this one. Thank you.' });
    }
    return res.json({
      survey: surveyForm.forPublic(survey),
      response_key: req.body.response_key,
      answers: parseJSON(existing.answers, {})
    });
  }

  const key = surveyForm.responseKey();
  db.prepare(`
    INSERT INTO survey_responses (id, survey_id, user_id, respondent_kind, anonymous_key_hash, triggered_by)
    VALUES (?, ?, NULL, 'anonymous', ?, 'link')
  `).run(uuid(), survey.id, surveyForm.hashKey(key));

  // Deliberately no engagement event: engagement is a record of what a member
  // has done, and there is no member here. Writing one would either need an
  // account invented for the occasion or a row pointing at nobody.

  res.json({
    survey: surveyForm.forPublic(survey),
    // Shown once. It is how this browser returns to this submission, and
    // there is no way to recover it — by design, since recovering it would
    // mean being able to identify the respondent.
    response_key: key,
    answers: {}
  });
});

// PATCH /api/public/surveys/:token/progress — keep what has been answered
router.patch('/surveys/:token/progress', writing, (req, res) => {
  const survey = openSurvey(req.params.token);
  if (!survey) return gone(res);

  const response = responseFor(survey, req.body?.response_key);
  if (!response) return res.status(404).json({ error: 'Start the survey first' });
  if (response.completed_at) return res.status(409).json({ error: 'Already completed' });

  const { answers } = req.body;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return res.status(400).json({ error: 'answers object required' });
  }

  const questionIds = new Set(surveyForm.hydrate(survey).questions.map(q => q.id));
  const kept = Object.fromEntries(Object.entries(answers).filter(([id]) => questionIds.has(id)));

  // The same ceiling the member's endpoint has, and for a stronger reason:
  // this one takes unvalidated answers from an unauthenticated caller.
  const serialized = JSON.stringify(kept);
  if (serialized.length > 100_000) {
    return res.status(413).json({ error: 'That is more than a survey in progress can hold' });
  }

  db.prepare('UPDATE survey_responses SET answers = ? WHERE id = ?').run(serialized, response.id);
  res.json({ saved: Object.keys(kept).length });
});

// POST /api/public/surveys/:token/respond — submit
router.post('/surveys/:token/respond', writing, (req, res) => {
  const survey = openSurvey(req.params.token);
  if (!survey) return gone(res);

  const response = responseFor(survey, req.body?.response_key);
  if (!response) return res.status(404).json({ error: 'Start the survey first' });
  if (response.completed_at) return res.status(409).json({ error: 'Already completed' });

  const { answers } = req.body;
  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({ error: 'answers object required' });
  }

  const questions = surveyForm.hydrate(survey).questions;
  const unknown = Object.keys(answers).filter(id => !questions.some(q => q.id === id));
  if (unknown.length) {
    return res.status(400).json({ error: 'Unknown question in answers', questions: unknown });
  }

  // The same definition, the same checks, the same refusals a member gets.
  // An answer arriving without an account is not an answer held to a lower
  // standard — if anything the opposite, since nothing else vouches for it.
  const checked = surveyForm.checkResponse(questions, answers);
  if (!checked.ok) {
    return res.status(400).json({
      error: checked.missing.length
        ? 'Some required questions have not been answered'
        : 'Some answers could not be accepted',
      errors: checked.errors,
      missing: checked.missing
    });
  }

  db.prepare(`
    UPDATE survey_responses SET answers = ?, completed_at = datetime('now') WHERE id = ?
  `).run(JSON.stringify(checked.answers), response.id);

  // Written answers are filed as feedback the same way a member's are. The
  // alternative — dropping them because there is no account to file them
  // against — would lose exactly the words this whole feature exists to
  // collect.
  const { filed } = verbatims.record(null, survey, checked.answers, { responseId: response.id });

  res.json({
    message: 'Survey completed',
    answered: checked.asked.length,
    discarded: checked.dropped.length,
    verbatims: filed
  });
});

module.exports = router;
