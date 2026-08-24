const express = require('express');
const db = require('../../db');
const { uuid, parseJSON } = require('../../utils/helpers');
const { requirePermission } = require('../../middleware/auth');
const scheduler = require('../../services/scheduler');
const circles = require('../../services/circles');
const notifications = require('../../services/notifications');

const router = express.Router();

const TYPES = ['survey', 'info', 'test', '1-on-1', 'workshop'];
const TARGET_TYPES = ['all', 'cohort', 'specific', 'circle'];

function hydrate(session) {
  return {
    ...session,
    target_ids: parseJSON(session.target_ids, []),
    channels: parseJSON(session.channels, ['in_portal']),
    reminder_offsets: parseJSON(session.reminder_offsets, [])
  };
}

// GET /api/admin/sessions
router.get('/', requirePermission('sessions.read'), async (req, res) => {
  const { status, upcoming } = req.query;
  const where = ['1=1'];
  const params = [];

  // Sessions belong to the circle that scheduled them
  where.push('s.circle_id = ?'); params.push(req.circleId);
  if (status) { where.push('s.status = ?'); params.push(status); }
  if (upcoming === 'true') { where.push("s.scheduled_for > datetime('now')"); }

  const sessions = await db.prepare(`
    SELECT s.*, c.name as circle_name, sv.title as survey_title,
      (SELECT COUNT(*) FROM session_dispatches d WHERE d.session_id = s.id) as dispatches_sent
    FROM scheduled_sessions s
    LEFT JOIN circles c ON c.id = s.circle_id
    LEFT JOIN surveys sv ON sv.id = s.survey_id
    WHERE ${where.join(' AND ')}
    ORDER BY s.scheduled_for ASC
  `).all(...params);

  res.json({ sessions: (sessions || []).map(hydrate) });
});

// GET /api/admin/sessions/:id
router.get('/:id', requirePermission('sessions.read'), (req, res) => {
  const session = db.prepare('SELECT * FROM scheduled_sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  res.json({
    session: hydrate(session),
    dispatches: db.prepare('SELECT * FROM session_dispatches WHERE session_id = ? ORDER BY offset_minutes DESC')
      .all(session.id),
    deliveries: db.prepare(`
      SELECT d.channel, d.status, d.reason, COUNT(*) as count
      FROM message_deliveries d
      WHERE d.source_id = ? AND d.source_type IN ('session_invite','session_reminder')
      GROUP BY d.channel, d.status, d.reason
    `).all(session.id)
  });
});

function validate(body) {
  const { title, scheduled_for, type, target_type, channels, reminder_offsets } = body;

  if (!title) return 'title is required';
  if (!scheduled_for) return 'scheduled_for is required';
  if (!scheduler.parseWhen(scheduled_for)) return 'scheduled_for must be an ISO date-time';
  if (type && !TYPES.includes(type)) return `type must be one of: ${TYPES.join(', ')}`;
  if (target_type && !TARGET_TYPES.includes(target_type)) {
    return `target_type must be one of: ${TARGET_TYPES.join(', ')}`;
  }
  if (channels && (!Array.isArray(channels) || channels.some(c => !notifications.CHANNELS.includes(c)))) {
    return `channels must be drawn from: ${notifications.CHANNELS.join(', ')}`;
  }
  if (reminder_offsets && (!Array.isArray(reminder_offsets) ||
      reminder_offsets.some(n => !Number.isFinite(Number(n)) || Number(n) <= 0))) {
    return 'reminder_offsets must be positive numbers of minutes before the session';
  }
  return null;
}

// POST /api/admin/sessions
router.post('/', requirePermission('sessions.write'), async (req, res) => {
  const invalid = validate(req.body);
  if (invalid) return res.status(400).json({ error: invalid });

  const {
    title, description, type = 'info', survey_id, circle_id,
    target_type = 'all', target_ids = [], scheduled_for, duration_min,
    location, channels = ['in_portal', 'email'], reminder_offsets = [1440, 60]
  } = req.body;

  if (type === 'survey' && !survey_id) {
    return res.status(400).json({ error: 'A survey session needs a survey_id' });
  }
  if (survey_id && !(await db.prepare('SELECT 1 FROM surveys WHERE id = ?').get(survey_id))) {
    return res.status(400).json({ error: 'Unknown survey_id' });
  }

  const circle = circle_id ? circles.byId(circle_id) : req.circle;
  if (!circle) return res.status(400).json({ error: 'Unknown circle_id' });

  const id = uuid();
  await db.prepare(`
    INSERT INTO scheduled_sessions (
      id, title, description, type, survey_id, circle_id, target_type, target_ids,
      scheduled_for, duration_min, location, channels, reminder_offsets, status, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)
  `).run(
    id, title, description || null, type, survey_id || null, circle.id,
    target_type, JSON.stringify(target_ids),
    scheduled_for, duration_min || 30, location || null,
    JSON.stringify(channels), JSON.stringify(reminder_offsets.map(Number)),
    req.admin.id
  );

  const session = await db.prepare('SELECT * FROM scheduled_sessions WHERE id = ?').get(id);

  // Return the availability picture with the session, so a clash is visible
  // at the moment of scheduling rather than after the invites go out.
  res.status(201).json({ session: hydrate(session), preview: await scheduler.preview(session) });
});

// GET /api/admin/sessions/:id/preview — who can attend, who is unavailable
router.get('/:id/preview', requirePermission('sessions.read'), async (req, res) => {
  const session = await db.prepare('SELECT * FROM scheduled_sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  try {
    res.json(await scheduler.preview(session));
  } catch (err) {
    if (err instanceof scheduler.SessionError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

// POST /api/admin/sessions/preview — check a slot before creating anything
router.post('/preview', requirePermission('sessions.read'), async (req, res) => {
  const invalid = validate({ ...req.body, title: req.body.title || 'draft' });
  if (invalid) return res.status(400).json({ error: invalid });

  try {
    res.json(await scheduler.preview({
      title: req.body.title || 'Draft session',
      scheduled_for: req.body.scheduled_for,
      circle_id: req.body.circle_id || req.circleId,
      target_type: req.body.target_type || 'all',
      target_ids: JSON.stringify(req.body.target_ids || []),
      channels: JSON.stringify(req.body.channels || ['in_portal', 'email'])
    }));
  } catch (err) {
    if (err instanceof scheduler.SessionError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

// PUT /api/admin/sessions/:id
router.put('/:id', requirePermission('sessions.write'), (req, res) => {
  const session = db.prepare('SELECT * FROM scheduled_sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const invalid = validate({ ...hydrate(session), ...req.body });
  if (invalid) return res.status(400).json({ error: invalid });

  const map = {
    title: req.body.title,
    description: req.body.description,
    type: req.body.type,
    scheduled_for: req.body.scheduled_for,
    duration_min: req.body.duration_min,
    location: req.body.location,
    target_type: req.body.target_type,
    status: req.body.status
  };

  const updates = [];
  const params = [];
  for (const [key, value] of Object.entries(map)) {
    if (value !== undefined) { updates.push(`${key} = ?`); params.push(value); }
  }
  for (const key of ['target_ids', 'channels', 'reminder_offsets']) {
    if (req.body[key] !== undefined) { updates.push(`${key} = ?`); params.push(JSON.stringify(req.body[key])); }
  }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  params.push(session.id);
  db.prepare(`UPDATE scheduled_sessions SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  // Moving a session invalidates reminders that were already sent for the old
  // time, so clear the dispatch log and let them fire again against the new one.
  if (req.body.scheduled_for && req.body.scheduled_for !== session.scheduled_for) {
    db.prepare('DELETE FROM session_dispatches WHERE session_id = ? AND offset_minutes >= 0').run(session.id);
  }

  res.json({ session: hydrate(db.prepare('SELECT * FROM scheduled_sessions WHERE id = ?').get(session.id)) });
});

// POST /api/admin/sessions/:id/announce — send the invitation now
router.post('/:id/announce', requirePermission('sessions.write'), async (req, res) => {
  try {
    const result = await scheduler.dispatch(req.params.id, null);
    if (result.skipped) return res.status(409).json({ error: 'This session has already been announced' });
    res.json({ message: `Announced to ${result.delivered} of ${result.recipients} member(s)`, ...result });
  } catch (err) {
    if (err instanceof scheduler.SessionError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

// POST /api/admin/sessions/:id/remind — send an ad-hoc reminder now
router.post('/:id/remind', requirePermission('sessions.write'), async (req, res) => {
  const session = db.prepare('SELECT * FROM scheduled_sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const when = scheduler.parseWhen(session.scheduled_for);
  const minutesOut = Math.max(1, Math.round((when.getTime() - Date.now()) / 60000));

  try {
    const result = await scheduler.dispatch(session.id, minutesOut);
    if (result.skipped) return res.status(409).json({ error: 'A reminder for this window already went out' });
    res.json({ message: `Reminded ${result.delivered} of ${result.recipients} member(s)`, ...result });
  } catch (err) {
    if (err instanceof scheduler.SessionError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

// DELETE /api/admin/sessions/:id — cancel and tell everyone
router.delete('/:id', requirePermission('sessions.write'), async (req, res) => {
  const session = db.prepare('SELECT * FROM scheduled_sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status === 'cancelled') return res.status(409).json({ error: 'Already cancelled' });

  const wasAnnounced = session.status === 'announced';
  db.prepare("UPDATE scheduled_sessions SET status = 'cancelled' WHERE id = ?").run(session.id);

  // Members who were told it was happening deserve to be told it is not
  let notified = 0;
  if (wasAnnounced) {
    for (const user of await scheduler.audienceFor(session)) {
      const result = await notifications.notify(user, {
        category: 'platform_updates',
        title: `Cancelled: ${session.title}`,
        actionUrl: '/member/sessions.html',
        // A DELETE usually carries no body, so req.body is undefined here
        body: req.body?.reason || 'This session will no longer take place. We\'ll follow up with a new date.',
        sourceType: 'session_invite',
        sourceId: session.id,
        channels: parseJSON(session.channels, ['in_portal'])
      });
      if (result.delivered) notified++;
    }
  }

  res.json({ message: 'Session cancelled', notified });
});

// POST /api/admin/sessions/run-scheduler — force a tick (useful for testing)
router.post('/run-scheduler', requirePermission('sessions.write'), async (req, res) => {
  res.json(await scheduler.tick());
});

module.exports = router;
