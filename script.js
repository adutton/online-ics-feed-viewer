(function () {
'use strict';

// Public CORS proxy. allorigins is the most boring/stable free option;
// expects the target URL as a query parameter.
const cors_proxy_url = "https://api.allorigins.win/raw?url=";

// Browsers cap the URL length around 32 KB; base64 of the file is the dominant
// component. ~24000 base64 chars ≈ 18 KB raw, which keeps the share URL safe.
const MAX_SHAREABLE_BASE64 = 24000;

// Old shared links may have the legacy heroku CORS proxy baked into the feed URL.
const LEGACY_CORS_ANYWHERE_PREFIX = "https://larrybolt-cors-anywhere.herokuapp.com/";

const mapping = {
  dtstart: "start",
  dtend: "end",
  summary: "title",
};

const value_type_mapping = {
  "date-time": (input) => {
    if (input.substr(-3) === "T::") {
      return input.substr(0, input.length - 3);
    }
    return input;
  },
};

// View name mapping for backward compatibility with old URL hashes
var VIEW_NAME_MAP = {
  'month': 'dayGridMonth',
  'agendaWeek': 'timeGridWeek',
  'agendaDay': 'timeGridDay',
  'listMonth': 'listMonth'
};

var calendar = null;
var _lastIcsData = null;
var _ignoreNextHashChange = false;

function setStatus(msg, isError) {
  var el = document.getElementById('status');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('error', !!isError);
}

function syncToggleLabel() {
  var btn = document.getElementById('toggle-form');
  if (!btn) return;
  btn.textContent = document.body.classList.contains('from_url') ? 'Show form' : 'Hide form';
}

function showShareLink() {
  var link = document.getElementById('share-link');
  if (link) {
    link.hidden = false;
    link.href = window.location.href;
  }
}

function hideShareLink() {
  var link = document.getElementById('share-link');
  if (link) link.hidden = true;
}

// Replace the entire URL hash atomically. Empty/null/undefined values delete keys.
// One assignment → at most one hashchange event, which we suppress.
function setUrlState(updates) {
  var dump = URIHash.dump() || [];
  var hashParts = [];
  for (var k in dump) {
    if (Object.prototype.hasOwnProperty.call(updates, k)) continue;
    hashParts.push(escape(k) + '=' + escape(dump[k]));
  }
  for (var k2 in updates) {
    var v = updates[k2];
    if (v === null || v === undefined || v === '') continue;
    hashParts.push(escape(k2) + '=' + escape(v));
  }
  var newHash = hashParts.join('&');
  var current = document.location.hash.replace(/^#/, '');
  if (current === newHash) return;
  _ignoreNextHashChange = true;
  document.location.hash = newHash;
}

// Update checkbox + URL hash + share link to reflect what was actually used.
function applyUrlState(url, cors) {
  document.getElementById('cors-enabled').checked = !!cors;
  setUrlState({
    feed: url,
    file: '',
    cors: cors ? 'true' : ''
  });
  showShareLink();
}

function applyFileUrlState(base64) {
  document.getElementById('cors-enabled').checked = false;
  setUrlState({
    feed: '',
    file: base64,
    cors: ''
  });
  showShareLink();
}

function clearFeedFileUrlState() {
  setUrlState({ feed: '', file: '', cors: '' });
}

function extractRawVevents(ics_data) {
  var blocks = [];
  var regex = /BEGIN:VEVENT[\s\S]*?END:VEVENT/gi;
  var match;
  while ((match = regex.exec(ics_data)) !== null) {
    blocks.push(match[0]);
  }
  return blocks;
}

function parseIcsEvents(ics_data) {
  const parsed = ICAL.parse(ics_data);
  const rawBlocks = extractRawVevents(ics_data);
  var veventIndex = 0;
  return parsed[2].map(([type, event_fields]) => {
    if (type !== "vevent") return;
    var event = event_fields.reduce((event, field) => {
      const [original_key, params, type, original_value] = field;
      const key =
        original_key in mapping ? mapping[original_key] : original_key;
      var value =
        type in value_type_mapping
          ? value_type_mapping[type](original_value)
          : original_value;
      if (original_key === 'dtstart' || original_key === 'dtend') {
        event['_orig_' + key] = value;
        if (params && params.tzid) {
          event[key + '_tzid'] = params.tzid;
          // Build an ISO string with timezone offset using Intl
          event['_utc_' + key] = tzToUTC(value, params.tzid);
        } else if (typeof value === 'string' && value.endsWith('Z')) {
          event['_utc_' + key] = value;
        } else {
          // Floating time — no timezone info
          event['_utc_' + key] = null;
        }
      }
      event[key] = value;
      return event;
    }, {});
    event._rawIcs = rawBlocks[veventIndex] || '';
    veventIndex++;
    return event;
  });
}

// Convert a datetime string in a given IANA timezone to a UTC ISO string
function tzToUTC(dateStr, tzid) {
  // dateStr is like "2024-01-15T10:00:00" or "20240115T100000"
  // Normalize to ISO format
  var normalized = dateStr;
  if (dateStr.length >= 15 && dateStr[8] === 'T' && dateStr.indexOf('-') === -1) {
    // Compact format: 20240115T100000
    normalized = dateStr.substring(0, 4) + '-' + dateStr.substring(4, 6) + '-' +
                 dateStr.substring(6, 8) + 'T' + dateStr.substring(9, 11) + ':' +
                 dateStr.substring(11, 13) + ':' + dateStr.substring(13, 15);
  }
  // Use the Intl API to figure out the offset at this time in this timezone
  // Create a date assuming UTC, then find the difference
  var utcGuess = new Date(normalized + 'Z');
  var formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  var parts = {};
  formatter.formatToParts(utcGuess).forEach(function(p) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  });
  // Build the local time at utcGuess in the target timezone
  var localAtUtc = new Date(
    parts.year + '-' + parts.month + '-' + parts.day + 'T' +
    (parts.hour === '24' ? '00' : parts.hour) + ':' + parts.minute + ':' + parts.second + 'Z'
  );
  // The offset is how much the tz is ahead of UTC
  var offsetMs = localAtUtc.getTime() - utcGuess.getTime();
  // The actual UTC time for the given local time is: local - offset
  var actualUtc = new Date(utcGuess.getTime() - offsetMs);
  return actualUtc.toISOString();
}

// Convert a UTC ISO string to a local datetime string in the given IANA timezone
// Returns "YYYY-MM-DDTHH:mm:ss" (no Z, so FC treats it as local)
function utcToTzLocal(utcIso, tzid) {
  var date = new Date(utcIso);
  var formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tzid,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  var parts = {};
  formatter.formatToParts(date).forEach(function(p) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  });
  var h = parts.hour === '24' ? '00' : parts.hour;
  return parts.year + '-' + parts.month + '-' + parts.day + 'T' + h + ':' + parts.minute + ':' + parts.second;
}

function buildEventSource(events) {
  var tz = getTimezoneOption();
  return events.filter(Boolean).map(function(event) {
    var start, end;
    if (event['_utc_start']) {
      if (tz === 'local') {
        // Pass UTC string — FC in 'local' mode will convert to browser tz
        start = event['_utc_start'];
      } else if (tz === 'UTC') {
        // Strip Z and pass as bare datetime so FC (in local mode) shows it as-is
        start = event['_utc_start'].replace('Z', '').replace(/\.\d+$/, '');
      } else {
        // Named timezone: convert UTC to that tz, pass as bare datetime
        start = utcToTzLocal(event['_utc_start'], tz);
      }
    } else {
      start = event.start;
    }
    if (event['_utc_end']) {
      if (tz === 'local') {
        end = event['_utc_end'];
      } else if (tz === 'UTC') {
        end = event['_utc_end'].replace('Z', '').replace(/\.\d+$/, '');
      } else {
        end = utcToTzLocal(event['_utc_end'], tz);
      }
    } else {
      end = event.end;
    }
    return {
      title: event.title || 'Untitled',
      start: start,
      end: end,
      allDay: event.start && event.start.length <= 10,
      extendedProps: {
        description: event.description || '',
        location: event.location || '',
        _rawIcs: event._rawIcs || '',
        _orig_start: event._orig_start,
        _orig_end: event._orig_end,
        start_tzid: event.start_tzid,
        end_tzid: event.end_tzid,
        eventUrl: event.url || ''
      }
    };
  });
}

function loadIcs(ics_data) {
  _lastIcsData = ics_data;
  var events = parseIcsEvents(ics_data);
  var source = buildEventSource(events);
  calendar.removeAllEventSources();
  calendar.addEventSource(source);
  setStatus('');
  document.body.classList.add('from_url');
  syncToggleLabel();
}

function getTimezoneOption() {
  var tz = document.getElementById('tz-select').value;
  if (tz === 'local') return 'local';
  return tz || 'local';
}

function applyTimezone() {
  if (!calendar || !_lastIcsData) return;
  // Re-parse events and rebuild source with times converted to the new timezone
  var events = parseIcsEvents(_lastIcsData);
  var source = buildEventSource(events);
  calendar.removeAllEventSources();
  calendar.addEventSource(source);
}

function loadSelectedFile() {
  var input = document.getElementById('myfile');
  if (!input.files || !input.files[0]) {
    setStatus('No file selected.', true);
    return;
  }
  var reader = new FileReader();
  reader.onload = function () {
    const result = reader.result.split('base64,')[1];
    if (result.length > MAX_SHAREABLE_BASE64) {
      // Too big to round-trip via the URL; render but skip the share link.
      hideShareLink();
      clearFeedFileUrlState();
      setStatus('File is too large to share via URL; rendering locally only.');
    } else {
      applyFileUrlState(result);
    }
    loadIcsFromBase64(result);
  };
  reader.readAsDataURL(input.files[0]);
}

function loadIcsFromBase64(input) {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const contents = new TextDecoder('utf-8').decode(bytes);
  loadIcs(contents);
}

// Public CORS proxies sometimes return short plaintext error blobs
// (e.g. "error code: 522") with a 200 status. Reject those before
// handing them to the parser, which would fail with confusing errors.
function looksLikeIcs(text) {
  if (!text) return false;
  var trimmed = text.replace(/^﻿/, '').trim();
  if (!trimmed) return false;
  if (/^error code:\s*\d+/i.test(trimmed)) return false;
  // RFC 5545 requires VCALENDAR as the outermost component.
  if (!/BEGIN:VCALENDAR/i.test(trimmed)) return false;
  return true;
}

function fetchText(url) {
  return fetch(url).then(function(response) {
    if (!response.ok) {
      var err = new Error('HTTP ' + response.status);
      err.httpStatus = response.status;
      throw err;
    }
    return response.text();
  });
}

// Only network/CORS failures are worth retrying via the proxy.
// HTTP error responses (404, 500, …) reached the origin successfully
// and represent a definitive answer.
function isLikelyCorsError(err) {
  return !err.httpStatus;
}

function fetchViaProxy(url) {
  return fetchText(cors_proxy_url + encodeURIComponent(url))
    .then(function(text) {
      if (!looksLikeIcs(text)) {
        var preview = text ? text.trim().slice(0, 80) : '(empty)';
        throw new Error('CORS proxy returned invalid response: ' + preview);
      }
      return text;
    });
}

function fetchIcsFeed(url, cors) {
  if (!url) return;
  if (cors) {
    setStatus('Fetching ' + url + ' via CORS proxy...');
    fetchViaProxy(url)
      .then(function(text) {
        applyUrlState(url, true);
        loadIcs(text);
      })
      .catch(function(err) {
        console.error('Failed to fetch ICS feed via proxy:', err);
        setStatus('Failed to fetch via proxy: ' + err.message, true);
      });
    return;
  }
  setStatus('Fetching ' + url + '...');
  fetchText(url)
    .then(function(text) {
      if (!looksLikeIcs(text)) throw new Error('Response did not look like an ICS feed');
      applyUrlState(url, false);
      loadIcs(text);
    })
    .catch(function(err) {
      if (!isLikelyCorsError(err)) {
        console.error('Failed to fetch ICS feed:', err);
        setStatus('Failed to fetch: ' + err.message, true);
        return;
      }
      console.warn('Direct fetch failed, retrying via CORS proxy:', err);
      setStatus('Direct fetch failed (' + err.message + '); retrying via CORS proxy...');
      fetchViaProxy(url)
        .then(function(text) {
          applyUrlState(url, true);
          loadIcs(text);
        })
        .catch(function(err2) {
          console.error('Failed to fetch ICS feed:', err2);
          setStatus('Failed to fetch: ' + err2.message, true);
        });
    });
}

function escapeHtml(unsafe) {
  return unsafe
       .replace(/&/g, "&amp;")
       .replace(/</g, "&lt;")
       .replace(/>/g, "&gt;")
       .replace(/"/g, "&quot;")
       .replace(/'/g, "&#039;");
}

function linkify(text) {
  const words = text.split(' ');
  for (var i = 0; i < words.length; i++) {
    if (words[i].indexOf('http://') === 0 || words[i].indexOf('https://') === 0) {
      words[i] = '<a href="' + words[i] + '">' + words[i] + '</a>';
    }
  }
  return words.join(' ');
}

function formatDateTime(dateObj, tzid, allDay) {
  if (!dateObj) return '';
  var options = allDay
    ? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true };
  if (tzid && tzid !== 'local') {
    options.timeZone = tzid;
  }
  return new Intl.DateTimeFormat('en-US', options).format(dateObj);
}

function isSameDay(d1, d2, tzid) {
  var opts = { year: 'numeric', month: '2-digit', day: '2-digit' };
  if (tzid && tzid !== 'local') opts.timeZone = tzid;
  var fmt = new Intl.DateTimeFormat('en-US', opts);
  return fmt.format(d1) === fmt.format(d2);
}

function showPopup(info) {
  var event = info.event;
  var ep = event.extendedProps;

  document.querySelector('#popup-content h2').textContent = event.title;

  // Time and timezone — show original times from the ICS
  var timeHtml = '';
  var origStart = ep._orig_start;
  var origEnd = ep._orig_end;
  var startTzid = ep.start_tzid;
  var endTzid = ep.end_tzid;

  if (origStart) {
    var startDate = startTzid ? new Date(tzToUTC(origStart, startTzid)) : new Date(origStart);
    var fmt_allDay = event.allDay;
    timeHtml = formatDateTime(startDate, startTzid, fmt_allDay);
    if (origEnd) {
      var endDate = endTzid ? new Date(tzToUTC(origEnd, endTzid)) : new Date(origEnd);
      if (fmt_allDay) {
        if (!isSameDay(startDate, endDate, startTzid)) {
          timeHtml += ' — ' + formatDateTime(endDate, endTzid, true);
        }
      } else {
        if (isSameDay(startDate, endDate, startTzid)) {
          timeHtml += ' — ' + new Intl.DateTimeFormat('en-US', {
            hour: 'numeric', minute: '2-digit', hour12: true,
            timeZone: startTzid && startTzid !== 'local' ? startTzid : undefined
          }).format(endDate);
        } else {
          timeHtml += ' — ' + formatDateTime(endDate, endTzid, false);
        }
      }
    }
    if (!fmt_allDay && startTzid) {
      timeHtml += ' <span style="color:#999;">(' + escapeHtml(startTzid) + ')</span>';
    }
  } else if (event.start) {
    timeHtml = formatDateTime(event.start, null, event.allDay);
    if (event.end) {
      if (event.allDay) {
        if (!isSameDay(event.start, event.end, null)) {
          timeHtml += ' — ' + formatDateTime(event.end, null, true);
        }
      } else {
        if (isSameDay(event.start, event.end, null)) {
          timeHtml += ' — ' + new Intl.DateTimeFormat('en-US', {
            hour: 'numeric', minute: '2-digit', hour12: true
          }).format(event.end);
        } else {
          timeHtml += ' — ' + formatDateTime(event.end, null, false);
        }
      }
    }
  }
  document.querySelector('.popup-time').innerHTML = timeHtml;

  // Description
  var popupP = document.querySelector('#popup-content p');
  popupP.innerHTML = '';
  if (ep.description) {
    ep.description.split("\n").forEach(function(item) {
      var span = document.createElement('span');
      span.innerHTML = linkify(escapeHtml(item));
      popupP.appendChild(span);
    });
  }

  // URL link
  var popupLink = document.querySelector('#popup-content .popup-link');
  if (ep.eventUrl) {
    popupLink.href = ep.eventUrl;
    popupLink.textContent = ep.eventUrl;
    popupLink.style.display = 'block';
  } else {
    popupLink.style.display = 'none';
  }

  // Raw ICS data — store data and reset visibility
  var rawEl = document.getElementById('popup-raw');
  rawEl.textContent = ep._rawIcs || 'No raw ICS data available';
  rawEl.style.display = 'none';

  document.getElementById('popup').style.display = 'block';
}

function initCalendar() {
  var calendarEl = document.getElementById('calendar');
  // Destroy existing calendar if re-initializing
  if (calendar) {
    calendar.destroy();
  }
  calendar = new FullCalendar.Calendar(calendarEl, {
    headerToolbar: {
      left: "prev,next today",
      center: "title",
      right: "dayGridMonth,timeGridWeek,timeGridDay,listMonth",
    },
    initialView: "dayGridMonth",
    timeZone: 'local',
    dayHeaderFormat: { weekday: 'short', day: 'numeric', month: 'short' },
    navLinks: true,
    editable: false,
    slotMinTime: "00:00:00",
    slotMaxTime: "23:59:59",
    nowIndicator: true,
    datesSet: function(info) {
      _ignoreNextHashChange = true;
      URIHash.set('view', info.view.type);
    },
    eventClick: function(info) {
      info.jsEvent.preventDefault();
      showPopup(info);
      return false;
    }
  });
  calendar.render();
}

function mapViewName(viewName) {
  return VIEW_NAME_MAP[viewName] || viewName;
}

function loadCalendar() {
  const url_feed = URIHash.get("feed");
  const url_file = URIHash.get("file");
  const url_cors = URIHash.get("cors") === "true";
  const url_title = URIHash.get("title");
  const url_hideinput = URIHash.get("hideinput") === 'true';
  const url_view = URIHash.get("view");
  const url_startdate = URIHash.get("startdate");
  const url_tz = URIHash.get("tz");

  if (url_tz) {
    document.getElementById('tz-select').value = url_tz;
  }
  initCalendar();
  if (url_title) {
    document.querySelector("h1").textContent = url_title;
  }
  if (url_cors) {
    document.getElementById("cors-enabled").checked = true;
  }
  // hideinput is now a no-op (auto-hide on render handles this). Kept for
  // backward-compat with already-shared links.
  if (url_hideinput) {
    document.body.classList.add('from_url');
  }
  if (url_feed) {
    var url = url_feed.indexOf(LEGACY_CORS_ANYWHERE_PREFIX) === 0
      ? url_feed.substring(LEGACY_CORS_ANYWHERE_PREFIX.length)
      : url_feed;
    document.getElementById("eventsource").value = url;
    showShareLink();
    fetchIcsFeed(url, url_cors);
  } else if (url_file) {
    showShareLink();
    loadIcsFromBase64(url_file);
  }
  if (url_view) {
    calendar.changeView(mapViewName(url_view));
  }
  if (url_startdate) {
    calendar.gotoDate(url_startdate);
  }
  syncToggleLabel();
}

function bindEventListeners() {
  document.getElementById('tz-select').addEventListener('change', function() {
    var tz = this.value;
    _ignoreNextHashChange = true;
    URIHash.set('tz', tz || '');
    applyTimezone();
    showShareLink();
  });
  document.getElementById('fetch-form').addEventListener('submit', function(e) {
    e.preventDefault();
    var corsOn = document.getElementById('cors-enabled').checked;
    var url = document.getElementById('eventsource').value.trim();
    if (!url) return;
    fetchIcsFeed(url, corsOn);
  });
  document.getElementById('load-file').addEventListener('click', loadSelectedFile);
  document.getElementById('load-text').addEventListener('click', function() {
    var text = document.getElementById('ics-text').value.trim();
    if (!text) return;
    // Pasted text isn't shareable via URL.
    clearFeedFileUrlState();
    hideShareLink();
    loadIcs(text);
  });
  document.getElementById('toggle-form').addEventListener('click', function() {
    document.body.classList.toggle('from_url');
    syncToggleLabel();
  });
  document.getElementById('popup-close').addEventListener('click', function() {
    document.getElementById('popup').style.display = 'none';
  });
  document.getElementById('popup-raw-toggle').addEventListener('click', function() {
    var raw = document.getElementById('popup-raw');
    raw.style.display = raw.style.display === 'none' ? 'block' : 'none';
  });
  document.addEventListener('keyup', function(e) {
    if (e.key === 'Escape') {
      document.getElementById('popup').style.display = 'none';
    }
  });
}

document.addEventListener('DOMContentLoaded', function() {
  bindEventListeners();
  window.addEventListener('hashchange', function() {
    if (_ignoreNextHashChange) {
      _ignoreNextHashChange = false;
      return;
    }
    loadCalendar();
  });
  loadCalendar();
});

})();
