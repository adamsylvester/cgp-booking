// ============================================================================
// JOBBER SYNC — turns a paid online booking into real Jobber records.
//
// Paste this into the SAME Apps Script project as apps_script.gs (File > New >
// Script, name it "jobber_sync"). It shares that file's PRICING, COL, STATUS
// and sheet helpers.
//
// CALENDLY IS THE SOURCE OF TRUTH FOR SCHEDULING. This script never decides
// what's available — it mirrors whatever slot the customer picked in Calendly
// onto the Jobber calendar.
//
// Two stages, in the order the money moves:
//
//   1. pushBookingToJobber_(lead, row)   fires the moment the deposit lands.
//      Creates: Client (+ Property) -> Request -> Quote (deposit recorded as a
//      note, since Jobber's API cannot post a payment).
//
//   2. Calendly webhook   fires when they pick their slot. Creates the Job with
//      the visit scheduled for exactly that time.
//
// SETUP — Script Properties (Project Settings > Script properties):
//   JOBBER_TOKEN_STORE_URL     same /exec URL the dashboard uses
//   JOBBER_TOKEN_STORE_SECRET  same shared secret
// Both values are already in ~/projects/jobber-dashboard/.env.
//
// The Jobber app ALSO needs write scopes (Developer Center > your app >
// Scopes). Read-only will fail with "hidden due to permissions".
// ============================================================================

const JOBBER_GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';
const JOBBER_API_VERSION = '2025-01-20';

// ===== Scheduling config =====
// Calendly decides WHEN. These only fill gaps Calendly doesn't tell us.
const SCHED = {
  jobMinutes: 90,           // job length, used only if Calendly sends no end time
  arrivalWindowMinutes: 60, // customer-facing "we'll arrive between" cushion
  timeZone: 'America/New_York',
};

// Jobber user IDs to auto-assign new online-booking jobs to.
// Leave EMPTY to create the job unassigned (safest). Fill it once you decide
// who owns online bookings: ['Z2lkOi8vSm9iYmVyL1VzZXIvMTIzNDU='].
const JOBBER_ASSIGN_USER_IDS = [];

// ===== Extra sheet columns (added by setupJobberColumns) =====
const JCOL = {
  CLIENT: 23, REQUEST: 24, QUOTE: 25, JOB: 26, VISIT_AT: 27, SYNC: 28,
};
const JOBBER_LAST_COL = 28;

// ===========================================================================
// TOKEN + TRANSPORT
// ===========================================================================

// Everything Jobber-related stays asleep until both Script Properties exist,
// so pasting this file in before you've set them up can't break checkout or
// spam you with failure emails.
function jobberSyncEnabled_() {
  var props = PropertiesService.getScriptProperties();
  return !!(props.getProperty('JOBBER_TOKEN_STORE_URL') &&
            props.getProperty('JOBBER_TOKEN_STORE_SECRET'));
}

// The token service (a separate Apps Script web app) is the single owner of
// the refresh-token chain — we only ever ask it for the current access token.
// Cached for 30 minutes so a busy minute-trigger doesn't hammer it.
function jobberToken_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('jobber_access_token');
  if (hit) return hit;

  var url = PropertiesService.getScriptProperties().getProperty('JOBBER_TOKEN_STORE_URL');
  var secret = PropertiesService.getScriptProperties().getProperty('JOBBER_TOKEN_STORE_SECRET');
  if (!url || !secret) {
    throw new Error('Set JOBBER_TOKEN_STORE_URL and JOBBER_TOKEN_STORE_SECRET in Script Properties.');
  }

  var resp = UrlFetchApp.fetch(url + '?secret=' + encodeURIComponent(secret), { muteHttpExceptions: true });
  var body = JSON.parse(resp.getContentText());
  if (!body.ok) throw new Error('Token service error: ' + (body.error || resp.getContentText()));
  var access = (body.tokens || {}).access_token;
  if (!access) throw new Error('Token service returned no access_token.');

  cache.put('jobber_access_token', access, 1800);
  return access;
}

// One GraphQL call. Retries once on a throttle, and once on an expired token.
function jobberGql_(query, variables) {
  for (var attempt = 0; attempt < 3; attempt++) {
    var resp = UrlFetchApp.fetch(JOBBER_GRAPHQL_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + jobberToken_(),
        'X-JOBBER-GRAPHQL-VERSION': JOBBER_API_VERSION,
      },
      payload: JSON.stringify({ query: query, variables: variables || {} }),
      muteHttpExceptions: true,
    });

    var code = resp.getResponseCode();
    var body = JSON.parse(resp.getContentText() || '{}');

    // 401 = the cached access token went stale. Drop it and let the next loop
    // fetch a fresh one from the token service.
    if (code === 401) {
      CacheService.getScriptCache().remove('jobber_access_token');
      continue;
    }

    if (body.errors) {
      var msg = JSON.stringify(body.errors);
      if (msg.indexOf('THROTTLED') !== -1) {
        Utilities.sleep(2000 * (attempt + 1));
        continue;
      }
      if (msg.indexOf('hidden due to permissions') !== -1) {
        throw new Error('Jobber write scopes are not enabled on the app yet — ' +
                        'add them in the Developer Center and re-authorize. (' + msg + ')');
      }
      throw new Error('Jobber GraphQL error: ' + msg);
    }
    return body.data;
  }
  throw new Error('Jobber call failed after retries.');
}

// Mutations return userErrors instead of throwing. Surface them loudly.
function jobberCheckErrors_(payload, label) {
  var errs = (payload && payload.userErrors) || [];
  if (errs.length) {
    throw new Error(label + ' failed: ' + errs.map(function (e) {
      return (e.path ? e.path.join('.') + ': ' : '') + e.message;
    }).join('; '));
  }
  return payload;
}

// ===========================================================================
// STAGE 1 — paid deposit becomes Client + Request + Quote
// ===========================================================================

// Called from checkPendingPayments the instant a row flips to PAID.
// Safe to re-run: every step checks the sheet for an ID it already wrote.
function pushBookingToJobber_(lead, sheetRow, receiptUrl) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];

  // One run at a time — the payment checker fires every minute and we never
  // want two runs racing to create the same client.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;

  try {
    var ids = {
      clientId: String(sheet.getRange(sheetRow, JCOL.CLIENT).getValue() || ''),
      requestId: String(sheet.getRange(sheetRow, JCOL.REQUEST).getValue() || ''),
      quoteId: String(sheet.getRange(sheetRow, JCOL.QUOTE).getValue() || ''),
    };

    if (!ids.clientId) {
      var made = jobberEnsureClient_(lead);
      ids.clientId = made.clientId;
      ids.propertyId = made.propertyId;
      sheet.getRange(sheetRow, JCOL.CLIENT).setValue(ids.clientId + '|' + made.propertyId);
    }

    var parts = ids.clientId.split('|');
    var clientId = parts[0];
    var propertyId = parts[1] || ids.propertyId;

    if (!ids.requestId) {
      ids.requestId = jobberCreateRequest_(clientId, propertyId, lead);
      sheet.getRange(sheetRow, JCOL.REQUEST).setValue(ids.requestId);
    }

    if (!ids.quoteId) {
      ids.quoteId = jobberCreateQuote_(clientId, propertyId, ids.requestId, lead, receiptUrl);
      sheet.getRange(sheetRow, JCOL.QUOTE).setValue(ids.quoteId);
    }

    sheet.getRange(sheetRow, JCOL.SYNC).setValue('✅ In Jobber — awaiting date');
  } catch (err) {
    // Never let a Jobber problem break the payment pipeline. The row keeps its
    // PAID status and the error is visible in the sheet.
    sheet.getRange(sheetRow, JCOL.SYNC).setValue('⚠️ ' + String(err).slice(0, 400));
    jobberNotifyFailure_(lead, err, 'creating the client/request/quote');
  } finally {
    lock.releaseLock();
  }
}

// Finds an existing client by email (then phone) so repeat customers don't get
// duplicated. Returns {clientId, propertyId}.
function jobberEnsureClient_(lead) {
  var email = String(lead.email || '').trim();
  var phone = String(lead.phone || '').trim();

  var found = null;
  if (email) found = jobberFindClient_(email, 'PRIMARY_EMAIL');
  if (!found && email) found = jobberFindClient_(email, 'EMAILS');
  if (!found && phone) found = jobberFindClient_(phone, 'PHONES');

  if (found) {
    return {
      clientId: found.id,
      propertyId: jobberEnsureProperty_(found, lead),
    };
  }

  // New client — the property rides along in the same mutation.
  var names = jobberSplitName_(lead.name);
  var data = jobberGql_(
    'mutation($input: ClientCreateInput!) {' +
    '  clientCreate(input: $input) {' +
    '    client { id clientProperties(first: 5) { nodes { id address { street } } } }' +
    '    userErrors { message path }' +
    '  }' +
    '}',
    {
      input: {
        firstName: names.first,
        lastName: names.last,
        emails: email ? [{ description: 'MAIN', address: email, primary: true }] : [],
        phones: phone ? [{ description: 'MOBILE', number: phone, primary: true, smsAllowed: true }] : [],
        properties: [{ address: jobberAddress_(lead) }],
        sourceAttribution: { sourceText: 'Online booking (book.cvillegutterpros.com)' },
        receivesReminders: true,
        receivesReviewRequests: true,
      },
    }
  );

  var payload = jobberCheckErrors_(data.clientCreate, 'clientCreate');
  var client = payload.client;
  var props = (client.clientProperties && client.clientProperties.nodes) || [];
  if (!props.length) throw new Error('Client created but no property came back.');

  return { clientId: client.id, propertyId: props[0].id };
}

function jobberFindClient_(term, field) {
  var data = jobberGql_(
    'query($term: String!, $fields: [ClientSearchField!]) {' +
    '  clients(first: 5, searchTerm: $term, searchFields: $fields, filter: { isArchived: false }) {' +
    '    nodes {' +
    '      id firstName lastName' +
    '      clientProperties(first: 20) { nodes { id address { street } } }' +
    '    }' +
    '  }' +
    '}',
    { term: term, fields: [field] }
  );
  var nodes = (data.clients && data.clients.nodes) || [];
  return nodes.length ? nodes[0] : null;
}

// Reuses a matching property on an existing client, or adds the new address.
function jobberEnsureProperty_(client, lead) {
  // Compare just the street line ("123 Main St"), since Jobber's `street` and
  // the customer's typed address agree on that but not on city/state/ZIP.
  var wanted = jobberNormalizeStreet_(String(lead.address || '').split(',')[0]);
  var nodes = (client.clientProperties && client.clientProperties.nodes) || [];

  for (var i = 0; i < nodes.length; i++) {
    var street = jobberNormalizeStreet_((nodes[i].address && nodes[i].address.street) || '');
    if (!wanted || !street) continue;
    // Either may be the longer string, so accept a match in either direction.
    if (street.indexOf(wanted) === 0 || wanted.indexOf(street) === 0) return nodes[i].id;
  }

  var data = jobberGql_(
    'mutation($clientId: EncodedId!, $input: PropertyCreateInput!) {' +
    '  propertyCreate(clientId: $clientId, input: $input) {' +
    '    properties { id }' +
    '    userErrors { message path }' +
    '  }' +
    '}',
    { clientId: client.id, input: { properties: [{ address: jobberAddress_(lead) }] } }
  );

  var payload = jobberCheckErrors_(data.propertyCreate, 'propertyCreate');
  var made = payload.properties || [];
  if (!made.length) throw new Error('propertyCreate returned no property.');
  return made[0].id;
}

// The Request is what keeps funnel math honest — one request per lead, so
// conversion stays per-request rather than per-quote.
function jobberCreateRequest_(clientId, propertyId, lead) {
  var data = jobberGql_(
    'mutation($input: RequestCreateInput!) {' +
    '  requestCreate(input: $input) { request { id } userErrors { message path } }' +
    '}',
    {
      input: {
        clientId: clientId,
        propertyId: propertyId,
        title: jobberJobTitle_(lead),
      },
    }
  );

  var requestId = jobberCheckErrors_(data.requestCreate, 'requestCreate').request.id;

  // requestDetails only accepts a job form, so what the customer told us goes
  // on as a note instead. A failure here must not lose the request itself.
  try {
    jobberGql_(
      'mutation($requestId: EncodedId!, $input: RequestCreateNoteInput!) {' +
      '  requestCreateNote(requestId: $requestId, input: $input) { userErrors { message } }' +
      '}',
      { requestId: requestId, input: { message: jobberDetailsNote_(lead), pinned: true } }
    );
  } catch (err) {
    Logger.log('Request note failed (request still created): ' + err);
  }

  return requestId;
}

function jobberCreateQuote_(clientId, propertyId, requestId, lead, receiptUrl) {
  var deposit = Number(lead.deposit || 0);

  var data = jobberGql_(
    'mutation($attributes: QuoteCreateAttributes!) {' +
    '  quoteCreate(attributes: $attributes) { quote { id quoteNumber } userErrors { message path } }' +
    '}',
    {
      attributes: {
        clientId: clientId,
        propertyId: propertyId,
        requestId: requestId,
        title: jobberJobTitle_(lead),
        lineItems: jobberLineItems_(lead),
        // Records the deposit AMOUNT that was owed. Jobber's API has no way to
        // mark it collected — that's what the note below is for.
        deposit: deposit > 0 ? { rate: deposit, type: 'Unit' } : null,
        transitionQuoteTo: 'AWAITING_RESPONSE',
        notes: [{ message: jobberDepositNote_(lead, receiptUrl) }],
      },
    }
  );
  return jobberCheckErrors_(data.quoteCreate, 'quoteCreate').quote.id;
}

// ===========================================================================
// STAGE 2 — the customer picks a date, so the Job goes on the calendar
// ===========================================================================

// startISO/endISO come straight from the Calendly slot the customer picked,
// e.g. "2026-08-14T13:00:00.000000Z". Calendly is the source of truth for
// timing — we just mirror it onto the Jobber calendar.
function scheduleBookingInJobber_(sheetRow, startISO, endISO, receiptUrl) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('Busy — try again in a moment.');

  try {
    var existingJob = String(sheet.getRange(sheetRow, JCOL.JOB).getValue() || '');
    if (existingJob) return existingJob;   // already scheduled; never double-book

    var clientCell = String(sheet.getRange(sheetRow, JCOL.CLIENT).getValue() || '');
    if (!clientCell) throw new Error('This booking has no Jobber client yet.');
    var propertyId = clientCell.split('|')[1];
    var requestId = String(sheet.getRange(sheetRow, JCOL.REQUEST).getValue() || '');
    var quoteId = String(sheet.getRange(sheetRow, JCOL.QUOTE).getValue() || '');

    var vals = sheet.getRange(sheetRow, 1, 1, LAST_COL).getValues()[0];
    var lead = rowToLead(vals);

    var start = new Date(startISO);
    if (isNaN(start)) throw new Error('Bad start time: ' + startISO);
    // Trust Calendly's end time; fall back to the default job length only if
    // it's missing or nonsensical.
    var end = endISO ? new Date(endISO) : null;
    if (!end || isNaN(end) || end <= start) {
      end = new Date(start.getTime() + SCHED.jobMinutes * 60000);
    }
    var tz = SCHED.timeZone;

    var attributes = {
      propertyId: propertyId,
      requestId: requestId || null,
      quoteId: quoteId || null,
      title: jobberJobTitle_(lead),
      instructions: jobberDetailsNote_(lead),
      lineItems: jobberLineItems_(lead).map(function (li) {
        return {
          name: li.name, description: li.description, quantity: li.quantity,
          unitPrice: li.unitPrice, taxable: li.taxable,
          saveToProductsAndServices: false,
        };
      }),
      scheduling: {
        createVisits: true,
        notifyTeam: true,
        startTime: Utilities.formatDate(start, tz, "HH:mm:ss"),
        endTime: Utilities.formatDate(end, tz, "HH:mm:ss"),
        assignedTo: JOBBER_ASSIGN_USER_IDS.length ? JOBBER_ASSIGN_USER_IDS : null,
        visitConfirmationStatus: true,
      },
      timeframe: {
        startAt: Utilities.formatDate(start, tz, 'yyyy-MM-dd'),
        durationUnits: 'DAYS',
        durationValue: 1,
      },
      // ASSUMPTION: every online booking is a ONE-OFF job, including the plan
      // tiers — the plan is captured in the title, line items and instructions,
      // but nobody has decided how often a plan visit actually recurs. To make
      // plans recurring, add `recurrence` (an iCal rule) to `scheduling` below.
      invoicing: { invoicingType: 'FIXED_PRICE', invoicingSchedule: 'ON_COMPLETION' },
      arrivalWindow: { durationInMinutes: SCHED.arrivalWindowMinutes },
      allowReviewRequest: true,
      notes: [{ message: jobberDepositNote_(lead, receiptUrl), pinned: true }],
    };

    var data = jobberGql_(
      'mutation($input: JobCreateAttributes!) {' +
      '  jobCreate(input: $input) { job { id jobNumber } userErrors { message path } }' +
      '}',
      { input: attributes }
    );

    var job = jobberCheckErrors_(data.jobCreate, 'jobCreate').job;
    sheet.getRange(sheetRow, JCOL.JOB).setValue(job.id);
    sheet.getRange(sheetRow, JCOL.VISIT_AT).setValue(start);
    sheet.getRange(sheetRow, JCOL.SYNC).setValue('✅ Scheduled — job #' + job.jobNumber);
    return job.id;
  } catch (err) {
    sheet.getRange(sheetRow, JCOL.SYNC).setValue('⚠️ schedule: ' + String(err).slice(0, 400));
    throw err;
  } finally {
    lock.releaseLock();
  }
}

// ===========================================================================
// SHARED HELPERS
// ===========================================================================

function jobberSplitName_(full) {
  var parts = String(full || '').trim().split(/\s+/);
  if (parts.length < 2) return { first: parts[0] || 'Online', last: 'Booking' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

// "123 Main St, Charlottesville, VA" + the ZIP the customer typed.
function jobberAddress_(lead) {
  var raw = String(lead.address || '').trim();
  var bits = raw.split(',').map(function (s) { return s.trim(); }).filter(String);
  return {
    street1: bits[0] || raw || 'Address not provided',
    city: bits.length > 1 ? bits[1] : 'Charlottesville',
    province: 'Virginia',
    postalCode: String(lead.zip || '').replace(/\D/g, ''),
    country: 'United States',
  };
}

function jobberNormalizeStreet_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Which plan tier this row is, worked back from the friendly label the sheet
// stores ("Basic + Seasonal Touch-Ups", "Gutter Protection Plan", ...).
function jobberPlanCode_(planLabel) {
  var s = String(planLabel || '').toLowerCase();
  if (s.indexOf('protection') !== -1) return 'protection';
  if (s.indexOf('touch') !== -1 || s.indexOf('seasonal') !== -1) return 'simple';
  return 'basic';
}

function jobberJobTitle_(lead) {
  return 'Gutter Cleaning — ' + (lead.plan || 'Basic') + ' (online booking)';
}

// Rebuilds the quote as real line items so Jobber shows the same math the
// customer saw. Falls back to a single line if the parts don't sum to the
// stored total (a hand-edited row, say) — the customer's total always wins.
function jobberLineItems_(lead) {
  var base = Number(lead.base || 0);
  var total = Number(lead.total || 0);
  var fee = lead.outside ? OUTSIDE_AREA_FEE : 0;
  var upgrade = total - fee - base;
  var code = jobberPlanCode_(lead.plan);

  var items = [];
  if (base > 0) {
    items.push({
      name: 'Gutter Cleaning — ' + (lead.house || 'Home'),
      description: jobberSizeNote_(lead),
      quantity: 1, unitPrice: base, taxable: false,
      saveToProductsAndServices: false, category: 'SERVICE',
    });
  }
  if (upgrade > 0) {
    items.push({
      name: code === 'protection' ? 'Gutter Protection Plan' : 'Seasonal Touch-Ups',
      description: code === 'protection'
        ? 'Full-season protection plan as chosen online.'
        : 'Seasonal touch-up visits as chosen online.',
      quantity: 1, unitPrice: upgrade, taxable: false,
      saveToProductsAndServices: false, category: 'SERVICE',
    });
  }
  if (fee > 0) {
    items.push({
      name: 'Travel fee', description: 'Outside the Charlottesville/Albemarle service area.',
      quantity: 1, unitPrice: fee, taxable: false,
      saveToProductsAndServices: false, category: 'SERVICE',
    });
  }

  var sum = items.reduce(function (a, li) { return a + li.unitPrice; }, 0);
  if (!items.length || Math.abs(sum - total) > 0.5) {
    return [{
      name: jobberJobTitle_(lead),
      description: jobberDetailsNote_(lead),
      quantity: 1, unitPrice: total, taxable: false,
      saveToProductsAndServices: false, category: 'SERVICE',
    }];
  }
  return items;
}

function jobberSizeNote_(lead) {
  var bits = [];
  if (lead.sqft) bits.push(Number(lead.sqft).toLocaleString() + ' sq ft');
  if (lead.stories) bits.push(lead.stories + '-story');
  return bits.join(' · ');
}

function jobberDetailsNote_(lead) {
  var lines = [];
  lines.push('Booked online at book.cvillegutterpros.com.');
  lines.push('Home: ' + (lead.house || '—') + (jobberSizeNote_(lead) ? ' (' + jobberSizeNote_(lead) + ')' : ''));
  lines.push('Plan: ' + (lead.plan || '—'));
  if (lead.outside) lines.push('Outside service area — $' + OUTSIDE_AREA_FEE + ' travel fee included.');
  var notes = String(lead.notes || '').trim();
  if (notes) lines.push('Customer notes: ' + notes);
  return lines.join('\n');
}

// Jobber's API cannot record a payment, so the deposit lives as a note that
// whoever invoices this job cannot miss.
function jobberDepositNote_(lead, receiptUrl) {
  var deposit = Number(lead.deposit || 0);
  var total = Number(lead.total || 0);
  var balance = Math.max(0, total - deposit);
  var lines = [
    '💵 DEPOSIT ALREADY PAID — $' + deposit + ' collected through Square when they booked online.',
    'Quoted total: $' + total,
    'BALANCE TO COLLECT ON COMPLETION: $' + balance,
    '',
    'Apply the $' + deposit + ' as a payment on the invoice by hand — it is in Square, not in Jobber.',
  ];
  if (receiptUrl) lines.push('Square receipt: ' + receiptUrl);
  return lines.join('\n');
}

function jobberNotifyFailure_(lead, err, doingWhat) {
  try {
    MailApp.sendEmail({
      to: NOTIFICATION_EMAIL,
      subject: '⚠️ Jobber sync failed: ' + (lead.name || 'booking') + ' — money is fine, Jobber is not',
      htmlBody: emailShell(
        statusBanner('#dc2626', '⚠️ The deposit was collected, but Jobber did not get the booking.') +
        '<p style="margin:0 0 12px;line-height:1.5;">Failed while ' + escapeHtml(doingWhat) + '. ' +
        'Enter this one in Jobber by hand, then look at the error below.</p>' +
        '<table style="border-collapse:collapse;width:100%;">' +
        contactRows(lead.name, lead.phone, lead.email, lead.address) + '</table>' +
        '<p style="margin-top:14px;font-size:12px;color:#b42318;white-space:pre-wrap;">' +
        escapeHtml(String(err)) + '</p>'
      ),
      from: FROM_ADDRESS,
      name: FROM_NAME,
    });
  } catch (e) { /* email must never mask the original failure */ }
}

// ===========================================================================
// CALENDLY -> JOBBER (the free on-site assessment path)
// ===========================================================================
// The booking page's "book an assessment" tile is a Calendly embed. Calendly
// posts here when someone books, and we turn it into a Jobber Request with the
// assessment already on the calendar.
//
// SETUP: put a Calendly personal access token in Script Properties as
// CALENDLY_TOKEN, then run registerCalendlyWebhook() once.

// Calendly hits the web app with ?cal=<CALENDLY_WEBHOOK_SECRET> so a stranger
// who guesses the /exec URL can't inject fake assessments.
function handleCalendlyWebhook_(body, queryParams) {
  var expected = PropertiesService.getScriptProperties().getProperty('CALENDLY_WEBHOOK_SECRET');
  if (expected && (queryParams || {}).cal !== expected) {
    return { ok: false, error: 'bad_secret' };
  }
  if (!jobberSyncEnabled_()) return { ok: false, error: 'jobber_not_configured' };

  var p = body.payload || {};
  var ev = p.scheduled_event || {};
  var email = String(p.email || '').trim();

  if (body.event === 'invitee.canceled') {
    return calendlyHandleCancellation_(email, ev);
  }
  if (body.event !== 'invitee.created') return { ok: true, skipped: body.event };

  // A paid booking that's waiting on a date is the common case: the customer
  // paid the deposit, then landed on Calendly. Schedule THAT job for the slot
  // they just chose. Anything else is a free assessment.
  var row = calendlyFindPaidUnscheduledRow_(email);
  if (row) return calendlyScheduleePaidBooking_(row, ev, email);

  return calendlyCreateAssessment_(p, ev);
}

// The Jobber job goes on the calendar for exactly the Calendly slot.
function calendlyScheduleePaidBooking_(row, ev, email) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var receiptUrl = String(sheet.getRange(row, COL.PAYMENT_LINK).getValue() || '');
  var lead = rowToLead(sheet.getRange(row, 1, 1, LAST_COL).getValues()[0]);

  try {
    // The deposit usually lands first, but if the customer beat the payment
    // checker here, create the client/request/quote now.
    if (!String(sheet.getRange(row, JCOL.CLIENT).getValue() || '')) {
      pushBookingToJobber_(lead, row, receiptUrl);
    }
    var jobId = scheduleBookingInJobber_(row, ev.start_time, ev.end_time, receiptUrl);
    return { ok: true, jobId: jobId, scheduled: ev.start_time };
  } catch (err) {
    jobberNotifyFailure_(lead, err, 'putting the Calendly slot on the Jobber calendar');
    return { ok: false, error: String(err) };
  }
}

// Newest row for this email that is PAID and has no Jobber job yet.
function calendlyFindPaidUnscheduledRow_(email) {
  if (!email) return 0;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  var firstRow = Math.max(2, lastRow - 299);
  var vals = sheet.getRange(firstRow, 1, lastRow - firstRow + 1, JOBBER_LAST_COL).getValues();
  var want = email.toLowerCase();

  for (var i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][COL.EMAIL - 1] || '').trim().toLowerCase() !== want) continue;
    if (String(vals[i][COL.STATUS - 1]) !== STATUS.PAID) continue;
    if (String(vals[i][JCOL.JOB - 1] || '')) continue;   // already scheduled
    return firstRow + i;
  }
  return 0;
}

// A free on-site assessment: a Request with the assessment scheduled.
function calendlyCreateAssessment_(p, ev) {
  var answers = p.questions_and_answers || [];
  var lead = {
    name: p.name || '',
    email: p.email || '',
    phone: p.text_reminder_number || calendlyAnswer_(answers, ['phone', 'number']) || '',
    address: calendlyAnswer_(answers, ['address', 'street', 'property']) || '',
    zip: (String(calendlyAnswer_(answers, ['address', 'zip', 'postal']) || '').match(/\b\d{5}\b/) || [''])[0],
    notes: calendlyAnswer_(answers, ['anything', 'note', 'detail', 'tell us']) || '',
    plan: 'On-site assessment',
    house: '', sqft: '', stories: '', outside: false, base: 0, total: 0, deposit: 0,
  };

  try {
    var made = jobberEnsureClient_(lead);
    var requestId = jobberCreateAssessmentRequest_(made.clientId, made.propertyId, lead, ev);
    calendlyLogRow_(lead, ev, requestId, '✅ Request created in Jobber');
    return { ok: true, requestId: requestId };
  } catch (err) {
    calendlyLogRow_(lead, ev, '', '⚠️ ' + String(err).slice(0, 300));
    jobberNotifyFailure_(lead, err, 'creating the assessment request from Calendly');
    return { ok: false, error: String(err) };
  }
}

// Cancellations can't be undone automatically — Jobber keeps the job so the
// deposit stays attached to something. The office gets told to reschedule.
function calendlyHandleCancellation_(email, ev) {
  // NB: not named `row` — that's the shared email-table helper in apps_script.gs.
  var sheetRow = email ? jobberFindRow_('', email) : 0;
  var jobId = sheetRow ? String(SpreadsheetApp.getActiveSpreadsheet().getSheets()[0]
                            .getRange(sheetRow, JCOL.JOB).getValue() || '') : '';
  try {
    MailApp.sendEmail({
      to: NOTIFICATION_EMAIL,
      subject: '📅 Calendly cancellation — reschedule in Jobber' + (email ? ': ' + email : ''),
      htmlBody: emailShell(
        statusBanner('#f59e0b', '📅 A booked slot was cancelled in Calendly.') +
        '<p style="margin:0 0 12px;line-height:1.5;">Their Jobber job was <strong>not</strong> ' +
        'changed — the deposit is still attached to it. Move or cancel it by hand once they rebook.</p>' +
        '<table style="border-collapse:collapse;width:100%;">' +
        row('Email', escapeHtml(email || '—')) +
        row('Was scheduled for', escapeHtml(String(ev.start_time || '—'))) +
        row('Jobber job', jobId ? escapeHtml(jobId) : 'none found') +
        '</table>'
      ),
      from: FROM_ADDRESS,
      name: FROM_NAME,
    });
  } catch (e) { /* never let the notification break the webhook */ }
  return { ok: true, cancelled: true };
}

// A Request whose assessment is scheduled for the Calendly slot.
function jobberCreateAssessmentRequest_(clientId, propertyId, lead, ev) {
  var tz = SCHED.timeZone;
  var start = new Date(ev.start_time);
  var end = ev.end_time ? new Date(ev.end_time) : new Date(start.getTime() + 30 * 60000);

  var data = jobberGql_(
    'mutation($input: RequestCreateInput!) {' +
    '  requestCreate(input: $input) { request { id } userErrors { message path } }' +
    '}',
    {
      input: {
        clientId: clientId,
        propertyId: propertyId,
        title: (ev.name || 'Gutter assessment') + ' (booked online)',
        assessment: {
          instructions: calendlyInstructions_(lead, ev),
          schedule: {
            notifyTeam: true,
            startAt: {
              date: Utilities.formatDate(start, tz, 'yyyy-MM-dd'),
              time: Utilities.formatDate(start, tz, 'HH:mm:ss'),
              timezone: tz,
            },
            endAt: {
              date: Utilities.formatDate(end, tz, 'yyyy-MM-dd'),
              time: Utilities.formatDate(end, tz, 'HH:mm:ss'),
              timezone: tz,
            },
            teamMemberIdsToAssign: JOBBER_ASSIGN_USER_IDS.length ? JOBBER_ASSIGN_USER_IDS : null,
          },
        },
      },
    }
  );
  return jobberCheckErrors_(data.requestCreate, 'requestCreate (assessment)').request.id;
}

// Finds a Calendly answer whose QUESTION mentions any of these words.
function calendlyAnswer_(answers, words) {
  for (var i = 0; i < answers.length; i++) {
    var q = String(answers[i].question || '').toLowerCase();
    for (var w = 0; w < words.length; w++) {
      if (q.indexOf(words[w]) !== -1 && String(answers[i].answer || '').trim()) {
        return String(answers[i].answer).trim();
      }
    }
  }
  return '';
}

function calendlyInstructions_(lead, ev) {
  var lines = ['Booked through Calendly from book.cvillegutterpros.com.'];
  if (ev.name) lines.push('Event: ' + ev.name);
  if (lead.phone) lines.push('Phone: ' + lead.phone);
  if (lead.notes) lines.push('What they told us: ' + lead.notes);
  return lines.join('\n');
}

// Assessments get their own tab so they never mix with the paid-booking sheet.
function calendlyLogRow_(lead, ev, requestId, status) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Assessments');
    if (!sheet) {
      sheet = ss.insertSheet('Assessments');
      sheet.appendRow(['Booked at', 'Assessment at', 'Name', 'Email', 'Phone',
                       'Address', 'Notes', 'Jobber request', 'Status']);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, 9).setFontWeight('bold')
           .setFontColor('#ffffff').setBackground('#1d4ed8');
    }
    sheet.appendRow([
      new Date(), ev.start_time ? new Date(ev.start_time) : '',
      lead.name, lead.email, lead.phone, lead.address, lead.notes,
      requestId, status,
    ]);
  } catch (e) { /* logging must never break the sync */ }
}

// Run ONCE by hand after setting CALENDLY_TOKEN. Points Calendly at this web app.
function registerCalendlyWebhook() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('CALENDLY_TOKEN');
  if (!token) throw new Error('Set CALENDLY_TOKEN in Script Properties first.');

  var secret = props.getProperty('CALENDLY_WEBHOOK_SECRET');
  if (!secret) {
    secret = Utilities.getUuid();
    props.setProperty('CALENDLY_WEBHOOK_SECRET', secret);
  }

  var webAppUrl = ScriptApp.getService().getUrl();
  if (!webAppUrl) throw new Error('Deploy this script as a web app first.');

  var me = calendlyApi_(token, 'get', '/users/me', null).resource;
  var result = calendlyApi_(token, 'post', '/webhook_subscriptions', {
    url: webAppUrl + '?cal=' + encodeURIComponent(secret),
    events: ['invitee.created', 'invitee.canceled'],
    organization: me.current_organization,
    user: me.uri,
    scope: 'user',
  });

  Logger.log('Calendly webhook registered: ' + (result.resource || {}).uri);
  Logger.log('Assessments booked from now on will land in Jobber as Requests.');
}

function calendlyApi_(token, method, path, body) {
  var options = {
    method: method,
    headers: { Authorization: 'Bearer ' + token },
    contentType: 'application/json',
    muteHttpExceptions: true,
  };
  if (body) options.payload = JSON.stringify(body);

  var resp = UrlFetchApp.fetch('https://api.calendly.com' + path, options);
  var code = resp.getResponseCode();
  var parsed = JSON.parse(resp.getContentText() || '{}');
  if (code < 200 || code >= 300) {
    throw new Error('Calendly API ' + code + ' — ' + (parsed.message || resp.getContentText()));
  }
  return parsed;
}

// ===========================================================================
// WEB APP HANDLERS (called from doPost in apps_script.gs)
// ===========================================================================

// Locates the sheet row for this customer: exact timestamp first, then their
// most recent row by email. Only looks at the last 300 rows.
function jobberFindRow_(timestamp, email) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  var firstRow = Math.max(2, lastRow - 299);
  var vals = sheet.getRange(firstRow, 1, lastRow - firstRow + 1, LAST_COL).getValues();
  var wantStamp = String(timestamp || '').trim();
  var wantEmail = String(email || '').trim().toLowerCase();

  var byEmail = 0;
  for (var i = vals.length - 1; i >= 0; i--) {
    var rowEmail = String(vals[i][COL.EMAIL - 1] || '').trim().toLowerCase();
    if (wantEmail && rowEmail !== wantEmail) continue;

    var rowStamp = vals[i][COL.TIMESTAMP - 1];
    var asText = (rowStamp instanceof Date) ? rowStamp.toISOString() : String(rowStamp || '');
    if (wantStamp && asText.slice(0, 19) === wantStamp.slice(0, 19)) return firstRow + i;
    if (!byEmail) byEmail = firstRow + i;   // newest row for this email
  }
  return byEmail;
}

// ===========================================================================
// SETUP + TEST (run these by hand from the editor)
// ===========================================================================

// Adds the Jobber columns to the leads sheet. Safe to re-run.
function setupJobberColumns() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var headers = ['Jobber client|property', 'Jobber request', 'Jobber quote', 'Jobber job', 'Visit at', 'Jobber sync'];
  sheet.getRange(1, JCOL.CLIENT, 1, headers.length).setValues([headers]);

  var header = sheet.getRange(1, JCOL.CLIENT, 1, headers.length);
  header.setFontWeight('bold').setFontColor('#ffffff').setBackground('#1d4ed8');
  sheet.getRange(1, JCOL.VISIT_AT, sheet.getMaxRows(), 1).setNumberFormat('yyyy-mm-dd hh:mm');
  for (var c = JCOL.CLIENT; c <= JOBBER_LAST_COL; c++) sheet.autoResizeColumn(c);
  Logger.log('Jobber columns ready (' + JCOL.CLIENT + '–' + JOBBER_LAST_COL + ').');
}

// Read-only connection + scope check. Run this FIRST, before any real booking.
function testJobberConnection() {
  var data = jobberGql_('query { account { id name } }', {});
  Logger.log('Connected to Jobber account: ' + data.account.name);

  // Does the token actually have write permission? Probe a nonexistent client
  // so nothing can be created or changed.
  try {
    jobberGql_(
      'mutation($id: EncodedId!) { clientEdit(clientId: $id, input: { firstName: "ScopeProbe" }) { userErrors { message } } }',
      { id: 'Z2lkOi8vSm9iYmVyL0NsaWVudC85OTk5OTk5OTk5' }
    );
    Logger.log('WRITE SCOPES: enabled ✅');
  } catch (err) {
    if (String(err).indexOf('scopes are not enabled') !== -1) {
      Logger.log('WRITE SCOPES: MISSING ❌ — add them in the Jobber Developer Center, then re-authorize.');
    } else {
      Logger.log('WRITE SCOPES: enabled ✅ (probe rejected the fake ID, as expected)');
    }
  }

}
