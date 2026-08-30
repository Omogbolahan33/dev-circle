const db = require('../db');
const { parseJSON } = require('../utils/helpers');

// The API products a member may record against themselves. The integration
// track itself (sandbox → KYB → production) is written by the Developer Hub
// webhooks or an administrator; a member telling us which product families
// they build against is harmless self-declaration that improves matching.
const SELF_SERVE_PRODUCTS = ['payments', 'lending', 'identity', 'credit_scoring'];

const PRODUCT_LABELS = {
  payments: 'Payments',
  lending: 'Lending',
  identity: 'Identity',
  credit_scoring: 'Credit scoring'
};

// ─── Member Readiness & Staged Task Rings ────────────────────
// Members are required to provide key information to participate effectively:
//   1. Profile Details (Name, Phone, Company, Work Sector)
//   2. Available Time & Schedule (Days that work, Daily time window)
//   3. Reachability & Consent (Preferred channels, Notification permissions)
//
// These three stages are represented as activity rings on the member's dashboard.
// If any stage remains unfinished (such as updating available time), that ring
// stays incomplete, holding back the member's readiness score and visibly showing
// how close they are to full participation.

function toArray(val) {
  if (Array.isArray(val)) return val;
  if (!val) return [];
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
      if (typeof parsed === 'string') {
        const second = JSON.parse(parsed);
        if (Array.isArray(second)) return second;
      }
    } catch {}
  }
  return [];
}

// ─── What a member is asked to complete ─────────────────────
// The three rings were a fixed list of eight things, which was fine while
// every circle wanted the same eight. It is not: an onboarding form decides
// what its circle needs to know, and a circle that asks applicants for their
// location and the products they build against has two properties the rings
// knew nothing about. Somebody onboarded through a spreadsheet, through
// Developer Hub SSO, or by skipping an optional question arrives without them,
// and nothing anywhere ever asks again.
//
// So the catalogue is the union of two things:
//
//   · `always: true` — what every member needs regardless of any form. The
//     original eight, unchanged, so no ring loses a task it used to have.
//   · everything else — a property is asked for only when an active onboarding
//     form in one of the member's circles is configured to collect it. See
//     wantedFor(). A circle that never asks about gender never nags anybody
//     about it.
//
// `key` matches the maps_to tag on an onboarding question, which is what joins
// the two halves together. A property with no `key` in onboarding.FIELDS (the
// availability window) is simply always-wanted and never comes from a form.
//
// Nothing lands here that a member cannot act on. A task pointing at a page
// with no field for it is worse than no task, so `dev_hub_user_id` — collected
// by forms, written by the Hub, editable by nobody — is deliberately absent.

const PROPERTIES = [
  // ── Ring 1: about you ──
  {
    key: 'name', ring: 'profile', label: 'Full name',
    always: true,
    description: 'Your name across circles',
    filled: user => Boolean(String(user.name || '').trim())
  },
  {
    // Deliberately never echoes the number back. It is half the credential, and
    // the one place it is not shown is anywhere somebody who is not the member
    // could read it off a screen — see the note on the profile endpoint.
    key: 'phone', ring: 'profile', label: 'Phone number',
    always: true,
    description: 'Sign-in credential and urgent contact',
    filled: user => Boolean(String(user.phone || '').trim())
  },
  {
    key: 'company', ring: 'profile', label: 'Company or team',
    always: true,
    description: 'Organisation you represent',
    filled: user => Boolean(String(user.company || '').trim()),
    value: user => user.company
  },
  {
    key: 'work_sector', ring: 'profile', label: 'Work sector',
    always: true,
    description: 'Fintech, Banking, Lending, Payments, etc.',
    filled: user => Boolean(String(user.work_sector || '').trim()),
    value: user => user.work_sector
  },
  {
    key: 'location_state', ring: 'profile', label: 'Location',
    description: 'The state you work from',
    filled: user => Boolean(String(user.location_state || '').trim()),
    value: user => user.location_state
  },
  {
    key: 'date_of_birth', ring: 'profile', label: 'Date of birth',
    description: 'Used for the age bands in research, never shown to anyone else',
    filled: user => Boolean(String(user.date_of_birth || '').trim()),
    value: user => user.date_of_birth
  },
  {
    key: 'gender', ring: 'profile', label: 'Gender',
    description: 'Optional, and used only in aggregate',
    filled: user => Boolean(String(user.gender || '').trim()),
    value: user => user.gender
  },
  {
    key: 'api_products', ring: 'profile', label: 'API products',
    description: 'Which product families you build against',
    filled: user => toArray(user.api_products).length > 0,
    value: user => toArray(user.api_products).map(p => PRODUCT_LABELS[p] || p).join(', ')
  },

  // ── Ring 2: when to reach you ──
  {
    key: 'preferred_days', ring: 'availability', label: 'Days that work',
    always: true,
    description: 'Select weekdays you are free',
    filled: user => toArray(user.preferred_days).length > 0,
    value: user => toArray(user.preferred_days).join(', ')
  },
  {
    // No onboarding form collects a time window, so this one is only ever
    // always-wanted. It has no maps_to twin.
    key: 'preferred_time', ring: 'availability', label: 'Time window',
    always: true,
    description: 'Set daily available hours',
    filled: user => {
      const start = String(user.preferred_time_start || '').trim();
      const end = String(user.preferred_time_end || '').trim();
      return Boolean(start && end && start !== end);
    },
    value: user => `${user.preferred_time_start} – ${user.preferred_time_end} WAT`
  },

  // ── Ring 3: how to reach you ──
  {
    key: 'preferred_channels', ring: 'channels', label: 'Preferred channels',
    always: true,
    description: 'Choose Email, WhatsApp, etc.',
    filled: user => toArray(user.preferred_channels).length > 0,
    value: user => toArray(user.preferred_channels).join(', ')
  },
  {
    // consent_channels is what an onboarding form calls it; the member's side
    // of it is rows in the consent table rather than a column.
    key: 'consent', ring: 'channels', label: 'Notification permissions',
    formKey: 'consent_channels',
    always: true,
    description: 'Give consent to receive messages',
    filled: (user, granted) => granted.length > 0,
    value: (user, granted) => `${granted.length} channel(s) granted`
  }
];

// Which onboarding maps_to tag corresponds to a property, for the ones whose
// names differ.
const formKeyOf = property => property.formKey || property.key;

// The three rings, in order, and what each is for. The tasks inside them are
// not listed here — they come from PROPERTIES, filtered by what this member's
// circles actually ask for.
const RINGS = [
  {
    id: 'profile', index: 1,
    name: 'Profile Details', subtitle: 'About you',
    color: '#0D9488',
    action_url: '/member/profile.html',
    action_label: 'Edit profile',
    impact: 'Ensures you are matched to relevant surveys and developer cohorts.'
  },
  {
    id: 'availability', index: 2,
    name: 'Available Time', subtitle: 'When to reach you',
    color: '#E84E1B',
    action_url: '/member/profile.html#availability',
    action_label: 'Update available time',
    impact: 'Unfinished availability keeps you back from scheduled sessions and 1-on-1 interviews.'
  },
  {
    id: 'channels', index: 3,
    name: 'Reachability & Consent', subtitle: 'How to reach you',
    color: '#E6B473',
    action_url: '/member/profile.html#channels',
    action_label: 'Set channels & consent',
    impact: 'Required to deliver survey links and gift claim updates without delay.'
  }
];

// `wanted` is the set of onboarding maps_to tags the member's circles collect,
// from wantedFor(). Omitted, the rings hold only the always-wanted properties —
// which is what they held before any of this, so every caller that has not been
// taught about forms still gets the eight it used to.
function computeReadiness(user, consentList = [], { wanted } = {}) {
  if (!user) return null;

  const granted = (consentList || []).filter(c => c.status === 'granted');
  const asked = wanted instanceof Set ? wanted : new Set(wanted || []);

  const applies = property => property.always || asked.has(formKeyOf(property));

  const rings = RINGS.map(ring => {
    const tasks = PROPERTIES
      .filter(p => p.ring === ring.id && applies(p))
      .map(property => {
        const done = property.filled(user, granted);
        return {
          key: property.key,
          label: property.label,
          done,
          // What they said, when they have said it. The prompt is only useful
          // while the answer is missing.
          description: done && property.value
            ? property.value(user, granted)
            : property.description,
          // Whether this is here because every member needs it, or because a
          // form in this member's circle asks for it. The dashboard says so —
          // "your circle asks for this" is a different sentence from "everyone
          // needs this", and being told the wrong one is how a nag reads as
          // arbitrary.
          asked_by_circle: !property.always
        };
      });

    const done = tasks.filter(t => t.done).length;
    // A ring with nothing in it is complete rather than a division by zero.
    const percentage = tasks.length ? Math.round((done / tasks.length) * 100) : 100;

    return { ...ring, percentage, is_complete: percentage === 100, tasks };
  });

  const completedRings = rings.filter(r => r.is_complete).length;
  const overallPercentage = Math.round(
    rings.reduce((total, ring) => total + ring.percentage, 0) / rings.length
  );

  // Unfinished tasks keeping the member from completing their rings
  const unfinishedTasks = [];
  for (const ring of rings) {
    for (const task of ring.tasks) {
      if (task.done) continue;
      unfinishedTasks.push({
        ring_id: ring.id,
        ring_name: ring.name,
        task_key: task.key,
        label: task.label,
        description: task.description,
        asked_by_circle: task.asked_by_circle,
        action_url: ring.action_url,
        action_label: ring.action_label,
        color: ring.color
      });
    }
  }

  const incompleteRingCount = rings.length - completedRings;
  let summary = '';
  if (incompleteRingCount === 0) {
    summary = 'All 3 rings closed! Your profile and availability are 100% complete.';
  } else if (incompleteRingCount === 1) {
    const incompleteRing = rings.find(r => !r.is_complete);
    summary = `2 of 3 rings complete · 1 incomplete ring (${incompleteRing.name}) keeps you back.`;
  } else {
    summary = `${completedRings} of 3 rings complete · ${incompleteRingCount} rings keep you back from full participation.`;
  }

  // Next prioritized unfinished action
  const priorityRing = rings.find(r => r.id === 'availability' && !r.is_complete)
    || rings.find(r => !r.is_complete);

  const nextAction = priorityRing ? {
    ring_id: priorityRing.id,
    ring_name: priorityRing.name,
    headline: priorityRing.id === 'availability'
      ? 'Set your available time to unlock session invites'
      : priorityRing.id === 'channels'
        ? 'Choose your channels and grant messaging consent'
        : 'Complete your profile details',
    detail: priorityRing.impact,
    action_url: priorityRing.action_url,
    action_label: priorityRing.action_label
  } : null;

  return {
    overall_percentage: overallPercentage,
    completed_rings: completedRings,
    total_rings: rings.length,
    is_complete: completedRings === rings.length,
    summary,
    next_action: nextAction,
    rings,
    unfinished_tasks: unfinishedTasks
  };
}

// ─── What this member's circles ask for ─────────────────────
// An onboarding form is a circle's own statement of what it needs to know
// about the people in it. Every question tagged with a profile field is that
// circle saying "this matters here" — so anything it asked for and did not get
// belongs in the member's rings, whichever door they actually came in by.
//
// Only live forms count. A closed form is a thing the circle used to ask, and
// nagging somebody about a question nobody is being asked any more is how a
// checklist stops being believed.
//
// Read from field_map rather than by opening the questions column: the map is
// kept in step with the questions on every save precisely so a query like this
// one does not have to parse a form to answer it.
async function wantedFor(userId) {
  if (!userId) return new Set();

  const rows = await db.prepare(`
    SELECT f.field_map
    FROM onboarding_forms f
    JOIN circle_members m ON m.circle_id = f.circle_id
    WHERE m.user_id = ? AND f.status = 'active'
  `).all(userId);

  const wanted = new Set();
  for (const row of rows || []) {
    const map = parseJSON(row.field_map, {});
    for (const field of Object.values(map || {})) wanted.add(field);
  }

  return wanted;
}

module.exports = {
  computeReadiness,
  wantedFor,
  PROPERTIES,
  SELF_SERVE_PRODUCTS,
  PRODUCT_LABELS
};
