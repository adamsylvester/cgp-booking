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

## When something breaks

Failures never block payment. The deposit is collected either way, and:

- The **"Jobber sync"** column (col 28) on the leads sheet shows the error.
- You get an email: *"Jobber sync failed — money is fine, Jobber is not."*
- `thanks.html` falls back to Calendly if availability can't be reached, so a
  paying customer is never stranded.

Re-running is safe. Every step checks the sheet for an ID it already wrote, so a
retry can't create a second client, quote, or job.

---

## Assumptions worth revisiting

- **Plans are booked as one-off jobs.** The plan tier is recorded in the title,
  line items and instructions, but nobody has decided how often a plan visit
  actually recurs. Add `recurrence` to `scheduling` in `scheduleBookingInJobber_`
  once that's settled.
- **Address parsing is simple** — first comma segment is the street, and the
  city defaults to Charlottesville when the customer didn't type one.
