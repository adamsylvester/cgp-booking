// To add your admin, make this a comma-separated list:
// 'adam@cvillegutterpros.com, admin@cvillegutterpros.com'
const NOTIFICATION_EMAIL = 'adam@cvillegutterpros.com';
const FROM_ADDRESS = 'adam@cvillegutterpros.com';
const FROM_NAME = 'Charlottesville Gutter Pros';
// Calendly event used to schedule the PAID cleaning (post-deposit). This is the
// gutter-cleaning calendar, NOT the assessment calendar on the booking page.
const CALENDLY_URL = 'https://calendly.com/gutterpros/gutter-cleaning';
// Deposit = 25% of the quoted total, rounded to a whole dollar.
const DEPOSIT_RATE = 0.25;
const OUTSIDE_AREA_FEE = 50;
// A checkout still unpaid after this many minutes is marked Abandoned and the
// office gets a follow-up email (once). If they pay later it flips to PAID.
const ABANDONED_AFTER_MIN = 45;
// The payment checker only looks at pending rows newer than this.
const PENDING_MAX_AGE_DAYS = 7;

// ===== Square =====
// The access token lives in Script Properties (key: SQUARE_ACCESS_TOKEN).
// The location ID is fetched from Square once and cached in Script Properties.
const SQUARE_API_BASE = 'https://connect.squareup.com';
const SQUARE_VERSION = '2025-01-23';
// Where Square sends the customer after paying (then thanks.html -> Calendly).
const AFTER_PAYMENT_URL = 'https://book.cvillegutterpros.com/thanks.html';

// ===== Server-side pricing (AUTHORITATIVE) =====
// This mirrors the PRICING config in index.html. The server recomputes every
// quote from raw inputs and charges ITS number — the browser's number is only
// used to detect mismatches. If you change pricing, change BOTH places.
const PRICING = {
  addonMultiplier: 0.5,
  protectionMultiplier: 3,
  houses: {
    simple:    { floor: 99,  modifier: { '1': 0.07, '2': 0.09, '3': 0.11 } },
    standard:  { floor: 149, modifier: { '1': 0.09, '2': 0.14, '3': 0.19 } },
    complex:   { floor: 229, modifier: { '1': 0.11, '2': 0.17, '3': 0.18 } },
    townhome2: { flat: 195 },
    townhome3: { flat: 325 },
  },
};

// Charlottesville + Albemarle ZIPs (no trip fee). Mirrors index.html.
const IN_AREA_ZIPS = {
  '22901': 1, '22902': 1, '22903': 1, '22904': 1, '22905': 1, '22906': 1,
  '22907': 1, '22908': 1, '22909': 1, '22910': 1, '22911': 1,
  '22924': 1, '22931': 1, '22932': 1, '22936': 1, '22937': 1, '22940': 1,
  '22943': 1, '22945': 1, '22946': 1, '22947': 1, '22959': 1, '22987': 1,
  '24590': 1,
};

// ===== Sheet columns (1-based) =====
const COL = {
  TIMESTAMP: 1, NAME: 2, PHONE: 3, EMAIL: 4, ADDRESS: 5, HOUSE: 6, SQFT: 7,
  STORIES: 8, PLAN: 9, OUTSIDE: 10, NOTES: 11, BASE: 12, TOTAL: 13,
  USER_AGENT: 14, PAGE: 15, ZIP: 16, DEPOSIT: 17, STATUS: 18, ORDER_ID: 19,
  PAID_AT: 20, PAYMENT_LINK: 21, PRICE_CHECK: 22,
};
const LAST_COL = 22;

const STATUS = {
  STARTED: '⏳ Checkout started',
  PAID: '✅ PAID',
  ABANDONED: '📞 Abandoned — follow up',
  FALLBACK: '⚠️ Sent to flat $25 link',
};

// Map the form's houseType codes to friendly labels.
const HOUSE_LABELS = {
  simple: 'Simple house',
  standard: 'Standard house',
  complex: 'Complex house',
  townhome2: '2-Story Townhome',
  townhome3: '3-Story Townhome',
};

function houseLabel(code) {
  return HOUSE_LABELS[code] || (code || '');
}

// ===== Pricing engine =====

// Returns {base, total, deposit, fee} or null if the inputs don't add up.
function computeServerPrice(data) {
  var cfg = PRICING.houses[data.houseType];
  if (!cfg) return null;

  var base;
  if (cfg.flat != null) {
    base = cfg.flat;
  } else {
    var sqft = Number(data.sqft);
    var rate = cfg.modifier[String(data.stories)];
    if (!sqft || sqft <= 0 || !rate) return null;
    base = Math.max(cfg.floor, Math.round(rate * sqft));
  }

  var subtotal = base;
  if (data.plan === 'simple') subtotal = base + Math.round(base * PRICING.addonMultiplier);
  else if (data.plan === 'protection') subtotal = Math.round(base * PRICING.protectionMultiplier);

  var zip = String(data.zip || '').replace(/\D/g, '');
  var fee = IN_AREA_ZIPS[zip] ? 0 : OUTSIDE_AREA_FEE;

  var total = subtotal + fee;
  return { base: base, total: total, fee: fee, deposit: Math.round(total * DEPOSIT_RATE) };
}

function depositFor(data) {
  var explicit = Number(data.deposit);
  if (explicit > 0) return Math.round(explicit);
  return Math.round(Number(data.finalPrice || 0) * DEPOSIT_RATE);
}

// ===== Web app entry points =====

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    // Calendly posts its own payload shape (no "action"), so it's recognized by
    // its event field rather than by us adding one.
    if (data.event && data.payload) {
      return jsonOutput(handleCalendlyWebhook_(data, (e && e.parameter) || {}));
    }

    var action = data.action || 'lead';

    // Funnel analytics. Deliberately first and self-contained: a tracking
    // failure must never touch checkout, so it can't throw past this block.
    if (action === 'event') {
      try { logEvent_(data); } catch (err) { /* analytics is never load-bearing */ }
      return jsonOutput({ ok: true });
    }

    // CompanyCam booking snapshots. Self-contained like analytics: a snapshot
    // failure must never touch checkout. The payload deliberately carries no
    // name/email/phone, so a deployment older than this code ignores it via
    // the lead guard below instead of fabricating a lead row.
    if (action === 'snapshot') {
      try {
        return jsonOutput(ccSaveSnapshot_(data));
      } catch (err) {
        return jsonOutput({ ok: false, error: String(err) });
      }
    }

    if (action === 'confirm') {
      sendBuyerConfirmationEmail(data);
      return jsonOutput({ ok: true });
    }

    if (action === 'checkout') {
      // Server recomputes the price from raw inputs and charges ITS number.
      var priced = computeServerPrice(data);
      var priceCheck;
      if (!priced) {
        priceCheck = '⚠️ could not verify (bad inputs) — charged client price';
      } else if (Number(data.finalPrice) === priced.total && depositFor(data) === priced.deposit) {
        priceCheck = '✓ verified';
      } else {
        priceCheck = '⚠️ MISMATCH: client sent $' + data.finalPrice +
                     ', server computed $' + priced.total + ' — charged server price';
        data.finalPrice = priced.total;
        data.deposit = priced.deposit;
        data.basePrice = priced.base;
        data.outsideArea = priced.fee > 0;
      }

      try {
        var link = createSquareCheckout(data);
        logLead(data, STATUS.STARTED, link.orderId, priceCheck);
        sendCheckoutStartedEmail(data, priceCheck);
        return jsonOutput({ ok: true, checkoutUrl: link.url });
      } catch (err) {
        // Square failed — log it so the row still exists, page falls back to
        // the flat $25 link.
        logLead(data, STATUS.FALLBACK, '', priceCheck);
        sendCheckoutStartedEmail(data, priceCheck + ' · Square link failed, customer sent to flat $25 link');
        return jsonOutput({ ok: false, error: String(err) });
      }
    }

    // 'lead' — fallback beacon fired when the page couldn't reach this script.
    // Guard: only an actual lead gets logged and emailed. Without this, ANY
    // unrecognised action (e.g. a newer page sending an action this deployment
    // doesn't know yet) falls in here and fabricates a lead row plus an email.
    // That is exactly what happens during the window where the site has been
    // updated but this script hasn't — so fail quietly instead.
    if (!data.name && !data.email && !data.phone) {
      return jsonOutput({ ok: false, ignored: String(action || '').slice(0, 40) });
    }
    logLead(data, STATUS.FALLBACK, '', '');
    sendCheckoutStartedEmail(data, 'Fallback path — customer sent to flat $25 link');
    return jsonOutput({ ok: true });
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  var p = (e && e.parameter) || {};

  // Read the funnel events. The leads spreadsheet stays PRIVATE — it holds
  // customer names, emails, phones and addresses — so the dashboard can't use
  // the public-CSV trick the other sheets use. It asks this endpoint instead,
  // which only ever exposes the Events tab (counts and drop-off, no people).
  if (p.events === '1' || p.action === 'events') {
    try {
      return jsonOutput(readEvents_(p));
    } catch (err) {
      return jsonOutput({ ok: false, error: String(err) });
    }
  }

  // Read-only pricing config for the admin quote calculator in the team app.
  // No PII — the same tables the page and the checkout verifier already use.
  // Serving them from here keeps one source of truth: change PRICING above
  // and the admin tool follows on its next load.
  if (p.pricing === '1' || p.action === 'pricing') {
    return jsonOutput({
      ok: true,
      pricing: PRICING,
      inAreaZips: Object.keys(IN_AREA_ZIPS),
      depositRate: DEPOSIT_RATE,
      outsideAreaFee: OUTSIDE_AREA_FEE,
      houseLabels: HOUSE_LABELS,
      planLabels: { basic: 'Basic Cleaning',
                    simple: 'Basic + Seasonal Touch-Ups',
                    protection: 'Gutter Protection Plan' },
    });
  }

  return ContentService.createTextOutput('CGP booking endpoint is alive.');
}

// Optional lock: set Script Property EVENTS_READ_KEY and callers must pass
// ?key=... . Left unset it stays open, which is fine for counts with no PII —
// this exists so it can be hardened later without a code change.
function readEvents_(p) {
  var wanted = PropertiesService.getScriptProperties().getProperty('EVENTS_READ_KEY');
  if (wanted && String(p.key || '') !== wanted) return { ok: false, error: 'bad_key' };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EVENTS_SHEET_NAME);
  if (!sheet) return { ok: true, columns: [], rows: [] };

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, columns: [], rows: [] };

  // Newest-last. Cap the payload so a busy month can't time the request out.
  var limit = Math.min(Number(p.limit) || EVENTS_MAX_ROWS, EVENTS_MAX_ROWS);
  var firstRow = Math.max(2, lastRow - limit + 1);
  var width = sheet.getLastColumn();

  var header = sheet.getRange(1, 1, 1, width).getValues()[0];
  var vals = sheet.getRange(firstRow, 1, lastRow - firstRow + 1, width).getValues();

  var since = null;
  if (p.since) {
    var d = new Date(p.since);
    if (!isNaN(d)) since = d;
  }

  var rows = [];
  for (var i = 0; i < vals.length; i++) {
    var ts = vals[i][0];
    if (since && ts instanceof Date && ts < since) continue;
    rows.push([
      ts instanceof Date ? Utilities.formatDate(ts, SCHED_TZ_FOR_EVENTS, "yyyy-MM-dd'T'HH:mm:ss") : String(ts),
      String(vals[i][1] || ''), String(vals[i][2] || ''), String(vals[i][3] || ''),
      String(vals[i][4] || ''), String(vals[i][5] || ''), String(vals[i][6] || ''),
      String(vals[i][7] || ''), vals[i][8] === '' ? null : Number(vals[i][8]),
      String(vals[i][9] || ''),
    ]);
  }
  return { ok: true, columns: header, rows: rows, returned: rows.length, sheetRows: lastRow - 1 };
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ===========================================================================
// FUNNEL ANALYTICS
// ===========================================================================
// The leads sheet only gets a row once someone reaches checkout, so it can
// answer "how many bought?" but never "how many looked and left, and where
// did they stop?". These events fill in everything above checkout.
//
// One row per event, stitched by a per-visit session id generated in the
// browser. No names, emails, phones or addresses are recorded here — this
// tab is about counts and drop-off, not people.
const EVENTS_SHEET_NAME = 'Events';
const EVENTS_MAX_ROWS = 5000;
// jobber_sync.gs owns SCHED.timeZone, but this file must work even if that
// file is absent, so the timezone is named here independently.
const SCHED_TZ_FOR_EVENTS = 'America/New_York';

function logEvent_(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(EVENTS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(EVENTS_SHEET_NAME);
    sheet.appendRow(['Timestamp', 'Event', 'Session', 'Device', 'Page', 'Referrer',
                     'House', 'Plan', 'Price', 'Detail']);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 10).setFontWeight('bold')
         .setFontColor('#ffffff').setBackground('#0f766e');
    sheet.setColumnWidth(1, 160);
    sheet.setColumnWidth(2, 150);
  }

  sheet.appendRow([
    new Date(),
    String(data.event || '').slice(0, 60),
    String(data.session || '').slice(0, 40),
    String(data.device || '').slice(0, 20),
    String(data.page || '').slice(0, 200),
    String(data.referrer || '').slice(0, 200),
    String(data.house || '').slice(0, 40),
    String(data.plan || '').slice(0, 60),
    data.price === undefined || data.price === null || data.price === '' ? '' : Number(data.price),
    String(data.detail || '').slice(0, 200),
  ]);
}

function logLead(data, status, orderId, priceCheck) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  sheet.appendRow([
    data.timestamp || new Date().toISOString(),
    data.name || '',
    data.phone || '',
    data.email || '',
    data.address || '',
    houseLabel(data.houseType),
    data.sqft || '',
    data.stories || '',
    data.planName || data.plan || '',
    data.outsideArea ? 'Yes (+$' + OUTSIDE_AREA_FEE + ')' : 'No',
    data.notes || '',
    data.basePrice || '',
    data.finalPrice || '',
    data.userAgent || '',
    data.page || '',
    data.zip || '',
    depositFor(data) || '',
    status || '',
    orderId || '',
    '', // paid at
    '', // payment link
    priceCheck || ''
  ]);
}

// ===== Square checkout =====

// Creates a one-off Square payment link for exactly this customer's deposit.
// Returns { url, orderId }.
function createSquareCheckout(data) {
  var token = PropertiesService.getScriptProperties().getProperty('SQUARE_ACCESS_TOKEN');
  if (!token) throw new Error('SQUARE_ACCESS_TOKEN script property is not set');

  var deposit = depositFor(data);
  if (!(deposit >= 1)) throw new Error('Invalid deposit amount: ' + deposit);

  var body = {
    idempotency_key: Utilities.getUuid(),
    quick_pay: {
      name: 'Gutter Cleaning Deposit — ' + (data.planName || 'Booking') +
            ' (25% of $' + Number(data.finalPrice || 0) + ')',
      price_money: { amount: deposit * 100, currency: 'USD' },
      location_id: getSquareLocationId(token),
    },
    checkout_options: {
      redirect_url: AFTER_PAYMENT_URL,
      ask_for_shipping_address: false,
    },
  };

  var prePopulated = {};
  if (data.email) prePopulated.buyer_email = String(data.email).trim();
  var phone = toE164(data.phone);
  if (phone) prePopulated.buyer_phone_number = phone;
  if (Object.keys(prePopulated).length) body.pre_populated_data = prePopulated;

  var result = squareRequest(token, 'POST', '/v2/online-checkout/payment-links', body);
  if (!result.payment_link || !result.payment_link.url) {
    throw new Error('Square did not return a payment link URL');
  }
  return { url: result.payment_link.url, orderId: result.payment_link.order_id || '' };
}

// First ACTIVE Square location, cached in Script Properties after the first lookup.
function getSquareLocationId(token) {
  var props = PropertiesService.getScriptProperties();
  var cached = props.getProperty('SQUARE_LOCATION_ID');
  if (cached) return cached;

  var result = squareRequest(token, 'GET', '/v2/locations', null);
  var locations = (result.locations || []).filter(function(loc) {
    return loc.status === 'ACTIVE';
  });
  if (!locations.length) throw new Error('No active Square locations found');

  props.setProperty('SQUARE_LOCATION_ID', locations[0].id);
  return locations[0].id;
}

function squareRequest(token, method, path, body) {
  var options = {
    method: method.toLowerCase(),
    headers: {
      'Authorization': 'Bearer ' + token,
      'Square-Version': SQUARE_VERSION,
    },
    contentType: 'application/json',
    muteHttpExceptions: true,
  };
  if (body) options.payload = JSON.stringify(body);

  var response = UrlFetchApp.fetch(SQUARE_API_BASE + path, options);
  var code = response.getResponseCode();
  var parsed = JSON.parse(response.getContentText() || '{}');
  if (code < 200 || code >= 300) {
    var detail = parsed.errors && parsed.errors.length
      ? parsed.errors.map(function(e) { return e.code + ': ' + e.detail; }).join('; ')
      : response.getContentText();
    throw new Error('Square API ' + code + ' — ' + detail);
  }
  return parsed;
}

// Square requires E.164 phone numbers (e.g. +14345551234); returns '' if unusable.
function toE164(raw) {
  var digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.charAt(0) === '1') return '+' + digits;
  return '';
}

// ===== Payment checker (runs every minute via time trigger) =====
// Flips pending rows to PAID the moment the deposit lands (with receipt link),
// or to Abandoned after ABANDONED_AFTER_MIN minutes — each with an instant email.

function checkPendingPayments() {
  // Once a day, nag the office about paid bookings whose quote never became a
  // job (customer skipped Calendly). Lives in jobber_sync.gs; the typeof guard
  // keeps this file working if that file is ever removed.
  if (typeof jobberDailyStuckSweep_ === 'function') {
    try { jobberDailyStuckSweep_(); } catch (e) { /* never block payments */ }
  }

  // Self-installs the hourly CompanyCam snapshot sync the first minute this
  // code runs (property-guarded, so the steady-state cost is one property read).
  try { ccEnsureSnapshotTrigger_(); } catch (e) { /* never block payments */ }

  var token = PropertiesService.getScriptProperties().getProperty('SQUARE_ACCESS_TOKEN');
  if (!token) return;

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var firstRow = Math.max(2, lastRow - 249);
  var values = sheet.getRange(firstRow, 1, lastRow - firstRow + 1, LAST_COL).getValues();
  var now = new Date();

  var pending = [];
  values.forEach(function(rowVals, i) {
    var status = String(rowVals[COL.STATUS - 1]);
    var orderId = String(rowVals[COL.ORDER_ID - 1]);
    if (!orderId) return;
    if (status !== STATUS.STARTED && status !== STATUS.ABANDONED) return;
    var ts = new Date(rowVals[COL.TIMESTAMP - 1]);
    if (isNaN(ts) || (now - ts) > PENDING_MAX_AGE_DAYS * 86400000) return;
    pending.push({ sheetRow: firstRow + i, vals: rowVals, orderId: orderId, ts: ts, status: status });
  });
  if (!pending.length) return;

  var locationId = getSquareLocationId(token);
  var orders = {};
  for (var i = 0; i < pending.length; i += 100) {
    var ids = pending.slice(i, i + 100).map(function(p) { return p.orderId; });
    var result = squareRequest(token, 'POST', '/v2/orders/batch-retrieve', {
      location_id: locationId,
      order_ids: ids,
    });
    (result.orders || []).forEach(function(o) { orders[o.id] = o; });
  }

  pending.forEach(function(p) {
    var order = orders[p.orderId];
    var tender = order && order.tenders && order.tenders.length ? order.tenders[0] : null;

    if (tender) {
      var paymentId = tender.payment_id || tender.id || '';
      var receiptUrl = paymentId
        ? 'https://squareup.com/dashboard/sales/transactions/' + paymentId
        : '';
      sheet.getRange(p.sheetRow, COL.STATUS).setValue(STATUS.PAID);
      sheet.getRange(p.sheetRow, COL.PAID_AT).setValue(new Date());
      if (receiptUrl) sheet.getRange(p.sheetRow, COL.PAYMENT_LINK).setValue(receiptUrl);
      sendPaidEmail(rowToLead(p.vals), receiptUrl);
      // Real money in -> real records in Jobber. Failures land in the sheet's
      // "Jobber sync" column and email the office; they never block payment.
      if (jobberSyncEnabled_()) {
        pushBookingToJobber_(rowToLead(p.vals), p.sheetRow, receiptUrl);
      }
    } else if (p.status === STATUS.STARTED && (now - p.ts) > ABANDONED_AFTER_MIN * 60000) {
      sheet.getRange(p.sheetRow, COL.STATUS).setValue(STATUS.ABANDONED);
      sendAbandonedEmail(rowToLead(p.vals));
    }
  });
}

function rowToLead(vals) {
  return {
    timestamp: vals[COL.TIMESTAMP - 1],
    name: vals[COL.NAME - 1],
    phone: vals[COL.PHONE - 1],
    email: vals[COL.EMAIL - 1],
    address: vals[COL.ADDRESS - 1],
    house: vals[COL.HOUSE - 1],
    sqft: vals[COL.SQFT - 1],
    stories: vals[COL.STORIES - 1],
    plan: vals[COL.PLAN - 1],
    outside: String(vals[COL.OUTSIDE - 1]).indexOf('Yes') === 0,
    zip: vals[COL.ZIP - 1],
    notes: vals[COL.NOTES - 1],
    base: vals[COL.BASE - 1],
    total: vals[COL.TOTAL - 1],
    deposit: vals[COL.DEPOSIT - 1],
    userAgent: vals[COL.USER_AGENT - 1],
    page: vals[COL.PAGE - 1],
  };
}

// Run this ONCE from the editor to install the every-minute payment checker.
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'checkPendingPayments') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkPendingPayments').timeBased().everyMinutes(1).create();
  Logger.log('Payment checker installed — runs every minute.');
}

// ===== Emails =====

function escapeHtml(s) {
  var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s).replace(/[&<>"']/g, function(c) { return map[c]; });
}

function row(label, value) {
  return '<tr><td style="padding:6px 0;color:#475467;width:170px;">' + label + '</td><td style="padding:6px 0;">' + value + '</td></tr>';
}

function rowBold(label, value) {
  return '<tr><td style="padding:6px 0;color:#475467;width:170px;">' + label + '</td><td style="padding:6px 0;"><strong>' + value + '</strong></td></tr>';
}

function statusBanner(color, text) {
  return '<div style="padding:12px 16px;border-radius:12px;background:' + color +
         ';color:#fff;font-weight:700;font-size:15px;margin-bottom:16px;">' + text + '</div>';
}

function quoteSummaryRows(data) {
  var total = Number(data.finalPrice || 0);
  var deposit = depositFor(data);
  var balance = Math.max(0, total - deposit);

  var html = '';
  html += row('Home type', escapeHtml(houseLabel(data.houseType)));
  if (data.sqft) html += row('Square footage', Number(data.sqft).toLocaleString());
  if (data.stories) html += row('Stories', escapeHtml(String(data.stories)));
  html += row('Plan', escapeHtml(data.planName || data.plan || ''));
  if (data.zip) html += row('ZIP code', escapeHtml(String(data.zip)));
  if (data.outsideArea) html += row('Trip fee (outside area)', '+$' + OUTSIDE_AREA_FEE);
  html += rowBold('Total price', '$' + total);
  html += row('Deposit (25%)', '$' + deposit);
  html += rowBold('Balance on completion', '$' + balance);
  return html;
}

// Every input + every dollar line, for the office emails. Accepts a normalized
// object: {timestamp, house, sqft, stories, zip, outside, plan, base, total, deposit}.
function fullBreakdownRows(o) {
  var base = Number(o.base || 0);
  var total = Number(o.total || 0);
  var deposit = Number(o.deposit || 0);
  var fee = o.outside ? OUTSIDE_AREA_FEE : 0;
  var planUpgrade = total - fee - base;
  var balance = Math.max(0, total - deposit);

  var html = '';
  html += sectionHead('Their inputs') + '<table style="border-collapse:collapse;width:100%;">';
  html += row('Home type', escapeHtml(String(o.house || '')));
  html += row('Square footage', o.sqft ? Number(o.sqft).toLocaleString() : 'n/a (flat-priced townhome)');
  html += row('Stories', o.stories ? escapeHtml(String(o.stories)) : 'n/a (flat-priced townhome)');
  html += row('ZIP code', escapeHtml(String(o.zip || '—')));
  html += row('Service area', o.outside ? 'Outside Cville/Albemarle (trip fee applies)' : 'In service area (no trip fee)');
  html += row('Plan chosen', escapeHtml(String(o.plan || '')));
  html += '</table>';

  html += sectionHead('Price math') + '<table style="border-collapse:collapse;width:100%;">';
  html += row('Base cleaning', '$' + base);
  if (planUpgrade > 0) html += row('Plan upgrade', '+$' + planUpgrade);
  html += row('Trip fee', fee ? '+$' + fee : '$0');
  html += rowBold('Total price', '$' + total);
  html += row('Deposit (25%)', '$' + deposit);
  html += rowBold('Balance on completion', '$' + balance);
  html += '</table>';
  return html;
}

// Submission metadata footer (timestamp, device, page).
function metaFooter(o) {
  var device = String(o.userAgent || '');
  var short = /iPhone|iPad/.test(device) ? 'iPhone/iPad' :
              /Android/.test(device) ? 'Android' :
              /Macintosh/.test(device) ? 'Mac' :
              /Windows/.test(device) ? 'Windows PC' : (device ? 'Other' : '');
  var bits = [];
  if (o.timestamp) bits.push('Submitted ' + escapeHtml(String(o.timestamp)));
  if (short) bits.push('Device: ' + short);
  if (o.page) bits.push('Page: ' + escapeHtml(String(o.page)));
  bits.push('Full row in the CGP Booking Leads sheet.');
  return '<p style="margin-top:18px;font-size:12px;color:#667085;">' + bits.join('<br>') + '</p>';
}

function contactRows(name, phone, email, address) {
  var html = '';
  html += rowBold('Name', escapeHtml(name || 'Unknown'));
  html += row('Phone', '<a href="tel:' + escapeHtml(phone || '') + '">' + escapeHtml(phone || '') + '</a>');
  html += row('Email', '<a href="mailto:' + escapeHtml(email || '') + '">' + escapeHtml(email || '') + '</a>');
  if (address) html += row('Address', escapeHtml(address));
  return html;
}

function emailShell(inner) {
  return '<div style="font-family:Arial,sans-serif;color:#101828;max-width:560px;">' + inner + '</div>';
}

function sectionHead(text) {
  return '<h3 style="margin:18px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:#475467;">' + text + '</h3>';
}

// --- "Checkout started" (instant, at pay-button click — NOT yet paid) ---
function sendCheckoutStartedEmail(data, priceCheck) {
  var name = data.name || 'Unknown';
  var deposit = depositFor(data);

  var inner = '';
  inner += statusBanner('#f59e0b', '⏳ Checkout started — NOT paid yet. You\'ll get a ✅ PAID email the moment the $' + deposit + ' deposit lands.');
  inner += '<h2 style="margin:0 0 16px;color:#1d4ed8;">' + escapeHtml(name) + ' — $' + Number(data.finalPrice || 0) + ' quote</h2>';
  inner += sectionHead('Customer');
  inner += '<table style="border-collapse:collapse;width:100%;">' + contactRows(data.name, data.phone, data.email, data.address) + '</table>';
  inner += fullBreakdownRows({
    house: houseLabel(data.houseType), sqft: data.sqft, stories: data.stories,
    zip: data.zip, outside: !!data.outsideArea, plan: data.planName || data.plan,
    base: data.basePrice, total: data.finalPrice, deposit: deposit,
  });
  if (priceCheck) inner += '<p style="margin-top:10px;font-size:13px;color:' + (priceCheck.indexOf('✓') === 0 ? '#15803d' : '#b42318') + ';font-weight:700;">Price check: ' + escapeHtml(priceCheck) + '</p>';
  var notes = (data.notes || '').trim();
  if (notes) {
    inner += sectionHead('Customer notes');
    inner += '<p style="margin:0;line-height:1.5;white-space:pre-wrap;">' + escapeHtml(notes) + '</p>';
  }
  inner += metaFooter(data);

  MailApp.sendEmail({
    to: NOTIFICATION_EMAIL,
    subject: '⏳ Checkout started: ' + name + ' — $' + Number(data.finalPrice || 0) + ' (not paid yet)',
    htmlBody: emailShell(inner),
    replyTo: data.email || undefined,
    from: FROM_ADDRESS,
    name: FROM_NAME
  });
}

// --- "PAID" (instant, from the payment checker) ---
function sendPaidEmail(lead, receiptUrl) {
  var balance = Math.max(0, Number(lead.total || 0) - Number(lead.deposit || 0));

  var inner = '';
  inner += statusBanner('#16a34a', '✅ PAID — $' + lead.deposit + ' deposit received. This booking is real.');
  inner += '<h2 style="margin:0 0 16px;color:#1d4ed8;">' + escapeHtml(lead.name) + ' — $' + lead.total + ' ' + escapeHtml(String(lead.plan)) + '</h2>';
  inner += sectionHead('Customer');
  inner += '<table style="border-collapse:collapse;width:100%;">' + contactRows(lead.name, lead.phone, lead.email, lead.address) + '</table>';
  inner += fullBreakdownRows(lead);
  inner += sectionHead('Money status');
  inner += '<table style="border-collapse:collapse;width:100%;">';
  inner += rowBold('Deposit paid today', '$' + lead.deposit);
  inner += rowBold('Balance to collect on completion', '$' + balance);
  inner += '</table>';
  if (receiptUrl) {
    inner += '<p style="margin:16px 0 0;"><a href="' + receiptUrl + '" style="display:inline-block;padding:12px 20px;background:#1d4ed8;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">View payment in Square</a></p>';
  }
  inner += '<p style="margin-top:16px;font-size:13px;color:#475467;">They\'re being sent to Calendly to pick their date — watch for the calendar invite. ' +
           'They\'ve paid, so open their quote in Jobber and mark it <strong>Approved</strong> — ' +
           'the API can\'t set that status, so it stays “Awaiting response” until someone clicks it.</p>';
  inner += metaFooter(lead);

  MailApp.sendEmail({
    to: NOTIFICATION_EMAIL,
    subject: '✅ PAID: ' + lead.name + ' — $' + lead.deposit + ' deposit in ($' + lead.total + ' total)',
    htmlBody: emailShell(inner),
    replyTo: lead.email || undefined,
    from: FROM_ADDRESS,
    name: FROM_NAME
  });
}

// --- "Abandoned" (instant once the 45-minute window passes) ---
function sendAbandonedEmail(lead) {
  var inner = '';
  inner += statusBanner('#dc2626', '📞 Abandoned checkout — quoted but never paid. Worth a follow-up call.');
  inner += '<h2 style="margin:0 0 16px;color:#1d4ed8;">' + escapeHtml(lead.name) + ' — $' + lead.total + ' quote on the table</h2>';
  inner += sectionHead('Customer');
  inner += '<table style="border-collapse:collapse;width:100%;">' + contactRows(lead.name, lead.phone, lead.email, lead.address) + '</table>';
  inner += fullBreakdownRows(lead);
  var notes = String(lead.notes || '').trim();
  if (notes) {
    inner += sectionHead('Their notes');
    inner += '<p style="margin:0;line-height:1.5;white-space:pre-wrap;">' + escapeHtml(notes) + '</p>';
  }
  inner += '<p style="margin-top:16px;font-size:13px;color:#475467;">If they pay later, this flips to ✅ PAID automatically — no action needed on the sheet.</p>';
  inner += metaFooter(lead);

  MailApp.sendEmail({
    to: NOTIFICATION_EMAIL,
    subject: '📞 Follow up: ' + lead.name + ' — quoted $' + lead.total + ', didn\'t pay',
    htmlBody: emailShell(inner),
    replyTo: lead.email || undefined,
    from: FROM_ADDRESS,
    name: FROM_NAME
  });
}

// --- Buyer confirmation (unchanged behavior, fired by thanks.html) ---
function buildBuyerEmailHtml(data) {
  var name = escapeHtml(data.name || 'there');
  var firstName = name.split(' ')[0];
  var deposit = depositFor(data);

  var inner = '';
  inner += '<h2 style="margin:0 0 8px;color:#1d4ed8;">Thanks, ' + firstName + '! Your $' + deposit + ' deposit is in.</h2>';
  inner += '<p style="margin:0 0 18px;color:#475467;line-height:1.5;">';
  inner += 'We are on the books for your gutter cleaning, and your service date is set. Our crew will take it from there - you will get a reminder before we head your way.';
  inner += '</p>';
  inner += sectionHead('Your quote');
  inner += '<table style="border-collapse:collapse;width:100%;">' + quoteSummaryRows(data) + '</table>';
  inner += '<p style="margin-top:22px;font-size:13px;color:#475467;line-height:1.5;">';
  inner += 'Questions? Just reply to this email - it goes straight to our office.';
  inner += '</p>';
  inner += '<p style="margin-top:22px;font-size:12px;color:#98a2b3;">Charlottesville Gutter Pros</p>';
  return emailShell(inner);
}

function sendBuyerConfirmationEmail(data) {
  var to = data.email;
  if (!to) return;
  MailApp.sendEmail({
    to: to,
    subject: 'Your gutter cleaning booking is confirmed',
    htmlBody: buildBuyerEmailHtml(data),
    replyTo: NOTIFICATION_EMAIL,
    from: FROM_ADDRESS,
    name: FROM_NAME
  });
}

// ===== One-off helpers =====

// Run manually to confirm the Square connection works end-to-end.
// Logs a test payment-link URL (open it, DON'T pay it).
function testSquareConnection() {
  var link = createSquareCheckout({
    planName: 'Connection Test',
    finalPrice: 100,
    deposit: 25,
    email: NOTIFICATION_EMAIL,
  });
  Logger.log('Square OK — test checkout link: ' + link.url + ' (order ' + link.orderId + ')');
}

function setupSheet() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var headers = [
    'Timestamp', 'Name', 'Phone', 'Email', 'Address',
    'Home type', 'Sq ft', 'Stories', 'Plan', 'Outside area',
    'Notes', 'Base price', 'Final price', 'User agent', 'Page',
    'ZIP', 'Deposit', 'Status', 'Square order', 'Paid at',
    'Payment', 'Price check'
  ];

  sheet.getRange(1, 1, 1, LAST_COL).setValues([headers]);
  sheet.setFrozenRows(1);

  var header = sheet.getRange(1, 1, 1, LAST_COL);
  header.setFontWeight('bold');
  header.setFontColor('#ffffff');
  header.setBackground('#1d4ed8');
  header.setHorizontalAlignment('left');
  header.setVerticalAlignment('middle');
  sheet.setRowHeight(1, 36);

  // Base price = L, Final price = M, Deposit = Q.
  ['L', 'M', 'Q'].forEach(function(col) {
    sheet.getRange(col + '2:' + col).setNumberFormat('"$"#,##0');
  });
  sheet.getRange('A2:A').setNumberFormat('yyyy-mm-dd hh:mm');
  sheet.getRange('T2:T').setNumberFormat('yyyy-mm-dd hh:mm');

  var range = sheet.getRange(1, 1, Math.max(2, sheet.getLastRow()), LAST_COL);
  range.getBandings().forEach(function(b) { b.remove(); });
  var banding = range.applyRowBanding(SpreadsheetApp.BandingTheme.BLUE, true, false);
  banding.setHeaderRowColor('#1d4ed8');
  banding.setFirstRowColor('#ffffff');
  banding.setSecondRowColor('#f1f5fb');

  var existing = sheet.getFilter();
  if (existing) existing.remove();
  sheet.getRange(1, 1, sheet.getMaxRows(), LAST_COL).createFilter();

  for (var c = 1; c <= LAST_COL; c++) {
    sheet.autoResizeColumn(c);
  }
}

// ===========================================================================
// COMPANYCAM BOOKING SNAPSHOTS
// ===========================================================================
// At pay-click the booking page captures two images — a literal screenshot of
// the filled-out quote card and a drawn "Order Summary" card — and POSTs them
// here (action:'snapshot'). The images are stored in the public Supabase
// bucket `booking-snapshots` (CompanyCam ingests photos by public URL, and its
// image proxy keeps referencing the source URL afterwards, so objects must
// stay put) and a row is queued in the CC Photo Queue tab.
//
// Every hour ccSyncSnapshots() attaches the queued photos to the customer's
// CompanyCam project — but only once the deposit is PAID (an abandoned
// checkout must never drop "what they ordered" photos into an existing
// client's project) and a CompanyCam project exists at that address.
//
// Script Properties used: SUPABASE_URL (shared with SpecialNotes.gs),
// SUPABASE_SERVICE_KEY, CC_ACCESS_TOKEN.

const CC_API_BASE = 'https://api.companycam.com/v2';
const CC_BUCKET = 'booking-snapshots';
const CC_QUEUE_SHEET_NAME = 'CC Photo Queue';
const CC_QUEUE_MAX_AGE_DAYS = 45;
const CC_QUEUE_SCAN_ROWS = 200;  // pending queue rows examined per hourly run
const CC_LEAD_SCAN_ROWS = 600;   // recent lead rows searched for the PAID match

const CC_STATUS = {
  WAITING: '⏳ Waiting',
  DONE: '✅ Uploaded',
  EXPIRED: '⌛ Expired (never matched)',
};

// Queue sheet columns (1-based).
const CC_QCOL = { TS: 1, ADDRESS: 2, ZIP: 3, IMAGES: 4, STATUS: 5, PROJECT: 6,
                  UPLOADED: 7, NOTE: 8 };

// Street suffixes vary between systems ("Drive" vs "Dr"), so the address key
// drops them: house number + first 6 chars of the street name + ZIP. Ported
// from companycam_labels.py in the jobber-dashboard repo — keep them in step.
const CC_ADDR_SUFFIXES = { street: 1, st: 1, road: 1, rd: 1, drive: 1, dr: 1,
  lane: 1, ln: 1, avenue: 1, ave: 1, court: 1, ct: 1, circle: 1, cir: 1,
  place: 1, pl: 1, trail: 1, trl: 1, boulevard: 1, blvd: 1, highway: 1,
  hwy: 1, way: 1, terrace: 1, ter: 1, run: 1 };

function ccAddrKey_(street, postal) {
  var s = String(street || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')
            .replace(/ +/g, ' ').trim();
  if (!s) return null;
  var parts = s.split(' ');
  var num = /^\d+$/.test(parts[0]) ? parts[0] : '';
  var words = parts.slice(1).filter(function(w) {
    return !CC_ADDR_SUFFIXES[w] && !/^\d+$/.test(w);
  });
  var stem = words.length ? words[0].slice(0, 6) : '';
  var zip5 = String(postal || '').replace(/[^0-9]/g, '').slice(0, 5);
  return (num && stem) ? num + '|' + stem + '|' + zip5 : null;
}

function ccQueueSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CC_QUEUE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CC_QUEUE_SHEET_NAME);
    sheet.appendRow(['Timestamp', 'Address', 'ZIP', 'Images', 'Status',
                     'CC project', 'Uploaded', 'Note']);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 8).setFontWeight('bold')
         .setFontColor('#ffffff').setBackground('#1d4ed8');
  }
  return sheet;
}

// doPost action:'snapshot' — store the images, queue the row.
function ccSaveSnapshot_(data) {
  var address = String(data.address || '').trim().slice(0, 200);
  var zip = String(data.zip || '').replace(/\D/g, '').slice(0, 5);
  var images = (data.images || []).slice(0, 2);
  if (!address || !images.length) return { ok: false, error: 'missing address or images' };

  var stored = [];
  for (var i = 0; i < images.length; i++) {
    var img = images[i] || {};
    var m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(String(img.data || ''));
    if (!m || m[2].length > 4000000) continue; // ~3MB decoded cap per image
    var name = String(img.name || 'photo').replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'photo';
    var path = Utilities.formatDate(new Date(), SCHED_TZ_FOR_EVENTS, 'yyyy-MM') + '/' +
               Utilities.getUuid() + '-' + name + (m[1] === 'png' ? '.png' : '.jpg');
    var url = ccStorageUpload_(path, Utilities.base64Decode(m[2]), 'image/' + m[1]);
    stored.push({ n: name, u: url });
  }
  if (!stored.length) return { ok: false, error: 'no valid images' };

  ccQueueSheet_().appendRow([new Date(), address, zip, JSON.stringify(stored),
                             CC_STATUS.WAITING, '', 0, '']);
  return { ok: true, saved: stored.length };
}

// Upload bytes to the public Supabase bucket; returns the public URL.
function ccStorageUpload_(path, bytes, contentType) {
  var props = PropertiesService.getScriptProperties();
  var base = String(props.getProperty('SUPABASE_URL') || '').replace(/\/$/, '');
  var key = props.getProperty('SUPABASE_SERVICE_KEY');
  if (!base || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set');

  var res = UrlFetchApp.fetch(base + '/storage/v1/object/' + CC_BUCKET + '/' + path, {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + key, 'apikey': key },
    contentType: contentType,
    payload: bytes,
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Storage upload failed: ' + res.getResponseCode() + ' ' +
                    res.getContentText().slice(0, 200));
  }
  return base + '/storage/v1/object/public/' + CC_BUCKET + '/' + path;
}

// Hourly trigger: attach queued snapshots to their CompanyCam projects.
function ccSyncSnapshots() {
  var token = PropertiesService.getScriptProperties().getProperty('CC_ACCESS_TOKEN');
  if (!token) return;

  var sheet = ccQueueSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var firstRow = Math.max(2, lastRow - CC_QUEUE_SCAN_ROWS + 1);
  var rows = sheet.getRange(firstRow, 1, lastRow - firstRow + 1, 8).getValues();
  var paidByKey = null; // built lazily — most runs have nothing waiting
  var now = new Date();

  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][CC_QCOL.STATUS - 1]) !== CC_STATUS.WAITING) continue;
    var sheetRow = firstRow + i;
    var ts = new Date(rows[i][CC_QCOL.TS - 1]);

    var key = ccAddrKey_(rows[i][CC_QCOL.ADDRESS - 1], rows[i][CC_QCOL.ZIP - 1]);
    var tooOld = isNaN(ts) || (now - ts) > CC_QUEUE_MAX_AGE_DAYS * 86400000;
    if (!key || tooOld) {
      sheet.getRange(sheetRow, CC_QCOL.STATUS).setValue(CC_STATUS.EXPIRED);
      if (!key) sheet.getRange(sheetRow, CC_QCOL.NOTE).setValue('unusable address');
      continue;
    }

    if (!paidByKey) paidByKey = ccPaidLeadsByAddrKey_();
    var lead = paidByKey[key];
    if (!lead) {
      sheet.getRange(sheetRow, CC_QCOL.NOTE).setValue('waiting for payment');
      continue;
    }

    var project;
    try {
      project = ccFindProject_(token, key);
    } catch (err) {
      sheet.getRange(sheetRow, CC_QCOL.NOTE).setValue(String(err).slice(0, 200));
      continue;
    }
    if (!project) {
      sheet.getRange(sheetRow, CC_QCOL.NOTE).setValue('paid — waiting for CompanyCam project');
      continue;
    }

    var imgs;
    try { imgs = JSON.parse(rows[i][CC_QCOL.IMAGES - 1]) || []; } catch (e) { imgs = []; }
    var done = Number(rows[i][CC_QCOL.UPLOADED - 1]) || 0;
    var failed = false;
    for (var j = done; j < imgs.length; j++) {
      try {
        // The description goes on the first photo (the Order Summary card)
        // only, so the project feed doesn't show the same text twice.
        ccUploadPhoto_(token, project.id, imgs[j], ts,
                       j === 0 ? ccPhotoDescription_(lead) : '');
        done++;
        sheet.getRange(sheetRow, CC_QCOL.UPLOADED).setValue(done);
      } catch (err) {
        sheet.getRange(sheetRow, CC_QCOL.NOTE).setValue(String(err).slice(0, 200));
        failed = true;
        break;
      }
    }
    if (!failed && done >= imgs.length) {
      sheet.getRange(sheetRow, CC_QCOL.STATUS).setValue(CC_STATUS.DONE);
      sheet.getRange(sheetRow, CC_QCOL.PROJECT)
           .setValue((project.name || '') + ' (' + project.id + ')');
      sheet.getRange(sheetRow, CC_QCOL.NOTE).setValue('');
    }
  }
}

// Newest PAID lead row per address key, from the recent slice of the leads sheet.
function ccPaidLeadsByAddrKey_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var lastRow = sheet.getLastRow();
  var map = {};
  if (lastRow < 2) return map;
  var firstRow = Math.max(2, lastRow - CC_LEAD_SCAN_ROWS + 1);
  var values = sheet.getRange(firstRow, 1, lastRow - firstRow + 1, LAST_COL).getValues();
  values.forEach(function(vals) {
    if (String(vals[COL.STATUS - 1]) !== STATUS.PAID) return;
    var k = ccAddrKey_(vals[COL.ADDRESS - 1], vals[COL.ZIP - 1]);
    if (k) map[k] = rowToLead(vals); // later rows overwrite → newest wins
  });
  return map;
}

// Search CompanyCam for the project at this address. Tries "number stem",
// then the stem alone; candidates are exact-matched on the full address key.
// Multiple projects at one address → the most recently created wins.
function ccFindProject_(token, addrKey) {
  var parts = addrKey.split('|');
  var queries = [parts[0] + ' ' + parts[1], parts[1]];
  for (var q = 0; q < queries.length; q++) {
    var res = ccRequest_(token, 'get',
        '/projects?per_page=50&query=' + encodeURIComponent(queries[q]), null) || [];
    var newest = null;
    for (var i = 0; i < res.length; i++) {
      var a = res[i].address || {};
      if (ccAddrKey_(a.street_address_1, a.postal_code) !== addrKey) continue;
      if (!newest || Number(res[i].created_at || 0) > Number(newest.created_at || 0)) {
        newest = res[i];
      }
    }
    if (newest) return newest;
  }
  return null;
}

function ccUploadPhoto_(token, projectId, img, capturedAt, description) {
  var when = (capturedAt instanceof Date && !isNaN(capturedAt)) ? capturedAt : new Date();
  var body = { photo: {
    uri: img.u,
    captured_at: Math.floor(when.getTime() / 1000),
  } };
  if (description) body.photo.description = description;
  ccRequest_(token, 'post', '/projects/' + projectId + '/photos', body);
}

function ccPhotoDescription_(lead) {
  var deposit = Number(lead.deposit || 0);
  var balance = Math.max(0, Number(lead.total || 0) - deposit);
  var bits = ['Booked online — ' + String(lead.plan || 'gutter cleaning')];
  bits.push('$' + lead.total + ' total · $' + deposit + ' deposit paid · $' +
            balance + ' due on completion');
  var home = [String(lead.house || '')];
  if (lead.sqft) home.push(lead.sqft + ' sq ft');
  if (lead.stories) home.push(lead.stories + ' stories');
  bits.push(home.filter(String).join(', '));
  var notes = String(lead.notes || '').trim();
  if (notes) bits.push('Customer notes: ' + notes);
  return bits.join('\n').slice(0, 900);
}

function ccRequest_(token, method, path, body) {
  var options = {
    method: method,
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
    muteHttpExceptions: true,
  };
  if (body) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(body);
  }
  var res = UrlFetchApp.fetch(CC_API_BASE + path, options);
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('CompanyCam API ' + code + ' — ' + res.getContentText().slice(0, 200));
  }
  var text = res.getContentText();
  return text ? JSON.parse(text) : null;
}

// Bootstrap, called from the every-minute payment checker: installs the hourly
// sync trigger the first minute this code is live — no editor visit needed.
function ccEnsureSnapshotTrigger_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('CC_SNAPSHOT_TRIGGER_V1')) return;
  var exists = ScriptApp.getProjectTriggers().some(function(t) {
    return t.getHandlerFunction() === 'ccSyncSnapshots';
  });
  if (!exists) {
    ScriptApp.newTrigger('ccSyncSnapshots').timeBased().everyHours(1).create();
  }
  props.setProperty('CC_SNAPSHOT_TRIGGER_V1', '1');
}
