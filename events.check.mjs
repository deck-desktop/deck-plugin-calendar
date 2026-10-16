// The calendar's pure logic, checked without a network call or a browser.
//
//   node events.check.mjs
//
// Deck has no test runner; this follows the repository's pattern of a standalone node:assert
// script. What is worth pinning is every case a real calendar has and a hand-written example
// does not: an all-day event's exclusive end date, a meeting that runs past midnight, several
// calendars merged into one week, and overlapping events sharing a column.
//
// The fixtures carry +03:00 offsets and the code renders in local time, so the zone is pinned:
// without this the expected "HH:MM" values only hold on a machine that happens to be at +03:00.
process.env.TZ = "Etc/GMT-3"; // POSIX sign convention: GMT-3 IS UTC+3
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

// events.ts is TypeScript, so it is stripped to JS in a temp file and imported. Cheaper than a
// build step for the one module under test, and it checks the real source rather than a copy.
const dir = mkdtempSync(join(tmpdir(), "deck-cal-"));
const out = join(dir, "events.mjs");
await build({
  entryPoints: [join(import.meta.dirname, "src/events.ts")],
  outfile: out, format: "esm", bundle: false,
});
const { toEvents, layout, until, minutes, weekDays, weekBounds, currentIndex, dueSoon } =
  await import(`file://${out}`);
rmSync(dir, { recursive: true, force: true });

const on = (day) => `2026-09-${String(day).padStart(2, "0")}`;

// ---- all-day: end.date is EXCLUSIVE -----------------------------------------------------
// A one-day holiday is start=12, end=13. Iterating through the end would paint two columns.
const holiday = toEvents([{ id: "h", summary: "Public holiday",
  start: { date: on(12) }, end: { date: on(13) } }]);
assert.equal(holiday.length, 1, "a one-day all-day event occupies exactly one day");
assert.equal(holiday[0].allDay, true);
assert.equal(holiday[0].time, "");
assert.equal(holiday[0].dayKey, new Date(2026, 8, 12).toDateString());

// A three-day all-day event spans three columns, not four.
const trip = toEvents([{ id: "t", summary: "Offsite",
  start: { date: on(14) }, end: { date: on(17) } }]);
assert.equal(trip.length, 3);
assert.deepEqual(trip.map((e) => new Date(e.dayKey).getDate()), [14, 15, 16]);

// ---- timed events ------------------------------------------------------------------------
const standup = toEvents([{ id: "s", summary: "Standup",
  hangoutLink: "https://meet.google.com/abc-defg-hij",
  start: { dateTime: "2026-09-07T11:00:00+03:00" }, end: { dateTime: "2026-09-07T11:15:00+03:00" },
  attendees: [{ self: true, responseStatus: "accepted" }, {}, {}] }], "#039be5");
assert.equal(standup.length, 1);
assert.equal(standup[0].time, "11:00");
assert.equal(standup[0].end, "11:15");
assert.equal(standup[0].startMin, 11 * 60);
assert.equal(standup[0].endMin, 11 * 60 + 15);
assert.equal(standup[0].link, "https://meet.google.com/abc-defg-hij");
assert.equal(standup[0].color, "#039be5", "the calendar's colour rides along");
assert.equal(standup[0].attendees, 3);

// Cancelled events are dropped — Google returns them so a client can delete its own copy.
assert.equal(toEvents([{ id: "c", status: "cancelled", summary: "Dropped",
  start: { dateTime: "2026-09-07T11:00:00+03:00" } }]).length, 0);

// Declined still appears — it is why the hour is free — but is marked.
assert.equal(toEvents([{ id: "d", summary: "Optional",
  start: { dateTime: "2026-09-07T14:00:00+03:00" }, end: { dateTime: "2026-09-07T15:00:00+03:00" },
  attendees: [{ self: true, responseStatus: "declined" }] }])[0].status, "declined");

// ---- crossing midnight: split into one block per day, never a negative height -------------
const late = toEvents([{ id: "l", summary: "Release window",
  start: { dateTime: "2026-09-12T23:30:00+03:00" }, end: { dateTime: "2026-09-13T01:00:00+03:00" } }]);
assert.equal(late.length, 2, "a meeting crossing midnight becomes one block per day");
assert.equal(late[0].startMin, 23 * 60 + 30);
assert.equal(late[0].endMin, 24 * 60, "the first block ends at midnight, not at 00:00");
assert.equal(late[1].startMin, 0);
assert.equal(late[1].endMin, 60);
assert.ok(late.every((e) => e.endMin > e.startMin), "no block may end before it starts");
assert.notEqual(late[0].id, late[1].id, "split blocks need distinct keys");

// An event ending exactly at midnight stays one block.
const toMidnight = toEvents([{ id: "m", summary: "Evening",
  start: { dateTime: "2026-09-12T22:00:00+03:00" }, end: { dateTime: "2026-09-13T00:00:00+03:00" } }]);
assert.equal(toMidnight.length, 1);
assert.equal(toMidnight[0].endMin, 24 * 60);

// ---- link discovery ----------------------------------------------------------------------
// conferenceData is where Zoom and Teams put their link when hangoutLink is absent.
assert.equal(toEvents([{ id: "z", summary: "Zoom", start: { dateTime: "2026-09-07T10:00:00+03:00" },
  conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+123" },
    { entryPointType: "video", uri: "https://zoom.us/j/1" }] } }])[0].link, "https://zoom.us/j/1");

// A URL in `location` is a join link, not a place — it must not be drawn as both.
const urlLoc = toEvents([{ id: "u", summary: "Call", location: "https://meet.google.com/x",
  start: { dateTime: "2026-09-07T10:00:00+03:00" } }])[0];
assert.equal(urlLoc.link, "https://meet.google.com/x");
assert.equal(urlLoc.location, "");

// ---- guests, organizer, description ------------------------------------------------------
const meeting = toEvents([{ id: "g", summary: "Standup",
  start: { dateTime: "2026-09-07T11:00:00+03:00" }, end: { dateTime: "2026-09-07T11:15:00+03:00" },
  organizer: { displayName: "Hasan Zarif", email: "hasan@x.dev" },
  recurringEventId: "series-1",
  description: "<p>Notes &amp; links</p><br><b>bring the deck</b>",
  attendees: [
    { email: "lara@x.dev", displayName: "Lara Issa", responseStatus: "accepted" },
    { email: "hasan@x.dev", displayName: "Hasan Zarif", organizer: true, self: true, responseStatus: "accepted" },
    { email: "nobody@x.dev", responseStatus: "needsAction" },
    { email: "no@x.dev", displayName: "Busy Person", responseStatus: "declined" },
  ] }])[0];

assert.equal(meeting.guests.length, 4);
assert.equal(meeting.guests[0].name, "Hasan Zarif", "the organizer is listed first");
assert.equal(meeting.guests[0].organizer, true);
assert.equal(meeting.guests[0].self, true);
// An attendee with no displayName falls back to the email, as Google's own UI does.
assert.equal(meeting.guests.find((g) => g.name === "nobody@x.dev").status, "unknown");
assert.equal(meeting.guests.find((g) => g.name === "Busy Person").status, "declined");
// Organized by someone else is worth showing; organized by you is not.
assert.equal(meeting.organizer, "Hasan Zarif");
assert.equal(toEvents([{ id: "mine", summary: "Focus", organizer: { self: true, email: "me@x.dev" },
  start: { dateTime: "2026-09-07T10:00:00+03:00" } }])[0].organizer, "");
// An expanded occurrence carries the id of its series, which is how repetition is known.
assert.equal(meeting.recurrence, "Repeats");
assert.equal(toEvents([{ id: "once", summary: "One off",
  start: { dateTime: "2026-09-07T10:00:00+03:00" } }])[0].recurrence, "");

// HTML never reaches the DOM: tags stripped, entities decoded, breaks kept as newlines.
assert.equal(meeting.description, "Notes & links\n\nbring the deck");
assert.ok(!meeting.description.includes("<"), "no markup survives into the description");
// A script tag is the case that matters, since this renders inside Deck.
assert.equal(toEvents([{ id: "x", summary: "s", description: "<script>alert(1)</script>ok",
  start: { dateTime: "2026-09-07T10:00:00+03:00" } }])[0].description, "alert(1)ok");

// The user's own response is what marks a block struck-through.
assert.equal(toEvents([{ id: "d2", summary: "No thanks",
  start: { dateTime: "2026-09-07T10:00:00+03:00" },
  attendees: [{ self: true, responseStatus: "declined" }] }])[0].status, "declined");
assert.equal(toEvents([{ id: "a2", summary: "Mine",
  start: { dateTime: "2026-09-07T10:00:00+03:00" } }])[0].status, "unknown",
  "no guest list means no response to report");

// ---- the week ----------------------------------------------------------------------------
const week = weekDays(0);
assert.equal(week.length, 7);
assert.equal(week[0].getDay(), 0, "the week starts on Sunday, as Google draws it");
assert.equal(week[6].getDay(), 6);
assert.ok(week.every((d) => d.getHours() === 0), "days are local midnight");
// Consecutive, including across a month boundary.
for (let i = 1; i < 7; i++) {
  assert.equal((week[i] - week[i - 1]) / 864e5, 1, "days must be consecutive");
}
const bounds = weekBounds(0);
assert.ok(new Date(bounds.timeMin) < new Date(bounds.timeMax));
assert.equal((new Date(bounds.timeMax) - new Date(bounds.timeMin)) / 864e5, 7,
  "the range covers exactly seven days");

// ---- overlap layout ----------------------------------------------------------------------
const mk = (id, startMin, endMin) => ({ id, startMin, endMin, allDay: false });

// Two overlapping meetings split the column in half.
const pair = layout([mk("a", 600, 660), mk("b", 630, 690)]);
assert.deepEqual(pair.get("a"), { left: 0, width: 0.5 });
assert.deepEqual(pair.get("b"), { left: 0.5, width: 0.5 });

// Two that do NOT overlap each keep the full width.
const apart = layout([mk("a", 600, 660), mk("b", 700, 760)]);
assert.deepEqual(apart.get("a"), { left: 0, width: 1 });
assert.deepEqual(apart.get("b"), { left: 0, width: 1 });

// Touching at the boundary is not overlapping: 10-11 and 11-12 are side by side in time.
const touching = layout([mk("a", 600, 660), mk("b", 660, 720)]);
assert.equal(touching.get("a").width, 1);
assert.equal(touching.get("b").width, 1);

// Three in one cluster split three ways, and a later separate one is full width again.
const cluster = layout([mk("a", 600, 700), mk("b", 610, 650), mk("c", 620, 690), mk("d", 800, 860)]);
assert.equal(cluster.get("a").width, 1 / 3);
assert.equal(cluster.get("c").width, 1 / 3);
assert.deepEqual(cluster.get("d"), { left: 0, width: 1 });

// All-day events are not laid out in the grid at all.
assert.equal(layout([{ id: "x", allDay: true, startMin: -1, endMin: -1 }]).size, 0);

// ---- "now" -------------------------------------------------------------------------------
const rows = [
  { allDay: true, startMin: -1, endMin: -1 },
  { allDay: false, startMin: minutes("09:30"), endMin: minutes("09:45") },
  { allDay: false, startMin: minutes("14:00"), endMin: minutes("15:00") },
];
assert.equal(currentIndex(rows, minutes("09:35")), 1, "in progress wins");
assert.equal(currentIndex(rows, minutes("10:00")), 2, "else the next one ahead");
assert.equal(currentIndex(rows, minutes("23:00")), -1, "day is over");
assert.equal(until(rows[1], minutes("09:35")), "now");
assert.equal(until(rows[1], minutes("09:25")), "in 5m");
assert.equal(until(rows[2], minutes("09:00")), "in 5h");
assert.equal(until(rows[2], minutes("09:30")), "in 4h 30m");
assert.equal(until(rows[0], minutes("09:00")), "", "all-day has no countdown");

// ---- reminders ---------------------------------------------------------------------------
// What a reminder fires on: timed, not declined, and starting inside the window.
const soon = [
  { id: "allday", allDay: true, status: "accepted", startMin: -1, endMin: -1 },
  { id: "no", allDay: false, status: "declined", startMin: minutes("09:05"), endMin: minutes("09:35") },
  { id: "yes", allDay: false, status: "accepted", startMin: minutes("09:05"), endMin: minutes("09:35") },
  { id: "later", allDay: false, status: "accepted", startMin: minutes("10:00"), endMin: minutes("11:00") },
];
assert.deepEqual(dueSoon(soon, minutes("09:00"), 5).map((e) => e.id), ["yes"],
  "all-day, declined and out-of-window are all skipped");
// The boundary is inclusive at the top, so a 5m threshold catches something exactly 5m out.
assert.equal(dueSoon(soon, minutes("09:00"), 5).length, 1);
assert.equal(dueSoon(soon, minutes("09:01"), 4).length, 1, "4m out, 4m window");
// Already started is not "due soon" — it is now, which is currentIndex's job.
assert.equal(dueSoon(soon, minutes("09:05"), 5).length, 0, "started exactly now");
assert.equal(dueSoon(soon, minutes("09:20"), 5).length, 0, "in progress");
// An unanswered invitation still counts: only an explicit no is excluded.
assert.equal(dueSoon([{ id: "u", allDay: false, status: "unknown",
  startMin: minutes("09:03"), endMin: minutes("09:30") }], minutes("09:00"), 5).length, 1);

// The plugin's cache key must stay off Home's, or each refresh clobbers the other's shape.
const api = readFileSync(join(import.meta.dirname, "src/api.ts"), "utf8");
assert.match(api, /const CACHE = "plugin-calendar"/);

console.log("calendar: all checks passed");
