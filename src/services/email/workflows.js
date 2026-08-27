const config = require('../../config');

// ─── Notification workflow → branded email template ─────────
// Every outbound engagement email used to be funnelled through one mapper
// that guessed the template from the category alone. That left the dedicated
// templates (session invite/reminder, gift, feedback, login code) either
// orphaned or fed the wrong fields — a session announcement went out inside
// the *survey* template, and a gift email rendered the literal word
// "undefined". This is the single place that decides which template an email
// uses and exactly which data it gets, so the resolution is testable on its
// own and the notification service never has to know template field names.

// Strip the labels the various callers prefix onto titles, so a template
// receives the bare thing name ("API Workshop", not "Scheduled: API Workshop").
function stripPrefixes(title, prefixes) {
  let out = String(title || '').trim();
  for (const prefix of prefixes) {
    if (out.toLowerCase().startsWith(prefix.toLowerCase())) {
      out = out.slice(prefix.length).trim();
      break;
    }
  }
  return out.replace(/^[:\s-]+/, '').trim();
}

// Pull a six-digit code out of a title or body when it was not handed over
// explicitly (login codes are transactional, but this keeps the fallback
// honest for a caller that only passes a message).
function extractCode(message) {
  if (message.templateData && message.templateData.code) {
    return String(message.templateData.code);
  }
  const haystack = `${message.title || ''} ${message.body || ''}`;
  const match = haystack.match(/\b(\d{6})\b/);
  return match ? match[1] : '';
}

function portalUrl(path = '') {
  return `${config.appUrl}${path.startsWith('/') ? '' : '/'}${path}`;
}

// Resolve a notification message to { template, subject, templateData }.
// `message` is the object the notification service builds; `user` is the
// recipient row. A caller that already knows the workflow can pass
// message.workflow and message.templateData to bypass inference.
function resolveWorkflow(message, user = {}) {
  const recipientName = (message.templateData && message.templateData.recipientName)
    || user.name
    || null;

  const base = {
    recipientName,
    appUrl: config.appUrl
  };

  const td = { ...base, ...(message.templateData || {}) };
  const category = message.category || 'platform_updates';
  const sourceType = message.source_type || message.sourceType || null;

  // Precedence: an explicit workflow wins, then the source_type when it names
  // a known event (a session reminder and a survey reminder share the
  // "survey_reminders" category, so the category alone cannot tell them
  // apart), and finally the category.
  const KNOWN = new Set([
    'survey_invite', 'survey_reminder',
    'session_invite', 'session_reminder',
    'gift_claimed', 'blast', 'login_code'
  ]);
  const workflow = String(
    message.workflow
    || (sourceType && KNOWN.has(sourceType) ? sourceType : null)
    || category
  ).toLowerCase();

  const is = (...keys) => keys.includes(workflow) || keys.includes(category) || keys.includes(sourceType);

  // ── Sessions first: a session invite/reminder otherwise collides with the
  // survey categories it is filed under. ────────────────────────────
  if (is('session_invite')) {
    const meetingUrl = td.meetingUrl || (looksLikeUrl(message.action_url) ? message.action_url : null);
    return {
      template: 'session_invite',
      subject: message.title,
      templateData: {
        ...td,
        sessionTitle: td.sessionTitle || stripPrefixes(message.title, ['Scheduled:', 'Invited:', 'You\'re invited:']),
        sessionDescription: td.sessionDescription || message.body,
        sessionTime: td.sessionTime || null,
        scheduledAt: td.scheduledAt || null,
        meetingUrl
      }
    };
  }

  if (is('session_reminder')) {
    const meetingUrl = td.meetingUrl || (looksLikeUrl(message.action_url) ? message.action_url : null);
    return {
      template: 'session_reminder',
      subject: message.title,
      templateData: {
        ...td,
        sessionTitle: td.sessionTitle || stripPrefixes(message.title, ['Reminder:', 'Upcoming:']),
        sessionTime: td.sessionTime || null,
        scheduledAt: td.scheduledAt || null,
        meetingUrl
      }
    };
  }

  // ── Surveys ──────────────────────────────────────────────
  if (is('survey_invite', 'survey_invites')) {
    return {
      template: 'survey_invite',
      subject: message.title,
      templateData: {
        ...td,
        surveyTitle: td.surveyTitle || stripPrefixes(message.title, ['You\'re invited:', 'Invited:']),
        surveyDescription: td.surveyDescription || message.body,
        surveyUrl: td.surveyUrl || message.action_url || portalUrl('/member/surveys.html'),
        timeEstimateMin: td.timeEstimateMin ?? null,
        questionCount: td.questionCount ?? null
      }
    };
  }

  if (is('survey_reminder', 'survey_reminders')) {
    return {
      template: 'survey_reminder',
      subject: message.title,
      templateData: {
        ...td,
        surveyTitle: td.surveyTitle || stripPrefixes(message.title, ['Reminder:', 'Still open:']),
        surveyUrl: td.surveyUrl || message.action_url || portalUrl('/member/surveys.html')
      }
    };
  }

  // ── Gifts / rewards ──────────────────────────────────────
  if (is('gift_notifications', 'gift_claimed')) {
    const giftName = td.giftName
      || stripPrefixes(message.title, ['Gift claimed:', 'You claimed'])
      || String(message.title || '').replace(/\s+is on its way\.?$/i, '').trim();
    return {
      template: 'gift_claimed',
      subject: message.title,
      templateData: {
        ...td,
        giftName: giftName || 'your reward',
        giftValue: td.giftValue ?? null,
        currency: td.currency || 'NGN'
      }
    };
  }

  // ── Feedback updates ─────────────────────────────────────
  if (is('feedback_updates', 'feedback_update')) {
    return {
      template: 'feedback_update',
      subject: message.title,
      templateData: {
        ...td,
        feedbackTitle: td.feedbackTitle || stripPrefixes(message.title, ['Update on feedback:']),
        feedbackStatus: td.feedbackStatus || null,
        responseMessage: td.responseMessage || message.body,
        feedbackUrl: td.feedbackUrl || message.action_url || portalUrl('/member/feedback.html')
      }
    };
  }

  // ── Sign-in codes ────────────────────────────────────────
  if (is('login_code')) {
    const code = extractCode(message);
    return {
      template: 'login_code',
      subject: message.title,
      templateData: {
        ...td,
        code,
        expiresInMinutes: td.expiresInMinutes ?? 10
      }
    };
  }

  // ── Broadcasts / platform announcements ──────────────────
  if (is('blast') || category === 'platform_updates') {
    return {
      template: 'blast',
      subject: message.title,
      templateData: {
        ...td,
        subject: message.title,
        title: td.title || message.title,
        content: td.content || message.body,
        actionText: td.actionText || (message.action_url ? 'View in Portal' : null),
        actionUrl: message.action_url || td.actionUrl || null
      }
    };
  }

  // ── Fallback: generic ────────────────────────────────────
  return {
    template: 'generic',
    subject: message.title,
    templateData: {
      ...td,
      title: message.title,
      body: message.body,
      actionUrl: message.action_url || td.actionUrl || null
    }
  };
}

function looksLikeUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

module.exports = { resolveWorkflow, stripPrefixes };
