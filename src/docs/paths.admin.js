// ─── Paths: the admin console API ───────────────────────────
// Everything under /admin needs a staff session, and every operation below
// declares the permission its role must hold. The permission is stated in the
// description, carried as `x-permission`, and returned in the 403 body — so
// what a role can do is discoverable three ways before anyone reads the source.

const {
  ref, str, int, bool, num, id, timestamp, arrayOf, object,
  CHANNELS, API_KEY_SCOPES, SESSION_TYPES
} = require('./components');
const { op, json, jsonBody, fileResponse, query, path } = require('./operation');

const MEMBER_ID = '9f1c2a44-6d0b-4a1e-9c2f-7b1d3e5a8c40';

// The member-list filters are shared by the list and the export, so what an
// admin sees on screen is exactly what lands in the file. Declared once here.
const memberFilterParams = [
  query('search', 'Matches name, email or company'),
  query('status', 'Account state', { type: 'string', enum: ['active', 'inactive', 'suspended'] }),
  query('api_status', 'How far the member has got with the APIs', { type: 'string', enum: ['sandbox', 'production'] }),
  query('cohort_id', 'Only members of this cohort', { type: 'string', format: 'uuid' }),
  query('circle_id', 'Only members of this circle', { type: 'string', format: 'uuid' }),
  query('work_sector', 'Exact industry match'),
  query('location_state', 'Exact state match'),
  query('gender', 'Exact match'),
  query('api_product', 'Members integrating this product family'),
  query('kyb_completed', 'Pass 1/true/yes for completed, anything else for pending', { type: 'string' }),
  query('min_streak', 'Members with at least this engagement streak', { type: 'integer' })
];

const paths = {

  // ─── Dashboard ────────────────────────────────────────────
  '/admin/dashboard': {
    get: op({
      tag: 'Admin · Dashboard',
      permission: 'members.read',
      operationId: 'getDashboard',
      summary: 'Headline numbers and recent activity',
      responses: {
        200: json('The console overview.', object({
          stats: object({
            total_members: int('Members on the platform'),
            active_cohorts: int('Cohorts defined'),
            engagement_rate: int('Completed surveys as a percentage of surveys sent'),
            surveys_sent: int('Survey invitations issued'),
            surveys_completed: int('Surveys finished'),
            new_this_week: int('Members who joined in the last seven days')
          }),
          recent_activity: arrayOf(ref('EngagementEvent'), 'The last 20 engagement events across everyone'),
          cohort_breakdown: arrayOf(object({
            id: str('Cohort id'), name: str('Cohort name'),
            color: str('Hex swatch'), member_count: int('Members in it')
          }), 'The ten largest cohorts'),
          status_breakdown: arrayOf(object({
            api_status: str('sandbox or production'), count: int('Members at that stage')
          }), 'Members by API stage')
        }), {
          stats: {
            total_members: 248, active_cohorts: 9, engagement_rate: 62,
            surveys_sent: 412, surveys_completed: 255, new_this_week: 11
          },
          recent_activity: [{
            id: 'e1', user_id: MEMBER_ID, user_name: 'Chidi Nwosu',
            type: 'survey_completed', source: 'dev_circle', created_at: '2026-08-14 09:12:03'
          }],
          cohort_breakdown: [{ id: 'c1', name: 'All Members', color: '#107EBC', member_count: 248 }],
          status_breakdown: [{ api_status: 'sandbox', count: 191 }, { api_status: 'production', count: 57 }]
        })
      }
    })
  },

  '/admin/demography': {
    get: op({
      tag: 'Admin · Dashboard',
      permission: 'members.read',
      operationId: 'getDemography',
      summary: 'Distributions across the member base',
      description: 'Every breakdown comes with `data_coverage`, so nobody reads a chart without knowing how much of the base actually answered.',
      responses: {
        200: json('Distributions, each as label/count pairs.', object({
          total: int('Members counted'),
          work_sector: arrayOf(object({ label: str('Sector'), count: int('Members') }), 'By industry'),
          location_state: arrayOf(object({ label: str('State'), count: int('Members') }), 'Top 15 states'),
          gender: arrayOf(object({ label: str('Gender'), count: int('Members') }), 'By gender'),
          age_band: arrayOf(object({ label: str('Band'), count: int('Members') }), 'Under 25 / 25–34 / 35–44 / 45+'),
          api_products: arrayOf(object({ label: str('Product'), count: int('Members') }), 'A member counts once per product'),
          api_status: arrayOf(object({ label: str('Stage'), count: int('Members') }), 'Sandbox against production'),
          kyb: arrayOf(object({ label: str('Completed or Pending'), count: int('Members') }), 'KYB progress'),
          engagement_depth: arrayOf(object({ label: str('Band'), count: int('Members') }), 'How many surveys members have answered'),
          data_coverage: object({
            no_date_of_birth: int('Members with no date of birth'),
            no_gender: int('Members with no gender'),
            no_location: int('Members with no state'),
            no_products: int('Members with no products recorded')
          }, { description: 'How much of the base is missing from each breakdown above.' })
        }), {
          total: 248,
          work_sector: [{ label: 'Fintech', count: 121 }, { label: 'Unspecified', count: 44 }],
          location_state: [{ label: 'Lagos', count: 160 }],
          gender: [{ label: 'male', count: 141 }, { label: 'female', count: 92 }],
          age_band: [{ label: '25–34', count: 118 }],
          api_products: [{ label: 'lending', count: 143 }],
          api_status: [{ label: 'sandbox', count: 191 }],
          kyb: [{ label: 'Pending', count: 173 }],
          engagement_depth: [{ label: 'Never responded', count: 61 }],
          data_coverage: { no_date_of_birth: 88, no_gender: 15, no_location: 21, no_products: 40 }
        })
      }
    })
  },

  // ─── Members ──────────────────────────────────────────────
  '/admin/members': {
    get: op({
      tag: 'Admin · Members',
      permission: 'members.read',
      operationId: 'listMembers',
      summary: 'List and filter members',
      description: 'Filters combine with AND. The same filters drive `GET /admin/export`, so a filtered screen and a filtered file agree.',
      parameters: [
        ...memberFilterParams,
        query('page', 'Page to return, 1-based', { type: 'integer', minimum: 1, default: 1 }),
        query('limit', 'Rows per page, capped at 100', { type: 'integer', minimum: 1, maximum: 100, default: 20 })
      ],
      responses: {
        200: json('A page of members.', object({
          members: arrayOf(ref('MemberSummary'), 'Newest first'),
          pagination: ref('Pagination')
        }), {
          members: [{
            id: MEMBER_ID, email: 'chidi@paystack.africa', name: 'Chidi Nwosu',
            company: 'Paystack', work_sector: 'Fintech', status: 'active',
            api_status: 'sandbox', kyb_completed: 0, engagement_streak: 4,
            surveys_completed: 3, surveys_invited: 5,
            cohorts: [{ id: 'c1', name: 'All Members', color: '#107EBC' }],
            last_active_at: '2026-08-14 08:02:55', created_at: '2026-02-11 14:20:03'
          }],
          pagination: { page: 1, limit: 20, total: 248, pages: 13 }
        })
      }
    })
  },

  '/admin/members/{id}': {
    get: op({
      tag: 'Admin · Members',
      permission: 'members.read',
      operationId: 'getMember',
      summary: 'One member, with their whole history',
      description: 'The single view an engagement rep works from: profile, memberships, consent, engagement, feedback, surveys, rewards and message deliveries.',
      parameters: [path('id', 'Member id')],
      responses: {
        200: json('Everything on record for this member.', object({
          user: ref('Member'),
          cohorts: arrayOf(ref('Cohort'), 'Cohorts they belong to'),
          consent: arrayOf(ref('ConsentRecord'), 'Consent per channel'),
          engagement: arrayOf(ref('EngagementEvent'), 'Last 50 engagement events'),
          feedback: arrayOf(ref('Feedback'), 'Last 20 pieces of feedback'),
          survey_responses: arrayOf(ref('SurveyResponse'), 'Every survey they were invited to'),
          gifts: arrayOf(object({
            name: str('Reward name'), value: num('Face value'), currency: str('Currency'),
            claimed_at: str('When they claimed it'), delivered_at: str('When it was fulfilled', { nullable: true })
          }), 'Rewards claimed'),
          deliveries: arrayOf(ref('MessageDelivery'), 'Last 25 outbound attempts')
        }), {
          user: { id: MEMBER_ID, email: 'chidi@paystack.africa', name: 'Chidi Nwosu', status: 'active' },
          cohorts: [{ id: 'c1', name: 'All Members' }],
          consent: [{ channel: 'email', status: 'granted' }],
          engagement: [{ id: 'e1', type: 'survey_completed', created_at: '2026-08-12 16:40:09' }],
          feedback: [], survey_responses: [], gifts: [],
          deliveries: [{ source_type: 'blast', channel: 'email', status: 'sent', reason: null, created_at: '2026-08-10 09:00:02' }]
        }),
        404: json('No such member.', ref('Error'), { error: 'Member not found' })
      }
    }),
    put: op({
      tag: 'Admin · Members',
      permission: 'members.write',
      operationId: 'updateMember',
      summary: 'Update a member\'s standing',
      description: [
        'Only the fields present in the body are touched. Setting a status other than',
        '`active` also ends that member\'s live sessions, so the account stops working',
        'immediately rather than when the token happens to expire.',
        '',
        'Changing these fields can move the member in or out of rule-based cohorts, which',
        'are reconciled as part of the call.'
      ].join('\n'),
      parameters: [path('id', 'Member id')],
      requestBody: jsonBody(object({
        status: str('Account state', { enum: ['active', 'inactive', 'suspended'] }),
        api_status: str('API stage', { enum: ['sandbox', 'production'] }),
        kyb_completed: bool('Whether KYB is done'),
        work_sector: str('Industry'),
        location_state: str('Nigerian state'),
        gender: str('Self-reported'),
        api_products: arrayOf({ type: 'string' }, 'Product families they integrate against')
      }), { api_status: 'production', kyb_completed: true }),
      responses: {
        200: json('The updated member.', object({ user: ref('Member') }), {
          user: { id: MEMBER_ID, name: 'Chidi Nwosu', api_status: 'production', kyb_completed: 1 }
        }),
        400: json('Nothing to update, or an invalid value.', ref('Error'), { error: 'Invalid status' }),
        404: json('No such member.', ref('Error'), { error: 'Member not found' })
      }
    })
  },

  '/admin/members/{id}/sign-out': {
    post: op({
      tag: 'Admin · Members',
      permission: 'members.write',
      operationId: 'signOutMember',
      summary: 'End all of a member\'s sessions',
      description: [
        'Members hold no password, so there is nothing to reset after a report of a lost or',
        'shared device — what is needed is to end their live sessions. The next one-time',
        'code they request is their way back in.'
      ].join('\n'),
      parameters: [path('id', 'Member id')],
      responses: {
        200: json('Sessions destroyed.', object({ message: str('Confirmation') }), {
          message: 'Signed out of every device. They can sign back in with a new code.'
        }),
        404: json('No such member.', ref('Error'), { error: 'Member not found' })
      }
    })
  },

  '/admin/import/template': {
    get: op({
      tag: 'Admin · Members',
      permission: 'members.import',
      operationId: 'downloadImportTemplate',
      summary: 'Download a blank import template',
      description: [
        'A sheet with the right columns already in place, so an import does not have to be',
        'guessed at. The workbook carries a second tab explaining what each column expects.',
        '',
        'It is generated from the same column specification the importer reads uploads',
        'through, so it cannot advertise a column the importer ignores or omit one it needs.',
        'Downloading it and posting it straight back to `/admin/import` succeeds unedited.'
      ].join('\n'),
      parameters: [
        query('format', 'File format', { type: 'string', enum: ['xlsx', 'csv'], default: 'xlsx' }),
        query('type', 'Which import the template is for', { type: 'string', enum: ['members'], default: 'members' })
      ],
      responses: {
        200: fileResponse(
          'The template, named for the browser to save.',
          'text/csv',
          'email,name,phone,company,work_sector,date_of_birth,gender,location_state,api_products\nada.obi@zilla.ng,Ada Obi,+2348031234567,Zilla,Fintech,1994-04-12,female,Lagos,payments;lending'
        ),
        400: json('Unsupported format.', ref('Error'), { error: 'format must be csv or xlsx' }),
        404: json('No such template.', ref('Error'), { error: 'No import template named "invoices"' })
      }
    })
  },

  '/admin/import/columns': {
    get: op({
      tag: 'Admin · Members',
      permission: 'members.import',
      operationId: 'getImportColumns',
      summary: 'Describe the import columns',
      description:
        'The specification behind the template: which columns exist, which are required, ' +
        'what each expects, and the alternative headings that are still understood. The ' +
        'import screen renders its guidance from this rather than keeping a second copy.',
      parameters: [
        query('type', 'Which import to describe', { type: 'string', enum: ['members'], default: 'members' })
      ],
      responses: {
        200: json('The column specification.', object({
          key: str('Which import this is'),
          label: str('Human name for the import'),
          guidance: arrayOf({ type: 'string' }, 'Notes shown to whoever fills the sheet in'),
          columns: arrayOf(object({
            key: str('Column heading'),
            label: str('Human name'),
            required: bool('Whether an import fails without it'),
            notes: str('What the column expects'),
            aliases: arrayOf({ type: 'string' }, 'Other headings accepted for this column'),
            suggested: arrayOf({ type: 'string' }, 'Values worth sticking to, where it matters')
          }), 'One entry per column')
        }), {
          key: 'members',
          label: 'Members',
          guidance: ['Fill in one row per person. Delete the example rows before importing.'],
          columns: [
            { key: 'email', label: 'Email', required: true, notes: 'Their sign-in identity.', aliases: [], suggested: null },
            { key: 'name', label: 'Full name', required: true, notes: 'As they would write it.', aliases: ['full_name'], suggested: null }
          ]
        }),
        404: json('No such template.', ref('Error'), { error: 'No import template named "invoices"' })
      }
    })
  },

  '/admin/import': {
    post: op({
      tag: 'Admin · Members',
      permission: 'members.import',
      operationId: 'importMembers',
      summary: 'Bulk import members',
      description: [
        'Takes a JSON array, raw CSV pasted from a spreadsheet, or a base64 `.xlsx`',
        'straight out of Excel — whichever the operator already has.',
        '',
        'Set `dry_run` to count and preview without writing anything: the whole import runs',
        'inside a transaction that is then rolled back. Column names are matched loosely,',
        'so `full_name`, `organisation`, `dob`, `state` and `phone_number` are understood.',
        '',
        'Existing emails are skipped rather than overwritten, and Credit Direct addresses',
        'are refused — staff accounts are created under Roles.'
      ].join('\n'),
      requestBody: jsonBody(object({
        users: arrayOf(object({
          email: str('Required'), name: str('Required'),
          phone: str('Optional'), company: str('Optional'), work_sector: str('Optional'),
          date_of_birth: str('YYYY-MM-DD'), gender: str('Optional'),
          location_state: str('Optional'),
          api_products: str('Semicolon or pipe separated when coming from a spreadsheet')
        }), 'Rows as JSON'),
        csv: str('Raw CSV including a header row'),
        xlsx_base64: str('A base64-encoded .xlsx workbook', { format: 'byte' }),
        cohort_id: str('Also add every imported member to this cohort', { format: 'uuid' }),
        circle_id: str('Also seed this circle with them', { format: 'uuid' }),
        dry_run: bool('Count and preview without writing anything')
      }), {
        csv: 'email,name,company,work_sector\nchidi@paystack.africa,Chidi Nwosu,Paystack,Fintech\nada@flutterwave.com,Ada Eze,Flutterwave,Fintech',
        cohort_id: 'c2',
        dry_run: true
      }),
      responses: {
        200: json('What happened, or what would happen on a dry run.', object({
          message: str('Human summary'),
          dry_run: bool('Whether anything was actually written'),
          created: int('Members created'),
          skipped: int('Rows skipped because the email already exists'),
          errors: arrayOf(object({
            row: object({}, { description: 'The row as supplied' }),
            error: str('Why it was rejected')
          }), 'Rows that could not be imported'),
          preview: arrayOf(object({}), 'Up to ten normalised rows, on a dry run')
        }), {
          message: 'Dry run: 2 would be created, 0 already exist',
          dry_run: true, created: 2, skipped: 0,
          errors: [{ row: { email: 'ops@creditdirect.ng' }, error: '"ops@creditdirect.ng" is a Credit Direct address — add staff under Roles' }],
          preview: [{ email: 'chidi@paystack.africa', name: 'Chidi Nwosu', company: 'Paystack' }]
        }),
        400: json('No usable input, or a workbook that could not be read.', ref('Error'), {
          error: 'Provide a users array, a csv string, or xlsx_base64'
        })
      }
    })
  },

  '/admin/feedback/axes': {
    get: op({
      tag: 'Admin · Feedback',
      permission: 'feedback.read',
      operationId: 'getFeedbackAxes',
      summary: 'Ways feedback can be grouped',
      description:
        'The same body of verbatims can be cut by question, developer, survey, source, ' +
        'company, sector, stage, month, cohort or circle. Each axis names the filter ' +
        'that drills into one of its groups, so grouping and filtering compose.',
      responses: {
        200: json('The available groupings.', object({
          axes: arrayOf(object({
            key: str('Pass as group_by'),
            label: str('Human name'),
            describe: str('What reading it this way tells you'),
            filter: str('Query parameter that narrows to one group'),
            facet: bool('True where one answer can appear under several groups, as with cohorts')
          }), 'Every way of cutting the feedback up')
        }), {
          axes: [
            { key: 'question', label: 'Question', describe: 'What people answered when we asked the same thing', filter: 'question_id', facet: false },
            { key: 'cohort', label: 'Cohort', describe: 'What a segment is telling us', filter: 'cohort_id', facet: true }
          ]
        })
      }
    })
  },

  '/admin/feedback/grouped': {
    get: op({
      tag: 'Admin · Feedback',
      permission: 'feedback.read',
      operationId: 'getGroupedFeedback',
      summary: 'Feedback grouped along one axis',
      description: [
        'Groups first, verbatims on drill-in. Filters and grouping compose, so "what the',
        'lending cohort said, by question" is one call.',
        '',
        'Counts lead with distinct developers rather than answers: five people saying a',
        'thing once and one person saying it five times are different facts, and a single',
        'total renders them identically.'
      ].join('\n'),
      parameters: [
        query('group_by', 'Which axis to group along — see /admin/feedback/axes', { type: 'string', default: 'question' }),
        query('prompted', 'true for answers to questions, false for what was raised unprompted', { type: 'string', enum: ['true', 'false'] }),
        query('search', 'Match against the question or the answer'),
        query('question_id', 'Narrow to one question'),
        query('user_id', 'Narrow to one developer'),
        query('survey_id', 'Narrow to one survey, or one external system'),
        query('source', 'dev_circle, survey, external_survey, feex or customer_io'),
        query('cohort_id', 'Narrow to a cohort'),
        query('circle_id', 'Narrow to a circle'),
        query('since', 'Only what was said on or after this date')
      ],
      responses: {
        200: json('The groups, with the size of the evidence behind each.', object({
          group_by: str('Axis used'),
          groups: arrayOf(object({
            key: str('Value to pass to the axis filter'),
            label: str('What to show'),
            context: str('Secondary label, such as the company for a developer', { nullable: true }),
            developer_count: int('Distinct developers who said something in this group'),
            answer_count: int('Verbatims in this group'),
            last_at: timestamp('Most recent thing said')
          }), 'One entry per group'),
          totals: object({
            answers: int('Verbatims matching the filters'),
            developers: int('Distinct developers'),
            questions: int('Distinct questions answered')
          })
        }), {
          group_by: 'question',
          groups: [{
            key: 'a1b2c3d4-0000-4000-8000-000000000001',
            label: 'What could we improve about the onboarding?',
            context: null, developer_count: 6, answer_count: 6,
            last_at: '2026-08-14 09:12:00'
          }],
          totals: { answers: 35, developers: 13, questions: 7 }
        }),
        400: json('Unknown grouping.', ref('Error'), { error: 'Unknown grouping "colour"' })
      }
    })
  },

  '/admin/feedback/items': {
    get: op({
      tag: 'Admin · Feedback',
      permission: 'feedback.read',
      operationId: 'getFeedbackItems',
      summary: 'The verbatims themselves',
      description:
        'Flat rows for whatever the filters leave — what a table view reads, and what ' +
        'drilling into a group returns. Accepts every filter `/admin/feedback/grouped` does.',
      parameters: [
        query('question_id', 'Narrow to one question'),
        query('user_id', 'Narrow to one developer'),
        query('survey_id', 'Narrow to one survey or external system'),
        query('source', 'Where it reached us'),
        query('prompted', 'true for answers, false for unprompted', { type: 'string', enum: ['true', 'false'] }),
        query('search', 'Match against the question or the answer'),
        query('limit', 'How many to return', { type: 'integer', default: 200, maximum: 500 })
      ],
      responses: {
        200: json('The matching verbatims.', object({
          items: arrayOf(object({
            id: id('Feedback id'),
            content: str('What the developer wrote'),
            question: str('The question it answered', { nullable: true }),
            came_from: str('Survey title, or the system it was collected in'),
            source: str('dev_circle, survey, external_survey, feex, customer_io'),
            developer: str('Who said it'),
            company: str('Their company', { nullable: true }),
            created_at: timestamp('When they said it')
          }), 'Verbatims, newest first'),
          totals: object({
            answers: int('How many'), developers: int('Distinct developers'), questions: int('Distinct questions')
          })
        }), {
          items: [{
            id: '2b7e1f00-0000-4000-8000-000000000009',
            content: 'The webhook retry intervals are undocumented.',
            question: 'What could we improve about the onboarding?',
            came_from: 'Onboarding Experience Feedback', source: 'survey',
            developer: 'Chidi Nwosu', company: 'Paystack', created_at: '2026-08-01 10:04:00'
          }],
          totals: { answers: 6, developers: 6, questions: 1 }
        })
      }
    })
  },

  '/admin/feedback/export': {
    get: op({
      tag: 'Admin · Feedback',
      permission: 'export.read',
      operationId: 'exportFeedback',
      summary: 'Export verbatims',
      description: [
        'Every filter the screen accepts, and the same rows it is showing — the export',
        'reads through the same service, so a file can never disagree with the screen',
        'that asked for it.',
        '',
        'Passing `group_by` with `format=xlsx` puts each group on its own sheet, behind a',
        'contents tab: reading one question\'s answers side by side is the same reason to',
        'group on screen and to want them on their own tab.',
        '',
        'CSV values beginning with `=`, `+`, `-` or `@` are neutralised — every one of',
        'these values was typed by a developer, which is exactly the case that guards against.'
      ].join('\n'),
      parameters: [
        query('format', 'File format', { type: 'string', enum: ['csv', 'xlsx', 'json'], default: 'csv' }),
        query('group_by', 'With xlsx, produces one sheet per group'),
        query('question_id', 'Narrow to one question'),
        query('user_id', 'Narrow to one developer'),
        query('cohort_id', 'Narrow to a cohort'),
        query('prompted', 'true for answers, false for unprompted', { type: 'string', enum: ['true', 'false'] }),
        query('search', 'Match against the question or the answer')
      ],
      responses: {
        200: fileResponse(
          'The verbatims, in the requested format.',
          'text/csv',
          'said_at,developer,email,company,work_sector,api_status,source,came_from,question,answer\n2026-08-01,Chidi Nwosu,chidi@paystack.africa,Paystack,Fintech,production,survey,Onboarding Experience Feedback,What could we improve about the onboarding?,The webhook retry intervals are undocumented.'
        ),
        400: json('Unsupported format.', ref('Error'), { error: 'format must be csv, xlsx, or json' })
      }
    })
  },

  '/admin/feedback/export/count': {
    get: op({
      tag: 'Admin · Feedback',
      permission: 'export.read',
      operationId: 'countFeedbackExport',
      summary: 'Size an export before downloading it',
      description: 'How many verbatims, developers and questions the filters select.',
      parameters: [query('question_id', 'Narrow to one question'), query('cohort_id', 'Narrow to a cohort')],
      responses: {
        200: json('What the filters select.', object({
          total: int('Verbatims'), developers: int('Distinct developers'), questions: int('Distinct questions')
        }), { total: 35, developers: 13, questions: 7 })
      }
    })
  },

  '/admin/questions': {
    get: op({
      tag: 'Admin · Feedback',
      permission: 'feedback.read',
      operationId: 'listQuestions',
      summary: 'Questions that have drawn written answers',
      description: [
        'A question is a thing in its own right rather than an entry inside one survey, so',
        'answers to it read together whichever survey carried it — including surveys run',
        'outside Dev Circle.',
        '',
        'A survey normally asks several open questions, so a survey and a question are not',
        'the same unit: four surveys can produce seven questions.'
      ].join('\n'),
      parameters: [query('search', 'Match against the question text or its answers')],
      responses: {
        200: json('Questions, most-answered first.', object({
          questions: arrayOf(object({
            id: id('Question id'),
            text: str('The question as asked'),
            developer_count: int('Distinct developers who answered'),
            answer_count: int('Answers collected'),
            survey_count: int('How many surveys or systems have carried it'),
            external_source: str('Set when the question belongs to a form run elsewhere', { nullable: true }),
            last_answered_at: timestamp('Most recent answer')
          }), 'One entry per question'),
          totals: object({ questions: int('Questions'), developers: int('Distinct developers'), answers: int('Answers') })
        }), {
          questions: [{
            id: 'a1b2c3d4-0000-4000-8000-000000000001',
            text: 'What could we improve about the onboarding?',
            developer_count: 6, answer_count: 6, survey_count: 1,
            external_source: null, last_answered_at: '2026-08-14 09:12:00'
          }],
          totals: { questions: 7, developers: 13, answers: 35 }
        })
      }
    })
  },

  '/admin/questions/{id}': {
    get: op({
      tag: 'Admin · Feedback',
      permission: 'feedback.read',
      operationId: 'getQuestion',
      summary: 'One question and everything said in answer to it',
      description:
        'Answers from every survey that has carried this question, with who said each one. ' +
        '`asked_in` lists the occasions, so a question asked three times over a year reads ' +
        'as one body of evidence rather than three.',
      parameters: [path('id', 'Question id')],
      responses: {
        200: json('The question and its answers.', object({
          question: object({ id: id('Question id'), text: str('As asked'), type: str('Question type') }),
          asked_in: arrayOf(object({
            id: id('Survey id'), title: str('Survey title'), developer_count: int('Answers from that round')
          }), 'Surveys that carried it'),
          developer_count: int('Distinct developers who answered'),
          answers: arrayOf(object({
            content: str('What they wrote'),
            user_name: str('Who said it'),
            user_company: str('Their company', { nullable: true }),
            survey_title: str('Which round', { nullable: true }),
            created_at: timestamp('When')
          }), 'Every answer, newest first')
        }), {
          question: { id: 'a1b2c3d4-0000-4000-8000-000000000001', text: 'What could we improve about the onboarding?', type: 'text' },
          asked_in: [{ id: MEMBER_ID, title: 'Onboarding Experience Feedback', developer_count: 6 }],
          developer_count: 6,
          answers: [{
            content: 'The webhook retry intervals are undocumented.',
            user_name: 'Chidi Nwosu', user_company: 'Paystack',
            survey_title: 'Onboarding Experience Feedback', created_at: '2026-08-01 10:04:00'
          }]
        }),
        404: json('No such question.', ref('Error'), { error: 'Question not found' })
      }
    })
  },

  '/admin/questions-reusable': {
    get: op({
      tag: 'Admin · Surveys',
      permission: 'surveys.write',
      operationId: 'listReusableQuestions',
      summary: 'Questions a survey can carry on',
      description: [
        'Offered while writing a survey, with how much each has already collected.',
        '',
        'Questions are not a fixed library: every discovery initiative asks whatever it',
        'needs, new questions are the ordinary case, and a question asked exactly once is',
        'a normal question. Reuse only makes *continuing* a question possible.'
      ].join('\n'),
      parameters: [query('type', 'Question type', { type: 'string', default: 'text' })],
      responses: {
        200: json('Questions that can be carried on.', object({
          questions: arrayOf(object({
            id: id('Question id'), text: str('As asked'),
            developer_count: int('Developers who have answered it'),
            survey_count: int('Surveys that have carried it')
          }), 'Reusable questions')
        }), {
          questions: [{
            id: 'a1b2c3d4-0000-4000-8000-000000000001',
            text: 'What could we improve about the onboarding?',
            developer_count: 6, survey_count: 1
          }]
        })
      }
    })
  },

  '/admin/questions/suggest': {
    post: op({
      tag: 'Admin · Surveys',
      permission: 'surveys.write',
      operationId: 'suggestQuestions',
      summary: 'Have we asked this before?',
      description: [
        'Questions already asked that read like the one being written, so the author can',
        'join the evidence up if they meant the same thing.',
        '',
        'This only ever suggests. Two initiatives can ask "Any other feedback?" about',
        'entirely different things, and merging them silently would be unrecoverable —',
        'separate piles can be joined later, a merged pile cannot be taken apart.'
      ].join('\n'),
      requestBody: jsonBody(object({
        text: str('The question being written'),
        type: str('Question type', { default: 'text' })
      }), { text: 'What could we improve about the onboarding?', type: 'text' }),
      responses: {
        200: json('Questions that read the same.', object({
          matches: arrayOf(object({
            id: id('Question id'), text: str('As previously asked'),
            developer_count: int('Developers who answered it'),
            survey_count: int('Surveys that carried it')
          }), 'Possible continuations — never applied automatically')
        }), {
          matches: [{
            id: 'a1b2c3d4-0000-4000-8000-000000000001',
            text: 'What could we improve about the onboarding?',
            developer_count: 6, survey_count: 1
          }]
        })
      }
    })
  },

  '/admin/members/{id}/timeline': {
    get: op({
      tag: 'Admin · Members',
      permission: 'members.read',
      operationId: 'getMemberTimeline',
      summary: 'Everything one developer did and said',
      description: [
        'One stream: the milestones the system recorded, every verbatim from every source,',
        'and the messages we sent them — in the order it happened.',
        '',
        'Reading it across three tabs and stitching the order together in your head was',
        'what made a developer hard to see whole.'
      ].join('\n'),
      parameters: [path('id', 'Member id'), query('limit', 'How many entries', { type: 'integer', default: 150 })],
      responses: {
        200: json('The member, whole.', object({
          timeline: arrayOf(object({
            kind: str('did, said or sent', { enum: ['did', 'said', 'sent'] }),
            at: timestamp('When it happened'),
            label: str('What happened, for a milestone', { nullable: true }),
            content: str('What they wrote, for a verbatim', { nullable: true }),
            prompt: str('The question it answered', { nullable: true }),
            source: str('Where it came from'),
            detail: str('Survey, reward or system it relates to', { nullable: true })
          }), 'Newest first'),
          counts: object({
            did: int('Milestones'), said: int('Verbatims'), sent: int('Messages delivered'),
            questions_answered: int('Distinct questions this developer has answered')
          })
        }), {
          timeline: [
            { kind: 'said', at: '2026-08-14 09:12:00', label: null,
              content: 'Waiting on KYB with no visibility. We had engineers idle for a week.',
              prompt: 'What is the single biggest friction in going live?',
              source: 'external_survey', detail: 'google forms' },
            { kind: 'did', at: '2026-07-16 11:00:00', label: 'first production call',
              content: null, prompt: null, source: 'customer_io', detail: null }
          ],
          counts: { did: 6, said: 5, sent: 0, questions_answered: 4 }
        }),
        404: json('No such member.', ref('Error'), { error: 'Member not found' })
      }
    })
  },

  '/admin/export/fields': {
    get: op({
      tag: 'Admin · Members',
      permission: 'export.read',
      operationId: 'getExportFields',
      summary: 'What an export can be filtered and sliced by',
      description: [
        'Every criterion that separates one member from another — demography, sector,',
        'product, cohort, circle, consent, engagement and activity — together with the',
        'columns an export can carry.',
        '',
        'Each criterion carries the values to choose between, resolved either from the',
        'domain (`active`, `suspended`) or from the member base itself (the sectors and',
        'states anyone actually holds). A filter builder renders straight from this and',
        'never keeps its own copy of a value list.',
        '',
        'This is the same catalogue `GET /admin/cohorts/rule-fields` returns, so a',
        'criterion added to the rule engine reaches cohorts, list filters and exports at once.'
      ].join('\n'),
      responses: {
        200: json('The criteria and columns.', object({
          criteria: arrayOf(ref('Criterion'), 'Everything a member can be separated by'),
          columns: arrayOf({ type: 'string' }, 'Columns an export can carry')
        }), {
          criteria: [
            {
              field: 'status', label: 'Account status', type: 'text', unit: null,
              operators: ['eq', 'neq'],
              values: [
                { value: 'active', label: 'active' },
                { value: 'inactive', label: 'inactive' },
                { value: 'suspended', label: 'suspended' }
              ],
              empty: false, open: false
            },
            {
              field: 'age', label: 'Age', type: 'number', unit: 'years',
              operators: ['gte', 'lte', 'eq', 'gt', 'lt'],
              values: null, empty: false, open: false
            },
            {
              field: 'cohort_id', label: 'Member of cohort', type: 'membership', unit: null,
              operators: ['eq', 'neq'],
              values: [{ value: '5c9d1e77-3a2b-4f80-9d11-6c2e4a7b8f31', label: 'All Members' }],
              empty: false, open: false
            }
          ],
          columns: ['id', 'email', 'name', 'age', 'cohorts', 'consented_channels']
        })
      }
    })
  },

  '/admin/export/count': {
    get: op({
      tag: 'Admin · Members',
      permission: 'export.read',
      operationId: 'countExportMembers',
      summary: 'Count what the criteria match',
      description:
        'How many members a set of criteria selects, without building the file. Cheap ' +
        'enough to call on every edit of a filter, so the size of an export is known ' +
        'before it is downloaded.',
      parameters: [
        query('rules', 'A rule definition, JSON-encoded — the same shape a cohort is built from'),
        ...memberFilterParams
      ],
      responses: {
        200: json('How many match.', object({ total: int('Matching members') }), { total: 42 }),
        400: json('A criterion could not be understood.', ref('Error'), { error: 'Unknown field "shoe_size"' })
      }
    })
  },

  '/admin/export': {
    get: op({
      tag: 'Admin · Members',
      permission: 'export.read',
      operationId: 'exportMembers',
      summary: 'Export members as JSON, CSV or Excel',
      description: [
        'Filter with any criterion a cohort can be built from, passed as `rules` — cohort,',
        'circle, age, sector, state, product, consent, engagement, activity — alone or',
        'combined with `match: all` or `match: any`. The simpler query parameters the member',
        'list uses are accepted too, and combine with the rules.',
        '',
        'Narrow the file with `columns`. CSV values beginning with `=`, `+`, `-` or `@` are',
        'neutralised so Excel does not evaluate them as formulas.',
        '',
        'Call `/admin/export/fields` for the criteria and `/admin/export/count` to size the',
        'result first.'
      ].join('\n'),
      parameters: [
        query('format', 'Response format', { type: 'string', enum: ['json', 'csv', 'xlsx'], default: 'json' }),
        query('rules', 'A rule definition, JSON-encoded. Example: `{"match":"all","rules":[{"field":"age","op":"gte","value":30}]}`'),
        query('columns', 'Comma-separated columns to include. Defaults to all of them.'),
        ...memberFilterParams
      ],
      responses: {
        200: {
          description: 'The matching members, in the requested format.',
          content: {
            'application/json': {
              schema: object({
                users: arrayOf(ref('Member'), 'Matching members, with cohorts and consented channels flattened'),
                total: int('How many were returned'),
                columns: arrayOf({ type: 'string' }, 'Columns carried in this export')
              }),
              example: {
                users: [{
                  id: MEMBER_ID, email: 'chidi@paystack.africa', name: 'Chidi Nwosu',
                  company: 'Paystack', api_status: 'sandbox', age: 34, surveys_completed: 3,
                  gifts_claimed: 1, cohorts: ['All Members'], consented_channels: ['email', 'in_portal']
                }],
                total: 248,
                columns: ['id', 'email', 'name']
              }
            },
            'text/csv': {
              schema: { type: 'string' },
              example: 'email,name,age,work_sector\nchidi@paystack.africa,Chidi Nwosu,34,Fintech'
            },
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
              schema: { type: 'string', format: 'binary' }
            }
          }
        },
        400: json('A criterion or format could not be understood.', ref('Error'),
          { error: 'format must be json, csv, or xlsx' })
      }
    })
  },

  // ─── Cohorts ──────────────────────────────────────────────
  '/admin/cohorts': {
    get: op({
      tag: 'Admin · Cohorts',
      permission: 'cohorts.read',
      operationId: 'listCohorts',
      summary: 'List cohorts',
      parameters: [query('circle_id', 'Only cohorts belonging to this circle', { type: 'string', format: 'uuid' })],
      responses: {
        200: json('Cohorts, largest first.', object({ cohorts: arrayOf(ref('Cohort'), 'Cohorts') }), {
          cohorts: [{
            id: 'c2', name: 'Production integrators', type: 'custom', color: '#107EBC',
            filter_rules: { match: 'all', conditions: [{ field: 'api_status', operator: 'eq', value: 'production' }] },
            auto_sync: 1, member_count: 57, circle_name: 'Dev Circle',
            last_synced_at: '2026-08-14 06:00:00', created_at: '2026-04-02 11:00:00'
          }]
        })
      }
    }),
    post: op({
      tag: 'Admin · Cohorts',
      permission: 'cohorts.write',
      operationId: 'createCohort',
      summary: 'Create a cohort',
      description: [
        'A rule set is validated before it is stored, so a cohort can never be saved with a',
        'definition the engine cannot evaluate — and it is populated immediately rather',
        'than sitting empty until something else triggers a sync.'
      ].join('\n'),
      requestBody: jsonBody(object({
        name: str('Cohort name'),
        description: str('What it is for'),
        color: str('Hex swatch', { default: '#107EBC' }),
        type: str('System cohorts cannot be deleted', { enum: ['system', 'custom'], default: 'custom' }),
        filter_rules: ref('FilterRules'),
        auto_sync: bool('Keep membership current as members change', { default: true }),
        circle_id: str('Circle it belongs to. Defaults to the root circle', { format: 'uuid' })
      }, { required: ['name'] }), {
        name: 'Production integrators',
        description: 'Anyone who has made a live call',
        color: '#107EBC',
        filter_rules: { match: 'all', conditions: [{ field: 'api_status', operator: 'eq', value: 'production' }] },
        auto_sync: true
      }),
      responses: {
        201: json('Created, and populated if it has rules.', object({
          cohort: ref('Cohort'),
          sync: object({
            added: int('Members matched on creation'),
            removed: int('Always 0 here'),
            total: int('Members in the cohort now')
          })
        }), {
          cohort: { id: 'c2', name: 'Production integrators', auto_sync: 1, member_count: 57 },
          sync: { added: 57, removed: 0, total: 57 }
        }),
        400: json('Missing name, unknown circle, or rules that do not evaluate.', ref('Error'), {
          error: 'Unknown field "api_stage" in filter rules'
        })
      }
    })
  },

  '/admin/cohorts/rule-fields': {
    get: op({
      tag: 'Admin · Cohorts',
      permission: 'cohorts.read',
      operationId: 'getCohortRuleFields',
      summary: 'What a cohort can be defined by',
      description: [
        'Every criterion the rule engine understands, with the operators it accepts and',
        'the values to choose between — resolved from the domain, or from the values',
        'members actually hold.',
        '',
        'The same catalogue backs `GET /admin/export/fields`, so the cohort builder and',
        'the export filter offer identical choices.'
      ].join('\n'),
      responses: {
        200: json('The criteria a cohort can be built from.', object({
          fields: arrayOf(ref('Criterion'), 'Everything a member can be separated by')
        }), {
          fields: [{
            field: 'preferred_channels', label: 'Preferred channel', type: 'array', unit: null,
            operators: ['eq', 'neq'],
            values: [
              { value: 'email', label: 'email' },
              { value: 'whatsapp', label: 'whatsapp' },
              { value: 'sms', label: 'sms' },
              { value: 'calls', label: 'calls' },
              { value: 'in_portal', label: 'in_portal' }
            ],
            empty: false, open: false
          }]
        })
      }
    })
  },

  '/admin/cohorts/preview': {
    post: op({
      tag: 'Admin · Cohorts',
      permission: 'cohorts.read',
      operationId: 'previewCohortRules',
      summary: 'Count who a rule set would match',
      description: 'Run before saving, so an operator sees the size of a segment before committing to it.',
      requestBody: jsonBody(object({ filter_rules: ref('FilterRules') }, { required: ['filter_rules'] }), {
        filter_rules: {
          match: 'all',
          conditions: [
            { field: 'api_status', operator: 'eq', value: 'production' },
            { field: 'engagement_streak', operator: 'gte', value: 3 }
          ]
        }
      }),
      responses: {
        200: json('How many match, with a sample.', object({
          total: int('Members matching the rules'),
          members: arrayOf(ref('MemberSummary'), 'The first ten matches')
        }), {
          total: 34,
          members: [{ id: MEMBER_ID, name: 'Chidi Nwosu', email: 'chidi@paystack.africa', company: 'Paystack' }]
        }),
        400: json('The rules could not be evaluated.', ref('Error'), {
          error: 'Unknown operator "matches" for field "company"'
        })
      }
    })
  },

  '/admin/cohorts/{id}': {
    put: op({
      tag: 'Admin · Cohorts',
      permission: 'cohorts.write',
      operationId: 'updateCohort',
      summary: 'Update a cohort',
      description: 'Changing `filter_rules` re-runs them, so membership matches the new definition when the call returns.',
      parameters: [path('id', 'Cohort id')],
      requestBody: jsonBody(object({
        name: str('Cohort name'),
        description: str('What it is for'),
        color: str('Hex swatch'),
        filter_rules: { ...ref('FilterRules'), nullable: true },
        auto_sync: bool('Keep membership current automatically')
      }), { name: 'Live integrators', auto_sync: true }),
      responses: {
        200: json('The updated cohort, and the result of any re-sync.', object({
          cohort: ref('Cohort'),
          sync: { ...object({
            added: int('Members added'), removed: int('Members removed'), total: int('Members now')
          }), nullable: true, description: 'Null when the rules were not touched' }
        }), {
          cohort: { id: 'c2', name: 'Live integrators', auto_sync: 1, member_count: 57 },
          sync: { added: 2, removed: 1, total: 57 }
        }),
        400: json('Nothing to update, or rules that do not evaluate.', ref('Error'), { error: 'No fields to update' }),
        404: json('No such cohort.', ref('Error'), { error: 'Cohort not found' })
      }
    }),
    delete: op({
      tag: 'Admin · Cohorts',
      permission: 'cohorts.write',
      operationId: 'deleteCohort',
      summary: 'Delete a cohort',
      description: 'Removes the cohort and its memberships. Members themselves are untouched. System cohorts cannot be deleted.',
      parameters: [path('id', 'Cohort id')],
      responses: {
        200: json('Deleted.', object({ message: str('Confirmation') }), { message: 'Cohort deleted' }),
        400: json('It is a system cohort.', ref('Error'), { error: 'Cannot delete system cohorts' }),
        404: json('No such cohort.', ref('Error'), { error: 'Cohort not found' })
      }
    })
  },

  '/admin/cohorts/{id}/sync': {
    post: op({
      tag: 'Admin · Cohorts',
      permission: 'cohorts.write',
      operationId: 'syncCohort',
      summary: 'Re-run a cohort\'s rules now',
      parameters: [path('id', 'Cohort id')],
      responses: {
        200: json('What the re-run changed.', object({
          added: int('Members who now match'),
          removed: int('Members who no longer match'),
          total: int('Members in the cohort')
        }), { added: 4, removed: 1, total: 60 }),
        404: json('No such cohort, or it has no rules to run.', ref('Error'), { error: 'Cohort not found' })
      }
    })
  },

  '/admin/cohorts/{id}/members': {
    post: op({
      tag: 'Admin · Cohorts',
      permission: 'cohorts.write',
      operationId: 'addCohortMembers',
      summary: 'Add members to a cohort',
      description: 'Ids that do not exist come back in `unknown` rather than failing the whole call. Adding somebody already in the cohort is a no-op.',
      parameters: [path('id', 'Cohort id')],
      requestBody: jsonBody(object({
        user_ids: arrayOf({ type: 'string', format: 'uuid' }, 'Members to add')
      }, { required: ['user_ids'] }), { user_ids: [MEMBER_ID, '2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d'] }),
      responses: {
        200: json('What was added.', object({
          message: str('Human summary'),
          added: int('Members actually added'),
          unknown: arrayOf({ type: 'string' }, 'Ids that matched no member'),
          member_count: int('Members in the cohort now')
        }), { message: '2 member(s) added', added: 2, unknown: [], member_count: 59 }),
        400: json('`user_ids` was not an array.', ref('Error'), { error: 'user_ids array required' }),
        404: json('No such cohort.', ref('Error'), { error: 'Cohort not found' })
      }
    })
  },

  '/admin/cohorts/{id}/members/{userId}': {
    delete: op({
      tag: 'Admin · Cohorts',
      permission: 'cohorts.write',
      operationId: 'removeCohortMember',
      summary: 'Remove a member from a cohort',
      parameters: [path('id', 'Cohort id'), path('userId', 'Member id')],
      responses: {
        200: json('Removed.', object({ message: str('Confirmation') }), { message: 'Member removed from cohort' })
      }
    })
  },

  // ─── Circles ──────────────────────────────────────────────
  '/admin/circles/all': {
    get: op({
      tag: 'Admin · Circles',
      permission: 'circles.read',
      operationId: 'listAllCircles',
      summary: 'Every workspace',
      description:
        'For the tier of Credit Direct staff who span circles. Ordinary staff see ' +
        'only the circles they hold a role in, through `GET /admin/circles`.',
      parameters: [query('include_archived', 'Include archived circles', { type: 'boolean', default: false })],
      responses: {
        200: json('Every circle.', object({
          circles: arrayOf(ref('Circle'), 'All workspaces')
        }), {
          circles: [
            { id: 'r1', name: 'Dev Circle', slug: 'dev-circle', member_count: 248, status: 'active' },
            { id: 'r2', name: 'Merchant Circle', slug: 'merchant-circle', member_count: 61, status: 'active' }
          ]
        }),
        403: json('Not a staff member who spans circles.', ref('Error'), {
          error: 'Only Credit Direct staff with access across circles can do this.'
        })
      }
    })
  },

  '/admin/circles/{id}/staff': {
    post: op({
      tag: 'Admin · Circles',
      permission: 'circles.write',
      operationId: 'grantCircleAccess',
      summary: 'Give a staff member a role in this workspace',
      description: [
        'A role is held *within* a circle. Granting one here lets that person work in',
        'this workspace and nowhere else — a rep for one circle has no business in',
        'another, and before circles were workspaces every admin could see everything.',
        '',
        'Only staff who span circles may grant access.'
      ].join('\n'),
      parameters: [path('id', 'Circle id')],
      requestBody: jsonBody(object({
        admin_id: id('The staff member'),
        role_id: id('The role they hold in this circle')
      }, { required: ['admin_id', 'role_id'] }), {
        admin_id: '3c8a1b20-0000-4000-8000-000000000004',
        role_id: '7d2e9f10-0000-4000-8000-000000000002'
      }),
      responses: {
        200: json('Access granted.', object({ message: str('What happened') }),
          { message: 'Access granted to this circle' }),
        400: json('Unknown admin or role.', ref('Error'), { error: 'Unknown admin_id' }),
        403: json('Not a staff member who spans circles.', ref('Error'), {
          error: 'Only Credit Direct staff with access across circles can do this.'
        })
      }
    })
  },

  '/admin/circles/{id}/staff/{adminId}': {
    delete: op({
      tag: 'Admin · Circles',
      permission: 'circles.write',
      operationId: 'revokeCircleAccess',
      summary: 'Take away a staff member\'s access to this workspace',
      description:
        'They keep any role they hold in other circles. Revoking the last one leaves ' +
        'them signed in with nowhere to work, which the console reports plainly.',
      parameters: [path('id', 'Circle id'), path('adminId', 'The staff member')],
      responses: {
        200: json('Access revoked.', object({ message: str('What happened') }),
          { message: 'Access revoked' }),
        404: json('They did not have access to begin with.', ref('Error'),
          { error: 'They did not have access to this circle' })
      }
    })
  },

  '/admin/circles': {
    get: op({
      tag: 'Admin · Circles',
      permission: 'circles.read',
      operationId: 'listCircles',
      summary: 'List circles',
      description: 'Circles nest. The root circle holds every member and is where work lands when no circle is named.',
      responses: {
        200: json('Every circle, with member counts, plus the root.', object({
          circles: arrayOf(ref('Circle'), 'All circles'),
          root: ref('Circle')
        }), {
          circles: [
            { id: 'r1', name: 'Dev Circle', slug: 'dev-circle', is_root: 1, parent_id: null, member_count: 248, status: 'active' },
            { id: 'p2', name: 'Payments guild', slug: 'payments-guild', is_root: 0, parent_id: 'r1', member_count: 34, status: 'active' }
          ],
          root: { id: 'r1', name: 'Dev Circle', slug: 'dev-circle', is_root: 1 }
        })
      }
    }),
    post: op({
      tag: 'Admin · Circles',
      permission: 'circles.write',
      operationId: 'createCircle',
      summary: 'Create a circle',
      description: 'A new circle usually starts from an existing segment, so `seed_from_cohort_id` fills it in one step rather than adding members one at a time.',
      requestBody: jsonBody(object({
        name: str('Circle name'),
        description: str('What it is for'),
        color: str('Hex swatch'),
        parent_id: str('Circle to nest under. Defaults to the root', { format: 'uuid' }),
        seed_from_cohort_id: str('Add everyone in this cohort as members', { format: 'uuid' })
      }, { required: ['name'] }), {
        name: 'Payments guild',
        description: 'Developers building on the payments APIs',
        color: '#7C3AED',
        seed_from_cohort_id: 'c3'
      }),
      responses: {
        201: json('Created.', object({
          circle: ref('Circle'),
          seeded: { ...object({ added: int('Members added from the cohort') }), nullable: true }
        }), {
          circle: { id: 'p2', name: 'Payments guild', slug: 'payments-guild', parent_id: 'r1', status: 'active' },
          seeded: { added: 34 }
        }),
        400: json('Missing name, unknown parent, or a name already in use.', ref('Error'), {
          error: 'A circle with that name already exists'
        })
      }
    })
  },

  '/admin/circles/{id}': {
    get: op({
      tag: 'Admin · Circles',
      permission: 'circles.read',
      operationId: 'getCircle',
      summary: 'One circle and everything scoped to it',
      parameters: [
        path('id', 'Circle id'),
        query('page', 'Page of members', { type: 'integer', minimum: 1, default: 1 }),
        query('limit', 'Members per page, capped at 100', { type: 'integer', maximum: 100, default: 20 })
      ],
      responses: {
        200: json('The circle, its place in the tree, and the work inside it.', object({
          circle: ref('Circle'),
          parent: { ...ref('Circle'), nullable: true },
          children: arrayOf(ref('Circle'), 'Circles nested directly under this one'),
          member_count: int('Members in the circle'),
          members: arrayOf(ref('MemberSummary'), 'A page of members'),
          cohorts: arrayOf(ref('Cohort'), 'Cohorts scoped to this circle'),
          surveys: arrayOf(ref('Survey'), 'Surveys scoped to this circle')
        }), {
          circle: { id: 'p2', name: 'Payments guild', slug: 'payments-guild', status: 'active' },
          parent: { id: 'r1', name: 'Dev Circle', slug: 'dev-circle' },
          children: [], member_count: 34,
          members: [{ id: MEMBER_ID, name: 'Chidi Nwosu', email: 'chidi@paystack.africa' }],
          cohorts: [{ id: 'c3', name: 'Payments early access', member_count: 12 }],
          surveys: [{ id: 's4', title: 'Payments API pain points', status: 'draft', engagement_mode: 'in_portal' }]
        }),
        404: json('No such circle.', ref('Error'), { error: 'Circle not found' })
      }
    }),
    put: op({
      tag: 'Admin · Circles',
      permission: 'circles.write',
      operationId: 'updateCircle',
      summary: 'Rename or restyle a circle',
      parameters: [path('id', 'Circle id')],
      requestBody: jsonBody(object({
        name: str('Circle name'), description: str('What it is for'), color: str('Hex swatch')
      }), { name: 'Payments guild', color: '#7C3AED' }),
      responses: {
        200: json('The updated circle.', object({ circle: ref('Circle') }), {
          circle: { id: 'p2', name: 'Payments guild', color: '#7C3AED' }
        }),
        400: json('Nothing to update.', ref('Error'), { error: 'No fields to update' }),
        404: json('No such circle.', ref('Error'), { error: 'Circle not found' })
      }
    }),
    delete: op({
      tag: 'Admin · Circles',
      permission: 'circles.write',
      operationId: 'archiveCircle',
      summary: 'Archive a circle',
      description: 'Archived rather than deleted, so the engagement history attached to the circle\'s work survives. The root circle cannot be archived.',
      parameters: [path('id', 'Circle id')],
      responses: {
        200: json('Archived.', object({ message: str('Confirmation') }), { message: 'Circle archived' }),
        400: json('It is the root circle, or it still has active children.', ref('Error'), {
          error: 'The root circle cannot be archived'
        })
      }
    })
  },

  '/admin/circles/{id}/candidates': {
    get: op({
      tag: 'Admin · Circles',
      permission: 'circles.read',
      operationId: 'getCircleCandidates',
      summary: 'Members who could join this circle',
      description: 'Active members not already in it — and, for a nested circle, only members of its parent, since a sub-circle is drawn from the circle above it.',
      parameters: [
        path('id', 'Circle id'),
        query('search', 'Matches name, email or company')
      ],
      responses: {
        200: json('Up to 100 candidates.', object({
          candidates: arrayOf(object({
            id: str('Member id'), name: str('Full name'), email: str('Email'),
            company: str('Employer', { nullable: true }), work_sector: str('Industry', { nullable: true })
          }), 'Members who could be added')
        }), {
          candidates: [{ id: MEMBER_ID, name: 'Chidi Nwosu', email: 'chidi@paystack.africa', company: 'Paystack', work_sector: 'Fintech' }]
        }),
        404: json('No such circle.', ref('Error'), { error: 'Circle not found' })
      }
    })
  },

  '/admin/circles/{id}/members': {
    post: op({
      tag: 'Admin · Circles',
      permission: 'circles.write',
      operationId: 'addCircleMembers',
      summary: 'Add members to a circle',
      description: 'Members can be named outright, pulled in by cohort, or matched by an ad-hoc rule set using the same engine that powers cohorts. The three combine.',
      parameters: [path('id', 'Circle id')],
      requestBody: jsonBody(object({
        user_ids: arrayOf({ type: 'string', format: 'uuid' }, 'Members to add by id'),
        cohort_id: str('Add everyone in this cohort', { format: 'uuid' }),
        filter_rules: ref('FilterRules'),
        role: str('Whether they join as members or leads', { enum: ['member', 'lead'], default: 'member' })
      }), { cohort_id: 'c3', role: 'member' }),
      responses: {
        200: json('What was added.', object({
          added: int('Members actually added'),
          skipped: int('Members already in the circle, or not in its parent'),
          member_count: int('Members in the circle now')
        }), { added: 34, skipped: 2, member_count: 36 }),
        400: json('Nothing to add, or rules that do not evaluate.', ref('Error'), {
          error: 'Provide user_ids, a cohort_id, or filter_rules'
        })
      }
    })
  },

  '/admin/circles/{id}/members/{userId}': {
    delete: op({
      tag: 'Admin · Circles',
      permission: 'circles.write',
      operationId: 'removeCircleMember',
      summary: 'Remove a member from a circle',
      description: 'Removing somebody from a circle also removes them from every circle beneath it — membership of a sub-circle only makes sense inside its parent.',
      parameters: [path('id', 'Circle id'), path('userId', 'Member id')],
      responses: {
        200: json('Removed.', object({
          message: str('Confirmation'),
          removed_from: arrayOf({ type: 'string' }, 'Every circle they were removed from')
        }), { message: 'Member removed', removed_from: ['p2', 'p2-beta'] }),
        404: json('They are not in this circle.', ref('Error'), { error: 'Member is not in this circle' })
      }
    })
  },

  // ─── Surveys ──────────────────────────────────────────────
  '/admin/surveys': {
    get: op({
      tag: 'Admin · Surveys',
      permission: 'surveys.read',
      operationId: 'listSurveys',
      summary: 'List surveys with response counts',
      responses: {
        200: json('Surveys, newest first.', object({ surveys: arrayOf(ref('Survey'), 'Surveys') }), {
          surveys: [{
            id: 's1', title: 'Sandbox onboarding experience', status: 'active',
            questions: [{ id: 'q1_8c3d21ff', type: 'rating', text: 'How clear is our API documentation?' }],
            target_type: 'cohort', target_ids: ['c2'], engagement_mode: 'email',
            time_estimate_min: 5, response_count: 78, completed_count: 51,
            created_at: '2026-07-01 10:00:00'
          }]
        })
      }
    }),
    post: op({
      tag: 'Admin · Surveys',
      permission: 'surveys.write',
      operationId: 'createSurvey',
      summary: 'Create a survey',
      description: [
        'Send `status: "active"` to publish immediately; anything else is saved as a draft',
        'and activated later with `PUT /admin/surveys/{id}`. Every question is given a',
        'stable id if you do not supply one, because responses, branching and exports are',
        'keyed by it.',
        '',
        'Questions are validated against the survey schema — see `GET /admin/surveys/schema`',
        'for the types and what each accepts. A survey that cannot be answered is refused',
        'with every reason at once, each carrying the index of the question it belongs to.',
        'A draft may have no questions yet; an active survey may not.',
        '',
        'Setting `trigger_event` wires the survey to an integration event, so a member is',
        'invited automatically the first time they do that thing.'
      ].join('\n'),
      requestBody: jsonBody(object({
        title: str('Survey title'),
        description: str('Shown above the questions'),
        questions: arrayOf(ref('SurveyQuestion'), 'The questions, in order'),
        theme: ref('SurveyTheme'),
        status: str('Publish on creation, or keep it as a draft', { enum: ['draft', 'active'], default: 'draft' }),
        target_type: str('Who it is for', { enum: ['all', 'cohort', 'specific'], default: 'all' }),
        target_ids: arrayOf({ type: 'string' }, 'Cohort or member ids, depending on target_type'),
        engagement_mode: str('How the invitation reaches them', { enum: ['1-on-1', 'email', 'whatsapp', 'in_portal'], default: 'in_portal' }),
        time_estimate_min: int('Minutes it takes, quoted to the member', { default: 5 }),
        expires_at: str('When it closes itself'),
        trigger_event: str('Integration event that auto-invites a member'),
        reminder_after_days: int('Days of silence before a reminder is queued'),
        circle_id: str('Circle it belongs to. Defaults to the root circle', { format: 'uuid' })
      }, { required: ['title', 'questions'] }), {
        title: 'Sandbox onboarding experience',
        description: 'Five minutes on how your first integration went.',
        questions: [
          { id: 'q1_8c3d21ff', type: 'nps', text: 'How likely are you to recommend our APIs to another developer?', required: true },
          {
            type: 'multi_choice', text: 'What slowed you down most?',
            options: ['Documentation', 'Sandbox errors', 'Latency', 'Support response time'],
            min_select: 1, max_select: 2, allow_other: true,
            // Only asked of the developers who are not recommending us
            visible_if: { match: 'all', rules: [{ question: 'q1_8c3d21ff', op: 'lte', value: 6 }] }
          },
          { type: 'text', text: 'Anything else we should know?', multiline: true, max_length: 500 }
        ],
        theme: { accent: '#107EBC', progress: 'steps' },
        target_type: 'cohort',
        target_ids: ['c2'],
        engagement_mode: 'email',
        time_estimate_min: 5,
        trigger_event: 'first_sandbox_call',
        reminder_after_days: 3
      }),
      responses: {
        201: json('Created.', object({ survey: ref('Survey') }), {
          survey: {
            id: 's1', title: 'Sandbox onboarding experience', status: 'draft',
            questions: [{ id: 'q1_8c3d21ff', type: 'nps', text: 'How likely are you to recommend our APIs to another developer?', required: true, scale: 10 }],
            engagement_mode: 'email', time_estimate_min: 5
          }
        }),
        400: json('Missing fields, or a survey that cannot be answered.', ref('Error'), {
          error: 'Question 2: Needs at least two options to choose between',
          issues: [{ index: 1, number: 2, field: 'options', message: 'Needs at least two options to choose between' }]
        })
      }
    })
  },

  '/admin/uploads': {
    post: op({
      tag: 'Admin · Surveys',
      permission: 'surveys.write',
      operationId: 'uploadBrandAsset',
      summary: 'Upload a logo, image or brand font',
      description: [
        'Survey themes reference uploaded files rather than remote addresses. A survey',
        'only ever loads images and fonts from this origin, which is what keeps a member',
        'answering one from being sent to somebody else\'s server, and what stops an',
        'approved image being swapped for something else afterwards.',
        '',
        'Send the file base64-encoded, with or without a data URL prefix. **What the file',
        'is, is decided by its bytes** — the filename, the extension and the declared type',
        'are all the uploader\'s to choose, so none of them are trusted. It is stored under',
        'a generated name and served back with a content type taken from its signature.',
        '',
        'Images: PNG, JPEG, GIF, WebP. SVG is refused — it is a document format that can',
        'carry script. Fonts: WOFF2, WOFF, TTF, OTF.',
        '',
        'The returned `path` is what goes into a theme field such as `logo_url` or',
        '`brand_font`. It is served unauthenticated, since a survey answered over a public',
        'link has to load its own logo; the generated name is what keeps it private.'
      ].join('\n'),
      requestBody: jsonBody(object({
        file: str('The file, base64-encoded. A data: URL prefix is accepted and its declared type ignored'),
        kind: str('What the caller expects, so a font field cannot be given an image', {
          enum: ['image', 'font'], default: 'image'
        })
      }, { required: ['file'] }), {
        file: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8Xw8AAoMBgDTD2qgAAAAASUVORK5CYII=',
        kind: 'image'
      }),
      responses: {
        201: json('Stored.', object({
          asset: object({
            path: str('Put this in a theme field', { example: '/uploads/0123456789abcdef0123456789abcdef.png' }),
            kind: str('image or font'),
            mime: str('What it will be served as, taken from the bytes'),
            bytes: int('Size on disk'),
            uploaded_by: id('Admin who uploaded it')
          })
        }), {
          asset: {
            path: '/uploads/0123456789abcdef0123456789abcdef.png',
            kind: 'image', mime: 'image/png', bytes: 2048
          }
        }),
        400: json('Not a file of the kind asked for.', ref('Error'), {
          error: 'That is not an image we can use. Upload a PNG, JPEG, GIF or WebP — not an SVG, which can carry scripts.'
        }),
        413: json('Too large.', ref('Error'), { error: 'Files are limited to 3MB' })
      }
    })
  },

  '/admin/surveys/schema': {
    get: op({
      tag: 'Admin · Surveys',
      permission: 'surveys.read',
      operationId: 'getSurveySchema',
      summary: 'The question types a survey may contain',
      description: [
        'What a survey can be made of: the question types, the comparisons branching can',
        'be written from, and the theme vocabulary. A builder draws itself from this',
        'rather than carrying its own copy, so a type added here needs no second edit',
        'anywhere else.'
      ].join('\n'),
      responses: {
        200: json('The vocabulary.', object({
          types: arrayOf(object({
            type: str('Type name, as sent in a question'),
            label: str('How it reads in an interface'),
            hint: str('What it is for'),
            answerable: bool('False for furniture like a section heading'),
            verbatim: bool('Whether answers are filed as feedback in the member\'s own words')
          }), 'Question types'),
          operators: arrayOf(object({
            op: str('Operator name'),
            label: str('How it reads'),
            needsValue: bool('Whether a value must be compared against')
          }), 'Branching comparisons'),
          operators_by_type: object({}, { description: 'Question type → the operators that make sense for it' }),
          text_formats: arrayOf(object({ value: str('Format name'), label: str('How it reads') }), 'What a text answer can be held to'),
          rating_styles: arrayOf({ type: 'string' }, 'How a rating can be drawn'),
          theme: object({}, { description: 'Theme defaults, the choices for each setting, and this circle\'s own default' })
        }), {
          types: [
            { type: 'rating', label: 'Rating', hint: 'A scale with labelled ends', answerable: true },
            { type: 'section', label: 'Section', hint: 'A heading or note between questions — nothing to answer', answerable: false }
          ],
          operators: [{ op: 'lte', label: 'is at most', needsValue: true }],
          rating_styles: ['numbers', 'stars', 'faces']
        })
      }
    })
  },

  '/admin/surveys/{id}': {
    get: op({
      tag: 'Admin · Surveys',
      permission: 'surveys.read',
      operationId: 'getSurvey',
      summary: 'One survey, with whether its questions can still be changed',
      description: [
        'The survey as stored, the look it inherits from its circle, and whether anyone',
        'has answered it yet. Questions are fixed the moment the first response lands,',
        'so an editor needs to know that before it lets someone start rewriting.'
      ].join('\n'),
      parameters: [path('id', 'Survey id')],
      responses: {
        200: json('The survey.', object({
          survey: ref('Survey'),
          circle_theme: ref('SurveyTheme'),
          completed_count: int('Members who have finished it'),
          questions_locked: bool('True once anyone has responded')
        }), {
          survey: {
            id: 's1', title: 'Sandbox onboarding experience', status: 'active',
            questions: [{ id: 'q1_8c3d21ff', type: 'rating', text: 'How clear is our API documentation?', required: true, scale: 5 }],
            theme: { accent: '#107EBC' }, engagement_mode: 'email', time_estimate_min: 5
          },
          circle_theme: { accent: '#107EBC' },
          completed_count: 51,
          questions_locked: true
        }),
        404: json('No such survey.', ref('Error'), { error: 'Survey not found' })
      }
    }),
    put: op({
      tag: 'Admin · Surveys',
      permission: 'surveys.write',
      operationId: 'updateSurvey',
      summary: 'Update a survey, or change its status',
      description: [
        'This is how a draft becomes active: send `{ "status": "active" }`. A survey with',
        'no questions cannot be activated.',
        '',
        'Questions cannot be changed once anyone has responded — that would orphan the',
        'answers already collected. Close the survey and create a new version instead.',
        'The theme can be changed at any point, including while collecting: it changes',
        'how the rest of the audience sees the survey, not what anyone was asked.'
      ].join('\n'),
      parameters: [path('id', 'Survey id')],
      requestBody: jsonBody(object({
        title: str('Survey title'),
        description: str('Shown above the questions'),
        questions: arrayOf(ref('SurveyQuestion'), 'Only while nobody has responded'),
        theme: ref('SurveyTheme'),
        status: str('Lifecycle state', { enum: ['draft', 'active', 'closed'] }),
        target_type: str('Who it is for', { enum: ['all', 'cohort', 'specific'] }),
        target_ids: arrayOf({ type: 'string' }, 'Cohort or member ids'),
        engagement_mode: str('How the invitation reaches them', { enum: ['1-on-1', 'email', 'whatsapp', 'in_portal'] }),
        time_estimate_min: int('Minutes it takes'),
        expires_at: str('When it closes itself'),
        trigger_event: str('Integration event that auto-invites a member'),
        reminder_after_days: int('Days of silence before a reminder')
      }), { status: 'active' }),
      responses: {
        200: json('The updated survey.', object({ survey: ref('Survey') }), {
          survey: { id: 's1', title: 'Sandbox onboarding experience', status: 'active' }
        }),
        400: json('Nothing to update, an invalid value, or publishing a survey with no questions.', ref('Error'), {
          error: 'Add at least one question before publishing'
        }),
        404: json('No such survey.', ref('Error'), { error: 'Survey not found' }),
        409: json('Questions cannot change after responses exist.', ref('Error'), {
          error: 'Cannot change questions — 51 member(s) have already responded. Close this survey and create a new version.'
        })
      }
    })
  },

  '/admin/surveys/{id}/audience': {
    get: op({
      tag: 'Admin · Surveys',
      permission: 'surveys.read',
      operationId: 'getSurveyAudience',
      summary: 'Who this survey would reach, and who it would miss',
      description: 'Consent, channel preference and quiet hours are applied here exactly as they are at send time, so `unreachable` says why each person would be skipped before anything goes out.',
      parameters: [path('id', 'Survey id')],
      responses: {
        200: json('The resolved audience.', object({
          survey: object({
            id: str('Survey id'), title: str('Survey title'),
            engagement_mode: str('How invitations are sent'), target_type: str('Targeting rule')
          }),
          eligible_count: int('Members the targeting selects'),
          reachable: arrayOf(object({
            id: str('Member id'), name: str('Name'), email: str('Email'),
            company: str('Employer', { nullable: true }),
            already_invited: bool('Whether they have been invited already'),
            channels: arrayOf({ type: 'string' }, 'Channels that would actually be used')
          }), 'Members at least one channel can reach'),
          unreachable: arrayOf(object({
            id: str('Member id'), name: str('Name'), email: str('Email'),
            reasons: arrayOf({ type: 'string' }, 'Why every channel was ruled out')
          }), 'Members no channel can reach'),
          already_completed: int('Members in this audience who have already responded'),
          completed_overall: int('Everyone who has responded, including people the targeting no longer selects')
        }), {
          survey: { id: 's1', title: 'Sandbox onboarding experience', engagement_mode: 'email', target_type: 'cohort' },
          eligible_count: 57,
          reachable: [{ id: MEMBER_ID, name: 'Chidi Nwosu', email: 'chidi@paystack.africa', company: 'Paystack', already_invited: false, channels: ['in_portal', 'email'] }],
          unreachable: [{ id: 'u9', name: 'Ada Eze', email: 'ada@flutterwave.com', reasons: ['No consent for email'] }],
          already_completed: 6,
          completed_overall: 51
        }),
        404: json('No such survey.', ref('Error'), { error: 'Survey not found' })
      }
    })
  },

  '/admin/surveys/{id}/invite': {
    post: op({
      tag: 'Admin · Surveys',
      permission: 'surveys.invite',
      operationId: 'inviteToSurvey',
      summary: 'Invite the audience',
      description: [
        'Sends over the survey\'s own engagement mode. Members who have already completed',
        'it are never invited again; members already invited are skipped unless `resend`',
        'is set.',
        '',
        'A `1-on-1` survey is a task for a rep rather than an automated send — the portal',
        'notification is the cue, and `requires_manual_followup` counts the calls owed.'
      ].join('\n'),
      parameters: [path('id', 'Survey id')],
      requestBody: jsonBody(object({
        resend: bool('Also send to members already invited but not finished')
      }, { description: 'Optional.' }), { resend: false }, { required: false }),
      responses: {
        200: json('What went out.', object({
          message: str('Human summary'),
          eligible: int('Members the targeting selects'),
          invited: int('Members invited on this run'),
          delivered: int('Deliveries that left the building'),
          queued: int('Held for a member\'s quiet hours'),
          skipped: int('Blocked by consent or preference'),
          failed: int('Provider failures'),
          requires_manual_followup: int('1-on-1 invitations a rep must now action')
        }), {
          message: 'Invited 51 member(s) via email',
          eligible: 57, invited: 51, delivered: 96, queued: 4, skipped: 2, failed: 0,
          requires_manual_followup: 0
        }),
        404: json('No such survey.', ref('Error'), { error: 'Survey not found' }),
        409: json('The survey is not active.', ref('Error'), { error: 'Activate the survey before inviting members' })
      }
    })
  },

  '/admin/surveys/{id}/remind': {
    post: op({
      tag: 'Admin · Surveys',
      permission: 'surveys.invite',
      operationId: 'remindSurvey',
      summary: 'Nudge members who have not responded',
      description: 'Only reaches active members who were invited and have not finished.',
      parameters: [path('id', 'Survey id')],
      responses: {
        200: json('How many were reminded.', object({
          message: str('Human summary'), reminded: int('Members reminded')
        }), { message: 'Reminded 19 member(s)', reminded: 19 }),
        404: json('No such survey.', ref('Error'), { error: 'Survey not found' })
      }
    })
  },

  '/admin/surveys/{id}/responses': {
    get: op({
      tag: 'Admin · Surveys',
      permission: 'surveys.read',
      operationId: 'getSurveyResponses',
      summary: 'Every response to a survey',
      description: 'Returned with the survey\'s questions, so answers can be lined up against what was asked without a second call.',
      parameters: [path('id', 'Survey id')],
      responses: {
        200: json('The survey and its responses.', object({
          survey: ref('Survey'),
          responses: arrayOf(ref('SurveyResponse'), 'Most recent first, including responses still in progress')
        }), {
          survey: {
            id: 's1', title: 'Sandbox onboarding experience',
            questions: [{ id: 'q1_8c3d21ff', type: 'rating', text: 'How clear is our API documentation?' }]
          },
          responses: [{
            id: 'r1', survey_id: 's1', user_id: MEMBER_ID,
            user_name: 'Chidi Nwosu', user_email: 'chidi@paystack.africa',
            answers: { q1_8c3d21ff: 4 }, completed_at: '2026-08-12 16:40:09',
            triggered_by: 'manual', created_at: '2026-08-10 09:00:00'
          }]
        }),
        404: json('No such survey.', ref('Error'), { error: 'Survey not found' })
      }
    })
  },

  '/admin/surveys/{id}/export': {
    get: op({
      tag: 'Admin · Surveys',
      permission: 'export.read',
      operationId: 'exportSurveyResponses',
      summary: 'Download completed responses as CSV',
      description: 'One row per completed response, one column per question. Multi-choice answers are joined with `; `.',
      parameters: [path('id', 'Survey id')],
      responses: {
        200: fileResponse('A CSV file.', 'text/csv',
          'respondent_name,respondent_email,company,submitted_at,triggered_by,q1. How clear is our API documentation?\nChidi Nwosu,chidi@paystack.africa,Paystack,2026-08-12 16:40:09,manual,4'),
        404: json('No such survey.', ref('Error'), { error: 'Survey not found' })
      }
    })
  },

  // ─── Sessions ─────────────────────────────────────────────
  '/admin/sessions': {
    get: op({
      tag: 'Admin · Sessions',
      permission: 'sessions.read',
      operationId: 'listSessions',
      summary: 'List scheduled sessions',
      parameters: [
        query('status', 'Filter by lifecycle state', { type: 'string', enum: ['draft', 'scheduled', 'announced', 'completed', 'cancelled'] }),
        query('upcoming', 'Pass `true` for future sessions only', { type: 'string', enum: ['true', 'false'] })
      ],
      responses: {
        200: json('Sessions, soonest first.', object({ sessions: arrayOf(ref('ScheduledSession'), 'Sessions') }), {
          sessions: [{
            id: 'ss1', title: 'Lending API office hours', type: 'workshop',
            scheduled_for: '2026-09-02T15:00:00Z', duration_min: 45,
            location: 'https://meet.google.com/xyz-abcd-efg',
            target_type: 'cohort', target_ids: ['c2'],
            channels: ['in_portal', 'email'], reminder_offsets: [1440, 60],
            status: 'scheduled', circle_name: 'Dev Circle', dispatches_sent: 0
          }]
        })
      }
    }),
    post: op({
      tag: 'Admin · Sessions',
      permission: 'sessions.write',
      operationId: 'createSession',
      summary: 'Schedule a session',
      description: [
        'Reminders fire automatically at each offset in `reminder_offsets`, counted in',
        'minutes before the start time — `[1440, 60]` means a day before and an hour',
        'before. A dispatch log makes each one send exactly once, whatever restarts or',
        'extra scheduler ticks happen in between.',
        '',
        'The response includes the availability preview, so a clash is visible at the',
        'moment of scheduling rather than after the invitations have gone out.'
      ].join('\n'),
      requestBody: jsonBody(object({
        title: str('Session title'),
        description: str('What will be covered'),
        type: str('Kind of session', { enum: SESSION_TYPES, default: 'info' }),
        survey_id: str('Required when type is `survey`', { format: 'uuid' }),
        circle_id: str('Circle it belongs to. Defaults to the root circle', { format: 'uuid' }),
        target_type: str('Who is invited', { enum: ['all', 'cohort', 'specific', 'circle'], default: 'all' }),
        target_ids: arrayOf({ type: 'string' }, 'Cohort, member or circle ids'),
        scheduled_for: str('ISO date-time the session starts'),
        duration_min: int('Length in minutes', { default: 30 }),
        location: str('Meeting link or venue'),
        channels: arrayOf({ type: 'string', enum: CHANNELS }, 'Channels to announce and remind on'),
        reminder_offsets: arrayOf({ type: 'integer' }, 'Minutes before the start to remind, e.g. [1440, 60]')
      }, { required: ['title', 'scheduled_for'] }), {
        title: 'Lending API office hours',
        description: 'Bring your integration questions.',
        type: 'workshop',
        target_type: 'cohort',
        target_ids: ['c2'],
        scheduled_for: '2026-09-02T15:00:00Z',
        duration_min: 45,
        location: 'https://meet.google.com/xyz-abcd-efg',
        channels: ['in_portal', 'email'],
        reminder_offsets: [1440, 60]
      }),
      responses: {
        201: json('Scheduled, with a preview of who it reaches.', object({
          session: ref('ScheduledSession'),
          preview: ref('SessionPreview')
        }), {
          session: { id: 'ss1', title: 'Lending API office hours', status: 'scheduled', scheduled_for: '2026-09-02T15:00:00Z' },
          preview: { recipients: 57, available: 41, reachable: 53, unavailable: [{ id: MEMBER_ID, name: 'Chidi Nwosu', reason: 'Outside their 10:00–14:00 window' }] }
        }),
        400: json('A missing or invalid field.', ref('Error'), { error: 'scheduled_for must be an ISO date-time' })
      }
    })
  },

  '/admin/sessions/preview': {
    post: op({
      tag: 'Admin · Sessions',
      permission: 'sessions.read',
      operationId: 'previewSessionSlot',
      summary: 'Check a slot before creating anything',
      description: 'Same preview a created session returns, on a session that does not exist yet — for testing a time against the audience\'s stated availability.',
      requestBody: jsonBody(object({
        scheduled_for: str('ISO date-time to test'),
        title: str('Optional label'),
        circle_id: str('Circle to draw the audience from', { format: 'uuid' }),
        target_type: str('Who would be invited', { enum: ['all', 'cohort', 'specific', 'circle'], default: 'all' }),
        target_ids: arrayOf({ type: 'string' }, 'Cohort, member or circle ids'),
        channels: arrayOf({ type: 'string', enum: CHANNELS }, 'Channels that would be used')
      }, { required: ['scheduled_for'] }), {
        scheduled_for: '2026-09-02T15:00:00Z',
        target_type: 'cohort',
        target_ids: ['c2'],
        channels: ['in_portal', 'email']
      }),
      responses: {
        200: json('Who the slot would reach.', ref('SessionPreview'), {
          recipients: 57, available: 41, reachable: 53,
          unavailable: [{ id: MEMBER_ID, name: 'Chidi Nwosu', reason: 'Outside their 10:00–14:00 window' }]
        }),
        400: json('A missing or invalid field.', ref('Error'), { error: 'scheduled_for must be an ISO date-time' })
      }
    })
  },

  '/admin/sessions/run-scheduler': {
    post: op({
      tag: 'Admin · Sessions',
      permission: 'sessions.write',
      operationId: 'runScheduler',
      summary: 'Force a scheduler tick',
      description: 'The scheduler runs on its own. This makes it run now, which is what you want when testing reminder offsets rather than waiting for one to come round.',
      responses: {
        200: json('What the tick did.', object({
          dispatched: int('Reminder batches sent'),
          sessions: int('Sessions examined'),
          delivered: int('Individual deliveries')
        }), { dispatched: 2, sessions: 6, delivered: 88 })
      }
    })
  },

  '/admin/sessions/{id}': {
    get: op({
      tag: 'Admin · Sessions',
      permission: 'sessions.read',
      operationId: 'getSession',
      summary: 'One session, with its dispatch and delivery record',
      parameters: [path('id', 'Session id')],
      responses: {
        200: json('The session and what has been sent for it.', object({
          session: ref('ScheduledSession'),
          dispatches: arrayOf(object({
            id: str('Dispatch id'),
            session_id: str('Session it belongs to'),
            offset_minutes: int('Minutes before the start this batch was for. Null-equivalent 0 is the announcement'),
            recipient_count: int('Members it went to'),
            dispatched_at: str('When it ran')
          }), 'Reminder batches already sent'),
          deliveries: arrayOf(object({
            channel: str('Channel'), status: str('Outcome'),
            reason: str('Why it was skipped', { nullable: true }), count: int('How many')
          }), 'Delivery outcomes, grouped')
        }), {
          session: { id: 'ss1', title: 'Lending API office hours', status: 'announced' },
          dispatches: [{ id: 'd1', session_id: 'ss1', offset_minutes: 1440, recipient_count: 57, dispatched_at: '2026-09-01 15:00:04' }],
          deliveries: [{ channel: 'email', status: 'sent', reason: null, count: 53 }, { channel: 'email', status: 'skipped', reason: 'No consent for email', count: 4 }]
        }),
        404: json('No such session.', ref('Error'), { error: 'Session not found' })
      }
    }),
    put: op({
      tag: 'Admin · Sessions',
      permission: 'sessions.write',
      operationId: 'updateSession',
      summary: 'Update a session',
      description: 'Moving a session clears its reminder dispatch log, so the reminders fire again against the new time rather than being suppressed as already sent.',
      parameters: [path('id', 'Session id')],
      requestBody: jsonBody(object({
        title: str('Session title'),
        description: str('What will be covered'),
        type: str('Kind of session', { enum: SESSION_TYPES }),
        scheduled_for: str('ISO date-time'),
        duration_min: int('Length in minutes'),
        location: str('Meeting link or venue'),
        target_type: str('Who is invited', { enum: ['all', 'cohort', 'specific', 'circle'] }),
        target_ids: arrayOf({ type: 'string' }, 'Cohort, member or circle ids'),
        channels: arrayOf({ type: 'string', enum: CHANNELS }, 'Channels to use'),
        reminder_offsets: arrayOf({ type: 'integer' }, 'Minutes before the start to remind'),
        status: str('Lifecycle state', { enum: ['draft', 'scheduled', 'announced', 'completed', 'cancelled'] })
      }), { scheduled_for: '2026-09-04T15:00:00Z', location: 'https://meet.google.com/new-link' }),
      responses: {
        200: json('The updated session.', object({ session: ref('ScheduledSession') }), {
          session: { id: 'ss1', title: 'Lending API office hours', scheduled_for: '2026-09-04T15:00:00Z' }
        }),
        400: json('Nothing to update, or an invalid field.', ref('Error'), { error: 'No fields to update' }),
        404: json('No such session.', ref('Error'), { error: 'Session not found' })
      }
    }),
    delete: op({
      tag: 'Admin · Sessions',
      permission: 'sessions.write',
      operationId: 'cancelSession',
      summary: 'Cancel a session',
      description: 'Members who were told it was happening are told it is not, on the same channels the announcement used.',
      parameters: [path('id', 'Session id')],
      requestBody: jsonBody(object({
        reason: str('Shown to members in the cancellation notice')
      }, { description: 'Optional.' }), { reason: 'Rescheduling to avoid a clash with the Lagos meetup.' }, { required: false }),
      responses: {
        200: json('Cancelled.', object({
          message: str('Confirmation'), notified: int('Members told')
        }), { message: 'Session cancelled', notified: 53 }),
        404: json('No such session.', ref('Error'), { error: 'Session not found' }),
        409: json('Already cancelled.', ref('Error'), { error: 'Already cancelled' })
      }
    })
  },

  '/admin/sessions/{id}/preview': {
    get: op({
      tag: 'Admin · Sessions',
      permission: 'sessions.read',
      operationId: 'previewSession',
      summary: 'Who an existing session reaches',
      parameters: [path('id', 'Session id')],
      responses: {
        200: json('Attendance and reachability.', ref('SessionPreview'), {
          recipients: 57, available: 41, reachable: 53,
          unavailable: [{ id: MEMBER_ID, name: 'Chidi Nwosu', reason: 'Outside their 10:00–14:00 window' }]
        }),
        404: json('No such session.', ref('Error'), { error: 'Session not found' })
      }
    })
  },

  '/admin/sessions/{id}/announce': {
    post: op({
      tag: 'Admin · Sessions',
      permission: 'sessions.write',
      operationId: 'announceSession',
      summary: 'Send the invitation now',
      description: 'Announcing twice is refused rather than sending a second invitation to everybody.',
      parameters: [path('id', 'Session id')],
      responses: {
        200: json('Announced.', object({
          message: str('Human summary'),
          recipients: int('Members it was addressed to'),
          delivered: int('Deliveries that left the building'),
          skipped: int('Blocked by consent or preference'),
          queued: int('Held for quiet hours')
        }), { message: 'Announced to 53 of 57 member(s)', recipients: 57, delivered: 53, skipped: 4, queued: 0 }),
        400: json('The session cannot be announced.', ref('Error'), { error: 'This session has no audience' }),
        409: json('Already announced.', ref('Error'), { error: 'This session has already been announced' })
      }
    })
  },

  '/admin/sessions/{id}/remind': {
    post: op({
      tag: 'Admin · Sessions',
      permission: 'sessions.write',
      operationId: 'remindSession',
      summary: 'Send an ad-hoc reminder now',
      description: 'Recorded against the current window, so the automatic reminder for that window will not also fire.',
      parameters: [path('id', 'Session id')],
      responses: {
        200: json('Reminded.', object({
          message: str('Human summary'),
          recipients: int('Members it was addressed to'),
          delivered: int('Deliveries that left the building')
        }), { message: 'Reminded 53 of 57 member(s)', recipients: 57, delivered: 53 }),
        404: json('No such session.', ref('Error'), { error: 'Session not found' }),
        409: json('A reminder for this window already went out.', ref('Error'), {
          error: 'A reminder for this window already went out'
        })
      }
    })
  },

  // ─── Broadcasts ───────────────────────────────────────────
  '/admin/blasts': {
    get: op({
      tag: 'Admin · Broadcasts',
      permission: ['blasts.send', 'members.read'],
      operationId: 'listBlasts',
      summary: 'List broadcasts with delivery counts',
      responses: {
        200: json('Broadcasts, newest first.', object({ blasts: arrayOf(ref('Blast'), 'Broadcasts') }), {
          blasts: [{
            id: 'b1', subject: 'Office hours this Thursday',
            content: 'Bring your integration questions.',
            channel: 'email', target_type: 'cohort', target_ids: ['c2'],
            status: 'sent', recipient_count: 57, delivered_count: 53, skipped_count: 4,
            sent_at: '2026-08-10 09:00:02', created_at: '2026-08-09 17:40:00'
          }]
        })
      }
    }),
    post: op({
      tag: 'Admin · Broadcasts',
      permission: 'blasts.send',
      operationId: 'createBlast',
      summary: 'Draft a broadcast',
      description: 'Created as a draft. Nothing is sent until `POST /admin/blasts/{id}/send`.',
      requestBody: jsonBody(object({
        subject: str('Subject line, for channels that have one'),
        content: str('Message body'),
        channel: str('Where it goes. "all" fans out to every consented channel', { enum: ['email', 'whatsapp', 'sms', 'in_portal', 'all'] }),
        target_type: str('Who receives it', { enum: ['all', 'cohort', 'specific'] }),
        target_ids: arrayOf({ type: 'string' }, 'Required unless target_type is "all"'),
        scheduled_for: str('When it should go out'),
        circle_id: str('Circle it belongs to. Defaults to the root circle', { format: 'uuid' })
      }, { required: ['content', 'channel', 'target_type'] }), {
        subject: 'Office hours this Thursday',
        content: 'Bring your integration questions — we will be on the call from 3pm.',
        channel: 'email',
        target_type: 'cohort',
        target_ids: ['c2']
      }),
      responses: {
        201: json('Drafted.', object({ blast: ref('Blast') }), {
          blast: { id: 'b1', subject: 'Office hours this Thursday', channel: 'email', status: 'draft' }
        }),
        400: json('Missing fields, or an invalid channel or target.', ref('Error'), {
          error: 'target_ids required when targeting cohort'
        })
      }
    })
  },

  '/admin/blasts/{id}/preview': {
    post: op({
      tag: 'Admin · Broadcasts',
      permission: 'blasts.send',
      operationId: 'previewBlast',
      summary: 'Who this broadcast reaches, before committing',
      description: 'Applies consent, channel preference and quiet hours exactly as the send does, and names the first 25 people it would not reach along with why.',
      parameters: [path('id', 'Broadcast id')],
      responses: {
        200: json('Reachability.', object({
          total: int('Members the targeting selects'),
          reachable: int('Members at least one channel can reach'),
          blocked_count: int('Members no channel can reach'),
          blocked: arrayOf(object({
            name: str('Member name'), email: str('Email'),
            reasons: arrayOf({ type: 'string' }, 'Why every channel was ruled out')
          }), 'The first 25 blocked members')
        }), {
          total: 57, reachable: 53, blocked_count: 4,
          blocked: [{ name: 'Ada Eze', email: 'ada@flutterwave.com', reasons: ['No consent for email'] }]
        }),
        404: json('No such broadcast.', ref('Error'), { error: 'Blast not found' })
      }
    })
  },

  '/admin/blasts/{id}/send': {
    post: op({
      tag: 'Admin · Broadcasts',
      permission: 'blasts.send',
      operationId: 'sendBlast',
      summary: 'Send a broadcast',
      description: [
        'Consent, channel preference and quiet hours are applied per recipient, and every',
        'outcome is written to the delivery log. A message held for somebody\'s quiet hours',
        'is queued rather than dropped.',
        '',
        'Sending is guarded against being run twice: a broadcast already sending or sent',
        'is refused with 409.'
      ].join('\n'),
      parameters: [path('id', 'Broadcast id')],
      responses: {
        200: json('Processed.', object({
          message: str('Human summary'),
          recipient_count: int('Members it was addressed to'),
          delivered: int('Deliveries that left the building'),
          skipped: int('Blocked by consent or preference'),
          queued_for_quiet_hours: int('Held until the recipient\'s quiet window ends'),
          failed: int('Provider failures')
        }), {
          message: 'Blast processed for 57 recipient(s)',
          recipient_count: 57, delivered: 53, skipped: 4, queued_for_quiet_hours: 6, failed: 0
        }),
        404: json('No such broadcast.', ref('Error'), { error: 'Blast not found' }),
        409: json('Already sent, or a send is in progress.', ref('Error'), { error: 'Already sent' })
      }
    })
  },

  '/admin/blasts/{id}/deliveries': {
    get: op({
      tag: 'Admin · Broadcasts',
      permission: 'blasts.send',
      operationId: 'getBlastDeliveries',
      summary: 'The audit trail for one broadcast',
      description: 'One row per recipient per channel — what was attempted, what happened, and why anything was skipped.',
      parameters: [path('id', 'Broadcast id')],
      responses: {
        200: json('Every delivery attempt.', object({
          deliveries: arrayOf(ref('MessageDelivery'), 'Most recent first'),
          count: int('How many rows')
        }), {
          deliveries: [{
            id: 'md1', source_type: 'blast', source_id: 'b1', user_id: MEMBER_ID,
            user_name: 'Chidi Nwosu', user_email: 'chidi@paystack.africa',
            channel: 'email', status: 'sent', reason: null, created_at: '2026-08-10 09:00:02'
          }],
          count: 114
        })
      }
    })
  },

  // ─── Rewards ──────────────────────────────────────────────
  '/admin/gifts': {
    get: op({
      tag: 'Admin · Rewards',
      permission: 'gifts.read',
      operationId: 'listGifts',
      summary: 'List rewards with claim counts',
      responses: {
        200: json('Rewards, newest first.', object({ gifts: arrayOf(ref('Gift'), 'Rewards') }), {
          gifts: [{
            id: 'g1', name: '₦10,000 airtime', description: 'For members who complete two surveys',
            value: 10000, currency: 'NGN', target_cohort_ids: [], stock: 50,
            min_surveys_completed: 2, min_streak: 0, active: 1,
            claimed_count: 19, delivered_count: 14, created_at: '2026-05-02 12:00:00'
          }]
        })
      }
    }),
    post: op({
      tag: 'Admin · Rewards',
      permission: 'gifts.write',
      operationId: 'createGift',
      summary: 'Create a reward',
      description: 'Eligibility is expressed as thresholds a member must reach; the portal turns those into plain-language requirements. An empty `target_cohort_ids` means every member.',
      requestBody: jsonBody(object({
        name: str('What the reward is'),
        description: str('Shown to the member'),
        value: num('Face value'),
        currency: str('ISO currency code', { default: 'NGN' }),
        target_cohort_ids: arrayOf({ type: 'string' }, 'Cohorts it is open to. Empty means everyone'),
        stock: int('How many can be claimed. Omit for unlimited'),
        min_surveys_completed: int('Surveys a member must have finished', { default: 0 }),
        min_streak: int('Engagement streak a member must have reached', { default: 0 })
      }, { required: ['name'] }), {
        name: '₦10,000 airtime',
        description: 'For members who complete two surveys',
        value: 10000,
        currency: 'NGN',
        target_cohort_ids: [],
        stock: 50,
        min_surveys_completed: 2,
        min_streak: 0
      }),
      responses: {
        201: json('Created.', object({ gift: ref('Gift') }), {
          gift: { id: 'g1', name: '₦10,000 airtime', value: 10000, currency: 'NGN', stock: 50, active: 1 }
        }),
        400: json('Missing name.', ref('Error'), { error: 'name required' })
      }
    })
  },

  '/admin/gifts/{id}': {
    put: op({
      tag: 'Admin · Rewards',
      permission: 'gifts.write',
      operationId: 'updateGift',
      summary: 'Update a reward',
      description: 'Setting `active` to false retires a reward without deleting the claims already made against it.',
      parameters: [path('id', 'Gift id')],
      requestBody: jsonBody(object({
        name: str('What the reward is'),
        description: str('Shown to the member'),
        value: num('Face value'),
        stock: int('How many can be claimed'),
        min_surveys_completed: int('Surveys required'),
        min_streak: int('Streak required'),
        target_cohort_ids: arrayOf({ type: 'string' }, 'Cohorts it is open to'),
        active: bool('False retires it')
      }), { stock: 80, active: true }),
      responses: {
        200: json('The updated reward.', object({ gift: ref('Gift') }), {
          gift: { id: 'g1', name: '₦10,000 airtime', stock: 80, active: 1 }
        }),
        400: json('Nothing to update.', ref('Error'), { error: 'No fields to update' }),
        404: json('No such reward.', ref('Error'), { error: 'Gift not found' })
      }
    })
  },

  '/admin/gifts/{id}/deliver': {
    post: op({
      tag: 'Admin · Rewards',
      permission: 'gifts.write',
      operationId: 'markGiftDelivered',
      summary: 'Mark a claim as fulfilled',
      description: 'Records the fulfilment against the member\'s engagement history and tells them it is on its way.',
      parameters: [path('id', 'Gift id')],
      requestBody: jsonBody(object({
        user_id: str('The member whose claim was fulfilled', { format: 'uuid' })
      }, { required: ['user_id'] }), { user_id: MEMBER_ID }),
      responses: {
        200: json('Marked.', object({ message: str('Confirmation') }), { message: 'Marked as delivered' }),
        400: json('No member given.', ref('Error'), { error: 'user_id required' }),
        404: json('That member has not claimed this reward.', ref('Error'), { error: 'No claim found for this member' }),
        409: json('Already delivered.', ref('Error'), { error: 'Already delivered' })
      }
    })
  },

  // ─── Feedback ─────────────────────────────────────────────
  '/admin/feedback': {
    get: op({
      tag: 'Admin · Feedback',
      permission: 'feedback.read',
      operationId: 'listFeedback',
      summary: 'All feedback and mirrored complaints',
      parameters: [
        query('status', 'Filter by triage state', { type: 'string', enum: ['open', 'reviewed', 'resolved'] }),
        query('source', 'Filter by originating system', { type: 'string', enum: ['dev_circle', 'feex', 'customer_io'] }),
        query('type', 'Filter by kind', { type: 'string', enum: ['self_initiated', 'system_triggered', 'feex_complaint'] }),
        query('limit', 'How many to return, capped at 200', { type: 'integer', default: 50, maximum: 200 })
      ],
      responses: {
        200: json('Feedback, most recent first.', object({
          feedback: arrayOf(ref('Feedback'), 'Feedback with the member attached')
        }), {
          feedback: [{
            id: 'f1', user_id: MEMBER_ID, user_name: 'Chidi Nwosu',
            user_email: 'chidi@paystack.africa', user_company: 'Paystack',
            type: 'self_initiated', content: 'The sandbox disbursement callback fires twice.',
            category: 'sandbox', rating: 3, status: 'open', source: 'dev_circle',
            created_at: '2026-08-14 10:02:18'
          }]
        })
      }
    })
  },

  '/admin/feedback/{id}': {
    put: op({
      tag: 'Admin · Feedback',
      permission: 'feedback.write',
      operationId: 'updateFeedbackStatus',
      summary: 'Move feedback through triage',
      description: [
        'This records how far the engagement team has got through *reading* feedback. It is',
        'triage state, not ticket resolution — Dev Circle collects information, it does not',
        'resolve issues.',
        '',
        'A complaint mirrored from Feex is owned by Feex and cannot be edited here; the',
        '409 body carries the ticket id and a link so it can be updated where it lives.'
      ].join('\n'),
      parameters: [path('id', 'Feedback id')],
      requestBody: jsonBody(object({
        status: str('Triage state', { enum: ['open', 'reviewed', 'resolved'] }),
        note: str('Optional triage note, recorded against the member\'s history')
      }, { required: ['status'] }), { status: 'reviewed', note: 'Reproduced — raised with the payments team.' }),
      responses: {
        200: json('The updated record.', object({ feedback: ref('Feedback') }), {
          feedback: { id: 'f1', status: 'reviewed', resolved_at: null }
        }),
        400: json('Missing or invalid status.', ref('Error'), { error: 'Invalid status' }),
        404: json('No such feedback.', ref('Error'), { error: 'Feedback not found' }),
        409: json('The complaint belongs to Feex.', ref('Error'), {
          error: 'This complaint is owned by Feex. Update it there — Dev Circle mirrors its status for engagement tracking only.',
          ticket_id: 'FEEX-10428',
          feex_status: 'in_progress',
          feex_url: 'https://feex.creditdirect.ng/tickets/10428'
        })
      }
    })
  },

  // ─── Access control ───────────────────────────────────────
  '/admin/permissions': {
    get: op({
      tag: 'Admin · Access control',
      permission: 'roles.read',
      operationId: 'listPermissions',
      summary: 'Every permission a role can be built from',
      description: 'The catalogue the roles screen is built from, and the only keys `POST /admin/roles` will accept — a permission that gates nothing cannot be granted.',
      responses: {
        200: json('The catalogue, flat and grouped.', object({
          permissions: arrayOf(ref('Permission'), 'Every permission'),
          grouped: object({}, { description: 'Group name → permissions in that group' })
        }), {
          permissions: [
            { key: 'members.read', label: 'View members', group: 'Members' },
            { key: 'docs.read', label: 'View the API reference', group: 'System' }
          ],
          grouped: { Members: [{ key: 'members.read', label: 'View members', group: 'Members' }] }
        })
      }
    })
  },

  '/admin/roles': {
    get: op({
      tag: 'Admin · Access control',
      permission: 'roles.read',
      operationId: 'listRoles',
      summary: 'List roles and who holds them',
      responses: {
        200: json('Roles, system roles first.', object({ roles: arrayOf(ref('Role'), 'Roles') }), {
          roles: [
            { id: 'r_super', name: 'Super Admin', description: 'Full access', permissions: ['*'], is_system: 1, admin_count: 1 },
            { id: 'r_rep', name: 'CDL Rep', description: 'Engagement team', permissions: ['members.read', 'surveys.invite'], is_system: 1, admin_count: 4 }
          ]
        })
      }
    }),
    post: op({
      tag: 'Admin · Access control',
      permission: 'roles.write',
      operationId: 'createRole',
      summary: 'Create a role',
      description: 'Permissions are validated against the catalogue, so a role cannot be built from a key that gates nothing. `*` grants everything, including permissions added in later releases.',
      requestBody: jsonBody(object({
        name: str('Role name'),
        description: str('What the role is for'),
        permissions: arrayOf({ type: 'string' }, 'Permission keys, or `*`')
      }, { required: ['name', 'permissions'] }), {
        name: 'Engagement lead',
        description: 'Runs surveys and sessions, cannot change access',
        permissions: ['members.read', 'surveys.read', 'surveys.write', 'surveys.invite', 'sessions.read', 'sessions.write']
      }),
      responses: {
        201: json('Created.', object({ role: ref('Role') }), {
          role: { id: 'r_lead', name: 'Engagement lead', permissions: ['members.read', 'surveys.write'], is_system: 0 }
        }),
        400: json('Missing fields, or an unknown permission.', ref('Error'), {
          error: 'Unknown permission(s): members.teleport'
        }),
        409: json('A role with that name exists.', ref('Error'), { error: 'A role with that name already exists' })
      }
    })
  },

  '/admin/roles/{id}': {
    put: op({
      tag: 'Admin · Access control',
      permission: 'roles.write',
      operationId: 'updateRole',
      summary: 'Update a role',
      description: 'System roles cannot be edited. Holders of the role keep their sessions — a permission change takes effect on their next request.',
      parameters: [path('id', 'Role id')],
      requestBody: jsonBody(object({
        name: str('Role name'),
        description: str('What the role is for'),
        permissions: arrayOf({ type: 'string' }, 'Permission keys, or `*`')
      }), { permissions: ['members.read', 'surveys.read', 'surveys.write'] }),
      responses: {
        200: json('The updated role.', object({ role: ref('Role') }), {
          role: { id: 'r_lead', name: 'Engagement lead', permissions: ['members.read', 'surveys.read', 'surveys.write'] }
        }),
        400: json('A system role, nothing to update, or an unknown permission.', ref('Error'), {
          error: 'System roles cannot be edited'
        }),
        404: json('No such role.', ref('Error'), { error: 'Role not found' })
      }
    }),
    delete: op({
      tag: 'Admin · Access control',
      permission: 'roles.write',
      operationId: 'deleteRole',
      summary: 'Delete a role',
      description: 'Refused while anybody still holds it, so nobody is left with an account that has no permissions at all.',
      parameters: [path('id', 'Role id')],
      responses: {
        200: json('Deleted.', object({ message: str('Confirmation') }), { message: 'Role deleted' }),
        400: json('It is a system role.', ref('Error'), { error: 'System roles cannot be deleted' }),
        404: json('No such role.', ref('Error'), { error: 'Role not found' }),
        409: json('Somebody still holds it.', ref('Error'), {
          error: '3 admin user(s) still have this role. Reassign them first.'
        })
      }
    })
  },

  '/admin/admins': {
    get: op({
      tag: 'Admin · Access control',
      permission: 'roles.read',
      operationId: 'listAdmins',
      summary: 'List staff accounts',
      responses: {
        200: json('Staff, newest first.', object({ admins: arrayOf(ref('AdminUser'), 'Staff accounts') }), {
          admins: [{
            id: 'a1', email: 'adaeze@creditdirect.ng', name: 'Adaeze Okonkwo',
            status: 'active', role_id: 'r_super', role_name: 'Super Admin',
            created_at: '2026-01-08 09:00:00'
          }]
        })
      }
    }),
    post: op({
      tag: 'Admin · Access control',
      permission: 'roles.write',
      operationId: 'createAdmin',
      summary: 'Create a staff account',
      description: [
        'Staff must be on a Credit Direct domain: the sign-in page reads the domain to',
        'decide whether to ask for a password at all, so an admin anywhere else would be',
        'sent down the one-time-code path and could never get in.',
        '',
        'Passwords must be at least 10 characters.'
      ].join('\n'),
      requestBody: jsonBody(object({
        email: str('Credit Direct address', { format: 'email' }),
        name: str('Full name'),
        password: str('At least 10 characters', { format: 'password', minLength: 10 }),
        role_id: str('Role to assign', { format: 'uuid' })
      }, { required: ['email', 'name', 'password', 'role_id'] }), {
        email: 'tunde@creditdirect.ng',
        name: 'Tunde Bakare',
        password: 'a-long-enough-password',
        role_id: 'r_lead'
      }),
      responses: {
        201: json('Created.', object({ admin: ref('AdminUser') }), {
          admin: { id: 'a2', email: 'tunde@creditdirect.ng', name: 'Tunde Bakare', status: 'active', role_id: 'r_lead' }
        }),
        400: json('Missing fields, a weak password, a non-Credit Direct address, or an unknown role.', ref('Error'), {
          error: 'Admin accounts must use a Credit Direct address (creditdirect.ng, fcmb.com)'
        }),
        409: json('That address already has an account.', ref('Error'), {
          error: 'An admin with that email already exists'
        })
      }
    })
  },

  '/admin/admins/{id}': {
    put: op({
      tag: 'Admin · Access control',
      permission: 'roles.write',
      operationId: 'updateAdmin',
      summary: 'Change a colleague\'s role or status',
      description: [
        'A role or status change ends that account\'s sessions immediately, so new',
        'permissions take effect at once rather than at token expiry — and a deactivated',
        'account stops working the moment it is deactivated.',
        '',
        'You cannot deactivate your own account.'
      ].join('\n'),
      parameters: [path('id', 'Admin id')],
      requestBody: jsonBody(object({
        role_id: str('Role to assign', { format: 'uuid' }),
        status: str('Account state', { enum: ['active', 'inactive'] })
      }), { role_id: 'r_rep' }),
      responses: {
        200: json('Updated. They will need to sign in again.', object({
          admin: ref('AdminUser'), message: str('What the caller should expect')
        }), {
          admin: { id: 'a2', email: 'tunde@creditdirect.ng', name: 'Tunde Bakare', status: 'active', role_id: 'r_rep' },
          message: 'Updated. The admin will need to sign in again.'
        }),
        400: json('Nothing to update, an unknown role, or self-deactivation.', ref('Error'), {
          error: 'You cannot deactivate your own account'
        }),
        404: json('No such admin.', ref('Error'), { error: 'Admin not found' })
      }
    })
  },

  '/admin/admins/{id}/reset-password': {
    post: op({
      tag: 'Admin · Access control',
      permission: 'roles.write',
      operationId: 'resetAdminPassword',
      summary: 'Reset a colleague\'s password',
      description: [
        'Staff are the only people who hold a password, so they are the only people who can',
        'be locked out of one — members sign in with a one-time code and never need this.',
        '',
        'Whoever held the old password loses their sessions with it.'
      ].join('\n'),
      parameters: [path('id', 'Admin id')],
      requestBody: jsonBody(object({
        new_password: str('At least 10 characters', { format: 'password', minLength: 10 })
      }, { required: ['new_password'] }), { new_password: 'a-brand-new-password' }),
      responses: {
        200: json('Reset.', object({ message: str('Confirmation') }), {
          message: 'Password reset. Their existing sessions were signed out.'
        }),
        400: json('The new password is too short.', ref('Error'), {
          error: 'Admin passwords must be at least 10 characters'
        }),
        404: json('No such admin.', ref('Error'), { error: 'Admin not found' })
      }
    })
  },

  // ─── Integrations (admin side) ────────────────────────────
  '/admin/integration-events': {
    get: op({
      tag: 'Admin · Integrations',
      permission: 'integrations.read',
      operationId: 'listIntegrationEvents',
      summary: 'The inbound event log',
      description: 'Everything the connected systems have sent, with the payload as received — the first place to look when an integration is not doing what it should.',
      parameters: [
        query('source', 'Filter by system', { type: 'string', example: 'customer_io' }),
        query('processed', 'Pass 0 for events that did not land, 1 for those that did', { type: 'integer', enum: [0, 1] }),
        query('limit', 'How many to return, capped at 200', { type: 'integer', default: 50, maximum: 200 })
      ],
      responses: {
        200: json('Events, most recent first.', object({
          events: arrayOf(ref('IntegrationEvent'), 'Inbound events')
        }), {
          events: [{
            id: 'ev_71a4', source: 'customer_io', event_type: 'first_sandbox_call',
            payload: '{"event_type":"first_sandbox_call","user_id":"hub_8221"}',
            processed: 1, error: null, created_at: '2026-08-14 07:15:22'
          }]
        })
      }
    })
  },

  // ─── Credentials ──────────────────────────────────────────
  '/admin/credentials': {
    get: op({
      tag: 'Admin · Credentials',
      permission: 'credentials.read',
      operationId: 'getCredentials',
      summary: 'Every credential this deployment holds or issues',
      description: [
        'Two halves. **Inbound** are the keys Dev Circle issues to integrations; they are',
        'stored as hashes and managed entirely through this API.',
        '',
        '**Outbound** are the credentials Dev Circle holds for the providers it calls.',
        'Signing a provider request needs those in cleartext, so they live in the',
        'environment rather than the database and this endpoint reports only whether each',
        'one is set — never its value.'
      ].join('\n'),
      responses: {
        200: json('The credential picture.', object({
          providers: arrayOf(ref('IntegrationProvider'), 'Outbound credentials and what breaks without them'),
          scopes: arrayOf(ref('ApiKeyScope'), 'Every scope a key can be granted, and what it unlocks'),
          keys: object({
            total: int('Keys ever issued'),
            live: int('Keys working right now'),
            expired: int('Keys past their expiry'),
            revoked: int('Keys revoked by hand'),
            never_used: int('Live keys that have never authenticated a call'),
            last_used_at: timestamp('The most recent use of any key')
          }),
          sandbox: object({
            enabled: bool('Whether the API sandbox is available here'),
            header: str('The header that routes a request to it')
          })
        }), {
          providers: [{
            id: 'customer_io', name: 'Customer.io',
            purpose: 'Delivers email, WhatsApp and SMS from a single transactional trigger',
            configured: false,
            env: ['CUSTOMERIO_SITE_ID', 'CUSTOMERIO_API_KEY'],
            degraded: 'Outbound messages are recorded as "simulated" instead of being sent.'
          }],
          scopes: [{
            key: 'feex', label: 'Feex',
            description: 'Mirror support tickets as engagement signals',
            endpoints: ['POST /integrations/feex/webhook', 'GET /integrations/events/pending']
          }],
          keys: { total: 4, live: 2, expired: 1, revoked: 1, never_used: 1, last_used_at: '2026-08-14 06:58:10' },
          sandbox: { enabled: true, header: 'X-Devcircle-Sandbox' }
        })
      }
    })
  },

  '/admin/api-keys': {
    get: op({
      tag: 'Admin · Credentials',
      permission: ['credentials.read', 'integrations.write'],
      operationId: 'listApiKeys',
      summary: 'List integration keys',
      description: [
        'Only the prefix is stored in a readable form, so a key can be identified in a log',
        'without the log becoming a credential store.',
        '',
        '`integrations.write` is accepted here because it is what gated key management',
        'before `credentials.*` existed.'
      ].join('\n'),
      parameters: [
        query('status', 'Filter by lifecycle state', { type: 'string', enum: ['live', 'expired', 'revoked'] })
      ],
      responses: {
        200: json('Keys, newest first.', object({
          keys: arrayOf(ref('ApiKeySummary'), 'Integration keys'),
          scopes: arrayOf(ref('ApiKeyScope'), 'The scope catalogue, so a client need not hardcode it')
        }), {
          keys: [{
            id: 'k1', name: 'Landing page', prefix: 'a1b2c3d4',
            permissions: ['landing_page'], status: 'live',
            last_used_at: '2026-08-14 06:58:10',
            expires_at: null, revoked_at: null, created_at: '2026-03-01 10:00:00'
          }],
          scopes: [{ key: 'landing_page', label: 'Landing page', description: 'Register developers from the public sign-up form', endpoints: ['POST /integrations/landing-page/ingest'] }]
        })
      }
    }),
    post: op({
      tag: 'Admin · Credentials',
      permission: ['credentials.write', 'integrations.write'],
      operationId: 'createApiKey',
      summary: 'Issue an integration key',
      description: [
        '**The plaintext key is returned exactly once.** Only its hash is stored, so a key',
        'that is not copied at this moment cannot be recovered — rotate it instead.',
        '',
        'Scope the key to what the integration actually does. A key scoped to `feex` cannot',
        'post landing-page registrations. Omitting `scopes` grants `["events"]`.'
      ].join('\n'),
      requestBody: jsonBody(object({
        name: str('What the key is for'),
        scopes: arrayOf({ type: 'string', enum: API_KEY_SCOPES }, 'Defaults to ["events"]. "*" cannot be combined with others'),
        expires_at: str('A date or date-time in the future. Omit for no expiry')
      }, { required: ['name'] }), {
        name: 'Landing page',
        scopes: ['landing_page'],
        expires_at: '2027-03-01'
      }),
      responses: {
        201: json('Issued. Copy the key now.', ref('IssuedApiKey'), {
          key: 'dc_a1b2c3d4_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4',
          prefix: 'a1b2c3d4',
          scopes: ['landing_page'],
          record: { id: 'k1', name: 'Landing page', prefix: 'a1b2c3d4', permissions: ['landing_page'], status: 'live' },
          warning: 'Copy this key now. It cannot be retrieved again.'
        }),
        400: json('Missing name, an unknown scope, or an expiry in the past.', ref('Error'), {
          error: 'Unknown scope(s): billing', valid: API_KEY_SCOPES
        })
      }
    })
  },

  '/admin/api-keys/{id}': {
    get: op({
      tag: 'Admin · Credentials',
      permission: 'credentials.read',
      operationId: 'getApiKey',
      summary: 'One key, with who issued it',
      parameters: [path('id', 'Key id')],
      responses: {
        200: json('The key.', object({
          key: ref('ApiKeySummary'),
          issued_by: object({ name: str('Admin name'), email: str('Admin email') }, { description: 'Null if the issuing account is gone' }),
          scopes: arrayOf(ref('ApiKeyScope'), 'The scope catalogue')
        }), {
          key: {
            id: 'k1', name: 'Landing page', prefix: 'a1b2c3d4', permissions: ['landing_page'],
            status: 'live', last_used_at: '2026-08-14 06:58:10', created_at: '2026-03-01 10:00:00'
          },
          issued_by: { name: 'Adaeze Okonkwo', email: 'adaeze@creditdirect.ng' }
        }),
        404: json('No such key.', ref('Error'), { error: 'Key not found' })
      }
    }),
    put: op({
      tag: 'Admin · Credentials',
      permission: 'credentials.write',
      operationId: 'updateApiKey',
      summary: 'Rename, re-scope, or change when a key expires',
      description: [
        'Narrowing a live key\'s scopes takes effect on its next request, which makes this',
        'the fastest way to contain a key that is doing more than it should without',
        'stopping the integration outright.',
        '',
        'A revoked key cannot be edited — issue a new one.'
      ].join('\n'),
      parameters: [path('id', 'Key id')],
      requestBody: jsonBody(object({
        name: str('What the key is for'),
        scopes: arrayOf({ type: 'string', enum: API_KEY_SCOPES }, 'Replaces the existing scopes outright'),
        expires_at: str('A date or date-time in the future. Send null to remove the expiry')
      }), { scopes: ['landing_page', 'events'], expires_at: '2027-06-30' }),
      responses: {
        200: json('The updated key.', object({ key: ref('ApiKeySummary') }), {
          key: { id: 'k1', name: 'Landing page', permissions: ['landing_page', 'events'], status: 'live', expires_at: '2027-06-30 23:59:59' }
        }),
        400: json('Nothing to update, an unknown scope, or an expiry in the past.', ref('Error'), {
          error: 'expires_at must be in the future'
        }),
        404: json('No such key.', ref('Error'), { error: 'Key not found' }),
        409: json('The key is revoked.', ref('Error'), { error: 'This key is revoked. Issue a new one instead.' })
      }
    }),
    delete: op({
      tag: 'Admin · Credentials',
      permission: ['credentials.write', 'integrations.write'],
      operationId: 'revokeApiKey',
      summary: 'Revoke a key immediately',
      description: 'Takes effect on the next request made with it. The row is kept so the event log still explains what the key was.',
      parameters: [path('id', 'Key id')],
      responses: {
        200: json('Revoked.', object({
          message: str('Confirmation'), key: ref('ApiKeySummary')
        }), {
          message: 'Key revoked',
          key: { id: 'k1', name: 'Landing page', status: 'revoked', revoked_at: '2026-08-14 15:10:22' }
        }),
        404: json('No such key, or it was already revoked.', ref('Error'), {
          error: 'Key not found or already revoked'
        })
      }
    })
  },

  '/admin/api-keys/{id}/rotate': {
    post: op({
      tag: 'Admin · Credentials',
      permission: 'credentials.write',
      operationId: 'rotateApiKey',
      summary: 'Replace a key, optionally without downtime',
      description: [
        'Issues a replacement carrying the same name, scopes and expiry, and retires the',
        'one it replaces.',
        '',
        'Replacing a key normally means an outage: the new one is not deployed yet at the',
        'moment the old one stops working. Pass `grace_hours` and the old key keeps working',
        'for that long instead of being revoked, so the integration can be moved across and',
        'the old credential lapses on its own. Up to 720 hours (30 days).',
        '',
        '**The new plaintext key is returned exactly once**, as at issue.'
      ].join('\n'),
      parameters: [path('id', 'Key id to replace')],
      requestBody: jsonBody(object({
        grace_hours: int('How long the old key keeps working. 0 revokes it immediately', {
          minimum: 0, maximum: 720, default: 0
        })
      }, { description: 'Optional.' }), { grace_hours: 24 }, { required: false }),
      responses: {
        201: json('Rotated. Copy the new key now.', {
          allOf: [ref('IssuedApiKey'), object({
            replaced: object({
              id: str('The key that was replaced'),
              prefix: str('Its prefix'),
              status: str('What became of it', { enum: ['live', 'revoked'] }),
              expires_at: timestamp('When it stops working, if it was given a grace period')
            })
          })]
        }, {
          key: 'dc_9f8e7d6c_9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928',
          prefix: '9f8e7d6c',
          scopes: ['landing_page'],
          record: { id: 'k9', name: 'Landing page', prefix: '9f8e7d6c', status: 'live' },
          replaced: { id: 'k1', prefix: 'a1b2c3d4', status: 'live', expires_at: '2026-08-15 15:10:22' },
          warning: 'Copy this key now — it cannot be retrieved again. The previous key keeps working for 24 hour(s), then stops.'
        }),
        400: json('grace_hours is out of range.', ref('Error'), {
          error: 'grace_hours must be between 0 and 720'
        }),
        404: json('No such key.', ref('Error'), { error: 'Key not found' }),
        409: json('The key is already revoked.', ref('Error'), {
          error: 'This key is already revoked. Issue a new one instead.'
        })
      }
    })
  },

  // ─── Sandbox ──────────────────────────────────────────────
  '/admin/sandbox': {
    get: op({
      tag: 'Admin · Sandbox',
      permission: 'sandbox.use',
      operationId: 'getSandboxStatus',
      summary: 'What is in the sandbox, and whether you are in it',
      description: 'Send this one with and without the sandbox header to see the difference — `active` tells you which database answered.',
      responses: {
        200: json('Sandbox status.', ref('SandboxStatus'), {
          enabled: true,
          active: true,
          header: 'X-Devcircle-Sandbox',
          seeded_at: '2026-08-14T15:02:11.409Z',
          reset_at: null,
          counts: { users: 6, cohorts: 2, circles: 1, surveys: 1, survey_responses: 3, gifts: 1, feedback: 2, scheduled_sessions: 1 }
        })
      }
    })
  },

  '/admin/sandbox/reset': {
    post: op({
      tag: 'Admin · Sandbox',
      permission: 'sandbox.use',
      operationId: 'resetSandbox',
      summary: 'Throw the sandbox away and rebuild it',
      description: [
        'Deletes the sandbox database and recreates it from the demo data. Everything',
        'created while exploring is gone; the live database is untouched whichever mode',
        'the request is sent in.',
        '',
        'The sandbox is shared by everyone using the reference, so a reset is visible to',
        'anybody else exploring at the same time.'
      ].join('\n'),
      responses: {
        200: json('Rebuilt.', {
          allOf: [ref('SandboxStatus'), object({ message: str('Confirmation') })]
        }, {
          message: 'Sandbox rebuilt from demo data. Anything created in it is gone.',
          enabled: true,
          active: true,
          header: 'X-Devcircle-Sandbox',
          reset_at: '2026-08-14T15:40:02.118Z',
          counts: { users: 6, cohorts: 2, circles: 1, surveys: 1, survey_responses: 3, gifts: 1, feedback: 2, scheduled_sessions: 1 }
        }),
        503: json('The sandbox is switched off in this environment.', ref('Error'), {
          error: 'The API sandbox is switched off in this environment'
        })
      }
    })
  },

  // ─── The specification itself ─────────────────────────────
  '/admin/docs/openapi.json': {
    get: op({
      tag: 'Admin · API reference',
      permission: 'docs.read',
      operationId: 'getOpenApiSpec',
      summary: 'This specification, as OpenAPI 3.0',
      description: [
        'The document you are reading. Import it into Postman, Insomnia or a code',
        'generator, or point another Swagger UI at it.',
        '',
        'It is generated from the same permission catalogue the routes are gated on, so',
        'the `x-permission` on each operation is what the server will actually check.'
      ].join('\n'),
      responses: {
        200: json('The OpenAPI document.', object({
          openapi: str('Specification version'),
          info: object({}, { description: 'Title, version and the getting-started guide' }),
          servers: arrayOf(object({}), 'Where the API answers'),
          tags: arrayOf(object({}), 'How the operations are grouped'),
          paths: object({}, { description: 'Every endpoint' }),
          components: object({}, { description: 'Schemas, security schemes and shared responses' })
        }), { openapi: '3.0.3', info: { title: 'Dev Circle API', version: '1.0.0' } })
      }
    })
  }
};

module.exports = paths;
