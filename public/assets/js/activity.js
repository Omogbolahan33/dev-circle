// ─── Dev Circle — Engagement event vocabulary ───────────────
// One place that decides how an engagement_history row reads to a human and
// what colour it carries. The admin overview, the activity log, a member's
// profile and the member's own history all render from this map, so an event
// never means one thing on one screen and something else on another.
//
// tone maps to a .tl-dot modifier: '' (blue) | gold | teal | rose | ash

const ACTIVITY = {
  account_created:       { tone: 'ash',  text: 'joined {{brand.product}}' },
  api_key_generated:     { tone: 'ash',  text: 'generated API keys' },
  first_sandbox_call:    { tone: 'gold', text: 'made a first sandbox call' },
  first_production_call: { tone: 'teal', text: 'went live in production' },
  kyb_completed:         { tone: 'teal', text: 'completed KYB' },
  product_requested:     { tone: '',     text: 'requested a product' },

  survey_invited:        { tone: 'ash',  text: 'was invited to a survey' },
  survey_started:        { tone: '',     text: 'started a survey' },
  survey_completed:      { tone: 'teal', text: 'completed a survey' },

  gift_claimed:          { tone: 'gold', text: 'claimed a reward' },
  gift_delivered:        { tone: 'gold', text: 'received a reward' },

  feedback_submitted:    { tone: '',     text: 'submitted feedback' },
  complaint_received:    { tone: 'rose', text: 'logged a complaint' },

  session_announced:     { tone: '',     text: 'was invited to a session' },
  session_reminded:      { tone: 'ash',  text: 'was reminded of a session' }
};

// Falls back to a readable version of the raw type rather than showing a
// database enum to an operator.
function activityInfo(type) {
  return ACTIVITY[type] || { tone: 'ash', text: String(type || '').replace(/_/g, ' ') };
}

// Groups events under Today / Yesterday / a date, so long histories scan.
function activityDayLabel(str) {
  const d = parseStamp(str);
  if (!d) return 'Undated';
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();

  if (same(d, today)) return 'Today';
  if (same(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
