/* ============================================================
   CGP online scheduler (replaces Calendly, 2026-10-22).

   Reads open slots straight from Supabase (booking_slots — public, holds no
   personal data), books through team.cvillegutterpros.com/api/book, which
   claims the slot and has the booking Apps Script put it in Jobber and send
   the confirmation email.

   Why our own: Calendly only knew free/busy. The slot function also knows
   where the crew already is that day, so a customer across town sees that
   day marked and is steered to a day the crew is nearby.

   window.CGPBooking.mount(el, { service, embed, token })
     service  'cleaning' | 'assessment'      (book mode)
     token    manage link id                 (manage mode: reschedule / cancel)
   ============================================================ */
(function () {
  'use strict';

  var SB_URL = 'https://wmmhvguajkeiyhmfmilu.supabase.co';
  var SB_KEY = 'sb_publishable_qTRQ_ECvykQgCBHWReXC7w_nt1HUv8Z';
  var API = 'https://team.cvillegutterpros.com/api/book';
  var APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwqXVInrbcXK5Z4YLU-rFqa3d4ycv0GYOdSFP_D9O4opkOI1KZQqDCKspUPj6GtYacr/exec';
  var TZ = 'America/New_York';
  var PHONE = '434-422-4700';
  var COMPANY = 'Charlottesville Gutter Pros';
  var DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

  // ---------- formatting (everything is Eastern, like the crew's calendar)
  function fmt(d, opts) { return new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: TZ }, opts)).format(d); }
  function dayKey(d) { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
  function timeStr(d) { return fmt(d, { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(' ', ''); }
  function longDate(d) { return fmt(d, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); }
  function range(a, b) { return timeStr(a) + ' - ' + timeStr(b) + ', ' + longDate(a); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ics(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }

  var ICON = {
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  };

  // ---------- data
  function sbGet(path) {
    return fetch(SB_URL + '/rest/v1/' + path, { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } })
      .then(function (r) { if (!r.ok) throw new Error('supabase ' + r.status); return r.json(); });
  }
  function sbRpc(fn, args) {
    return fetch(SB_URL + '/rest/v1/rpc/' + fn, {
      method: 'POST', headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    }).then(function (r) { if (!r.ok) throw new Error('supabase ' + r.status); return r.json(); });
  }
  function api(body) {
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { j._status = r.status; return j; }); });
  }
  function readLead() {
    try { var raw = localStorage.getItem('cgp_lastLead'); if (raw) return JSON.parse(raw); } catch (_) {}
    return null;
  }
  function track(event, extra) {
    try {
      var p = Object.assign({ action: 'event', event: event, page: location.pathname,
        device: matchMedia('(max-width: 760px)').matches ? 'mobile' : 'desktop' }, extra || {});
      try { p.session = sessionStorage.getItem('cgp_sid') || localStorage.getItem('cgp_sid') || ''; } catch (_) {}
      navigator.sendBeacon(APPS_SCRIPT_URL, new Blob([JSON.stringify(p)], { type: 'text/plain;charset=utf-8' }));
    } catch (_) { /* analytics never blocks a booking */ }
  }

  // ---------- widget
  function mount(root, opts) {
    opts = opts || {};
    var S = {
      mode: opts.token ? 'manage' : 'book',
      service: opts.service || 'cleaning',
      embed: !!opts.embed,
      token: opts.token || '',
      svc: null,            // booking_services_public row
      slots: [],            // [{start:Date, end:Date, miles, far}]
      byDay: {},            // dayKey -> slots
      zip: '',
      month: null,          // Date (first of month, UTC noon)
      day: null,            // dayKey
      picked: null,         // slot
      hold: null,           // current booking in manage mode
      step: 'loading',
      err: '',
      lead: readLead(),
    };
    if (S.embed) document.body.classList.add('embed');

    function postHeight() {
      if (!S.embed) return;
      try { parent.postMessage({ type: 'cgp.height', height: document.documentElement.scrollHeight }, '*'); } catch (_) {}
    }
    function set(patch) { Object.assign(S, patch); render(); }

    // --- load
    function loadService() {
      return sbGet('booking_services_public?service=eq.' + encodeURIComponent(S.service))
        .then(function (rows) { if (!rows[0]) throw new Error('unknown service'); S.svc = rows[0]; });
    }
    function loadSlots() {
      return sbRpc('booking_slots', { p_service: S.service, p_zip: S.zip || null }).then(function (rows) {
        S.slots = rows.map(function (r) { return { start: new Date(r.slot_start), end: new Date(r.slot_end), miles: r.miles == null ? null : Number(r.miles), far: !!r.far }; });
        S.byDay = {};
        S.slots.forEach(function (s) { var k = dayKey(s.start); (S.byDay[k] = S.byDay[k] || []).push(s); });
        var first = S.slots[0] ? S.slots[0].start : new Date();
        var k = dayKey(first).split('-');
        S.month = new Date(Date.UTC(+k[0], +k[1] - 1, 1, 12));
        S.day = null; S.picked = null;
      });
    }
    function boot() {
      var p = loadService();
      if (S.mode === 'manage') {
        p = p.then(function () { return api({ op: 'get', token: S.token }); }).then(function (r) {
          if (!r.ok) throw new Error(r.error === 'not_found' ? 'We could not find that booking. Call us at ' + PHONE + '.' : r.error);
          S.hold = r.hold; S.zip = r.hold.zip || '';
          set({ step: 'manage' });
        });
      } else {
        if (S.service === 'cleaning' && S.lead && S.lead.zip) S.zip = String(S.lead.zip).replace(/\D/g, '').slice(0, 5);
        p = p.then(function () {
          if (S.service === 'assessment' && !S.zip) { set({ step: 'zip' }); return; }
          return loadSlots().then(function () { set({ step: 'calendar' }); });
        });
      }
      p.catch(function (e) { set({ step: 'error', err: String(e.message || e) }); });
    }

    // --- pieces
    function info(extra) {
      var svc = S.svc || {};
      var mins = svc.duration_min || 60;
      var dur = mins >= 60 ? (mins / 60) + ' hr' : mins + ' min';
      var h = '';
      if (extra && extra.back) h += '<button class="bk-back" type="button" data-act="back" aria-label="Back">&larr;</button>';
      h += '<div class="bk-brand"><div class="bk-logo">CGP</div><div class="bk-company">' + COMPANY + '</div></div>';
      h += '<h1 class="bk-title">' + esc(svc.title || '') + '</h1>';
      h += '<div class="bk-meta">' + ICON.clock + '<span>' + dur + '</span></div>';
      h += '<div class="bk-meta">' + ICON.pin + '<span>Client\'s Home</span></div>';
      if (extra && extra.when) h += '<div class="bk-meta when">' + ICON.cal + '<span>' + esc(extra.when) + '</span></div>';
      h += '<div class="bk-meta">' + ICON.globe + '<span>Eastern Time - US &amp; Canada</span></div>';
      if (!(extra && extra.when)) h += '<div class="bk-desc">' + esc(svc.description || '') + '</div>';
      return '<div class="bk-info">' + h + '</div>';
    }

    function calendar() {
      var y = S.month.getUTCFullYear(), m = S.month.getUTCMonth();
      var first = new Date(Date.UTC(y, m, 1, 12)).getUTCDay();
      var days = new Date(Date.UTC(y, m + 1, 0, 12)).getUTCDate();
      var today = dayKey(new Date());
      var minMonth = S.slots[0] ? dayKey(S.slots[0].start).slice(0, 7) : today.slice(0, 7);
      var maxMonth = S.slots.length ? dayKey(S.slots[S.slots.length - 1].start).slice(0, 7) : minMonth;
      var cur = y + '-' + String(m + 1).padStart(2, '0');
      var h = '<div class="bk-cal"><div class="bk-cal-head">';
      h += '<button class="bk-nav" type="button" data-act="prev" aria-label="Previous month"' + (cur <= minMonth ? ' disabled' : '') + '>&lsaquo;</button>';
      h += '<div class="bk-cal-month">' + fmt(new Date(Date.UTC(y, m, 15, 12)), { month: 'long', year: 'numeric' }) + '</div>';
      h += '<button class="bk-nav" type="button" data-act="next" aria-label="Next month"' + (cur >= maxMonth ? ' disabled' : '') + '>&rsaquo;</button></div>';
      h += '<div class="bk-dow">' + DOW.map(function (d) { return '<div>' + d + '</div>'; }).join('') + '</div><div class="bk-grid">';
      for (var i = 0; i < first; i++) h += '<div class="bk-day"></div>';
      var anyFar = false;
      for (var d = 1; d <= days; d++) {
        var k = cur + '-' + String(d).padStart(2, '0');
        var list = S.byDay[k];
        if (list) {
          var allFar = list.every(function (s) { return s.far; });
          if (allFar) anyFar = true;
          h += '<div class="bk-day"><button type="button" data-act="day" data-day="' + k + '" class="' + (S.day === k ? 'sel' : '') + (allFar ? ' far' : '') + '">' + d + '</button></div>';
        } else {
          h += '<div class="bk-day"><span class="' + (k === today ? 'today' : '') + '">' + d + '</span></div>';
        }
      }
      h += '</div>';
      h += '<div class="bk-tz">' + ICON.globe + '<span>Eastern Time - US &amp; Canada (' + timeStr(new Date()) + ')</span></div>';
      if (anyFar) h += '<div class="bk-legend"><i></i> Our crew is across town that day &mdash; a highlighted day gets you a tighter arrival window.</div>';
      if (!S.slots.length) h += '<div class="bk-empty">No online times in the next ' + (S.svc.horizon_days || 60) + ' days. Call or text us at <a href="tel:+1' + PHONE.replace(/\D/g, '') + '">' + PHONE + '</a> and we\'ll find you a spot.</div>';
      h += '</div>';
      return h;
    }

    function times() {
      if (!S.day) return '';
      var list = S.byDay[S.day] || [];
      var d = list[0] ? list[0].start : null;
      var h = '<div class="bk-times"><h3>' + (d ? fmt(d, { weekday: 'long', month: 'long', day: 'numeric' }) : '') + '</h3>';
      if (list.length && list.every(function (s) { return s.far; })) {
        h += '<div class="far-note">Our crew is working about ' + Math.round(list[0].miles) + ' miles from you that day. You can still book it &mdash; we\'ll call ahead with a tighter arrival time.</div>';
      }
      h += '<div class="bk-times-list">';
      list.forEach(function (s, i) {
        var picked = S.picked === s;
        h += '<div class="bk-slot' + (picked ? ' picked' : '') + '"><button type="button" class="t" data-act="pick" data-i="' + i + '">' + timeStr(s.start) + '</button>';
        if (picked) h += '<button type="button" class="next" data-act="next-step">Next</button>';
        h += '</div>';
      });
      h += '</div></div>';
      return h;
    }

    function zipAsk() {
      return '<div class="bk-zip"><label for="bkZip">Where is the property? Enter the ZIP code</label>' +
        '<div class="row"><input id="bkZip" inputmode="numeric" maxlength="5" autocomplete="postal-code" placeholder="22901" value="' + esc(S.zip) + '" data-1p-ignore />' +
        '<span class="hint">We\'ll show the days our team is already near you.</span></div></div>';
    }

    function form() {
      var l = S.lead || {};
      var parts = String(l.name || '').trim().split(/\s+/);
      var first = parts[0] || '', last = parts.slice(1).join(' ');
      var isA = S.service === 'assessment';
      var h = '<form class="bk-form" novalidate><h2 class="bk-h2">Enter Details</h2>';
      h += '<div class="row2"><div class="f"><label>First name <i>*</i></label><input name="first" autocomplete="given-name" required value="' + esc(first) + '" data-1p-ignore></div>';
      h += '<div class="f"><label>Last name <i>*</i></label><input name="last" autocomplete="family-name" required value="' + esc(last) + '" data-1p-ignore></div></div>';
      h += '<div class="f"><label>Email <i>*</i></label><input name="email" type="email" autocomplete="email" required value="' + esc(l.email || '') + '" data-1p-ignore></div>';
      h += '<div class="f"><label>Phone number <i>*</i></label><input name="phone" type="tel" autocomplete="tel" required value="' + esc(l.phone || '') + '" data-1p-ignore></div>';
      if (isA) {
        h += '<div class="f"><label>Property address <i>*</i></label><input name="address" autocomplete="street-address" required value="' + esc(l.address || '') + '" data-1p-ignore></div>';
        h += '<div class="f"><label>Tell us what you need done. <i>*</i></label><textarea name="notes" required></textarea></div>';
        h += '<div class="f"><label class="bk-check"><input type="checkbox" name="home" required> <span>I\'ll be home for this in-person appointment so we can walk the property together.</span></label></div>';
      } else {
        h += '<div class="f"><label>Anything we should know? (gate codes, dogs, where to park)</label><textarea name="notes"></textarea></div>';
      }
      h += '<div class="bk-hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>';
      h += '<div class="err" id="bkErr"></div>';
      h += '<button class="bk-submit" type="submit">Schedule Event</button>';
      h += '<p class="bk-fine">You\'ll get a confirmation email with a calendar invite right away, and a reminder the day before. Need to change it later? Every email has a link for that.</p>';
      h += '</form>';
      return h;
    }

    function calLinks(hold) {
      var st = new Date(hold.start_at), en = new Date(hold.end_at);
      var title = S.svc.title + ' - ' + COMPANY;
      var details = 'Your ' + S.svc.title.toLowerCase() + ' with ' + COMPANY + '. We\'ll call or text on the way. Questions: ' + PHONE + '.';
      var g = 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(title) +
        '&dates=' + ics(st) + '/' + ics(en) + '&details=' + encodeURIComponent(details) + '&location=' + encodeURIComponent(hold.address || '');
      var body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Charlottesville Gutter Pros//Booking//EN', 'BEGIN:VEVENT',
        'UID:' + hold.token + '@cvillegutterpros.com', 'DTSTAMP:' + ics(new Date()), 'DTSTART:' + ics(st), 'DTEND:' + ics(en),
        'SUMMARY:' + title, 'LOCATION:' + String(hold.address || '').replace(/,/g, '\\,'), 'DESCRIPTION:' + details.replace(/,/g, '\\,'),
        'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
      var icsHref = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(body);
      var t = S.embed ? ' target="_blank" rel="noopener"' : '';
      return '<a class="bk-btn" href="' + g + '"' + t + ' target="_blank" rel="noopener">' + ICON.cal + 'Google Calendar</a>' +
        '<a class="bk-btn" href="' + icsHref + '" download="gutter-pros.ics">' + ICON.cal + 'Apple / Outlook</a>';
    }

    function done(hold, kind) {
      var st = new Date(hold.start_at), en = new Date(hold.end_at);
      var manage = location.origin + location.pathname.replace(/[^/]*$/, '') + 'manage.html?t=' + hold.token;
      var h = '<div class="bk-done">';
      if (kind === 'cancelled') {
        h += '<div class="bk-check-big" style="background:#6b7280">&#10005;</div><h2>Your booking is cancelled</h2>';
        h += '<p class="lead">Sorry we won\'t see you this time. Want a different day? Call or text <a href="tel:+1' + PHONE.replace(/\D/g, '') + '">' + PHONE + '</a> or book again any time.</p></div>';
        return h;
      }
      h += '<div class="bk-check-big">&#10003;</div>';
      h += '<h2>' + (kind === 'rescheduled' ? 'You are rescheduled' : 'You are scheduled') + '</h2>';
      h += '<p class="lead">' + (S.warning ? 'Our office will send your confirmation shortly.' : 'A calendar invitation has been sent to your email address.') + '</p>';
      h += '<div class="bk-card"><div class="t">' + esc(S.svc.title) + '</div>';
      h += '<div class="bk-meta">' + ICON.cal + '<span>' + esc(range(st, en)) + '</span></div>';
      h += '<div class="bk-meta">' + ICON.globe + '<span>Eastern Time - US &amp; Canada</span></div>';
      if (hold.address) h += '<div class="bk-meta">' + ICON.pin + '<span>' + esc(hold.address) + '</span></div>';
      h += '</div>';
      h += '<div class="bk-actions">' + calLinks(hold) + '</div>';
      if (hold.far || (hold.miles != null && S.svc && hold.miles > 12)) {
        h += '<div class="bk-note">Heads up: our crew is scheduled across town that day, so your arrival window may be a little wider. We\'ll call ahead.</div>';
      }
      h += '<div class="bk-manage">Need to change it? <a href="' + manage + '"' + (S.embed ? ' target="_blank" rel="noopener"' : '') + '>Reschedule or cancel</a></div>';
      h += '</div>';
      return h;
    }

    function manage() {
      var hd = S.hold, st = new Date(hd.start_at), en = new Date(hd.end_at);
      var active = hd.status === 'booked' || hd.status === 'held';
      var h = '<div class="bk-done"><h2>Your ' + esc(S.svc.title.toLowerCase()) + '</h2>';
      if (!active) {
        h += '<p class="lead">This booking was ' + (hd.status === 'rescheduled' ? 'moved to a new time (use the link in your latest email)' : 'cancelled') + '.</p></div>';
        return h;
      }
      h += '<p class="lead">Here\'s what we have on the calendar for you.</p>';
      h += '<div class="bk-card"><div class="t">' + esc(hd.name || '') + '</div>';
      h += '<div class="bk-meta">' + ICON.cal + '<span>' + esc(range(st, en)) + '</span></div>';
      if (hd.address) h += '<div class="bk-meta">' + ICON.pin + '<span>' + esc(hd.address) + '</span></div>';
      h += '</div>';
      if (S.err) h += '<div class="bk-error" style="margin-top:16px">' + esc(S.err) + '</div>';
      if (S.confirmCancel) {
        h += '<div class="bk-actions"><button class="bk-btn danger" type="button" data-act="cancel-go">Yes, cancel my booking</button><button class="bk-btn" type="button" data-act="cancel-no">Keep it</button></div>';
      } else {
        h += '<div class="bk-actions"><button class="bk-btn solid" type="button" data-act="reschedule">Reschedule</button><button class="bk-btn danger" type="button" data-act="cancel-ask">Cancel booking</button></div>';
      }
      h += '</div>';
      return h;
    }

    // --- render
    function render() {
      var h = '';
      var wide = false;
      if (S.step === 'loading') h = '<div class="bk-loading"><div class="bk-spin"></div>Loading times&hellip;</div>';
      else if (S.step === 'error') h = '<div class="bk-loading"><div class="bk-error">' + esc(S.err) + '</div></div>';
      else if (S.step === 'zip') h = info() + '<div class="bk-main"><h2 class="bk-h2">Select a Date &amp; Time</h2>' + zipAsk() + '</div>';
      else if (S.step === 'calendar') {
        h = info() + '<div class="bk-main"><h2 class="bk-h2">Select a Date &amp; Time</h2>' +
          (S.service === 'assessment' ? zipAsk() : '') +
          (S.err ? '<div class="bk-error">' + esc(S.err) + '</div>' : '') +
          '<div class="bk-split' + (S.day ? '' : ' no-times') + '">' + calendar() + times() + '</div></div>';
      }
      else if (S.step === 'form') h = info({ back: true, when: range(S.picked.start, S.picked.end) }) + '<div class="bk-main">' + form() + '</div>';
      else if (S.step === 'busy') h = '<div class="bk-loading"><div class="bk-spin"></div>' + esc(S.busyMsg || 'Booking your time&hellip;') + '</div>';
      else if (S.step === 'done') { h = done(S.hold, S.doneKind); wide = true; }
      else if (S.step === 'manage') { h = manage(); wide = true; }
      root.className = 'bk' + (wide ? ' is-wide' : '');
      root.innerHTML = h;
      bind();
      postHeight();
      setTimeout(postHeight, 300);
    }

    function bind() {
      root.querySelectorAll('[data-act]').forEach(function (el) {
        el.addEventListener('click', function (ev) { ev.preventDefault(); act(el.getAttribute('data-act'), el); });
      });
      var zipEl = root.querySelector('#bkZip');
      if (zipEl) zipEl.addEventListener('input', function () {
        var z = zipEl.value.replace(/\D/g, '').slice(0, 5); zipEl.value = z;
        if (z.length === 5 && z !== S.zip) { S.zip = z; S.err = ''; S.step = 'loading'; render(); loadSlots().then(function () { set({ step: 'calendar' }); }).catch(function (e) { set({ step: 'error', err: String(e.message || e) }); }); }
      });
      var f = root.querySelector('form.bk-form');
      if (f) f.addEventListener('submit', function (ev) { ev.preventDefault(); submit(f); });
      var fe = root.querySelector('input[name=first]');
      if (fe && !fe.value) fe.focus();
    }

    function act(a, el) {
      if (a === 'prev' || a === 'next') {
        S.month = new Date(Date.UTC(S.month.getUTCFullYear(), S.month.getUTCMonth() + (a === 'next' ? 1 : -1), 1, 12)); S.day = null; S.picked = null; render();
      } else if (a === 'day') { S.day = el.getAttribute('data-day'); S.picked = null; render(); }
      else if (a === 'pick') { S.picked = S.byDay[S.day][+el.getAttribute('data-i')]; render(); }
      else if (a === 'next-step') {
        if (S.mode === 'manage') return reschedule();
        set({ step: 'form' });
      }
      else if (a === 'back') set({ step: 'calendar' });
      else if (a === 'reschedule') { S.step = 'loading'; render(); loadSlots().then(function () { set({ step: 'calendar' }); }).catch(function (e) { set({ step: 'error', err: String(e.message || e) }); }); }
      else if (a === 'cancel-ask') set({ confirmCancel: true, err: '' });
      else if (a === 'cancel-no') set({ confirmCancel: false });
      else if (a === 'cancel-go') cancel();
    }

    function friendly(err, status) {
      if (err === 'slot_taken') return 'That time was just taken by someone else. Please pick another.';
      if (err === 'payment_not_found') return 'We could not find the deposit for this booking. Call or text ' + PHONE + ' and we\'ll sort it out.';
      if (err === 'missing_fields') return 'Please check your name, email and phone number.';
      if (err === 'not_active') return 'This booking is no longer active.';
      return 'Something went wrong (' + (err || status || 'network') + '). Please try again or call ' + PHONE + '.';
    }

    function submit(f) {
      var v = function (n) { var e = f.elements[n]; return e ? (e.type === 'checkbox' ? e.checked : e.value.trim()) : ''; };
      var errEl = f.querySelector('#bkErr');
      var problems = [];
      if (!v('first') || !v('last')) problems.push('name');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v('email'))) problems.push('email');
      if (v('phone').replace(/\D/g, '').length < 10) problems.push('phone number');
      if (S.service === 'assessment') { if (!v('address')) problems.push('property address'); if (!v('notes')) problems.push('what you need done'); if (!v('home')) problems.push('the "I\'ll be home" box'); }
      if (problems.length) { errEl.textContent = 'Please fill in: ' + problems.join(', ') + '.'; errEl.classList.add('on'); return; }
      var btn = f.querySelector('.bk-submit'); btn.disabled = true;
      var l = S.lead || {};
      var body = {
        op: 'book', service: S.service, start: S.picked.start.toISOString(),
        name: v('first') + ' ' + v('last'), email: v('email'), phone: v('phone'),
        address: S.service === 'assessment' ? v('address') : (l.address || ''),
        zip: S.zip || (String(v('address')).match(/\b\d{5}\b/) || [''])[0],
        notes: v('notes'), website: v('website'),
        lead_timestamp: S.service === 'cleaning' ? (l.timestamp || '') : '',
        source: S.embed ? 'booking-page-embed' : 'booking-page',
      };
      set({ step: 'busy', busyMsg: 'Booking your time…' });
      api(body).then(function (r) {
        if (!r.ok) { S.err = friendly(r.error, r._status); if (r.error === 'slot_taken') return loadSlots().then(function () { set({ step: 'calendar' }); }); return set({ step: 'form' }); }
        S.warning = r.warning || '';
        S.hold = Object.assign({ far: S.picked.far, miles: S.picked.miles }, r.hold || {}, { token: r.token });
        S.err = '';
        track(S.service === 'cleaning' ? 'cleaning_scheduled' : 'assessment_booked', { plan: S.service });
        try { parent.postMessage({ type: 'cgp.booked', service: S.service }, '*'); } catch (_) {}
        set({ step: 'done', doneKind: 'booked' });
      }).catch(function () { S.err = friendly('', 'network'); set({ step: 'form' }); });
    }

    function reschedule() {
      set({ step: 'busy', busyMsg: 'Moving your booking…' });
      api({ op: 'reschedule', token: S.token, start: S.picked.start.toISOString() }).then(function (r) {
        if (!r.ok) { S.err = friendly(r.error, r._status); return loadSlots().then(function () { set({ step: 'calendar' }); }); }
        S.token = r.token; S.warning = r.warning || '';
        S.hold = Object.assign({ far: S.picked.far, miles: S.picked.miles }, r.hold || {}, { token: r.token });
        try { history.replaceState(null, '', location.pathname + '?t=' + r.token); } catch (_) {}
        set({ step: 'done', doneKind: 'rescheduled', err: '' });
      }).catch(function () { S.err = friendly('', 'network'); set({ step: 'calendar' }); });
    }

    function cancel() {
      set({ step: 'busy', busyMsg: 'Cancelling…' });
      api({ op: 'cancel', token: S.token }).then(function (r) {
        if (!r.ok) { S.err = friendly(r.error, r._status); S.confirmCancel = false; return set({ step: 'manage' }); }
        S.hold.status = 'cancelled';
        set({ step: 'done', doneKind: 'cancelled' });
      }).catch(function () { S.err = friendly('', 'network'); S.confirmCancel = false; set({ step: 'manage' }); });
    }

    render();
    boot();
    if (window.ResizeObserver) new ResizeObserver(postHeight).observe(root);
  }

  window.CGPBooking = { mount: mount };
})();
