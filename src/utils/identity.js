// ─── Identity resolution ────────────────────────────────────
// One sign-in field, two audiences. Everything downstream — which challenge a
// visitor is offered, whether an account may be created at all — is decided
// from the identifier alone, with no database lookup, so the sign-in page can
// answer "what do I ask you for?" without ever becoming an oracle for who
// holds an account here.
//
// The rule: a Credit Direct email domain means staff, and staff use a
// password. Everyone else is a participant, and participants never have one.

const config = require('../config');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Participants hold no password, but users.password_hash is NOT NULL and rows
// predate that. This sentinel fills the column with something that can never
// match: bcrypt.compareSync returns false against it rather than throwing, and
// unlike a random hash it is obvious in the database that no password exists.
const NO_PASSWORD = '!';

function normalizeEmail(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return EMAIL_RE.test(value) ? value : null;
}

function emailDomain(email) {
  const at = String(email || '').lastIndexOf('@');
  return at === -1 ? null : email.slice(at + 1).toLowerCase();
}

// Matches the domain itself and anything under it, so mail.creditdirect.ng
// counts as staff while a lookalike like creditdirect.ng.example.com does not.
function isStaffEmail(email) {
  const domain = emailDomain(normalizeEmail(email));
  if (!domain) return false;
  return config.staffEmailDomains.some(d => domain === d || domain.endsWith(`.${d}`));
}

// ─── Phone numbers ──────────────────────────────────────────
// Members give their number however they habitually write it — 0803…,
// 803…, +234803…, with spaces or dashes. All of those are one person, so
// they collapse to a single E.164 form that is what we store and match on.

const DEFAULT_COUNTRY_CODE = '234'; // Nigeria

function normalizePhone(raw) {
  const input = String(raw || '').trim();
  if (!input) return null;

  // Nothing but digits, spaces, and the punctuation people write numbers with
  if (!/^\+?[\d\s().-]+$/.test(input)) return null;

  const hadPlus = input.startsWith('+');
  let digits = input.replace(/\D/g, '');
  if (!digits) return null;

  if (!hadPlus) {
    if (digits.startsWith('00')) {
      digits = digits.slice(2);                                  // 00234803…
    } else if (digits.startsWith('0')) {
      digits = DEFAULT_COUNTRY_CODE + digits.slice(1);           // 0803…
    } else if (digits.length === 10) {
      digits = DEFAULT_COUNTRY_CODE + digits;                    // 803…
    }
  }

  // E.164 allows 8–15 digits including the country code
  if (digits.length < 8 || digits.length > 15) return null;

  return `+${digits}`;
}

// ─── Classification ─────────────────────────────────────────

/**
 * Work out what a visitor typed and what we should ask them for next.
 * Returns null when the input is neither an email nor a usable phone number.
 */
function classify(raw) {
  const input = String(raw || '').trim();
  if (!input) return null;

  if (input.includes('@')) {
    const email = normalizeEmail(input);
    if (!email) return null;

    return isStaffEmail(email)
      ? { type: 'email', value: email, audience: 'staff', method: 'password', channel: null }
      : { type: 'email', value: email, audience: 'participant', method: 'code', channel: 'email' };
  }

  const phone = normalizePhone(input);
  if (!phone) return null;

  // A phone number is never a staff credential: staff sign in with their
  // work email and a password.
  return { type: 'phone', value: phone, audience: 'participant', method: 'code', channel: 'sms' };
}

// ─── Masking ────────────────────────────────────────────────
// "We sent a code to a•••@paystack.dev" tells the right person they typed the
// right thing without telling anyone else what the address is.

const DOT = '•';

function maskEmail(email) {
  const at = email.indexOf('@');
  if (at <= 0) return DOT.repeat(6);
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const head = local[0];
  const tail = local.length > 4 ? local[local.length - 1] : '';
  return `${head}${DOT.repeat(3)}${tail}${domain}`;
}

function maskPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  const last = digits.slice(-4);
  return `+${digits.slice(0, 3)} ${DOT.repeat(3)} ${DOT.repeat(3)} ${last}`;
}

function mask(identity) {
  if (!identity) return '';
  return identity.type === 'email' ? maskEmail(identity.value) : maskPhone(identity.value);
}

module.exports = {
  EMAIL_RE,
  NO_PASSWORD,
  normalizeEmail,
  normalizePhone,
  emailDomain,
  isStaffEmail,
  classify,
  mask,
  maskEmail,
  maskPhone
};
