const express = require('express');
const db = require('../db');
const { uuid, parseJSON, sanitizeUser } = require('../utils/helpers');
const identity = require('../utils/identity');
const { requireAuth } = require('../middleware/auth');
const engagement = require('../services/engagement');
const verbatims = require('../services/verbatims');
const notifications = require('../services/notifications');
const circles = require('../services/circles');
const scheduler = require('../services/scheduler');
const surveyForm = require('../services/surveyForm');

const router = express.Router();

// ─── Profile ────────────────────────────────────────────────

// GET /api/users/profile
router.get('/profile', requireAuth, async (req, res) => {
  // The session already joined this member. Reloading users (and the inbox)
  // was four extra round-trips for a screen that only needs counts.
  const user = await engagement.decayStale(req.user) || req.user;
  const id = user.id;

  const [cohorts, consent, memberCircles, stats] = await Promise.all([
    db.prepare(`
      SELECT c.id, c.name, c.color, c.description
      FROM cohorts c
      JOIN user_cohorts uc ON uc.cohort_id = c.id
      WHERE uc.user_id = ?
    `).all(id),
    db.prepare('SELECT channel, status, granted_at, withdrawn_at FROM consent WHERE user_id = ?').all(id),
    circles.forUser(id),
    db.prepare(`
      SELECT 'sr' as k,
             CAST(COUNT(*) AS INTEGER) as n,
             CAST(SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) AS INTEGER) as n2
      FROM survey_responses WHERE user_id = ?
      UNION ALL
      SELECT 'gifts', CAST(COUNT(*) AS INTEGER), CAST(NULL AS INTEGER)
      FROM user_gifts WHERE user_id = ?
      UNION ALL
      SELECT 'feedback', CAST(COUNT(*) AS INTEGER), CAST(NULL AS INTEGER)
      FROM feedback WHERE user_id = ?
      UNION ALL
      SELECT 'unread', CAST(COUNT(*) AS INTEGER), CAST(NULL AS INTEGER)
      FROM notifications WHERE user_id = ? AND read_at IS NULL
    `).all(id, id, id, id)
  ]);

  const byK = Object.fromEntries((stats || []).map(r => [r.k, r]));

  res.json({
    user: sanitizeUser(user),
    cohorts,
    circles: memberCircles,
    consent,
    stats: {
      surveys_completed: Number(byK.sr?.n2 || 0),
      surveys_invited: Number(byK.sr?.n || 0),
      gifts_claimed: Number(byK.gifts?.n || 0),
      feedback_submitted: Number(byK.feedback?.n || 0),
      streak: user.engagement_streak,
      best_streak: user.best_streak
    },
    unread_notifications: Number(byK.unread?.n || 0)
  });
});

// ─── Circles ────────────────────────────────────────────────

// GET /api/users/circles — the circles this member belongs to
router.get('/circles', requireAuth, async (req, res) => {
  res.json({ circles: await circles.forUser(req.user.id) });
});

// ─── Scheduled sessions ─────────────────────────────────────

// GET /api/users/sessions — upcoming engagements for this member
router.get('/sessions', requireAuth, async (req, res) => {
  const membership = await db.prepare(`
    SELECT 'circle' as k, circle_id as id FROM circle_members WHERE user_id = ?
    UNION ALL
    SELECT 'cohort', cohort_id FROM user_cohorts WHERE user_id = ?
  `).all(req.user.id, req.user.id);
  const circleIds = [];
  const cohortIds = [];
  for (const row of membership || []) {
    if (row.k === 'circle') circleIds.push(row.id);
    else cohortIds.push(row.id);
  }

  const circlePlaceholders = (circleIds || []).map(() => '?').join(',') || "''";
  const sessions = await db.prepare(`
    SELECT s.*, c.name as circle_name, sv.title as survey_title
    FROM scheduled_sessions s
    LEFT JOIN circles c ON c.id = s.circle_id
    LEFT JOIN surveys sv ON sv.id = s.survey_id
    WHERE s.status IN ('scheduled','announced')
      AND s.scheduled_for > datetime('now', '-1 hour')
      AND (s.circle_id IS NULL ${circleIds.length ? `OR s.circle_id IN (${circlePlaceholders})` : ''})
    ORDER BY s.scheduled_for ASC
  `).all(...circleIds);

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
router.put('/profile', requireAuth, async (req, res) => {
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

    // The phone number is a way in now, not just a contact detail, so it is
    // stored twice: as the member wrote it, and in the canonical form a
    // sign-in is matched against.
    if (phone !== undefined) {
      const normalized = identity.normalizePhone(phone);
      if (phone && !normalized) {
        return res.status(400).json({ error: 'That phone number is not one we can send a code to.' });
      }
      setText('phone', phone || null);
      setText('phone_normalized', normalized);
    }

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

  await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: sanitizeUser(user) });
});

// ─── Consent ────────────────────────────────────────────────

// GET /api/users/consent
router.get('/consent', requireAuth, async (req, res) => {
  const consent = await db.prepare('SELECT * FROM consent WHERE user_id = ?').all(req.user.id);
  res.json({ consent, channels: notifications.CHANNELS });
});

// POST /api/users/consent
router.post('/consent', requireAuth, async (req, res) => {
  const { channel } = req.body;

  if (!channel || !notifications.CHANNELS.includes(channel)) {
    return res.status(400).json({ error: 'Valid channel required' });
  }

  const existing = await db.prepare('SELECT * FROM consent WHERE user_id = ? AND channel = ?').get(req.user.id, channel);

  if (existing) {
    await db.prepare(`
      UPDATE consent SET status = 'granted', granted_at = datetime('now'), withdrawn_at = NULL
      WHERE id = ?
    `).run(existing.id);
  } else {
    await db.prepare(`
      INSERT INTO consent (id, user_id, channel, status, granted_at)
      VALUES (?, ?, ?, 'granted', datetime('now'))
    `).run(uuid(), req.user.id, channel);
  }

  engagement.log(req.user.id, 'consent_granted', { metadata: { channel } });

  const consent = await db.prepare('SELECT * FROM consent WHERE user_id = ?').all(req.user.id);
  res.json({ consent });
});

// DELETE /api/users/consent/:channel
router.delete('/consent/:channel', requireAuth, async (req, res) => {
  const { channel } = req.params;

  if (!notifications.CHANNELS.includes(channel)) {
    return res.status(400).json({ error: 'Unknown channel' });
  }

  const result = await db.prepare(`
    UPDATE consent SET status = 'withdrawn', withdrawn_at = datetime('now')
    WHERE user_id = ? AND channel = ? AND status = 'granted'
  `).run(req.user.id, channel);

  if (result.changes === 0) {
    // Record the withdrawal even if consent was never explicitly granted, so
    // the send path has an authoritative "no" on file either way.
    const existing = await db.prepare('SELECT id FROM consent WHERE user_id = ? AND channel = ?')
      .get(req.user.id, channel);

    if (existing) {
      await db.prepare("UPDATE consent SET status = 'withdrawn', withdrawn_at = datetime('now') WHERE id = ?")
        .run(existing.id);
    } else {
      await db.prepare(`
        INSERT INTO consent (id, user_id, channel, status, withdrawn_at)
        VALUES (?, ?, ?, 'withdrawn', datetime('now'))
      `).run(uuid(), req.user.id, channel);
    }
  }

  engagement.log(req.user.id, 'consent_withdrawn', { metadata: { channel } });

  // Anything already queued for this channel must not go out afterwards
  await db.prepare(`
    UPDATE message_deliveries SET status = 'skipped', reason = 'Consent withdrawn before send'
    WHERE user_id = ? AND channel = ? AND status = 'queued'
  `).run(req.user.id, channel);

  const consent = await db.prepare('SELECT * FROM consent WHERE user_id = ?').all(req.user.id);
  res.json({ consent });
});

// ─── Notification preferences ───────────────────────────────

// GET /api/users/notification-preferences
router.get('/notification-preferences', requireAuth, async (req, res) => {
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
router.put('/notification-preferences', requireAuth, async (req, res) => {
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
  await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
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
router.get('/notifications', requireAuth, async (req, res) => {
  const { unread_only, limit = 50 } = req.query;
  res.json(await notifications.inbox(req.user.id, {
    unreadOnly: unread_only === 'true',
    limit: Math.min(100, parseInt(limit, 10) || 50)
  }));
});

// POST /api/users/notifications/:id/read
router.post('/notifications/:id/read', requireAuth, async (req, res) => {
  const changed = await notifications.markRead(req.user.id, req.params.id);
  res.json({ read: changed, ...await notifications.inbox(req.user.id, { limit: 1 }) });
});

// POST /api/users/notifications/read-all
router.post('/notifications/read-all', requireAuth, async (req, res) => {
  const count = await notifications.markAllRead(req.user.id);
  res.json({ marked_read: count });
});

// ─── Engagement History ─────────────────────────────────────

// GET /api/users/engagement
router.get('/engagement', requireAuth, async (req, res) => {
  const { type, limit = 50 } = req.query;
  let query = 'SELECT * FROM engagement_history WHERE user_id = ?';
  const params = [req.user.id];

  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.min(200, parseInt(limit, 10) || 50));

  const history = await db.prepare(query).all(...params);
  res.json({ history });
});

// ─── Gifts ──────────────────────────────────────────────────

// GET /api/users/gifts — what this member can claim, and what they already have
router.get('/gifts', requireAuth, async (req, res) => {
  const user = req.user;
  const [cohortRows, surveysRow, claimed, catalogue] = await Promise.all([
    db.prepare('SELECT cohort_id FROM user_cohorts WHERE user_id = ?').all(req.user.id),
    db.prepare(
      "SELECT COUNT(*) as c FROM survey_responses WHERE user_id = ? AND completed_at IS NOT NULL"
    ).get(req.user.id),
    db.prepare(`
      SELECT g.id, g.name, g.description, g.value, g.currency, g.target_cohort_ids,
             g.stock, g.min_surveys_completed, g.min_streak, g.active,
             ug.claimed_at, ug.delivered_at
      FROM user_gifts ug JOIN gifts g ON g.id = ug.gift_id
      WHERE ug.user_id = ?
      ORDER BY ug.claimed_at DESC
    `).all(req.user.id),
    db.prepare(`
      SELECT g.id, g.name, g.description, g.value, g.currency, g.target_cohort_ids,
             g.stock, g.min_surveys_completed, g.min_streak, g.active,
             COALESCE(ug.c, 0) as claimed_count
      FROM gifts g
      LEFT JOIN (
        SELECT ug.gift_id, COUNT(*) as c
        FROM user_gifts ug
        JOIN gifts gx ON gx.id = ug.gift_id AND COALESCE(gx.active, 1) = 1
        GROUP BY ug.gift_id
      ) ug ON ug.gift_id = g.id
      WHERE COALESCE(g.active, 1) = 1
    `).all()
  ]);
  const cohortIds = (cohortRows || []).map(r => r.cohort_id);
  const surveysCompleted = Number(surveysRow?.c || 0);

  const claimedIds = new Set((claimed || []).map(g => g.id));
  const claimedByGift = new Map((catalogue || []).map(r => [r.id, Number(r.claimed_count || 0)]));

  const available = [];
  const locked = [];

  for (const gift of catalogue) {
    if (claimedIds.has(gift.id)) continue;

    const targets = parseJSON(gift.target_cohort_ids, []) || [];
    // An empty target list means the gift is open to every member
    if (targets.length && !targets.some(id => cohortIds.includes(id))) continue;

    const claimedCount = claimedByGift.get(gift.id) || 0;
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
  const gift = await db.prepare('SELECT * FROM gifts WHERE id = ?').get(req.params.id);
  if (!gift || gift.active === 0) return res.status(404).json({ error: 'Gift not available' });

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  const alreadyClaimed = await db.prepare('SELECT id FROM user_gifts WHERE user_id = ? AND gift_id = ?')
    .get(user.id, gift.id);
  if (alreadyClaimed) return res.status(409).json({ error: 'You have already claimed this gift' });

  const targets = parseJSON(gift.target_cohort_ids, []) || [];
  if (targets.length) {
    const cohortIds = ((await db.prepare('SELECT cohort_id FROM user_cohorts WHERE user_id = ?')
      .all(user.id)) || []).map(r => r.cohort_id);
    if (!targets.some(id => cohortIds.includes(id))) {
      return res.status(403).json({ error: 'This gift is not available to your cohort' });
    }
  }

  const surveysCompleted = Number((await db.prepare(
    "SELECT COUNT(*) as c FROM survey_responses WHERE user_id = ? AND completed_at IS NOT NULL"
  ).get(user.id))?.c || 0);

  if (surveysCompleted < (gift.min_surveys_completed || 0)) {
    return res.status(403).json({
      error: `Complete ${gift.min_surveys_completed} survey(s) to unlock this`,
      surveys_completed: surveysCompleted
    });
  }
  if ((user.engagement_streak || 0) < (gift.min_streak || 0)) {
    return res.status(403).json({ error: `Requires an engagement streak of ${gift.min_streak}` });
  }

  const claimedCount = Number((await db.prepare('SELECT COUNT(*) as c FROM user_gifts WHERE gift_id = ?').get(gift.id))?.c || 0);
  if (gift.stock != null && claimedCount >= gift.stock) {
    return res.status(409).json({ error: 'This gift has been fully claimed' });
  }

  const claimId = uuid();
  try {
    await db.prepare('INSERT INTO user_gifts (id, user_id, gift_id) VALUES (?, ?, ?)')
      .run(claimId, user.id, gift.id);
  } catch (err) {
    // The unique index is the real guard against a double-claim race
    return res.status(409).json({ error: 'You have already claimed this gift' });
  }

  const { streak } = await engagement.record(user.id, 'gift_claimed', {
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
router.get('/surveys', requireAuth, async (req, res) => {
  const [allSurveys, cohortRows, progress] = await Promise.all([
    db.prepare(`
      SELECT s.id, s.title, s.description, s.status, s.target_type, s.target_ids,
             s.engagement_mode, s.time_estimate_min, s.expires_at, s.circle_id,
             COALESCE(json_array_length(s.questions), 0) as question_count
      FROM surveys s
      WHERE s.status = 'active' AND (s.expires_at IS NULL OR s.expires_at > datetime('now'))
        AND (s.circle_id IS NULL OR EXISTS (
          SELECT 1 FROM circle_members cm WHERE cm.circle_id = s.circle_id AND cm.user_id = ?
        ))
    `).all(req.user.id),
    db.prepare('SELECT cohort_id FROM user_cohorts WHERE user_id = ?').all(req.user.id),
    db.prepare(`
      SELECT survey_id, completed_at, answers
      FROM survey_responses WHERE user_id = ?
    `).all(req.user.id)
  ]);
  const userCohortIds = (cohortRows || []).map(r => r.cohort_id);

  const eligible = (allSurveys || []).filter(s => {
    if (s.target_type === 'all') return true;
    const targets = parseJSON(s.target_ids, []);
    if (s.target_type === 'cohort') return targets.some(t => userCohortIds.includes(t));
    if (s.target_type === 'specific') return targets.includes(req.user.id);
    return false;
  });

  const completed = new Set();
  const started = new Map();
  for (const row of progress || []) {
    if (row.completed_at) completed.add(row.survey_id);
    else started.set(row.survey_id, Object.keys(parseJSON(row.answers, {})).length);
  }

  const result = eligible.map(s => {
    const done = completed.has(s.id);
    return {
      id: s.id,
      title: s.title,
      description: s.description,
      status: s.status,
      target_type: s.target_type,
      target_ids: parseJSON(s.target_ids, []),
      engagement_mode: s.engagement_mode,
      time_estimate_min: s.time_estimate_min,
      expires_at: s.expires_at,
      circle_id: s.circle_id,
      completed: done,
      already_responded: done,
      answered_so_far: started.get(s.id) || 0,
      question_count: Number(s.question_count || 0)
    };
  });

  res.json({ surveys: result });
});

// POST /api/users/surveys/:id/start
router.post('/surveys/:id/start', requireAuth, async (req, res) => {
  const survey = await db.prepare('SELECT * FROM surveys WHERE id = ? AND status = ?').get(req.params.id, 'active');
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  if (survey.expires_at && new Date(survey.expires_at.replace(' ', 'T')) < new Date()) {
    return res.status(410).json({ error: 'This survey has closed' });
  }

  const existing = await db.prepare('SELECT * FROM survey_responses WHERE survey_id = ? AND user_id = ?')
    .get(survey.id, req.user.id);
  if (existing && existing.completed_at) {
    return res.status(409).json({ error: 'Survey already completed' });
  }

  if (!existing) {
    await db.prepare(`
      INSERT INTO survey_responses (id, survey_id, user_id, triggered_by)
      VALUES (?, ?, ?, 'manual')
    `).run(uuid(), survey.id, req.user.id);

    engagement.log(req.user.id, 'survey_started', { referenceId: survey.id });
  }

  const response = await db.prepare('SELECT * FROM survey_responses WHERE survey_id = ? AND user_id = ?')
    .get(survey.id, req.user.id);

  const hydrated = surveyForm.hydrate(survey);

  res.json({
    survey: {
      ...hydrated,
      // What the member's page paints itself with: the survey's own look over
      // its circle's over the product's, resolved here so the page never has
      // to know the order of precedence.
      theme: surveyForm.themes.resolve(
        hydrated.theme,
        parseJSON((await circles.byId(survey.circle_id))?.survey_theme, null)
      )
    },
    response,
    // Answers kept from a previous sitting, so leaving a long survey and
    // coming back is not the same as starting again
    answers: parseJSON(response.answers, {})
  });
});

// PATCH /api/users/surveys/:id/progress
// Keeping what has been answered so far. "Save & exit" offered to do this and
// then discarded everything, which is a promise a survey cannot afford to
// break — a member who loses fifteen answers does not come back for a
// sixteenth.
//
// Nothing is validated here beyond the questions being real: a half-typed
// answer is exactly what this exists to hold. Validation belongs at the point
// of submission, where the member is saying they are finished.
router.patch('/surveys/:id/progress', requireAuth, async (req, res) => {
  const { answers } = req.body;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return res.status(400).json({ error: 'answers object required' });
  }

  const survey = await db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  const response = await db.prepare('SELECT * FROM survey_responses WHERE survey_id = ? AND user_id = ?')
    .get(survey.id, req.user.id);
  if (!response) return res.status(404).json({ error: 'Start the survey first' });
  if (response.completed_at) return res.status(409).json({ error: 'Already completed' });

  const questionIds = new Set(surveyForm.hydrate(survey).questions.map(q => q.id));
  const kept = Object.fromEntries(
    Object.entries(answers).filter(([id]) => questionIds.has(id))
  );

  // The one check this endpoint cannot skip. Everywhere else a text answer is
  // held to the question's own limit, but that is exactly what is deliberately
  // not enforced here — so without a ceiling this is an authenticated way to
  // write unbounded data, one PATCH at a time. Generous enough that no real
  // half-finished survey meets it.
  const serialized = JSON.stringify(kept);
  if (serialized.length > 100_000) {
    return res.status(413).json({ error: 'That is more than a survey in progress can hold' });
  }

  await db.prepare('UPDATE survey_responses SET answers = ? WHERE id = ?')
    .run(serialized, response.id);

  res.json({ saved: Object.keys(kept).length });
});

// POST /api/users/surveys/:id/respond
router.post('/surveys/:id/respond', requireAuth, async (req, res) => {
  const { answers } = req.body;
  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({ error: 'answers object required' });
  }

  const survey = await db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  const response = await db.prepare('SELECT * FROM survey_responses WHERE survey_id = ? AND user_id = ?')
    .get(survey.id, req.user.id);
  if (!response) return res.status(404).json({ error: 'Start the survey first' });
  if (response.completed_at) return res.status(409).json({ error: 'Already completed' });

  const questions = surveyForm.hydrate(survey).questions;

  // Reject answers to questions this survey does not contain
  const questionIds = new Set(questions.map(q => q.id));
  const unknown = Object.keys(answers).filter(k => !questionIds.has(k));
  if (unknown.length) {
    return res.status(400).json({ error: 'Unknown question in answers', questions: unknown });
  }

  // The same check the member's page ran, from the same definition — because
  // the page is a courtesy and this is the guarantee. Everything the survey
  // promised about itself is settled here: required answers are present,
  // ratings are within their scale, an option picked is one that was offered,
  // and a question the member's branch never reached is neither required of
  // them nor recorded against them.
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

  await db.prepare(`
    UPDATE survey_responses SET answers = ?, completed_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(checked.answers), response.id);

  // Free-text answers are feedback, so they are filed with the rest of it
  // rather than left inside this one response's JSON where nobody can find them
  const { filed } = await verbatims.record(req.user.id, survey, checked.answers);

  const { streak } = await engagement.record(req.user.id, 'survey_completed', {
    referenceId: survey.id,
    metadata: { survey_title: survey.title, verbatims: filed }
  });

  // Any pending reminder for this survey is now moot
  await db.prepare(`
    UPDATE message_deliveries SET status = 'skipped', reason = 'Survey completed before reminder'
    WHERE user_id = ? AND source_id = ? AND status = 'queued'
  `).run(req.user.id, survey.id);

  res.json({
    message: 'Survey completed',
    streak: streak ? streak.streak : null,
    answered: checked.asked.length,
    // Answers to questions the member's branch took them past. Reported
    // rather than silently dropped, so a client that got its own branching
    // wrong can be found out.
    discarded: checked.dropped.length
  });
});

module.exports = router;
