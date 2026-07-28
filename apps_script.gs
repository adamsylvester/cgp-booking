const NOTIFICATION_EMAIL = 'adam@cvillegutterpros.com';
const FROM_ADDRESS = 'adam@cvillegutterpros.com';
const FROM_NAME = 'Charlottesville Gutter Pros';
// Calendly event used to schedule the PAID cleaning (post-deposit). This is the
// gutter-cleaning calendar, NOT the assessment calendar on the booking page.
const CALENDLY_URL = 'https://calendly.com/gutterpros/gutter-cleaning';
// Deposit = 25% of the quoted total, rounded to a whole dollar.
const DEPOSIT_RATE = 0.25;
const OUTSIDE_AREA_FEE = 50;

// ===== Square checkout =====
// The access token lives in Script Properties (key: SQUARE_ACCESS_TOKEN) so it
// never sits in this file. Project Settings -> Script Properties -> add it there.
// The location ID is fetched from Square once and cached in Script Properties.
const SQUARE_API_BASE = 'https://connect.squareup.com';
const SQUARE_VERSION = '2025-01-23';
// Where Square sends the customer after paying (then thanks.html -> Calendly).
const AFTER_PAYMENT_URL = 'https://book.cvillegutterpros.com/thanks.html';

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

function depositFor(data) {
  var explicit = Number(data.deposit);
  if (explicit > 0) return Math.round(explicit);
  return Math.round(Number(data.finalPrice || 0) * DEPOSIT_RATE);
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var action = data.action || 'lead';

    if (action === 'confirm') {
      sendBuyerConfirmationEmail(data);
      return jsonOutput({ ok: true });
    }

    // Both 'lead' (fallback beacon) and 'checkout' log the lead + notify the office.
    logLead(data);
    sendOfficeNotificationEmail(data);

    if (action === 'checkout') {
      try {
        var url = createSquareCheckoutUrl(data);
        return jsonOutput({ ok: true, checkoutUrl: url });
      } catch (err) {
        // Lead is already logged; the page will fall back to the flat $25 link.
        return jsonOutput({ ok: false, error: String(err) });
      }
    }

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

function logLead(data) {
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
    depositFor(data) || ''
  ]);
}

// Creates a one-off Square payment link for exactly this customer's deposit.
function createSquareCheckoutUrl(data) {
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
  return result.payment_link.url;
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

function buildOfficeEmailHtml(data) {
  var name = escapeHtml(data.name || 'Unknown');
  var phone = escapeHtml(data.phone || '');
  var email = escapeHtml(data.email || '');
  var address = escapeHtml(data.address || '');
  var submitted = escapeHtml(data.timestamp || '');
  var notes = (data.notes || '').trim();

  var html = '';
  html += '<div style="font-family:Arial,sans-serif;color:#101828;max-width:560px;">';
  html += '<h2 style="margin:0 0 16px;color:#1d4ed8;">New booking - ' + name + '</h2>';
  html += '<h3 style="margin:18px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:#475467;">Customer</h3>';
  html += '<table style="border-collapse:collapse;width:100%;">';
  html += rowBold('Name', name);
  html += row('Phone', '<a href="tel:' + phone + '">' + phone + '</a>');
  html += row('Email', '<a href="mailto:' + email + '">' + email + '</a>');
  html += row('Address', address);
  html += '</table>';
  html += '<h3 style="margin:18px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:#475467;">Quote</h3>';
  html += '<table style="border-collapse:collapse;width:100%;">';
  html += quoteSummaryRows(data);
  html += '</table>';
  if (notes) {
    html += '<h3 style="margin:18px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:#475467;">Customer notes</h3>';
    html += '<p style="margin:0;color:#101828;line-height:1.5;white-space:pre-wrap;">' + escapeHtml(notes) + '</p>';
  }
  html += '<p style="margin-top:18px;font-size:12px;color:#667085;">Submitted ' + submitted + '<br>Full row in the CGP Booking Leads sheet.</p>';
  html += '</div>';
  return html;
}

function buildBuyerEmailHtml(data) {
  var name = escapeHtml(data.name || 'there');
  var firstName = name.split(' ')[0];
  var deposit = depositFor(data);
  var calendlyHref = CALENDLY_URL + '?name=' + encodeURIComponent(data.name || '') + '&email=' + encodeURIComponent(data.email || '');

  var html = '';
  html += '<div style="font-family:Arial,sans-serif;color:#101828;max-width:560px;">';
  html += '<h2 style="margin:0 0 8px;color:#1d4ed8;">Thanks, ' + firstName + '! Your $' + deposit + ' deposit is in.</h2>';
  html += '<p style="margin:0 0 18px;color:#475467;line-height:1.5;">';
  html += 'We are on the books for your gutter cleaning. Pick the date that works best for you using the link below, and our crew will take it from there.';
  html += '</p>';
  html += '<p style="margin:0 0 22px;">';
  html += '<a href="' + calendlyHref + '" style="display:inline-block;padding:14px 22px;background:#1d4ed8;color:#ffffff;text-decoration:none;border-radius:12px;font-weight:700;">Pick your service date</a>';
  html += '</p>';
  html += '<h3 style="margin:18px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:#475467;">Your quote</h3>';
  html += '<table style="border-collapse:collapse;width:100%;">';
  html += quoteSummaryRows(data);
  html += '</table>';
  html += '<p style="margin-top:22px;font-size:13px;color:#475467;line-height:1.5;">';
  html += 'Questions? Just reply to this email - it goes straight to our office.';
  html += '</p>';
  html += '<p style="margin-top:22px;font-size:12px;color:#98a2b3;">';
  html += 'Charlottesville Gutter Pros';
  html += '</p>';
  html += '</div>';
  return html;
}

function sendOfficeNotificationEmail(data) {
  var name = data.name || 'Unknown';
  MailApp.sendEmail({
    to: NOTIFICATION_EMAIL,
    subject: 'New booking: ' + name + ' (' + houseLabel(data.houseType) + ')',
    htmlBody: buildOfficeEmailHtml(data),
    replyTo: data.email || undefined,
    from: FROM_ADDRESS,
    name: FROM_NAME
  });
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

// One-off helper: run manually from the editor to confirm the Square connection
// works end-to-end. Logs a test payment-link URL (open it, DON'T pay it).
function testSquareConnection() {
  var url = createSquareCheckoutUrl({
    planName: 'Connection Test',
    finalPrice: 100,
    deposit: 25,
    email: NOTIFICATION_EMAIL,
  });
  Logger.log('Square OK — test checkout link: ' + url);
}

function setupSheet() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var headers = [
    'Timestamp', 'Name', 'Phone', 'Email', 'Address',
    'Home type', 'Sq ft', 'Stories', 'Plan', 'Outside area',
    'Notes', 'Base price', 'Final price', 'User agent', 'Page',
    'ZIP', 'Deposit'
  ];
  var lastCol = headers.length; // 17

  sheet.getRange(1, 1, 1, lastCol).setValues([headers]);
  sheet.setFrozenRows(1);

  var header = sheet.getRange(1, 1, 1, lastCol);
  header.setFontWeight('bold');
  header.setFontColor('#ffffff');
  header.setBackground('#1d4ed8');
  header.setHorizontalAlignment('left');
  header.setVerticalAlignment('middle');
  sheet.setRowHeight(1, 36);

  // Base price = L (12), Final price = M (13), Deposit = Q (17).
  ['L', 'M', 'Q'].forEach(function(col) {
    sheet.getRange(col + '2:' + col).setNumberFormat('"$"#,##0');
  });
  sheet.getRange('A2:A').setNumberFormat('yyyy-mm-dd hh:mm');

  var range = sheet.getRange(1, 1, Math.max(2, sheet.getLastRow()), lastCol);
  range.getBandings().forEach(function(b) { b.remove(); });
  var banding = range.applyRowBanding(SpreadsheetApp.BandingTheme.BLUE, true, false);
  banding.setHeaderRowColor('#1d4ed8');
  banding.setFirstRowColor('#ffffff');
  banding.setSecondRowColor('#f1f5fb');

  var existing = sheet.getFilter();
  if (existing) existing.remove();
  sheet.getRange(1, 1, sheet.getMaxRows(), lastCol).createFilter();

  for (var c = 1; c <= lastCol; c++) {
    sheet.autoResizeColumn(c);
  }
}
