// ─── Paths: everything outside /admin ───────────────────────
// Liveness, the sign-in flows, the member's own portal endpoints, feedback,
// and the machine-to-machine integration surface.

const {
  ref, str, int, bool, id, timestamp, arrayOf, object,
  CHANNELS, FEEDBACK_CATEGORIES, ENGAGEMENT_TYPES
} = require('./components');
const { op, json, jsonBody, query, path } = require('./operation');

// Worked examples reused across operations, so the same member appears
// throughout the documentation rather than a different invented one per page.
const MEMBER_EXAMPLE = {
  id: '9f1c2a44-6d0b-4a1e-9c2f-7b1d3e5a8c40',
  email: 'chidi@paystack.africa',
  name: 'Chidi Nwosu',
  phone: '0803 555 0142',
  phone_normalized: '+2348035550142',
  company: 'Paystack',
  work_sector: 'Fintech',
  status: 'active',
  api_status: 'sandbox',
  kyb_completed: 0,
  api_products: ['lending', 'payments'],
  preferred_channels: ['email', 'in_portal'],
  preferred_days: ['tuesday', 'thursday'],
  preferred_time_start: '10:00',
  preferred_time_end: '14:00',
  quiet_hours_start: '22:00',
  quiet_hours_end: '08:00',
  notification_prefs: { survey_reminders: false },
  engagement_streak: 4,
  best_streak: 9,
  gender: 'male',
  date_of_birth: '1994-03-02',
  location_state: 'Lagos',
  country: 'NG',
  last_active_at: '2026-08-14 08:02:55',
  created_at: '2026-02-11 14:20:03',
  updated_at: '2026-08-14 08:02:55'
};

const TOKEN_EXAMPLE = '7c1f0b9a4e2d8f63a05c1e7b2d4f6a8c9e0b1d3f5a7c9e1b3d5f7a9c1e3b5d7f';

const paths = {

  // ─── Health ───────────────────────────────────────────────
  '/health': {
    get: op({
      tag: 'Health',
      auth: 'none',
      operationId: 'getHealth',
      summary: 'Liveness check',
      description: 'Deliberately free of business data, so it is safe to poll from a load balancer or an uptime monitor.',
      responses: {
        200: json('The service is up.', object({
          status: str('Always "ok" when the process is serving'),
          version: str('Deployed package version'),
          uptime: int('Seconds since the process started')
        }), { status: 'ok', version: '1.0.0', uptime: 84213 })
      }
    })
  },

  // ─── Authentication ───────────────────────────────────────
  '/auth/identify': {
    post: op({
      tag: 'Authentication',
      auth: 'none',
      operationId: 'identify',
      summary: 'Work out how this person signs in',
      description: [
        'Step one of the single sign-in form. The visitor types the address they are known',
        'by, and this says what to ask for next: a password for Credit Direct staff, and for',
        'everybody else the last six digits of the phone number on their record.',
        '',
        'A participant who types their **phone number** gets `method: "email_required"`. That is',
        'not a preference: the secret is six digits of that very number, so accepting it as the',
        'identifier would mean handing over the credential to reach the credential box.',
        '',
        'The answer comes from the identifier alone with no database lookup, so this',
        'endpoint cannot be used to discover who holds an account.'
      ].join('\n'),
      requestBody: jsonBody(object({
        identifier: str('An email address or a phone number. `email` is accepted as an alias')
      }, { required: ['identifier'] }), { identifier: 'chidi@paystack.africa' }),
      responses: {
        200: json('How to challenge this visitor.', object({
          identifier: str('The identifier, normalised — lowercased email or E.164 phone'),
          type: str('What was recognised', { enum: ['email', 'phone'] }),
          audience: str('Which side of the product they belong to', { enum: ['staff', 'participant'] }),
          method: str('What to ask for next', { enum: ['password', 'phone_digits', 'email_required'] }),
          channel: str('Unused by the current scheme; always null', { nullable: true }),
          digits: int('How many digits of the phone number to ask for, when that is the method'),
          masked: str('The identifier, masked for display back to the visitor'),
          sso: bool('Whether Developer Hub SSO is an option for them')
        }), {
          identifier: 'chidi@paystack.africa',
          type: 'email',
          audience: 'participant',
          method: 'phone_digits',
          channel: null,
          digits: 6,
          masked: 'c•••i@paystack.africa',
          sso: true
        }),
        400: json('The input is neither an email address nor a usable phone number.', ref('Error'), {
          error: 'Enter the email address or phone number you registered with.'
        })
      }
    })
  },

  '/auth/login': {
    post: op({
      tag: 'Authentication',
      auth: 'none',
      operationId: 'login',
      summary: 'Sign in',
      description: [
        'One endpoint for both audiences, because it is one form on one page. Which',
        'credential is expected follows from the address:',
        '',
        '- **Credit Direct staff** give `password`.',
        '- **Participants** give `digits` — the last six of the phone number on their record.',
        '  They hold no password at all. `phone_digits` and `password` are accepted as aliases',
        '  for the field, so one form can post whichever box it rendered.',
        '',
        'Failure answers identically whichever audience it was, and the account status is',
        'checked only after the credential verifies, so neither half can be used to find out',
        'which addresses have accounts. Eight failed attempts from one address and IP pair are',
        'throttled for 15 minutes.',
        '',
        'A member with no phone number on file cannot sign in this way, and that is reported',
        'as bad credentials rather than as a missing number.'
      ].join('\n'),
      requestBody: jsonBody(object({
        identifier: str('The email address. `email` is accepted as an alias'),
        password: str('Staff only: the account password', { format: 'password' }),
        digits: str('Participants only: the last six digits of their phone number')
      }, { required: ['identifier'] }), {
        identifier: 'chidi@paystack.africa', digits: '550142'
      }),
      responses: {
        200: json('Signed in.', object({
          token: str('Session token for the Authorization header'),
          admin: ref('AdminUser'),
          user: ref('AdminUser'),
          isAdmin: bool('Always true'),
          permissions: arrayOf({ type: 'string' }, 'Permission keys this role holds. `*` means everything')
        }), {
          token: TOKEN_EXAMPLE,
          admin: {
            id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
            email: 'adaeze@creditdirect.ng',
            name: 'Adaeze Okonkwo',
            status: 'active',
            role_id: '7d8e9f01-2a3b-4c5d-6e7f-8a9b0c1d2e3f',
            created_at: '2026-01-08 09:00:00'
          },
          isAdmin: true,
          permissions: ['*']
        }),
        400: json('A phone number was given as the identifier, or the credential is missing.', ref('Error'), {
          error: 'Sign in with the email address you registered with, not your phone number.',
          method: 'email_required'
        }),
        401: json('The credential does not match an account.', ref('Error'), {
          error: 'That email address and those digits do not match an account.'
        }),
        403: json('The account is not active.', ref('Error'), { error: 'Account is inactive' }),
        429: json('Too many failed attempts.', ref('Error'), {
          error: 'Too many failed attempts. Try again in 15 minutes.'
        })
      }
    })
  },

  '/auth/admin/login': {
    post: op({
      tag: 'Authentication',
      auth: 'none',
      operationId: 'loginLegacy',
      summary: 'Sign in (legacy path)',
      description: 'Identical to `POST /auth/login`, both audiences included. Kept for callers written against the old split between the member and admin sign-in forms.',
      requestBody: jsonBody(object({
        identifier: str('Credit Direct email address'),
        password: str('The account password', { format: 'password' })
      }, { required: ['identifier', 'password'] }), {
        identifier: 'adaeze@creditdirect.ng', password: 'correct-horse-battery-staple'
      }),
      responses: {
        200: json('Signed in. Same body as `POST /auth/login`.', object({
          token: str('Session token'),
          admin: ref('AdminUser'),
          isAdmin: bool('Always true'),
          permissions: arrayOf({ type: 'string' }, 'Permission keys')
        }), { token: TOKEN_EXAMPLE, isAdmin: true, permissions: ['members.read', 'surveys.write'] })
      },
      extras: { deprecated: true }
    })
  },

  '/auth/register': {
    post: op({
      tag: 'Authentication',
      auth: 'none',
      operationId: 'register',
      summary: 'Register as a developer',
      description: [
        'Creates a participant profile and puts the member in the "All Members" cohort',
        'and the root circle. No password is set and no session is returned: the account',
        'is claimed by signing in with a one-time code, which is also what proves the',
        'address belongs to whoever registered it.',
        '',
        'Credit Direct addresses are refused — staff accounts are created by an',
        'administrator under Roles.'
      ].join('\n'),
      requestBody: jsonBody(object({
        email: str('Work email address', { format: 'email' }),
        name: str('Full name'),
        phone: str('Phone number, however they write it'),
        company: str('Employer or the product they are building'),
        work_sector: str('Industry they work in')
      }, { required: ['email', 'name'] }), {
        email: 'chidi@paystack.africa',
        name: 'Chidi Nwosu',
        phone: '0803 555 0142',
        company: 'Paystack',
        work_sector: 'Fintech'
      }),
      responses: {
        201: json('Profile created. Ask for a code next.', object({
          user: ref('Member'),
          next: object({
            method: str('Always "code"'),
            endpoint: str('Where to send the member next'),
            identifier: str('The identifier to request a code for')
          }, { description: 'The step that turns this profile into a usable account.' })
        }), {
          user: MEMBER_EXAMPLE,
          next: { method: 'phone_digits', endpoint: '/api/auth/login', identifier: 'chidi@paystack.africa', digits: 6 }
        }),
        400: json('Missing or invalid fields, or a Credit Direct address.', ref('Error'), {
          error: 'A valid email and a name are required'
        }),
        409: json('That email is already registered.', ref('Error'), { error: 'Email already registered' })
      }
    })
  },

  '/auth/logout': {
    post: op({
      tag: 'Authentication',
      operationId: 'logout',
      summary: 'End this session',
      description: 'Destroys only the token used to make the call. Other devices stay signed in.',
      responses: {
        200: json('Session destroyed.', object({ message: str('Confirmation') }), { message: 'Logged out' })
      }
    })
  },

  '/auth/me': {
    get: op({
      tag: 'Authentication',
      operationId: 'getMe',
      summary: 'Who this token belongs to',
      description: 'The cheapest way to check a token is still good, and the canonical source of an admin\'s current permissions.',
      responses: {
        200: json('The account behind the token. Staff also get their role and permissions.', object({
          user: { oneOf: [ref('Member'), ref('AdminUser')] },
          role: { ...ref('Role'), nullable: true },
          permissions: arrayOf({ type: 'string' }, 'Staff only'),
          isAdmin: bool('Whether this is a staff session')
        }), { user: MEMBER_EXAMPLE, isAdmin: false })
      }
    })
  },

  '/auth/sso/exchange': {
    post: op({
      tag: 'Authentication',
      auth: 'none',
      operationId: 'ssoExchange',
      summary: 'Trade a Developer Hub handoff token for a session',
      description: [
        'The Hub mints an HMAC-signed token of the form `base64url(payload).hexHmac`.',
        'The subject is read from the *verified* payload and never from the request body,',
        'so knowing a `dev_hub_user_id` is not enough to obtain a session. Tokens older',
        'than five minutes are rejected.',
        '',
        'A Hub developer with no Dev Circle profile has one created on arrival, unless',
        'their address is on a Credit Direct domain.'
      ].join('\n'),
      requestBody: jsonBody(object({
        hub_token: str('The signed handoff token')
      }, { required: ['hub_token'] }), {
        hub_token: 'eyJzdWIiOiJodWJfODIyMSIsImVtYWlsIjoiY2hpZGlAcGF5c3RhY2suYWZyaWNhIn0.4f6c…'
      }),
      responses: {
        200: json('Signed in.', object({
          token: str('Dev Circle session token'),
          user: ref('Member'),
          isAdmin: bool('Always false')
        }), { token: TOKEN_EXAMPLE, user: MEMBER_EXAMPLE, isAdmin: false }),
        400: json('No token was sent.', ref('Error'), { error: 'hub_token is required' }),
        401: json('The token failed verification or has expired.', ref('Error'), {
          error: 'SSO rejected: Signature verification failed'
        }),
        403: json('The linked account is not active.', ref('Error'), { error: 'Account is suspended' }),
        404: json('No Dev Circle account matches, and auto-provisioning did not apply.', ref('Error'), {
          error: 'No Dev Circle account linked to this Developer Hub user'
        })
      }
    })
  },

  '/auth/sso/mint': {
    post: op({
      tag: 'Authentication',
      auth: 'none',
      operationId: 'ssoMint',
      summary: 'Mint a handoff token (development only)',
      description: 'Stands in for the Developer Hub so the SSO exchange can be exercised locally. Returns 404 in production.',
      requestBody: jsonBody(object({
        sub: str('Developer Hub user id'),
        email: str('Email to link or provision with', { format: 'email' }),
        name: str('Full name'),
        company: str('Employer'),
        work_sector: str('Industry')
      }, { required: ['sub'] }), { sub: 'hub_8221', email: 'chidi@paystack.africa', name: 'Chidi Nwosu' }),
      responses: {
        200: json('A token ready to post to `/auth/sso/exchange`.', object({
          hub_token: str('The signed handoff token')
        }), { hub_token: 'eyJzdWIiOiJodWJfODIyMSJ9.4f6c…' }),
        400: json('`sub` is required.', ref('Error'), { error: 'sub (dev hub user id) is required' }),
        404: json('Production — the endpoint does not exist.', ref('Error'), { error: 'Endpoint not found' })
      }
    })
  },

  '/auth/sso/link': {
    post: op({
      tag: 'Authentication',
      operationId: 'ssoLink',
      summary: 'Link this account to a Developer Hub account',
      description: 'Records the Hub user id against the signed-in member, so a later SSO arrival resolves to this profile.',
      requestBody: jsonBody(object({
        dev_hub_user_id: str('The Developer Hub user id to link')
      }, { required: ['dev_hub_user_id'] }), { dev_hub_user_id: 'hub_8221' }),
      responses: {
        200: json('Linked.', object({ message: str('Confirmation') }), { message: 'Account linked to Developer Hub' }),
        400: json('No id was sent.', ref('Error'), { error: 'dev_hub_user_id is required' })
      }
    })
  },

  // ─── Member profile ───────────────────────────────────────
  '/users/profile': {
    get: op({
      tag: 'Member profile',
      operationId: 'getProfile',
      summary: 'The signed-in member\'s profile and standing',
      description: 'Also rolls back a streak the member has let lapse, so the number returned is honest at the moment it is read.',
      responses: {
        200: json('Profile, memberships, consent and engagement standing.', object({
          user: ref('Member'),
          cohorts: arrayOf(ref('Cohort'), 'Cohorts the member belongs to'),
          circles: arrayOf(ref('Circle'), 'Circles the member belongs to'),
          consent: arrayOf(ref('ConsentRecord'), 'Consent, per channel'),
          stats: object({
            surveys_completed: int('Surveys finished'),
            surveys_invited: int('Surveys invited to'),
            gifts_claimed: int('Rewards claimed'),
            feedback_submitted: int('Pieces of feedback raised'),
            streak: int('Current engagement streak'),
            best_streak: int('Longest streak reached')
          }),
          unread_notifications: int('Unread items in the portal inbox')
        }), {
          user: MEMBER_EXAMPLE,
          cohorts: [{ id: 'c1', name: 'All Members', type: 'system', color: '#107EBC' }],
          circles: [{ id: 'r1', name: 'Dev Circle', slug: 'dev-circle', is_root: 1 }],
          consent: [{ id: 'k1', user_id: MEMBER_EXAMPLE.id, channel: 'email', status: 'granted', granted_at: '2026-02-11 14:21:40' }],
          stats: { surveys_completed: 3, surveys_invited: 5, gifts_claimed: 1, feedback_submitted: 2, streak: 4, best_streak: 9 },
          unread_notifications: 2
        })
      }
    }),
    put: op({
      tag: 'Member profile',
      operationId: 'updateProfile',
      summary: 'Update the signed-in member\'s profile',
      description: [
        'Only the fields present in the body are touched. A phone number is stored twice:',
        'as the member wrote it, and in the canonical form a sign-in code is matched',
        'against — so a number we could not send a code to is refused outright.'
      ].join('\n'),
      requestBody: jsonBody(object({
        name: str('Full name'),
        phone: str('Phone number, however they write it'),
        company: str('Employer'),
        work_sector: str('Industry'),
        preferred_channels: arrayOf({ type: 'string', enum: CHANNELS }, 'Channels they prefer'),
        preferred_days: arrayOf({ type: 'string' }, 'Weekdays they are happy to be contacted'),
        preferred_time_start: str('Start of their contact window, HH:MM'),
        preferred_time_end: str('End of their contact window, HH:MM'),
        date_of_birth: str('YYYY-MM-DD'),
        gender: str('Self-reported'),
        location_state: str('Nigerian state'),
        api_products: arrayOf({ type: 'string' }, 'Product families they integrate against')
      }), {
        name: 'Chidi Nwosu',
        phone: '0803 555 0142',
        company: 'Paystack',
        preferred_channels: ['email', 'in_portal'],
        preferred_days: ['tuesday', 'thursday'],
        api_products: ['lending', 'payments']
      }),
      responses: {
        200: json('The updated profile.', object({ user: ref('Member') }), { user: MEMBER_EXAMPLE }),
        400: json('Nothing to update, or a value was rejected.', ref('Error'), {
          error: 'That phone number is not one we can send a code to.'
        })
      }
    })
  },

  '/users/circles': {
    get: op({
      tag: 'Member profile',
      operationId: 'getMyCircles',
      summary: 'Circles this member belongs to',
      responses: {
        200: json('The member\'s circles.', object({ circles: arrayOf(ref('Circle'), 'Circles they are in') }), {
          circles: [
            { id: 'r1', name: 'Dev Circle', slug: 'dev-circle', is_root: 1, color: '#107EBC' },
            { id: 'p2', name: 'Payments guild', slug: 'payments-guild', is_root: 0, color: '#7C3AED' }
          ]
        })
      }
    })
  },

  '/users/sessions': {
    get: op({
      tag: 'Member profile',
      operationId: 'getMySessions',
      summary: 'Upcoming sessions this member is invited to',
      description: [
        'Applies exactly the targeting the dispatcher uses, so what a member sees here is',
        'what they will actually be invited to. Each entry is checked against their own',
        'stated availability, so a clash is visible to them and not only to the admin who',
        'scheduled it.'
      ].join('\n'),
      responses: {
        200: json('Sessions in the member\'s future.', object({
          sessions: arrayOf(object({
            id: str('Session id', { format: 'uuid' }),
            title: str('Session title'),
            description: str('What will be covered', { nullable: true }),
            type: str('Kind of session'),
            scheduled_for: str('When it starts'),
            duration_min: int('Length in minutes'),
            location: str('Meeting link or venue', { nullable: true }),
            circle_name: str('Circle it belongs to', { nullable: true }),
            survey_id: str('Survey to be run, if any', { nullable: true }),
            survey_title: str('Convenience label', { nullable: true }),
            clashes_with_availability: bool('True when the slot falls outside the member\'s stated window'),
            clash_reason: str('Why it clashes', { nullable: true })
          }), 'Upcoming sessions')
        }), {
          sessions: [{
            id: '5b6c7d8e-9f01-4a2b-3c4d-5e6f7a8b9c0d',
            title: 'Lending API office hours',
            description: 'Bring your integration questions.',
            type: 'workshop',
            scheduled_for: '2026-09-02T15:00:00Z',
            duration_min: 45,
            location: 'https://meet.google.com/xyz-abcd-efg',
            circle_name: 'Dev Circle',
            survey_id: null,
            survey_title: null,
            clashes_with_availability: true,
            clash_reason: 'Outside their 10:00–14:00 window'
          }]
        })
      }
    })
  },

  '/users/consent': {
    get: op({
      tag: 'Member profile',
      operationId: 'getConsent',
      summary: 'Consent on record, per channel',
      responses: {
        200: json('Consent records and the channels that exist.', object({
          consent: arrayOf(ref('ConsentRecord'), 'One record per channel the member has answered for'),
          channels: arrayOf({ type: 'string', enum: CHANNELS }, 'Every channel the platform can use')
        }), {
          consent: [{ id: 'k1', user_id: MEMBER_EXAMPLE.id, channel: 'email', status: 'granted', granted_at: '2026-02-11 14:21:40', withdrawn_at: null }],
          channels: CHANNELS
        })
      }
    }),
    post: op({
      tag: 'Member profile',
      operationId: 'grantConsent',
      summary: 'Grant consent for a channel',
      description: 'Re-granting a channel that was withdrawn clears the withdrawal rather than creating a second record.',
      requestBody: jsonBody(object({
        channel: str('Channel to consent to', { enum: CHANNELS })
      }, { required: ['channel'] }), { channel: 'whatsapp' }),
      responses: {
        200: json('The member\'s full consent state after the change.', object({
          consent: arrayOf(ref('ConsentRecord'), 'Every consent record for this member')
        }), {
          consent: [
            { id: 'k1', channel: 'email', status: 'granted', granted_at: '2026-02-11 14:21:40' },
            { id: 'k2', channel: 'whatsapp', status: 'granted', granted_at: '2026-08-14 09:31:02' }
          ]
        }),
        400: json('Unknown channel.', ref('Error'), { error: 'Valid channel required' })
      }
    })
  },

  '/users/consent/{channel}': {
    delete: op({
      tag: 'Member profile',
      operationId: 'withdrawConsent',
      summary: 'Withdraw consent for a channel',
      description: [
        'Recorded as an explicit "no" even where consent was never granted, so the send',
        'path always has an authoritative answer. Anything already queued for the channel',
        'is skipped rather than going out afterwards.'
      ].join('\n'),
      parameters: [path('channel', 'Channel to withdraw', { type: 'string', enum: CHANNELS })],
      responses: {
        200: json('The member\'s full consent state after the change.', object({
          consent: arrayOf(ref('ConsentRecord'), 'Every consent record for this member')
        }), { consent: [{ id: 'k2', channel: 'whatsapp', status: 'withdrawn', withdrawn_at: '2026-08-14 09:44:10' }] }),
        400: json('Unknown channel.', ref('Error'), { error: 'Unknown channel' })
      }
    })
  },

  '/users/notification-preferences': {
    get: op({
      tag: 'Member notifications',
      operationId: 'getNotificationPreferences',
      summary: 'Notification categories and quiet hours',
      description: 'A locked category is transactional rather than marketing, and cannot be switched off.',
      responses: {
        200: json('Preferences as they currently stand.', object({
          categories: arrayOf(object({
            key: str('Category key'),
            label: str('Human label'),
            enabled: bool('Whether the member receives it'),
            locked: bool('True when the category cannot be switched off')
          }), 'Every notification category'),
          quiet_hours: object({
            start: str('Start of the quiet window, HH:MM'),
            end: str('End of the quiet window, HH:MM'),
            active_now: bool('Whether the member is inside their quiet window right now')
          })
        }), {
          categories: [
            { key: 'survey_invites', label: 'Survey invitations', enabled: true, locked: false },
            { key: 'feedback_updates', label: 'Feedback updates', enabled: true, locked: true }
          ],
          quiet_hours: { start: '22:00', end: '08:00', active_now: false }
        })
      }
    }),
    put: op({
      tag: 'Member notifications',
      operationId: 'updateNotificationPreferences',
      summary: 'Update notification categories and quiet hours',
      description: 'Mandatory categories stay on regardless of what is sent for them.',
      requestBody: jsonBody(object({
        categories: object({}, { description: 'Category key → boolean. Unknown keys are rejected.' }),
        quiet_hours: object({
          start: str('HH:MM'),
          end: str('HH:MM')
        }, { description: 'Both ends are required when this is present.' })
      }), {
        categories: { survey_reminders: false, engagement_streaks: true },
        quiet_hours: { start: '21:30', end: '07:00' }
      }),
      responses: {
        200: json('Preferences after the change.', object({
          categories: arrayOf(object({
            key: str('Category key'), label: str('Human label'),
            enabled: bool('Whether it is on'), locked: bool('Whether it can be switched off')
          }), 'Every category'),
          quiet_hours: object({ start: str('HH:MM'), end: str('HH:MM') })
        }), {
          categories: [{ key: 'survey_reminders', label: 'Survey reminders', enabled: false, locked: false }],
          quiet_hours: { start: '21:30', end: '07:00' }
        }),
        400: json('An unknown category, a malformed time, or nothing to update.', ref('Error'), {
          error: 'quiet_hours.start and quiet_hours.end must be HH:MM'
        })
      }
    })
  },

  '/users/notifications': {
    get: op({
      tag: 'Member notifications',
      operationId: 'getNotifications',
      summary: 'The portal inbox',
      parameters: [
        query('unread_only', 'Pass `true` to return only unread items', { type: 'string', enum: ['true', 'false'] }),
        query('limit', 'How many to return, capped at 100', { type: 'integer', default: 50, maximum: 100 })
      ],
      responses: {
        200: json('Inbox contents and the unread count.', object({
          notifications: arrayOf(ref('Notification'), 'Most recent first'),
          unread_count: int('Unread items across the whole inbox')
        }), {
          notifications: [{
            id: 'n1', user_id: MEMBER_EXAMPLE.id, category: 'survey_invites',
            title: 'Sandbox onboarding experience',
            body: 'We\'d like your input. This takes about 5 minutes.',
            action_url: '/member/survey.html?id=s1',
            source_type: 'survey_invite', source_id: 's1',
            read_at: null, created_at: '2026-08-13 11:02:41'
          }],
          unread_count: 2
        })
      }
    })
  },

  '/users/notifications/{id}/read': {
    post: op({
      tag: 'Member notifications',
      operationId: 'markNotificationRead',
      summary: 'Mark one notification as read',
      parameters: [path('id', 'Notification id')],
      responses: {
        200: json('Whether it changed, plus the refreshed unread count.', object({
          read: bool('False when it was already read, or is not this member\'s'),
          notifications: arrayOf(ref('Notification'), 'A single most-recent item'),
          unread_count: int('Unread items remaining')
        }), { read: true, unread_count: 1 })
      }
    })
  },

  '/users/notifications/read-all': {
    post: op({
      tag: 'Member notifications',
      operationId: 'markAllNotificationsRead',
      summary: 'Mark the whole inbox as read',
      responses: {
        200: json('How many were marked.', object({ marked_read: int('Notifications marked as read') }), { marked_read: 7 })
      }
    })
  },

  '/users/engagement': {
    get: op({
      tag: 'Member profile',
      operationId: 'getMyEngagement',
      summary: 'This member\'s engagement history',
      description: 'The platform\'s memory of the relationship — every survey, reward, complaint and integration milestone, most recent first.',
      parameters: [
        query('type', 'Filter to one event type', { type: 'string', enum: ENGAGEMENT_TYPES }),
        query('limit', 'How many to return, capped at 200', { type: 'integer', default: 50, maximum: 200 })
      ],
      responses: {
        200: json('Engagement events.', object({ history: arrayOf(ref('EngagementEvent'), 'Most recent first') }), {
          history: [{
            id: 'e1', user_id: MEMBER_EXAMPLE.id, type: 'survey_completed',
            reference_id: 's1', metadata: { survey_title: 'Sandbox onboarding experience' },
            source: 'dev_circle', created_at: '2026-08-12 16:40:09'
          }]
        })
      }
    })
  },

  // ─── Member rewards ───────────────────────────────────────
  '/users/gifts': {
    get: op({
      tag: 'Member rewards',
      operationId: 'getMyGifts',
      summary: 'Rewards this member can claim, and what they already hold',
      description: 'A locked reward carries plain-language `requirements` saying exactly what stands between the member and it.',
      responses: {
        200: json('The reward catalogue, sorted into what is open to this member.', object({
          available: arrayOf(ref('Gift'), 'Claimable right now'),
          locked: arrayOf(ref('Gift'), 'Not yet — see each entry\'s requirements'),
          claimed: arrayOf(ref('Gift'), 'Already claimed, with claim and delivery timestamps'),
          progress: object({
            surveys_completed: int('Surveys finished'),
            streak: int('Current engagement streak')
          })
        }), {
          available: [{
            id: 'g1', name: '₦10,000 airtime', value: 10000, currency: 'NGN',
            target_cohort_ids: [], stock: 50, remaining: 31,
            min_surveys_completed: 2, min_streak: 0, requirements: []
          }],
          locked: [{
            id: 'g2', name: 'Conference ticket', value: 75000, currency: 'NGN',
            target_cohort_ids: [], stock: 5, remaining: 5,
            min_surveys_completed: 6, min_streak: 10,
            requirements: ['Complete 3 more survey(s)', 'Reach a 10 engagement streak']
          }],
          claimed: [],
          progress: { surveys_completed: 3, streak: 4 }
        })
      }
    })
  },

  '/users/gifts/{id}/claim': {
    post: op({
      tag: 'Member rewards',
      operationId: 'claimGift',
      summary: 'Claim a reward',
      description: 'Eligibility is re-checked server-side. A unique index is the real guard against a double claim, so a race loses cleanly with 409.',
      parameters: [path('id', 'Gift id')],
      responses: {
        201: json('Claimed.', object({
          message: str('Confirmation'),
          claim_id: str('Id of this claim'),
          gift: ref('Gift'),
          streak: object({}, { description: 'The member\'s engagement streak after the claim' })
        }), {
          message: 'Gift claimed',
          claim_id: 'cl_9a8b7c6d',
          gift: { id: 'g1', name: '₦10,000 airtime', value: 10000, currency: 'NGN' },
          streak: { streak: 5, best: 9 }
        }),
        403: json('The member does not qualify.', ref('Error'), {
          error: 'Complete 2 survey(s) to unlock this', surveys_completed: 1
        }),
        404: json('No such gift, or it has been retired.', ref('Error'), { error: 'Gift not available' }),
        409: json('Already claimed, or the stock has run out.', ref('Error'), {
          error: 'You have already claimed this gift'
        })
      }
    })
  },

  // ─── Member surveys ───────────────────────────────────────
  '/users/surveys': {
    get: op({
      tag: 'Member surveys',
      operationId: 'getMySurveys',
      summary: 'Surveys open to this member',
      description: 'Active, unexpired surveys whose targeting includes this member, each flagged with whether they have already responded.',
      responses: {
        200: json('Eligible surveys.', object({
          surveys: arrayOf({
            allOf: [ref('Survey'), object({
              completed: bool('Whether this member has finished it'),
              already_responded: bool('Alias of completed, kept for older clients')
            })]
          }, 'Surveys this member may answer')
        }), {
          surveys: [{
            id: 's1', title: 'Sandbox onboarding experience',
            description: 'Five minutes on how your first integration went.',
            questions: [
              { id: 'q1_8c3d21ff', type: 'rating', text: 'How clear is our API documentation?', required: true },
              { id: 'q2_1f4a9b02', type: 'long_text', text: 'What slowed you down most?', required: false }
            ],
            status: 'active', target_type: 'cohort', target_ids: ['c2'],
            engagement_mode: 'email', time_estimate_min: 5,
            expires_at: '2026-09-30 23:59:59', completed: false, already_responded: false
          }]
        })
      }
    })
  },

  '/users/surveys/{id}/start': {
    post: op({
      tag: 'Member surveys',
      operationId: 'startSurvey',
      summary: 'Open a survey and get its questions',
      description: [
        'Idempotent — starting an already-started survey returns the same in-progress',
        'response rather than creating a second one, along with any answers saved on a',
        'previous sitting.',
        '',
        'The survey comes back with its theme already resolved: the survey\'s own look',
        'over its circle\'s over the product default, so a client never has to know the',
        'order of precedence.'
      ].join('\n'),
      parameters: [path('id', 'Survey id')],
      responses: {
        200: json('The survey and this member\'s response record.', object({
          survey: ref('Survey'),
          response: ref('SurveyResponse'),
          answers: object({}, { description: 'Answers kept from an earlier sitting, keyed by question id' })
        }), {
          survey: {
            id: 's1', title: 'Sandbox onboarding experience', status: 'active',
            questions: [{ id: 'q1_8c3d21ff', type: 'rating', text: 'How clear is our API documentation?', scale: 5, required: true }],
            theme: { accent: '#107EBC', layout: 'one_per_page', progress: 'bar' },
            time_estimate_min: 5
          },
          response: {
            id: 'r1', survey_id: 's1', user_id: MEMBER_EXAMPLE.id,
            answers: {}, completed_at: null, triggered_by: 'manual', created_at: '2026-08-14 09:50:12'
          },
          answers: {}
        }),
        404: json('No such active survey.', ref('Error'), { error: 'Survey not found' }),
        409: json('Already completed.', ref('Error'), { error: 'Survey already completed' }),
        410: json('The survey has closed.', ref('Error'), { error: 'This survey has closed' })
      }
    })
  },

  // ─── Answering over a link ────────────────────────────────
  '/public/surveys/{token}': {
    get: op({
      tag: 'Open surveys',
      auth: 'none',
      operationId: 'getOpenSurvey',
      summary: 'The survey behind a link',
      description: [
        'Takes no credential. The token is the authorisation, and it opens exactly one',
        'survey — there is no endpoint here that accepts a survey id.',
        '',
        'A token that never existed, one whose survey has closed, and one that has expired',
        'all answer 404 identically, so this cannot be used to work out which tokens are',
        'real. The survey comes back with its theme resolved and without anything about how',
        'it is run: no targeting, no circle, no response counts.'
      ].join('\n'),
      parameters: [path('token', 'The token from the survey\'s link')],
      responses: {
        200: json('The survey, as a respondent sees it.', object({ survey: ref('Survey') }), {
          survey: {
            id: 's7', title: 'What stopped you finishing the sandbox setup?',
            description: 'Three questions, no account needed.',
            questions: [{ id: 'q1_8c3d21ff', type: 'nps', text: 'How likely are you to recommend our APIs?', required: true, scale: 10 }],
            theme: { accent: '#107EBC', layout: 'one_per_page' },
            time_estimate_min: 3, expires_at: null
          }
        }),
        404: json('No open survey behind this link.', ref('Error'), {
          error: 'This survey is not open. The link may have expired, or it may have closed.'
        })
      }
    })
  },

  '/public/surveys/{token}/start': {
    post: op({
      tag: 'Open surveys',
      auth: 'none',
      operationId: 'startOpenSurvey',
      summary: 'Begin a submission',
      description: [
        'Creates a submission and returns the key that owns it. No account is created and',
        'nothing recorded identifies the respondent.',
        '',
        'Send the key back on later calls to add to the same submission — a refreshed tab',
        'is then the same respondent rather than a second one. The key is shown once and',
        'cannot be recovered, because recovering it would mean being able to identify who',
        'it belongs to.'
      ].join('\n'),
      parameters: [path('token', 'The token from the survey\'s link')],
      requestBody: jsonBody(object({
        response_key: str('A key from an earlier start, to carry on that submission')
      }, { required: [] }), {}, { required: false }),
      responses: {
        200: json('The submission, and the key that owns it.', object({
          survey: ref('Survey'),
          response_key: str('Send this back to add to the same submission'),
          answers: object({}, { description: 'Answers already held against it' })
        }), {
          survey: { id: 's7', title: 'What stopped you finishing the sandbox setup?' },
          response_key: 'Zx8Q2m_K1pWv7sT4nR6yB0aC',
          answers: {}
        }),
        404: json('No open survey behind this link.', ref('Error'), {
          error: 'This survey is not open. The link may have expired, or it may have closed.'
        }),
        409: json('This key has already submitted.', ref('Error'), {
          error: 'You have already answered this one. Thank you.'
        })
      }
    })
  },

  '/public/surveys/{token}/progress': {
    patch: op({
      tag: 'Open surveys',
      auth: 'none',
      operationId: 'saveOpenSurveyProgress',
      summary: 'Keep what has been answered so far',
      description: 'As for a member, but owned by the response key rather than by a session. Answers to questions this survey does not contain are dropped.',
      parameters: [path('token', 'The token from the survey\'s link')],
      requestBody: jsonBody(object({
        response_key: str('The key returned by start'),
        answers: object({}, { description: 'Question id → answer, as far as they have got' })
      }, { required: ['response_key', 'answers'] }), {
        response_key: 'Zx8Q2m_K1pWv7sT4nR6yB0aC',
        answers: { q1_8c3d21ff: 4 }
      }),
      responses: {
        200: json('Held.', object({ saved: int('How many answers are being kept') }), { saved: 1 }),
        400: json('No answers object.', ref('Error'), { error: 'answers object required' }),
        404: json('No open survey, or no submission for this key.', ref('Error'), { error: 'Start the survey first' }),
        409: json('Already submitted.', ref('Error'), { error: 'Already completed' }),
        413: json('More than a survey in progress can hold.', ref('Error'), {
          error: 'That is more than a survey in progress can hold'
        })
      }
    })
  },

  '/public/surveys/{token}/respond': {
    post: op({
      tag: 'Open surveys',
      auth: 'none',
      operationId: 'respondToOpenSurvey',
      summary: 'Submit answers',
      description: [
        'Held to exactly the checks a member\'s submission is held to — required answers,',
        'branching, option limits, answer shapes — from the same definition. An answer',
        'arriving without an account is not an answer trusted more.',
        '',
        'Free-text answers are filed as feedback in the respondent\'s own words, against no',
        'member. No engagement event is written, because engagement is a record of what a',
        'member has done and there is no member here.'
      ].join('\n'),
      parameters: [path('token', 'The token from the survey\'s link')],
      requestBody: jsonBody(object({
        response_key: str('The key returned by start'),
        answers: object({}, { description: 'Question id → answer, in the shape each question expects' })
      }, { required: ['response_key', 'answers'] }), {
        response_key: 'Zx8Q2m_K1pWv7sT4nR6yB0aC',
        answers: { q1_8c3d21ff: 4, q2_1f4a9b02: 'The callback signature was not documented.' }
      }),
      responses: {
        200: json('Recorded.', object({
          message: str('Confirmation'),
          answered: int('How many questions this respondent was actually shown'),
          discarded: int('Answers dropped because their branch never asked them'),
          verbatims: int('Written answers filed as feedback')
        }), { message: 'Survey completed', answered: 3, discarded: 0, verbatims: 1 }),
        400: json('A missing required answer, or an answer the question does not accept.', ref('Error'), {
          error: 'Some required questions have not been answered',
          errors: { q1_8c3d21ff: 'This one is required' },
          missing: ['q1_8c3d21ff']
        }),
        404: json('No open survey, or no submission for this key.', ref('Error'), { error: 'Start the survey first' }),
        409: json('Already submitted.', ref('Error'), { error: 'Already completed' })
      }
    })
  },

  '/users/surveys/{id}/progress': {
    patch: op({
      tag: 'Member surveys',
      operationId: 'saveSurveyProgress',
      summary: 'Keep what has been answered so far',
      description: [
        'Replaces the answers held against an in-progress response, so a member who leaves',
        'a long survey can pick it up where they left off. Answers to questions this survey',
        'does not contain are dropped.',
        '',
        'Nothing else is validated: a half-typed answer is exactly what this exists to hold.',
        'Validation belongs at submission, where the member says they are finished.'
      ].join('\n'),
      parameters: [path('id', 'Survey id')],
      requestBody: jsonBody(object({
        answers: object({}, { description: 'Question id → answer, as far as they have got' })
      }, { required: ['answers'] }), {
        answers: { q1_8c3d21ff: 4 }
      }),
      responses: {
        200: json('Held.', object({ saved: int('How many answers are being kept') }), { saved: 1 }),
        400: json('No answers object.', ref('Error'), { error: 'answers object required' }),
        404: json('No such survey, or it was never started.', ref('Error'), { error: 'Start the survey first' }),
        409: json('Already completed.', ref('Error'), { error: 'Already completed' })
      }
    })
  },

  '/users/surveys/{id}/respond': {
    post: op({
      tag: 'Member surveys',
      operationId: 'respondToSurvey',
      summary: 'Submit answers',
      description: [
        'Answers are keyed by question id — the ids returned by `/users/surveys/{id}/start`.',
        'An answer to a question this survey does not contain is rejected outright.',
        '',
        'Every answer is checked against the question that drew it: a rating within its',
        'scale, an option that was actually offered, a multi-choice within its limits.',
        'Required answers are enforced only for the questions this member was shown —',
        'branching means a required question inside a path they never took is not',
        'required of them. Answers to questions their branch skipped are discarded rather',
        'than refused, because backing out of a branch is ordinary behaviour and the',
        'answer has been retracted.',
        '',
        'Completing a survey counts toward the engagement streak, files free-text answers',
        'as feedback in the member\'s own words, and cancels any reminder still queued.'
      ].join('\n'),
      parameters: [path('id', 'Survey id')],
      requestBody: jsonBody(object({
        answers: object({}, {
          description: [
            'Question id → answer. The shape follows the question: a number for rating,',
            'nps and number; a string for text, choice, dropdown and date; an array of',
            'strings for multi_choice and ranking; a boolean for boolean; and an object of',
            'row → column for matrix.'
          ].join(' ')
        })
      }, { required: ['answers'] }), {
        answers: {
          q1_8c3d21ff: 4,
          q2_1f4a9b02: ['Documentation', 'Latency'],
          q3_77b0e412: { Documentation: 'Fine', Sandbox: 'Great' },
          q4_51ac8d90: 'The callback signature was not documented for the sandbox.'
        }
      }),
      responses: {
        200: json('Recorded.', object({
          message: str('Confirmation'),
          streak: int('The member\'s streak after this, or null if unchanged', { nullable: true }),
          answered: int('How many questions this member was actually shown'),
          discarded: int('Answers dropped because their branch never asked them')
        }), { message: 'Survey completed', streak: 5, answered: 4, discarded: 0 }),
        400: json('An unknown question, a missing required answer, or an answer the question does not accept.', ref('Error'), {
          error: 'Some required questions have not been answered',
          errors: { q2_1f4a9b02: 'Pick at least 1', q4_51ac8d90: 'This one is required' },
          missing: ['q4_51ac8d90']
        }),
        404: json('No such survey, or it was never started.', ref('Error'), { error: 'Start the survey first' }),
        409: json('Already completed.', ref('Error'), { error: 'Already completed' })
      }
    })
  },

  // ─── Feedback ─────────────────────────────────────────────
  '/feedback': {
    post: op({
      tag: 'Feedback',
      operationId: 'submitFeedback',
      summary: 'Raise feedback',
      description: 'Counts toward the member\'s engagement streak. Content is capped at 5,000 characters.',
      requestBody: jsonBody(object({
        content: str('The feedback itself, up to 5000 characters'),
        category: str('What it is about', { enum: FEEDBACK_CATEGORIES }),
        rating: int('Satisfaction, 1–5', { minimum: 1, maximum: 5 }),
        survey_id: str('Set when the feedback was prompted by a survey', { format: 'uuid' })
      }, { required: ['content'] }), {
        content: 'The sandbox disbursement callback fires twice for a single request.',
        category: 'sandbox',
        rating: 3
      }),
      responses: {
        201: json('Recorded.', object({
          feedback: ref('Feedback'),
          streak: int('The member\'s streak after this', { nullable: true })
        }), {
          feedback: {
            id: 'f1', user_id: MEMBER_EXAMPLE.id, type: 'self_initiated',
            content: 'The sandbox disbursement callback fires twice for a single request.',
            category: 'sandbox', rating: 3, status: 'open', source: 'dev_circle',
            created_at: '2026-08-14 10:02:18'
          },
          streak: 5
        }),
        400: json('Missing content, an unknown category, or a rating outside 1–5.', ref('Error'), {
          error: 'Unknown category', valid: FEEDBACK_CATEGORIES
        })
      }
    }),
    get: op({
      tag: 'Feedback',
      operationId: 'listMyFeedback',
      summary: 'Feedback this member has raised',
      description: 'Scoped to the caller. Reading anybody else\'s feedback needs `feedback.read` and the admin endpoint.',
      parameters: [
        query('status', 'Filter by triage state', { type: 'string', enum: ['open', 'reviewed', 'resolved'] }),
        query('limit', 'How many to return, capped at 200', { type: 'integer', default: 50, maximum: 200 })
      ],
      responses: {
        200: json('The caller\'s feedback.', object({
          feedback: arrayOf(ref('Feedback'), 'Most recent first'),
          categories: arrayOf({ type: 'string' }, 'The categories that may be used')
        }), {
          feedback: [{
            id: 'f1', type: 'self_initiated', content: 'The sandbox disbursement callback fires twice.',
            category: 'sandbox', rating: 3, status: 'reviewed', source: 'dev_circle',
            created_at: '2026-08-14 10:02:18'
          }],
          categories: FEEDBACK_CATEGORIES
        })
      }
    })
  },

  '/feedback/{id}': {
    get: op({
      tag: 'Feedback',
      operationId: 'getMyFeedback',
      summary: 'One piece of the caller\'s own feedback',
      parameters: [path('id', 'Feedback id')],
      responses: {
        200: json('The feedback.', object({ feedback: ref('Feedback') }), {
          feedback: {
            id: 'f1', type: 'self_initiated', content: 'The sandbox disbursement callback fires twice.',
            category: 'sandbox', rating: 3, status: 'reviewed', created_at: '2026-08-14 10:02:18'
          }
        }),
        404: json('No such feedback belonging to this member.', ref('Error'), { error: 'Feedback not found' })
      }
    })
  },

  // ─── Integrations ─────────────────────────────────────────
  '/integrations/landing-page/ingest': {
    post: op({
      tag: 'Integrations',
      auth: 'apiKey',
      scopes: ['landing_page'],
      operationId: 'ingestLandingPageRegistration',
      summary: 'Register a developer from the landing page',
      description: [
        'Creates the profile, adds it to the "All Members" cohort and the root circle, and',
        'records the channels ticked on the registration form as granted consent.',
        '',
        'No credential is handed back: the member signs in with a one-time code sent to the',
        'address or number they just registered.'
      ].join('\n'),
      requestBody: jsonBody(object({
        email: str('Work email address', { format: 'email' }),
        name: str('Full name'),
        phone: str('Phone number'),
        company: str('Employer'),
        work_sector: str('Industry'),
        date_of_birth: str('YYYY-MM-DD'),
        gender: str('Self-reported'),
        location_state: str('Nigerian state'),
        api_products: arrayOf({ type: 'string' }, 'Product families of interest'),
        consent_channels: arrayOf({ type: 'string', enum: CHANNELS }, 'Channels ticked on the consent form'),
        dev_hub_user_id: str('Developer Hub id, when the form was reached from the Hub')
      }, { required: ['email', 'name'] }), {
        email: 'chidi@paystack.africa',
        name: 'Chidi Nwosu',
        phone: '0803 555 0142',
        company: 'Paystack',
        work_sector: 'Fintech',
        location_state: 'Lagos',
        api_products: ['lending'],
        consent_channels: ['email', 'whatsapp']
      }),
      responses: {
        201: json('Profile created.', object({
          message: str('Confirmation'),
          user_id: str('The new member id'),
          sign_in: object({
            method: str('Always "code"'),
            identifier: str('What the member should sign in with')
          })
        }), {
          message: 'User created',
          user_id: MEMBER_EXAMPLE.id,
          sign_in: { method: 'code', identifier: 'chidi@paystack.africa' }
        }),
        400: json('Missing fields, or a Credit Direct address.', ref('Error'), {
          error: 'Credit Direct staff accounts are created by an administrator'
        }),
        409: json('That email is already registered.', ref('Error'), {
          error: 'User already exists', user_id: MEMBER_EXAMPLE.id
        })
      }
    })
  },

  '/integrations/customerio/webhook': {
    post: op({
      tag: 'Integrations',
      auth: 'apiKey',
      scopes: ['customer_io'],
      operationId: 'customerIoWebhook',
      summary: 'Receive a Customer.io lifecycle event',
      description: [
        'Maps the event onto the member\'s engagement history, updates the fields it',
        'implies — `first_production_call` promotes them out of sandbox, `kyb_completed`',
        'flags KYB — reconciles rule-based cohorts, and invites the member to any survey',
        'wired to that event.',
        '',
        'Recognised event types: `signup_successful`, `generate_api_keys`,',
        '`first_sandbox_call`, `first_production_call`, `kyb_completed`,',
        '`product_requested`, `survey_completed`. Anything else is logged and can still',
        'trigger a survey, but changes no member state.'
      ].join('\n'),
      requestBody: jsonBody(object({
        event_type: str('The Customer.io event name'),
        user_id: str('Developer Hub user id of the member'),
        data: object({}, { description: 'Event payload. `email` here is used as a fallback lookup; `product` is read for product_requested.' })
      }, { required: ['event_type', 'user_id'] }), {
        event_type: 'first_production_call',
        user_id: 'hub_8221',
        data: { email: 'chidi@paystack.africa', product: 'lending' }
      }),
      responses: {
        200: json('Processed.', object({
          message: str('Confirmation'),
          user_id: str('The Dev Circle member the event was applied to'),
          engagement_type: str('The engagement event recorded, or null for an unmapped type', { nullable: true }),
          surveys_triggered: arrayOf(object({
            survey_id: str('Survey the member was invited to'),
            title: str('Survey title')
          }), 'Surveys wired to this event that the member has now been invited to')
        }), {
          message: 'Event processed',
          user_id: MEMBER_EXAMPLE.id,
          engagement_type: 'first_production_call',
          surveys_triggered: [{ survey_id: 's3', title: 'Going live: how did it go?' }]
        }),
        400: json('Missing fields.', ref('Error'), { error: 'event_type and user_id required' }),
        404: json('No matching member. The event is kept for replay.', ref('Error'), {
          error: 'User not found in Dev Circle', queued: true, event_id: 'ev_71a2'
        })
      }
    })
  },

  '/integrations/feex/webhook': {
    post: op({
      tag: 'Integrations',
      auth: 'apiKey',
      scopes: ['feex'],
      operationId: 'feexWebhook',
      summary: 'Mirror a Feex support ticket',
      description: [
        'Feex owns support tickets end to end, including all correspondence with the',
        'developer. Dev Circle mirrors the ticket so a complaint shows up as an engagement',
        'signal against the member — it never writes back and never resolves anything.',
        '',
        'Send both new tickets and status changes here: a ticket already known by',
        '`ticket_id` has its state updated rather than being duplicated.'
      ].join('\n'),
      requestBody: jsonBody(object({
        ticket_id: str('Feex ticket id — the idempotency key for this endpoint'),
        user_email: str('Email of the developer who raised it', { format: 'email' }),
        subject: str('Ticket subject'),
        description: str('Ticket body'),
        status: str('Ticket state in Feex', { example: 'in_progress' }),
        priority: str('Ticket priority in Feex', { example: 'high' }),
        ticket_url: str('Deep link into Feex', { format: 'uri' })
      }, { required: ['ticket_id', 'user_email'] }), {
        ticket_id: 'FEEX-10428',
        user_email: 'chidi@paystack.africa',
        subject: 'Duplicate disbursement callback',
        description: 'Sandbox fires the callback twice for one request.',
        status: 'in_progress',
        priority: 'high',
        ticket_url: 'https://feex.creditdirect.ng/tickets/10428'
      }),
      responses: {
        200: json('An existing ticket\'s state was mirrored.', object({
          message: str('Confirmation'),
          feedback_id: str('The Dev Circle feedback record mirroring this ticket'),
          feex_status: str('The state now on record')
        }), { message: 'Ticket state mirrored', feedback_id: 'f9', feex_status: 'resolved' }),
        201: json('A new ticket was ingested.', object({
          message: str('Confirmation'),
          feedback_id: str('The feedback record created'),
          user_id: str('The member it belongs to')
        }), { message: 'Complaint ingested', feedback_id: 'f9', user_id: MEMBER_EXAMPLE.id }),
        400: json('Missing fields.', ref('Error'), { error: 'ticket_id and user_email required' }),
        404: json('No matching member. The event is kept for replay.', ref('Error'), {
          error: 'User not found', queued: true, event_id: 'ev_71a3'
        })
      }
    })
  },

  '/integrations/survey-responses': {
    post: op({
      tag: 'Integrations',
      credential: 'apiKey',
      scope: 'events',
      operationId: 'ingestSurveyResponses',
      summary: 'Deliver answers from a survey run elsewhere',
      description: [
        'A discovery round does not have to run in Dev Circle. It may go out through',
        'Customer.io, Google Forms, Microsoft Forms or anything else the team already',
        'uses — and those answers are the same evidence. Post them here and they are',
        'filed against the developer who wrote them, under the question they answered,',
        'alongside everything else that developer has said.',
        '',
        'Only written answers are kept. A rating or a picked option is a measurement and',
        'belongs in the form\'s own results, the same as one collected here.',
        '',
        'The respondent is matched on email, Developer Hub id, phone or Dev Circle id. If',
        'nobody matches, the delivery is queued rather than dropped, so it can be replayed',
        'once that developer exists here.',
        '',
        'Send `response_id` and re-delivery is not a duplicate: the same submission maps',
        'to the same rows however many times it arrives.'
      ].join('\n'),
      requestBody: jsonBody(object({
        source_system: str('The tool it was collected in', { example: 'google_forms' }),
        external_survey_id: str('The form\'s own id, so repeat runs accumulate against one question', { nullable: true }),
        survey_name: str('What the round was called', { nullable: true }),
        response_id: str('The vendor\'s id for this submission, used to ignore re-delivery', { nullable: true }),
        submitted_at: timestamp('When they answered'),
        respondent: object({
          email: str('Their email', { format: 'email', nullable: true }),
          dev_hub_user_id: str('Their Developer Hub id', { nullable: true }),
          phone: str('Their phone number', { nullable: true }),
          user_id: id('Their Dev Circle id, if the caller knows it')
        }, 'How to find the developer'),
        answers: arrayOf(object({
          question: str('The question as it was asked'),
          answer: { description: 'What they wrote. Non-text answers are skipped.' }
        }), 'One entry per question')
      }), {
        source_system: 'google_forms',
        external_survey_id: '1FAIpQL_q3_2026',
        survey_name: 'Q3 Developer Experience',
        response_id: 'resp_8871',
        submitted_at: '2026-08-14 09:12:00',
        respondent: { email: 'chidi@paystack.africa' },
        answers: [
          { question: 'What is the single biggest friction in going live?',
            answer: 'Waiting on KYB with no visibility. We had engineers idle for a week.' },
          { question: 'How would you rate the docs?', answer: 4 }
        ]
      }),
      responses: {
        201: json('The written answers were filed.', object({
          message: str('What happened'),
          user_id: id('The developer they were filed against'),
          filed: arrayOf(object({ question: str('Question'), question_id: id('Question id') }), 'What was kept'),
          skipped: arrayOf(object({ question: str('Question'), reason: str('Why it was not kept') }), 'What was not')
        }), {
          message: '1 answer(s) filed for Chidi Nwosu',
          user_id: '9f1c2a44-6d0b-4a1e-9c2f-7b1d3e5a8c40',
          filed: [{ question: 'What is the single biggest friction in going live?', question_id: 'a1b2c3d4-0000-4000-8000-000000000001' }],
          skipped: [{ question: 'How would you rate the docs?', reason: 'Not a written answer' }]
        }),
        200: json('Nothing new — every answer had already been filed.', object({
          message: str('What happened'), filed: arrayOf({ type: 'object' }, 'Empty'),
          skipped: arrayOf({ type: 'object' }, 'Already filed')
        }), { message: '0 answer(s) filed for Chidi Nwosu', filed: [], skipped: [{ question: 'What is the single biggest friction in going live?', reason: 'Already filed' }] }),
        400: json('The delivery could not be read.', ref('Error'),
          { error: 'answers must be a non-empty array of { question, answer }' }),
        404: json('No developer matches the respondent. Queued for replay.', ref('Error'), {
          error: 'No developer in Dev Circle matches this respondent',
          queued: true, matched_on: ['email']
        })
      }
    })
  },

  '/integrations/events': {
    post: op({
      tag: 'Integrations',
      auth: 'apiKey',
      scopes: ['events'],
      operationId: 'ingestEvent',
      summary: 'Report a developer action',
      description: [
        'The general-purpose bridge the Developer Hub analytics layer posts to on action',
        'completion. Recognised types — `api_key_generated`, `first_sandbox_call`,',
        '`first_production_call`, `kyb_completed`, `product_requested` — are recorded as',
        'engagement and reconcile rule-based cohorts. Any event type at all can trigger a',
        'survey wired to it.'
      ].join('\n'),
      requestBody: jsonBody(object({
        event_type: str('What the developer did'),
        user_identifier: str('How to find them'),
        user_identifier_type: str('What the identifier is', { enum: ['email', 'dev_hub_id', 'id'], default: 'email' }),
        data: object({}, { description: 'Event payload, stored on the engagement record' })
      }, { required: ['event_type', 'user_identifier'] }), {
        event_type: 'first_sandbox_call',
        user_identifier: 'chidi@paystack.africa',
        user_identifier_type: 'email',
        data: { endpoint: '/v1/loans/eligibility', environment: 'sandbox' }
      }),
      responses: {
        200: json('Processed.', object({
          message: str('Confirmation'),
          user_id: str('The member the event was applied to'),
          surveys_triggered: arrayOf(object({
            survey_id: str('Survey the member was invited to'),
            title: str('Survey title')
          }), 'Surveys wired to this event')
        }), {
          message: 'Event processed',
          user_id: MEMBER_EXAMPLE.id,
          surveys_triggered: [{ survey_id: 's1', title: 'Sandbox onboarding experience' }]
        }),
        400: json('Missing fields, or an unknown identifier type.', ref('Error'), {
          error: 'user_identifier_type must be email, dev_hub_id, or id'
        }),
        404: json('No matching member. The event is kept for replay.', ref('Error'), {
          error: 'User not found', queued: true, event_id: 'ev_71a4'
        })
      }
    })
  },

  '/integrations/events/pending': {
    get: op({
      tag: 'Integrations',
      auth: 'apiKey',
      scopes: ['events', 'customer_io', 'feex'],
      operationId: 'listPendingEvents',
      summary: 'Events that did not land, and why',
      description: 'The replay queue. An event is unprocessed when it arrived for a member Dev Circle does not know yet.',
      responses: {
        200: json('Up to 100 unprocessed events, most recent first.', object({
          events: arrayOf(object({
            id: str('Event id'),
            source: str('System it came from'),
            event_type: str('The event name'),
            error: str('Why it did not land', { nullable: true }),
            created_at: str('When it arrived')
          }), 'Unprocessed events'),
          count: int('How many were returned')
        }), {
          events: [{
            id: 'ev_71a4', source: 'customer_io', event_type: 'first_sandbox_call',
            error: null, created_at: '2026-08-14 07:15:22'
          }],
          count: 1
        })
      }
    })
  }
};

module.exports = paths;
