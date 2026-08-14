const express = require('express');
const db = require('../db');
const { uuid, parseJSON, sanitizeUser } = require('../utils/helpers');
const { requireAuth } = require('../middleware/auth');
const engagement = require('../services/engagement');
const notifications = require('../services/notifications');
const circles = require('../services/circles');
const scheduler = require('../services/scheduler');

const router = express.Router();

// ─── Profile ────────────────────────────────────────────────

// GET /api/users/profile
router.get('/profile', requireAuth, (req, res) => {
  // Roll back a streak the member has let lapse before reporting it
  engagement.decayStale(req.user.id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const cohorts = db.prepare(`
    SELECT c.* FROM cohorts c
    JOIN user_cohorts uc ON uc.cohort_id = c.id
    WHERE uc.user_id = ?
  `).all(req.user.id);

  const consent = db.prepare('SELECT * FROM consent WHERE user_id = ?').all(req.user.id);

  const stats = {
    surveys_completed: db.prepare("SELECT COUNT(*) as c FROM survey_responses WHERE user_id = ? AND completed_at IS NOT NULL").get(req.user.id).c,
    surveys_invited: db.prepare('SELECT COUNT(*) as c FROM survey_responses WHERE user_id = ?').get(req.user.id).c,
    gifts_claimed: db.prepare('SELECT COUNT(*) as c FROM user_gifts WHERE user_id = ?').get(req.user.id).c,
    feedback_submitted: db.prepare('SELECT COUNT(*) as c FROM feedback WHERE user_id = ?').get(req.user.id).c,
    streak: user.engagement_streak,
    best_streak: user.best_streak
  };

  res.json({
    user: sanitizeUser(user),
    cohorts,
    circles: circles.forUser(req.user.id),
    consent,
    stats,
    unread_notifications: notifications.inbox(req.user.id, { limit: 1 }).unread_count
  });
});

// ─── Circles ────────────────────────────────────────────────

// GET /api/users/circles — the circles this member belongs to
router.get('/circles', requireAuth, (req, res) => {
  res.json({ circles: circles.forUser(req.user.id) });
});

// ─── Scheduled sessions ─────────────────────────────────────

// GET /api/users/sessions — upcoming engagements for this member
router.get('/sessions', requireAuth, (req, res) => {
  const circleIds = circles.circleIdsForUser(req.user.id);
  const cohortIds = db.prepare('SELECT cohort_id FROM user_cohorts WHERE user_id = ?')
    .all(req.user.id).map(r => r.cohort_id);

  const sessions = db.prepare(`
    SELECT s.*, c.name as circle_name, sv.title as survey_title
    FROM scheduled_sessions s
    LEFT JOIN circles c ON c.id = s.circle_id
    LEFT JOIN surveys sv ON sv.id = s.survey_id
    WHERE s.status IN ('scheduled','announced')
      AND s.scheduled_for > datetime('now', '-1 hour')
    ORDER BY s.scheduled_for ASC
  `).all();

  // Mirror the same targeting the dispatcher uses, so what a member sees here
  // matches what they will actually be invited to.
  const mine = sessions.filter(s => {
    if (s.circle_id && !circleIds.includes(s.circle_id)) return false;
    const targets = parseJSON(s.target_ids, []) || [];
    if (s.target_type === 'cohort') return targets.some(t => cohortIds.includes(t));
    if (s.target_type === 'specific') return targets.includes(req.user.id);
    if (s.target_type === 'circle') return targets.length ? targets.some(t => circleIds.includes(t)) : true;
    return true;
  });

  res.json({
    sessions: mine.map(s => {
      const when = scheduler.parseWhen(s.scheduled_for);
      const slot = when ? scheduler.availability(req.user, when) : { available: true, reason: null };
      return {
        id: s.id,
        title: s.title,
        description: s.description,
        type: s.type,
        scheduled_for: s.scheduled_for,
        duration_min: s.duration_min,
        location: s.location,
        circle_name: s.circle_name,
        survey_id: s.survey_id,
        survey_title: s.survey_title,
        // Flagged against the member's own stated availability so a clash is
        // visible to them, not just to the admin who scheduled it
        clashes_with_availability: !slot.available,
        clash_reason: slot.reason
      };
    })
  });
});

// PUT /api/users/profile
router.put('/profile', requireAuth, (req, res) => {
  const {
    name, phone, company, work_sector,
    preferred_channels, preferred_days, preferred_time_start, preferred_time_end,
    date_of_birth, gender, location_state, api_products
  } = req.body;

  const updates = [];
  const params = [];

  const setText = (column, value) => {
    if (value !== undefined) { updates.push(`${column} = ?`); params.push(value); }
  };
  const setJson = (column, value) => {
    if (value !== undefined) {
      if (!Array.isArray(value)) throw new TypeError(`${column} must be an array`);
      updates.push(`${column} = ?`);
      params.push(JSON.stringify(value));
    }
  };

  try {
    setText('name', name);
    setText('phone', phone);
    setText('company', company);
    setText('work_sector', work_sector);
    setText('preferred_time_start', preferred_time_start);
    setText('preferred_time_end', preferred_time_end);
    setText('date_of_birth', date_of_birth);
    setText('gender', gender);
    setText('location_state', location_state);
    setJson('preferred_channels', preferred_channels);
    setJson('preferred_days', preferred_days);
    setJson('api_products', api_products);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  updates.push("updated_at = datetime('now')");
  params.push(req.user.id);

  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: sanitizeUser(user) });
});

// ─── Consent ────────────────────────────────────────────────

// GET /api/users/consent
router.get('/consent', requireAuth, (req, res) => {
  const consent = db.prepare('SELECT * FROM consent WHERE user_id = ?').all(req.user.id);
  res.json({ consent, channels: notifications.CHANNELS });
});

// POST /api/users/consent
router.post('/consent', requireAuth, (req, res) => {
  const { channel } = req.body;

  if (!channel || !notifications.CHANNELS.includes(channel)) {
    return res.status(400).json({ error: 'Valid channel required' });
  }

  const existing = db.prepare('SELECT * FROM consent WHERE user_id = ? AND channel = ?').get(req.user.id, channel);

  if (existing) {
    db.prepare(`
      UPDATE consent SET status = 'granted', granted_at = datetime('now'), withdrawn_at = NULL
      WHERE id = ?
    `).run(existing.id);
  } else {
    db.prepare(`
      INSERT INTO consent (id, user_id, channel, status, granted_at)
      VALUES (?, ?, ?, 'granted', datetime('now'))
    `).run(uuid(), req.user.id, channel);
  }

  engagement.log(req.user.id, 'consent_granted', { metadata: { channel } });

  const consent = db.prepare('SELECT * FROM consent WHERE user_id = ?').all(req.user.id);
  res.json({ consent });
});

// DELETE /api/users/consent/:channel
router.delete('/consent/:channel', requireAuth, (req, res) => {
  const { channel } = req.params;

  if (!notifications.CHANNELS.includes(channel)) {
    return res.status(400).json({ error: 'Unknown channel' });
  }

  const result = db.prepare(`
    UPDATE consent SET status = 'withdrawn', withdrawn_at = datetime('now')
    WHERE user_id = ? AND channel = ? AND status = 'granted'
  `).run(req.user.id, channel);

  if (result.changes === 0) {
    // Record the withdrawal even if consent was never explicitly granted, so
    // the send path has an authoritative "no" on file either way.
    const existing = db.prepare('SELECT id FROM consent WHERE user_id = ? AND channel = ?')
      .get(req.user.id, channel);

    if (existing) {
      db.prepare("UPDATE consent SET status = 'withdrawn', withdrawn_at = datetime('now') WHERE id = ?")
        .run(existing.id);
    } else {
      db.prepare(`
        INSERT INTO consent (id, user_id, channel, status, withdrawn_at)
        VALUES (?, ?, ?, 'withdrawn', datetime('now'))
      `).run(uuid(), req.user.id, channel);
    }
  }

  engagement.log(req.user.id, 'consent_withdrawn', { metadata: { channel } });

  // Anything already queued for this channel must not go out afterwards
  db.prepare(`
    UPDATE message_deliveries SET status = 'skipped', reason = 'Consent withdrawn before send'
    WHERE user_id = ? AND channel = ? AND status = 'queued'
  `).run(req.user.id, channel);

  const consent = db.prepare('SELECT * FROM consent WHERE user_id = ?').all(req.user.id);
  res.json({ consent });
});

// ─── Notification preferences ───────────────────────────────

// GET /api/users/notification-preferences
router.get('/notification-preferences', requireAuth, (req, res) => {
  const stored = parseJSON(req.user.notification_prefs, {}) || {};

  const categories = Object.entries(notifications.CATEGORIES).map(([key, meta]) => ({
    key,
    label: meta.label,
    enabled: stored[key] === undefined ? meta.default : stored[key] !== false,
    locked: notifications.MANDATORY_CATEGORIES.has(key)
  }));

  res.json({
    categories,
    quiet_hours: {
      start: req.user.quiet_hours_start || '22:00',
      end: req.user.quiet_hours_end || '08:00',
      active_now: notifications.inQuietHours(req.user)
    }
  });
});

// PUT /api/users/notification-preferences
router.put('/notification-preferences', requireAuth, (req, res) => {
  const { categories, quiet_hours } = req.body;
  const updates = [];
  const params = [];

  if (categories !== undefined) {
    if (typeof categories !== 'object' || categories === null || Array.isArray(categories)) {
      return res.status(400).json({ error: 'categories must be an object of key → boolean' });
    }

    const clean = {};
    for (const [key, value] of Object.entries(categories)) {
      if (!notifications.CATEGORIES[key]) {
        return res.status(400).json({ error: `Unknown notification category "${key}"` });
      }
      // Mandatory categories stay on regardless of what the client sends
      clean[key] = notifications.MANDATORY_CATEGORIES.has(key) ? true : Boolean(value);
    }

    updates.push('notification_prefs = ?');
    params.push(JSON.stringify(clean));
  }

  if (quiet_hours !== undefined) {
    const valid = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t));
    if (!quiet_hours || !valid(quiet_hours.start) || !valid(quiet_hours.end)) {
      return res.status(400).json({ error: 'quiet_hours.start and quiet_hours.end must be HH:MM' });
    }
    updates.push('quiet_hours_start = ?', 'quiet_hours_end = ?');
    params.push(quiet_hours.start, quiet_hours.end);
  }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  updates.push("updated_at = datetime('now')");
  params.push(req.user.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const stored = parseJSON(user.notification_prefs, {}) || {};

  res.json({
    categories: Object.entries(notifications.CATEGORIES).map(([key, meta]) => ({
      key,
      label: meta.label,
      enabled: stored[key] === undefined ? meta.default : stored[key] !== false,
      locked: notifications.MANDATORY_CATEGORIES.has(key)
    })),
    quiet_hours: { start: user.quiet_hours_start, end: user.quiet_hours_end }
  });
});

// ─── In-portal inbox ────────────────────────────────────────

// GET /api/users/notifications
router.get('/notifications', requireAuth, (req, res) => {
  const { unread_only, limit = 50 } = req.query;
  res.json(notifications.inbox(req.user.id, {
    unreadOnly: unread_only === 'true',
    limit: Math.min(100, parseInt(limit, 10) || 50)
  }));
});

// POST /api/users/notifications/:id/read
router.post('/notifications/:id/read', requireAuth, (req, res) => {
  const changed = notifications.markRead(req.user.id, req.params.id);
  res.json({ read: changed, ...notifications.inbox(req.user.id, { limit: 1 }) });
});

// POST /api/users/notifications/read-all
router.post('/notifications/read-all', requireAuth, (req, res) => {
  const count = notifications.markAllRead(req.user.id);
  res.json({ marked_read: count });
});

// ─── Engagement History ─────────────────────────────────────

// GET /api/users/engagement
router.get('/engagement', requireAuth, (req, res) => {
  const { type, limit = 50 } = req.query;
  let query = 'SELECT * FROM engagement_history WHERE user_id = ?';
  const params = [req.user.id];

  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.min(200, parseInt(limit, 10) || 50));

  const history = db.prepare(query).all(...params);
  res.json({ history });
});

// ─── Gifts ──────────────────────────────────────────────────

// GET /api/users/gifts — what this member can claim, and what they already have
router.get('/gifts', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const cohortIds = db.prepare('SELECT cohort_id FROM user_cohorts WHERE user_id = ?')
    .all(user.id).map(r => r.cohort_id);

  const surveysCompleted = db.prepare(
    "SELECT COUNT(*) as c FROM survey_responses WHERE user_id = ? AND completed_at IS NOT NULL"
  ).get(user.id).c;

  const claimed = db.prepare(`
    SELECT g.*, ug.claimed_at, ug.delivered_at
    FROM user_gifts ug JOIN gifts g ON g.id = ug.gift_id
    WHERE ug.user_id = ?
    ORDER BY ug.claimed_at DESC
  `).all(user.id);

  const claimedIds = new Set(claimed.map(g => g.id));

  const catalogue = db.prepare("SELECT * FROM gifts WHERE COALESCE(active, 1) = 1").all();

  const available = [];
  const locked = [];

  for (const gift of catalogue) {
    if (claimedIds.has(gift.id)) continue;

    const targets = parseJSON(gift.target_cohort_ids, []) || [];
    // An empty target list means the gift is open to every member
    if (targets.length && !targets.some(id => cohortIds.includes(id))) continue;

    const claimedCount = db.prepare('SELECT COUNT(*) as c FROM user_gifts WHERE gift_id = ?').get(gift.id).c;
    const outOfStock = gift.stock !== null && gift.stock !== undefined && claimedCount >= gift.stock;

    const requirements = [];
    if (surveysCompleted < (gift.min_surveys_completed || 0)) {
      requirements.push(`Complete ${gift.min_surveys_completed - surveysCompleted} more survey(s)`);
    }
    if ((user.engagement_streak || 0) < (gift.min_streak || 0)) {
      requirements.push(`Reach a ${gift.min_streak} engagement streak`);
    }
    if (outOfStock) requirements.push('Fully claimed');

    const entry = {
      ...gift,
      target_cohort_ids: targets,
      requirements,
      remaining: gift.stock == null ? null : Math.max(0, gift.stock - claimedCount)
    };

    (requirements.length ? locked : available).push(entry);
  }

  res.json({
    available,
    locked,
    claimed: claimed.map(g => ({ ...g, target_cohort_ids: parseJSON(g.target_cohort_ids, []) })),
    progress: { surveys_completed: surveysCompleted, streak: user.engagement_streak || 0 }
  });
});

// POST /api/users/gifts/:id/claim
router.post('/gifts/:id/claim', requireAuth, async (req, res) => {
  const gift = db.prepare('SELECT * FROM gifts WHERE id = ?').get(req.params.id);
  if (!gift || gift.active === 0) return res.status(404).json({ error: 'Gift not available' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  const alreadyClaimed = db.prepare('SELECT id FROM user_gifts WHERE user_id = ? AND gift_id = ?')
    .get(user.id, gift.id);
  if (alreadyClaimed) return res.status(409).json({ error: 'You have already claimed this gift' });

  const targets = parseJSON(gift.target_cohort_ids, []) || [];
  if (targets.length) {
    const cohortIds = db.prepare('SELECT cohort_id FROM user_cohorts WHERE user_id = ?')
      .all(user.id).map(r => r.cohort_id);
    if (!targets.some(id => cohortIds.includes(id))) {
      return res.status(403).json({ error: 'This gift is not available to your cohort' });
    }
  }

  const surveysCompleted = db.prepare(
    "SELECT COUNT(*) as c FROM survey_responses WHERE user_id = ? AND completed_at IS NOT NULL"
  ).get(user.id).c;

  if (surveysCompleted < (gift.min_surveys_completed || 0)) {
    return res.status(403).json({
      error: `Complete ${gift.min_surveys_completed} survey(s) to unlock this`,
      surveys_completed: surveysCompleted
    });
  }
  if ((user.engagement_streak || 0) < (gift.min_streak || 0)) {
    return res.status(403).json({ error: `Requires an engagement streak of ${gift.min_streak}` });
  }

  const claimedCount = db.prepare('SELECT COUNT(*) as c FROM user_gifts WHERE gift_id = ?').get(gift.id).c;
  if (gift.stock != null && claimedCount >= gift.stock) {
    return res.status(409).json({ error: 'This gift has been fully claimed' });
  }

  const claimId = uuid();
  try {
    db.prepare('INSERT INTO user_gifts (id, user_id, gift_id) VALUES (?, ?, ?)')
      .run(claimId, user.id, gift.id);
  } catch (err) {
    // The unique index is the real guard against a double-claim race
    return res.status(409).json({ error: 'You have already claimed this gift' });
  }

  const { streak } = engagement.record(user.id, 'gift_claimed', {
    referenceId: gift.id,
    metadata: { gift_name: gift.name, value: gift.value, currency: gift.currency }
  });

  await notifications.notify(user, {
    category: 'gift_notifications',
    title: `You claimed ${gift.name}`,
    body: 'We\'ll be in touch with delivery details shortly.',
    actionUrl: '/member/gifts.html',
    sourceType: 'system',
    sourceId: gift.id,
    channels: ['in_portal', 'email']
  });

  res.status(201).json({
    message: 'Gift claimed',
    claim_id: claimId,
    gift: { ...gift, target_cohort_ids: targets },
    streak
  });
});

// ─── Survey Endpoints (User-facing) ─────────────────────────

// GET /api/users/surveys — active surveys for this user
router.get('/surveys', requireAuth, (req, res) => {
  const userCohortIds = db.prepare('SELECT cohort_id FROM user_cohorts WHERE user_id = ?')
    .all(req.user.id).map(r => r.cohort_id);
  const userCircleIds = circles.circleIdsForUser(req.user.id);

  const allSurveys = db.prepare(`
    SELECT * FROM surveys
    WHERE status = 'active' AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).all();

  const eligible = allSurveys.filter(s => {
    // A survey belonging to a sub-circle is only for that circle's members
    if (s.circle_id && !userCircleIds.includes(s.circle_id)) return false;
    if (s.target_type === 'all') return true;
    const targets = parseJSON(s.target_ids, []);
    if (s.target_type === 'cohort') return targets.some(t => userCohortIds.includes(t));
    if (s.target_type === 'specific') return targets.includes(req.user.id);
    return false;
  });

  const completed = db.prepare(`
    SELECT survey_id FROM survey_responses WHERE user_id = ? AND completed_at IS NOT NULL
  `).all(req.user.id).map(r => r.survey_id);

  const result = eligible.map(s => ({
    ...s,
    questions: parseJSON(s.questions, []),
    target_ids: parseJSON(s.target_ids, []),
    completed: completed.includes(s.id),
    already_responded: completed.includes(s.id)
  }));

  res.json({ surveys: result });
});

// POST /api/users/surveys/:id/start
router.post('/surveys/:id/start', requireAuth, (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ? AND status = ?').get(req.params.id, 'active');
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  if (survey.expires_at && new Date(survey.expires_at.replace(' ', 'T')) < new Date()) {
    return res.status(410).json({ error: 'This survey has closed' });
  }

  const existing = db.prepare('SELECT * FROM survey_responses WHERE survey_id = ? AND user_id = ?')
    .get(survey.id, req.user.id);
  if (existing && existing.completed_at) {
    return res.status(409).json({ error: 'Survey already completed' });
  }

  if (!existing) {
    db.prepare(`
      INSERT INTO survey_responses (id, survey_id, user_id, triggered_by)
      VALUES (?, ?, ?, 'manual')
    `).run(uuid(), survey.id, req.user.id);

    engagement.log(req.user.id, 'survey_started', { referenceId: survey.id });
  }

  const response = db.prepare('SELECT * FROM survey_responses WHERE survey_id = ? AND user_id = ?')
    .get(survey.id, req.user.id);

  res.json({
    survey: { ...survey, questions: parseJSON(survey.questions, []) },
    response
  });
});

// POST /api/users/surveys/:id/respond
router.post('/surveys/:id/respond', requireAuth, (req, res) => {
  const { answers } = req.body;
  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({ error: 'answers object required' });
  }

  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  const response = db.prepare('SELECT * FROM survey_responses WHERE survey_id = ? AND user_id = ?')
    .get(survey.id, req.user.id);
  if (!response) return res.status(404).json({ error: 'Start the survey first' });
  if (response.completed_at) return res.status(409).json({ error: 'Already completed' });

  // Reject answers to questions this survey does not contain
  const questionIds = new Set(parseJSON(survey.questions, []).map(q => q.id));
  const unknown = Object.keys(answers).filter(k => !questionIds.has(k));
  if (unknown.length) {
    return res.status(400).json({ error: 'Unknown question in answers', questions: unknown });
  }

  db.prepare(`
    UPDATE survey_responses SET answers = ?, completed_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(answers), response.id);

  const { streak } = engagement.record(req.user.id, 'survey_completed', {
    referenceId: survey.id,
    metadata: { survey_title: survey.title }
  });

  // Any pending reminder for this survey is now moot
  db.prepare(`
    UPDATE message_deliveries SET status = 'skipped', reason = 'Survey completed before reminder'
    WHERE user_id = ? AND source_id = ? AND status = 'queued'
  `).run(req.user.id, survey.id);

  res.json({ message: 'Survey completed', streak: streak ? streak.streak : null });
});

module.exports = router;
