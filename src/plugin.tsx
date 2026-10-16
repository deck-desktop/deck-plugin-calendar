// The Calendar: a week grid, the way Google Calendar draws one, in a modal over the app.
//
// No tab. The grid is a thing you glance at and dismiss, not a place you navigate to and stay —
// so it opens over whatever you were doing (from the footer readout or the command palette) and
// closes again. What is always on screen is the footer readout: the next meeting and its Join
// button, which is the part you act on.
//
// Deck contributes the Google account and a token; everything calendar-shaped is here. The
// account is Deck's because a refresh token is access to a whole Google account and does not
// belong in a plugin bundle — but the API calls, the event shape and this grid are the plugin's,
// and someone else could write a different one against the same token.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { CalendarDays, RotateCw, Video, ChevronLeft, ChevronRight, AlertCircle, Link2,
  X, MapPin, Users, Repeat, AlignLeft } from "lucide-react";
import { googleAccount, openExternal } from "../shim/bridge.js";
import { listen } from "../shim/event.js";
import { currentIndex, layout, until, weekDays, type CalEvent, type Guest } from "./events";
import { clearCache, fetchWeek, readCache, weekKey } from "./api";
// Aliased: the grid has its own `setOpen` for the details popover, and two things called
// setOpen in one file is exactly the confusion that closes the wrong thing.
import { checkReminders, isOpen, setOpen as setModalOpen, subscribe, TICK_MS } from "./store";

/** Pixels per hour. The grid is 24 of these tall and scrolls; everything is positioned off it. */
const HOUR_PX = 48;
const DAY_PX = 24 * HOUR_PX;

/** Fallback when a calendar has no colour of its own. */
const DEFAULT_COLOR = "#7c6df2";

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** Every line in the grid. One value so the hour rules and the day dividers cannot disagree —
 *  and far fainter than --border-subtle, which is sized for a panel edge and reads as white
 *  once it is repeated 24 times down and 7 across. */
const LINE = "rgba(255,255,255,0.055)";

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** "3m ago" — how stale the grid is, which is the question a refresh button raises. */
function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

/** "September 2026", or "Aug – Sep 2026" for a week that straddles two months. */
function rangeLabel(days: Date[]): string {
  const [a, b] = [days[0], days[6]];
  const month = (d: Date) => d.toLocaleDateString(undefined, { month: "long" });
  if (a.getMonth() === b.getMonth()) return `${month(a)} ${a.getFullYear()}`;
  const short = (d: Date) => d.toLocaleDateString(undefined, { month: "short" });
  return a.getFullYear() === b.getFullYear()
    ? `${short(a)} – ${short(b)} ${b.getFullYear()}`
    : `${short(a)} ${a.getFullYear()} – ${short(b)} ${b.getFullYear()}`;
}

/** Where a popover was opened from, so it can be placed beside its block. */
interface Anchor { x: number; y: number }

const GUEST_MARK: Record<Guest["status"], string> = {
  accepted: "✓", declined: "✕", tentative: "?", unknown: "",
};

/**
 * Event details, beside the block that was clicked.
 *
 * Not a portal: a plugin is handed React but not ReactDOM, so createPortal is not available to
 * it. Fixed positioning does the same job here — it escapes the scroll container without needing
 * to render outside the tree — and the coordinates come from the click, clamped so a meeting in
 * Saturday's column does not open off the right edge.
 *
 * Read-only, deliberately. Editing, deleting and RSVP all need calendar write scope, which would
 * mean a new consent screen for buttons nobody asked for yet.
 */
function Details({ e, at, onClose }: { e: CalEvent; at: Anchor; onClose: () => void }) {
  const W = 300;
  const color = e.color || DEFAULT_COLOR;
  // Defensive on a field rather than trusting it: `events` can come from a cache written by an
  // older build, and a missing array here takes the whole tab down with the error boundary.
  const guests = e.guests ?? [];
  const yes = guests.filter((g) => g.status === "accepted").length;
  const awaiting = guests.filter((g) => g.status === "unknown").length;
  const when = new Date(e.dayKey).toLocaleDateString(undefined,
    { weekday: "long", month: "long", day: "numeric" });

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {/* A click anywhere else closes it. Transparent rather than dimmed: the grid behind is
          the context you are reading the event against. */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 overflow-hidden rounded-xl border border-subtle shadow-2xl"
        style={{
          background: "var(--bg-card)",
          width: W,
          left: Math.min(at.x + 8, window.innerWidth - W - 12),
          // Clamped at both ends so a late meeting opens upward rather than off the bottom.
          top: Math.max(12, Math.min(at.y, window.innerHeight - 340)),
        }}
      >
        <div className="flex items-start gap-2 px-4 pt-3">
          <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: color }} />
          <div className="min-w-0 flex-1">
            <div className={"text-sm font-semibold leading-snug text-text-primary " +
              (e.status === "declined" ? "line-through opacity-70" : "")}>
              {e.title}
            </div>
            <div className="mt-0.5 text-[11px] text-text-secondary">
              {when}{e.time && ` · ${e.time} – ${e.end}`}{e.allDay && " · All day"}
            </div>
          </div>
          <button onClick={onClose}
            className="-mr-1 shrink-0 rounded p-1 text-text-muted transition hover:bg-white/5 hover:text-text-primary">
            <X size={13} />
          </button>
        </div>

        <div className="max-h-72 space-y-2.5 overflow-y-auto scroll-thin px-4 pb-3 pt-3">
          {e.link && (
            <button onClick={() => void openExternal(e.link)}
              className="flex w-full items-center justify-center gap-2 rounded-lg py-2 text-xs font-semibold text-white transition hover:brightness-110"
              style={{ background: "var(--accent-strong)" }}>
              <Video size={13} /> Join
            </button>
          )}
          {e.recurrence && (
            <div className="flex items-center gap-2 text-[11px] text-text-muted">
              <Repeat size={12} className="shrink-0" /> {e.recurrence}
            </div>
          )}
          {e.location && (
            <div className="flex items-start gap-2 text-[11px] text-text-secondary">
              <MapPin size={12} className="mt-0.5 shrink-0 text-text-muted" />
              <span className="min-w-0 break-words">{e.location}</span>
            </div>
          )}
          {guests.length > 0 && (
            <div className="flex items-start gap-2">
              <Users size={12} className="mt-0.5 shrink-0 text-text-muted" />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-text-secondary">
                  {guests.length} guest{guests.length === 1 ? "" : "s"}
                  {yes > 0 && <span className="text-text-muted"> · {yes} yes</span>}
                  {awaiting > 0 && <span className="text-text-muted"> · {awaiting} awaiting</span>}
                </div>
                <ul className="mt-1 space-y-0.5">
                  {guests.map((g, i) => (
                    <li key={`${g.name}-${i}`} className="flex items-center gap-1.5 text-[11px]">
                      <span className="w-2.5 shrink-0 text-center text-[10px]"
                        style={{ color: g.status === "declined" ? "var(--danger)" : "var(--text-muted)" }}>
                        {GUEST_MARK[g.status]}
                      </span>
                      <span className={"min-w-0 truncate " +
                        (g.status === "declined" ? "text-text-muted line-through" : "text-text-secondary")}>
                        {g.name}
                      </span>
                      {g.organizer && <span className="shrink-0 text-[10px] text-text-muted">organizer</span>}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {!guests.length && e.organizer && (
            <div className="flex items-center gap-2 text-[11px] text-text-secondary">
              <Users size={12} className="shrink-0 text-text-muted" /> {e.organizer}
            </div>
          )}
          {e.description && (
            <div className="flex items-start gap-2">
              <AlignLeft size={12} className="mt-0.5 shrink-0 text-text-muted" />
              <p className="min-w-0 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-text-secondary">
                {e.description}
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** One timed event, positioned in its day column. */
function Block({ e, left, width, past, onOpen }: {
  e: CalEvent; left: number; width: number; past: boolean;
  onOpen: (e: CalEvent, at: Anchor) => void;
}) {
  const color = e.color || DEFAULT_COLOR;
  const height = Math.max((e.endMin - e.startMin) / 60 * HOUR_PX, 18);
  // Under about half an hour there is no room for a second line, so the time joins the title.
  const tight = height < 34;
  const detail = [e.time && `${e.time}–${e.end}`, e.location, e.attendees > 1 && `${e.attendees} people`]
    .filter(Boolean).join(" · ");

  return (
    <button
      onClick={(ev) => {
        const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
        onOpen(e, { x: r.right, y: r.top });
      }}
      title={detail || e.title}
      // Inline, not Tailwind: these are computed pixel values, and a class like top-[123px]
      // does not exist unless Tailwind's content scan happened to see that exact string.
      style={{
        position: "absolute",
        top: (e.startMin / 60) * HOUR_PX,
        height,
        left: `calc(${left * 100}% + 2px)`,
        width: `calc(${width * 100}% - 4px)`,
        // A near-solid fill rather than a wash: at 25% alpha a pale calendar colour (Google
        // hands out things like #9fe1e7) turns grey on Deck's black and stops identifying
        // anything. The text is the same hue at full strength, which keeps the block readable
        // without a border doing the work.
        background: `${color}${past ? "1f" : "33"}`,
        boxShadow: `inset 3px 0 0 ${color}`,
        color,
        opacity: past ? 0.5 : 1,
        cursor: "pointer",
      }}
      className="overflow-hidden rounded-sm pl-2.5 pr-1.5 py-0.5 text-left transition hover:brightness-150"
    >
      <span className={"block truncate text-[11px] font-medium leading-tight " +
        (e.status === "declined" ? "line-through opacity-70" : "")}>
        {tight && e.time ? `${e.time} ` : ""}{e.title}
        {e.link && <Video size={9} className="ml-1 inline shrink-0 align-baseline opacity-80" />}
      </span>
      {!tight && e.time && (
        <span className="block truncate text-[10px] leading-tight opacity-70">
          {e.time}{e.end && `–${e.end}`}
        </span>
      )}
    </button>
  );
}

function Calendar() {
  const [offset, setOffset] = useState(0);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [fetched, setFetched] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<{ e: CalEvent; at: Anchor } | null>(null);
  // A tick so the now-line moves and "in 5m" stays true without a reload.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const days = useMemo(() => weekDays(offset), [offset]);

  const load = async (week: number, force: boolean) => {
    setBusy(true); setErr("");
    try {
      if (!force) {
        const c = await readCache();
        if (c && c.week === weekKey(week)) {
          setEvents(c.events); setFetched(c.fetched); setBusy(false);
          return;
        }
      }
      setEvents(await fetchWeek(week));
      setFetched(Date.now());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setEvents([]);
      setFetched(null);
    }
    setBusy(false);
  };

  useEffect(() => { setOpen(null); void load(offset, false); }, [offset]);

  // Open on the working day rather than at midnight: two hours of context above "now" is what
  // makes the first frame useful without scrolling.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = Math.max(0, (nowMin / 60 - 2) * HOUR_PX);
    // Only on mount — re-running would yank the view back while the user is scrolling.
  }, []);

  const byDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const e of events) {
      const k = e.dayKey;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(e);
    }
    return m;
  }, [events]);

  // Not connected is not something retrying fixes, so it reads as guidance rather than a failure.
  const disconnected = err.includes("not connected") || err.includes("connect again")
    || err.includes("client ID");
  const allDayRows = days.map((d) => (byDay.get(d.toDateString()) ?? []).filter((e) => e.allDay));
  const hasAllDay = allDayRows.some((r) => r.length > 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 px-5 py-3">
        <CalendarDays size={17} style={{ color: "var(--accent)" }} />
        <h1 className="text-base font-semibold text-text-primary">{rangeLabel(days)}</h1>
        {offset !== 0 && (
          <button onClick={() => setOffset(0)}
            className="rounded-md border border-subtle px-2 py-0.5 text-xs text-text-secondary transition hover:border-strong hover:text-text-primary">
            Today
          </button>
        )}
        <span className="ml-auto flex items-center gap-1">
          {fetched && <span className="mr-1 text-[11px] text-text-muted">{ago(fetched)}</span>}
          <button onClick={() => setOffset(offset - 1)} title="Previous week"
            className="rounded-md p-1.5 text-text-muted transition hover:bg-white/5 hover:text-text-primary">
            <ChevronLeft size={15} />
          </button>
          <button onClick={() => setOffset(offset + 1)} title="Next week"
            className="rounded-md p-1.5 text-text-muted transition hover:bg-white/5 hover:text-text-primary">
            <ChevronRight size={15} />
          </button>
          <button onClick={() => void load(offset, true)} disabled={busy} title="Refresh"
            className="rounded-md p-1.5 text-text-muted transition hover:bg-white/5 hover:text-text-primary disabled:opacity-40">
            <RotateCw size={14} className={busy ? "animate-spin" : ""} />
          </button>
          <button onClick={() => setModalOpen(false)} title="Close"
            className="rounded-md p-1.5 text-text-muted transition hover:bg-white/5 hover:text-text-primary">
            <X size={15} />
          </button>
        </span>
      </div>

      {err && (
        <div className="mx-5 mb-2 flex items-start gap-2 rounded-lg border border-subtle px-3 py-2 text-xs"
          style={{ color: disconnected ? "var(--text-secondary)" : "var(--danger)" }}>
          {disconnected ? <Link2 size={13} className="mt-0.5 shrink-0" />
            : <AlertCircle size={13} className="mt-0.5 shrink-0" />}
          <span className="min-w-0">
            {disconnected
              ? "Connect a Google account from the chip at the top right to see your calendar."
              : err}
          </span>
        </div>
      )}

      {/* Day headings. Outside the scroller so they stay put while the grid scrolls. */}
      <div className="flex shrink-0 border-b border-subtle pr-[var(--sb)] [--sb:10px]">
        <div className="w-14 shrink-0" />
        {days.map((d) => {
          const today = sameDay(d, now);
          return (
            <div key={d.toDateString()} className="flex-1 border-l pb-1.5 text-center" style={{ borderColor: LINE }}>
              <div className="text-[10px] font-medium tracking-wide"
                style={{ color: today ? "var(--accent)" : "var(--text-muted)" }}>
                {WEEKDAYS[d.getDay()]}
              </div>
              <div className="mx-auto flex h-7 w-7 items-center justify-center rounded-full text-sm font-medium"
                style={today
                  ? { background: "var(--accent-strong)", color: "#fff" }
                  : { color: "var(--text-secondary)" }}>
                {d.getDate()}
              </div>
            </div>
          );
        })}
      </div>

      {/* All-day band. Only drawn when something is in it — an empty strip is wasted height. */}
      {hasAllDay && (
        <div className="flex shrink-0 border-b border-subtle">
          <div className="w-14 shrink-0 pr-2 pt-1 text-right text-[10px] text-text-muted">all day</div>
          {days.map((d, i) => (
            <div key={d.toDateString()} className="min-w-0 flex-1 space-y-0.5 border-l p-1" style={{ borderColor: LINE }}>
              {allDayRows[i].map((e) => (
                <button key={e.id} title={e.title}
                  onClick={(ev) => {
                    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                    setOpen({ e, at: { x: r.right, y: r.top } });
                  }}
                  className="block w-full truncate rounded-sm py-0.5 pl-2 pr-1.5 text-left text-[11px] font-medium"
                  style={{ background: `${e.color || DEFAULT_COLOR}33`,
                    boxShadow: `inset 3px 0 0 ${e.color || DEFAULT_COLOR}`,
                    color: e.color || DEFAULT_COLOR }}>
                  {e.title}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* The grid */}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        <div className="relative flex" style={{ height: DAY_PX }}>
          {/* Hour gutter */}
          <div className="w-14 shrink-0">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="relative" style={{ height: HOUR_PX }}>
                {h > 0 && (
                  <span className="absolute right-2 -top-1.5 text-[10px] text-text-muted">
                    {h % 12 === 0 ? 12 : h % 12} {h < 12 ? "AM" : "PM"}
                  </span>
                )}
              </div>
            ))}
          </div>

          {days.map((d) => {
            const dayEvents = (byDay.get(d.toDateString()) ?? []).filter((e) => !e.allDay);
            const slots = layout(dayEvents);
            const today = sameDay(d, now);
            return (
              <div key={d.toDateString()} className="relative min-w-0 flex-1 border-l" style={{ borderColor: LINE }}>
                {/* Hour lines. A background gradient rather than 24 bordered divs: one hairline
                    per hour instead of a border that meets the next div's border and reads as
                    two, which is what made the grid look drawn in white. */}
                <div className="absolute inset-0" style={{
                  backgroundImage: `linear-gradient(to bottom, ${LINE} 1px, transparent 1px)`,
                  backgroundSize: `100% ${HOUR_PX}px`,
                }} />

                {dayEvents.map((e) => {
                  const s = slots.get(e.id) ?? { left: 0, width: 1 };
                  return (
                    <Block key={e.id} e={e} left={s.left} width={s.width}
                      past={d < now && !sameDay(d, now) ? true : today && e.endMin <= nowMin}
                      onOpen={(ev, at) => setOpen({ e: ev, at })} />
                  );
                })}

                {/* Now-line, in today's column only. */}
                {today && (
                  <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center"
                    style={{ top: (nowMin / 60) * HOUR_PX }}>
                    <span className="-ml-1 h-2.5 w-2.5 rounded-full" style={{ background: "#f2544b" }} />
                    <span className="h-px flex-1" style={{ background: "#f2544b" }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {open && <Details e={open.e} at={open.at} onClose={() => setOpen(null)} />}
    </div>
  );
}

/**
 * The modal the grid lives in.
 *
 * Not a portal — a plugin gets React but not ReactDOM, the same constraint `Details` above works
 * around. `position: fixed` escapes the Provider's place in the tree just as well, and the z-index
 * sits below the toast stack's z-[200] so a reminder still paints over an open calendar.
 *
 * Escape closes it. `Details` listens for Escape too, so one press with a popover open closes
 * both — acceptable, and better than the alternative of the popover swallowing the key and
 * leaving the modal feeling stuck.
 */
function Modal() {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") setModalOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50"
      onClick={() => setModalOpen(false)}>
      {/* Stop the click from reaching the backdrop, or every click inside the grid closes it. */}
      <div onClick={(e) => e.stopPropagation()}
        // Grows with the window instead of stopping at a fixed ceiling: seven day columns is the
        // layout that most wants width, and 1100px left half a large screen empty. The 94vw
        // floor still keeps it off the edges, and 1600px stops it becoming a wall of grid.
        className="flex h-[88vh] w-[min(1600px,94vw)] flex-col overflow-hidden rounded-xl border border-subtle shadow-2xl"
        style={{ background: "var(--bg-card)" }}>
        <Calendar />
      </div>
    </div>
  );
}

/**
 * Where the modal is rendered, and where the reminder loop runs.
 *
 * The loop is here rather than at module scope because re-importing a plugin runs module scope
 * again — a reload would leave the old interval running with no handle to clear it. A Provider
 * unmounts on reload, so its cleanup does the right thing. It is not in `Status` either: footer
 * readouts can be switched off in Settings, and reminders should not stop because the readout
 * was hidden.
 */
export function Provider({ children }: { children: ReactNode }) {
  const open = useSyncExternalStore(subscribe, isOpen);

  useEffect(() => {
    // Immediately as well as on the interval: Deck started four minutes before a meeting should
    // say so now, not at the next minute boundary.
    void checkReminders();
    const t = setInterval(() => void checkReminders(), TICK_MS);
    return () => clearInterval(t);
  }, []);

  // Disconnecting the Google account throws the cached week away.
  //
  // The cache holds meeting titles, attendee counts and join links fetched with that account, so
  // keeping them after a disconnect would leave Google data on disk with no account attached —
  // and Deck's privacy policy says a disconnect removes the data, not just the credential. Deck
  // cannot clear this itself: the cache is the plugin's, under the plugin's own config key, and
  // the backend knowing that key would put plugin knowledge into Rust. The event is the seam.
  //
  // The same event fires on sign-IN, where clearing would throw away a week the grid may have
  // just fetched, so the account is checked first: `googleAccount()` is null only when there are
  // no tokens, which is the disconnected case and no other.
  useEffect(() => {
    const un = listen("google-auth-changed", () => {
      void googleAccount().then((a) => { if (!a) void clearCache(); }).catch((e) => console.warn("[calendar] account check failed", e));
    });
    return () => { void un.then((f) => f()); };
  }, []);

  return (
    <>
      {children}
      {open && <Modal />}
    </>
  );
}

/**
 * The footer readout: the next meeting, and the one button worth having on it.
 *
 * This is what replaces the tab. The countdown is the part you act on, so it is always visible;
 * the grid behind it is one click away and otherwise out of the way.
 */
export function Status() {
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Read from the cache the grid and the reminder loop both write, so all three agree. Re-read
  // on the tick because the loop refreshes it in the background.
  useEffect(() => {
    let alive = true;
    void readCache().then((c) => {
      if (alive && c && c.week === weekKey(0)) setEvents(c.events);
    }).catch(() => {});
    return () => { alive = false; };
  }, [now]);

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const today = events.filter((e) => e.dayKey === now.toDateString());
  const idx = currentIndex(today, nowMin);
  const next = idx >= 0 ? today[idx] : null;

  return (
    <button onClick={() => setModalOpen(true)}
      title={next ? `${next.title} — open the calendar` : "Open the calendar"}
      className="flex items-center gap-1.5 text-text-muted transition hover:text-text-primary">
      <CalendarDays size={12} />
      {next ? (
        <>
          <span className="max-w-[16ch] truncate">{next.title}</span>
          <span style={{ color: "var(--accent)" }}>{until(next, nowMin)}</span>
          {next.link && (
            // A nested button would be invalid HTML inside the readout's button, so this is a
            // span that stops the click reaching it.
            <span role="button" tabIndex={0}
              onClick={(ev) => { ev.stopPropagation(); void openExternal(next.link); }}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.stopPropagation();
                  void openExternal(next.link);
                }
              }}
              title="Join"
              className="rounded px-1 transition hover:bg-white/10"
              style={{ color: "var(--accent)" }}>
              <Video size={11} />
            </span>
          )}
        </>
      ) : (
        <span>No meetings</span>
      )}
    </button>
  );
}

/** Palette entries, so the calendar is reachable with the footer readout switched off. */
export function commands() {
  return [
    { id: "open", title: "Calendar: open", run: () => setModalOpen(true) },
    { id: "reminders", title: "Calendar: check for reminders now",
      run: () => { void checkReminders(); } },
  ];
}
