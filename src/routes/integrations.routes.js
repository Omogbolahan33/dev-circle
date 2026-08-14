const express = require('express');
const db = require('../db');
const { uuid, parseJSON } = require('../utils/helpers');
const identity = require('../utils/identity');
const { requireApiKey } = require('../middleware/auth');
const engagement = require('../services/engagement');
const notifications = require('../services/notifications');
const cohortRules = require('../services/cohortRules');
const circles = require('../services/circles');

const router = express.Router();

// Every endpoint below is a machine-to-machine surface reachable from outside
// the network, so all of them authenticate with a scoped API key. They were
// previously wide open: anonymous callers could create accounts, forge
// engagement events, promote users to production, and mark KYB complete.

// ─── Helpers ────────────────────────────────────────────────

function logIntegrationEvent(source, eventType, payload, { processed = 0, error = null } = {}) {
  const id = uuid();
  db.prepare(`
    INSERT INTO integration_events (id, source, event_type, payload, processed, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, source, eventType, JSON.stringify(payload), processed, error);
  return id;
}

function markProcessed(eventId, error = null) {
  db.prepare('UPDATE integration_events SET processed = ?, error = ? WHERE id = ?')
    .run(error ? 0 : 1, error, eventId);
}

function findUser({ dev_hub_user_id, email, user_id }) {
  if (dev_hub_user_id) {
    const byHub = db.prepare('SELECT * FROM users WHERE dev_hub_user_id = ?').get(dev_hub_user_id);
    if (byHub) return byHub;
  }
  if (email) {
    const byEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (byEmail) return byEmail;
  }
  if (user_id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(user_id) || null;
  }
  return null;
}

// Invite a member to any survey wired to this event, exactly once
async function triggerSurveysFor(user, eventType, metadata = {}) {
  const surveys = db.prepare(`
    SELECT * FROM surveys
    WHERE trigger_event = ? AND status = 'active'
      AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).all(eventType);

  const triggered = [];

  for (const survey of surveys) {
    const existing = db.prepare('SELECT id FROM survey_responses WHERE survey_id = ? AND user_id = ?')
      .get(survey.id, user.id);
    if (existing) continue;

    db.prepare(`
      INSERT INTO survey_responses (id, survey_id, user_id, triggered_by)
      VALUES (?, ?, ?, 'customer_io')
    `).run(uuid(), survey.id, user.id);

    engagement.log(user.id, 'survey_invited', {
      referenceId: survey.id,
      metadata: { event_type: eventType, auto_triggered: true, ...metadata },
      source: 'customer_io'
    });

    await notifications.notify(user, {
      category: 'survey_invites',
      title: survey.title,
      body: survey.description || `A short survey (about ${survey.time_estimate_min} min) is ready for you.`,
      actionUrl: `/member/survey.html?id=${survey.id}`,
      sourceType: 'survey_invite',
      sourceId: survey.id,
      channels: survey.engagement_mode === 'in_portal' ? ['in_portal'] : ['in_portal', survey.engagement_mode]
    });

    triggered.push({ survey_id: survey.id, title: survey.title });
  }

  return triggered;
}

// ─── Landing Page Integration ───────────────────────────────
// POST /api/integrations/landing-page/ingest
router.post('/landing-page/ingest', requireApiKey('landing_page'), (req, res) => {
  const {
    name, phone, company, work_sector,
    date_of_birth, gender, location_state, api_products, dev_hub_user_id
  } = req.body;

  const email = identity.normalizeEmail(req.body.email);

  if (!email || !name) {
    return res.status(400).json({ error: 'A valid email and a name are required' });
  }

  const eventId = logIntegrationEvent('landing_page', 'user_registration', { email, name });

  // A Credit Direct address belongs to a staff account, which is created by an
  // administrator and signs in with a password. Letting one in here would make
  // a participant profile nobody could ever sign in to.
  if (identity.isStaffEmail(email)) {
    markProcessed(eventId, 'Credit Direct domain');
    return res.status(400).json({ error: 'Credit Direct staff accounts are created by an administrator' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email);
  if (existing) {
    markProcessed(eventId, 'Duplicate registration');
    return res.status(409).json({ error: 'User already exists', user_id: existing.id });
  }

  const id = uuid();

  db.prepare(`
    INSERT INTO users (id, email, name, phone, phone_normalized, company, work_sector, password_hash,
                       date_of_birth, gender, location_state, api_products, dev_hub_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, email, name, phone || null, identity.normalizePhone(phone),
    company || null, work_sector || null, identity.NO_PASSWORD,
    date_of_birth || null, gender || null, location_state || null,
    JSON.stringify(Array.isArray(api_products) ? api_products : []),
    dev_hub_user_id || null
  );

  const allCohort = db.prepare("SELECT id FROM cohorts WHERE name = 'All Members'").get();
  if (allCohort) {
    db.prepare('INSERT OR IGNORE INTO user_cohorts (user_id, cohort_id) VALUES (?, ?)').run(id, allCohort.id);
  }
  circles.joinRoot(id);

  // Registration on the landing page includes the consent form, so record the
  // channels the member agreed to rather than leaving consent empty.
  const consentedChannels = Array.isArray(req.body.consent_channels) ? req.body.consent_channels : [];
  const consentStmt = db.prepare(`
    INSERT INTO consent (id, user_id, channel, status, granted_at)
    VALUES (?, ?, ?, 'granted', datetime('now'))
  `);
  for (const channel of consentedChannels) {
    if (notifications.CHANNELS.includes(channel)) {
      consentStmt.run(uuid(), id, channel);
      engagement.log(id, 'consent_granted', { metadata: { channel }, source: 'landing_page' });
    }
  }

  engagement.log(id, 'account_created', { metadata: { source: 'landing_page' }, source: 'landing_page' });
  cohortRules.syncAll();
  markProcessed(eventId);

  // No credential to hand back: the member signs in with a one-time code sent
  // to the address or number they just registered.
  res.status(201).json({
    message: 'User created',
    user_id: id,
    sign_in: { method: 'code', identifier: email }
  });
});

// ─── Customer.io Integration ────────────────────────────────
// POST /api/integrations/customerio/webhook
router.post('/customerio/webhook', requireApiKey('customer_io'), async (req, res) => {
  const { event_type, user_id, data = {} } = req.body;

  if (!event_type || !user_id) {
    return res.status(400).json({ error: 'event_type and user_id required' });
  }

  const eventId = logIntegrationEvent('customer_io', event_type, req.body);

  const user = findUser({ dev_hub_user_id: user_id, email: data.email });
  if (!user) {
    // Left unprocessed so it can be replayed once the member exists
    return res.status(404).json({ error: 'User not found in Dev Circle', queued: true, event_id: eventId });
  }

  const eventMap = {
    'signup_successful': 'account_created',
    'generate_api_keys': 'api_key_generated',
    'first_sandbox_call': 'first_sandbox_call',
    'first_production_call': 'first_production_call',
    'kyb_completed': 'kyb_completed',
    'product_requested': 'product_requested',
    'survey_completed': 'survey_completed'
  };

  const engagementType = eventMap[event_type];
  if (engagementType) {
    engagement.record(user.id, engagementType, { metadata: data, source: 'customer_io' });

    if (event_type === 'first_production_call') {
      db.prepare("UPDATE users SET api_status = 'production' WHERE id = ? AND api_status = 'sandbox'").run(user.id);
    }
    if (event_type === 'kyb_completed') {
      db.prepare('UPDATE users SET kyb_completed = 1 WHERE id = ?').run(user.id);
    }
    if (event_type === 'product_requested' && data.product) {
      const current = parseJSON(user.api_products, []) || [];
      if (!current.includes(data.product)) {
        db.prepare('UPDATE users SET api_products = ? WHERE id = ?')
          .run(JSON.stringify([...current, data.product]), user.id);
      }
    }
  }

  // These events change cohort membership inputs, so reconcile rule-based
  // cohorts instead of letting them drift until someone edits them by hand.
  cohortRules.syncAll();

  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const triggered = await triggerSurveysFor(fresh, event_type, { via: 'customer_io' });

  markProcessed(eventId);

  res.json({
    message: 'Event processed',
    user_id: user.id,
    engagement_type: engagementType || null,
    surveys_triggered: triggered
  });
});

// ─── Feex Integration ───────────────────────────────────────
// POST /api/integrations/feex/webhook
// Feex is the system of record for support tickets and handles them end to
// end, including all comms with the developer. Dev Circle only mirrors the
// ticket so a complaint shows up as an engagement signal against the member —
// it never writes back to Feex and never resolves anything itself.
router.post('/feex/webhook', requireApiKey('feex'), (req, res) => {
  const { ticket_id, user_email, subject, description, status, priority, ticket_url } = req.body;

  if (!ticket_id || !user_email) {
    return res.status(400).json({ error: 'ticket_id and user_email required' });
  }

  const eventId = logIntegrationEvent('feex', 'complaint_received', req.body);

  const user = findUser({ email: user_email });
  if (!user) {
    return res.status(404).json({ error: 'User not found', queued: true, event_id: eventId });
  }

  // Feex sends both new complaints and status changes on existing tickets.
  // Every callback used to create a duplicate feedback row.
  const existing = db.prepare('SELECT * FROM feedback WHERE external_ticket_id = ?').get(ticket_id);

  if (existing) {
    db.prepare(`
      UPDATE feedback
      SET feex_status = ?, feex_priority = COALESCE(?, feex_priority),
          feex_url = COALESCE(?, feex_url), feex_updated_at = datetime('now')
      WHERE id = ?
    `).run(status || existing.feex_status, priority || null, ticket_url || null, existing.id);

    // A closed ticket is still worth recording as engagement history — that
    // visibility is the whole point of the integration.
    if ((status === 'resolved' || status === 'closed') && existing.feex_status !== status) {
      engagement.log(user.id, 'complaint_resolved', {
        referenceId: existing.id, metadata: { ticket_id, feex_status: status }, source: 'feex'
      });
    }

    markProcessed(eventId);
    return res.json({ message: 'Ticket state mirrored', feedback_id: existing.id, feex_status: status });
  }

  const feedbackId = uuid();
  db.prepare(`
    INSERT INTO feedback (id, user_id, type, content, category, status, source,
                          external_ticket_id, feex_status, feex_priority, feex_url, feex_updated_at)
    VALUES (?, ?, 'feex_complaint', ?, ?, 'open', 'feex', ?, ?, ?, ?, datetime('now'))
  `).run(
    feedbackId, user.id, description || subject, subject, ticket_id,
    status || 'open', priority || null, ticket_url || null
  );

  engagement.log(user.id, 'complaint_received', {
    referenceId: feedbackId,
    metadata: { ticket_id, subject, priority },
    source: 'feex'
  });

  markProcessed(eventId);
  res.status(201).json({ message: 'Complaint ingested', feedback_id: feedbackId, user_id: user.id });
});

// ─── Generic Event Ingestion ────────────────────────────────
// POST /api/integrations/events
// The Developer Hub analytics bridge posts here on action completion.
router.post('/events', requireApiKey('events'), async (req, res) => {
  const { event_type, user_identifier, user_identifier_type = 'email', data = {} } = req.body;

  if (!event_type || !user_identifier) {
    return res.status(400).json({ error: 'event_type and user_identifier required' });
  }

  const eventId = logIntegrationEvent('external', event_type, req.body);

  const lookup = {
    email: { email: user_identifier },
    dev_hub_id: { dev_hub_user_id: user_identifier },
    id: { user_id: user_identifier }
  }[user_identifier_type];

  if (!lookup) {
    return res.status(400).json({ error: 'user_identifier_type must be email, dev_hub_id, or id' });
  }

  const user = findUser(lookup);
  if (!user) {
    return res.status(404).json({ error: 'User not found', queued: true, event_id: eventId });
  }

  const KNOWN_TYPES = new Set([
    'api_key_generated', 'first_sandbox_call', 'first_production_call',
    'kyb_completed', 'product_requested'
  ]);

  if (KNOWN_TYPES.has(event_type)) {
    engagement.record(user.id, event_type, { metadata: data, source: 'system' });
    if (event_type === 'first_production_call') {
      db.prepare("UPDATE users SET api_status = 'production' WHERE id = ? AND api_status = 'sandbox'").run(user.id);
    }
    if (event_type === 'kyb_completed') {
      db.prepare('UPDATE users SET kyb_completed = 1 WHERE id = ?').run(user.id);
    }
    cohortRules.syncAll();
  }

  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const triggered = await triggerSurveysFor(fresh, event_type, data);

  markProcessed(eventId);
  res.json({ message: 'Event processed', user_id: user.id, surveys_triggered: triggered });
});

// ─── Replay ─────────────────────────────────────────────────
// GET /api/integrations/events/pending — what failed to land, and why
router.get('/events/pending', requireApiKey('events', 'customer_io', 'feex'), (req, res) => {
  const events = db.prepare(`
    SELECT id, source, event_type, error, created_at FROM integration_events
    WHERE processed = 0 ORDER BY created_at DESC LIMIT 100
  `).all();
  res.json({ events, count: events.length });
});

module.exports = router;
