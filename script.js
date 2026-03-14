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

function load_ics(ics_data) {
  _lastIcsData = ics_data;
  const parsed = ICAL.parse(ics_data);
  const rawBlocks = extractRawVevents(ics_data);
  var veventIndex = 0;
  const events = parsed[2].map(([type, event_fields]) => {
    if (type !== "vevent") return;
    var event = event_fields.reduce((event, field) => {
      const [original_key, params, type, original_value] = field;
      const key =
        original_key in mapping ? mapping[original_key] : original_key;
      var value =
        type in value_type_mapping
          ? value_type_mapping[type](original_value)
          : original_value;
      // For start/end times: store the original value and TZID for the detail popup,
      // then convert to UTC for FullCalendar's timezone conversion
      if (original_key === 'dtstart' || original_key === 'dtend') {
        event['_orig_' + key] = value;
        if (params && params.tzid) {
          event[key + '_tzid'] = params.tzid;
          value = moment.tz(value, params.tzid).toISOString();
        }
      }
      event[key] = value;
      return event;
    }, {});
    event._rawIcs = rawBlocks[veventIndex] || '';
    veventIndex++;
    return event;
  });
  $("#calendar").fullCalendar("removeEventSources");
  $("#calendar").fullCalendar("addEventSource", events);
}

function getTimezoneOption() {
  var tz = $('#tz-select').val();
  if (tz === 'local') return 'local';
  return tz || 'local';
}

function applyTimezone() {
  if (!_lastIcsData) return;
  var cal = $('#calendar');
  // Save current view and date so we can restore after reinit
  var currentView = cal.fullCalendar('getView');
  var currentDate = cal.fullCalendar('getDate');
  // Destroy and reinitialize with the new timezone
  cal.fullCalendar('destroy');
  initCalendar();
  if (currentView) {
    cal.fullCalendar('changeView', currentView.name);
  }
  if (currentDate) {
    cal.fullCalendar('gotoDate', currentDate);
  }
  // Re-add the events
  load_ics(_lastIcsData);
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
  URIHash.set("hideinput", $("#share input").is(":checked"));
  $("#share").show("slow");
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
  const contents = atob(input);
  load_ics(contents);
}

function fetch_ics_feed(url, cors, show_share) {
  $.get(cors ? `${cors_anywhere_url}${url}` : url, (res) => load_ics(res));
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

function initCalendar() {
  $("#calendar").fullCalendar({
    header: {
      left: "prev,next today",
      center: "title",
      right: "month,agendaWeek,agendaDay,listMonth",
    },
    defaultView: "month",
    timezone: getTimezoneOption(),
    views: {
      agendaWeek: {
        columnFormat : "ddd D MMM"
      }
    },
    navLinks: true,
    editable: false,
    minTime: "0:00:00",
    maxTime: "23:59:59",
    nowIndicator: true,
    viewRender: function(view) {
      URIHash.set('view', view.name);
    },
    eventClick: function(info, jsEvent) {
      jsEvent.preventDefault();
      $('#popup-content h2').text(info['title']);

      // Time and timezone — show original times from the ICS, not the converted ones
      var timeHtml = '';
      var origStart = info['_orig_start'];
      var origEnd = info['_orig_end'];
      var startTzid = info['start_tzid'];
      var endTzid = info['end_tzid'];
      if (origStart) {
        var startMoment = startTzid ? moment.tz(origStart, startTzid) : moment(origStart);
        var fmt = info.allDay ? 'ddd, MMM D, YYYY' : 'ddd, MMM D, YYYY h:mm A';
        timeHtml = startMoment.format(fmt);
        if (origEnd) {
          var endMoment = endTzid ? moment.tz(origEnd, endTzid) : moment(origEnd);
          if (info.allDay) {
            if (!endMoment.isSame(startMoment, 'day')) {
              timeHtml += ' — ' + endMoment.format(fmt);
            }
          } else {
            if (endMoment.isSame(startMoment, 'day')) {
              timeHtml += ' — ' + endMoment.format('h:mm A');
            } else {
              timeHtml += ' — ' + endMoment.format(fmt);
            }
          }
        }
        if (!info.allDay && startTzid) {
          timeHtml += ' <span style="color:#999;">(' + escapeHtml(startTzid) + ')</span>';
        }
      } else if (info.start) {
        // Fallback if no original times stored (e.g. no TZID in ICS)
        var startMoment = moment(info.start);
        var fmt = info.allDay ? 'ddd, MMM D, YYYY' : 'ddd, MMM D, YYYY h:mm A';
        timeHtml = startMoment.format(fmt);
        if (info.end) {
          var endMoment = moment(info.end);
          if (info.allDay) {
            if (!endMoment.isSame(startMoment, 'day')) {
              timeHtml += ' — ' + endMoment.format(fmt);
            }
          } else {
            if (endMoment.isSame(startMoment, 'day')) {
              timeHtml += ' — ' + endMoment.format('h:mm A');
            } else {
              timeHtml += ' — ' + endMoment.format(fmt);
            }
          }
        }
      }
      $('.popup-time').html(timeHtml);

      // Description
      const popup_content = $('#popup-content p');
      popup_content.empty();
      if (info['description']) {
        info['description'].split("\n").forEach(function (item) {
          popup_content.append($("<span></span>").html(linkify(escapeHtml(item))));
        });
      }

      // URL link
      var popup_link = $('#popup-content .popup-link');
      if (info['url']) {
        popup_link.attr('href', info['url']).text(info['url']).show();
      } else {
        popup_link.hide();
      }

      // Raw ICS data
      $('#popup-raw').text(info._rawIcs || 'No raw ICS data available').hide();

      $('#popup').show();
      return false;
    }
  });
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
    $('#tz-select').val(url_tz);
  }
  initCalendar();
  if (url_title) {
    $("h1").text(url_title);
  }
  if (url_feed) {
    url = url_feed.replace(cors_anywhere_url, "");
    console.log(`Load ${url}`);
    fetch_ics_feed(url, url_cors, false);
    $("#eventsource").val(url);
  } else if (url_file) {
    console.log(`Load file from file`);
    load_ics_from_base64(url_file);
  }
  if (url_cors) {
    $("#cors-enabled").prop("checked", true);
  }
  if (url_hideinput) {
    $("body").addClass("from_url");
  }
  if (url_view) {
      $('#calendar').fullCalendar("changeView", url_view);
  }
  if (url_startdate) {
      $('#calendar').fullCalendar("gotoDate", url_startdate);
  }
  $('#tz-select').on('change', function() {
    var tz = $(this).val();
    if (tz) {
      URIHash.set('tz', tz);
    } else {
      URIHash.set('tz', '');
    }
    applyTimezone();
  });
  $('#share input').click(function(){
    if ($("#cors-enabled").is(":checked")) {
      URIHash.set('hideinput', 'true')
    }
  });
  $("#fetch").click(function () {
    const corsAnywhereOn = $("#cors-enabled").is(":checked");
    const url = $("#eventsource").val();
    fetch_ics_feed(url, corsAnywhereOn, true);
  });
  $('#popup-close').on('click', function() {
    $('#popup').hide();
  });
  $('#popup-raw-toggle').on('click', function() {
    $('#popup-raw').toggle();
  });
};
$(document).keyup(function(e) {
  if (e.which == 27) {
    $('#popup').hide();
  }
});
$(document).ready(function () {
    $(window).on('hashchange', function () {
        loadCalendar();
    }).trigger('hashchange');
});
