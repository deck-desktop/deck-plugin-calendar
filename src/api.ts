// Talking to Google Calendar.
//
// The plugin never sees a refresh token: it asks Deck for a short-lived access token and makes
// the API call itself. That is the point of Deck owning the auth — a plugin that leaks a token
// here leaks an hour of read-only calendar access, not a Google account.
import { googleToken, configRead, configWrite } from "../shim/bridge.js";
import { toEvents, weekBounds, weekDays, type CalEvent, type GoogleEvent } from "./events";

/** Cached under the "plugin-" prefix, in Deck's config dir on this machine.
 *  Deliberately NOT "calendar-cache": that one belongs to Home's rail, and sharing the key would
 *  mean each refresh clobbered the other's shape. */
const CACHE = "plugin-calendar";

/**
 * Bumped whenever CalEvent gains or changes a field.
 *
 * A cache written by an older build holds the older shape, and reading it puts objects into the
 * grid that are missing whatever was added since — which surfaces as the plugin throwing on
 * something like `e.guests.filter` rather than as a stale list. Ignoring a cache whose version
 * does not match costs one fetch and cannot do that.
 */
const SHAPE = 2;

export interface Cached {
  shape?: number;
  /** The week's Sunday, as a local date string, so a cache from another week is not shown. */
  week: string;
  events: CalEvent[];
  fetched: number;
}

export async function readCache(): Promise<Cached | null> {
  try {
    const t = await configRead(CACHE);
    if (!t.trim()) return null;
    const c = JSON.parse(t) as Cached;
    return c.shape === SHAPE ? c : null;
  } catch { return null; }
}

/**
 * Throw the cached week away.
 *
 * Called when the Google account is disconnected. The cache holds meeting titles, attendee
 * counts and join links fetched with that account, and leaving them on disk after a disconnect
 * would contradict what Deck's privacy policy promises — a disconnect is meant to remove the
 * data, not just the credential.
 */
export async function clearCache(): Promise<void> {
  await configWrite(CACHE, "").catch((e) => console.warn("[calendar] cache clear failed", e));
}

/** The key a week's cache is stamped with: its Sunday, local. */
export const weekKey = (offset: number) => weekDays(offset)[0].toDateString();

interface CalListEntry {
  id: string;
  summary?: string;
  backgroundColor?: string;
  /** Google's own checkbox state. Mirroring it means Deck shows what the web UI shows. */
  selected?: boolean;
  primary?: boolean;
}

async function get<T>(url: URL, token: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    // Google's error body is JSON with a readable message; the status alone ("403") does not say
    // whether the API is disabled, the scope is wrong, or the quota is spent.
    const body = await res.text();
    let msg = `${res.status}`;
    try { msg = JSON.parse(body)?.error?.message ?? msg; } catch { /* keep the status */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

/**
 * Every calendar the user has ticked in Google Calendar.
 *
 * Reading `selected` rather than offering a picker of Deck's own: the checkboxes already exist,
 * the user already curates them, and a second list to keep in sync would only ever disagree.
 */
async function calendars(token: string): Promise<CalListEntry[]> {
  const url = new URL("https://www.googleapis.com/calendar/v3/users/me/calendarList");
  url.searchParams.set("minAccessRole", "reader");
  const res = await get<{ items?: CalListEntry[] }>(url, token);
  // `selected` is absent rather than true on the primary calendar for some accounts.
  return (res.items ?? []).filter((c) => c.selected !== false || c.primary);
}

/**
 * Fetch one week from every selected calendar.
 *
 * `singleEvents` expands a recurring series into its occurrences — without it a daily standup
 * comes back as one event with a recurrence rule, and the week would show it once. `orderBy` is
 * only accepted alongside it, and is redundant once events from several calendars are merged,
 * so it is left off.
 */
export async function fetchWeek(weekOffset: number): Promise<CalEvent[]> {
  const token = await googleToken();
  const { timeMin, timeMax } = weekBounds(weekOffset);

  const list = await calendars(token);
  const results = await Promise.allSettled(list.map(async (cal) => {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`);
    url.searchParams.set("timeMin", timeMin);
    url.searchParams.set("timeMax", timeMax);
    url.searchParams.set("singleEvents", "true");
    // A week across several calendars passes 50 easily; holidays alone can fill a page.
    url.searchParams.set("maxResults", "250");
    const res = await get<{ items?: GoogleEvent[] }>(url, token);
    return toEvents(res.items ?? [], cal.backgroundColor ?? "");
  }));

  // One calendar that refuses (a shared one whose access was revoked) must not cost the week.
  const events = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (results.every((r) => r.status === "rejected") && results.length > 0) {
    throw (results[0] as PromiseRejectedResult).reason;
  }

  const cache: Cached = { shape: SHAPE, week: weekKey(weekOffset), events, fetched: Date.now() };
  await configWrite(CACHE, JSON.stringify(cache)).catch((e) => console.warn("[calendar] cache save failed", e));
  return events;
}
