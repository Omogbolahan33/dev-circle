// ─── OpenAPI components ─────────────────────────────────────
// The reusable half of the specification: security schemes, the object shapes
// the API returns, and the error responses every endpoint can produce. Paths
// reference these by name, so a field is described once and stays consistent
// across the eighty-odd operations that mention it.

// ─── Small builders ─────────────────────────────────────────
// The spec is data, and data written by hand drifts. These keep every
// declaration to one line so a reviewer can see the shape, not the boilerplate.

const ref = name => ({ $ref: `#/components/schemas/${name}` });

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const bool = description => ({ type: 'boolean', description });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });

// SQLite stores timestamps as 'YYYY-MM-DD HH:MM:SS' in UTC rather than ISO-8601
// with a zone, so this is documented as a plain string with an example instead
// of format: date-time, which would promise something the API does not return.
const timestamp = description => ({
  type: 'string',
  description: `${description} — UTC, formatted \`YYYY-MM-DD HH:MM:SS\``,
  example: '2026-08-14 09:24:11'
});

const id = description => ({ type: 'string', format: 'uuid', description, example: '9f1c2a44-6d0b-4a1e-9c2f-7b1d3e5a8c40' });

const arrayOf = (items, description) => ({ type: 'array', description, items });

const object = (properties, { required, description } = {}) => ({
  type: 'object',
  ...(description ? { description } : {}),
  ...(required ? { required } : {}),
  properties
});

// ─── Enumerations ───────────────────────────────────────────
// Mirrors of the CHECK constraints and validation lists in the code. A client
// generated from this spec should reject a bad value before the round trip.

const CHANNELS = ['in_portal', 'email', 'whatsapp', 'sms', 'calls'];
const NOTIFICATION_CATEGORIES = [
  'survey_invites', 'survey_reminders', 'gift_notifications',
  'feedback_updates', 'platform_updates', 'engagement_streaks'
];
const FEEDBACK_CATEGORIES = [
  'documentation', 'api', 'sandbox', 'support', 'billing', 'feature_request', 'other'
];
const ENGAGEMENT_TYPES = [
  'survey_invited', 'survey_completed', 'survey_started', 'survey_reminded',
  'gift_claimed', 'gift_delivered', 'gift_awarded',
  'feedback_submitted', 'complaint_received', 'complaint_resolved',
  'account_created', 'api_key_generated',
  'first_sandbox_call', 'first_production_call',
  'kyb_completed', 'product_requested',
  'message_sent', 'message_read',
  'consent_granted', 'consent_withdrawn'
];
const API_KEY_SCOPES = ['landing_page', 'customer_io', 'feex', 'events', '*'];
const SESSION_TYPES = ['survey', 'info', 'test', '1-on-1', 'workshop'];

// ─── Security ───────────────────────────────────────────────

const securitySchemes = {
  bearerAuth: {
    type: 'http',
    scheme: 'bearer',
    description: [
      'A Dev Circle session token, sent as `Authorization: Bearer <token>`.',
      '',
      'Staff receive one from `POST /auth/login`; members receive one from',
      '`POST /auth/code/verify` or `POST /auth/sso/exchange`. Tokens expire 24 hours',
      'after issue by default and are revoked immediately when an account is',
      'deactivated or its role changes.'
    ].join('\n')
  },
  apiKeyAuth: {
    type: 'apiKey',
    in: 'header',
    name: 'x-api-key',
    description: [
      'A scoped integration key, issued from `POST /admin/api-keys` and shown once.',
      '',
      'Machine-to-machine endpoints under `/integrations` authenticate with this',
      'instead of a session. The key may also be presented as a bearer token.',
      'Keys carry scopes (`landing_page`, `customer_io`, `feex`, `events`, or `*`)',
      'and a call outside the granted scope is refused with 403.'
    ].join('\n')
  }
};

// ─── Schemas ────────────────────────────────────────────────

const schemas = {
  Error: object({
    error: str('What went wrong, in language safe to show a person', { example: 'Member not found' }),
    error_id: str('Present on 500s only. Quote it in a support report — the server log holds the detail', { example: 'a3f9c1b27e04' }),
    required: arrayOf({ type: 'string' }, 'Present on 403s from a permission gate: the permissions that would have allowed the call')
  }, { required: ['error'], description: 'Every non-2xx response has this shape.' }),

  Pagination: object({
    page: int('The page returned, 1-based', { example: 1 }),
    limit: int('Rows per page, capped at 100', { example: 20 }),
    total: int('Rows matching the filters, across all pages', { example: 248 }),
    pages: int('Total number of pages', { example: 13 })
  }),

  // ── People ──
  Member: object({
    id: id('Dev Circle member id'),
    email: str('Sign-in address', { format: 'email', example: 'chidi@paystack.africa' }),
    name: str('Full name', { example: 'Chidi Nwosu' }),
    phone: str('As the member typed it', { nullable: true, example: '0803 555 0142' }),
    phone_normalized: str('E.164 form a sign-in code is matched against', { nullable: true, example: '+2348035550142' }),
    company: str('Employer or product they build on', { nullable: true, example: 'Paystack' }),
    work_sector: str('Industry they work in', { nullable: true, example: 'Fintech' }),
    dev_hub_user_id: str('Linked Developer Hub account, if any', { nullable: true }),
    status: str('Account state', { enum: ['active', 'inactive', 'suspended'], example: 'active' }),
    api_status: str('How far they have got with the Credit Direct APIs', { enum: ['sandbox', 'production'], example: 'sandbox' }),
    kyb_completed: int('1 once Know-Your-Business checks are done', { enum: [0, 1], example: 0 }),
    api_products: arrayOf({ type: 'string' }, 'Product families they integrate against'),
    preferred_channels: arrayOf({ type: 'string', enum: CHANNELS }, 'Channels the member prefers to be reached on'),
    preferred_days: arrayOf({ type: 'string' }, 'Weekdays they are happy to be contacted, e.g. ["tuesday","thursday"]'),
    preferred_time_start: str('Start of their preferred contact window, HH:MM', { example: '10:00' }),
    preferred_time_end: str('End of their preferred contact window, HH:MM', { example: '14:00' }),
    quiet_hours_start: str('Start of the window in which nothing is delivered, HH:MM', { example: '22:00' }),
    quiet_hours_end: str('End of the quiet window, HH:MM', { example: '08:00' }),
    notification_prefs: object({}, { description: 'Category → enabled. Categories absent here use their default.' }),
    engagement_streak: int('Consecutive engagement periods', { example: 4 }),
    best_streak: int('Longest streak ever reached', { example: 9 }),
    gender: str('Self-reported', { nullable: true, example: 'male' }),
    date_of_birth: str('YYYY-MM-DD', { nullable: true, example: '1994-03-02' }),
    location_state: str('Nigerian state', { nullable: true, example: 'Lagos' }),
    country: str('ISO country code', { example: 'NG' }),
    last_active_at: timestamp('Last time they used the portal'),
    last_engagement_at: timestamp('Last action that counted toward the streak'),
    created_at: timestamp('When the profile was created'),
    updated_at: timestamp('When the profile last changed')
  }, { description: 'A developer in the Dev Circle. The password hash is never returned.' }),

  MemberSummary: object({
    id: id('Member id'),
    email: str('Sign-in address', { format: 'email' }),
    name: str('Full name'),
    company: str('Employer', { nullable: true }),
    work_sector: str('Industry', { nullable: true }),
    status: str('Account state', { enum: ['active', 'inactive', 'suspended'] }),
    api_status: str('Sandbox or production', { enum: ['sandbox', 'production'] }),
    kyb_completed: int('1 once KYB is done', { enum: [0, 1] }),
    engagement_streak: int('Consecutive engagement periods'),
    surveys_completed: int('Surveys this member has finished'),
    surveys_invited: int('Surveys this member has been invited to'),
    cohorts: arrayOf(object({
      id: id('Cohort id'), name: str('Cohort name'), color: str('Hex swatch')
    }), 'Cohorts the member belongs to'),
    last_active_at: timestamp('Last portal activity'),
    created_at: timestamp('When they joined')
  }, { description: 'The row shape used by the member list — lighter than a full member record.' }),

  ConsentRecord: object({
    id: id('Consent record id'),
    user_id: id('Member the record belongs to'),
    channel: str('Channel consented to', { enum: CHANNELS, example: 'email' }),
    status: str('Current state', { enum: ['granted', 'withdrawn', 'pending'], example: 'granted' }),
    granted_at: timestamp('When consent was given'),
    withdrawn_at: timestamp('When consent was withdrawn')
  }, { description: 'Consent is per channel and is the final word on whether a message may be sent.' }),

  // ── Segmentation ──
  Cohort: object({
    id: id('Cohort id'),
    name: str('Cohort name', { example: 'Production integrators' }),
    description: str('What the cohort is for', { nullable: true }),
    type: str('System cohorts are maintained by the platform and cannot be deleted', { enum: ['system', 'custom'], example: 'custom' }),
    color: str('Hex swatch used in the console', { example: '#107EBC' }),
    filter_rules: { ...ref('FilterRules'), nullable: true },
    auto_sync: int('1 when membership is recalculated automatically as members change', { enum: [0, 1], example: 1 }),
    last_synced_at: timestamp('Last time the rules were re-evaluated'),
    circle_id: id('Circle the cohort lives in'),
    circle_name: str('Convenience label for the circle'),
    member_count: int('Members currently matched', { example: 41 }),
    created_by: id('Admin who created it'),
    created_at: timestamp('When it was created')
  }, { description: 'A saved segment of members — either a hand-picked list or a rule set that keeps itself current.' }),

  FilterRules: object({
    match: str('Whether every condition must hold or any one of them', { enum: ['all', 'any'], example: 'all' }),
    conditions: arrayOf(object({
      field: str('Field to test — see GET /admin/cohorts/rule-fields', { example: 'api_status' }),
      operator: str('Comparison to apply', { enum: ['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte'], example: 'eq' }),
      value: { description: 'Value to compare against', example: 'production' }
    }), 'The conditions to combine')
  }, { description: 'A cohort definition the rule engine can evaluate.' }),

  Circle: object({
    id: id('Circle id'),
    name: str('Circle name', { example: 'Payments guild' }),
    slug: str('URL-safe name, derived from the name', { example: 'payments-guild' }),
    description: str('What the circle is for', { nullable: true }),
    color: str('Hex swatch', { example: '#107EBC' }),
    parent_id: { ...id('Circle this one sits under'), nullable: true },
    is_root: int('1 for the original Dev Circle, which holds every member', { enum: [0, 1] }),
    status: str('Archived circles keep their history but take no new work', { enum: ['active', 'archived'] }),
    member_count: int('Members in the circle'),
    created_by: id('Admin who created it'),
    created_at: timestamp('When it was created')
  }, { description: 'A whole engagement space with its own members, cohorts, surveys and messaging. Circles nest.' }),

  // ── Surveys ──
  SurveyQuestion: object({
    id: str('Stable question id. Generated if you omit it — answers are keyed by this', { example: 'q1_8c3d21ff' }),
    type: str('How the question is answered', { enum: ['text', 'long_text', 'single_choice', 'multi_choice', 'rating', 'nps'], example: 'rating' }),
    text: str('The question as the member reads it', { example: 'How clear is our API documentation?' }),
    options: arrayOf({ type: 'string' }, 'Choices, for the choice types'),
    required: bool('Whether an answer must be given')
  }, { required: ['type', 'text'] }),

  Survey: object({
    id: id('Survey id'),
    title: str('Survey title', { example: 'Sandbox onboarding experience' }),
    description: str('Shown above the questions', { nullable: true }),
    questions: arrayOf(ref('SurveyQuestion'), 'The questions, in order'),
    status: str('Only an active survey is visible to members', { enum: ['draft', 'active', 'closed'], example: 'active' }),
    target_type: str('Who the survey is for', { enum: ['all', 'cohort', 'specific'], example: 'cohort' }),
    target_ids: arrayOf({ type: 'string' }, 'Cohort ids or member ids, depending on target_type'),
    engagement_mode: str('How the invitation reaches the member', { enum: ['1-on-1', 'email', 'whatsapp', 'in_portal'], example: 'email' }),
    time_estimate_min: int('Minutes the survey takes, quoted to the member', { example: 5 }),
    expires_at: timestamp('When the survey closes itself'),
    trigger_event: str('Integration event that auto-invites a member, e.g. first_sandbox_call', { nullable: true }),
    reminder_after_days: int('Days of silence before a reminder is queued', { nullable: true }),
    circle_id: id('Circle the survey belongs to'),
    response_count: int('Members invited'),
    completed_count: int('Members who finished'),
    created_by: id('Admin who created it'),
    created_at: timestamp('When it was created')
  }),

  SurveyResponse: object({
    id: id('Response id'),
    survey_id: id('Survey answered'),
    user_id: id('Member who answered'),
    user_name: str('Convenience label'),
    user_email: str('Convenience label', { format: 'email' }),
    answers: object({}, { description: 'Question id → answer. A multi-choice answer is an array of strings.' }),
    completed_at: timestamp('When it was submitted. Null while still in progress'),
    triggered_by: str('What put this survey in front of the member', { enum: ['manual', 'system', 'customer_io'] }),
    created_at: timestamp('When the member was invited or started')
  }),

  // ── Sessions ──
  ScheduledSession: object({
    id: id('Session id'),
    title: str('Session title', { example: 'Lending API office hours' }),
    description: str('What will be covered', { nullable: true }),
    type: str('Kind of session', { enum: SESSION_TYPES, example: 'workshop' }),
    survey_id: { ...id('Survey to run in the session'), nullable: true },
    survey_title: str('Convenience label', { nullable: true }),
    circle_id: id('Circle the session belongs to'),
    circle_name: str('Convenience label'),
    target_type: str('Who is invited', { enum: ['all', 'cohort', 'specific', 'circle'], example: 'cohort' }),
    target_ids: arrayOf({ type: 'string' }, 'Cohort, member or circle ids, depending on target_type'),
    scheduled_for: str('When it starts — ISO date-time', { example: '2026-09-02T15:00:00Z' }),
    duration_min: int('Length in minutes', { example: 45 }),
    location: str('Meeting link or venue', { nullable: true, example: 'https://meet.google.com/xyz-abcd-efg' }),
    channels: arrayOf({ type: 'string', enum: CHANNELS }, 'Channels the invitation and reminders go out on'),
    reminder_offsets: arrayOf({ type: 'integer' }, 'Minutes before the session at which to remind, e.g. [1440, 60]'),
    status: str('Lifecycle state', { enum: ['draft', 'scheduled', 'announced', 'completed', 'cancelled'] }),
    dispatches_sent: int('Reminder batches already sent'),
    created_by: id('Admin who scheduled it'),
    created_at: timestamp('When it was scheduled')
  }),

  SessionPreview: object({
    recipients: int('Members who would be invited', { example: 38 }),
    available: int('Members whose stated availability covers the slot', { example: 31 }),
    unavailable: arrayOf(object({
      id: id('Member id'), name: str('Member name'), reason: str('Why the slot does not suit them')
    }), 'Members the slot clashes with, and why'),
    reachable: int('Members at least one channel can actually reach', { example: 35 })
  }, { description: 'Who a session would reach, and who it would miss — before anything is sent.' }),

  // ── Rewards ──
  Gift: object({
    id: id('Gift id'),
    name: str('What the reward is', { example: '₦10,000 airtime' }),
    description: str('Shown to the member', { nullable: true }),
    value: num('Face value', { example: 10000 }),
    currency: str('ISO currency code', { example: 'NGN' }),
    target_cohort_ids: arrayOf({ type: 'string' }, 'Cohorts the gift is open to. Empty means every member'),
    stock: int('How many can be claimed in total. Null means unlimited', { nullable: true, example: 50 }),
    remaining: int('Claims still available. Null when stock is unlimited', { nullable: true }),
    min_surveys_completed: int('Surveys a member must have finished to qualify', { example: 2 }),
    min_streak: int('Engagement streak a member must have reached to qualify', { example: 0 }),
    active: int('0 retires the gift without deleting its claim history', { enum: [0, 1] }),
    requirements: arrayOf({ type: 'string' }, 'Plain-language reasons this member cannot claim it yet'),
    claimed_count: int('Times it has been claimed'),
    delivered_count: int('Claims marked as fulfilled'),
    created_at: timestamp('When it was created')
  }),

  // ── Feedback ──
  Feedback: object({
    id: id('Feedback id'),
    user_id: id('Member who raised it'),
    user_name: str('Convenience label'),
    user_email: str('Convenience label', { format: 'email' }),
    type: str('Where it came from', { enum: ['self_initiated', 'system_triggered', 'feex_complaint'] }),
    content: str('The feedback itself', { example: 'The sandbox disbursement callback fires twice for a single request.' }),
    category: str('What it is about', { enum: FEEDBACK_CATEGORIES, nullable: true }),
    rating: int('Satisfaction, 1–5', { nullable: true, minimum: 1, maximum: 5, example: 3 }),
    status: str('Triage state — how far the engagement team has read it', { enum: ['open', 'reviewed', 'resolved'] }),
    source: str('System it arrived from', { enum: ['dev_circle', 'feex', 'customer_io'] }),
    external_ticket_id: str('Feex ticket id, for mirrored complaints', { nullable: true }),
    feex_status: str('Ticket state as Feex last reported it', { nullable: true }),
    feex_priority: str('Ticket priority in Feex', { nullable: true }),
    feex_url: str('Deep link into Feex', { nullable: true, format: 'uri' }),
    survey_id: { ...id('Survey that prompted this feedback'), nullable: true },
    created_at: timestamp('When it was raised'),
    resolved_at: timestamp('When triage closed it')
  }, { description: 'Feedback raised by a member, or a support ticket mirrored from Feex. Feex owns its tickets; Dev Circle only reflects their state.' }),

  // ── Messaging ──
  Notification: object({
    id: id('Notification id'),
    user_id: id('Recipient'),
    category: str('Preference category it falls under', { enum: NOTIFICATION_CATEGORIES }),
    title: str('Headline', { example: 'Sandbox onboarding experience' }),
    body: str('Body text', { nullable: true }),
    action_url: str('Where the notification takes the member', { nullable: true, example: '/member/survey.html?id=…' }),
    source_type: str('What produced it', { nullable: true }),
    source_id: str('Id of the thing that produced it', { nullable: true }),
    read_at: timestamp('When the member read it. Null while unread'),
    created_at: timestamp('When it was raised')
  }),

  Blast: object({
    id: id('Blast id'),
    subject: str('Subject line, for channels that have one', { nullable: true }),
    content: str('Message body', { example: 'Office hours this Thursday — bring your integration questions.' }),
    channel: str('Where it goes. "all" fans out to every consented channel', { enum: ['email', 'whatsapp', 'sms', 'in_portal', 'all'] }),
    target_type: str('Who receives it', { enum: ['all', 'cohort', 'specific'] }),
    target_ids: arrayOf({ type: 'string' }, 'Cohort or member ids, depending on target_type'),
    status: str('Lifecycle state', { enum: ['draft', 'sending', 'sent', 'failed'] }),
    circle_id: id('Circle the blast belongs to'),
    scheduled_for: timestamp('When it should go out, if scheduled'),
    recipient_count: int('Members it was addressed to'),
    skipped_count: int('Members it could not be sent to'),
    delivered_count: int('Deliveries that left the building'),
    sent_by: id('Admin who sent it'),
    sent_at: timestamp('When it went out'),
    created_at: timestamp('When it was drafted')
  }),

  MessageDelivery: object({
    id: id('Delivery id'),
    source_type: str('What produced the message', { enum: ['blast', 'survey_invite', 'survey_reminder', 'session_invite', 'session_reminder', 'system'] }),
    source_id: str('Id of the blast, survey or session'),
    user_id: id('Recipient'),
    user_name: str('Convenience label'),
    user_email: str('Convenience label', { format: 'email' }),
    channel: str('Channel attempted', { enum: CHANNELS }),
    status: str('Outcome. "simulated" means no provider credentials are configured', { enum: ['queued', 'sent', 'simulated', 'skipped', 'failed'] }),
    reason: str('Why it was skipped or failed', { nullable: true, example: 'No consent for whatsapp' }),
    provider_ref: str('Provider-side message id', { nullable: true }),
    sent_at: timestamp('When it left'),
    created_at: timestamp('When it was attempted')
  }, { description: 'One row per recipient per channel — the audit trail behind every message.' }),

  // ── Engagement ──
  EngagementEvent: object({
    id: id('Event id'),
    user_id: id('Member the event belongs to'),
    user_name: str('Convenience label'),
    type: str('What happened', { enum: ENGAGEMENT_TYPES, example: 'survey_completed' }),
    reference_id: str('Id of the survey, gift, blast or ticket involved', { nullable: true }),
    metadata: object({}, { description: 'Event-specific detail' }),
    source: str('System that reported it', { enum: ['system', 'customer_io', 'feex', 'manual', 'dev_circle', 'landing_page'] }),
    created_at: timestamp('When it happened')
  }, { description: 'One line of a member\'s engagement history. This is the platform\'s memory of a relationship.' }),

  // ── Access control ──
  Permission: object({
    key: str('The permission a role is granted', { example: 'members.read' }),
    label: str('What it lets somebody do', { example: 'View members' }),
    group: str('How the roles screen groups it', { example: 'Members' })
  }),

  Role: object({
    id: id('Role id'),
    name: str('Role name', { example: 'Super Admin' }),
    description: str('What the role is for', { nullable: true }),
    permissions: arrayOf({ type: 'string' }, 'Permission keys. `*` grants everything, including permissions added later'),
    is_system: int('1 for roles the platform ships, which cannot be edited or deleted', { enum: [0, 1] }),
    admin_count: int('Staff currently holding this role'),
    created_at: timestamp('When it was created')
  }),

  AdminUser: object({
    id: id('Admin id'),
    email: str('Credit Direct address', { format: 'email', example: 'adaeze@creditdirect.ng' }),
    name: str('Full name', { example: 'Adaeze Okonkwo' }),
    status: str('Inactive staff cannot sign in and hold no live sessions', { enum: ['active', 'inactive'] }),
    role_id: id('Role assigned'),
    role_name: str('Convenience label', { example: 'Super Admin' }),
    created_at: timestamp('When the account was created')
  }, { description: 'A member of Credit Direct staff. Admin accounts are created here, never through registration.' }),

  ApiKeySummary: object({
    id: id('Key id'),
    name: str('What the key is for', { example: 'Landing page' }),
    prefix: str('First segment of the key, safe to display and to log', { example: 'a1b2c3d4' }),
    permissions: arrayOf({ type: 'string', enum: API_KEY_SCOPES }, 'Scopes granted'),
    status: str('Derived from the timestamps below — the one field worth reading first', {
      enum: ['live', 'expired', 'revoked'], example: 'live'
    }),
    last_used_at: timestamp('Last time the key authenticated a call. Null means it has never been used'),
    expires_at: timestamp('When it stops working. Null means no expiry'),
    revoked_at: timestamp('When it was revoked. Null while live'),
    created_by: id('Admin who issued it'),
    created_at: timestamp('When it was issued')
  }, { description: 'The plaintext key is returned once at creation and never again — only its hash is stored.' }),

  IssuedApiKey: object({
    key: str('The plaintext key. Returned at issue and rotation, and never again', {
      example: 'dc_a1b2c3d4_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4'
    }),
    prefix: str('Safe to record so the key can be identified later', { example: 'a1b2c3d4' }),
    scopes: arrayOf({ type: 'string', enum: API_KEY_SCOPES }, 'Scopes granted'),
    record: ref('ApiKeySummary'),
    warning: str('Says plainly that this is the only time the key is readable')
  }, { description: 'The one response in the API that carries a secret. It is not stored anywhere it can be read back.' }),

  ApiKeyScope: object({
    key: str('The scope as it is granted', { example: 'feex' }),
    label: str('Human label', { example: 'Feex' }),
    description: str('What an integration holding it is able to do'),
    endpoints: arrayOf({ type: 'string' }, 'The endpoints this scope unlocks')
  }, { description: 'The catalogue a key editor builds from — a scope, and exactly what it opens.' }),

  IntegrationProvider: object({
    id: str('Provider key', { example: 'customer_io' }),
    name: str('Provider name', { example: 'Customer.io' }),
    purpose: str('What Dev Circle uses it for'),
    configured: bool('Whether the credential is present. The value itself is never returned'),
    env: arrayOf({ type: 'string' }, 'Environment variables that supply it'),
    degraded: str('What stops working, or works differently, while it is missing')
  }, {
    description: [
      'An outbound credential. These are held in the environment rather than the database,',
      'because signing a provider request needs the secret in cleartext — so this reports',
      'only whether one is set, never what it is.'
    ].join(' ')
  }),

  SandboxStatus: object({
    enabled: bool('Whether the sandbox is available in this environment'),
    active: bool('Whether this very request was served from the sandbox'),
    header: str('The header that routes a request to it', { example: 'X-Devcircle-Sandbox' }),
    seeded_at: str('When the demo data was first built'),
    reset_at: str('When it was last rebuilt. Null if never', { nullable: true }),
    counts: object({}, { description: 'Rows per table, so it is obvious what is in there' })
  }),

  IntegrationEvent: object({
    id: id('Event id'),
    source: str('Which system sent it', { example: 'customer_io' }),
    event_type: str('The event name as the sender used it', { example: 'first_sandbox_call' }),
    payload: str('The body as received, JSON-encoded'),
    processed: int('0 means it did not land and can be replayed', { enum: [0, 1] }),
    error: str('Why it did not land', { nullable: true }),
    created_at: timestamp('When it arrived')
  }, { description: 'The inbound log. Every webhook is recorded here before it is acted on, so nothing is lost when it fails.' })
};

// ─── Shared responses ───────────────────────────────────────
// Attached to operations by reference, so the failure modes are documented
// consistently rather than the happy path being the only thing described.

const errorResponse = (description, example) => ({
  description,
  content: { 'application/json': { schema: ref('Error'), example } }
});

const responses = {
  Unauthorized: errorResponse(
    'No credential was sent, or the one sent has expired or been revoked.',
    { error: 'Invalid or expired token' }
  ),
  Forbidden: errorResponse(
    'Authenticated, but the role or API key scope does not permit this.',
    { error: 'You do not have permission to do this', required: ['members.write'] }
  ),
  NotFound: errorResponse('No such record — or none the caller is allowed to see.', { error: 'Member not found' }),
  BadRequest: errorResponse('The request was rejected before anything changed.', { error: 'No fields to update' }),
  Conflict: errorResponse('The request contradicts the current state of the record.', { error: 'Already sent' }),
  TooManyRequests: {
    description: [
      'Rate limit exceeded. Every response carries `RateLimit-Limit`,',
      '`RateLimit-Remaining` and `RateLimit-Reset`; this one adds `Retry-After`.'
    ].join(' '),
    headers: {
      'Retry-After': { description: 'Seconds until the window resets', schema: { type: 'integer' } },
      'RateLimit-Limit': { description: 'Requests permitted per window', schema: { type: 'integer' } },
      'RateLimit-Remaining': { description: 'Requests left in this window', schema: { type: 'integer' } },
      'RateLimit-Reset': { description: 'Seconds until the window resets', schema: { type: 'integer' } }
    },
    content: {
      'application/json': {
        schema: ref('Error'),
        example: { error: 'Too many requests. Slow down and try again shortly.', retry_after_seconds: 42 }
      }
    }
  },
  ServerError: errorResponse(
    'Something failed on our side. The `error_id` is in the server log — quote it in a report.',
    { error: 'Something went wrong on our end.', error_id: 'a3f9c1b27e04' }
  )
};

// ─── Common parameters ──────────────────────────────────────

const parameters = {
  PathId: {
    name: 'id', in: 'path', required: true,
    description: 'Record id',
    schema: { type: 'string', format: 'uuid' }
  },
  Page: {
    name: 'page', in: 'query', required: false,
    description: 'Page to return, 1-based',
    schema: { type: 'integer', minimum: 1, default: 1 }
  },
  Limit: {
    name: 'limit', in: 'query', required: false,
    description: 'Rows per page. Values above 100 are clamped to 100',
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
  }
};

module.exports = {
  ref, str, int, bool, num, timestamp, id, arrayOf, object,
  securitySchemes, schemas, responses, parameters,
  CHANNELS, NOTIFICATION_CATEGORIES, FEEDBACK_CATEGORIES,
  ENGAGEMENT_TYPES, API_KEY_SCOPES, SESSION_TYPES
};
