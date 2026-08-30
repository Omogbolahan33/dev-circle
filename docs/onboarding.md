# Onboarding forms

A form a circle publishes to collect people who are not members yet — on this
site, or on a page this platform does not own.

Until now the only ways into a circle were an administrator typing somebody in,
a spreadsheet import, or the landing page calling
`POST /api/integrations/landing-page/ingest` with a scoped API key. None of
those is something a circle lead can set up on a Tuesday, and none of them can
be put on a partner's developer docs, a campaign microsite or a QR code on a
conference stand.

## What it is made of

It is the survey engine with one thing added and one thing changed.

**Added:** a question can be tagged with the profile field its answer fills in.
"What should we call you?" and "Who are we speaking to?" are the same question
as far as `users.name` is concerned, and the tag is what lets a form written in
its author's own words produce a profile.

**Changed:** what a submission is. A public survey response is evidence, and it
is deliberately anonymous — `src/routes/public.routes.js` says so in as many
words. An onboarding submission is the opposite: it exists to learn who
somebody is, and it is an *application* that gets decided on rather than a
record that gets counted.

Everything else is shared, from the same files:

| | |
|---|---|
| `public/assets/js/survey-schema.js` | what a question is, what branching may say, what counts as an answer |
| `public/assets/js/survey-theme.js` | colours, type, imagery, layout, contrast floors |
| `public/assets/js/survey-render.js` | the controls somebody answers with |
| `public/assets/js/question-builder.js` | the editor both builders draw their cards from |
| `public/assets/js/theme-panel.js` | the brand controls both builders offer |

## Nothing it collects becomes a member on its own

This is the load-bearing decision, and everything else follows from it.

An onboarding form is reachable, unauthenticated, from a page we do not
control. If submitting one wrote a row into `users`, the embed snippet would be
a public signup form for whoever found it — rate limits and origin checks only
raise the cost of abusing that, they do not remove it.

So submitting produces a row in `onboarding_submissions` and nothing else. No
user, no circle membership, no consent. Everything in the platform that counts
members, mails members or exports members reads `users` and `circle_members`,
so an application is invisible to all of it until somebody holding
`onboarding.approve` decides on it.

Approving is where the account is created, the circle is joined, the cohorts are
added and the consent rows are written — `onboarding.approve()` in
`src/services/onboarding.js`, reached only from an authenticated admin route.

The worst an abusive caller achieves is a queue that needs clearing.

## Writing one

**Onboarding → New form.** The builder is the survey builder: the same question
types, the same branching, the same theme panel.

The one extra control is on each card — *"This answer is…"* — which tags the
question with a profile field. Only fields that question type could carry are
offered, and a field another question already collects is greyed out (two
questions filling one column means the second silently wins, and which one is
second is a matter of what order they were dragged into).

### What a form must collect, and what it may

A form cannot go live until it collects an **email address** and a **phone
number**, both **required** and **not behind a branch**.

Those two are the credential: a participant signs in with their email address
and the last six digits of the phone number on their record. A form that can be
completed without them produces accounts nobody can get into, and the person who
filled it in has no way of knowing that happened.

**Everything else is the circle's to choose.** A form that collects no name
publishes fine — the members it makes simply show as unnamed everywhere they are
listed, and the builder says so in the rail on the right while there is still
something to do about it. That guidance is advice, never a refusal; it comes
back on the save response as `warnings` too, so an integration writing forms
through the API sees the same thing the builder shows.

The rail separates the two: `○` is something that blocks a publish, `·` is
something worth knowing.

### Fields a question can be tagged with

**Required of every form** — the credential:
`email` · `phone`

**Recommended** — a consequence is warned about if it is missing:
`name`

**Optional** — collect them or don't:
`company` · `work_sector` · `location_state` · `gender` · `date_of_birth` ·
`api_products` · `dev_hub_user_id` · `preferred_channels` · `preferred_days` ·
`consent_channels`

`GET /api/admin/onboarding/schema` is the live list, and the builder draws its
menu from it — a field added to `FIELDS` in `src/services/onboarding.js` appears
in the builder without a second edit.

Two of them are matched leniently on purpose, because an author writes option
labels for people to read rather than keys for us to parse. `consent_channels`
and `preferred_channels` fold "E-mail", "A phone call" and "In the portal" onto
`email`, `calls` and `in_portal`. An option that names **no** channel, or one
that names **two** ("Email or SMS"), is refused when the form is saved with the
option quoted back — consent is the last place to resolve an ambiguity on the
author's behalf.

## Three ways in

The same form, the same questions, the same queue.

### A link

Every form lives at `/o/<token>` — paste it into an email, a WhatsApp group, a
post, or turn it into a QR code for a conference stand. No account needed to
open it, and it is the same page the embed frames. **Onboarding → Share** on any
live form hands you the link.

### An embed on somebody else's page

Two lines, wherever the form should appear. See *Putting it on a page* below.

### A spreadsheet

**Onboarding → Import** on any form. Three steps, in this order:

1. **Take the template.** Excel or CSV, generated from that form's own questions
   plus two columns of its own — `submitted_at` and `reference`. The example row
   is a real one: downloading the template and importing it unedited lands one
   application, which a test asserts. Delete it before a real run.
2. **Check the file.** A dry run reports exactly what a real run would do and
   writes nothing. Refusals are reported against their line in the sheet, so a
   two-hundred-row file is fixed in one pass rather than one row at a time.
3. **Import.**

One row or five hundred — the mechanism does not care, which is what makes "add
this one person" and "add these two hundred" the same feature.

Every row goes through the same check a filled-in form gets, from the same
definition: required answers are required, branching decides what was asked, and
an answer under a branch the row did not open is dropped. A partner's list that
omits the phone number will have every row refused, and that is the point — the
alternative is a queue holding applications that do not satisfy the rules the
form states about itself.

**Rows become applications, not members.** They land in the same queue a
filled-in form lands in. Tick **Approve as they land** to do both steps at once;
because that creates members, it needs `onboarding.approve` on top of
`onboarding.write` and is hidden from anyone without it.

Two things make a re-run safe:

- a row carrying a `reference` already seen on this form is **skipped**;
- an address that already has a pending or approved application is **skipped**.

The same address twice *within one sheet* is **refused** instead — unlike a
re-upload, the operator has not watched that row land once already.

Columns the form has nowhere to put are named back in the result. A blank answer
and a column that did not line up look identical afterwards, so it is said there
or not at all.

## Putting it on a page

Two lines, wherever the form should appear:

```html
<div data-devcircle-onboarding="THE_FORM_TOKEN"></div>
<script src="https://your-domain.com/embed/onboarding.js" async></script>
```

The builder assembles this for you, with the address this deployment actually
answers on, so a staging form cannot hand out a production link.

It is an iframe, and the reasons are in the header of
`public/embed/onboarding.js`. Briefly: the form is themed, so rendering it
inside the host document would hand its buttons to whatever their reset says a
button looks like; it collects personal details, so in the host document any
script on that page could read what is being typed into it; and it validates
answers against a definition, which means loading the schema and the renderer
into a page we do not control.

What an iframe costs is height. The framed document reports how tall it is as
questions branch, and the loader resizes the frame — so nothing needs a height
set.

### The origin allowlist

A form names the sites allowed to frame it, under **Embed** in the builder. One
origin per line; a leading `*.` matches subdomains.

```
https://developers.partner.com
https://*.creditdirect.ng
```

That becomes `frame-ancestors` on the form's page, and `X-Frame-Options` is
removed from that one response — it has no list form, so left in place it would
mean `DENY`. Every other page in the platform keeps the strict default.

A form with nothing listed resolves to `frame-ancestors 'none'`: it still opens
at its own address, and it can be framed nowhere. That is the safe state for a
form nobody has told where it belongs.

### Reacting on the host page

When somebody sends the form in, the placeholder element is given a
`devcircle:onboarding:submitted` event — enough to hide the section, show a
confirmation of the host's own, or send an analytics event:

```html
<div data-devcircle-onboarding="THE_FORM_TOKEN" id="join"></div>
<script>
  document.getElementById('join')
    .addEventListener('devcircle:onboarding:submitted', event => {
      // event.detail.redirect — where the form wants them sent, or null.
      // Call event.preventDefault() to handle the redirect yourself.
      document.getElementById('join-section').hidden = true;
    });
</script>
```

A redirect is performed by the host page rather than from inside the frame: the
frame has no permission to move the page around it, and navigating itself would
leave the visitor looking at a page inside a box.

Nothing else crosses between the two pages. What is typed into the form is
readable only by this platform, which is the point of it being a frame.

## Working the queue

**Onboarding → Applications.** Each one shows the questions in the words they
were asked in, only the questions that applicant actually saw (a branch not
taken is not an unanswered question), what the form understood as facts about
them, and which channels they consented to.

- **Approve** creates the member, joins them to the circle the form feeds and to
  its cohorts, and writes a granted consent row per channel ticked. They hold no
  password: like every participant, they sign in with the email address on the
  application and the last six digits of the phone number beside it.
- Where the address already belongs to a member — or, failing an address, the
  normalised phone number does — they are **joined to this circle** instead of
  getting a second account, and the application fills in only what their profile
  did not already have. Somebody who applies through a
  partner's form having been a member for a year should not have their company
  replaced because they typed it differently this time.
- A Credit Direct address is refused. Staff accounts are created by an
  administrator and sign in with a password; approving one here would make a
  participant profile nobody could ever sign in to.
- **Turn down** creates nothing and deletes nothing. The application keeps its
  answers and carries the decision, so a queue that was worked through can be
  read back.

### Changing your mind

A rejection is not final. It is a decision somebody made in a minute about a
person they had never heard of, and the reason to reconsider — the partner
vouches for them, the address turns out to be the one from the conference list —
usually arrives afterwards.

So a rejected application offers two things instead of a dead end:

- **Approve after all** — the ordinary approval, from a no.
- **Put back in the queue** — clears the decision and its note, for somebody who
  wants it off their desk without putting a yes on it.

An **approved** application is final, and that asymmetry is deliberate: the
account exists, the person is in the circle, and marking the paperwork
"rejected" would say otherwise while changing none of it. Removing a member is
the member page's job.

### Deciding in bulk

Tick the rows and the bar above the table offers the decisions that make sense
for the tab you are on. A stack of applicants from one partner's list are all
the same decision, and clicking through them one at a time is how a reviewer
stops reading them.

Each row is decided separately on the server rather than in one statement.
Approving is not a status change — it creates an account, joins a circle, writes
consent — and any one row can legitimately refuse: a Credit Direct address, an
application carrying no usable email. A single bulk update would either take the
whole batch down with the first refusal or hide it. Instead the rest still land
and the refusals come back named:

```
3 of 4 done — 1 could not be
  · Credit Direct staff accounts are created by an administrator, not through a form
```

What could not be done stays selected, so the next thing on screen is the list
of what still needs attention rather than an empty table and a number in a
toast.

An application is addressed to one workspace, so the queue is scoped to the
circle being worked in. A lead for another circle has no business reading the
personal details in it.

### Duplicates

What a second application from one address means is the form's decision, because
it depends on where the form has been posted:

| | |
|---|---|
| `replace` (default) | keep the newer one, mark the earlier **superseded** — not deleted, since somebody may be part-way through reviewing it |
| `reject` | refuse the second and tell them we already have one |
| `allow` | keep both in the queue |

Somebody who is **already a member** is always told so, whichever this is set to.

## What the form did not collect

Onboarding is a form, and a form is answered once. The properties a circle needs
do not stop mattering because a question was optional, or because somebody
arrived through a door that never asked — Developer Hub SSO, a spreadsheet
import, the landing-page ingest. All three produce a member with gaps nobody
ever mentions again.

So the gaps become the member's own **three rings**, on their dashboard.

The rings hold two kinds of thing:

| | |
|---|---|
| **Asked of everybody** | name, phone, company, work sector, days that work, time window, preferred channels, consent |
| **Asked by the circle** | any other property an **active** onboarding form in one of their circles is configured to collect |

The second is the connection. A form's `maps_to` tags are that circle saying
"this matters here", so a circle that asks applicants where they work has a ring
task for it, and a circle that never asks about gender never nags anybody about
it. Close the form and it stops asking.

Tasks carry `asked_by_circle`, and both the dashboard and the profile page use
it: an unusual prompt is labelled *your circle asks* rather than appearing from
nowhere. Being asked for a date of birth with no idea who wants it is how a
checklist gets ignored.

Two rules keep it honest:

- **Nothing lands there that a member cannot act on.** The Developer Hub id is
  collectable by a form, written by the Hub, and editable by nobody — so it is
  never made a task. A prompt with nowhere to go is worse than no prompt.
- **A completed task shows what they said**, not the prompt that got it — except
  the phone number, which is half the credential and is deliberately never
  displayed anywhere it could be read off a screen by somebody who is not them.

`GET /api/users/readiness` is the whole of it; `src/services/readiness.js` holds
the property catalogue and `wantedFor()` is the query that asks the forms.

## Permissions

| | |
|---|---|
| `onboarding.read` | see the forms and the queue |
| `onboarding.write` | write and publish a form |
| `onboarding.approve` | approve an applicant into the circle |

Approving is separate from authoring on purpose: it creates a member account
from something a stranger typed into a page we do not control. Migration 27
grants `onboarding.read` and `onboarding.write` to roles that already held the
matching `surveys.*` permissions, and `onboarding.approve` to roles that held
`members.write`.

## Once people have filled it in

The questions freeze, for the same reason a survey's do — rewriting one would
leave answers attached to wording nobody was shown, and here those answers are
somebody's name, address and employer. Close the form and write a new one to ask
differently.

Its look, the sites it may be embedded on, where it sends people afterwards and
whether it is open can all still change. None of those alters what anybody was
asked.

A form nobody has filled in can be deleted. One somebody has is closed instead:
deleting it would take their applications with it.

## Where it lives

| | |
|---|---|
| `src/db/migrations.js` (27) | `onboarding_forms`, `onboarding_submissions`, and why they are not `surveys` |
| `src/services/onboarding.js` | the field catalogue, origin validation, publish rules, and `approve()` |
| `src/services/onboardingImport.js` | the spreadsheet path — a thin wrapper over `responseImport.js` |
| `src/routes/onboarding.routes.js` | the four unauthenticated endpoints a browser reaches |
| `src/routes/admin/onboarding.routes.js` | authoring, the queue, and the decisions |
| `src/middleware/security.js` | `allowFraming()` — the one carve-out in the frame policy |
| `public/onboarding/form.html` | the runner, standalone and embedded |
| `public/embed/onboarding.js` | the loader a host page includes |
| `public/admin/onboarding*.html` | the list, the builder, the queue |
| `docs/api` (`/admin/api-docs.html`) | every endpoint, with worked examples |

---

## How a member signs in

Worth knowing here, because it is why the form is required to collect what it
collects.

A participant signs in with **their email address and the last six digits of the
phone number on their record**. There is no password and no one-time code. Staff
— recognised by a Credit Direct email domain — still use a password, on the same
form.

A **phone number is not accepted as the identifier**. The secret is six digits
of that very number, so accepting it in the first box would mean handing over
the credential to reach the credential box. Typing one is answered with "sign in
with the email address you registered with".

The digits are counted off the normalised E.164 form, so `0803 555 0142`,
`+234 803 555 0142` and `8035550142` all yield the same six — otherwise the same
person would have a different secret depending on how they wrote their number
the day they registered.

### What this is worth

Six digits is a million combinations, and a phone number is not private the way
a password is: anyone who has it can derive this. What stands in front of it is
the login throttle — eight failures per address-and-IP in fifteen minutes — and
the rate limit on `/api/auth`. That is enough to make guessing impractical for
one attacker and **not** enough to make this equivalent to a password. The trade
is deliberate; it is written down beside the code in `src/utils/identity.js`.

Email verification is the intended next step. `src/services/loginCodes.js` is
left standing for it — the delivery, hashing and throttle machinery is what that
will be built on, and none of it changed when the login path did.

### Members who predate this

A member with **no phone number on file cannot sign in**, and is told only that
the credential does not match — "this address exists but has no number" is worth
nothing to them and something to an attacker.

That state is reachable four ways that have never required a number: Developer
Hub SSO, the landing-page ingest, a spreadsheet import, and an administrator
typing somebody in. **Anyone onboarded before this change who has no phone
number is locked out until one is added to their profile.** Worth a query
against `users` before this ships:

```sql
SELECT COUNT(*) FROM users WHERE phone_normalized IS NULL AND status = 'active';
```

Two ways to fix one: the member sets it themselves under **Profile**, or an
administrator sets it on the member's page — the Phone row reads *"None — they
cannot sign in"* and carries an **Add** button. Either way the number is
normalised to E.164 on the way in, because the six digits are counted off that
form rather than off what was typed.
