const express = require('express');
const db = require('../db');
const { uuid, parseJSON, hasExpired } = require('../utils/helpers');
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
async function openSurvey(token) {
  if (!token || typeof token !== 'string' || token.length < 16) return null;

  const survey = await db.prepare(`
    SELECT * FROM surveys
    WHERE public_token = ? AND target_type = ? AND status = 'active'
  `).get(token, surveyForm.ANONYMOUS);

  if (!survey) return null;
  if (hasExpired(survey.expires_at)) return null;
  return survey;
}

const gone = async res => res.status(404).json({
  error: 'This survey is not open. The link may have expired, or it may have closed.'
});

// The response a key belongs to. Looked up by the hash, so the key itself is
// never stored — a copy of this database does not hand over the ability to
// alter anyone's answers.
async function responseFor(survey, key) {
  if (!key) return null;
  return await db.prepare(`
    SELECT * FROM survey_responses
    WHERE survey_id = ? AND anonymous_key_hash = ? AND respondent_kind = 'anonymous'
  `).get(survey.id, surveyForm.hashKey(key));
}

// GET /api/public/surveys/:token — what the link opens
router.get('/surveys/:token', opening, async (req, res) => {
  const survey = await openSurvey(req.params.token);
  if (!survey) return gone(res);

  // Resolved on the way out, exactly as it is for a member, so the page
  // answering it needs no idea that a circle exists — but they still see its
  // brand. Three layers, merged field by field: what the survey says wins,
  // over the workspace's own brand, over the look surveys start from, over
  // the product defaults.
  const circleRow = survey.circle_id ? await circles.byId(survey.circle_id) : null;
  const theme = surveyForm.resolveThemeFor(surveyForm.hydrate(survey).theme, circleRow);

  res.json({
    survey: {
      ...surveyForm.forPublic(survey),
      theme
    }
  });
});

// POST /api/public/surveys/:token/start
// Hands the tab a key for its eventual submission. Anonymous drafts live in
// that tab's sessionStorage, not in survey_responses; only a completed answer
// becomes a database row. Existing keys are still checked for completed and
// legacy in-progress responses.
router.post('/surveys/:token/start', writing, async (req, res) => {
  const survey = await openSurvey(req.params.token);
  if (!survey) return gone(res);

  const suppliedKey = typeof req.body?.response_key === 'string' && /^[A-Za-z0-9_-]{32}$/.test(req.body.response_key)
    ? req.body.response_key : null;
  const existing = await responseFor(survey, suppliedKey);
  if (existing) {
    if (existing.completed_at) {
      return res.status(409).json({ error: 'You have already answered this one. Thank you.' });
    }
    return res.json({
      survey: surveyForm.forPublic(survey),
      response_key: suppliedKey,
      answers: parseJSON(existing.answers, {})
    });
  }

  const key = suppliedKey || surveyForm.responseKey();

  // Deliberately no engagement event or response row at start: engagement is
  // a record of what a member has done, and anonymous progress remains local.

  res.json({
    survey: surveyForm.forPublic(survey),
    // Shown once. It is how this browser returns to this submission, and
    // there is no way to recover it — by design, since recovering it would
    // mean being able to identify the respondent.
    response_key: key,
    answers: {}
  });
});

// PATCH /api/public/surveys/:token/progress — legacy compatibility only.
// The current browser saves anonymous progress in sessionStorage and does not
// call this endpoint, so anonymous draft answers are never written here.
router.patch('/surveys/:token/progress', writing, async (req, res) => {
  const survey = await openSurvey(req.params.token);
  if (!survey) return gone(res);

  const response = await responseFor(survey, req.body?.response_key);
  if (response?.completed_at) return res.status(409).json({ error: 'Already completed' });

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

  // Do not persist anonymous progress. Keep the endpoint response compatible
  // with older clients while they continue to hold their draft locally.
  res.json({ saved: Object.keys(kept).length, browser_only: true });
});

// POST /api/public/surveys/:token/respond — submit
router.post('/surveys/:token/respond', writing, async (req, res) => {
  const survey = await openSurvey(req.params.token);
  if (!survey) return gone(res);

  const key = typeof req.body?.response_key === 'string' && /^[A-Za-z0-9_-]{32}$/.test(req.body.response_key)
    ? req.body.response_key : null;
  if (!key) return res.status(400).json({ error: 'A valid response key is required' });
  let response = await responseFor(survey, key);
  if (response?.completed_at) return res.status(409).json({ error: 'Already completed' });

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

  // Beside the answers, the questions they were shown — see the note on the
  // member's half of this in users.routes.js.
  if (response) {
    // Retain compatibility for respondents who started before anonymous drafts
    // moved to the browser; new submissions create their row only now.
    await db.prepare(`
      UPDATE survey_responses SET answers = ?, questions = ?, completed_at = datetime('now') WHERE id = ?
    `).run(JSON.stringify(checked.answers), JSON.stringify(questions), response.id);
  } else {
    response = { id: uuid() };
    try {
      await db.prepare(`
        INSERT INTO survey_responses
          (id, survey_id, user_id, answers, questions, completed_at, triggered_by, respondent_kind, anonymous_key_hash)
        VALUES (?, ?, NULL, ?, ?, datetime('now'), 'link', 'anonymous', ?)
      `).run(response.id, survey.id, JSON.stringify(checked.answers), JSON.stringify(questions), surveyForm.hashKey(key));
    } catch (err) {
      // A repeated final request is idempotently refused once its first write
      // has completed, including two submissions racing on the same key.
      const alreadySubmitted = await responseFor(survey, key);
      if (alreadySubmitted?.completed_at) return res.status(409).json({ error: 'Already completed' });
      throw err;
    }
  }

  // The survey may have branched to its end before it was over — a consent
  // question answered "no" ends it there — and the ending the author wrote
  // for that is what the end of the link should carry, not a thank-you that
  // assumes the whole survey was walked.
  const ending = surveyForm.ending(questions, checked.answers);

  // Written answers are filed as feedback the same way a member's are. The
  // alternative — dropping them because there is no account to file them
  // against — would lose exactly the words this whole feature exists to
  // collect.
  const { filed } = await verbatims.record(null, survey, checked.answers, { responseId: response.id });

  res.json({
    message: 'Survey completed',
    answered: checked.asked.length,
    discarded: checked.dropped.length,
    verbatims: filed,
    ended: !!ending,
    end_message: ending ? ending.message : null
  });
});

module.exports = router;
