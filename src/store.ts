// The calendar's live half: the modal's open/closed state, and the loop that watches for a
// meeting about to start.
//
// Module-level rather than React state for the usual Deck reason — a plugin's slots are separate
// mount points. `commands()` is a plain function with no component around it, `Status` renders in
// the footer and `Provider` wraps the app; all three have to agree on whether the modal is open,
// and only something outside the tree can hold that.
//
// The reminder LOOP deliberately does not live here. Module scope runs again on every plugin
// reload (see the note on reloadPlugins in src/core/plugins.ts), so an interval started here
// would be duplicated by each reload with no way to clear the old one. It lives in Provider's
// effect instead, which unmounts — and therefore cleans up — when the plugin reloads.
import { notifyOs, openExternal } from "../shim/bridge.js";
import { toast } from "../shim/ui.js";
import { dueSoon, type CalEvent } from "./events";
import { readCache, weekKey, fetchWeek } from "./api";

/** How early a meeting announces itself. */
// ponytail: hardcoded rather than a setting — one number, nobody has asked to change it, and a
// Settings panel for it is more code than the feature.
const LEAD_MIN = 5;

/** How stale the cache may be before the loop refetches. */
const STALE_MS = 15 * 60_000;

// ---- the modal ------------------------------------------------------------------------------

let open = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const isOpen = () => open;

export function setOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  emit();
}

// ---- the reminder loop ----------------------------------------------------------------------

/**
 * The reminder currently on screen for an event, by event id.
 *
 * Two jobs. It stops the minute tick raising a second toast for a meeting already being
 * announced — otherwise one event produces five, on its way down from "in 5m". And it holds the
 * dismiss handle, because a reminder stays up until the meeting starts rather than expiring on a
 * timer, so something has to take it down.
 */
const announced = new Map<string, () => void>();

/** Minutes since local midnight. */
const minsNow = (d: Date) => d.getHours() * 60 + d.getMinutes();

/**
 * Today's events, from the cache, refetched when it is missing, stale, or for another week.
 *
 * The cache is the medium on purpose: the grid already writes it on every load, so the loop and
 * the grid cannot disagree about what is on the calendar, and a week the user is looking at
 * costs no extra request.
 *
 * A failure is swallowed. This runs every minute in the background, and a disconnected Google
 * account would otherwise raise an error toast sixty times an hour — the grid is where that
 * state is reported, because that is where the user went to look at it.
 */
async function todaysEvents(): Promise<CalEvent[]> {
  const thisWeek = weekKey(0);
  let cached = await readCache().catch(() => null);
  if (!cached || cached.week !== thisWeek || Date.now() - cached.fetched > STALE_MS) {
    try {
      // fetchWeek writes the cache itself, so the grid sees the refresh too.
      const events = await fetchWeek(0);
      cached = { week: thisWeek, events, fetched: Date.now() };
    } catch {
      // Keep whatever was cached — a stale week is still worth reminding from.
      if (!cached || cached.week !== thisWeek) return [];
    }
  }
  const today = new Date().toDateString();
  return cached.events.filter((e) => e.dayKey === today);
}

/**
 * One pass: announce anything starting within the lead time that has not been announced yet.
 *
 * Exported so the Provider's effect can call it immediately on mount as well as on each tick —
 * otherwise a Deck started four minutes before a meeting would say nothing until the next
 * minute boundary.
 */
export async function checkReminders(): Promise<void> {
  const events = await todaysEvents();
  const now = minsNow(new Date());

  // Take down the reminder for anything that has started: it has said what it had to say, and
  // the countdown on it is no longer true.
  for (const [id, dismiss] of announced) {
    const e = events.find((x) => x.id === id);
    if (!e || e.startMin <= now) { dismiss(); announced.delete(id); }
  }

  for (const e of dueSoon(events, now, LEAD_MIN)) {
    const mins = e.startMin - now;
    const when = mins <= 1 ? "now" : `in ${mins}m`;
    const text = e.link ? `${e.title} ${when} — click to join` : `${e.title} ${when}`;

    // Already up: replace it so the countdown stays honest ("in 4m" a minute after "in 5m")
    // rather than leaving a stale number on screen for the whole five minutes.
    const repeat = announced.has(e.id);
    announced.get(e.id)?.();

    const dismiss = toast(text, "info", {
      // Stays until the meeting starts. A fixed duration was the wrong shape: the reminder is
      // true for exactly as long as the meeting has not begun, and a minute of that is no use
      // to someone who was not at the screen for that minute.
      ms: 0,
      onClick: () => {
        if (e.link) void openExternal(e.link);
        else setOpen(true);
      },
    });
    announced.set(e.id, dismiss);

    // An in-app toast is invisible when Deck is behind another window or in the tray, which is
    // exactly when a reminder matters most. The OS one is raised only in that case, so a focused
    // Deck does not announce the same meeting twice.
    //
    // First announcement only. The in-app toast is REPLACED each minute to keep its countdown
    // true, which costs nothing; doing the same with a Windows notification would pop one every
    // minute for five minutes.
    if (!repeat && !document.hasFocus()) {
      void notifyOs("Meeting " + when, e.title).catch(() => {});
    }
  }
}

/** The tick interval, in ms. A minute is the resolution the countdown is written at. */
export const TICK_MS = 60_000;

