// ============================================================================
// CGP BUSY CALENDARS — Jobber visits → Google Calendar → Calendly conflicts
// ============================================================================
//
// Standalone Apps Script project "CGP Busy Calendars" (adam@cvillegutterpros.com).
// Every 10 minutes it reads the next HORIZON_DAYS of Jobber visits and mirrors
// them as busy blocks into Google Calendars that Calendly checks for conflicts:
//
//   CGP Busy — Todd      every visit Todd is assigned to (or the Assessments
//                        lane)  →  Calendly "todd-cvillegutterpros/30min"
//   CGP Busy — Cleaning  every visit on the GC1 lane (new-customer cleanings —
//                        online bookings land there; GC2 is the recurring lane
//                        and does NOT make GC1 free)  →  Calendly "gutterpros/gutter-cleaning"
//
// Jobber stays the only source of truth for the crew's day. The calendars hold
// nothing but copies, so the script may freely delete and recreate its own
// events (it only ever touches events carrying EVENT_TAG in the description).
//
// Setup (once):
//   1. Script Properties: JOBBER_TOKEN_STORE_URL, JOBBER_TOKEN_STORE_SECRET
//      (same values as the booking project — the token service owns the
//      refresh-token chain, this script only asks for the current access token).
//   2. Services + → add "Google Calendar API" (identifier Calendar) — used only
//      to share the calendars.
//   3. Run setup()  → creates the calendars, shares them read-only with
//      SHARE_WITH, installs the 10-minute trigger, runs one sync.
//   4. In each Calendly account: Calendar connections → "Check for conflicts"
//      → tick the matching CGP Busy calendar.
//
// Lane users (GC1, GC2, Solo, Install, Repair, Assessments…) are Jobber
// pseudo-users with no last name; real techs have one. People are matched on
// "First L" (first name + last initial) so a renamed account can't silently
// drop someone.
// ============================================================================

const JOBBER_GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';
const JOBBER_API_VERSION = '2025-01-20';

const HORIZON_DAYS = 60;          // how far ahead to mirror
const SYNC_EVERY_MINUTES = 10;
const EVENT_TAG = '[jobber-busy]';
const CAL_TZ = 'America/New_York';

// Who gets read access to the calendars (so their Calendly can tick them).
// The owner account (adam@cvillegutterpros.com) sees them automatically.
const SHARE_WITH = [
  'todd@cvillegutterpros.com',   // Todd's Calendly user connects to this Google account
];

// mode 'any' : busy whenever ANY matching visit is on (per-visit events).
// mode 'all' : busy only where EVERY listed lane has a visit at the same time
//              (merged blocks) — i.e. no crew is free.
const BUSY_CALENDARS = [
  { key: 'todd',     name: 'CGP Busy — Todd',     mode: 'any', people: ['Todd M'], lanes: ['Assessments'] },
  // 2026-10-22: was mode 'all' over ['GC1','GC2'] — a Nov 3 booking slipped
  // through because GC2 was empty while GC1 was full, then got put on GC1.
  { key: 'cleaning', name: 'CGP Busy — Cleaning', mode: 'any', people: [],         lanes: ['GC1'] },
];

// ----------------------------------------------------------------------------
// ENTRY POINTS
// ----------------------------------------------------------------------------

function setup() {
  BUSY_CALENDARS.forEach(function (cfg) {
    var cal = ensureCalendar_(cfg);
    SHARE_WITH.forEach(function (email) { shareCalendar_(cal.getId(), email); });
  });
  ensureTrigger_();
  syncBusyCalendars();
}

function syncBusyCalendars() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;   // a previous run is still going
  try {
    var now = new Date();
    var from = startOfDay_(now);
    var to = new Date(from.getTime() + HORIZON_DAYS * 86400000);
    var visits = fetchVisits_(from, to);
    var summary = [];
    BUSY_CALENDARS.forEach(function (cfg) {
      var cal = ensureCalendar_(cfg);
      var desired = cfg.mode === 'all' ? desiredAllLanes_(cfg, visits) : desiredAny_(cfg, visits);
      var r = reconcile_(cal, from, to, desired);
      summary.push(cfg.name + ': ' + Object.keys(desired).length + ' busy, +' + r.created + ' −' + r.deleted);
    });
    PropertiesService.getScriptProperties().setProperty('LAST_SYNC', now.toISOString() + ' · ' + visits.length + ' visits · ' + summary.join(' | '));
    Logger.log(summary.join('\n'));
  } finally {
    lock.releaseLock();
  }
}

// Handy while testing: what would land on each calendar today → +7d.
function previewBusy() {
  var from = startOfDay_(new Date());
  var to = new Date(from.getTime() + 7 * 86400000);
  var visits = fetchVisits_(from, to);
  BUSY_CALENDARS.forEach(function (cfg) {
    var desired = cfg.mode === 'all' ? desiredAllLanes_(cfg, visits) : desiredAny_(cfg, visits);
    Logger.log('== ' + cfg.name);
    Object.keys(desired).sort(function (a, b) { return desired[a].start - desired[b].start; }).forEach(function (k) {
      var d = desired[k];
      Logger.log(fmt_(d.start) + ' → ' + fmt_(d.end) + '  ' + d.title);
    });
  });
}

// ----------------------------------------------------------------------------
// JOBBER
// ----------------------------------------------------------------------------

function fetchVisits_(from, to) {
  var query =
    'query BusyVisits($after: ISO8601DateTime!, $before: ISO8601DateTime!, $cursor: String) {' +
    '  visits(filter: { startAt: { after: $after, before: $before } }, first: 100, after: $cursor) {' +
    '    nodes { id title startAt endAt isComplete ' +
    '      assignedUsers(first: 10) { nodes { id name { first last } } } }' +
    '    pageInfo { hasNextPage endCursor }' +
    '  }' +
    '}';
  var out = [];
  var cursor = null;
  for (var page = 0; page < 20; page++) {
    var data = jobberGql_(query, { after: from.toISOString(), before: to.toISOString(), cursor: cursor });
    var conn = data.visits;
    conn.nodes.forEach(function (v) {
      if (!v.startAt || !v.endAt) return;
      out.push({
        id: v.id,
        title: v.title || '(untitled visit)',
        start: new Date(v.startAt),
        end: new Date(v.endAt),
        people: (v.assignedUsers.nodes || []).filter(function (u) { return u.name && u.name.last; })
          .map(function (u) { return u.name.first + ' ' + u.name.last.charAt(0); }),
        lanes: (v.assignedUsers.nodes || []).filter(function (u) { return u.name && !u.name.last; })
          .map(function (u) { return u.name.first; }),
      });
    });
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

function jobberToken_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('jobber_access_token');
  if (hit) return hit;
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('JOBBER_TOKEN_STORE_URL');
  var secret = props.getProperty('JOBBER_TOKEN_STORE_SECRET');
  if (!url || !secret) throw new Error('Set JOBBER_TOKEN_STORE_URL and JOBBER_TOKEN_STORE_SECRET in Script Properties.');
  var resp = UrlFetchApp.fetch(url + '?secret=' + encodeURIComponent(secret), { muteHttpExceptions: true });
  var body = JSON.parse(resp.getContentText());
  if (!body.ok) throw new Error('Token service error: ' + (body.error || resp.getContentText()));
  var access = (body.tokens || {}).access_token;
  if (!access) throw new Error('Token service returned no access_token.');
  cache.put('jobber_access_token', access, 1800);
  return access;
}

function jobberGql_(query, variables) {
  for (var attempt = 0; attempt < 3; attempt++) {
    var resp = UrlFetchApp.fetch(JOBBER_GRAPHQL_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + jobberToken_(), 'X-JOBBER-GRAPHQL-VERSION': JOBBER_API_VERSION },
      payload: JSON.stringify({ query: query, variables: variables || {} }),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    var body = JSON.parse(resp.getContentText() || '{}');
    if (code === 401) { CacheService.getScriptCache().remove('jobber_access_token'); continue; }
    if (body.errors) {
      var msg = JSON.stringify(body.errors);
      if (msg.indexOf('THROTTLED') !== -1) { Utilities.sleep(2000 * (attempt + 1)); continue; }
      throw new Error('Jobber GraphQL error: ' + msg);
    }
    if (code >= 400) throw new Error('Jobber HTTP ' + code + ': ' + resp.getContentText().slice(0, 300));
    return body.data;
  }
  throw new Error('Jobber GraphQL: gave up after 3 attempts.');
}

// ----------------------------------------------------------------------------
// WHAT SHOULD BE BUSY
// desired = { key: { start: Date, end: Date, title: String } }
// ----------------------------------------------------------------------------

function matchesPerson_(cfg, visit) {
  return visit.people.some(function (p) { return cfg.people.indexOf(p) !== -1; });
}

function desiredAny_(cfg, visits) {
  var desired = {};
  visits.forEach(function (v) {
    var hit = matchesPerson_(cfg, v) || v.lanes.some(function (l) { return cfg.lanes.indexOf(l) !== -1; });
    if (!hit) return;
    desired[v.id] = { start: v.start, end: v.end, title: 'Jobber: ' + v.title };
  });
  return desired;
}

function desiredAllLanes_(cfg, visits) {
  // Per lane, merge that lane's visits into non-overlapping intervals, then
  // intersect across lanes: a moment is busy only when every lane is busy.
  var perLane = cfg.lanes.map(function (lane) {
    var ivs = visits.filter(function (v) { return v.lanes.indexOf(lane) !== -1; })
      .map(function (v) { return [v.start.getTime(), v.end.getTime()]; });
    return mergeIntervals_(ivs);
  });
  var busy = perLane.length ? perLane[0] : [];
  for (var i = 1; i < perLane.length; i++) busy = intersectIntervals_(busy, perLane[i]);
  var desired = {};
  busy.forEach(function (iv) {
    if (iv[1] - iv[0] < 15 * 60000) return;   // ignore slivers under 15 min
    var start = new Date(iv[0]), end = new Date(iv[1]);
    desired[start.toISOString() + '|' + end.toISOString()] = {
      start: start, end: end, title: 'Cleaning crews booked (' + cfg.lanes.join(' + ') + ')',
    };
  });
  return desired;
}

function mergeIntervals_(ivs) {
  ivs = ivs.slice().sort(function (a, b) { return a[0] - b[0]; });
  var out = [];
  ivs.forEach(function (iv) {
    var last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  });
  return out;
}

function intersectIntervals_(a, b) {
  var out = [], i = 0, j = 0;
  while (i < a.length && j < b.length) {
    var lo = Math.max(a[i][0], b[j][0]), hi = Math.min(a[i][1], b[j][1]);
    if (lo < hi) out.push([lo, hi]);
    if (a[i][1] < b[j][1]) i++; else j++;
  }
  return out;
}

// ----------------------------------------------------------------------------
// GOOGLE CALENDAR
// ----------------------------------------------------------------------------

function ensureCalendar_(cfg) {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('CAL_ID_' + cfg.key);
  var cal = id ? CalendarApp.getCalendarById(id) : null;
  if (!cal) {
    var found = CalendarApp.getCalendarsByName(cfg.name);
    cal = found.length ? found[0] : CalendarApp.createCalendar(cfg.name, { timeZone: CAL_TZ, summary: 'Mirror of Jobber visits. Managed by the CGP Busy Calendars script — edits here are overwritten.' });
    props.setProperty('CAL_ID_' + cfg.key, cal.getId());
  }
  return cal;
}

// CalendarApp has no sharing method; the Calendar advanced service does
// (editor: Services + → Google Calendar API, identifier "Calendar").
function shareCalendar_(calendarId, email) {
  var already = (Calendar.Acl.list(calendarId).items || []).some(function (r) {
    return r.scope && r.scope.type === 'user' && r.scope.value === email;
  });
  if (already) return;
  Calendar.Acl.insert({ role: 'reader', scope: { type: 'user', value: email } }, calendarId);
  Logger.log('shared with ' + email);
}

// Make the calendar hold exactly `desired` (within the window), touching only
// our own tagged events. Unchanged events are left alone so Calendly's cached
// view of the calendar stays stable.
function reconcile_(cal, from, to, desired) {
  var created = 0, deleted = 0;
  var seen = {};
  cal.getEvents(from, to).forEach(function (ev) {
    var desc = ev.getDescription() || '';
    if (desc.indexOf(EVENT_TAG) === -1) return;
    var m = desc.match(/key=(\S+)/);
    var key = m ? m[1] : null;
    var want = key && desired[key];
    var same = want && ev.getStartTime().getTime() === want.start.getTime() &&
               ev.getEndTime().getTime() === want.end.getTime() && ev.getTitle() === want.title;
    if (same && !seen[key]) { seen[key] = true; return; }
    ev.deleteEvent(); deleted++;
  });
  Object.keys(desired).forEach(function (key) {
    if (seen[key]) return;
    var d = desired[key];
    cal.createEvent(d.title, d.start, d.end, { description: EVENT_TAG + ' key=' + key });
    created++;
  });
  return { created: created, deleted: deleted };
}

// ----------------------------------------------------------------------------
// PLUMBING
// ----------------------------------------------------------------------------

function ensureTrigger_() {
  var have = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'syncBusyCalendars'; });
  if (!have) ScriptApp.newTrigger('syncBusyCalendars').timeBased().everyMinutes(SYNC_EVERY_MINUTES).create();
}

function startOfDay_(d) {
  var s = Utilities.formatDate(d, CAL_TZ, "yyyy-MM-dd'T'00:00:00");
  // Interpret that wall-clock midnight in CAL_TZ by asking for its offset.
  var off = Utilities.formatDate(d, CAL_TZ, 'Z');   // e.g. -0400
  return new Date(s + off.slice(0, 3) + ':' + off.slice(3));
}

function fmt_(d) { return Utilities.formatDate(d, CAL_TZ, 'EEE MM/dd HH:mm'); }
