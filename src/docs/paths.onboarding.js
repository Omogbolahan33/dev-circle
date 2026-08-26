// ─── Paths: onboarding ──────────────────────────────────────
// Both halves of the same feature in one file, because they are only
// comprehensible together: what a stranger can reach on somebody else's page,
// and what an administrator does with what comes back.
//
// The dividing line is worth reading in the descriptions rather than inferred
// from the prefixes — nothing under /onboarding writes to users, and
// everything that does is under /admin.

const { ref, str, int, bool, id, timestamp, arrayOf, object } = require('./components');
const { op, json, jsonBody, fileResponse, query, path } = require('./operation');

const FORM_TOKEN = 'k3Nv8QpZ2xR7tYbW1mAe5LcH9dFsJ0uG';

const QUESTIONS_EXAMPLE = [
  {
    id: 'q1_4a7c2e19', type: 'text', text: 'What should we call you?',
    required: true, format: 'none', maps_to: 'name'
  },
  {
    id: 'q2_9f1b3d05', type: 'text', text: 'Which email should we send your invitation to?',
    required: true, format: 'email', maps_to: 'email'
  },
  {
    id: 'q3_2c8e6a44', type: 'text', text: 'And your phone number?',
    required: true, format: 'phone', maps_to: 'phone'
  },
  {
    id: 'q4_1e5a9c07', type: 'boolean', text: 'Have you already built against our sandbox?',
    required: true, true_label: 'Yes', false_label: 'Not yet'
  },
  {
    id: 'q4_7d3f1b62', type: 'multi_choice', text: 'Which products are you integrating?',
    required: false, options: ['Lending', 'Payments', 'Identity'], maps_to: 'api_products',
    visible_if: { match: 'all', rules: [{ question: 'q4_1e5a9c07', op: 'is', value: true }] }
  }
];

const FORM_EXAMPLE = {
  id: 'ob_3f19', circle_id: 'c_dev', name: 'Partner developer intake',
  description: 'Join the Credit Direct developer circle.',
  questions: QUESTIONS_EXAMPLE,
  theme: { accent: '#107EBC', layout: 'one_per_page', corner: 'soft' },
  field_map: {
    q1_4a7c2e19: 'name', q2_9f1b3d05: 'email', q3_2c8e6a44: 'phone', q4_7d3f1b62: 'api_products'
  },
  cohort_ids: ['co_partner'],
  status: 'active',
  public_token: FORM_TOKEN,
  allowed_origins: ['https://developers.partner.com'],
  redirect_url: null,
  submitted_message: 'Thanks — we will be in touch once someone has looked at this.',
  duplicate_policy: 'replace',
  public_path: `/o/${FORM_TOKEN}`,
  created_at: '2026-08-20 09:14:02'
};

const APPLICATION_EXAMPLE = {
  id: 'sub_a91c', form_id: 'ob_3f19', form_name: 'Partner developer intake',
  email: 'chidi@paystack.africa', name: 'Chidi Nwosu', status: 'pending',
  source_origin: 'https://developers.partner.com',
  source_page: 'https://developers.partner.com/join',
  submitted_at: '2026-08-24 11:02:41', created_at: '2026-08-24 10:58:12',
  decided_at: null, decision_note: null, decided_by_name: null, user_id: null
};

const paths = {

  // ─── Filling one in ───────────────────────────────────────

  '/onboarding/{token}': {
    get: op({
      tag: 'Onboarding forms',
      auth: 'none',
      operationId: 'getOnboardingForm',
      summary: 'The form behind a link',
      description: [
        'Takes no credential. The token is the authorisation and it opens exactly one form —',
        'there is no endpoint here that accepts a form id.',
        '',
        'A token that never existed and one whose form has been closed answer 404 identically,',
        'so this cannot be used to work out which tokens are real. The form comes back with its',
        'theme resolved and with nothing about how it is run: not the circle it feeds, not the',
        'cohorts it joins people to, not the origins it may be embedded on, and no counts.',
        '',
        'The closing message and the redirect are not here either — they are only needed once it',
        'has been sent in, and the submit response carries them then.'
      ].join('\n'),
      parameters: [path('token', 'The token from the form\'s link or embed snippet', { type: 'string' })],
      responses: {
        200: json('The form, as somebody filling it in sees it.', object({
          form: object({
            id: id('Form id'),
            name: str('What the form is called'),
            description: str('Shown above the first question'),
            questions: arrayOf(object({}), 'The questions, in order, with their branching rules'),
            theme: object({}, { description: 'The resolved theme — the form\'s own over the circle\'s default' })
          })
        }), {
          form: {
            id: FORM_EXAMPLE.id, name: FORM_EXAMPLE.name, description: FORM_EXAMPLE.description,
            questions: QUESTIONS_EXAMPLE, theme: FORM_EXAMPLE.theme
          }
        }),
        404: json('No open form behind this link.', ref('Error'), {
          error: 'This form is not open. The link may have been closed, or it may never have existed.'
        })
      }
    })
  },

  '/onboarding/{token}/start': {
    post: op({
      tag: 'Onboarding forms',
      auth: 'none',
      operationId: 'startOnboarding',
      summary: 'Begin an application',
      description: [
        'Creates an application and returns the key that owns it. **No account is created here**',
        'and none is created when it is submitted: what this produces is an application an',
        'administrator reviews.',
        '',
        'A caller that already holds a key gets its answers back rather than a second blank',
        'application, so a refreshed tab is not a second applicant. The key is shown once and',
        'cannot be recovered.',
        '',
        '`embedded_on` is the address of the page the embed is running on. It is recorded only',
        'when it names an origin this form allows to frame it, and ignored otherwise.'
      ].join('\n'),
      parameters: [path('token', 'The token from the form\'s link or embed snippet', { type: 'string' })],
      requestBody: jsonBody(object({
        session_key: str('A key from an earlier start, to resume that application'),
        embedded_on: str('The page the embed is on')
      }), { embedded_on: 'https://developers.partner.com/join' }, { required: false }),
      responses: {
        200: json('The application, new or resumed.', object({
          form: object({}, { description: 'The form, as in GET /onboarding/{token}' }),
          session_key: str('Shown once. How this browser returns to this application.'),
          answers: object({}, { description: 'What has been filled in so far, keyed by question id' })
        }), {
          form: { id: 'ob_3f19', name: 'Partner developer intake' },
          session_key: 'Zt7nQ2xR9mAe5LcH1dFsJ0uGk3Nv8QpW',
          answers: {}
        }),
        404: json('No open form behind this link.', ref('Error'), {
          error: 'This form is not open. The link may have been closed, or it may never have existed.'
        }),
        409: json('This application has already been sent in.', ref('Error'), {
          error: 'You have already sent this in. We will be in touch.'
        })
      }
    })
  },

  '/onboarding/{token}/progress': {
    patch: op({
      tag: 'Onboarding forms',
      auth: 'none',
      operationId: 'saveOnboardingProgress',
      summary: 'Keep what has been filled in',
      description: [
        'A form long enough to need branching is long enough to be abandoned halfway on a phone,',
        'and starting again is how it stays abandoned.',
        '',
        'Answers to questions this form does not contain are dropped rather than refused, so a',
        'stale tab cannot fail the whole save. Nothing is validated here — that happens on submit.'
      ].join('\n'),
      parameters: [path('token', 'The token from the form\'s link', { type: 'string' })],
      requestBody: jsonBody(object({
        session_key: str('The key returned by start'),
        answers: object({}, { description: 'Answers so far, keyed by question id' })
      }), {
        session_key: 'Zt7nQ2xR9mAe5LcH1dFsJ0uGk3Nv8QpW',
        answers: { q1_4a7c2e19: 'Chidi Nwosu' }
      }),
      responses: {
        200: json('Saved.', object({ saved: int('How many answers were kept') }), { saved: 1 }),
        400: json('No answers object.', ref('Error'), { error: 'answers object required' }),
        404: json('No such form, or this key owns no application.', ref('Error'), {
          error: 'Start the form first'
        }),
        409: json('Already sent in.', ref('Error'), { error: 'Already sent in' }),
        413: json('More than a form in progress can hold.', ref('Error'), {
          error: 'That is more than a form in progress can hold'
        })
      }
    })
  },

  '/onboarding/{token}/submit': {
    post: op({
      tag: 'Onboarding forms',
      auth: 'none',
      operationId: 'submitOnboarding',
      summary: 'Send the application in',
      description: [
        'Validated against the same question definition the builder wrote, and answers to',
        'questions this applicant was never shown are dropped rather than stored.',
        '',
        'The questions tagged as collecting an email address and a name are resolved into a',
        'profile here, against the form as it stands now — not at approval time, when the',
        'wording may have changed underneath the answers.',
        '',
        '**This creates no account.** The application moves to `pending` and waits for somebody',
        'holding `onboarding.approve` to decide on it. What happens when the same address',
        'applies twice is the form\'s `duplicate_policy`.'
      ].join('\n'),
      parameters: [path('token', 'The token from the form\'s link', { type: 'string' })],
      requestBody: jsonBody(object({
        session_key: str('The key returned by start'),
        answers: object({}, { description: 'Every answer, keyed by question id' })
      }), {
        session_key: 'Zt7nQ2xR9mAe5LcH1dFsJ0uGk3Nv8QpW',
        answers: {
          q1_4a7c2e19: 'Chidi Nwosu',
          q2_9f1b3d05: 'chidi@paystack.africa',
          q3_2c8e6a44: true,
          q4_7d3f1b62: ['Lending', 'Payments']
        }
      }),
      responses: {
        200: json('The application is in the queue.', object({
          message: str(),
          answered: int('How many questions were actually asked'),
          submitted_message: str('What to show them now'),
          redirect_url: str('Where to send them, if anywhere')
        }), {
          message: 'Application received',
          answered: 4,
          submitted_message: 'Thanks — we will be in touch once someone has looked at this.',
          redirect_url: null
        }),
        400: json('The answers were refused, or nobody could be identified from them.', ref('Error'), {
          error: 'Some required questions have not been answered',
          missing: ['q2_9f1b3d05']
        }),
        404: json('No such form, or this key owns no application.', ref('Error'), {
          error: 'Start the form first'
        }),
        409: json('Already sent in, or already a member.', ref('Error'), {
          error: 'That address is already a member here.'
        })
      }
    })
  },

  // ─── Authoring one ────────────────────────────────────────

  '/admin/onboarding': {
    get: op({
      tag: 'Admin · Onboarding',
      operationId: 'listOnboardingForms',
      permission: 'onboarding.read',
      summary: 'Every onboarding form in this circle',
      description: 'With how many applications each has taken, and how many are still waiting on a decision.',
      responses: {
        200: json('The forms.', object({ forms: arrayOf(object({}), 'Onboarding forms') }), {
          forms: [{ ...FORM_EXAMPLE, pending_count: 3, approved_count: 11, submission_count: 15 }]
        })
      }
    }),
    post: op({
      tag: 'Admin · Onboarding',
      operationId: 'createOnboardingForm',
      permission: 'onboarding.write',
      summary: 'Write a new onboarding form',
      description: [
        'Questions, branching and theme are the same definition a survey carries and are',
        'validated by the same code. What is added is `maps_to` on a question: the profile field',
        'that answer fills in. `GET /admin/onboarding/schema` lists what may be tagged with what.',
        '',
        'A draft may be anything. A form saved with `status: "active"` must ask for an **email',
        'address** and a **phone number**, both required and neither behind a branch: together',
        'they are what an approved member signs in with, so a form that can be completed without',
        'them produces accounts nobody can get into.',
        '',
        'Nothing else is compulsory. A form that collects no name publishes fine and comes back',
        'with a `warnings` entry saying those members will show as unnamed — the consequence is',
        'surfaced, not imposed.',
        '',
        'The form is created in the circle being worked in, and that is the circle its approved',
        'applicants join. The public token is issued on creation, so the embed snippet can be',
        'copied out of the builder on the first save.'
      ].join('\n'),
      requestBody: jsonBody(object({
        name: str('What the form is called, internally'),
        description: str('Shown above the first question'),
        questions: arrayOf(object({}), 'The questions, in order'),
        theme: object({}, { description: 'Brand colours, type, imagery and layout' }),
        cohort_ids: arrayOf(str(), 'Cohorts an approved applicant joins — must belong to this circle'),
        allowed_origins: arrayOf(str(), 'Origins allowed to frame this form. A leading *. matches subdomains.'),
        redirect_url: str('Where to send them once they have sent it in'),
        submitted_message: str('What to show them if they are not being sent anywhere'),
        duplicate_policy: str('replace | reject | allow — what a second application from one address means'),
        status: str('draft or active')
      }), {
        name: 'Partner developer intake',
        questions: QUESTIONS_EXAMPLE,
        theme: { accent: '#107EBC' },
        allowed_origins: ['https://developers.partner.com'],
        cohort_ids: ['co_partner'],
        status: 'active'
      }),
      responses: {
        201: json('Created.', object({
          form: object({}),
          embed_snippet: str('The two lines to paste into the host page'),
          warnings: arrayOf(object({}), 'Saved, but worth a second look')
        }), {
          form: FORM_EXAMPLE,
          embed_snippet: `<div data-devcircle-onboarding="${FORM_TOKEN}"></div>\n<script src="https://circle.creditdirect.ng/embed/onboarding.js" async></script>`
        }),
        400: json('The form could not be saved.', ref('Error'), {
          error: 'No question collects the phone number. It is half of what an approved member signs in with, so a form without it produces accounts nobody can get into.',
          issues: [{ field: 'maps_to', message: 'No question collects the phone number. It is half of what an approved member signs in with, so a form without it produces accounts nobody can get into.' }]
        })
      }
    })
  },

  '/admin/onboarding/schema': {
    get: op({
      tag: 'Admin · Onboarding',
      operationId: 'getOnboardingSchema',
      permission: 'onboarding.read',
      summary: 'What an onboarding form may contain',
      description: [
        'The question types, the branching operators and the theme options, all unchanged from',
        'the survey schema — it is the same builder over the same definition.',
        '',
        'What is added is `fields`: the profile fields a question may be tagged with, and which',
        'question types may carry each. The builder draws its menu from this rather than holding',
        'its own copy.',
        '',
        'Two of them carry `required: true` — the email address and the phone number. Those are',
        'the credential a member signs in with, so every form that goes out must collect both,',
        'required and not behind a branch. `recommended: true` marks a field whose absence is',
        'only warned about. Everything else is the circle\'s to choose.'
      ].join('\n'),
      responses: {
        200: json('The schema.', object({
          types: arrayOf(object({}), 'Question types'),
          operators: arrayOf(object({}), 'Branching operators'),
          operators_by_type: object({}, { description: 'Which operators each type accepts' }),
          text_formats: arrayOf(object({}), 'Formats a text answer can be held to'),
          rating_styles: arrayOf(str(), 'How a rating can be drawn'),
          fields: arrayOf(object({}), 'Profile fields a question can be tagged with'),
          theme: object({}, { description: 'Theme options, and this circle\'s default' })
        }), {
          fields: [
            { value: 'email', label: 'Email address', types: ['text'], required: true, recommended: false },
            { value: 'phone', label: 'Phone number', types: ['text'], required: true, recommended: false },
            { value: 'name', label: 'Full name', types: ['text'], required: false, recommended: true },
            { value: 'api_products', label: 'API products', types: ['multi_choice', 'ranking', 'choice', 'dropdown'], required: false, recommended: false },
            { value: 'consent_channels', label: 'Consent to contact', types: ['multi_choice'], required: false, recommended: false, channels: ['in_portal', 'email', 'whatsapp', 'sms', 'calls'] }
          ],
          types: [{ type: 'text', label: 'Text', answerable: true }]
        })
      }
    })
  },

  '/admin/onboarding/{id}': {
    get: op({
      tag: 'Admin · Onboarding',
      operationId: 'getOnboardingForm2',
      permission: 'onboarding.read',
      summary: 'One form, for editing',
      description: [
        'With the counts behind it and whether its questions are still editable.',
        '',
        'Questions freeze once anybody has filled the form in, for the same reason a survey\'s do:',
        'rewriting one leaves answers attached to wording nobody was shown — and here those',
        'answers are somebody\'s personal details. The look, the origins, the redirect and whether',
        'it is open can all still change.'
      ].join('\n'),
      parameters: [path('id', 'Form id')],
      responses: {
        200: json('The form.', object({
          form: object({}),
          counts: object({}, { description: 'pending, approved, rejected and unfinished' }),
          questions_locked: bool('Whether anybody has filled it in yet'),
          circle_theme: object({}, { description: 'What this circle\'s forms start from' }),
          embed_snippet: str('The two lines to paste into the host page')
        }), {
          form: FORM_EXAMPLE,
          counts: { pending: 3, approved: 11, rejected: 1, unfinished: 6 },
          questions_locked: true
        }),
        404: json('No such form in this circle.', ref('Error'), { error: 'Form not found' })
      }
    }),
    put: op({
      tag: 'Admin · Onboarding',
      operationId: 'updateOnboardingForm',
      permission: 'onboarding.write',
      summary: 'Edit a form',
      description: [
        'Once applications exist the questions are fixed: posting different ones answers 409,',
        'and posting the same ones is accepted so a builder can save a theme change without',
        'stripping the questions out of its payload first.',
        '',
        'Publishing is checked here too, so a draft saved without an email question cannot become',
        'active through an edit that only changed its colours.'
      ].join('\n'),
      parameters: [path('id', 'Form id')],
      requestBody: jsonBody(object({
        name: str(), description: str(),
        questions: arrayOf(object({}), 'Ignored, beyond a check that they match, once applications exist'),
        theme: object({}), cohort_ids: arrayOf(str()), allowed_origins: arrayOf(str()),
        redirect_url: str(), submitted_message: str(), duplicate_policy: str(),
        status: str('draft, active or closed')
      }), { name: 'Partner developer intake', status: 'closed' }),
      responses: {
        200: json('Saved.', object({ form: object({}), embed_snippet: str(), warnings: arrayOf(object({})) }), {
          form: { ...FORM_EXAMPLE, status: 'closed' }
        }),
        400: json('The form could not be saved.', ref('Error'), {
          error: 'A question collecting the email address must use the "Email address" format'
        }),
        404: json('No such form in this circle.', ref('Error'), { error: 'Form not found' }),
        409: json('Its questions are fixed.', ref('Error'), {
          error: '15 people have already filled this in, so the questions are fixed. Close it and write a new one to ask differently.'
        })
      }
    }),
    delete: op({
      tag: 'Admin · Onboarding',
      operationId: 'deleteOnboardingForm',
      permission: 'onboarding.write',
      summary: 'Delete a form nobody has filled in',
      description: [
        'A form somebody has filled in is closed rather than deleted — deleting it would take',
        'their applications with it, and those are the record of what people were asked and what',
        'they were told.'
      ].join('\n'),
      parameters: [path('id', 'Form id')],
      responses: {
        200: json('Deleted.', object({ message: str() }), { message: 'Form deleted' }),
        404: json('No such form in this circle.', ref('Error'), { error: 'Form not found' }),
        409: json('People have filled it in.', ref('Error'), {
          error: '15 people have filled this in. Close it instead — deleting it would delete their applications too.'
        })
      }
    })
  },

  '/admin/onboarding/{id}/duplicate': {
    post: op({
      tag: 'Admin · Onboarding',
      operationId: 'duplicateOnboardingForm',
      permission: 'onboarding.write',
      summary: 'Copy a form',
      description: [
        'Every question gets a fresh slot id and the branching rules are rewritten to match, so',
        'the copy\'s answers can never be read against the original\'s definition. The copy is a',
        'draft with its own token: sharing one would mean closing the original closed the copy.'
      ].join('\n'),
      parameters: [path('id', 'Form id')],
      responses: {
        201: json('The copy.', object({ form: object({}) }), {
          form: { ...FORM_EXAMPLE, id: 'ob_5b22', name: 'Partner developer intake (copy)', status: 'draft' }
        }),
        404: json('No such form in this circle.', ref('Error'), { error: 'Form not found' })
      }
    })
  },

  '/admin/onboarding/{id}/import/template': {
    get: op({
      tag: 'Admin · Onboarding',
      operationId: 'onboardingImportTemplate',
      permission: 'onboarding.read',
      summary: 'A blank sheet shaped like this form',
      description: [
        'One column per question the form asks, plus two of its own: when the details were',
        'collected, and your own reference for the row.',
        '',
        'Generated from the form rather than written out, so it can never advertise a column the',
        'parser ignores. The example row is a real one — downloading the template and importing',
        'it unedited lands one application, which is asserted by a test and is the only honest',
        'way to promise that the format shown is the format accepted. Delete it before a real run.',
        '',
        '`format` is `xlsx` (default) or `csv`. The workbook carries a second sheet spelling out',
        'what each column accepts, for whoever is transcribing a stack of paper forms.'
      ].join('\n'),
      parameters: [
        path('id', 'Form id'),
        query('format', 'xlsx (default) or csv')
      ],
      responses: {
        200: fileResponse('The template.',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'submitted_at,reference,q1. What should we call you?,q2. Which email should we send your invitation to?,q3. And your phone number?'),
        400: json('The form asks nothing yet, or the format is unknown.', ref('Error'), {
          error: 'This form asks nothing yet, so there is nothing for a sheet to line up against'
        }),
        404: json('No such form in this circle.', ref('Error'), { error: 'Form not found' })
      }
    })
  },

  '/admin/onboarding/{id}/import/columns': {
    get: op({
      tag: 'Admin · Onboarding',
      operationId: 'onboardingImportColumns',
      permission: 'onboarding.read',
      summary: 'The spec behind the template',
      description: 'So a screen can describe the upload without keeping a second copy of the column list that drifts from the parser\'s. `also_accepted` is every other heading a column answers to, which is why an export from another tool lines up without being edited.',
      parameters: [path('id', 'Form id')],
      responses: {
        200: json('The columns.', object({
          form: object({}),
          guidance: arrayOf(str(), 'The rules, in prose, as the template prints them'),
          columns: arrayOf(object({}), 'One per column, question columns included')
        }), {
          form: { id: 'ob_3f19', name: 'Partner developer intake' },
          guidance: ['One row per person you are onboarding through "Partner developer intake". Delete the example row before importing.'],
          columns: [{
            key: 'q2. Which email should we send your invitation to?',
            kind: 'question', required: true, maps_to: 'email', type: 'text',
            accepts: 'An email address.', in_template: true,
            also_accepted: ['q2', 'q2_9f1b3d05', 'Which email should we send your invitation to?']
          }]
        }),
        404: json('No such form in this circle.', ref('Error'), { error: 'Form not found' })
      }
    })
  },

  '/admin/onboarding/{id}/import': {
    post: op({
      tag: 'Admin · Onboarding',
      operationId: 'importOnboarding',
      permission: 'onboarding.write',
      summary: 'Land a sheet of people as applications',
      description: [
        'One row or five hundred — a partner\'s list, a page of names off a stand, somebody\'s',
        'export. The mechanism does not care, which is what makes "add this one person" and',
        '"add these two hundred" the same feature.',
        '',
        'Every row goes through the same check a filled-in form gets, from the same definition:',
        'required answers are required, branching decides what was asked, and an answer under a',
        'branch the row did not open is dropped. A refusal is reported against its line in the',
        'sheet, so a two-hundred-row file is fixed in one pass rather than one refusal at a time.',
        '',
        '**Nothing here creates a member by default.** Rows become applications in the same queue',
        'a filled-in form lands in. `approve: true` approves each one as it lands — and because',
        'that creates members, it needs `onboarding.approve` on top of `onboarding.write`, and',
        'answers 403 without it.',
        '',
        'Two things make a re-run safe: a row carrying a `Your reference` already seen on this',
        'form is skipped, and an address that already has a pending or approved application is',
        'skipped. The same address twice *within one sheet* is refused instead — unlike a',
        're-upload, the operator has not watched that row land once already.',
        '',
        'Use `dry_run: true` first. It reports exactly what a real run would do and writes nothing.'
      ].join('\n'),
      parameters: [path('id', 'Form id')],
      requestBody: jsonBody(object({
        csv: str('The sheet as CSV text'),
        xlsx_base64: str('The workbook, base64 encoded'),
        rows: arrayOf(object({}), 'Or the rows already parsed, keyed by heading'),
        dry_run: bool('Report what would happen and write nothing'),
        approve: bool('Approve each row as it lands. Needs onboarding.approve.')
      }), {
        csv: 'What should we call you?,Which email should we use?,And your phone number?\nAda Obi,ada@zilla.ng,08031112222',
        dry_run: true
      }),
      responses: {
        200: json('What landed, and what did not.', object({
          created: int('Applications created — or that would be, on a dry run'),
          skipped: int('Rows already held, by reference or by address'),
          approved: int('Members created, when approve was set'),
          errors: arrayOf(object({
            line: int('The line in the sheet, counting the headings as line 1'),
            error: str('Why that row was refused')
          }), 'One per refused row'),
          dry_run: bool(),
          rows: int('How many data rows the sheet carried'),
          unmatched_columns: arrayOf(str(), 'Headings this form has nowhere to put')
        }), {
          created: 2, skipped: 1, approved: 0,
          errors: [{ line: 4, error: 'Not answered: And your phone number?' }],
          dry_run: false, rows: 4, unmatched_columns: ['shoe_size']
        }),
        400: json('The sheet could not be read, or the form is not ready to take applications.', ref('Error'), {
          error: 'No data rows found. The first row must be the headings, with a row per person under it.'
        }),
        403: json('Approving as they land needs its own permission.', ref('Error'), {
          error: 'Approving as they land needs the onboarding.approve permission. Import without it and the rows wait in the queue.'
        }),
        404: json('No such form in this circle.', ref('Error'), { error: 'Form not found' })
      }
    })
  },

  // ─── Deciding on what comes back ──────────────────────────

  '/admin/onboarding-applications': {
    get: op({
      tag: 'Admin · Onboarding',
      operationId: 'listOnboardingApplications',
      permission: 'onboarding.read',
      summary: 'The queue',
      description: [
        'Applications across every form in this circle. Scoped to the circle because an',
        'application is addressed to one workspace, and a lead for another has no business',
        'reading the personal details in it.',
        '',
        'Unfinished ones are left out unless asked for: somebody who opened a form and stopped',
        'typing has not applied.'
      ].join('\n'),
      parameters: [
        query('status', 'pending (default), approved, rejected, withdrawn or started'),
        query('form_id', 'Only applications to one form'),
        query('limit', 'Up to 200', { type: 'integer', default: 50 }),
        query('offset', 'For paging', { type: 'integer', default: 0 })
      ],
      responses: {
        200: json('The queue.', object({
          applications: arrayOf(object({}), 'Applications'),
          total: int('How many match'),
          pending: int('How many are waiting on a decision, whatever the filter')
        }), { applications: [APPLICATION_EXAMPLE], total: 3, pending: 3 })
      }
    })
  },

  '/admin/onboarding-applications/{id}': {
    get: op({
      tag: 'Admin · Onboarding',
      operationId: 'getOnboardingApplication',
      permission: 'onboarding.read',
      summary: 'One application, in full',
      description: [
        'What they were asked, what they answered, and what of it the form understood as a fact',
        'about them — all three, because somebody deciding whether to let a stranger into a',
        'workspace is entitled to the answers in the words they were given.',
        '',
        '`asked` contains only the questions this applicant actually saw. A branch they never',
        'went down is not an unanswered question.',
        '',
        '`existing_member` says whether approving this would create an account or join somebody',
        'who already has one to this circle.'
      ].join('\n'),
      parameters: [path('id', 'Application id')],
      responses: {
        200: json('The application.', object({
          application: object({}, { description: 'With its answers, resolved profile and consent' }),
          asked: arrayOf(object({}), 'The questions they saw, with their answers'),
          existing_member: object({}, { description: 'The member holding this address, or null' })
        }), {
          application: {
            ...APPLICATION_EXAMPLE,
            profile: { name: 'Chidi Nwosu', email: 'chidi@paystack.africa', api_products: ['Lending', 'Payments'] },
            consent_channels: ['email', 'whatsapp']
          },
          asked: [{
            id: 'q1_4a7c2e19', text: 'What should we call you?', type: 'text',
            maps_to: 'name', answer: 'Chidi Nwosu', answer_text: 'Chidi Nwosu'
          }],
          existing_member: null
        }),
        404: json('No such application in this circle.', ref('Error'), { error: 'Application not found' })
      }
    })
  },

  '/admin/onboarding-applications/decide': {
    post: op({
      tag: 'Admin · Onboarding',
      operationId: 'decideOnboardingApplications',
      permission: 'onboarding.approve',
      summary: 'One decision, applied to many',
      description: [
        'A queue is worked through in passes — a stack of applicants from one partner\'s list are',
        'all the same decision, and clicking through them one at a time is how a reviewer stops',
        'reading them.',
        '',
        'Worked one at a time on the server rather than as a single UPDATE, on purpose. Approving',
        'is not a status change: it creates an account, joins a circle and writes consent, and any',
        'one row can legitimately refuse — a Credit Direct address, an application carrying no',
        'usable email. A bulk update would either take the whole batch down with the first refusal',
        'or hide it. This reports per row in `failed` and keeps going, which is the only shape',
        'that makes a screenful of checkboxes safe to press.',
        '',
        'An id belonging to another circle is reported as not found rather than refused — the same',
        'answer that circle\'s queue gives about ours. Two hundred at a time is the ceiling.'
      ].join('\n'),
      requestBody: jsonBody(object({
        ids: arrayOf(str(), 'The applications to decide on'),
        action: str('approve, reject or reopen', { enum: ['approve', 'reject', 'reopen'] }),
        note: str('Why, recorded against every one of them')
      }, { required: ['ids', 'action'] }), {
        ids: ['sub_a91c', 'sub_b02d', 'sub_c14f'],
        action: 'approve',
        note: 'Partner programme intake'
      }),
      responses: {
        200: json('What was done, and what could not be.', object({
          decided: int('How many the action was applied to'),
          created: int('Members created, when the action was approve'),
          failed: arrayOf(object({
            id: id('The application'),
            error: str('Why that one could not be done')
          }), 'One per row that refused. The rest still landed.'),
          message: str('A sentence for a toast')
        }), {
          decided: 2, created: 2,
          failed: [{
            id: 'sub_c14f',
            error: 'Credit Direct staff accounts are created by an administrator, not through a form'
          }],
          message: '2 of 3 done — 1 could not be'
        }),
        400: json('Nothing to decide on, an unknown action, or more than two hundred.', ref('Error'), {
          error: 'action must be approve, reject or reopen'
        })
      }
    })
  },

  '/admin/onboarding-applications/{id}/reopen': {
    post: op({
      tag: 'Admin · Onboarding',
      operationId: 'reopenOnboardingApplication',
      permission: 'onboarding.approve',
      summary: 'Put a rejected application back in the queue',
      description: [
        'Undeciding. For somebody who wants a rejection off their desk without putting a yes on',
        'it instead — a triage pass that turned out to need a second opinion. The decision, its',
        'note and who made it are all cleared.',
        '',
        'Only a rejected application can be reopened. An approved one has a member behind it, and',
        'clearing the paperwork would not undo that; removing them from the circle is the member',
        'page\'s job. Reopening one that is already waiting answers 200 and changes nothing.'
      ].join('\n'),
      parameters: [path('id', 'Application id')],
      responses: {
        200: json('Back in the queue.', object({
          message: str(), reopened: bool(), already: bool('It was already waiting')
        }), { message: 'Back in the queue', reopened: true }),
        404: json('No such application in this circle.', ref('Error'), { error: 'Application not found' }),
        409: json('It cannot be reopened.', ref('Error'), {
          error: 'This applicant is already a member, so there is nothing to put back in the queue.'
        })
      }
    })
  },

  '/admin/onboarding-applications/{id}/approve': {
    post: op({
      tag: 'Admin · Onboarding',
      operationId: 'approveOnboardingApplication',
      permission: 'onboarding.approve',
      summary: 'Approve an applicant into the circle',
      description: [
        'The only place in the onboarding path that writes to `users`, which is what makes a',
        'publicly embeddable form safe to publish at all.',
        '',
        'Creates the account if that address holds none, joins them to the circle the form feeds',
        'and to its cohorts, and writes a granted consent row for every channel they ticked. They',
        'hold no password at all: like every participant, they sign in with their email address',
        'and the last six digits of the phone number on the application.',
        '',
        'Where the address already belongs to a member — or, failing an address, the normalised',
        'phone number does — they are joined to the circle instead of getting a second account,',
        'and the application fills in only what their profile did not already have. A Credit',
        'Direct address is refused: staff accounts are created by an administrator.',
        '',
        'A **rejected** application can be approved too. A rejection is a decision somebody made',
        'in a minute about a person they had never heard of, and the reason to reconsider usually',
        'arrives afterwards. What stops that being a way to approve twice is that an approved one',
        'cannot be approved again.'
      ].join('\n'),
      parameters: [path('id', 'Application id')],
      requestBody: jsonBody(object({ note: str('Why, for the record') }), { note: 'Known from the partner programme' }, { required: false }),
      responses: {
        200: json('Approved.', object({
          message: str(), user_id: id('The member'), created: bool('Whether the account is new'),
          circle_id: id('The circle they joined'),
          can_sign_in: bool('Whether they hold enough to sign in — an address and a number')
        }), {
          message: 'Member created', user_id: '9f1c2a44-6d0b-4a1e-9c2f-7b1d3e5a8c40',
          created: true, circle_id: 'c_dev', can_sign_in: true
        }),
        404: json('No such application in this circle.', ref('Error'), { error: 'Application not found' }),
        409: json('It cannot be approved.', ref('Error'), {
          error: 'This application has already been approved'
        })
      }
    })
  },

  '/admin/onboarding-applications/{id}/reject': {
    post: op({
      tag: 'Admin · Onboarding',
      operationId: 'rejectOnboardingApplication',
      permission: 'onboarding.approve',
      summary: 'Turn an application down',
      description: [
        'Nothing is created and nothing is deleted. The application keeps its answers and carries',
        'the decision, so a queue that was worked through can be read back — and it can still be',
        'approved later, or put back in the queue with `POST …/reopen`.',
        '',
        'An **approved** application cannot be turned down: the account exists and marking the',
        'paperwork rejected would say otherwise while changing none of it.'
      ].join('\n'),
      parameters: [path('id', 'Application id')],
      requestBody: jsonBody(object({ note: str('Why, for the record') }), { note: 'Not a developer account' }, { required: false }),
      responses: {
        200: json('Rejected.', object({ message: str() }), { message: 'Application rejected' }),
        404: json('No such application in this circle.', ref('Error'), { error: 'Application not found' }),
        409: json('It has already been decided.', ref('Error'), {
          error: 'This application has already been approved'
        })
      }
    })
  }
};

module.exports = paths;
