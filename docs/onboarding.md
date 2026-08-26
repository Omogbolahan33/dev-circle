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

A form cannot go live until:

- a question is tagged as the **email address**, and
- a question is tagged as the **full name**,

and both are **required** and **not behind a branch**. A branch around the email
question produces an application with nobody in it, and the person who filled it
in has no way of knowing that happened. The rail on the right shows what is
still outstanding while there is something to do about it.

### Fields a question can be tagged with

`email` · `name` · `phone` · `company` · `work_sector` · `location_state` ·
`gender` · `date_of_birth` · `api_products` · `dev_hub_user_id` ·
`preferred_channels` · `preferred_days` · `consent_channels`

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

### Its own address

Every form also lives at `/o/<token>` — a link in an email, a QR code on a
stand, a post. No account needed to open it, and it is the same page the embed
frames.

## Working the queue

**Onboarding → Applications.** Each one shows the questions in the words they
were asked in, only the questions that applicant actually saw (a branch not
taken is not an unanswered question), what the form understood as facts about
them, and which channels they consented to.

- **Approve** creates the member, joins them to the circle the form feeds and to
  its cohorts, and writes a granted consent row per channel ticked. They hold no
  password: like every participant, they sign in with a one-time code sent to
  the address they gave.
- Where the address already belongs to a member, they are **joined to this
  circle** instead of getting a second account, and the application fills in only
  what their profile did not already have. Somebody who applies through a
  partner's form having been a member for a year should not have their company
  replaced because they typed it differently this time.
- A Credit Direct address is refused. Staff accounts are created by an
  administrator and sign in with a password; approving one here would make a
  participant profile nobody could ever sign in to.
- **Turn down** creates nothing and deletes nothing. The application keeps its
  answers and carries the decision, so a queue that was worked through can be
  read back.

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
| `src/routes/onboarding.routes.js` | the four unauthenticated endpoints a browser reaches |
| `src/routes/admin/onboarding.routes.js` | authoring, the queue, and the decisions |
| `src/middleware/security.js` | `allowFraming()` — the one carve-out in the frame policy |
| `public/onboarding/form.html` | the runner, standalone and embedded |
| `public/embed/onboarding.js` | the loader a host page includes |
| `public/admin/onboarding*.html` | the list, the builder, the queue |
| `docs/api` (`/admin/api-docs.html`) | every endpoint, with worked examples |
