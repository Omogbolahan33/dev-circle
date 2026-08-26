const crypto = require('crypto');
const db = require('../db');
const { uuid, parseJSON } = require('../utils/helpers');
const identity = require('../utils/identity');
const surveyForm = require('./surveyForm');
const notifications = require('./notifications');
const engagement = require('./engagement');
const circles = require('./circles');
const cohortRules = require('./cohortRules');

// ─── Onboarding forms ───────────────────────────────────────
// A form a circle publishes to be filled in by people who are not members yet,
// on pages this platform does not own.
//
// It is built out of the same parts a survey is — the question schema, the
// branching rules and the theme engine under public/assets/js — because those
// are the parts worth having twice as much as once, and having them once is
// what keeps the two kinds of form behaving identically. What is added here is
// everything that follows from a form being about *a person* rather than about
// an opinion:
//
//   · Some answers are facts, not answers. "What company do you work for?" is
//     a column on users, and the mapping from question to column is what makes
//     a free-written form produce a profile. See FIELDS.
//   · Nothing it collects becomes a member on its own. A submission is an
//     application that an administrator approves; see the migration for why an
//     unauthenticated public endpoint must not write to users.
//   · It is embedded elsewhere, so it names the origins allowed to frame it.
//
// Deliberately not here: filing free-written answers as feedback the way a
// survey response does. A verbatim is evidence from a member, and it is stored
// against the survey that drew it out; an applicant is neither. Their words are
// held on the submission until there is a person to attribute them to.

// ─── What a question can populate ───────────────────────────
// Onboarding asks whatever the circle wants to ask, in whatever words, in
// whatever order, with whatever branching. What makes it onboarding rather than
// a survey is that some of those questions are understood: an answer tagged
// `email` is the address the account is created against, whether the question
// reads "What's your email?" or "Where should we send your invitation?".
//
// The tag lives on the question rather than in a lookup beside it, so moving a
// question, duplicating it or branching around it carries the meaning with it.
//
// `types` is what may carry the field, and it is narrow on purpose. A date of
// birth collected as free text is a column full of "early 90s".

const FIELDS = {
  email: {
    label: 'Email address',
    hint: 'The address the account is created against',
    column: 'email',
    types: ['text'],
    essential: true
  },
  name: {
    label: 'Full name',
    hint: 'What we call them everywhere in the platform',
    column: 'name',
    types: ['text'],
    essential: true
  },
  phone: {
    label: 'Phone number',
    hint: 'Used for SMS and WhatsApp, once they consent to those',
    column: 'phone',
    types: ['text']
  },
  company: {
    label: 'Company',
    column: 'company',
    types: ['text', 'choice', 'dropdown']
  },
  work_sector: {
    label: 'Work sector',
    hint: 'Cohorts are built on this, so a list beats free text',
    column: 'work_sector',
    types: ['text', 'choice', 'dropdown']
  },
  location_state: {
    label: 'Location',
    column: 'location_state',
    types: ['text', 'choice', 'dropdown']
  },
  gender: {
    label: 'Gender',
    column: 'gender',
    types: ['text', 'choice', 'dropdown']
  },
  date_of_birth: {
    label: 'Date of birth',
    column: 'date_of_birth',
    types: ['date']
  },
  api_products: {
    label: 'API products',
    hint: 'Which product families they integrate against',
    column: 'api_products',
    types: ['multi_choice', 'ranking', 'choice', 'dropdown'],
    list: true
  },
  dev_hub_user_id: {
    label: 'Developer hub ID',
    hint: 'Links this account to an existing dev portal account',
    column: 'dev_hub_user_id',
    types: ['text']
  },
  preferred_channels: {
    label: 'Preferred channels',
    hint: 'How they would rather be reached. Not the same as consent.',
    column: 'preferred_channels',
    types: ['multi_choice'],
    list: true,
    channels: true
  },
  preferred_days: {
    label: 'Preferred days',
    hint: 'Which days suit them for a session',
    column: 'preferred_days',
    types: ['multi_choice'],
    list: true
  },
  // Not a column. Every option ticked becomes a granted consent row, which is
  // the record that permits us to message them on that channel at all.
  consent_channels: {
    label: 'Consent to contact',
    hint: 'Ticking an option grants consent for that channel',
    types: ['multi_choice'],
    list: true,
    channels: true,
    consent: true
  }
};

const FIELD_KEYS = new Set(Object.keys(FIELDS));

// The days a session can be offered on, matched the same forgiving way channels
// are — an author writes "Tuesday", not "tue".
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// An author writes option labels for people to read: "WhatsApp", "E-mail",
// "A phone call", "In the portal". Those have to become the channel keys the
// rest of the platform speaks.
//
// Matched on what the label contains rather than on the whole of it, because
// the whole of it is a sentence somebody wrote for a person to read and will
// never be an exact key. Two rules keep that from becoming guesswork:
//
//   · An option that names more than one channel — "Email or SMS" — folds to
//     nothing. Picking the first match would file a tick against one channel
//     and silently drop permission for the other, and consent is the last
//     place to be resolving an ambiguity on the author's behalf.
//   · An option that names none folds to nothing too. Both are refused when
//     the form is saved, with the option quoted back, rather than losing
//     somebody's consent quietly at submission time.
const CHANNEL_WORDS = [
  ['whatsapp',                          'whatsapp'],
  ['inportal|inapp|portal|devcircle',   'in_portal'],
  ['email|mail',                        'email'],
  ['sms|text',                          'sms'],
  ['call|phone|voice',                  'calls']
];

function foldChannel(option) {
  const value = String(option || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!value) return null;

  // An exact channel key wins outright, so a form built by an integration
  // rather than by hand needs none of the guessing below.
  if (notifications.CHANNELS.includes(String(option || '').toLowerCase().trim())) {
    return String(option).toLowerCase().trim();
  }

  const matched = [...new Set(
    CHANNEL_WORDS.filter(([words]) => new RegExp(words).test(value)).map(([, channel]) => channel)
  )];

  return matched.length === 1 ? matched[0] : null;
}

function foldDay(option) {
  const value = String(option || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 3);
  return DAYS.includes(value) ? value : null;
}

// ─── Secrets ────────────────────────────────────────────────
// The token is the whole of a form's addressability, exactly as a public
// survey's is, and the session key is how one unfinished form in one browser
// returns to itself. Both are 24 random bytes, URL-safe, and the key is only
// ever stored as a hash.
const publicToken = () => crypto.randomBytes(24).toString('base64url');
const sessionKey = () => crypto.randomBytes(24).toString('base64url');
const hashKey = key => crypto.createHash('sha256').update(String(key)).digest('hex');

// ─── Where it may be embedded ───────────────────────────────
// An origin, and nothing but an origin. A path here would be meaningless —
// frame-ancestors matches on origin — and accepting one would let an author
// believe they had restricted the form to one page of a site when they had
// not. A single leading `*.` is allowed because a brand with a dozen
// subdomains should not have to list all twelve.

function normalizeOrigins(input) {
  const list = Array.isArray(input)
    ? input
    : String(input || '').split(/[\s,]+/);

  const origins = [];
  const issues = [];
  const seen = new Set();

  for (const raw of list) {
    const value = String(raw || '').trim().replace(/\/+$/, '');
    if (!value) continue;

    if (origins.length >= 20) {
      issues.push({ field: 'allowed_origins', message: 'Twenty sites is as many as one form can be embedded on' });
      break;
    }

    const wildcard = /^(https?):\/\/\*\.([a-z0-9-]+(\.[a-z0-9-]+)+)$/i.exec(value);
    if (wildcard) {
      const normalized = `${wildcard[1].toLowerCase()}://*.${wildcard[2].toLowerCase()}`;
      if (!seen.has(normalized)) { seen.add(normalized); origins.push(normalized); }
      continue;
    }

    let url;
    try { url = new URL(value); } catch {
      issues.push({ field: 'allowed_origins', message: `"${value}" is not a web address` });
      continue;
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      issues.push({ field: 'allowed_origins', message: `"${value}" is not a http or https address` });
      continue;
    }
    if (url.pathname !== '/' || url.search || url.hash) {
      issues.push({
        field: 'allowed_origins',
        message: `Give the site, not the page — "${url.origin}" rather than "${value}"`
      });
      continue;
    }

    if (!seen.has(url.origin)) { seen.add(url.origin); origins.push(url.origin); }
  }

  return { origins, issues };
}

// What a browser is told about who may frame this form. `'none'` is the honest
// answer for a form nobody has named a home for: it is still reachable at its
// own link, and refusing to be framed anywhere is what stops a form that was
// never configured from being wrapped by whoever finds its token.
function frameAncestors(form) {
  const origins = typeof form?.allowed_origins === 'string'
    ? parseJSON(form.allowed_origins, [])
    : (form?.allowed_origins || []);

  return origins.length ? `'self' ${origins.join(' ')}` : "'none'";
}

// Whether a page at this origin is allowed to frame the form. Used to decide
// which origin the runner may postMessage to, so a form embedded on an allowed
// site cannot be talked into reporting its own progress to another one.
function originAllowed(form, origin) {
  if (!origin) return false;
  const origins = typeof form.allowed_origins === 'string'
    ? parseJSON(form.allowed_origins, [])
    : (form.allowed_origins || []);

  return origins.some(allowed => {
    if (allowed === origin) return true;
    const wildcard = /^(https?):\/\/\*\.(.+)$/i.exec(allowed);
    if (!wildcard) return false;
    try {
      const url = new URL(origin);
      return url.protocol === `${wildcard[1].toLowerCase()}:` &&
             url.hostname.endsWith(`.${wildcard[2]}`);
    } catch { return false; }
  });
}

// ─── Authoring ──────────────────────────────────────────────

// Take what the builder posted and return the form as it will be stored.
// Questions, branching and theme are normalized by exactly the code that
// normalizes a survey's; what is added is the mapping, which the shared schema
// knows nothing about and should not.
function normalizeDefinition(body, { createdBy = null, allowEmpty = false } = {}) {
  const { questions, theme, issues, warnings } = surveyForm.normalizeDefinition(body, {
    createdBy,
    allowEmpty,
    // Not registered as canonical questions. "What should we call you?" is not
    // a research question — its answer is a column on users, and it is never
    // filed as evidence — so a canonical row for it would carry nothing and
    // would still be offered to the next survey author as something already
    // asked. See surveyForm.normalizeDefinition.
    identify: false
  });

  // The shared schema speaks of surveys because that is what it was written
  // for. An author writing an onboarding form should not be told their survey
  // is empty.
  for (const issue of issues) {
    issue.message = String(issue.message)
      .replace(/A survey needs at least one question/, 'A form needs at least one question')
      .replace(/A survey of only section headings asks nothing/, 'A form of only headings asks nothing');
  }

  if (issues.length) return { questions, theme, field_map: {}, issues, warnings };

  // With no issues, normalizeQuestions returned one question per question it
  // was given, in order — it only drops a question by raising an issue about
  // it. That is what makes it safe to read the tags back off the input by
  // position, and it is why this runs after the check above rather than before.
  const raw = Array.isArray(body.questions) ? body.questions : [];
  const mapIssues = [];
  const field_map = {};
  const claimed = new Map();

  questions.forEach((question, index) => {
    const wanted = String(raw[index]?.maps_to || '').trim();
    if (!wanted) return;

    const at = message => mapIssues.push({ index, number: index + 1, field: 'maps_to', message });

    if (!FIELD_KEYS.has(wanted)) {
      at(`"${wanted}" is not something a question can fill in`);
      return;
    }

    const field = FIELDS[wanted];

    if (!field.types.includes(question.type)) {
      at(`${field.label} cannot be collected with a ${question.type.replace('_', ' ')} question`);
      return;
    }

    // Two questions filling one column means the second silently wins, and
    // which one is second is a matter of what order the author dragged them
    // into.
    if (claimed.has(wanted)) {
      at(`${field.label} is already collected by question ${claimed.get(wanted) + 1}`);
      return;
    }

    // An address we cannot mail is an application nobody can act on, and the
    // format check exists precisely so it is caught while they are still on
    // the page rather than three days later in the queue.
    if (wanted === 'email' && question.format !== 'email') {
      at('A question collecting the email address must use the "Email address" format');
      return;
    }
    if (wanted === 'phone' && question.format !== 'phone') {
      at('A question collecting the phone number must use the "Phone number" format');
      return;
    }

    // Options that fold to nothing would be ticked by an applicant and mean
    // nothing to us — consent most of all, where the cost of losing one is
    // that we may not lawfully contact somebody who said we could.
    if (field.channels) {
      const unknown = (question.options || []).filter(option => !foldChannel(option));
      if (unknown.length) {
        at(`${unknown.map(o => `"${o}"`).join(', ')} ${unknown.length === 1 ? 'is not a channel' : 'are not channels'} we can message on — use Email, WhatsApp, SMS, Calls or In-portal`);
        return;
      }
    }

    if (wanted === 'preferred_days') {
      const unknown = (question.options || []).filter(option => !foldDay(option));
      if (unknown.length) {
        at(`${unknown.map(o => `"${o}"`).join(', ')} ${unknown.length === 1 ? 'is not a day' : 'are not days'} of the week`);
        return;
      }
    }

    claimed.set(wanted, index);
    question.maps_to = wanted;
    field_map[question.id] = wanted;
  });

  return { questions, theme, field_map, issues: mapIssues, warnings };
}

// A draft may be anything. A form that goes out may not.
//
// The two essential fields have to be asked of everybody, which means asked
// unconditionally and required — a branch around the email question produces
// an application with nobody in it, and the person who filled it in has no way
// of knowing that happened. Checking it here means it is checked wherever a
// form is published, including through an edit of a live one.
function canGoOut(questions) {
  const list = Array.isArray(questions) ? questions : [];
  const issues = [];

  if (!list.some(surveyForm.isAnswerable)) {
    issues.push({ field: 'questions', message: 'A form that goes out has to ask something' });
  }

  for (const [key, field] of Object.entries(FIELDS)) {
    if (!field.essential) continue;

    const question = list.find(q => q.maps_to === key);
    if (!question) {
      issues.push({
        field: 'maps_to',
        message: `No question collects the ${field.label.toLowerCase()}, and an application without one cannot become a member`
      });
      continue;
    }
    if (question.visible_if) {
      issues.push({
        index: list.indexOf(question), number: list.indexOf(question) + 1, field: 'visible_if',
        message: `The ${field.label.toLowerCase()} is only asked on a branch, so an application can arrive without one`
      });
    }
    if (!question.required) {
      issues.push({
        index: list.indexOf(question), number: list.indexOf(question) + 1, field: 'required',
        message: `An answer to the ${field.label.toLowerCase()} has to be required`
      });
    }
  }

  return issues;
}

// ─── Reading a stored form ──────────────────────────────────

function hydrate(form) {
  if (!form) return null;
  const open = (value, fallback) =>
    typeof value === 'string' ? parseJSON(value, fallback) : (value ?? fallback);

  return {
    ...form,
    questions: open(form.questions, []),
    theme: open(form.theme, null),
    field_map: open(form.field_map, {}),
    cohort_ids: open(form.cohort_ids, []),
    allowed_origins: open(form.allowed_origins, []),
    public_path: form.public_token ? `/o/${form.public_token}` : null
  };
}

// What someone filling the form in may see of it. An allowlist rather than a
// blocklist, for the same reason surveyForm.forPublic is: a column added to
// this table later is private until somebody decides otherwise. In particular
// the circle, the cohorts, the origin list and every count stay in.
function forPublic(form) {
  const full = hydrate(form);
  return {
    id: full.id,
    name: full.name,
    description: full.description,
    questions: full.questions,
    theme: full.theme
    // Deliberately not the closing message or the redirect: they are only
    // needed once it has been sent in, and the submit response carries them
    // then. Here they would publish a partner's thank-you address to anyone
    // holding the token.
  };
}

function byToken(token) {
  if (!token || typeof token !== 'string' || token.length < 16) return null;
  return db.prepare(
    "SELECT * FROM onboarding_forms WHERE public_token = ? AND status = 'active'"
  ).get(token) || null;
}

// ─── Turning answers into a person ──────────────────────────
// Run once, when the form is submitted, against the questions as they were at
// that moment. Doing it at approval time instead would read today's mapping
// against an answer given to yesterday's wording — an edited form would refile
// somebody's company as their job title, and nothing would look wrong.

function resolveProfile(questions, answers) {
  const profile = {};
  const consent = [];

  for (const question of Array.isArray(questions) ? questions : []) {
    const field = question.maps_to && FIELDS[question.maps_to];
    if (!field) continue;

    const value = answers[question.id];
    if (value === undefined || value === null || value === '') continue;

    if (field.consent) {
      for (const option of Array.isArray(value) ? value : [value]) {
        const channel = foldChannel(option);
        if (channel && !consent.includes(channel)) consent.push(channel);
      }
      continue;
    }

    if (field.list) {
      const items = (Array.isArray(value) ? value : [value])
        .map(item => {
          if (field.channels) return foldChannel(item);
          if (question.maps_to === 'preferred_days') return foldDay(item);
          return String(item).trim();
        })
        .filter(Boolean);
      if (items.length) profile[question.maps_to] = [...new Set(items)];
      continue;
    }

    profile[question.maps_to] = String(value).trim();
  }

  if (profile.email) profile.email = identity.normalizeEmail(profile.email);
  if (profile.phone) profile.phone = identity.normalizePhone(profile.phone) || profile.phone;

  return { profile, consent };
}

// ─── Approving ──────────────────────────────────────────────
// The only place in the onboarding path that writes to users, and it is
// reached only from an authenticated admin route holding onboarding.approve.

class OnboardingError extends Error {}

// Columns are filled from the application, but never over something already
// there. Somebody who applies through a partner's form having been a member
// for a year should not have the company on their profile replaced because
// they typed it differently this time — what the application adds is what we
// did not know.
const CARRIED = [
  'phone', 'company', 'work_sector', 'location_state',
  'gender', 'date_of_birth', 'dev_hub_user_id'
];
const CARRIED_LISTS = ['api_products', 'preferred_channels', 'preferred_days'];

function approve(submissionId, { adminId = null, note = null } = {}) {
  const submission = db.prepare('SELECT * FROM onboarding_submissions WHERE id = ?').get(submissionId);
  if (!submission) throw new OnboardingError('No such application');
  if (submission.status !== 'pending') {
    throw new OnboardingError(
      submission.status === 'started'
        ? 'That form was never submitted'
        : `This application has already been ${submission.status}`
    );
  }

  const form = db.prepare('SELECT * FROM onboarding_forms WHERE id = ?').get(submission.form_id);
  const profile = parseJSON(submission.profile, {});
  const consent = parseJSON(submission.consent_channels || '[]', []);

  const email = identity.normalizeEmail(profile.email);
  const name = String(profile.name || '').trim();

  if (!email) throw new OnboardingError('This application carries no usable email address');
  if (!name) throw new OnboardingError('This application carries no name');

  // The same rule the landing page ingest holds: a Credit Direct address is a
  // staff account, created by an administrator and signing in with a password.
  // Approving one here would make a participant profile nobody can ever sign
  // in to.
  if (identity.isStaffEmail(email)) {
    throw new OnboardingError('Credit Direct staff accounts are created by an administrator, not through a form');
  }

  const circleId = submission.circle_id || form?.circle_id;
  let userId;
  let created = false;

  db.transaction(() => {
    const existing = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);

    if (existing) {
      userId = existing.id;

      const sets = [];
      const values = [];
      for (const key of CARRIED) {
        if (profile[key] && !existing[key]) { sets.push(`${key} = ?`); values.push(profile[key]); }
      }
      for (const key of CARRIED_LISTS) {
        const held = parseJSON(existing[key], []);
        if (profile[key]?.length && !held.length) {
          sets.push(`${key} = ?`);
          values.push(JSON.stringify(profile[key]));
        }
      }
      if (profile.phone && !existing.phone_normalized) {
        sets.push('phone_normalized = ?');
        values.push(identity.normalizePhone(profile.phone));
      }
      if (sets.length) {
        db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values, userId);
      }
    } else {
      userId = uuid();
      created = true;
      db.prepare(`
        INSERT INTO users (id, email, name, phone, phone_normalized, company, work_sector,
                           password_hash, date_of_birth, gender, location_state, api_products,
                           preferred_channels, preferred_days, dev_hub_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId, email, name,
        profile.phone || null, identity.normalizePhone(profile.phone),
        profile.company || null, profile.work_sector || null,
        // Participants hold no password — they sign in with a one-time code
        // sent to the address they just gave us.
        identity.NO_PASSWORD,
        profile.date_of_birth || null, profile.gender || null, profile.location_state || null,
        JSON.stringify(profile.api_products || []),
        JSON.stringify(profile.preferred_channels || []),
        JSON.stringify(profile.preferred_days || []),
        profile.dev_hub_user_id || null
      );
    }

    // The circle this form onboards into — the answer to "which workspace am I
    // joining?", decided by the form rather than by whichever circle the
    // approving admin happens to be looking at.
    circles.join(userId, circleId);

    const allCohort = db.prepare(
      "SELECT id FROM cohorts WHERE name = 'All Members' AND circle_id = ?"
    ).get(circleId);
    const addCohort = db.prepare('INSERT OR IGNORE INTO user_cohorts (user_id, cohort_id) VALUES (?, ?)');
    if (allCohort) addCohort.run(userId, allCohort.id);

    for (const cohortId of parseJSON(form?.cohort_ids, [])) {
      const cohort = db.prepare('SELECT id FROM cohorts WHERE id = ? AND circle_id = ?').get(cohortId, circleId);
      if (cohort) addCohort.run(userId, cohort.id);
    }

    // Consent is a record of permission, so it is written from what they
    // actually ticked and nothing is assumed from silence.
    const grant = db.prepare(`
      INSERT INTO consent (id, user_id, channel, status, granted_at)
      VALUES (?, ?, ?, 'granted', datetime('now'))
    `);
    const held = new Set(
      db.prepare("SELECT channel FROM consent WHERE user_id = ? AND status = 'granted'")
        .all(userId).map(row => row.channel)
    );
    for (const channel of consent) {
      if (!notifications.CHANNELS.includes(channel) || held.has(channel)) continue;
      grant.run(uuid(), userId, channel);
      engagement.log(userId, 'consent_granted', {
        metadata: { channel, via: 'onboarding_form' }, source: 'landing_page'
      });
    }

    db.prepare(`
      UPDATE onboarding_submissions
      SET status = 'approved', user_id = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ?
      WHERE id = ?
    `).run(userId, adminId, note || null, submissionId);
  })();

  if (created) {
    engagement.log(userId, 'account_created', {
      referenceId: submission.form_id,
      metadata: { source: 'onboarding_form', form: form?.name || null, submission: submissionId },
      source: 'landing_page'
    });
  }

  // Rules-based cohorts are worked out from a member's properties, and this
  // member did not exist when they last ran.
  try { cohortRules.syncAll(); } catch { /* membership catches up on the next sync */ }

  return { user_id: userId, created, circle_id: circleId };
}

function reject(submissionId, { adminId = null, note = null } = {}) {
  const submission = db.prepare('SELECT * FROM onboarding_submissions WHERE id = ?').get(submissionId);
  if (!submission) throw new OnboardingError('No such application');
  if (submission.status !== 'pending') {
    throw new OnboardingError(`This application has already been ${submission.status}`);
  }

  db.prepare(`
    UPDATE onboarding_submissions
    SET status = 'rejected', decided_by = ?, decided_at = datetime('now'), decision_note = ?
    WHERE id = ?
  `).run(adminId, note || null, submissionId);

  return { rejected: true };
}

module.exports = {
  FIELDS, FIELD_KEYS, DAYS,
  foldChannel, foldDay,
  publicToken, sessionKey, hashKey,
  normalizeOrigins, frameAncestors, originAllowed,
  normalizeDefinition, canGoOut,
  hydrate, forPublic, byToken,
  resolveProfile,
  approve, reject,
  OnboardingError
};
