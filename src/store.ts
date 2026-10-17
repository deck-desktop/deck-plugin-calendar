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
import { openExternal } from "../shim/bridge.js";
import { notify, dismissNotification } from "../shim/ui.js";
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

/** The name Deck shows beside this plugin's notifications. */
const SOURCE = "Calendar";

/**
 * The events with a reminder up, by id, so the tick can take each one down once its meeting has
 * started: a reminder stays until then rather than expiring on a timer.
 */
const announced = new Set<string>();

/** Events whose reminder was dismissed: nothing more is said about them this session. */
const muted = new Set<string>();

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
  for (const id of announced) {
    const e = events.find((x) => x.id === id);
    if (!e || e.startMin <= now) { dismissNotification(SOURCE, id); announced.delete(id); }
  }

  for (const e of dueSoon(events, now, LEAD_MIN)) {
    if (muted.has(e.id)) continue;
    const mins = e.startMin - now;
    announced.add(e.id);

    // Posted again every minute with the same key, so the countdown stays honest ("4 min" a
    // minute after "5 min"). Deck updates a card that is still up in place, with no second chime
    // or Windows notification, so only the first post of each meeting announces it.
    notify({
      kind: "attention", source: SOURCE, key: e.id,
      title: mins <= 1 ? "Starting now" : `Meeting in ${mins} min`,
      body: `${e.title} · ${e.time}`,
      actions: [
        e.link
          ? { label: "Join", primary: true, run: () => void openExternal(e.link).catch((err) => console.warn("[calendar] opening the meeting link failed", err)) }
          : { label: "Open calendar", primary: true, run: () => setOpen(true) },
        { label: "Dismiss", run: () => { muted.add(e.id); announced.delete(e.id); dismissNotification(SOURCE, e.id); } },
      ],
    });
  }
}

/** The tick interval, in ms. A minute is the resolution the countdown is written at. */
export const TICK_MS = 60_000;

