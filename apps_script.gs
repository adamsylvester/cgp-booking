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
    var action = data.action || 'lead';

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
    logLead(data, STATUS.FALLBACK, '', '');
    sendCheckoutStartedEmail(data, 'Fallback path — customer sent to flat $25 link');
    return jsonOutput({ ok: true });
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err) });
  }
}

function doGet() {
  return ContentService.createTextOutput('CGP booking endpoint is alive.');
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
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
    } else if (p.status === STATUS.STARTED && (now - p.ts) > ABANDONED_AFTER_MIN * 60000) {
      sheet.getRange(p.sheetRow, COL.STATUS).setValue(STATUS.ABANDONED);
      sendAbandonedEmail(rowToLead(p.vals));
    }
  });
}

function rowToLead(vals) {
  return {
    name: vals[COL.NAME - 1],
    phone: vals[COL.PHONE - 1],
    email: vals[COL.EMAIL - 1],
    address: vals[COL.ADDRESS - 1],
    house: vals[COL.HOUSE - 1],
    plan: vals[COL.PLAN - 1],
    zip: vals[COL.ZIP - 1],
    notes: vals[COL.NOTES - 1],
    total: vals[COL.TOTAL - 1],
    deposit: vals[COL.DEPOSIT - 1],
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
  inner += sectionHead('Quote');
  inner += '<table style="border-collapse:collapse;width:100%;">' + quoteSummaryRows(data) + '</table>';
  if (priceCheck) inner += '<p style="margin-top:10px;font-size:13px;color:' + (priceCheck.indexOf('✓') === 0 ? '#15803d' : '#b42318') + ';font-weight:700;">Price check: ' + escapeHtml(priceCheck) + '</p>';
  var notes = (data.notes || '').trim();
  if (notes) {
    inner += sectionHead('Customer notes');
    inner += '<p style="margin:0;line-height:1.5;white-space:pre-wrap;">' + escapeHtml(notes) + '</p>';
  }

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
  inner += sectionHead('Money');
  inner += '<table style="border-collapse:collapse;width:100%;">';
  inner += rowBold('Total price', '$' + lead.total);
  inner += row('Deposit paid', '$' + lead.deposit);
  inner += rowBold('Balance on completion', '$' + balance);
  inner += '</table>';
  if (receiptUrl) {
    inner += '<p style="margin:16px 0 0;"><a href="' + receiptUrl + '" style="display:inline-block;padding:12px 20px;background:#1d4ed8;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">View payment in Square</a></p>';
  }
  inner += '<p style="margin-top:16px;font-size:13px;color:#475467;">They\'re being sent to Calendly to pick their date — watch for the calendar invite.</p>';

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
  inner += sectionHead('What they saw');
  inner += '<table style="border-collapse:collapse;width:100%;">';
  inner += row('Home', escapeHtml(String(lead.house)));
  inner += row('Plan', escapeHtml(String(lead.plan)));
  if (lead.zip) inner += row('ZIP', escapeHtml(String(lead.zip)));
  inner += rowBold('Quoted total', '$' + lead.total);
  inner += row('Deposit they didn\'t pay', '$' + lead.deposit);
  inner += '</table>';
  var notes = String(lead.notes || '').trim();
  if (notes) {
    inner += sectionHead('Their notes');
    inner += '<p style="margin:0;line-height:1.5;white-space:pre-wrap;">' + escapeHtml(notes) + '</p>';
  }
  inner += '<p style="margin-top:16px;font-size:13px;color:#475467;">If they pay later, this flips to ✅ PAID automatically — no action needed on the sheet.</p>';

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
  var calendlyHref = CALENDLY_URL + '?name=' + encodeURIComponent(data.name || '') + '&email=' + encodeURIComponent(data.email || '');

  var inner = '';
  inner += '<h2 style="margin:0 0 8px;color:#1d4ed8;">Thanks, ' + firstName + '! Your $' + deposit + ' deposit is in.</h2>';
  inner += '<p style="margin:0 0 18px;color:#475467;line-height:1.5;">';
  inner += 'We are on the books for your gutter cleaning. Pick the date that works best for you using the link below, and our crew will take it from there.';
  inner += '</p>';
  inner += '<p style="margin:0 0 22px;">';
  inner += '<a href="' + calendlyHref + '" style="display:inline-block;padding:14px 22px;background:#1d4ed8;color:#ffffff;text-decoration:none;border-radius:12px;font-weight:700;">Pick your service date</a>';
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
