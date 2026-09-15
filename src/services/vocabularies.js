// ─── Vocabularies ───────────────────────────────────────────
// The option lists behind the profile fields that have a fixed set of answers.
//
// Each of these existed already, two or three times over and never quite the
// same: the member profile page hard-coded its own sectors and genders, the
// seed invented states as it went, and an onboarding form asking for any of
// them started from an empty option list that whoever built the form filled in
// by hand. So a circle collected "Fintech" on the form and offered "fintech"
// on the profile, and a cohort built on either matched half the people it
// should have.
//
// One list each, and everything that offers a choice reads it from here: the
// onboarding builder fills a question's options from it the moment the
// question is tagged, the member's own profile renders its selects from it,
// and the import templates line up with both.
//
// What is written below is what *ships*, not what is possible. A sector list
// that needs a deploy to add a row is a list that stops being true — Nigeria
// added a state once, and a circle that starts onboarding insurers wants
// Insurance in the list this afternoon. So each of these can be overridden per
// circle in option_lists (migration 32), and the code list is what applies
// until somebody does. Same arrangement as email_templates: absent means the
// default, present means this circle decided otherwise.
//
// Read them with listFor()/allFor(), which take the circle into account.
// The bare arrays below are the fallback and the seed, and nothing outside
// this file should read them directly.

const db = require('../db');
const { parseJSON, uuid, sqlTime } = require('../utils/helpers');
const { PRODUCT_LABELS } = require('./readiness');

// All thirty-six, plus the Federal Capital Territory, alphabetically — which
// is how somebody looks for their own in a dropdown.
const NIGERIAN_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue',
  'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu',
  'Federal Capital Territory', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano',
  'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun',
  'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe',
  'Zamfara'
];

// Written as they are stored, because the profile stores the lowercase key and
// the form stores what the option said. Keeping them the same word avoids a
// mapping nobody would remember to update.
const GENDERS = ['Female', 'Male', 'Other', 'Prefer not to say'];

// What this platform's members actually build in. "Other" is last and is the
// reason a form does not need a free-text box beside the list.
const WORK_SECTORS = [
  'Fintech', 'Banking', 'Lending', 'Payments', 'Insurance',
  'E-commerce', 'Telecoms', 'Logistics', 'Healthtech', 'Education',
  'Government', 'Other'
];

// From the readiness service rather than a second copy: these are the products
// a member may say they build against, and the labels the rest of the product
// already shows them by.
const API_PRODUCTS = Object.values(PRODUCT_LABELS);

const DAY_LABELS = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'
];

// Channel options are written for a person to read and folded back to channel
// keys when the form is saved — see foldChannel in services/onboarding.js.
// These are the labels that fold cleanly.
const CHANNEL_LABELS = ['Email', 'SMS', 'WhatsApp', 'A phone call', 'In the portal'];

// Which profile field gets which list. A field absent from here has no fixed
// set of answers — a company name is whatever somebody types.
const FOR_FIELD = {
  gender: GENDERS,
  work_sector: WORK_SECTORS,
  location_state: NIGERIAN_STATES,
  api_products: API_PRODUCTS,
  preferred_days: DAY_LABELS,
  preferred_channels: CHANNEL_LABELS,
  consent_channels: CHANNEL_LABELS
};

// Which fields have a list at all. A company name has none and should not
// pretend to: offering an author a "standard list of companies" would be
// offering them a wrong one.
const FIELDS_WITH_OPTIONS = Object.keys(FOR_FIELD);

// A copy every time: callers go on to edit what they are handed, and a caller
// editing the module's own array would change it for every circle in the
// process.
function shipped(field) {
  const list = FOR_FIELD[field];
  return list ? [...list] : null;
}

function parseOptions(raw) {
  const parsed = parseJSON(raw, null);
  if (!Array.isArray(parsed)) return null;
  const clean = parsed.map(o => String(o == null ? '' : o).trim()).filter(Boolean);
  return clean.length ? clean : null;
}

// What this circle asks for one field: its own list if it has set one, and
// what ships otherwise. An override that has been emptied to nothing falls
// back rather than offering a question with no answers — deleting the row is
// how a circle returns to the default, and that is a different action.
async function listFor(field, circleId) {
  if (!FOR_FIELD[field]) return null;

  if (circleId) {
    const row = await db.prepare(
      'SELECT options FROM option_lists WHERE circle_id = ? AND field = ?'
    ).get(circleId, field);
    const stored = row && parseOptions(row.options);
    if (stored) return stored;
  }

  return shipped(field);
}

// Every field at once, which is what the schema endpoint and the profile page
// both want — one query rather than one per field.
async function allFor(circleId) {
  const overrides = new Map();

  if (circleId) {
    const rows = await db.prepare(
      'SELECT field, options FROM option_lists WHERE circle_id = ?'
    ).all(circleId);
    for (const row of rows || []) {
      const stored = parseOptions(row.options);
      if (stored) overrides.set(row.field, stored);
    }
  }

  return Object.fromEntries(
    FIELDS_WITH_OPTIONS.map(field => [field, overrides.get(field) || shipped(field)])
  );
}

// For the screen that edits them: what this circle asks, what ships, and
// whether the two differ — so an author can see they have customised a list
// and can put it back.
async function catalogue(circleId) {
  const current = await allFor(circleId);

  return FIELDS_WITH_OPTIONS.map(field => {
    const options = current[field];
    const defaults = shipped(field);
    return {
      field,
      options,
      defaults,
      customised: JSON.stringify(options) !== JSON.stringify(defaults)
    };
  });
}

// ─── Editing a list ─────────────────────────────────────────

// Set what this circle asks for one field. Whitespace goes, blanks go, and so
// do duplicates — two identical options in a dropdown is a bug in the list,
// not a choice somebody made, and it would split a cohort in two.
function cleanOptions(raw) {
  if (!Array.isArray(raw)) return { error: 'options must be an array' };

  const seen = new Set();
  const clean = [];
  for (const entry of raw) {
    const label = String(entry == null ? '' : entry).trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(label);
  }

  if (!clean.length) {
    return { error: 'A list needs at least one option. To go back to the standard list, reset it instead.' };
  }
  if (clean.length > 500) {
    return { error: 'That is more options than anybody can choose from — 500 is the limit.' };
  }
  return { options: clean };
}

async function setList(field, circleId, options, adminId) {
  if (!FOR_FIELD[field]) return { error: `${field} has no list of answers` };

  const cleaned = cleanOptions(options);
  if (cleaned.error) return cleaned;

  const existing = await db.prepare(
    'SELECT id FROM option_lists WHERE circle_id = ? AND field = ?'
  ).get(circleId, field);

  if (existing) {
    await db.prepare(
      'UPDATE option_lists SET options = ?, updated_at = ?, updated_by = ? WHERE id = ?'
    ).run(JSON.stringify(cleaned.options), sqlTime(), adminId || null, existing.id);
  } else {
    await db.prepare(
      'INSERT INTO option_lists (id, circle_id, field, options, updated_by) VALUES (?, ?, ?, ?, ?)'
    ).run(uuid(), circleId, field, JSON.stringify(cleaned.options), adminId || null);
  }

  return { options: cleaned.options };
}

// Back to what ships. Deleting the row rather than writing the default into
// it, so a circle that resets keeps following the default as it changes
// instead of freezing today's copy of it.
async function resetList(field, circleId) {
  if (!FOR_FIELD[field]) return { error: `${field} has no list of answers` };
  await db.prepare('DELETE FROM option_lists WHERE circle_id = ? AND field = ?').run(circleId, field);
  return { options: shipped(field) };
}

module.exports = {
  NIGERIAN_STATES,
  GENDERS,
  WORK_SECTORS,
  API_PRODUCTS,
  DAY_LABELS,
  CHANNEL_LABELS,
  FIELDS_WITH_OPTIONS,
  shipped,
  parseOptions,
  listFor,
  allFor,
  catalogue,
  cleanOptions,
  setList,
  resetList
};
