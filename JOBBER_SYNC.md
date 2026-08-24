# Jobber sync — setup runbook

Turns a paid online booking into real Jobber records.

**Calendly is the source of truth for scheduling.** This script never decides
what's available — it mirrors whatever slot the customer picked in Calendly onto
the Jobber calendar.

Everything lives in `jobber_sync.gs`, which goes in the **same Apps Script
project** as `apps_script.gs`.

---

## What it does

| When | What happens in Jobber |
|---|---|
| Deposit hits Square | Client (+ Property) → Request → Quote, with the deposit as a pinned note |
| Customer picks their slot in Calendly | Job created, visit scheduled for exactly that time |
| Someone books the free assessment in Calendly | Request created with the assessment scheduled |
| A Calendly booking is cancelled | Email to the office; the Jobber job is left alone so the deposit stays attached |

Repeat customers are matched by email → phone → street, so they don't get
duplicated.

### How a Calendly booking finds its paid row

`thanks.html` prefills the Calendly form with the customer's name and email.
When the webhook fires, the script looks for the **newest sheet row with that
email that is PAID and has no Jobber job yet**:

- **Found** → that's the post-deposit cleaning. Job created for the Calendly slot.
- **Not found** → treated as a free assessment. Request created with the
  assessment scheduled.

So the webhook is not optional. Without it, paid bookings stop at the quote and
never become scheduled jobs.

---

## Setup, in order

**1. Write scopes + re-authorization — DONE 2026-08-03**

Write scopes were enabled in the Jobber Developer Center and the app
re-authorized via `oauth_setup.py`, which also pushed the new refresh token to
the shared token service. Verified: a write mutation now executes instead of
returning "hidden due to permissions".

Only redo this if writes start failing with a permissions error.

**2. Script Properties** (Project Settings → Script properties)

| Key | Value |
|---|---|
| `JOBBER_TOKEN_STORE_URL` | same `/exec` URL the dashboard uses |
| `JOBBER_TOKEN_STORE_SECRET` | same shared secret |
| `CALENDLY_TOKEN` | Calendly personal access token — **required**, this is what creates jobs |

Both Jobber values are already in `~/projects/jobber-dashboard/.env`.

**3. Run these once, from the Apps Script editor**

```
setupJobberColumns()      // adds columns 23–28 to the leads sheet
testJobberConnection()    // confirms the account and write scopes
registerCalendlyWebhook() // REQUIRED — without it, nothing gets scheduled
```

`testJobberConnection()` prints `WRITE SCOPES: MISSING ❌` if the authorization
ever lapses.

**4. Redeploy the web app** — Deploy → Manage deployments → pencil → Version
"New version". Do **not** create a fresh deployment; that changes the `/exec`
URL the booking page points at.

---

## Scheduling config

Calendly decides when. The `SCHED` block only fills gaps Calendly doesn't tell
us:

```js
jobMinutes: 90,           // job length, used ONLY if Calendly sends no end time
arrivalWindowMinutes: 60, // customer-facing "we'll arrive between" cushion
timeZone: 'America/New_York',
```

Change the appointment length in **Calendly**, not here — the visit uses
Calendly's own start and end times.

`JOBBER_ASSIGN_USER_IDS` is empty, so jobs are created **unassigned**. Fill it
with Jobber user IDs once you decide who owns online bookings.

---

## The one thing that stays manual

**Jobber's API cannot record a payment.** There is no payment mutation — not for
deposits, not for anything. So the 25% collected in Square is written as a
pinned note on the quote and the job:

> 💵 DEPOSIT ALREADY PAID — $124 collected through Square when they booked online.
> BALANCE TO COLLECT ON COMPLETION: $373

Whoever invoices the job has to apply that credit by hand. The note is pinned so
it's hard to miss, but nothing can automate it.

---

## ⚠️ The two files share one global scope

Apps Script does not have per-file scope. `apps_script.gs` and `jobber_sync.gs`
are compiled together as if they were one file, so **the same `const` name can
only be declared once across both.**

If a name is declared twice, the whole project stops compiling — not just the
duplicated part. Checkout links, office emails, the payment checker, the
Calendly webhook and the Jobber sync all die at once, while the booking page
keeps taking money through the flat $25 fallback link.

This happened on 2026-08-03: `apps_script.gs`'s contents were pasted into the
`jobber_sync` file, re-declaring `NOTIFICATION_EMAIL`.

**After any paste into the editor, check that it still compiles** by opening the
`/exec` URL in a browser. Healthy looks like:

> CGP booking endpoint is alive.

Anything else — especially a `SyntaxError` page — means the funnel is down.
The `Booking endpoint health` GitHub Action checks this every 30 minutes and
emails on failure.

---

## Approving a paid quote — the API cannot do it

A paid booking's quote should read **Approved**. **Jobber's GraphQL API has no
way to set that**, verified by schema introspection against both API versions
that exist (2025-01-20 and 2025-04-16):

- The only quote mutations are `quoteCreate`, `quoteEdit`, the line-item and
  note ones. None touch status.
- `QuoteEditAttributes` has no status field.
- `transitionQuoteTo` on create accepts exactly one value: `AWAITING_RESPONSE`.
- `approved` is a real value of `QuoteStatusTypeEnum` — it just isn't settable.

So approval must be a human click, by one of two people:

- **The office**, on the quote in Jobber (`jobberWebUri`).
- **The customer**, in their Client Hub — every quote exposes a `clientHubUri`
  where they can approve it themselves. Worth considering for the funnel: send
  the buyer there after payment instead of relying on the office.

Note that *converting a quote to a job* also moves it out of Awaiting response
(to `converted`), but that schedules work — it is not a substitute for
approving, and shouldn't be used as one.

**Daily sweep** — `jobberDailyStuckSweep_` piggybacks on the payment checker
(no extra trigger needed). Once a day it asks Jobber for the real status of
every paid quote older than ~a day and emails the office only those still in
Awaiting response, with both an "Approve in Jobber" link and the customer's
Client Hub link. Anything already approved, converted or archived drops out
silently and is written back to the sheet's "Jobber sync" column, so nobody is
nagged about a quote somebody already handled.

Happened for real with quote #11145 (2026-08-24): customer paid at 2:59pm and
the quote sat in Awaiting response.

---

## When something breaks

Failures never block payment. The deposit is collected either way, and:

- The **"Jobber sync"** column (col 28) on the leads sheet shows the error.
- You get an email: *"Jobber sync failed — money is fine, Jobber is not."*
- The customer's Calendly booking is unaffected either way — Calendly holds the
  appointment whether or not Jobber accepted it, so nobody loses their slot.

Re-running is safe. Every step checks the sheet for an ID it already wrote, so a
retry can't create a second client, quote, or job.

---

## Line items

Online bookings write the **same Products & Services the team uses by hand**, so
they report identically. Each line passes `productOrServiceId`, which links it to
the real record instead of creating a one-off name — the map lives in
`JOBBER_SERVICES` at the top of `jobber_sync.gs`.

| Plan chosen online | Line items written |
|---|---|
| Basic Cleaning | `Single Gutter Cleaning` × 1 @ base |
| Basic + Seasonal Touch-Ups | `Single Gutter Cleaning` × 1 @ base, plus `Touch Ups Until October 31, 2026.` × 1 @ 50% of base |
| Gutter Protection Plan | `Complete Gutter Protection Plan` × 4 @ base, plus `Free Cleaning Applied` × −1 @ base (nets to 3× base) |
| Outside the service area | `Trip Fee` × 1 @ $50 |

Two guardrails:

- **The customer's total always wins.** The lines are summed (quantity ×
  unit price) and compared to what Square actually charged. If they disagree by
  more than 50¢, the whole set is discarded and one plain line at the real total
  is written instead. A mapping bug can never change the amount owed.
- **Lines are written non-taxable** (`JOBBER_LINE_TAXABLE`), even though every
  saved service is flagged taxable, because the online prices are what Square
  already collected. Flipping it would add tax on top and break that match.

If a service is renamed or archived in Jobber, its ID keeps working; only update
the `name` in `JOBBER_SERVICES` so the quote reads correctly.

---

## Assumptions worth revisiting

- **Plans are booked as one-off jobs.** The plan tier is recorded in the title,
  line items and instructions, but nobody has decided how often a plan visit
  actually recurs. Add `recurrence` to `scheduling` in `scheduleBookingInJobber_`
  once that's settled.
- **Address parsing is simple** — first comma segment is the street, and the
  city defaults to Charlottesville when the customer didn't type one.
