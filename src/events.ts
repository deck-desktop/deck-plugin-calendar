// Turning Google's event JSON into blocks a week grid can position, and the arithmetic the grid
// needs to place them.
//
// Separate from the component so it is pure and testable: every awkward case in a calendar is in
// here (all-day events and their exclusive end date, meetings that cross midnight, declined and
// cancelled ones, overlap), and none of it needs React or a network call to check.
// See events.check.mjs.

/** One event, placed on one day. A meeting crossing midnight becomes two of these. */
export interface CalEvent {
  id: string;
  title: string;
  /** Which column it belongs to: a local date, as Date.toDateString(). */
  dayKey: string;
  /** Local "HH:MM", or "" for an all-day event. */
  time: string;
  end: string;
  /** Video-call join URL, when the event has one. */
  link: string;
  location: string;
  attendees: number;
  /** Who is invited, for the detail popover. Empty for an event with no guest list. */
  guests: Guest[];
  /** The organizer's display name or email, when someone else owns the event. */
  organizer: string;
  /** "Weekly on weekdays" and the like — Google's own words, when it says them. */
  recurrence: string;
  /** The event's own notes. Plain text; Google allows HTML, which is stripped. */
  description: string;
  /** Whether the user has said yes. Declined events are drawn struck through. */
  status: "accepted" | "declined" | "tentative" | "unknown";
  /** The owning calendar's colour, so several calendars stay tellable apart. */
  color: string;
  /** True for an all-day event, which lives in the band above the grid rather than in it. */
  allDay: boolean;
  /** Minutes since local midnight. Both -1 for an all-day event. */
  startMin: number;
  endMin: number;
}

/** One invited person, as the popover lists them. */
export interface Guest {
  name: string;
  status: "accepted" | "declined" | "tentative" | "unknown";
  organizer: boolean;
  self: boolean;
}

/** Google's shape, as much of it as this plugin reads. */
export interface GoogleEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  organizer?: { displayName?: string; email?: string; self?: boolean };
  recurringEventId?: string;
  hangoutLink?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; email?: string; displayName?: string;
    organizer?: boolean; responseStatus?: string }[];
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
}

const DAY = 24 * 60;

/** Minutes since midnight for an "HH:MM", or -1 when there is none. */
export function minutes(time: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Midnight local on a "YYYY-MM-DD", without the UTC shift `new Date("...")` would apply. */
function parseDateOnly(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/**
 * The join link, in the order Google actually fills these in.
 *
 * `hangoutLink` is the old Meet field and is still set on most events; conferenceData is where
 * Meet, Zoom and Teams all put a video entry point. A `location` that happens to be a URL is the
 * last resort — never invented, because a wrong join link is worse than none.
 */
function joinLink(e: GoogleEvent): string {
  if (e.hangoutLink) return e.hangoutLink;
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video");
  if (video?.uri) return video.uri;
  const loc = (e.location ?? "").trim();
  return /^https?:\/\//.test(loc) ? loc : "";
}

const asStatus = (s?: string): Guest["status"] =>
  s === "accepted" || s === "declined" || s === "tentative" ? s : "unknown";

/** The guest list, organizer first and then in Google's own order. */
function guestList(e: GoogleEvent): Guest[] {
  return (e.attendees ?? []).map((a) => ({
    // An attendee often has no displayName; the email is what Google itself falls back to.
    name: (a.displayName ?? "").trim() || (a.email ?? "").trim() || "(unknown)",
    status: asStatus(a.responseStatus),
    organizer: a.organizer === true,
    self: a.self === true,
  })).sort((x, y) => Number(y.organizer) - Number(x.organizer));
}

/**
 * Google allows HTML in a description. Rendering it would be an injection surface in a plugin
 * that has Deck's whole bridge, so the tags come out and the text stays.
 */
function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Whether the user is going.
 *
 * Anything that is not an explicit no counts as yes: an event with no guest list is one you made
 * for yourself, and an invitation you have not answered is still on your calendar. Only "declined"
 * changes how a block is drawn, so the other cases need no distinction here.
 */
function selfStatus(e: GoogleEvent): CalEvent["status"] {
  return asStatus(e.attendees?.find((a) => a.self)?.responseStatus);
}

/**
 * Flatten Google's events into per-day blocks.
 *
 * Two shapes need care. An all-day event's `end.date` is EXCLUSIVE — a one-day holiday is
 * start=12th, end=13th — so iterating up to but not including the end is what stops every
 * holiday painting two columns. And a timed event running past midnight is split at midnight
 * into one block per day, because a block belongs to a column and cannot span two.
 */
export function toEvents(items: GoogleEvent[], color = ""): CalEvent[] {
  const out: CalEvent[] = [];

  for (const [i, e] of items.entries()) {
    if (e.status === "cancelled") continue;   // returned so a client can delete its own copy

    const base = {
      id: e.id ?? `${i}`,
      title: (e.summary ?? "").trim() || "(no title)",
      link: joinLink(e),
      // Only a place, never a URL: a link is already the Join affordance, and repeating it as
      // location text is a line of noise on every video meeting.
      location: /^https?:\/\//.test((e.location ?? "").trim()) ? "" : (e.location ?? "").trim(),
      attendees: e.attendees?.length ?? 0,
      guests: guestList(e),
      // Only when it is someone else's: "organized by me" is noise on your own calendar.
      organizer: e.organizer?.self ? "" :
        (e.organizer?.displayName ?? "").trim() || (e.organizer?.email ?? "").trim(),
      // Google does not hand back the human sentence ("Weekly on weekdays") on an expanded
      // occurrence, only the id of the series it came from. That is enough to say it repeats,
      // which is the fact worth showing; the exact cadence would need another API call.
      recurrence: e.recurringEventId ? "Repeats" : "",
      description: plainText(e.description ?? ""),
      status: selfStatus(e),
      color,
    };

    if (e.start?.date) {
      const from = parseDateOnly(e.start.date);
      const to = e.end?.date ? parseDateOnly(e.end.date) : new Date(from.getTime() + 864e5);
      for (const d = new Date(from); d < to; d.setDate(d.getDate() + 1)) {
        out.push({ ...base, id: `${base.id}-${d.toDateString()}`, dayKey: d.toDateString(),
          time: "", end: "", allDay: true, startMin: -1, endMin: -1 });
      }
      continue;
    }

    if (!e.start?.dateTime) continue;         // neither a date nor a time: nothing to place
    const start = new Date(e.start.dateTime);
    const end = e.end?.dateTime ? new Date(e.end.dateTime) : new Date(start.getTime() + 36e5);
    if (Number.isNaN(start.getTime())) continue;

    // Split at midnight, one block per day touched.
    const day = new Date(start);
    day.setHours(0, 0, 0, 0);
    let first = true;
    while (day < end) {
      const nextDay = new Date(day);
      nextDay.setDate(nextDay.getDate() + 1);
      const from = first ? start : day;
      const to = end < nextDay ? end : nextDay;
      const startMin = from.getHours() * 60 + from.getMinutes();
      // A block ending exactly at midnight reads as 24:00 on the day it started, not 00:00 on
      // the next — which would give it a negative height.
      const endMin = to.getTime() === nextDay.getTime() ? DAY : to.getHours() * 60 + to.getMinutes();
      out.push({ ...base, id: first ? base.id : `${base.id}-${day.toDateString()}`,
        dayKey: day.toDateString(), time: hhmm(from), end: hhmm(to),
        allDay: false, startMin, endMin });
      day.setDate(day.getDate() + 1);
      first = false;
    }
  }

  // Sorted by day first: these span a week, so ordering on startMin alone would put every day's
  // 00:00 block ahead of the previous evening's — including the two halves of one meeting that
  // crossed midnight, which then read as ending before it began.
  return out.sort((a, b) =>
    Date.parse(a.dayKey) - Date.parse(b.dayKey)
    || a.startMin - b.startMin
    || a.title.localeCompare(b.title));
}

/** The seven local dates of a week, Sunday first — the week Google Calendar draws by default. */
export function weekDays(weekOffset: number): Date[] {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay() + weekOffset * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(d);
    x.setDate(x.getDate() + i);
    return x;
  });
}

/** RFC-3339 bounds covering a whole week, for the API's timeMin/timeMax. */
export function weekBounds(weekOffset: number): { timeMin: string; timeMax: string } {
  const days = weekDays(weekOffset);
  const end = new Date(days[6]);
  end.setDate(end.getDate() + 1);
  return { timeMin: days[0].toISOString(), timeMax: end.toISOString() };
}

/** Where a block sits horizontally when several overlap, as a 0..1 fraction of the column. */
export interface Slot { left: number; width: number }

/**
 * Lay out one day's timed events side by side where they overlap.
 *
 * ponytail: a cluster of mutually overlapping events splits the column evenly by how many are in
 * it, rather than packing each event into the narrowest free lane. Even splitting is what Google
 * does for the common case (two or three overlapping meetings) and is a few lines; real interval
 * packing is worth writing the day a calendar makes the difference visible.
 */
export function layout(dayEvents: CalEvent[]): Map<string, Slot> {
  const slots = new Map<string, Slot>();
  const sorted = [...dayEvents].filter((e) => !e.allDay).sort((a, b) => a.startMin - b.startMin);

  let cluster: CalEvent[] = [];
  let clusterEnd = -1;
  const flush = () => {
    cluster.forEach((e, i) => slots.set(e.id, { left: i / cluster.length, width: 1 / cluster.length }));
    cluster = [];
    clusterEnd = -1;
  };

  for (const e of sorted) {
    // A gap means nothing left in the cluster can overlap what comes next.
    if (cluster.length && e.startMin >= clusterEnd) flush();
    cluster.push(e);
    clusterEnd = Math.max(clusterEnd, e.endMin);
  }
  flush();
  return slots;
}

/** "in 5m" / "now" / "" — the countdown on the next meeting, which is the thing you act on. */
export function until(e: CalEvent, nowMin: number): string {
  if (e.allDay) return "";
  if (nowMin >= e.startMin && nowMin < e.endMin) return "now";
  const d = e.startMin - nowMin;
  if (d <= 0) return "";
  if (d < 60) return `in ${d}m`;
  const h = Math.floor(d / 60);
  return `in ${h}h${d % 60 ? ` ${d % 60}m` : ""}`;
}

/** Which of today's events is "now": in progress, else the next still to come, else -1. */
export function currentIndex(events: CalEvent[], nowMin: number): number {
  let next = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.allDay) continue;
    if (nowMin >= e.startMin && nowMin < e.endMin) return i;
    if (next === -1 && e.startMin > nowMin) next = i;
  }
  return next;
}

/**
 * The events starting within `threshold` minutes — what a reminder fires on.
 *
 * Only timed events you have not declined: an all-day event has no start to be late for, and a
 * meeting you said no to is not one to be nudged about. The window is open at the bottom
 * (`> 0`), so an event that has already started is not re-announced — `currentIndex` is what
 * answers "what am I in right now".
 */
export function dueSoon(events: CalEvent[], nowMin: number, threshold: number): CalEvent[] {
  return events.filter((e) => !e.allDay && e.status !== "declined"
    && e.startMin - nowMin > 0 && e.startMin - nowMin <= threshold);
}
