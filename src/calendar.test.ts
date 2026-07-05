import test from "node:test";
import assert from "node:assert/strict";
import { eventsOnLocalDate, formatEventLines, totalBusyHours } from "./calendar.js";

function ics(body: string): string {
  return ["BEGIN:VCALENDAR", body, "END:VCALENDAR"].join("\r\n");
}

function vevent(props: string[]): string {
  return ["BEGIN:VEVENT", ...props, "END:VEVENT"].join("\r\n");
}

test("finds a plain UTC event on its date", () => {
  const text = ics(
    vevent(["SUMMARY:Client call", "DTSTART:20260706T130000Z", "DTEND:20260706T140000Z"])
  );
  const events = eventsOnLocalDate(text, "2026-07-06", "UTC");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.summary, "Client call");
  assert.equal(events[0]?.allDay, false);
  assert.equal(totalBusyHours(events), 1);

  assert.equal(eventsOnLocalDate(text, "2026-07-07", "UTC").length, 0);
});

test("respects TZID and the user's timezone when matching dates", () => {
  // 23:00 Chicago on Jul 6 = 04:00 UTC Jul 7 — still "Jul 6" for a Chicago user.
  const text = ics(
    vevent(["SUMMARY:Late call", "DTSTART;TZID=America/Chicago:20260706T230000"])
  );
  assert.equal(eventsOnLocalDate(text, "2026-07-06", "America/Chicago").length, 1);
  assert.equal(eventsOnLocalDate(text, "2026-07-06", "UTC").length, 0);
  assert.equal(eventsOnLocalDate(text, "2026-07-07", "UTC").length, 1);
});

test("handles all-day events", () => {
  const text = ics(vevent(["SUMMARY:Conference", "DTSTART;VALUE=DATE:20260706"]));
  const events = eventsOnLocalDate(text, "2026-07-06", "America/Chicago");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.allDay, true);
  assert.equal(eventsOnLocalDate(text, "2026-07-05", "America/Chicago").length, 0);
});

test("expands a daily recurrence started in the past", () => {
  const text = ics(
    vevent(["SUMMARY:Standup", "DTSTART:20260601T090000Z", "DTEND:20260601T091500Z", "RRULE:FREQ=DAILY"])
  );
  const events = eventsOnLocalDate(text, "2026-07-06", "UTC");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.start?.toISOString(), "2026-07-06T09:00:00.000Z");
  assert.equal(events[0]?.end?.toISOString(), "2026-07-06T09:15:00.000Z");
});

test("weekly recurrence with BYDAY matches only listed weekdays", () => {
  // 2026-07-06 is a Monday, 2026-07-07 a Tuesday.
  const text = ics(
    vevent([
      "SUMMARY:Gym",
      "DTSTART:20260601T170000Z", // a Monday
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE",
    ])
  );
  assert.equal(eventsOnLocalDate(text, "2026-07-06", "UTC").length, 1);
  assert.equal(eventsOnLocalDate(text, "2026-07-07", "UTC").length, 0);
  assert.equal(eventsOnLocalDate(text, "2026-07-08", "UTC").length, 1);
});

test("recurrence honors UNTIL and COUNT", () => {
  const until = ics(
    vevent(["SUMMARY:Sprint", "DTSTART:20260601T100000Z", "RRULE:FREQ=DAILY;UNTIL=20260615T100000Z"])
  );
  assert.equal(eventsOnLocalDate(until, "2026-06-10", "UTC").length, 1);
  assert.equal(eventsOnLocalDate(until, "2026-07-06", "UTC").length, 0);

  const count = ics(
    vevent(["SUMMARY:Onboarding", "DTSTART:20260701T100000Z", "RRULE:FREQ=DAILY;COUNT=3"])
  );
  assert.equal(eventsOnLocalDate(count, "2026-07-03", "UTC").length, 1);
  assert.equal(eventsOnLocalDate(count, "2026-07-04", "UTC").length, 0);
});

test("skips cancelled events and unfolds continuation lines", () => {
  const text = ics(
    [
      vevent(["SUMMARY:Cancelled thing", "STATUS:CANCELLED", "DTSTART:20260706T130000Z"]),
      "BEGIN:VEVENT",
      "SUMMARY:Long titled",
      " event",
      "DTSTART:20260706T150000Z",
      "END:VEVENT",
    ].join("\r\n")
  );
  const events = eventsOnLocalDate(text, "2026-07-06", "UTC");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.summary, "Long titledevent");
});

test("formatEventLines renders times in the user's timezone", () => {
  const text = ics(
    vevent(["SUMMARY:Client call", "DTSTART:20260706T140000Z", "DTEND:20260706T150000Z"])
  );
  const events = eventsOnLocalDate(text, "2026-07-06", "America/Chicago");
  const lines = formatEventLines(events, "America/Chicago");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /09:00–10:00 Client call/);
});
