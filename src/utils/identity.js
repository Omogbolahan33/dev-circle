// ─── Identity resolution ────────────────────────────────────
// One sign-in field, two audiences. Everything downstream — which challenge a
// visitor is offered, whether an account may be created at all — is decided
// from the identifier alone, with no database lookup, so the sign-in page can
// answer "what do I ask you for?" without ever becoming an oracle for who
// holds an account here.
//
// The rule: a Credit Direct email domain means staff, and staff use a
// password. Everyone else is a participant, and a participant signs in with
// their email address and the last six digits of the phone number they
// registered — which is why an onboarding form is required to collect both.

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

// ─── The participant's secret ───────────────────────────────
// The last six digits of the number they registered with.
//
// It is a weak secret and it is worth naming as one: six digits is a million
// combinations, and a phone number is not private the way a password is —
// anyone who has it can derive this. What stands in front of it is the login
// throttle (eight failures per address per address-and-IP in fifteen minutes)
// and the rate limit on /api/auth. That is enough to make guessing impractical
// for one attacker and not enough to make this equivalent to a password, which
// is the trade this scheme makes knowingly.
//
// Six is counted off the normalised E.164 form rather than off what they
// typed, so 0803 555 0142, +234 803 555 0142 and 8035550142 all yield the same
// six digits — otherwise the same person would have a different secret
// depending on how they wrote their number the day they registered.

const PHONE_DIGITS = 6;

// The digits themselves, or null when there is no number on file or it is too
// short to yield a secret. Null is never a match: a member with no phone number
// cannot sign in, and that is reported as bad credentials rather than as a
// missing phone, so the endpoint stays useless as a membership oracle.
function phoneDigits(phoneNormalized) {
  const digits = String(phoneNormalized || '').replace(/\D/g, '');
  return digits.length >= PHONE_DIGITS ? digits.slice(-PHONE_DIGITS) : null;
}

// Whether what somebody typed matches the digits on file. Compared over the
// full length in constant time so the answer cannot be found one digit at a
// time from how long the comparison took.
function checkPhoneDigits(phoneNormalized, given) {
  const expected = phoneDigits(phoneNormalized);
  const offered = String(given ?? '').replace(/\D/g, '');

  if (!expected || offered.length !== PHONE_DIGITS) return false;

  let differences = 0;
  for (let i = 0; i < PHONE_DIGITS; i++) {
    if (expected[i] !== offered[i]) differences++;
  }
  return differences === 0;
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
      : { type: 'email', value: email, audience: 'participant', method: 'phone_digits', digits: PHONE_DIGITS, channel: null };
  }

  const phone = normalizePhone(input);
  if (!phone) return null;

  // A phone number is never a staff credential: staff sign in with their work
  // email and a password.
  //
  // It is not a participant's identifier either, and that is a security
  // property rather than a preference. The secret is the last six digits of
  // this very number, so accepting the number as the thing you type in the
  // first box would mean handing over the credential to get to the credential
  // box. The sign-in page reads this and asks for their email instead.
  return { type: 'phone', value: phone, audience: 'participant', method: 'email_required', digits: PHONE_DIGITS, channel: null };
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
  PHONE_DIGITS,
  phoneDigits,
  checkPhoneDigits,
  normalizeEmail,
  normalizePhone,
  emailDomain,
  isStaffEmail,
  classify,
  mask,
  maskEmail,
  maskPhone
};
