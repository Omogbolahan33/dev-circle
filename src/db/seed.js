// The demo bootstrap and this script seed the same accounts, and the bootstrap
// runs on import — so left alone the two race, and the loser fails on a unique
// constraint over roles.name. This script is the richer of the two and it is
// the one being asked for, so it turns the other off before the handle it
// hangs off is required. Set before the require, because that is when it runs.
process.env.SEED_DEMO_ACCOUNTS = 'false';

const db = require('.');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('../config');
const { NO_PASSWORD, normalizePhone } = require('../utils/identity');
const { generateApiKey, hashApiKey } = require('../middleware/auth');
const verbatims = require('../services/verbatims');
const questionsService = require('../services/questions');
const surveyForm = require('../services/surveyForm');

function uuid() { return crypto.randomUUID(); }

// Postgres / Supabase: use async seed
if (config.isPostgres) {
  console.log('Postgres detected — delegating to async seed for Supabase/Postgres...');
  // Load async seeder and exit; it handles the same data via pg pool
  require('../../scripts/seed-postgres');
  // seed-postgres is async and will process.exit when done; prevent fall-through
  return;
}

// This script wipes every table it owns and installs weak demo credentials.
// Running it against production would delete the member base and open two
// admin accounts with published passwords.
if (config.isProduction && process.env.ALLOW_PRODUCTION_SEED !== 'yes-destroy-my-data') {
  console.error('Refusing to seed: NODE_ENV is production.');
  console.error('This deletes all data and creates demo accounts with known passwords.');
  process.exit(1);
}

console.log('Seeding Dev Circle database...\n');

// The seed owns every table below, so it clears them first. Re-running used to
// stack duplicate engagement, feedback, and consent rows on each invocation.
const OWNED_TABLES = [
  'session_dispatches', 'scheduled_sessions',
  'message_deliveries', 'notifications', 'user_gifts', 'gifts', 'consent',
  'feedback', 'survey_responses', 'surveys', 'questions', 'engagement_history',
  'circle_admins', 'circle_members', 'circles',
  'user_cohorts', 'cohorts', 'sessions', 'users', 'admin_users', 'roles',
  'api_keys', 'message_blasts', 'integration_events'
];

db.transaction(() => {
  for (const table of OWNED_TABLES) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
})();
console.log('✓ cleared previous seed data');

// ─── Roles ──────────────────────────────────────────────────
// Permissions now gate real routes, so these lists determine what each role
// can actually do rather than being descriptive labels.
const roles = [
  {
    id: uuid(), name: 'Super Admin', description: 'Full access', is_system: 1,
    permissions: ['*']
  },
  {
    id: uuid(), name: 'Admin', description: 'Standard admin', is_system: 1,
    permissions: [
      'members.read', 'members.write', 'members.import',
      'cohorts.read', 'cohorts.write',
      'circles.read', 'circles.write',
      'sessions.read', 'sessions.write',
      'surveys.read', 'surveys.write', 'surveys.invite',
      'blasts.send', 'feedback.read', 'feedback.write',
      'onboarding.read', 'onboarding.write', 'onboarding.approve',
      'gifts.read', 'gifts.write', 'export.read', 'integrations.read'
    ]
  },
  {
    id: uuid(), name: 'CDL Rep', description: 'Engagement team', is_system: 1,
    permissions: [
      'members.read', 'cohorts.read', 'circles.read',
      'sessions.read', 'sessions.write',
      'surveys.read', 'surveys.invite',
      'onboarding.read',
      'feedback.read', 'feedback.write', 'gifts.read'
    ]
  },
  {
    id: uuid(), name: 'Read Only', description: 'View only access', is_system: 0,
    permissions: [
      'members.read', 'cohorts.read', 'circles.read',
      'sessions.read', 'surveys.read', 'onboarding.read', 'feedback.read'
    ]
  }
];

const roleStmt = db.prepare('INSERT INTO roles (id, name, description, permissions, is_system) VALUES (?, ?, ?, ?, ?)');
for (const r of roles) {
  roleStmt.run(r.id, r.name, r.description, JSON.stringify(r.permissions), r.is_system);
}
console.log(`✓ ${roles.length} roles created`);

// ─── Admin Users ────────────────────────────────────────────
const admins = [
  { id: uuid(), email: 'admin@creditdirect.ng', name: 'Adaeze Okonkwo', password: 'admin123', role_id: roles[0].id },
  { id: uuid(), email: 'engagement@creditdirect.ng', name: 'Tunde Bakare', password: 'engagement123', role_id: roles[2].id }
];

const adminStmt = db.prepare('INSERT INTO admin_users (id, email, name, password_hash, role_id) VALUES (?, ?, ?, ?, ?)');
for (const a of admins) {
  adminStmt.run(a.id, a.email, a.name, bcrypt.hashSync(a.password, 10), a.role_id);
}
console.log(`✓ ${admins.length} admin users created`);

// ─── Circles ────────────────────────────────────────────────
// A circle is a workspace, and Dev Circle is one instance of it. A second is
// seeded so the switcher, the scoping and the per-circle staff grants are
// visible rather than theoretical — the two share the same member accounts but
// nothing else: separate cohorts, surveys, sessions and feedback.
const devCircleId = uuid();
const merchantCircleId = uuid();

const circleStmt = db.prepare(`
  INSERT INTO circles (id, name, slug, description, color, created_by)
  VALUES (?, ?, ?, ?, ?, ?)
`);

circleStmt.run(devCircleId, 'Dev Circle', 'dev-circle',
  'Developers integrating the Credit Direct APIs', '#107EBC', admins[0].id);
circleStmt.run(merchantCircleId, 'Merchant Circle', 'merchant-circle',
  'Merchants and partners on the business products', '#945A39', admins[0].id);

// The workspace the rest of this seed builds out
const rootCircleId = devCircleId;

console.log('✓ 2 circles created (Dev Circle, Merchant Circle)');

// ─── Cohorts ────────────────────────────────────────────────
// System cohorts carry real filter_rules and auto_sync, so membership is
// derived and stays correct as members change rather than being a fixed list.
const cohorts = [
  {
    id: uuid(), name: 'All Members', description: 'Every registered user',
    type: 'system', color: '#A0A0B8', rules: null, auto_sync: 0
  },
  {
    id: uuid(), name: 'Fintech Partners', description: 'Fintech companies using our APIs',
    type: 'system', color: '#107EBC',
    rules: [{ field: 'work_sector', op: 'eq', value: 'Fintech' }], auto_sync: 1
  },
  {
    id: uuid(), name: 'KYB Completed', description: 'Users who completed Know Your Business',
    type: 'system', color: '#0D9488',
    rules: [{ field: 'kyb_completed', op: 'eq', value: 'yes' }], auto_sync: 1
  },
  {
    id: uuid(), name: 'Sandbox Users', description: 'Users in sandbox/testing phase',
    type: 'system', color: '#E6B473',
    rules: [{ field: 'api_status', op: 'eq', value: 'sandbox' }], auto_sync: 1
  },
  {
    id: uuid(), name: 'Production Users', description: 'Users with live production keys',
    type: 'system', color: '#16A34A',
    rules: [{ field: 'api_status', op: 'eq', value: 'production' }], auto_sync: 1
  },
  {
    id: uuid(), name: 'High Engagement', description: 'Members with 3+ completed surveys',
    type: 'system', color: '#E11D48',
    rules: [{ field: 'surveys_completed', op: 'gte', value: 3 }], auto_sync: 1
  },
  {
    id: uuid(), name: 'Mon/Wed/Fri Availability', description: 'Available on Mondays',
    type: 'custom', color: '#6B6B80',
    rules: [{ field: 'preferred_days', op: 'eq', value: 'Mon' }], auto_sync: 1
  },
  {
    id: uuid(), name: 'Banking Sector', description: 'Banking & financial services',
    type: 'custom', color: '#0B5A8A',
    rules: [{ field: 'work_sector', op: 'eq', value: 'Banking' }], auto_sync: 1
  },
  {
    id: uuid(), name: 'Lending Products', description: 'Integrating the lending APIs',
    type: 'custom', color: '#945A39',
    rules: [{ field: 'api_products', op: 'eq', value: 'lending' }], auto_sync: 1
  },
  {
    id: uuid(), name: 'Payment Products', description: 'Integrating the payment/transfer APIs',
    type: 'custom', color: '#C99A58',
    rules: [{ field: 'api_products', op: 'eq', value: 'payments' }], auto_sync: 1
  },
  {
    id: uuid(), name: 'Dormant', description: 'No activity in the last 30 days',
    type: 'custom', color: '#6B6B80',
    rules: [{ field: 'days_since_active', op: 'gte', value: 30 }], auto_sync: 1
  }
];

const cohortStmt = db.prepare(`
  INSERT INTO cohorts (id, name, description, type, color, filter_rules, auto_sync, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
for (const c of cohorts) {
  cohortStmt.run(
    c.id, c.name, c.description, c.type, c.color,
    c.rules ? JSON.stringify(c.rules) : null, c.auto_sync, admins[0].id
  );
}
console.log(`✓ ${cohorts.length} cohorts created`);

// ─── Developer Users ────────────────────────────────────────
const developers = [
  { name: 'Adebayo Martins', email: 'adebayo@paystack.dev', company: 'Paystack', work_sector: 'Fintech', api_status: 'production', kyb: 1, streak: 12, best: 12, dob: '1991-03-14', gender: 'male', state: 'Lagos', products: ['payments', 'identity'] },
  { name: 'Fatima Yusuf', email: 'fatima@moniepoint.ng', company: 'Moniepoint', work_sector: 'Fintech', api_status: 'sandbox', kyb: 0, streak: 3, best: 3, dob: '1996-07-02', gender: 'female', state: 'Lagos', products: ['payments'] },
  { name: 'Emeka Okafor', email: 'emeka@kuda.ng', company: 'Kuda Bank', work_sector: 'Banking', api_status: 'production', kyb: 1, streak: 8, best: 11, dob: '1988-11-23', gender: 'male', state: 'Lagos', products: ['lending', 'payments'] },
  { name: 'Chioma Adeyemi', email: 'chioma@flutter.co', company: 'Flutterwave', work_sector: 'Fintech', api_status: 'production', kyb: 1, streak: 6, best: 9, dob: '1993-01-30', gender: 'female', state: 'Lagos', products: ['payments'] },
  { name: 'Oluwaseun Ibrahim', email: 'oluwaseun@cowrywise.com', company: 'Cowrywise', work_sector: 'Fintech', api_status: 'sandbox', kyb: 0, streak: 0, best: 0, dob: '1999-05-19', gender: 'male', state: 'Oyo', products: [] },
  { name: 'Ngozi Nwankwo', email: 'ngozi@opay.ng', company: 'OPay', work_sector: 'Fintech', api_status: 'production', kyb: 1, streak: 5, best: 7, dob: '1990-09-08', gender: 'female', state: 'Lagos', products: ['payments', 'lending'] },
  { name: 'Yusuf Abdullahi', email: 'yusuf@palmpay.ng', company: 'PalmPay', work_sector: 'Fintech', api_status: 'sandbox', kyb: 0, streak: 2, best: 2, dob: '1997-12-11', gender: 'male', state: 'Kano', products: ['payments'] },
  { name: 'Blessing Eze', email: 'blessing@interswitch.ng', company: 'Interswitch', work_sector: 'Payments', api_status: 'production', kyb: 1, streak: 4, best: 6, dob: '1986-04-27', gender: 'female', state: 'Lagos', products: ['payments', 'identity'] },
  { name: 'Ibrahim Musa', email: 'ibrahim@carbon.ng', company: 'Carbon', work_sector: 'Lending', api_status: 'production', kyb: 1, streak: 7, best: 7, dob: '1992-08-16', gender: 'male', state: 'Abuja', products: ['lending', 'credit_scoring'] },
  { name: 'Funke Akindele', email: 'funke@fairmoney.ng', company: 'FairMoney', work_sector: 'Lending', api_status: 'sandbox', kyb: 0, streak: 1, best: 1, dob: '1995-02-05', gender: 'female', state: 'Lagos', products: ['lending'] },
  { name: 'Chidi Obi', email: 'chidi@chipper.ng', company: 'Chipper Cash', work_sector: 'Fintech', api_status: 'production', kyb: 1, streak: 9, best: 14, dob: '1989-06-21', gender: 'male', state: 'Rivers', products: ['payments'] },
  { name: 'Amina Bello', email: 'amina@vfd.ng', company: 'VFD Microfinance', work_sector: 'Banking', api_status: 'sandbox', kyb: 0, streak: 0, best: 0, dob: '1994-10-03', gender: 'female', state: 'Kaduna', products: [] },
  { name: 'David Okonkwo', email: 'david@greenshelf.ng', company: 'GreenShelf', work_sector: 'Lending', api_status: 'production', kyb: 1, streak: 3, best: 5, dob: '1998-03-09', gender: 'male', state: 'Enugu', products: ['lending', 'credit_scoring'] },
  { name: 'Kemi Adeola', email: 'kemi@lendsqr.ng', company: 'Lendsqr', work_sector: 'Lending', api_status: 'sandbox', kyb: 1, streak: 2, best: 4, dob: '1991-11-14', gender: 'female', state: 'Lagos', products: ['lending'] },
  { name: 'Tunde Johnson', email: 'tunde@remita.net', company: 'Remita', work_sector: 'Payments', api_status: 'production', kyb: 1, streak: 11, best: 11, dob: '1985-07-25', gender: 'male', state: 'Lagos', products: ['payments', 'identity'] }
];

const userStmt = db.prepare(`
  INSERT INTO users (
    id, email, name, phone, phone_normalized, password_hash, company, work_sector, api_status, kyb_completed,
    engagement_streak, best_streak, preferred_channels, preferred_days,
    date_of_birth, gender, location_state, api_products, dev_hub_user_id,
    last_active_at, last_engagement_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?), datetime('now', ?))
`);

const cohortAssignStmt = db.prepare('INSERT OR IGNORE INTO user_cohorts (user_id, cohort_id) VALUES (?, ?)');
const allCohortId = cohorts[0].id;

const channels = [
  '["email","in_portal"]',
  '["email","whatsapp"]',
  '["email"]',
  '["whatsapp","in_portal"]',
  '["email","whatsapp","in_portal"]'
];

const days = [
  '["Mon","Wed","Fri"]',
  '["Mon","Tue","Wed","Thu","Fri"]',
  '["Tue","Thu"]',
  '["Mon","Wed"]',
  '["Sat","Sun"]'
];

for (let i = 0; i < developers.length; i++) {
  const d = developers[i];
  const id = uuid();
  const phone = `+234${700 + Math.floor(Math.random() * 300)}${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`;
  const hoursAgo = Math.floor(Math.random() * 168);

  // Members hold no password: they sign in with their address and the last six
  // digits of the number below, generated per member on the email
  // or number seeded here, so there is nothing to publish for them.
  userStmt.run(
    id, d.email, d.name, phone, normalizePhone(phone), NO_PASSWORD,
    d.company, d.work_sector, d.api_status, d.kyb ? 1 : 0,
    d.streak, d.best,
    channels[i % channels.length],
    days[i % days.length],
    d.dob, d.gender, d.state, JSON.stringify(d.products),
    `hub_${d.email.split('@')[0]}`,
    `-${hoursAgo} hours`,
    `-${d.streak > 0 ? Math.floor(Math.random() * 20) : 90} days`,
    '-60 days'
  );

  cohortAssignStmt.run(id, allCohortId);
  d._id = id;
}
console.log(`✓ ${developers.length} developer users created`);

// ─── Surveys ────────────────────────────────────────────────
const surveys = [
  {
    id: uuid(), title: 'Onboarding Experience Feedback', description: 'Help us understand your first impressions',
    questions: [
      { id: 'q1', type: 'rating', text: 'How easy was the registration process?', scale: 5, required: true, label_low: 'A struggle', label_high: 'Effortless' },
      { id: 'q2', type: 'rating', text: 'How clear was the initial documentation?', scale: 5, required: true },
      { id: 'q3', type: 'choice', text: 'What brought you to Credit Direct APIs?', options: ['Business integration', 'Personal project', 'Evaluation', 'Client requirement'], allow_other: true, required: true },
      { id: 'q4', type: 'text', text: 'What could we improve about the onboarding?' },
      // Only asked of the people who found it hard — the ones who breezed
      // through have nothing to say here and being asked anyway is the cost
      { id: 'q5', type: 'text', text: 'What nearly stopped you from finishing?',
        visible_if: { match: 'all', rules: [{ question: 'q1', op: 'lte', value: 3 }] } }
    ],
    target_type: 'all', engagement_mode: 'in_portal', time_estimate_min: 3,
    trigger_event: 'api_key_generated'
  },
  {
    id: uuid(), title: 'API Documentation Clarity', description: 'Rate the quality of our developer docs',
    questions: [
      { id: 'q1', type: 'matrix', text: 'How would you rate each part of the documentation?',
        rows: ['Authentication', 'Endpoints reference', 'Error handling', 'Webhooks'],
        columns: ['Poor', 'Adequate', 'Good', 'Excellent'], required: true },
      { id: 'q2', type: 'multi_choice', text: 'Which of these have cost you time?',
        options: ['Missing examples', 'Out-of-date responses', 'No sandbox equivalents', 'Unclear error codes', 'None of these'],
        exclusive_options: ['None of these'], min_select: 1, required: true },
      { id: 'q3', type: 'ranking', text: 'Put these in the order you would have them fixed',
        options: ['More code examples', 'A Postman collection', 'Clearer errors', 'Webhook guides'] },
      { id: 'q4', type: 'text', text: 'Which example would have saved you the most time?' }
    ],
    target_type: 'all', engagement_mode: 'in_portal', time_estimate_min: 5,
    theme: { accent: '#0D9488', progress: 'steps' }
  },
  {
    id: uuid(), title: 'Sandbox → Production Journey', description: 'Tell us about your path to going live',
    questions: [
      { id: 'q1', type: 'nps', text: 'How likely are you to recommend our APIs to another developer?',
        required: true, label_low: 'Not at all likely', label_high: 'Extremely likely' },
      { id: 'q2', type: 'multi_choice', text: 'What went wrong?',
        options: ['KYB process', 'API configuration', 'Testing limitations', 'Documentation gaps', 'Support response time'],
        min_select: 1, max_select: 3, allow_other: true, required: true,
        visible_if: { match: 'all', rules: [{ question: 'q1', op: 'lte', value: 6 }] } },
      { id: 'q3', type: 'text', text: 'What is working well enough that we should not touch it?',
        visible_if: { match: 'all', rules: [{ question: 'q1', op: 'gte', value: 9 }] } },
      { id: 'q4', type: 'section', text: 'About your integration' },
      { id: 'q5', type: 'date', text: 'When did you make your first production call?' },
      { id: 'q6', type: 'number', text: 'Roughly how many calls do you make on a normal day?',
        min: 0, integer: true, unit: 'calls/day' },
      { id: 'q7', type: 'text', text: 'What would have made the journey faster?' }
    ],
    target_type: 'cohort', target_ids: [cohorts[4].id], engagement_mode: 'email', time_estimate_min: 4,
    trigger_event: 'first_production_call', reminder_after_days: 5,
    theme: {
      accent: '#E6B473', background: 'tinted',
      intro: {
        headline: 'You made it to production',
        body: 'Four minutes on how the journey went. Your answers go to the engineers building the APIs you integrate with — not to a ticket queue.',
        button: 'Tell them'
      },
      thank_you: { headline: 'Noted, and read', body: 'Every answer here is read by the team before the next release is planned.' }
    }
  },
  {
    // The audience you cannot reach any other way: developers who gave up
    // before they ever registered. There is no cohort for people who are not
    // members, so the link is the only way to ask them.
    id: uuid(), title: 'What stopped you finishing the sandbox setup?',
    description: 'Three questions, no account needed. From the team that builds the sandbox.',
    target_type: 'anonymous',
    public_token: 'demo' + crypto.randomBytes(18).toString('base64url'),
    questions: [
      { id: 'q1', type: 'choice', text: 'How far did you get?',
        options: ['Never got a key', 'Got a key, no successful call', 'Made calls, then stopped', 'Still trying'],
        required: true },
      { id: 'q2', type: 'multi_choice', text: 'What got in the way?',
        options: ['Documentation', 'Sign-up itself', 'Waiting on approval', 'Errors I could not decode', 'Chose another provider'],
        min_select: 1, allow_other: true, required: true },
      { id: 'q3', type: 'text', text: 'What would have kept you going?' }
    ],
    engagement_mode: 'in_portal', time_estimate_min: 2,
    theme: {
      background_color: '#0B1F2A', text_color: '#EAF4F7', accent: '#2DD4BF', corner: 'round',
      intro: {
        headline: 'You did not finish. We would like to know why.',
        body: 'Two minutes, no sign-in, and nothing here identifies you. It goes to the engineers who own the sandbox.',
        button: 'Tell them'
      },
      thank_you: { headline: 'Thank you — that is exactly what we needed', body: 'No account, no follow-up, no marketing. Just the answer.' }
    }
  },
  {
    id: uuid(), title: 'KYB Process Feedback', description: 'Rate your KYB verification experience',
    questions: [
      { id: 'q1', type: 'rating', text: 'How would you rate the KYB process?', scale: 5, style: 'stars', required: true },
      { id: 'q2', type: 'boolean', text: 'Were the document requirements clear before you started?',
        true_label: 'Yes, clear', false_label: 'No, I had to guess', required: true },
      { id: 'q3', type: 'choice', text: 'How long did KYB take?',
        options: ['Less than 24 hours', '1-3 days', '3-7 days', 'More than a week'], required: true },
      { id: 'q4', type: 'text', text: 'What was unclear?',
        visible_if: { match: 'all', rules: [{ question: 'q2', op: 'is', value: false }] } }
    ],
    target_type: 'cohort', target_ids: [cohorts[2].id], engagement_mode: 'email', time_estimate_min: 3,
    trigger_event: 'kyb_completed', reminder_after_days: 7
  }
];

const surveyStmt = db.prepare(`
  INSERT INTO surveys (id, title, description, questions, theme, status, target_type, target_ids,
                       engagement_mode, time_estimate_min, trigger_event, reminder_after_days,
                       public_token, created_by)
  VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
`);

// ─── From here down, one await ──────────────────────────────
// Normalising a survey definition reaches the questions table, and that read
// is async now — so everything downstream of it is too. Wrapped rather than
// scattered: a seed script is a straight line, and the alternative is an
// await in the middle of a file that otherwise reads top to bottom.
(async () => {

  for (const s of surveys) {
    // Through the same door an authored survey goes through, so seeded data
    // carries question identities the same way — and so a seed that drifts out
    // of what a survey may contain fails here rather than in front of a member.
    const definition = await surveyForm.normalizeDefinition(s, { createdBy: admins[0].id });
    if (definition.issues.length) {
      throw new Error(`Seed survey "${s.title}": ${surveyForm.issueSummary(definition.issues)}`);
    }
    s.questions = definition.questions;

    surveyStmt.run(
      s.id, s.title, s.description, JSON.stringify(s.questions),
      definition.theme ? JSON.stringify(definition.theme) : null,
      s.target_type, JSON.stringify(s.target_ids || []),
      s.engagement_mode, s.time_estimate_min,
      s.trigger_event || null, s.reminder_after_days || null,
      s.public_token || null, admins[0].id
    );
  }
  console.log(`✓ ${surveys.length} surveys created (${db.prepare('SELECT COUNT(*) c FROM questions').get().c} questions)`);

  // ─── Survey Responses ───────────────────────────────────────
  const responseStmt = db.prepare(`
    INSERT INTO survey_responses (id, survey_id, user_id, answers, completed_at, triggered_by)
    VALUES (?, ?, ?, ?, datetime('now', ?), ?)
  `);

  // Written answers, so the verbatims a survey collects read like things a
  // person actually typed rather than "Sample feedback text" repeated 30 times
  const VERBATIMS = [
    'The webhook retry intervals are documented as "every few minutes" — I need the actual schedule to build idempotency properly.',
    'Sandbox rate limits are far tighter than production, so load testing tells me nothing useful.',
    'KYB took eight days and the status page never moved. I only found out we were approved by trying a call.',
    'Error bodies say "unauthorized" whether the key is wrong, expired, or lacks a scope. Three very different fixes.',
    'The Postman collection is a version behind the docs. Lost half a day to that.',
    'Honestly the onboarding was the smoothest of any Nigerian provider we have integrated.',
    'Would like a way to rotate keys without downtime — right now it is a hard cutover.',
    'Transfer status webhooks arrive before the GET reflects the same state, so we poll anyway.',
    'Docs assume Node. Our stack is Go and the examples do not translate cleanly.',
    'Support answered in under two hours on a production issue. That is why we stayed.'
  ];

  const pick = list => list[Math.floor(Math.random() * list.length)];
  const between = (from, to) => from + Math.floor(Math.random() * (to - from + 1));

  // One plausible answer to one question. Kept honest about the shape each type
  // expects, because seeded data that a live submission would have refused is
  // data every screen then has to be defensive about.
  function inventAnswer(q) {
    // An answer is the word an option is held under — the label of a card,
    // the word itself otherwise. Seeding a card would put a shape in the data
    // where every screen expects words.
    const words = (q.options || []).map(o => surveyForm.optionLabel(o));
    switch (q.type) {
      case 'rating': return between(1, q.scale || 5);
      case 'nps': return between(0, 10);
      case 'number': return between(q.min ?? 50, Math.min(q.max ?? 5000, 5000));
      case 'date': return new Date(Date.now() - between(30, 400) * 86400000).toISOString().slice(0, 10);
      case 'boolean': return Math.random() > 0.4;
      case 'choice':
      case 'dropdown': return pick(words);
      case 'multi_choice': {
        const exclusive = q.exclusive_options || [];
        // Sometimes the "None of these" answer, which is the one that has to
        // stand alone — worth having in the data so the screens meet it
        if (exclusive.length && Math.random() > 0.75) return [pick(exclusive)];
        const open = words.filter(o => !exclusive.includes(o));
        const most = Math.min(q.max_select || open.length, open.length);
        const many = between(Math.max(1, q.min_select || 1), most);
        return open.slice().sort(() => Math.random() - 0.5).slice(0, many);
      }
      case 'ranking': return words.slice().sort(() => Math.random() - 0.5);
      case 'matrix':
        return Object.fromEntries(q.rows.map(row => [row, pick(q.columns)]));
      case 'text':
        return q.format ? null : pick(VERBATIMS);
      default:
        return null;
    }
  }

  let responseCount = 0;
  for (const dev of developers) {
    for (const survey of surveys) {
      // A link survey is answered by people who are not members, so putting
      // member responses against it would seed a state that cannot occur
      if (survey.target_type === 'anonymous') continue;
      if (Math.random() > 0.4) {
        const answers = {};

        // Answered in order, re-reading what is on offer after each one, so a
        // branch only gets an answer when this member's earlier answers actually
        // opened it. Answering the whole list would seed responses no member
        // could have given.
        for (const q of survey.questions) {
          if (!surveyForm.isAnswerable(q)) continue;
          if (!surveyForm.visible(survey.questions, answers).some(shown => shown.id === q.id)) continue;
          // Optional questions go unanswered sometimes, which is what makes a
          // response rate mean anything
          if (!q.required && Math.random() > 0.65) continue;

          const invented = inventAnswer(q);
          if (invented !== null) answers[q.id] = invented;
        }

        // The same check a submission goes through. A seed that drifts out of
        // what a survey accepts fails here rather than becoming data every
        // screen has to be defensive about.
        const checked = surveyForm.checkResponse(survey.questions, answers);
        if (!checked.ok) {
          throw new Error(`Seed response to "${survey.title}": ${JSON.stringify(checked.errors)}`);
        }

        const completedDaysAgo = Math.floor(Math.random() * 30);
        responseStmt.run(
          uuid(), survey.id, dev._id, JSON.stringify(answers),
          `-${completedDaysAgo} days`, 'manual'
        );

        // Free-text answers are filed with the rest of the member's feedback,
        // the same way a live submission does it
        verbatims.record(dev._id, survey, answers, {
          at: new Date(Date.now() - completedDaysAgo * 86400000).toISOString().slice(0, 19).replace('T', ' ')
        });

        responseCount++;
      }
    }
  }

  // ─── Answers from people with no account ────────────────────
  // The link survey's respondents. They have no user row by definition, which is
  // the state every screen reading responses has to cope with — so the demo data
  // contains it rather than leaving it to be discovered in production.
  const anonymousResponse = db.prepare(`
    INSERT INTO survey_responses (id, survey_id, user_id, respondent_kind, anonymous_key_hash,
                                  answers, completed_at, triggered_by)
    VALUES (?, ?, NULL, 'anonymous', ?, ?, datetime('now', ?), 'link')
  `);

  let anonymousCount = 0;
  for (const survey of surveys.filter(s => s.target_type === 'anonymous')) {
    for (let i = 0; i < 14; i++) {
      const answers = {};
      for (const q of survey.questions) {
        if (!surveyForm.isAnswerable(q)) continue;
        if (!surveyForm.visible(survey.questions, answers).some(shown => shown.id === q.id)) continue;
        if (!q.required && Math.random() > 0.55) continue;
        const invented = inventAnswer(q);
        if (invented !== null) answers[q.id] = invented;
      }

      const checked = surveyForm.checkResponse(survey.questions, answers);
      if (!checked.ok) throw new Error(`Seed link response: ${JSON.stringify(checked.errors)}`);

      const id = uuid();
      const daysAgo = Math.floor(Math.random() * 21);
      anonymousResponse.run(
        id, survey.id,
        crypto.createHash('sha256').update(uuid()).digest('hex'),
        JSON.stringify(checked.answers), `-${daysAgo} days`
      );

      // Filed as evidence the same way a member's words are, minus the member
      verbatims.record(null, survey, checked.answers, {
        responseId: id,
        at: new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 19).replace('T', ' ')
      });
      anonymousCount++;
    }
  }

  db.prepare('UPDATE feedback SET circle_id = ? WHERE circle_id IS NULL').run(rootCircleId);
  db.prepare('UPDATE questions SET circle_id = ? WHERE circle_id IS NULL').run(rootCircleId);

  const verbatimCount = db.prepare("SELECT COUNT(*) c FROM feedback WHERE source = 'survey'").get().c;
  console.log(`✓ ${responseCount} survey responses created (${verbatimCount} verbatims filed as feedback)`);
  console.log(`✓ ${anonymousCount} answered over a public link, with no account`);

  // ─── Engagement History ─────────────────────────────────────
  const ehStmt = db.prepare(`
    INSERT INTO engagement_history (id, user_id, type, source, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', ?))
  `);

  let ehCount = 0;
  for (const dev of developers) {
    ehStmt.run(uuid(), dev._id, 'account_created', 'landing_page', '{}', '-60 days');
    ehCount++;

    if (dev.api_status === 'production') {
      ehStmt.run(uuid(), dev._id, 'api_key_generated', 'customer_io', '{}', '-50 days');
      ehStmt.run(uuid(), dev._id, 'first_sandbox_call', 'customer_io', '{}', '-45 days');
      ehStmt.run(uuid(), dev._id, 'first_production_call', 'customer_io', '{}', '-30 days');
      ehCount += 3;
    } else {
      ehStmt.run(uuid(), dev._id, 'api_key_generated', 'customer_io', '{}', '-20 days');
      ehCount++;
    }

    if (dev.kyb) {
      ehStmt.run(uuid(), dev._id, 'kyb_completed', 'customer_io', '{}', '-40 days');
      ehCount++;
    }
  }
  console.log(`✓ ${ehCount} engagement history events created`);

  // ─── Feedback ───────────────────────────────────────────────
  const feedbackData = [
    { user: 0, content: 'The webhook retry logic documentation is unclear. It says retries happen "every few minutes" but doesn\'t specify the exact intervals.', category: 'documentation', source: 'dev_circle' },
    { user: 2, content: 'Would love to see a sandbox mode for the transfer API that simulates different bank response times.', category: 'feature_request', source: 'dev_circle' },
    { user: 4, content: 'Getting 429 errors even within the documented rate limits. Happens during peak testing hours.', category: 'api', source: 'dev_circle' },
    { user: 1, content: 'KYB process took 8 days. The status tracker didn\'t update in real-time, had to email support.', category: 'support', source: 'feex', external_ticket_id: 'FEEX-2026-1847', feex_status: 'in_progress', feex_priority: 'high' },
    { user: 6, content: 'The error messages for invalid API keys could be more descriptive. Just says "unauthorized" without details.', category: 'api', source: 'dev_circle' },
    { user: 8, content: 'Excellent support from the dev relations team. Response within 2 hours for a critical production issue.', category: 'support', source: 'feex', external_ticket_id: 'FEEX-2026-2103' }
  ];

  const fbStmt = db.prepare(`
    INSERT INTO feedback (id, user_id, type, content, category, status, source, external_ticket_id,
                          feex_status, feex_priority, feex_url, feex_updated_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))
  `);

  for (let i = 0; i < feedbackData.length; i++) {
    const f = feedbackData[i];
    const isFeex = f.source === 'feex';
    fbStmt.run(
      uuid(), developers[f.user]._id, isFeex ? 'feex_complaint' : 'self_initiated',
      f.content, f.category, i < 3 ? 'open' : 'reviewed',
      f.source, f.external_ticket_id || null,
      // Feex owns these states; Dev Circle only mirrors what Feex last reported
      isFeex ? f.feex_status : null,
      isFeex ? f.feex_priority : null,
      isFeex ? `https://feex.creditdirect.ng/tickets/${f.external_ticket_id}` : null,
      isFeex ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
      `-${Math.floor(Math.random() * 14)} days`
    );
  }
  console.log(`✓ ${feedbackData.length} feedback entries created`);

  // ─── Gifts ──────────────────────────────────────────────────
  // Gifts now carry real eligibility rules, so the developer-facing catalogue
  // can distinguish "available to you" from "keep going to unlock".
  const gifts = [
    { id: uuid(), name: '₦5,000 Airtime Credit', description: 'Airtime top-up for any Nigerian network', value: 5000, min_surveys: 1, min_streak: 0, stock: null },
    { id: uuid(), name: 'Dev Circle Branded Notebook', description: 'Premium notebook with Dev Circle branding', value: 3000, min_surveys: 2, min_streak: 0, stock: 50 },
    { id: uuid(), name: '₦10,000 Data Bundle', description: 'Monthly data subscription', value: 10000, min_surveys: 3, min_streak: 3, stock: 25 },
    { id: uuid(), name: 'DevFest Lagos 2026 Ticket', description: 'Conference pass, travel not included', value: 25000, min_surveys: 4, min_streak: 5, stock: 10 }
  ];

  const giftStmt = db.prepare(`
    INSERT INTO gifts (id, name, description, value, currency, stock, min_surveys_completed, min_streak, active)
    VALUES (?, ?, ?, ?, 'NGN', ?, ?, ?, 1)
  `);
  for (const g of gifts) {
    giftStmt.run(g.id, g.name, g.description, g.value, g.stock, g.min_surveys, g.min_streak);
  }
  console.log(`✓ ${gifts.length} gifts created`);

  // A few claims so the admin view is not empty
  const claimStmt = db.prepare('INSERT OR IGNORE INTO user_gifts (id, user_id, gift_id, claimed_at) VALUES (?, ?, ?, datetime(\'now\', ?))');
  let claimCount = 0;
  for (const dev of developers) {
    if (dev.streak >= 5) {
      claimStmt.run(uuid(), dev._id, gifts[0].id, '-10 days');
      claimCount++;
    }
  }
  console.log(`✓ ${claimCount} gift claims created`);

  // ─── Consent ────────────────────────────────────────────────
  const grantStmt = db.prepare(`
    INSERT INTO consent (id, user_id, channel, status, granted_at)
    VALUES (?, ?, ?, 'granted', datetime('now', '-30 days'))
  `);
  const withdrawStmt = db.prepare(`
    INSERT INTO consent (id, user_id, channel, status, granted_at, withdrawn_at)
    VALUES (?, ?, ?, 'withdrawn', datetime('now', '-30 days'), datetime('now', '-5 days'))
  `);

  let consentCount = 0;
  for (const [i, dev] of developers.entries()) {
    const userPrefs = JSON.parse(channels[i % channels.length] || '[]');
    // Setting engagement channels automatically grants consent for them
    const grantedChs = new Set(['email', 'in_portal', ...userPrefs]);
    for (const ch of grantedChs) {
      grantStmt.run(uuid(), dev._id, ch);
      consentCount++;
    }
    if (!grantedChs.has('sms') && i % 3 === 1) {
      withdrawStmt.run(uuid(), dev._id, 'sms');
      consentCount++;
    }
  }
  console.log(`✓ ${consentCount} consent records created`);

  // ─── Circle membership ──────────────────────────────────────
  const circleMemberStmt = db.prepare('INSERT OR IGNORE INTO circle_members (circle_id, user_id, role) VALUES (?, ?, ?)');

  let circleMemberCount = 0;
  for (const dev of developers) {
    circleMemberStmt.run(devCircleId, dev._id, 'member');
    circleMemberCount++;

    // One account, several workspaces: a few of these developers also work on
    // the business products, so they are in both circles. Nothing else is shared.
    if (dev.work_sector === 'Payments' || dev.company === 'Interswitch') {
      circleMemberStmt.run(merchantCircleId, dev._id, 'member');
      circleMemberCount++;
    }
  }
  console.log(`✓ ${circleMemberCount} circle memberships across 2 circles`);

  // Staff hold a role within a circle. Adaeze spans both as Credit Direct staff;
  // Tunde works in Dev Circle only, and cannot see Merchant Circle at all.
  const staffGrantStmt = db.prepare('INSERT OR IGNORE INTO circle_admins (circle_id, admin_id, role_id) VALUES (?, ?, ?)');
  db.prepare('UPDATE admin_users SET is_global = 1 WHERE id = ?').run(admins[0].id);
  staffGrantStmt.run(devCircleId, admins[0].id, admins[0].role_id);
  staffGrantStmt.run(merchantCircleId, admins[0].id, admins[0].role_id);
  staffGrantStmt.run(devCircleId, admins[1].id, admins[1].role_id);
  console.log('✓ staff granted per circle (Adaeze: both, Tunde: Dev Circle only)');

  // Everything created above belongs to the workspace it was made in
  for (const table of ['cohorts', 'surveys', 'gifts']) {
    db.prepare(`UPDATE ${table} SET circle_id = ? WHERE circle_id IS NULL`).run(rootCircleId);
  }

  // ─── Scheduled sessions ─────────────────────────────────────
  // Dated engagements with automated lead-up reminders, so "upcoming scheduled
  // info/Test" is something members can actually see and be reminded about.
  const sessions = [
    {
      id: uuid(), title: 'Q3 API Roadmap Walkthrough', type: 'info',
      description: 'What is shipping next quarter, and what we need your input on.',
      circle_id: rootCircleId, target_type: 'all', target_ids: [],
      offset_days: 6, hour: 11, duration: 45, location: 'Google Meet',
      channels: ['in_portal', 'email'], reminders: [1440, 60]
    },
    {
      id: uuid(), title: 'Lending API v2 Preview', type: 'workshop',
      description: 'Hands-on session on the v2 lending endpoints before general availability.',
      circle_id: rootCircleId, target_type: 'cohort', target_ids: [cohorts[8].id],
      offset_days: 10, hour: 14, duration: 90, location: 'Lagos office + remote',
      channels: ['in_portal', 'email', 'whatsapp'], reminders: [2880, 1440, 60]
    },
    {
      id: uuid(), title: 'Sandbox Load Test Window', type: 'test',
      description: 'Coordinated load test against the sandbox. Bring your integration.',
      circle_id: rootCircleId, target_type: 'cohort', target_ids: [cohorts[4].id],
      offset_days: 3, hour: 10, duration: 120, location: 'Remote',
      channels: ['in_portal', 'email'], reminders: [1440, 120]
    }
  ];

  const sessionStmt = db.prepare(`
    INSERT INTO scheduled_sessions (
      id, title, description, type, circle_id, target_type, target_ids,
      scheduled_for, duration_min, location, channels, reminder_offsets, status, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)
  `);

  for (const s of sessions) {
    const when = new Date(Date.now() + s.offset_days * 86400000);
    when.setUTCHours(s.hour - 1, 0, 0, 0); // stored UTC, expressed to members in WAT
    sessionStmt.run(
      s.id, s.title, s.description, s.type, s.circle_id, s.target_type,
      JSON.stringify(s.target_ids), when.toISOString().replace('T', ' ').slice(0, 19),
      s.duration, s.location, JSON.stringify(s.channels),
      JSON.stringify(s.reminders), admins[0].id
    );
  }
  console.log(`✓ ${sessions.length} scheduled sessions created`);

  // ─── Cohort membership from rules ───────────────────────────
  // Requires the rows above to exist, so it runs last.
  const cohortRules = require('../services/cohortRules');
  const syncResults = await cohortRules.syncAll();
  const totalAssigned = syncResults.reduce((sum, r) => sum + (r.added || 0), 0);
  console.log(`✓ ${totalAssigned} cohort memberships derived from rules across ${syncResults.length} cohorts`);

  // ─── Bootstrap API key ──────────────────────────────────────
  // Integration endpoints now require a key. Print one so the landing page,
  // Customer.io, and Feex can be wired up immediately.
  const { key: bootstrapKey } = generateApiKey();
  db.prepare(`
    INSERT INTO api_keys (id, key_hash, name, prefix, permissions, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    uuid(), hashApiKey(bootstrapKey), 'Bootstrap integration key',
    bootstrapKey.split('_')[1], JSON.stringify(['*']), admins[0].id
  );

  // ─── Done ───────────────────────────────────────────────────
  console.log('\n✅ Seed complete!');
  console.log('\nSign in at / with any of these — one form, no role to pick:');
  console.log('  Admin (full access):  admin@creditdirect.ng      password: admin123');
  console.log('  CDL Rep (limited):    engagement@creditdirect.ng password: engagement123');
  console.log('  Developer:            adebayo@paystack.dev       last 6 digits of their phone');
  console.log('\nA Credit Direct domain gets asked for a password; everyone else for the last six');
  console.log('digits of the number on their record. Seeded developers get a random number, so');
  console.log('take the digits from the members list — or use a demo developer, whose number is fixed.');
  console.log('\nIntegration API key (shown once — endpoints reject unauthenticated calls):');
  console.log(`  ${bootstrapKey}`);


})().catch(err => {
  // A seed that half-ran is worse than one that did not: it leaves a database
  // that looks populated and is missing whatever came after the failure.
  console.error('\n✗ Seed failed:', err.message);
  process.exitCode = 1;
});