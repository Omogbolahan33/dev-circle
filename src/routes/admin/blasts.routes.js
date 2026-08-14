const express = require('express');
const db = require('../../db');
const { uuid, parseJSON } = require('../../utils/helpers');
const { requirePermission } = require('../../middleware/auth');
const { blastRecipients } = require('../../services/audience');
const engagement = require('../../services/engagement');
const notifications = require('../../services/notifications');
const circles = require('../../services/circles');

const router = express.Router();

// ─── Message Blasts ─────────────────────────────────────────

// GET /api/admin/blasts
router.get('/blasts', requirePermission('blasts.send', 'members.read'), (req, res) => {
  const blasts = db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM message_deliveries d
        WHERE d.source_type = 'blast' AND d.source_id = b.id
          AND d.status IN ('sent','simulated')) as delivered_count,
      (SELECT COUNT(*) FROM message_deliveries d
        WHERE d.source_type = 'blast' AND d.source_id = b.id AND d.status = 'skipped') as skipped_count
    FROM message_blasts b ORDER BY b.created_at DESC
  `).all();

  res.json({ blasts: blasts.map(b => ({ ...b, target_ids: parseJSON(b.target_ids, []) })) });
});

// GET /api/admin/blasts/:id/deliveries — the audit trail for one blast
router.get('/blasts/:id/deliveries', requirePermission('blasts.send'), (req, res) => {
  const deliveries = db.prepare(`
    SELECT d.*, u.name as user_name, u.email as user_email
    FROM message_deliveries d
    JOIN users u ON u.id = d.user_id
    WHERE d.source_type = 'blast' AND d.source_id = ?
    ORDER BY d.created_at DESC
  `).all(req.params.id);

  res.json({ deliveries, count: deliveries.length });
});

// POST /api/admin/blasts
router.post('/blasts', requirePermission('blasts.send'), (req, res) => {
  const { subject, content, channel, target_type, target_ids, scheduled_for, circle_id } = req.body;

  if (!content || !channel || !target_type) {
    return res.status(400).json({ error: 'content, channel, and target_type required' });
  }

  let circle;
  try {
    circle = circles.resolve(circle_id);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!['email', 'whatsapp', 'sms', 'in_portal', 'all'].includes(channel)) {
    return res.status(400).json({ error: 'Invalid channel' });
  }
  if (!['all', 'cohort', 'specific'].includes(target_type)) {
    return res.status(400).json({ error: 'Invalid target_type' });
  }
  if (target_type !== 'all' && (!Array.isArray(target_ids) || target_ids.length === 0)) {
    return res.status(400).json({ error: `target_ids required when targeting ${target_type}` });
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO message_blasts (id, subject, content, channel, target_type, target_ids,
                                status, sent_by, scheduled_for, circle_id)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
  `).run(id, subject || null, content, channel, target_type,
         JSON.stringify(target_ids || []), req.admin.id, scheduled_for || null, circle.id);

  const blast = db.prepare('SELECT * FROM message_blasts WHERE id = ?').get(id);
  res.status(201).json({ blast: { ...blast, target_ids: parseJSON(blast.target_ids, []) } });
});

// POST /api/admin/blasts/:id/preview — who this reaches, before committing
router.post('/blasts/:id/preview', requirePermission('blasts.send'), (req, res) => {
  const blast = db.prepare('SELECT * FROM message_blasts WHERE id = ?').get(req.params.id);
  if (!blast) return res.status(404).json({ error: 'Blast not found' });

  const recipients = blastRecipients(blast);
  const channels = blast.channel === 'all' ? notifications.CHANNELS : ['in_portal', blast.channel];

  let reachable = 0;
  const blocked = [];

  for (const user of recipients) {
    const { allowed, skipped } = notifications.resolveChannels(user, channels, 'platform_updates');
    if (allowed.length) reachable++;
    else blocked.push({ name: user.name, email: user.email, reasons: skipped.map(s => s.reason) });
  }

  res.json({ total: recipients.length, reachable, blocked_count: blocked.length, blocked: blocked.slice(0, 25) });
});

// POST /api/admin/blasts/:id/send
router.post('/blasts/:id/send', requirePermission('blasts.send'), async (req, res) => {
  const blast = db.prepare('SELECT * FROM message_blasts WHERE id = ?').get(req.params.id);
  if (!blast) return res.status(404).json({ error: 'Blast not found' });
  if (blast.status === 'sent') return res.status(409).json({ error: 'Already sent' });
  if (blast.status === 'sending') return res.status(409).json({ error: 'Send already in progress' });

  db.prepare("UPDATE message_blasts SET status = 'sending' WHERE id = ?").run(blast.id);

  try {
    const recipients = blastRecipients(blast);
    const channels = blast.channel === 'all' ? notifications.CHANNELS : ['in_portal', blast.channel];

    // Consent, channel preference, and quiet hours are all applied inside the
    // notification service, and every outcome is recorded per recipient.
    const summary = await notifications.notifyMany(recipients, {
      category: 'platform_updates',
      title: blast.subject || 'A message from Credit Direct',
      body: blast.content,
      actionUrl: '/member/notifications.html',
      sourceType: 'blast',
      sourceId: blast.id,
      channels
    });

    // Engagement history records a message as a message. It previously logged
    // every blast as 'survey_invited', which corrupted the history.
    for (const entry of summary.per_user) {
      if (entry.delivered > 0) {
        engagement.log(entry.user_id, 'message_sent', {
          referenceId: blast.id,
          metadata: { channel: blast.channel, subject: blast.subject },
          source: 'manual'
        });
      }
    }

    db.prepare(`
      UPDATE message_blasts
      SET status = 'sent', sent_at = datetime('now'), recipient_count = ?, skipped_count = ?
      WHERE id = ?
    `).run(recipients.length, summary.skipped, blast.id);

    res.json({
      message: `Blast processed for ${recipients.length} recipient(s)`,
      recipient_count: recipients.length,
      delivered: summary.delivered,
      skipped: summary.skipped,
      queued_for_quiet_hours: summary.queued,
      failed: summary.failed
    });
  } catch (err) {
    db.prepare("UPDATE message_blasts SET status = 'failed' WHERE id = ?").run(blast.id);
    throw err;
  }
});

module.exports = router;
