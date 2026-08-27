const { parseJSON } = require('../utils/helpers');

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

function computeReadiness(user, consentList = []) {
  if (!user) return null;

  const preferredDays = toArray(user.preferred_days);
  const preferredChannels = toArray(user.preferred_channels);

  // ─── Ring 1: Profile & Identity ("About you") ─────────────
  const profileTasks = [
    {
      key: 'name',
      label: 'Full name',
      done: Boolean(user.name && user.name.trim()),
      description: 'Your name across circles'
    },
    {
      key: 'phone',
      label: 'Phone number',
      done: Boolean(user.phone && user.phone.trim()),
      description: 'Sign-in credential and urgent contact'
    },
    {
      key: 'company',
      label: 'Company or team',
      done: Boolean(user.company && user.company.trim()),
      description: 'Organisation you represent'
    },
    {
      key: 'work_sector',
      label: 'Work sector',
      done: Boolean(user.work_sector && user.work_sector.trim()),
      description: 'Fintech, Banking, Lending, Payments, etc.'
    }
  ];
  const profileDone = profileTasks.filter(t => t.done).length;
  const profilePercent = Math.round((profileDone / profileTasks.length) * 100);

  // ─── Ring 2: Available Time & Schedule ("When to reach you") ─
  const timeStart = String(user.preferred_time_start || '').trim();
  const timeEnd = String(user.preferred_time_end || '').trim();
  const hasWindow = Boolean(timeStart && timeEnd && timeStart !== timeEnd);
  const hasDays = Boolean(preferredDays && preferredDays.length > 0);

  const availabilityTasks = [
    {
      key: 'preferred_days',
      label: 'Days that work',
      done: hasDays,
      description: hasDays ? preferredDays.join(', ') : 'Select weekdays you are free'
    },
    {
      key: 'preferred_time',
      label: 'Time window',
      done: hasWindow,
      description: hasWindow ? `${timeStart} – ${timeEnd} WAT` : 'Set daily available hours'
    }
  ];
  const availDone = availabilityTasks.filter(t => t.done).length;
  const availPercent = Math.round((availDone / availabilityTasks.length) * 100);

  // ─── Ring 3: Reachability & Consent ("How to reach you") ───
  const activeConsent = (consentList || []).filter(c => c.status === 'granted');
  const hasChannels = Boolean(preferredChannels && preferredChannels.length > 0);
  const hasConsent = Boolean(activeConsent.length > 0);

  const channelTasks = [
    {
      key: 'preferred_channels',
      label: 'Preferred channels',
      done: hasChannels,
      description: hasChannels ? preferredChannels.join(', ') : 'Choose Email, WhatsApp, etc.'
    },
    {
      key: 'consent',
      label: 'Notification permissions',
      done: hasConsent,
      description: hasConsent ? `${activeConsent.length} channel(s) granted` : 'Give consent to receive messages'
    }
  ];
  const channelDone = channelTasks.filter(t => t.done).length;
  const channelPercent = Math.round((channelDone / channelTasks.length) * 100);

  // ─── The Three Rings ──────────────────────────────────────
  const rings = [
    {
      id: 'profile',
      index: 1,
      name: 'Profile Details',
      subtitle: 'About you',
      percentage: profilePercent,
      is_complete: profilePercent === 100,
      tasks: profileTasks,
      color: '#0D9488', // Teal
      action_url: '/member/profile.html',
      action_label: 'Edit profile',
      impact: 'Ensures you are matched to relevant surveys and developer cohorts.'
    },
    {
      id: 'availability',
      index: 2,
      name: 'Available Time',
      subtitle: 'When to reach you',
      percentage: availPercent,
      is_complete: availPercent === 100,
      tasks: availabilityTasks,
      color: '#E84E1B', // Credit Direct Primary Orange
      action_url: '/member/profile.html#availability',
      action_label: 'Update available time',
      impact: 'Unfinished availability keeps you back from scheduled sessions and 1-on-1 interviews.'
    },
    {
      id: 'channels',
      index: 3,
      name: 'Reachability & Consent',
      subtitle: 'How to reach you',
      percentage: channelPercent,
      is_complete: channelPercent === 100,
      tasks: channelTasks,
      color: '#E6B473', // CD Harvest Gold
      action_url: '/member/profile.html#channels',
      action_label: 'Set channels & consent',
      impact: 'Required to deliver survey links and gift claim updates without delay.'
    }
  ];

  const completedRings = rings.filter(r => r.is_complete).length;
  const overallPercentage = Math.round((profilePercent + availPercent + channelPercent) / 3);

  // Unfinished tasks keeping the member from completing their rings
  const unfinishedTasks = [];
  rings.forEach(ring => {
    ring.tasks.forEach(task => {
      if (!task.done) {
        unfinishedTasks.push({
          ring_id: ring.id,
          ring_name: ring.name,
          task_key: task.key,
          label: task.label,
          description: task.description,
          action_url: ring.action_url,
          action_label: ring.action_label,
          color: ring.color
        });
      }
    });
  });

  const incompleteRingCount = 3 - completedRings;
  let summary = '';
  if (completedRings === 3) {
    summary = 'All 3 rings closed! Your profile and availability are 100% complete.';
  } else if (completedRings === 2) {
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
    total_rings: 3,
    is_complete: completedRings === 3,
    summary,
    next_action: nextAction,
    rings,
    unfinished_tasks: unfinishedTasks
  };
}

module.exports = {
  computeReadiness
};
