# Visual Identity Brief — Credit Direct Dev Circle

Act as the design lead at a small studio known for giving every client a visual identity that could not be mistaken for anyone else's. Make deliberate, opinionated choices about palette, typography, and layout specific to this brief — don't default to generic templates. Take one real aesthetic risk you can justify.

## What this product actually is

Dev Circle is the engagement and feedback layer for Credit Direct's developer ecosystem — the human-relationship counterpart to the Developer Hub (where developers actually integrate, generate API keys, and move from sandbox to production). Dev Circle is where those same developers get surveyed, give feedback, log complaints, track their engagement history, and get recognized for participating (gifts, streaks, cohort status). Think of it as developer relations infrastructure for a CBN-licensed Nigerian fintech, not a generic community forum and not a generic admin panel.

**Ground every design decision in this world** — API keys, sandbox vs. production states, KYB completion, cohorts, consent, engagement streaks — rather than defaulting to generic "community platform" visual language (avatars-in-a-grid, badge walls, generic notification bells).

## Two audiences, one identity, different emphasis

**Developer-facing side:** External developers and fintech partners who already trust (or are evaluating whether to trust) Credit Direct with production credentials and KYB data. This needs to read as credible, technical, unfussy — closer to how a developer console or API docs site feels (Stripe, Twilio-adjacent) than how a customer-facing banking app feels. Respect that these are engineers: no infantilizing gamification, no forced cheerfulness. Reward and recognition (gifts claimed, engagement history) should feel earned and precise, not confetti-and-badges.

**Admin/CDL rep-facing side:** Internal operators managing cohorts, sending message blasts, reviewing demography, building segments. This surface handles real data volume, but data volume is not a license to reach for the generic dashboard template (see the dedicated section below) — it needs clarity and scannability, achieved through typographic hierarchy, restraint, and well-organized single-purpose screens, not through packing everything into a KPI-tile-and-chart command center. It should clearly belong to the same visual family as the developer side (shared type system, shared color logic, shared component language), not a bolted-on separate app, and not a different register entirely.

The tension between these two — a lighter-touch developer surface and a task-focused admin surface — is worth designing around rather than smoothing over, but both should feel like calm, well-made web software rather than "developer tool" vs. "enterprise dashboard" as two different genres.

## Ground it in the existing Credit Direct brand system

Dev Circle is not a spin-off brand — it has to be recognizably Credit Direct to the people who already use the consumer app and the merchant/business products, while reading as a developer tool rather than a loan product. Base the palette and voice on the parent brand rather than inventing a fresh identity:

- **Primary — Denim blue `#107EBC`**: the brand's core color. Use it as the dominant identity color, the way it anchors creditdirect.ng.
- **Accent — Harvest Gold `#E6B473`**: warm secondary accent, used for the same "friendly, human" role it plays across Credit Direct's consumer touchpoints — CTAs, highlights, positive/reward states.
- **Accent — Potters Clay `#945A39`**: deeper warm neutral, useful for grounding text or secondary emphasis without reaching for pure black.
- Treat these as the starting palette, not a hard constraint — extend them with the neutrals, states (success/warning/error), and a data/mono-adjacent tone the developer surfaces need, but any extension should read as a natural family member of these three, not an unrelated palette bolted on.

**Voice**: Credit Direct's own copy is direct, warm, and unafraid of Nigerian vernacular ("no OTP wahala," "sharp sharp loans," "no unnecessary back and forth") — plainspoken and confident rather than corporate-stiff. It leans on trust signals (CBN license, "trusted by over 2 million customers") and already has a conversational assistant persona (Clara). Dev Circle's copy — survey prompts, empty states, admin messaging tools — should carry that same directness, translated for a technical audience: no jargon-as-decoration, no forced cheerfulness, but still warm and human rather than sterile enterprise-software tone.

**What this does NOT mean**: don't just reskin the consumer marketing site. The consumer site is optimized to sell loans to a general public; Dev Circle is a working tool for engineers and internal ops staff. Carry the color logic, warmth, and directness forward — not the marketing-site layout patterns (large lifestyle photography, testimonial carousels, app-store badges). If you can't verify a color or type spec against an internal brand asset, note the assumption rather than guessing silently.

## Avoid the "AI dashboard" look

This is the most important constraint in this brief, and it takes precedence over the density language above where the two seem to conflict. Do not default to the generic SaaS dashboard template — it's now so common (and so associated with AI-generated UI specifically) that it undermines the credibility this product needs, on both the developer and admin sides:

- Persistent left sidebar nav + a top row of rounded KPI/stat cards + colorful icon badges + a big data table underneath, repeated on every screen
- Every screen trying to show everything at once — metrics, charts, tables, filters, all competing for attention in the same view
- Gradient-filled stat tiles and generic bar/donut chart widgets dropped in for visual interest rather than because a specific number actually needs a chart to be understood
- Card-grid-of-everything: turning every list (developers, cohorts, surveys, messages) into a grid of shadowed rounded cards with an icon, a title, and three metadata lines, when a plain list or table would be clearer

**Instead, treat this more like a well-designed content site or focused tool than a command center.** Most screens should have one clear job and show what that job needs — not a dashboard trying to summarize the whole system at a glance. Concretely:

- Favor single-column or clearly-prioritized layouts over dense multi-panel grids. Let one thing be the obvious focus of the page.
- Use real typographic hierarchy and whitespace to organize information — the way a well-built content page or reading-focused tool does — rather than boxing every group of data in its own card/container.
- Lists can be lists. A clean, well-typeset table or list view often reads calmer and more credible than a grid of cards. Reach for a card layout only when content genuinely benefits from a visual lead — most of what's here (cohort tables, survey lists, message logs) doesn't.
- Where the admin side does need real data density (a cohort table, a message-blast recipient list), let it be an honest, well-typeset table — not a dashboard-ified version dressed up with icons and colored pills on every cell.
- Charts and numbers belong only where they're the actual answer to a real question someone has, not as ambient decoration to signal "this is a dashboard."
- Success test: someone should describe this as "a clean web app" or "a nice tool" — not "a dashboard."

## Explicitly avoid

- Generic corporate-bank blue-and-white with stock-photo warmth
- Generic SaaS gradient-and-rounded-blob hero sections
- Badge-wall/leaderboard gamification aesthetics
- The current wave of AI-generated design defaults: warm cream + terracotta serif, near-black + single acid accent, or broadsheet hairline-rule newspaper layouts — unless you can justify one of these as the actual right answer for this specific brief, not a fallback
- Straight reskinning of the creditdirect.ng marketing site's layout patterns onto a working tool
- The generic AI-dashboard template described above — sidebar nav + KPI cards + card-grid-of-everything

## What to deliver

Work in two passes, and show your thinking before building:

1. **Design plan** — a compact token system:
   - **Color**: 4–6 named hex values, and the *logic* connecting them to the product (e.g., how sandbox vs. production, or consent states, or cohort identity, get expressed in color)
   - **Type**: 2–3 typefaces across roles — a display face used with restraint, a body face, and a utility/mono face for data, API-adjacent content, or status indicators
   - **Layout**: a layout concept per major surface (developer home/engagement history, admin cohort & messaging workspace, survey/feedback moment), described in a sentence plus a rough ASCII wireframe — consciously designed against the dashboard template, per the section above
   - **Signature**: the one element this product will be remembered by

2. **Self-critique against this brief** — before writing code, check the plan against the "explicitly avoid" list and the two-audience tension above, and revise anything that reads as a generic default rather than a decision made for this product.

Build mobile-responsive by default, not as an afterthought — a meaningful share of developers will check surveys and engagement status from a phone. Respect keyboard focus states and reduced-motion preferences.
