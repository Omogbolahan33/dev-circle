const express = require('express');
const db = require('../db');
const { uuid, parseJSON } = require('../utils/helpers');
const { rateLimit } = require('../middleware/rateLimit');
const onboarding = require('../services/onboarding');
const surveyForm = require('../services/surveyForm');
const circles = require('../services/circles');

const router = express.Router();

// ─── Filling in an onboarding form ──────────────────────────
// The only routes in this platform that an unauthenticated stranger can reach
// on a page we do not own. Everything about them is narrower than usual, and
// for reasons worth stating rather than assuming:
//
//   · The token is the whole of the authorisation, and it opens exactly one
//     form. No endpoint here takes a form id.
//   · Nothing here writes to users, circle_members or consent. A submission is
//     an application; it becomes a member only when an administrator approves
//     it from the admin API. That is what makes a publicly embeddable form
//     safe to publish at all — the worst an abusive caller achieves is a queue
//     that needs clearing, not accounts.
//   · A caller sees what somebody filling in a form needs and nothing about
//     which circle it feeds, which cohorts it joins them to, or how many have
//     applied. forPublic() is an allowlist, so a column added later is private
//     by default.
//   · Everything is limited by address, because there is no account to limit
//     by, and tighter on submitting than on reading.

const opening = rateLimit({ name: 'onboarding-open', windowMs: 60_000, max: 30 });
const filling = rateLimit({ name: 'onboarding-fill', windowMs: 60_000, max: 60 });
// Submitting is the expensive one — it is what puts a row in front of a human —
// so it is counted over an hour rather than a minute.
//
// The ceiling is not as low as it could be, deliberately. This limit is by
// address, and the case this whole feature exists for is a form on a stand at
// an event or on a partner's intranet: dozens of real people behind one NAT,
// filling it in within the same hour. A limit tuned for one person per address
// would turn the launch it was built for into a wall of 429s. What makes that
// affordable is that nothing here creates an account — the worst an abusive
// caller achieves at this rate is a queue somebody has to clear.
const submitting = rateLimit({ name: 'onboarding-submit', windowMs: 3_600_000, max: 30 });

const gone = res => res.status(404).json({
  error: 'This form is not open. The link may have been closed, or it may never have existed.'
});

// The application a session key owns. Looked up by hash, so the key itself is
// never stored — a copy of this database does not hand over the ability to
// alter what somebody submitted.
async function submissionFor(form, key) {
  if (!key) return null;
  return await db.prepare(
    'SELECT * FROM onboarding_submissions WHERE form_id = ? AND session_key_hash = ?'
  ).get(form.id, onboarding.hashKey(key));
}

// Which page this was filled in on. Worth recording because an embed can be
// placed anywhere its form allows, and a placement that quietly stopped
// working is invisible otherwise.
//
// It cannot be read from the request headers: the form runs inside an iframe
// served from this origin, so every call it makes is same-origin and the
// Origin and Referer both name us rather than the host page. The runner sends
// the address its embed reported instead — and because that is a string from
// a page we do not control, it is recorded only when it names an origin this
// form actually allows to frame it. Anything else is stored as nothing, which
// is also what an application filled in at the form's own link looks like.
function placement(req, form) {
  const claimed = String(req.body?.embedded_on || '').slice(0, 500);
  if (!claimed) return { origin: null, page: null };

  try {
    const url = new URL(claimed);
    if (!onboarding.originAllowed(form, url.origin)) return { origin: null, page: null };
    return { origin: url.origin, page: `${url.origin}${url.pathname}`.slice(0, 500) };
  } catch {
    return { origin: null, page: null };
  }
}

// GET /api/onboarding/:token — what the form asks
router.get('/:token', opening, async (req, res) => {
  const form = await onboarding.byToken(req.params.token);
  if (!form) return gone(res);

  res.json({
    form: {
      ...onboarding.forPublic(form),
      // Resolved on the way out, exactly as a survey's is, so the page filling
      // it in needs no idea that a circle exists or that it carries a default.
      theme: surveyForm.themes.resolve(
        onboarding.hydrate(form).theme,
        parseJSON((await circles.byId(form.circle_id))?.survey_theme, null)
      )
    }
  });
});

// POST /api/onboarding/:token/start
// Begins an application and hands back the key that owns it. A caller holding
// a key gets their answers back instead of a second blank application, so a
// refreshed tab is not a second applicant.
router.post('/:token/start', filling, async (req, res) => {
  const form = await onboarding.byToken(req.params.token);
  if (!form) return gone(res);

  const existing = await submissionFor(form, req.body?.session_key);
  if (existing) {
    if (existing.status !== 'started') {
      return res.status(409).json({
        error: 'You have already sent this in. We will be in touch.',
        status: existing.status
      });
    }
    return res.json({
      form: onboarding.forPublic(form),
      session_key: req.body.session_key,
      answers: parseJSON(existing.answers, {})
    });
  }

  const key = onboarding.sessionKey();
  const where = placement(req, form);

  await db.prepare(`
    INSERT INTO onboarding_submissions (id, form_id, circle_id, session_key_hash, source_origin, source_page)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uuid(), form.id, form.circle_id, onboarding.hashKey(key), where.origin, where.page);

  res.json({
    form: onboarding.forPublic(form),
    // Shown once. It is how this browser returns to this half-finished form,
    // and there is no way to recover it.
    session_key: key,
    answers: {}
  });
});

// PATCH /api/onboarding/:token/progress — keep what has been filled in
// A form long enough to need branching is long enough to be abandoned halfway
// on a phone, and starting again is how it stays abandoned.
router.patch('/:token/progress', filling, async (req, res) => {
  const form = await onboarding.byToken(req.params.token);
  if (!form) return gone(res);

  const submission = await submissionFor(form, req.body?.session_key);
  if (!submission) return res.status(404).json({ error: 'Start the form first' });
  if (submission.status !== 'started') return res.status(409).json({ error: 'Already sent in' });

  const { answers } = req.body;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return res.status(400).json({ error: 'answers object required' });
  }

  const known = new Set(onboarding.hydrate(form).questions.map(q => q.id));
  const kept = Object.fromEntries(Object.entries(answers).filter(([id]) => known.has(id)));

  const serialized = JSON.stringify(kept);
  if (serialized.length > 100_000) {
    return res.status(413).json({ error: 'That is more than a form in progress can hold' });
  }

  await db.prepare('UPDATE onboarding_submissions SET answers = ? WHERE id = ?').run(serialized, submission.id);
  res.json({ saved: Object.keys(kept).length });
});

// POST /api/onboarding/:token/submit — send it in
router.post('/:token/submit', submitting, async (req, res) => {
  const form = await onboarding.byToken(req.params.token);
  if (!form) return gone(res);

  const submission = await submissionFor(form, req.body?.session_key);
  if (!submission) return res.status(404).json({ error: 'Start the form first' });
  if (submission.status !== 'started') {
    return res.status(409).json({ error: 'You have already sent this in. We will be in touch.' });
  }

  const { answers } = req.body;
  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({ error: 'answers object required' });
  }

  const questions = onboarding.hydrate(form).questions;
  const unknown = Object.keys(answers).filter(id => !questions.some(q => q.id === id));
  if (unknown.length) {
    return res.status(400).json({ error: 'Unknown question in answers', questions: unknown });
  }

  // The same definition and the same refusals the builder's preview applied.
  // Nothing arriving here is trusted: branching decides which questions were
  // really asked, and an answer to a question this applicant never saw is
  // dropped rather than stored.
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

  // Resolved now, against the questions as they are now — see resolveProfile
  // for why this cannot wait until somebody reviews it.
  const { profile, consent } = onboarding.resolveProfile(questions, checked.answers);

  if (!profile.email) {
    return res.status(400).json({ error: 'We need an email address we can reach you on' });
  }
  if (!profile.name) {
    return res.status(400).json({ error: 'We need a name to put to this' });
  }

  // What a second application from one address means is the form's decision,
  // because it depends on where it has been posted. A form on one partner's
  // page wants the newer answers; an open call wants to know somebody applied
  // twice.
  const prior = await db.prepare(`
    SELECT id, status FROM onboarding_submissions
    WHERE form_id = ? AND email = ? AND status IN ('pending','approved') AND id != ?
    ORDER BY submitted_at DESC
  `).all(form.id, profile.email, submission.id);

  if (prior.length) {
    const policy = form.duplicate_policy || 'replace';

    if (policy === 'reject' || prior.some(p => p.status === 'approved')) {
      await db.prepare("UPDATE onboarding_submissions SET status = 'withdrawn' WHERE id = ?").run(submission.id);
      return res.status(409).json({
        error: prior.some(p => p.status === 'approved')
          ? 'That address is already a member here.'
          : 'We already have an application from that address.'
      });
    }

    if (policy === 'replace') {
      // The earlier one is withdrawn rather than deleted: somebody may already
      // be part-way through reviewing it, and a row that vanishes under them
      // is worse than one marked as superseded.
      const withdraw = db.prepare(
        "UPDATE onboarding_submissions SET status = 'withdrawn' WHERE id = ? AND status = 'pending'"
      );
      for (const earlier of prior) await withdraw.run(earlier.id);
    }
  }

  await db.prepare(`
    UPDATE onboarding_submissions
    SET answers = ?, profile = ?, consent_channels = ?, email = ?, name = ?,
        status = 'pending', submitted_at = datetime('now')
    WHERE id = ?
  `).run(
    JSON.stringify(checked.answers),
    JSON.stringify(profile),
    JSON.stringify(consent),
    profile.email,
    profile.name,
    submission.id
  );

  res.json({
    message: 'Application received',
    answered: checked.asked.length,
    // What to do with the page now. Held on the form rather than decided here
    // so the runner and a host page embedding it agree on what "done" looks
    // like.
    submitted_message: form.submitted_message || null,
    redirect_url: form.redirect_url || null
  });
});

module.exports = router;
