# Jobber sync — setup runbook

Turns a paid online booking into real Jobber records, and lets the booking page
offer dates off the crew's actual Jobber calendar instead of Calendly.

Everything lives in `jobber_sync.gs`, which goes in the **same Apps Script
project** as `apps_script.gs`.

---

## What it does

| When | What happens in Jobber |
|---|---|
| Deposit hits Square | Client (+ Property) → Request → Quote, with the deposit as a pinned note |
| Customer picks a date on `thanks.html` | Job created, visit already on the calendar |
| Someone books the free assessment on Calendly | Request created with the assessment scheduled |
| Booking page loads the date picker | Reads real visits from Jobber to decide which days have room |

Repeat customers are matched by email → phone → street, so they don't get
duplicated.

---

## Setup, in order

**1. Turn on write scopes** (this is the blocker — nothing writes until it's done)

Jobber Developer Center → your app → Scopes. Keep every Read scope you already
have, and add **Write** for: Clients, Properties, Requests, Quotes, Jobs, and
Scheduled Items (that last one covers visits and assessments).

**2. Re-authorize, because scopes only apply to newly issued tokens**

```
cd ~/projects/jobber-dashboard
./venv/bin/python oauth_setup.py
```

Then push the new refresh token into the Apps Script **token service** — it is
the single owner of the refresh chain, and it will keep handing out old
read-only tokens until you do. Nothing else needs new credentials: this script
reads its token from that same service.

**3. Script Properties** (Project Settings → Script properties)

| Key | Value |
|---|---|
| `JOBBER_TOKEN_STORE_URL` | same `/exec` URL the dashboard uses |
| `JOBBER_TOKEN_STORE_SECRET` | same shared secret |
| `CALENDLY_TOKEN` | Calendly personal access token (only for the assessment sync) |

Both Jobber values are already in `~/projects/jobber-dashboard/.env`.

**4. Run these once, from the Apps Script editor**

```
setupJobberColumns()      // adds columns 23–28 to the leads sheet
testJobberConnection()    // confirms the account, scopes, and availability
registerCalendlyWebhook() // only if you want assessments synced too
```

`testJobberConnection()` prints `WRITE SCOPES: MISSING ❌` if step 1 or 2 didn't
take. Nothing else will work until it says enabled.

**5. Redeploy the web app** — Deploy → Manage deployments → pencil → Version
"New version". Do **not** create a fresh deployment; that changes the `/exec`
URL the booking page points at.

---

## Tuning the calendar

All in the `SCHED` block at the top of `jobber_sync.gs`:

```js
crewCount: 3,          // how many crews can be out at once
dayStartHour: 8,       // first start time offered
dayEndHour: 17,        // last end time allowed
jobMinutes: 90,        // how long one online booking blocks
leadTimeDays: 2,       // earliest bookable day
horizonDays: 30,       // how far out to offer
workDays: [1,2,3,4,5,6],  // 0=Sun … 6=Sat
```

**How a slot is judged open:** it counts how many existing visits *overlap* that
slot, and offers it when fewer than `crewCount` do. It deliberately does not add
up each day's booked minutes — the real calendar has visits running to 11pm and
one starting at 2am, and a minutes-based model reads those as a full day when
the crew is actually free.

`crewCount: 3` was measured from the live calendar on 2026-08-03: peak overlap
was 3 crews on 7 days, 4 on one. **If availability ever looks wrong, check this
number first.** Against real data it produced 24 open days in 30 — 6 slots on
quiet days, 1–3 on busy ones.

Availability is cached 5 minutes so the page stays fast.

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
