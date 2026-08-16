Overview
This tracker specifies the requirement for the dev circle management platform. This platform reuses the following:

Existing  landing page for registration

Existing consent form

Existing engagement platforms such as customer.io, appsflyer, netcore, mixpanel used in messaging and communicating with users.

Existing Credit Direct feex/support platform which is used as support in dev. hub. The complaints or response from here goes to the dev circle.

Engagement Session Types
Surveys

User complaints on Feex

User self-initiated feedbacks in dev circle

System-triggered surveys on action completion in dev portal

Users
Fill registration form from the existing landing page.

Be able to sign into the dev circle after registration on the landing page.

Receive communications (in-portal, e-mail, whatsapp, SMS notification) for upcoming scheduled upcoming info/Test.

Open a notification and land on the thing it is about, rather than a list to go searching through.

Be able to initiate feedback within the dev circle aside from the regular scheduled engagement.

Give and withdraw consent.

See engagement history with CDL, # surveys done, # gifts claimed, etc.

Select preferred general/global available days/schedules for engagement.

Select preferred engagement channel(s) (e-mail, in-portal, whatsapp, calls, sms, 1-on-1).

Update profile.

Cannot see other people except admin/CDL Rep.

Admin
See all members

See at a glance, an informational dashboard which covers demography, age, products, engagement histories, etc. 

Be able to create other Circles beside the dev circle, each one a workspace of its own with its own members, cohorts, surveys and feedback. Nothing crosses between them. The dev circle is one circle among them, not the parent of the rest.

Switch between the circles an account can reach, and see at all times which one is being worked in. A developer can belong to more than one. Staff hold a role per circle, so the same person can run one circle and have no access to another.

Grouping people within a circle is what cohorts are for. A circle is where the work happens; a cohort is a slice of the people in it.

Send message blast to:

All users

All Cohort

Specific user (s)

Specific cohort (s)

Create cohort based on:

Engagement histories

Available days

Work Sector

Integration Product types

Sandbox/Production users

Custom

Export users/cohort details for external processing depending on properties. (Should be able to filter by properties, cohorts, etc.)

See engagement history

Send engagement communications and reminders to users/cohort

Select engagement modes in invite for surveys (1 on-1, email, whatsapp)

Bulk add/import users from existing excel worksheet

Download a template wherever there is an import, so the sheet going in is already the shape the system expects.

Manage members (deactivate,  reset password, etc)

See eligible cohorts of users according to their cohorts for surveys.

Write the questions for each survey freely. A discovery initiative sets its own questions, so they can never be fixed in advance, and one survey carries as many questions as it needs.

Where a question has been asked before, be offered the existing one so the answers line up across surveys. Offered, never imposed.

See at a glance, the feedback table by developer, question, survey, source, system, company, work sector, API status, location, month, status or cohort. A question is counted across every survey that asked it, so one question asked in three surveys reads as one line rather than three.

Switch that feedback between the reading view and a table view, keeping whichever grouping is in force. Researchers and analysts work in spreadsheets.

See the entire engagement of a single developer at once — every survey answered, every complaint from feex, every self-initiated feedback and every verbatim, whichever source it arrived from and whichever survey asked it.

Export the feedback on the same terms the table is read by, so what leaves the system is what was on the screen.

System
Be able to accept user details from the existing landing page to the dev circle.

Be able to create user profile using the registration details submitted on the landing page.

Be able to link user account in developer hub to user account in dev circle via SSO. Authenticated users on dev portal is automatically authenticated on dev circle as far as the token is valid.

Maintain consistent records of feedback obtained per user, per engagement session.

Be able to integrate to credit direct’s support/feex platform to be able to get user complaint, feedback and visibility as an engagement type to be attached to the user_Id for ticket.

Be able to connect to dev portal or other analytics bridge between sitting between the dev circle and dev-portal for triggering in-portal, action-based surveys or get the engagement details from connected platform for tracking members' engagement history:

Events:

Signup successful

Generate API keys

First successful API call - Sandbox.

First successful API call - Production.

KYB Completed

Request for more API products

These are tracked by customer.io. Customer.io also sends engagement to the participants. The actual survey response is the primary information expected to be received by dev circle for analysis.

Customer.io sends the engagement details to dev circle for tracking.

Reason:

Get signal that action has happened so as to update user engagement table to show engagement activities.

Avoid manually going to the dev circle to be updating tracking status.

Have permissions created to determine what can be done. Admin can create custom roles and assign permissions to those roles.

Handle feedback tied to a single user account from multiple sources (customerio, feex,  surveys, etc) and map them properly by source to that user.

Be able to take in surveys run outside the dev circle — customer.io, google forms, microsoft forms — with their verbatim responses, and map each response to the developer that gave it. A survey deployed elsewhere still lands here.

Interfaces
Interface with existing landing page

API for sign-in

Interface with customer.io

API for data ingestion

Interface with developer hub

Api for auth - into the dev circle.

Interface with feex

API for data ingestion