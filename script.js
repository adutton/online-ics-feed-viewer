const cors_anywhere_url = "https://larrybolt-cors-anywhere.herokuapp.com/";
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

function load_ics(ics_data) {
  _lastIcsData = ics_data;
  var events = parseIcsEvents(ics_data);
  var source = buildEventSource(events);
  calendar.removeAllEventSources();
  calendar.addEventSource(source);
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

function createShareUrl(feed, cors, title, file) {
  if (feed) {
    URIHash.set("feed", feed);
  }
  if (file) {
    URIHash.set("file", file);
  }
  URIHash.set("cors", cors);
  URIHash.set("title", title);
  var shareCheckbox = document.querySelector('#share input');
  URIHash.set("hideinput", shareCheckbox && shareCheckbox.checked);
  document.getElementById('share').style.display = 'block';
}

function openFile(event) {
  var input = event.target;
  var reader = new FileReader();
  reader.onload = function () {
    const result = reader.result.split("base64,")[1];
    createShareUrl(null, false, "My events", result);
    load_ics_from_base64(result);
  };
  reader.readAsDataURL(input.files[0]);
}

function load_ics_from_base64(input) {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const contents = new TextDecoder('utf-8').decode(bytes);
  load_ics(contents);
}

function fetch_ics_feed(url, cors, show_share) {
  var fetchUrl = cors ? cors_anywhere_url + url : url;
  fetch(fetchUrl)
    .then(function(response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.text();
    })
    .then(function(text) { load_ics(text); })
    .catch(function(err) { console.error('Failed to fetch ICS feed:', err); });
  if (show_share) {
    createShareUrl(url, !!cors, "My Feed");
  }
}

function escapeHtml(unsafe) {
  return unsafe
       .replace(/&/g, "&amp;")
       .replace(/</g, "&lt;")
       .replace(/>/g, "&gt;")
       .replace(/"/g, "&quot;")
       .replace(/'/g, "&#039;");
}

function linkify(text){
  const words = text.split(' ');
  for (i in words) {
      if (words[i].indexOf('http://') == 0 || words[i].indexOf('https://') == 0) {
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
  console.log({
    url_feed,
    url_file,
    url_cors,
    url_title,
    url_hideinput,
    url_view,
    url_startdate,
    url_tz
  });

  // Set timezone dropdown before initializing calendar
  if (url_tz) {
    document.getElementById('tz-select').value = url_tz;
  }
  initCalendar();
  if (url_title) {
    document.querySelector("h1").textContent = url_title;
  }
  if (url_feed) {
    var url = url_feed.replace(cors_anywhere_url, "");
    console.log('Load ' + url);
    fetch_ics_feed(url, url_cors, false);
    document.getElementById("eventsource").value = url;
  } else if (url_file) {
    console.log('Load file from file');
    load_ics_from_base64(url_file);
  }
  if (url_cors) {
    document.getElementById("cors-enabled").checked = true;
  }
  if (url_hideinput) {
    document.body.classList.add("from_url");
  }
  if (url_view) {
    calendar.changeView(mapViewName(url_view));
  }
  if (url_startdate) {
    calendar.gotoDate(url_startdate);
  }
}

// Bind all UI event listeners once on DOMContentLoaded
function bindEventListeners() {
  document.getElementById('tz-select').addEventListener('change', function() {
    var tz = this.value;
    // Set hash without triggering full reload — just update the calendar timezone
    _ignoreNextHashChange = true;
    URIHash.set('tz', tz || '');
    applyTimezone();
  });
  document.querySelector('#share input').addEventListener('click', function() {
    if (document.getElementById("cors-enabled").checked) {
      URIHash.set('hideinput', 'true');
    }
  });
  document.getElementById("fetch").addEventListener('click', function() {
    var corsAnywhereOn = document.getElementById("cors-enabled").checked;
    var url = document.getElementById("eventsource").value;
    fetch_ics_feed(url, corsAnywhereOn, true);
  });
  document.getElementById("load-text").addEventListener('click', function() {
    var text = document.getElementById("ics-text").value.trim();
    if (text) {
      load_ics(text);
    }
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

var _ignoreNextHashChange = false;

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
