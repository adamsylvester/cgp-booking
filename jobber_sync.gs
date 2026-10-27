// ============================================================================
// JOBBER SYNC — turns a paid online booking into real Jobber records.
//
// Paste this into the SAME Apps Script project as apps_script.gs (File > New >
// Script, name it "jobber_sync"). It shares that file's PRICING, COL, STATUS
// and sheet helpers.
//
// THE SCHEDULER DECIDES WHEN (booking_slots in Supabase since 2026-10-22;
// Calendly before that). This script never decides what's available — it
// mirrors whatever slot the customer picked onto the Jobber calendar.
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

// ===== Online-booking markers =====
// The admin should be able to tell at a glance — from any list, the calendar,
// or the client page — that a record came through the booking site
// rather than being entered by the team. The prefix leads every title; the tag
// shows as a chip on the client and is filterable in client lists.
const JOBBER_TITLE_PREFIX = '📅 ONLINE — ';
const JOBBER_CLIENT_TAG = '📅 Online Booking';

// ===== Scheduling config =====
// Calendly decides WHEN. These only fill gaps Calendly doesn't tell us.
const SCHED = {
  jobMinutes: 90,           // job length, used only if Calendly sends no end time
  arrivalWindowMinutes: 60, // customer-facing "we'll arrive between" cushion
  timeZone: 'America/New_York',
};

// ===== Real Jobber Products & Services =====
// Online bookings must land as the SAME line items the team builds by hand, so
// they report identically. Each entry is a live Product/Service in the account
// — passing productOrServiceId links the line to that record instead of
// inventing a one-off name. Names are kept here only so the quote still reads
// correctly if a service is ever renamed or archived in Jobber.
const JOBBER_SERVICES = {
  cleaning: {
    id: 'Z2lkOi8vSm9iYmVyL1Byb2R1Y3RPclNlcnZpY2UvOTM0MDczNA==',
    name: 'Single Gutter Cleaning',
  },
  gutterSeal: {
    id: 'Z2lkOi8vSm9iYmVyL1Byb2R1Y3RPclNlcnZpY2UvMTc1ODUxOTc=',
    name: 'Gutter Seal',
  },
  // Retired upsell (through Oct 31, 2026); kept so old rows re-sync faithfully.
  touchUps: {
    id: 'Z2lkOi8vSm9iYmVyL1Byb2R1Y3RPclNlcnZpY2UvNDY0OTMxOTE=',
    name: 'Touch Ups Until October 31, 2026.',
  },
  protectionPlan: {
    id: 'Z2lkOi8vSm9iYmVyL1Byb2R1Y3RPclNlcnZpY2UvNDM4NDQxNjE=',
    name: '\uD83C\uDF1F Complete Gutter Protection Plan - 2 years of service / 4 cleanings - Most Popular! \uD83C\uDFC6',
  },
  freeCleaning: {
    id: 'Z2lkOi8vSm9iYmVyL1Byb2R1Y3RPclNlcnZpY2UvNDQzODQ2OTI=',
    name: 'Free Cleaning Applied',
  },
  tripFee: {
    id: 'Z2lkOi8vSm9iYmVyL1Byb2R1Y3RPclNlcnZpY2UvNTE1MzE4MTY=',
    name: 'Trip Fee',
  },
};

// The Gutter Protection Plan is priced as 4 cleanings with 1 credited back,
// which is how Todd builds it by hand — and it nets to the funnel's 3x price.
const GPP_CLEANINGS = 4;
const GPP_FREE_CLEANINGS = 1;

// Every saved Product/Service in the account is flagged taxable, but the funnel
// has always written non-taxable lines and Square charged the customer the
// pre-tax total. Flipping this to true would add tax on top and the Jobber
// total would no longer match what was collected — so it stays false until the
// online prices are meant to be tax-inclusive.
const JOBBER_LINE_TAXABLE = false;

// Jobber user IDs to auto-assign new online-booking jobs to.
// Leave EMPTY to create the job unassigned (safest). Fill it once you decide
// who owns online bookings: ['Z2lkOi8vSm9iYmVyL1VzZXIvMTIzNDU='].
const JOBBER_ASSIGN_USER_IDS = [];

// Every online assessment lands assigned to the Assessments lane account and
// Todd (Adam, 2026-10-27), the way the office assigns them by hand, so Todd
// sees it on his calendar without anyone touching the request. Jobber has two
// "Todd Miller" users; ...ODE1MzI3 is the active one (...ODE0NzAz is deactivated).
const JOBBER_ASSESSMENT_ASSIGN_IDS = [
  'Z2lkOi8vSm9iYmVyL1VzZXIvMTgxNzM5Mw==',   // Assessments
  'Z2lkOi8vSm9iYmVyL1VzZXIvODE1MzI3',       // Todd Miller
];

// ===== Extra sheet columns (added by setupJobberColumns) =====
const JCOL = {
  CLIENT: 23, REQUEST: 24, QUOTE: 25, JOB: 26, VISIT_AT: 27, SYNC: 28,
  HOLD: 29,   // booking_holds id when they picked a time before paying (2026-10-22)
};
const JOBBER_LAST_COL = 29;

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
    jobberTagClient_(found.id);
    return {
      clientId: found.id,
      propertyId: jobberEnsureProperty_(found, lead),
    };
  }

  // New client — the property rides along in the same mutation.
  var names = jobberSplitName_(lead.name);
  var create = function (sms) {
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
          phones: phone ? [{ description: 'MOBILE', number: phone, primary: true, smsAllowed: sms }] : [],
          properties: [{ address: jobberAddress_(lead) }],
          sourceAttribution: { sourceText: 'Online booking (book.cvillegutterpros.com)' },
          receivesReminders: true,
          receivesReviewRequests: true,
        },
      }
    );
    return jobberCheckErrors_(data.clientCreate, 'clientCreate');
  };
  var payload;
  try {
    payload = create(true);
  } catch (err) {
    // Jobber refuses a number it cannot text (a landline, a foreign number:
    // 2026-10-24 a +234 number killed the whole booking). The client still
    // belongs in Jobber, just without the text toggle.
    if (!/cannot receive text/i.test(String(err))) throw err;
    payload = create(false);
  }
  var client = payload.client;
  var props = (client.clientProperties && client.clientProperties.nodes) || [];
  if (!props.length) throw new Error('Client created but no property came back.');

  jobberTagClient_(client.id);
  return { clientId: client.id, propertyId: props[0].id };
}

// Puts the Calendly chip on the client. Best-effort: a tagging hiccup must
// never block the booking itself. Re-adding an existing tag is a no-op.
function jobberTagClient_(clientId) {
  try {
    jobberGql_(
      'mutation($id: EncodedId!, $input: ClientEditInput!) {' +
      '  clientEdit(clientId: $id, input: $input) { userErrors { message } }' +
      '}',
      { id: clientId, input: { tagsToAdd: [JOBBER_CLIENT_TAG] } }
    );
  } catch (err) {
    Logger.log('Client tag failed (booking unaffected): ' + err);
  }
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
          productOrServiceId: li.productOrServiceId || null,
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
// DAILY SWEEP — paid bookings whose quote is still "Awaiting response"
// ===========================================================================
// A paid booking's quote SHOULD read Approved. Jobber's GraphQL API cannot set
// that: there is no approve/accept/transition mutation, `quoteEdit` has no
// status field, and `transitionQuoteTo` accepts only AWAITING_RESPONSE at
// create time (verified against API versions 2025-01-20 and 2025-04-16, the
// only two that exist). So approval has to be a human click — either the
// office in Jobber, or the customer in their Client Hub.
//
// This ran real: quote #11145 (2026-08-24) — customer paid, quote sat in
// Awaiting response.
//
// Runs from checkPendingPayments but does real work once a day. It asks Jobber
// for each paid quote's actual status and emails the office only the ones
// still sitting in Awaiting response, with a one-click link to each.
function jobberDailyStuckSweep_() {
  if (!jobberSyncEnabled_()) return;
  var props = PropertiesService.getScriptProperties();
  var today = Utilities.formatDate(new Date(), SCHED.timeZone, 'yyyy-MM-dd');
  if (props.getProperty('JOBBER_SWEEP_LAST') === today) return;
  props.setProperty('JOBBER_SWEEP_LAST', today);

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var firstRow = Math.max(2, lastRow - 299);
  var vals = sheet.getRange(firstRow, 1, lastRow - firstRow + 1, JOBBER_LAST_COL).getValues();
  var now = new Date();

  var candidates = [];
  vals.forEach(function (v, i) {
    if (String(v[COL.STATUS - 1]) !== STATUS.PAID) return;
    if (!String(v[JCOL.QUOTE - 1] || '')) return; // no quote = create failed; that already emailed
    var paidAt = new Date(v[COL.PAID_AT - 1] || v[COL.TIMESTAMP - 1]);
    if (isNaN(paidAt) || (now - paidAt) < 20 * 3600000) return; // give the office a day
    candidates.push({ sheetRow: firstRow + i, lead: rowToLead(v), quoteId: String(v[JCOL.QUOTE - 1]), paidAt: paidAt });
  });

  // Jobber, not the sheet, is the authority on whether a quote still needs a
  // human. Anything already approved (or converted/archived) drops out, so the
  // office is never nagged about a quote somebody already handled.
  var stuck = candidates.filter(function (s) {
    try {
      var data = jobberGql_(
        'query($id: EncodedId!) { quote(id: $id) { quoteStatus clientHubUri } }',
        { id: s.quoteId }
      );
      var status = String(((data.quote || {}).quoteStatus) || '');
      if (status && status !== 'awaiting_response' && status !== 'draft') {
        sheet.getRange(s.sheetRow, JCOL.SYNC).setValue('✅ Quote ' + status.replace(/_/g, ' '));
        return false;
      }
      s.clientHubUri = (data.quote || {}).clientHubUri || '';
      return true;
    } catch (err) {
      return false; // can't reach Jobber — stay quiet rather than cry wolf
    }
  });
  if (!stuck.length) return;

  var inner = statusBanner('#f59e0b', '⏰ ' + stuck.length + ' paid quote' +
    (stuck.length > 1 ? 's are' : ' is') + ' still sitting in “Awaiting response”.') +
    '<p style="margin:0 0 12px;line-height:1.5;">Each customer below already paid their deposit, so their ' +
    'quote should read <strong>Approved</strong>. Jobber\'s API cannot set that status — it has to be a ' +
    'click. Open each quote and mark it <strong>Approved</strong> (or send them the Client Hub link and let ' +
    'them approve it themselves).</p>';

  stuck.forEach(function (s) {
    var link = jobberQuoteWebLink_(s.quoteId);
    inner += '<table style="border-collapse:collapse;width:100%;margin-top:10px;">' +
      contactRows(s.lead.name, s.lead.phone, s.lead.email, s.lead.address) +
      row('Paid on', Utilities.formatDate(s.paidAt, SCHED.timeZone, 'EEE, MMM d h:mm a')) +
      row('Deposit / total', '$' + s.lead.deposit + ' / $' + s.lead.total) +
      row('Quote', link ? '<a href="' + link + '">Approve in Jobber</a>' : s.quoteId) +
      (s.clientHubUri ? row('Client Hub', '<a href="' + s.clientHubUri + '">Customer approval link</a>') : '') +
      '</table>';
  });

  MailApp.sendEmail({
    to: NOTIFICATION_EMAIL,
    subject: '⏰ Paid online booking' + (stuck.length > 1 ? 's' : '') +
             ' — quote still “Awaiting response”, needs approving',
    htmlBody: emailShell(inner),
    from: FROM_ADDRESS,
    name: FROM_NAME,
  });
}

// "Z2lkOi8vSm9iYmVyL1F1b3RlLzY0NTE2NjA4" decodes to gid://Jobber/Quote/64516608,
// whose trailing number is the web URL id.
function jobberQuoteWebLink_(encodedId) {
  try {
    var decoded = Utilities.newBlob(Utilities.base64Decode(encodedId)).getDataAsString();
    var num = decoded.split('/').pop();
    return /^\d+$/.test(num) ? 'https://secure.getjobber.com/quotes/' + num : '';
  } catch (e) {
    return '';
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
// stores ("Basic Cleaning", "Gutter Protection Plan", ...). The add-on tier
// ('simple') was retired 2026-10-12 but old rows still carry its labels, so
// they map to it and jobberAddonService_ picks the matching Jobber product.
function jobberPlanCode_(planLabel) {
  var s = String(planLabel || '').toLowerCase();
  if (s.indexOf('protection') !== -1) return 'protection';
  if (s.indexOf('seal') !== -1 || s.indexOf('touch') !== -1 || s.indexOf('seasonal') !== -1) return 'simple';
  return 'basic';
}

// The add-on product for a 'simple' row: Gutter Seal today, Touch Ups for
// rows booked before the Oct 2026 swap so a re-sync never rewrites history.
function jobberAddonService_(planLabel) {
  var s = String(planLabel || '').toLowerCase();
  if (s.indexOf('touch') !== -1 || s.indexOf('seasonal') !== -1) {
    return { product: JOBBER_SERVICES.touchUps, description: 'Unlimited touch-ups through Oct. 31, as chosen online.' };
  }
  return { product: JOBBER_SERVICES.gutterSeal, description: 'Reseal leaking seams and end caps, as chosen online.' };
}

function jobberJobTitle_(lead) {
  return JOBBER_TITLE_PREFIX + 'Gutter Cleaning — ' + (lead.plan || 'Basic');
}

// Rebuilds the quote as real line items so Jobber shows the same math the
// customer saw. Falls back to a single line if the parts don't sum to the
// stored total (a hand-edited row, say) — the customer's total always wins.
function jobberLineItems_(lead) {
  var base = Number(lead.base || 0);
  var total = Number(lead.total || 0);
  var fee = lead.outside ? OUTSIDE_AREA_FEE : 0;
  var code = jobberPlanCode_(lead.plan);

  var items = [];

  if (code === 'protection') {
    // 4 cleanings on the plan, 1 credited back — nets to 3x base, and matches
    // the structure the team quotes by hand.
    items.push(jobberServiceLine_(JOBBER_SERVICES.protectionPlan, {
      quantity: GPP_CLEANINGS,
      unitPrice: base,
      description: 'Booked online. ' + GPP_CLEANINGS + ' cleanings over 24 months.'
        + (jobberSizeNote_(lead) ? ' Home: ' + jobberSizeNote_(lead) + '.' : ''),
    }));
    items.push(jobberServiceLine_(JOBBER_SERVICES.freeCleaning, {
      quantity: -GPP_FREE_CLEANINGS,
      unitPrice: base,
      description: 'Free cleaning credit applied at enrollment.',
    }));
  } else if (base > 0) {
    items.push(jobberServiceLine_(JOBBER_SERVICES.cleaning, {
      quantity: 1,
      unitPrice: base,
      description: jobberSizeNote_(lead),
    }));
    if (code === 'simple') {
      // Flat add-on; whatever the page charged above the cleaning is the seal.
      var addon = total - fee - base;
      if (addon > 0) {
        var svc = jobberAddonService_(lead.plan);
        items.push(jobberServiceLine_(svc.product, {
          quantity: 1,
          unitPrice: addon,
          description: svc.description,
        }));
      }
    }
  }

  if (fee > 0) {
    items.push(jobberServiceLine_(JOBBER_SERVICES.tripFee, {
      quantity: 1,
      unitPrice: fee,
      description: 'Outside the Charlottesville/Albemarle service area.',
    }));
  }

  // Never let a mapping bug change what the customer was charged. If the lines
  // don't reconcile to the total, fall back to one plain line at the real price.
  var sum = items.reduce(function (a, li) { return a + li.quantity * li.unitPrice; }, 0);
  if (!items.length || Math.abs(sum - total) > 0.5) {
    return [{
      name: jobberJobTitle_(lead),
      description: jobberDetailsNote_(lead),
      quantity: 1, unitPrice: total, taxable: JOBBER_LINE_TAXABLE,
      saveToProductsAndServices: false, category: 'SERVICE',
    }];
  }
  return items;
}

// Builds one line item linked to a real Product/Service record.
function jobberServiceLine_(service, opts) {
  return {
    productOrServiceId: service.id,
    name: service.name,
    description: opts.description || '',
    quantity: opts.quantity,
    unitPrice: opts.unitPrice,
    taxable: JOBBER_LINE_TAXABLE,
    saveToProductsAndServices: false,
    category: 'SERVICE',
  };
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
  var paidInFull = balance === 0 && deposit > 0;
  var lines = [
    (paidInFull ? '💵 PAID IN FULL — $' : '💵 DEPOSIT ALREADY PAID — $') + deposit +
      ' collected through Square when they booked online.',
    'Quoted total: $' + total,
    'BALANCE TO COLLECT ON COMPLETION: $' + balance + (paidInFull ? ' (nothing — fully prepaid)' : ''),
    '',
    'Apply the $' + deposit + ' as a payment on the invoice by hand — it is in Square, not in Jobber.',
  ];
  if (receiptUrl) lines.push('Square receipt: ' + receiptUrl);
  return lines.join('\n');
}

// free = nothing was charged (an assessment), so the banner must not claim a
// deposit the office then goes looking for in Square (Vicki, 2026-10-27).
function jobberNotifyFailure_(lead, err, doingWhat, free) {
  try {
    MailApp.sendEmail({
      to: NOTIFICATION_EMAIL,
      subject: '⚠️ Jobber sync failed: ' + (lead.name || 'booking') + (free ? ' — nothing was charged, Jobber is missing it' : ' — money is fine, Jobber is not'),
      htmlBody: emailShell(
        statusBanner('#dc2626', free
          ? '⚠️ Jobber did not get this booking. No money was taken (assessments are free).'
          : '⚠️ The deposit was collected, but Jobber did not get the booking.') +
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
        title: JOBBER_TITLE_PREFIX + (ev.name || 'Gutter assessment'),
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
            teamMemberIdsToAssign: JOBBER_ASSESSMENT_ASSIGN_IDS,
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
  var lines = ['Booked online at book.cvillegutterpros.com.'];
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

// ---------------------------------------------------------------------------
// END-TO-END TEST — run this ONCE before a real customer hits the flow.
//
// Fakes a paid booking and walks it through every step for real: creates a
// Client, Property, Request and Quote in Jobber, then fires a synthetic
// Calendly webhook to create the scheduled Job. No money moves and no email
// goes to a customer.
//
// Everything is named "ZZZ TEST — DELETE ME" so it sorts to the bottom of your
// Jobber lists and is obvious. Run cleanupEndToEndTest() afterwards, then
// delete the leftovers by hand (see the note in that function).
// ---------------------------------------------------------------------------
function testEndToEnd() {
  if (!jobberSyncEnabled_()) throw new Error('Set the JOBBER_TOKEN_STORE_* Script Properties first.');

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var stamp = new Date().toISOString();
  var email = 'jobber-sync-test+' + stamp.slice(0, 19).replace(/\D/g, '') + '@example.com';

  // 1. A row exactly as a real paid booking would look.
  var lead = {
    timestamp: stamp,
    name: 'ZZZ TEST — DELETE ME',
    phone: '4345550199',
    email: email,
    address: '123 Test Street, Charlottesville, VA',
    houseType: 'standard',
    sqft: 2000,
    stories: '2',
    planName: 'Basic Cleaning',
    zip: '22901',
    notes: 'Automated end-to-end test. Safe to delete.',
    basePrice: 315,
    finalPrice: 315,
    deposit: 79,
  };
  logLead(lead, STATUS.PAID, 'TEST-ORDER', '✓ verified (test)');
  var row = sheet.getLastRow();
  Logger.log('1/3  Test row added at sheet row ' + row);

  // 2. Deposit-paid path: Client -> Property -> Request -> Quote.
  pushBookingToJobber_(rowToLead(sheet.getRange(row, 1, 1, LAST_COL).getValues()[0]), row, '');
  var sync = String(sheet.getRange(row, JCOL.SYNC).getValue() || '');
  if (sync.indexOf('⚠️') === 0) throw new Error('Stage 1 failed — ' + sync);
  Logger.log('2/3  ' + sync);
  Logger.log('     client|property: ' + sheet.getRange(row, JCOL.CLIENT).getValue());
  Logger.log('     request: ' + sheet.getRange(row, JCOL.REQUEST).getValue());
  Logger.log('     quote:   ' + sheet.getRange(row, JCOL.QUOTE).getValue());

  // 3. Calendly path: a slot two days out becomes a scheduled Job.
  var start = new Date(Date.now() + 2 * 86400000);
  start.setHours(9, 0, 0, 0);
  var end = new Date(start.getTime() + 2 * 3600000);   // the event is 2 hours

  var result = handleCalendlyWebhook_({
    event: 'invitee.created',
    payload: {
      name: lead.name,
      email: email,
      text_reminder_number: '+14345550199',
      questions_and_answers: [{ question: 'Phone number', answer: '(434) 555-0199' }],
      scheduled_event: {
        name: 'Gutter Cleaning',
        start_time: start.toISOString(),
        end_time: end.toISOString(),
      },
    },
  }, { cal: PropertiesService.getScriptProperties().getProperty('CALENDLY_WEBHOOK_SECRET') });

  if (!result.ok) throw new Error('Stage 2 failed — ' + result.error);
  Logger.log('3/3  ' + String(sheet.getRange(row, JCOL.SYNC).getValue()));
  Logger.log('     job: ' + sheet.getRange(row, JCOL.JOB).getValue());
  Logger.log('     scheduled for: ' + start);
  Logger.log('');
  Logger.log('PASSED. Check Jobber for "ZZZ TEST — DELETE ME", then run cleanupEndToEndTest().');
  return row;
}

// Archives the test client and clears the test rows from the sheet.
//
// NOTE: Jobber's API has no delete for jobs or quotes — archiving the client
// hides it from normal views, but to remove the job, quote and request fully
// you have to delete them in the Jobber UI.
function cleanupEndToEndTest() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheets()[0];
  var lastRow = sheet.getLastRow();
  var removed = 0;

  // Test rows on the Assessments tab too (online-booking rehearsals log there).
  var assess = ss.getSheetByName('Assessments');
  if (assess) {
    for (var a = assess.getLastRow(); a >= 2; a--) {
      if (String(assess.getRange(a, 3).getValue()).indexOf('ZZZ') === 0) { assess.deleteRow(a); removed++; }
    }
  }

  for (var r = lastRow; r >= 2; r--) {
    // Any ZZZ-prefixed name: "ZZZ TEST — DELETE ME", "ZZZ SANDBOX — …"
    if (String(sheet.getRange(r, COL.NAME).getValue()).indexOf('ZZZ') !== 0) continue;

    var clientCell = String(sheet.getRange(r, JCOL.CLIENT).getValue() || '');
    var clientId = clientCell.split('|')[0];
    if (clientId) {
      try {
        jobberGql_(
          'mutation($id: EncodedId!) { clientArchive(clientId: $id) { userErrors { message } } }',
          { id: clientId }
        );
        Logger.log('Archived test client ' + clientId);
      } catch (err) {
        Logger.log('Could not archive ' + clientId + ': ' + err);
      }
    }
    sheet.deleteRow(r);
    removed++;
  }
  Logger.log('Removed ' + removed + ' test row(s). Delete the job/quote/request by hand in Jobber.');
}

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

// ===========================================================================
// ONLINE BOOKING (2026-10-22) — our own scheduler replaced Calendly.
// ===========================================================================
// book.cvillegutterpros.com/schedule.html shows open slots straight from
// Supabase (booking_slots — it knows where the crew already is that day),
// and team.cvillegutterpros.com/api/book claims the slot as a booking_holds
// row. Then it calls this web app with the hold id and nothing else. We read
// the hold back from Supabase ourselves (booking_hold_get), so the request
// body is never trusted — the unguessable id is the whole credential, the
// same way Calendly's reschedule links worked.
//
//   online_schedule    paid cleaning → the PAID sheet row's job gets its visit
//                      (same scheduleBookingInJobber_ Calendly used);
//                      assessment  → Request with the assessment scheduled.
//   online_reschedule  move the visit / assessment to the new hold's time.
//   online_cancel      email the office; Jobber is left alone (the deposit
//                      stays attached to the job) exactly as before.
//
// Every path emails the customer (confirmation with a calendar invite,
// reschedule, cancellation) and the office. Day-before reminder emails are
// queued in Postgres (booking_queue_reminders, 9am ET) and sent by the pulse.

const ONLINE_SB_URL = 'https://wmmhvguajkeiyhmfmilu.supabase.co';
const ONLINE_SB_KEY = 'sb_publishable_qTRQ_ECvykQgCBHWReXC7w_nt1HUv8Z';   // publishable; the hold id is the secret
const ONLINE_MANAGE_URL = 'https://book.cvillegutterpros.com/manage.html?t=';
const ONLINE_TITLES = { cleaning: 'Gutter Cleaning', assessment: 'Gutter Assessment' };

function onlineAction_(action, data) {
  var holdId = String((data && data.hold) || '');
  if (!/^[0-9a-f-]{36}$/i.test(holdId)) return { ok: false, error: 'bad_hold' };
  if (!jobberSyncEnabled_()) return { ok: false, error: 'jobber_not_configured' };
  var hold = onlineHold_(holdId);
  if (!hold || !hold.id) return { ok: false, error: 'hold_not_found' };
  try {
    if (action === 'online_schedule') return onlineSchedule_(hold);
    if (action === 'online_reschedule') return onlineReschedule_(hold, onlineHold_(String(data.prev || '')));
    if (action === 'online_cancel') return onlineCancel_(hold);
    return { ok: false, error: 'unknown_action' };
  } catch (err) {
    onlineHoldUpdate_(hold.id, { error: String(err).slice(0, 400) });
    jobberNotifyFailure_(onlineLead_(hold), err, action.replace('online_', '') + ' for an online ' + hold.service + ' booking', hold.service === 'assessment');
    return { ok: false, error: String(err).slice(0, 300) };
  }
}

function onlineRpc_(fn, args) {
  var resp = UrlFetchApp.fetch(ONLINE_SB_URL + '/rest/v1/rpc/' + fn, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: ONLINE_SB_KEY, Authorization: 'Bearer ' + ONLINE_SB_KEY },
    payload: JSON.stringify(args),
  });
  var code = resp.getResponseCode();
  var text = resp.getContentText() || '';
  if (code >= 300) throw new Error('Supabase ' + fn + ' -> ' + code + ' ' + text.slice(0, 200));
  return text ? JSON.parse(text) : null;
}
function onlineHold_(id) { return id ? onlineRpc_('booking_hold_get', { p_id: id }) : null; }
function onlineHoldUpdate_(id, patch) {
  try { return onlineRpc_('booking_hold_update', { p_id: id, p: patch }); } catch (e) { return null; }
}

// A hold in the shape the Jobber helpers expect from a sheet row.
function onlineLead_(hold) {
  return {
    name: hold.name || '', email: hold.email || '', phone: hold.phone || '',
    address: hold.address || '', zip: hold.zip || '', notes: hold.notes || '',
    plan: hold.service === 'assessment' ? 'On-site assessment' : '',
    house: '', sqft: '', stories: '', outside: false, base: 0, total: 0, deposit: 0,
    timestamp: hold.lead_timestamp || '',
  };
}

function onlineSchedule_(hold) {
  if (hold.status === 'booked' && (hold.jobber_job_id || hold.jobber_request_id)) return { ok: true, already: true };
  if (hold.status !== 'held' && hold.status !== 'booked') return { ok: false, error: 'hold_' + hold.status };
  var ids = hold.service === 'assessment' ? onlineScheduleAssessment_(hold) : onlineScheduleCleaning_(hold);
  if (ids.error) return { ok: false, error: ids.error };
  var patch = { status: 'booked' };
  Object.keys(ids).forEach(function (k) { if (ids[k]) patch[k] = ids[k]; });
  onlineHoldUpdate_(hold.id, patch);
  hold.status = 'booked';
  onlineSendCustomerEmail_(hold, 'booked');
  onlineNotifyOffice_(hold, 'booked', ids, null);
  return { ok: true, jobId: ids.jobber_job_id || '', requestId: ids.jobber_request_id || '' };
}

// The paid cleaning: find the PAID row with no job yet (newest for this
// email), exactly as the Calendly webhook did. The customer only reaches the
// scheduler from Square's "paid" redirect, but the minute checker may not
// have marked the row yet — ask Square now instead of refusing.
function onlineScheduleCleaning_(hold) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var row = calendlyFindPaidUnscheduledRow_(hold.email);
  if (!row) {
    row = jobberFindRow_(hold.lead_timestamp, hold.email);
    if (!row) return { error: 'payment_not_found' };
    if (String(sheet.getRange(row, JCOL.JOB).getValue() || '')) return { error: 'already_scheduled' };
    if (String(sheet.getRange(row, COL.STATUS).getValue() || '') !== STATUS.PAID) {
      try { checkPendingPayments(); } catch (e) { /* fall through to the re-read */ }
      if (String(sheet.getRange(row, COL.STATUS).getValue() || '') !== STATUS.PAID) return { error: 'payment_not_found' };
    }
  }
  var receiptUrl = String(sheet.getRange(row, COL.PAYMENT_LINK).getValue() || '');
  var lead = rowToLead(sheet.getRange(row, 1, 1, LAST_COL).getValues()[0]);
  if (!String(sheet.getRange(row, JCOL.CLIENT).getValue() || '')) pushBookingToJobber_(lead, row, receiptUrl);
  var jobId = scheduleBookingInJobber_(row, hold.start_at, hold.end_at, receiptUrl);
  var visitId = '';
  try { visitId = onlineFirstVisitId_(jobId); } catch (e) { /* the id only matters for a later reschedule */ }
  var clientCell = String(sheet.getRange(row, JCOL.CLIENT).getValue() || '');
  return { jobber_job_id: jobId, jobber_visit_id: visitId, jobber_client_id: clientCell.split('|')[0] };
}

function onlineScheduleAssessment_(hold) {
  var lead = onlineLead_(hold);
  var made = jobberEnsureClient_(lead);
  var ev = { start_time: hold.start_at, end_time: hold.end_at, name: 'Gutter assessment' };
  var requestId = jobberCreateAssessmentRequest_(made.clientId, made.propertyId, lead, ev);
  var assessmentId = '';
  try { assessmentId = onlineAssessmentId_(requestId); } catch (e) { /* only needed to move it later */ }
  calendlyLogRow_(lead, ev, requestId, '✅ Request created in Jobber (online booking)');
  return { jobber_request_id: requestId, jobber_assessment_id: assessmentId, jobber_client_id: made.clientId };
}

function onlineFirstVisitId_(jobId) {
  var data = jobberGql_(
    'query($id: EncodedId!) { job(id: $id) { visits(first: 3) { nodes { id startAt } } } }', { id: jobId });
  var nodes = (((data.job || {}).visits || {}).nodes) || [];
  return nodes.length ? nodes[0].id : '';
}

function onlineAssessmentId_(requestId) {
  var data = jobberGql_('query($id: EncodedId!) { request(id: $id) { assessment { id } } }', { id: requestId });
  return (((data.request || {}).assessment) || {}).id || '';
}

function onlineReschedule_(hold, prev) {
  if (!prev || !prev.id) return { ok: false, error: 'prev_not_found' };
  var ids = {
    jobber_job_id: prev.jobber_job_id || '', jobber_visit_id: prev.jobber_visit_id || '',
    jobber_request_id: prev.jobber_request_id || '', jobber_assessment_id: prev.jobber_assessment_id || '',
    jobber_client_id: prev.jobber_client_id || '',
  };
  var tz = SCHED.timeZone;
  var start = new Date(hold.start_at), end = new Date(hold.end_at);
  var at = function (d) {
    return { date: Utilities.formatDate(d, tz, 'yyyy-MM-dd'), time: Utilities.formatDate(d, tz, 'HH:mm:ss'), timezone: tz };
  };
  if (ids.jobber_visit_id) {
    var d1 = jobberGql_(
      'mutation($id: EncodedId!, $input: VisitEditScheduleInput!) {' +
      '  visitEditSchedule(id: $id, input: $input) { visit { id } userErrors { message path } }' +
      '}', { id: ids.jobber_visit_id, input: { startAt: at(start), endAt: at(end) } });
    jobberCheckErrors_(d1.visitEditSchedule, 'visitEditSchedule');
  } else if (ids.jobber_assessment_id) {
    var d2 = jobberGql_(
      'mutation($id: EncodedId!, $input: AssessmentEditInput!) {' +
      '  assessmentEdit(assessmentId: $id, input: $input) { assessment { id } userErrors { message path } }' +
      '}', { id: ids.jobber_assessment_id, input: { schedule: { startAt: at(start), endAt: at(end), notifyTeam: true } } });
    jobberCheckErrors_(d2.assessmentEdit, 'assessmentEdit');
  } else {
    // The first booking never made it into Jobber: schedule the new time fresh.
    return onlineSchedule_(hold);
  }
  var patch = { status: 'booked' };
  Object.keys(ids).forEach(function (k) { if (ids[k]) patch[k] = ids[k]; });
  onlineHoldUpdate_(hold.id, patch);
  hold.status = 'booked';
  onlineSendCustomerEmail_(hold, 'rescheduled');
  onlineNotifyOffice_(hold, 'rescheduled', ids, prev);
  return { ok: true };
}

// Jobber keeps the job so the deposit stays attached to something; the
// office moves or cancels it by hand (same rule as the Calendly days).
function onlineCancel_(hold) {
  onlineNotifyOffice_(hold, 'cancelled', hold, null);
  onlineSendCustomerEmail_(hold, 'cancelled');
  return { ok: true };
}

// ----- emails ---------------------------------------------------------------

function onlineWhen_(hold) {
  var tz = SCHED.timeZone, s = new Date(hold.start_at), e = new Date(hold.end_at);
  return Utilities.formatDate(s, tz, 'EEEE, MMMM d, yyyy') + ' · ' +
         Utilities.formatDate(s, tz, 'h:mm a').toLowerCase() + ' – ' + Utilities.formatDate(e, tz, 'h:mm a').toLowerCase() + ' (Eastern)';
}

function onlineGoogleCalLink_(hold, title) {
  var f = function (d) { return Utilities.formatDate(new Date(d), 'UTC', "yyyyMMdd'T'HHmmss'Z'"); };
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE' +
    '&text=' + encodeURIComponent(title + ' - ' + FROM_NAME) +
    '&dates=' + f(hold.start_at) + '/' + f(hold.end_at) +
    '&location=' + encodeURIComponent(hold.address || '') +
    '&details=' + encodeURIComponent('We will call or text on the way. Reschedule or cancel: ' + ONLINE_MANAGE_URL + hold.id);
}

// A real calendar invitation (METHOD:REQUEST), so Gmail / Apple Mail show the
// "add to calendar" card the way Calendly's did.
function onlineIcs_(hold, title) {
  var f = function (d) { return Utilities.formatDate(new Date(d), 'UTC', "yyyyMMdd'T'HHmmss'Z'"); };
  var esc = function (s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, function (c) { return '\\' + c; });
  };
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Charlottesville Gutter Pros//Booking//EN', 'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:' + hold.id + '@cvillegutterpros.com',
    'DTSTAMP:' + f(new Date()), 'DTSTART:' + f(hold.start_at), 'DTEND:' + f(hold.end_at),
    'SUMMARY:' + esc(title + ' - ' + FROM_NAME),
    'LOCATION:' + esc(hold.address),
    'DESCRIPTION:' + esc('We will call or text on the way. Reschedule or cancel: ' + ONLINE_MANAGE_URL + hold.id),
    'ORGANIZER;CN=' + esc(FROM_NAME) + ':mailto:' + FROM_ADDRESS,
    'ATTENDEE;CN=' + esc(hold.name) + ';RSVP=FALSE:mailto:' + hold.email,
    'STATUS:CONFIRMED', 'SEQUENCE:0',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

function onlineSendCustomerEmail_(hold, kind, lead) {
  if (!hold.email) return;
  var title = ONLINE_TITLES[hold.service] || 'Appointment';
  var first = escapeHtml(String(hold.name || 'there').split(' ')[0]);
  var tz = SCHED.timeZone, start = new Date(hold.start_at);
  var short = Utilities.formatDate(start, tz, 'EEE, MMM d') + ' at ' + Utilities.formatDate(start, tz, 'h:mm a').toLowerCase();
  var manage = ONLINE_MANAGE_URL + hold.id;
  var btn = function (href, label, solid) {
    return '<a href="' + href + '" style="display:inline-block;margin:0 8px 8px 0;padding:11px 18px;border-radius:999px;font-weight:700;text-decoration:none;' +
      (solid ? 'background:#1d4ed8;color:#fff;' : 'border:1px solid #1d4ed8;color:#1d4ed8;') + '">' + label + '</a>';
  };
  var inner = '', subject;
  if (kind === 'cancelled') {
    subject = 'Cancelled: ' + title + ' on ' + Utilities.formatDate(start, tz, 'MMM d');
    inner += '<h2 style="margin:0 0 8px;color:#101828;">Your ' + title.toLowerCase() + ' is cancelled</h2>';
    inner += '<p style="margin:0 0 18px;color:#475467;line-height:1.5;">Hi ' + first + ', we\'ve taken <strong>' + escapeHtml(onlineWhen_(hold)) + '</strong> off the calendar. ' +
             'Want a different day? Reply to this email or call/text <a href="tel:+14344224700">434-422-4700</a>.</p>';
  } else {
    subject = (kind === 'rescheduled' ? 'Rescheduled: ' : 'Confirmed: ') + title + ' with ' + FROM_NAME + ' on ' + short;
    inner += '<h2 style="margin:0 0 8px;color:#1d4ed8;">' + (kind === 'rescheduled' ? 'You\'re rescheduled' : 'You\'re scheduled') + ', ' + first + '!</h2>';
    inner += '<p style="margin:0 0 18px;color:#475467;line-height:1.5;">A calendar invitation is attached. Your technician will call or text on the way.</p>';
    inner += '<table style="border-collapse:collapse;width:100%;">';
    inner += rowBold('What', escapeHtml(title));
    inner += rowBold('When', escapeHtml(onlineWhen_(hold)));
    if (hold.address) inner += row('Where', escapeHtml(hold.address));
    inner += '</table>';
    if (lead && Number(lead.total || 0) > 0) {
      // Paid cleaning: fold the deposit receipt in so this is their one email.
      var paidAll = depositRateFor(lead.plan) >= 1;
      inner += sectionHead('Your quote');
      inner += '<table style="border-collapse:collapse;width:100%;">' +
        quoteSummaryRows({ houseType: lead.house, sqft: lead.sqft, stories: lead.stories, planName: lead.plan, plan: lead.plan,
                           finalPrice: lead.total, deposit: lead.deposit, outsideArea: lead.outside }) + '</table>';
      inner += '<p style="margin:10px 0 0;color:#475467;font-size:13px;">' + (paidAll ? 'Paid in full — nothing due after the job.' : 'Your $' + escapeHtml(String(lead.deposit)) + ' deposit is in; the rest is due when the job is done.') + '</p>';
    }
    inner += '<p style="margin:18px 0 6px;">' + btn(onlineGoogleCalLink_(hold, title), 'Add to Google Calendar', true) + btn(manage, 'Reschedule or cancel', false) + '</p>';
    inner += '<p style="margin-top:14px;font-size:13px;color:#475467;line-height:1.5;">You\'ll get a reminder the day before. Please be home for the appointment — ' +
             (hold.service === 'assessment' ? 'your service consultant will walk the property with you.' : 'we\'ll knock when we arrive and again when we\'re done.') + '</p>';
  }
  inner += '<p style="margin-top:22px;font-size:13px;color:#475467;line-height:1.5;">Questions? Just reply to this email — it goes straight to our office.</p>';
  inner += '<p style="margin-top:22px;font-size:12px;color:#98a2b3;">' + FROM_NAME + ' · 434-422-4700</p>';
  var options = { to: hold.email, subject: subject, htmlBody: emailShell(inner), replyTo: NOTIFICATION_EMAIL, from: FROM_ADDRESS, name: FROM_NAME };
  if (kind !== 'cancelled') options.attachments = [Utilities.newBlob(onlineIcs_(hold, title), 'text/calendar', 'invite.ics')];
  MailApp.sendEmail(options);
}

function onlineJobberLink_(encodedId, kind) {
  try {
    var raw = Utilities.newBlob(Utilities.base64Decode(encodedId)).getDataAsString();   // gid://Jobber/Job/123
    var n = raw.split('/').pop();
    return n ? 'https://secure.getjobber.com/' + kind + '/' + n : '';
  } catch (e) { return ''; }
}

function onlineNotifyOffice_(hold, kind, ids, prev) {
  var title = ONLINE_TITLES[hold.service] || 'Appointment';
  var colors = { booked: '#15803d', rescheduled: '#1d4ed8', cancelled: '#f59e0b' };
  var words = { booked: '📅 New online booking', rescheduled: '🔁 Online booking moved', cancelled: '❌ Online booking cancelled' };
  var inner = (typeof officeBanner_ === 'function' ? officeBanner_(hold) : '') + statusBanner(colors[kind] || '#475467', words[kind] + ' — ' + title);
  inner += '<h2 style="margin:0 0 16px;color:#1d4ed8;">' + escapeHtml(hold.name || 'Unknown') + ' · ' + escapeHtml(onlineWhen_(hold)) + '</h2>';
  if (prev) inner += '<p style="margin:0 0 12px;color:#475467;">Was: ' + escapeHtml(onlineWhen_(prev)) + '</p>';
  inner += '<table style="border-collapse:collapse;width:100%;">' + contactRows(hold.name, hold.phone, hold.email, hold.address) + '</table>';
  inner += '<table style="border-collapse:collapse;width:100%;margin-top:10px;">';
  if (hold.zip) inner += row('ZIP', escapeHtml(hold.zip));
  if (hold.miles != null && hold.miles !== '') inner += row('Crew that day', 'about ' + Math.round(Number(hold.miles)) + ' mi away' + (Number(hold.miles) > 12 ? ' ⚠️ across town' : ''));
  if (hold.notes) inner += row('Notes', escapeHtml(hold.notes));
  var jobLink = ids && ids.jobber_job_id ? onlineJobberLink_(ids.jobber_job_id, 'work_orders') : '';
  var reqLink = ids && ids.jobber_request_id ? onlineJobberLink_(ids.jobber_request_id, 'requests') : '';
  if (jobLink) inner += row('Jobber job', '<a href="' + jobLink + '">' + jobLink + '</a>');
  if (reqLink) inner += row('Jobber request', '<a href="' + reqLink + '">' + reqLink + '</a>');
  inner += '</table>';
  if (kind === 'cancelled') {
    inner += '<p style="margin:16px 0 0;line-height:1.5;">Their Jobber ' + (hold.jobber_job_id ? 'job' : 'request') +
      ' was <strong>not</strong> changed' + (hold.jobber_job_id ? ' — the deposit is still attached to it' : '') + '. Move or cancel it by hand once they rebook.</p>';
  } else if (kind === 'booked' && hold.service === 'cleaning') {
    inner += '<p style="margin:16px 0 0;font-size:13px;color:#475467;line-height:1.5;">They\'ve paid, so open their quote in Jobber and mark it <strong>Approved</strong> — the API can\'t set that status.</p>';
  }
  inner += '<p style="margin-top:16px;font-size:12px;color:#98a2b3;">Change or cancel link (same one the customer has): ' + ONLINE_MANAGE_URL + hold.id + '</p>';
  try {
    MailApp.sendEmail({ to: NOTIFICATION_EMAIL, subject: words[kind] + ': ' + (hold.name || hold.email) + ' · ' + Utilities.formatDate(new Date(hold.start_at), SCHED.timeZone, 'EEE MMM d h:mm a'),
                        htmlBody: emailShell(inner), from: FROM_ADDRESS, name: FROM_NAME });
  } catch (e) { /* never let the notification break the booking */ }
}

// ----- pick-then-pay (2026-10-22) ---------------------------------------------
// The cleaning flow is now price → details → pick a time → deposit. The time is
// a 30-minute hold in booking_holds; the checkout request carries its id and we
// pin it to the sheet row. When the deposit lands, the payment checker calls
// onlineAfterPaid_: confirm the hold (it may have expired if they paid slowly),
// schedule the Jobber job for exactly that time, and send the confirmation.

function onlineRememberHold_(holdId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(holdId || ''))) return;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var row = sheet.getLastRow();           // logLead() just appended this booking
  if (row < 2) return;
  sheet.getRange(row, JCOL.HOLD).setValue(String(holdId));
}

function onlineAfterPaid_(sheetRow, receiptUrl) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var holdId = String(sheet.getRange(sheetRow, JCOL.HOLD).getValue() || '');
  if (!holdId) return;                                   // skipped the picker: schedule.html handles it later
  if (String(sheet.getRange(sheetRow, JCOL.JOB).getValue() || '')) return;   // already on the calendar
  var lead = rowToLead(sheet.getRange(sheetRow, 1, 1, LAST_COL).getValues()[0]);
  var hold = onlineHold_(holdId);
  if (!hold || !hold.id) { jobberNotifyFailure_(lead, new Error('hold ' + holdId + ' not found'), 'finding the time they picked'); return; }
  try {
    var confirmed = onlineRpc_('booking_hold_confirm', { p_id: holdId });
    if (!confirmed || !confirmed.id) {
      // The hold expired while they paid and the time is gone. Money is in,
      // so the office picks a new time with them; the customer is told.
      onlineHoldUpdate_(holdId, { status: 'cancelled', error: 'slot lost before the deposit landed' });
      sheet.getRange(sheetRow, JCOL.SYNC).setValue('⚠️ paid, but their picked time was taken — call to reschedule');
      onlineSlotLostEmails_(hold, lead);
      return;
    }
    hold = confirmed;
    var jobId = scheduleBookingInJobber_(sheetRow, hold.start_at, hold.end_at, receiptUrl);
    var visitId = '';
    try { visitId = onlineFirstVisitId_(jobId); } catch (e) { /* only needed to move it later */ }
    var clientCell = String(sheet.getRange(sheetRow, JCOL.CLIENT).getValue() || '');
    var ids = { jobber_job_id: jobId, jobber_visit_id: visitId, jobber_client_id: clientCell.split('|')[0] };
    var patch = { status: 'booked' };
    Object.keys(ids).forEach(function (k) { if (ids[k]) patch[k] = ids[k]; });
    onlineHoldUpdate_(holdId, patch);
    hold.status = 'booked';
    onlineSendCustomerEmail_(hold, 'booked', lead);
    onlineNotifyOffice_(hold, 'booked', ids, null);
  } catch (err) {
    onlineHoldUpdate_(holdId, { error: String(err).slice(0, 400) });
    jobberNotifyFailure_(lead, err, 'scheduling the time they picked before paying');
  }
}

function onlineSlotLostEmails_(hold, lead) {
  var when = onlineWhen_(hold);
  try {
    MailApp.sendEmail({ to: NOTIFICATION_EMAIL, from: FROM_ADDRESS, name: FROM_NAME,
      subject: '⚠️ Paid, but their time slot was lost: ' + (hold.name || hold.email),
      htmlBody: emailShell(statusBanner('#f59e0b', '⚠️ Deposit received, but the time they picked (' + escapeHtml(when) + ') was taken while they paid.') +
        '<table style="border-collapse:collapse;width:100%;">' + contactRows(hold.name, hold.phone, hold.email, hold.address) + '</table>' +
        '<p style="margin:16px 0 0;line-height:1.5;">Their quote/request is in Jobber with no visit yet. Call them to set a new time, then schedule it by hand.</p>') });
  } catch (e) { /* never block */ }
  if (!hold.email) return;
  try {
    MailApp.sendEmail({ to: hold.email, replyTo: NOTIFICATION_EMAIL, from: FROM_ADDRESS, name: FROM_NAME,
      subject: 'Your deposit is in — one quick thing about the date',
      htmlBody: emailShell('<h2 style="margin:0 0 8px;color:#1d4ed8;">Thanks, ' + escapeHtml(String(hold.name || 'there').split(' ')[0]) + '! Your deposit is in.</h2>' +
        '<p style="margin:0 0 14px;color:#475467;line-height:1.5;">The time you picked (' + escapeHtml(when) + ') filled up in the few minutes it took to pay — sorry about that. ' +
        'Our office will call you today to set a new time that works. Or reply to this email with a couple of options.</p>' +
        '<p style="margin-top:22px;font-size:12px;color:#98a2b3;">' + FROM_NAME + ' · 434-422-4700</p>') });
  } catch (e) { /* never block */ }
}
