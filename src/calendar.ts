/**
 * Read-only calendar awareness from an ICS feed URL (Google, Proton, Fastmail,
 * Outlook all export one). The feed is fetched with a short in-memory cache and
 * parsed just enough to answer "what is on the user's calendar today":
 * single events, all-day events, and simple DAILY/WEEKLY/MONTHLY/YEARLY
 * recurrence (INTERVAL, BYDAY, UNTIL, COUNT). Exotic RRULE features are
 * ignored rather than guessed at.
 */

export interface CalendarEvent {
  summary: string;
  /** UTC instant of this occurrence's start; null for all-day events. */
  start: Date | null;
  /** UTC instant of this occurrence's end; null when absent or all-day. */
  end: Date | null;
  allDay: boolean;
}

const DAY_MS = 86_400_000;
const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_EVENTS_SHOWN = 6;

const WEEKDAY_CODES: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

// ---------------------------------------------------------------------------
// Timezone math (no external deps)
// ---------------------------------------------------------------------------

/** Offset of a timezone (ms to ADD to UTC to get local wall time) at a given instant. */
function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const hour = get("hour") === 24 ? 0 : get("hour");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUtc - at.getTime();
}

/** Convert wall-clock time in a timezone to a UTC instant. */
function zonedToUtc(
  y: number,
  mo: number,
  d: number,
  hh: number,
  mm: number,
  ss: number,
  tz: string
): Date {
  const guess = Date.UTC(y, mo - 1, d, hh, mm, ss);
  let offset = tzOffsetMs(new Date(guess), tz);
  let ts = guess - offset;
  const offset2 = tzOffsetMs(new Date(ts), tz);
  if (offset2 !== offset) ts = guess - offset2;
  return new Date(ts);
}

/** Local "YYYY-MM-DD" of a UTC instant in a timezone. */
export function localDateStr(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  return parts;
}

function localTimeStr(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}

// ---------------------------------------------------------------------------
// ICS parsing
// ---------------------------------------------------------------------------

interface IcsProp {
  params: Record<string, string>;
  value: string;
}

type RawVevent = Record<string, IcsProp>;

/** Unfold RFC 5545 continuation lines (next line starts with space/tab). */
function unfoldLines(text: string): string[] {
  const rawLines = text.split(/\r?\n/);
  const lines: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function parseVevents(text: string): RawVevent[] {
  const events: RawVevent[] = [];
  let current: RawVevent | null = null;

  for (const line of unfoldLines(text)) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;

    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const left = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const [name, ...paramParts] = left.split(";");
    const params: Record<string, string> = {};
    for (const p of paramParts) {
      const eq = p.indexOf("=");
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
    }
    current[name!.toUpperCase()] = { params, value };
  }

  return events;
}

interface ParsedStart {
  /** UTC instant for timed events; null for all-day. */
  utc: Date | null;
  /** "YYYY-MM-DD" for all-day events; null for timed. */
  dateStr: string | null;
}

/** Parse a DTSTART/DTEND value. `fallbackTz` covers floating (no-Z, no-TZID) times. */
function parseIcsDate(prop: IcsProp | undefined, fallbackTz: string): ParsedStart | null {
  if (!prop) return null;
  const value = prop.value.trim();

  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (prop.params.VALUE === "DATE" || dateOnly) {
    const m = dateOnly ?? /^(\d{4})(\d{2})(\d{2})/.exec(value);
    if (!m) return null;
    return { utc: null, dateStr: `${m[1]}-${m[2]}-${m[3]}` };
  }

  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m;
  const nums = [y, mo, d, hh, mm, ss].map(Number) as [number, number, number, number, number, number];

  if (z === "Z") {
    return { utc: new Date(Date.UTC(nums[0], nums[1] - 1, nums[2], nums[3], nums[4], nums[5])), dateStr: null };
  }

  let tz = prop.params.TZID ?? fallbackTz;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = fallbackTz; // unknown TZID (e.g. Windows zone name) — fall back
  }
  return { utc: zonedToUtc(nums[0], nums[1], nums[2], nums[3], nums[4], nums[5], tz), dateStr: null };
}

function parseRrule(prop: IcsProp | undefined): Record<string, string> | null {
  if (!prop) return null;
  const rule: Record<string, string> = {};
  for (const part of prop.value.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) rule[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).toUpperCase();
  }
  return Object.keys(rule).length ? rule : null;
}

// ---------------------------------------------------------------------------
// Recurrence — does an occurrence land on the target local date?
// ---------------------------------------------------------------------------

function parseUntil(value: string | undefined, fallbackTz: string): Date | null {
  if (!value) return null;
  const parsed = parseIcsDate({ params: {}, value }, fallbackTz);
  if (!parsed) return null;
  if (parsed.utc) return parsed.utc;
  // Date-only UNTIL: include the whole day.
  return new Date(new Date(`${parsed.dateStr}T23:59:59.000Z`).getTime());
}

/** Occurrences of a timed recurring event within [windowStart, windowEnd]. */
function timedOccurrences(
  startUtc: Date,
  rule: Record<string, string>,
  windowStart: Date,
  windowEnd: Date,
  fallbackTz: string
): Date[] {
  const freq = rule.FREQ;
  const interval = Math.max(1, Number(rule.INTERVAL ?? "1") || 1);
  const until = parseUntil(rule.UNTIL, fallbackTz);
  const count = rule.COUNT ? Number(rule.COUNT) : null;
  const startMs = startUtc.getTime();
  const out: Date[] = [];

  const within = (t: number, occIndex: number): boolean => {
    if (t < startMs) return false;
    if (until && t > until.getTime()) return false;
    if (count !== null && occIndex >= count) return false;
    return true;
  };

  if (freq === "DAILY") {
    const step = interval * DAY_MS;
    const first = Math.max(0, Math.ceil((windowStart.getTime() - startMs) / step));
    for (let k = first; ; k++) {
      const t = startMs + k * step;
      if (t > windowEnd.getTime()) break;
      if (!within(t, k)) break;
      out.push(new Date(t));
    }
    return out;
  }

  if (freq === "WEEKLY") {
    const startDow = startUtc.getUTCDay();
    const byday = (rule.BYDAY ?? "")
      .split(",")
      .map((c) => WEEKDAY_CODES[c.trim()])
      .filter((n): n is number => n !== undefined);
    const days = byday.length ? byday : [startDow];
    // Order days by distance from the event's start weekday so occurrence
    // indices (for COUNT) advance in chronological order.
    const offsets = [...new Set(days)].map((d) => (d - startDow + 7) % 7).sort((a, b) => a - b);
    const weekStep = interval * 7 * DAY_MS;
    const maxK = Math.ceil((windowEnd.getTime() - startMs) / weekStep) + 1;
    let occIndex = 0;
    for (let k = 0; k <= maxK; k++) {
      for (const off of offsets) {
        const t = startMs + k * weekStep + off * DAY_MS;
        if (t < startMs) continue;
        if (until && t > until.getTime()) return out;
        if (count !== null && occIndex >= count) return out;
        occIndex++;
        if (t >= windowStart.getTime() && t <= windowEnd.getTime()) out.push(new Date(t));
      }
    }
    return out;
  }

  if (freq === "MONTHLY" || freq === "YEARLY") {
    // Pragmatic: match same day-of-month (and month for YEARLY) at the event's
    // original wall-clock time, ignoring COUNT/BYxxx beyond UNTIL.
    for (let t = windowStart.getTime(); t <= windowEnd.getTime() + DAY_MS; t += DAY_MS) {
      const candidate = new Date(t);
      const sameDay = candidate.getUTCDate() === startUtc.getUTCDate();
      const sameMonth = candidate.getUTCMonth() === startUtc.getUTCMonth();
      if (!sameDay || (freq === "YEARLY" && !sameMonth)) continue;
      const occ = Date.UTC(
        candidate.getUTCFullYear(),
        candidate.getUTCMonth(),
        candidate.getUTCDate(),
        startUtc.getUTCHours(),
        startUtc.getUTCMinutes(),
        startUtc.getUTCSeconds()
      );
      if (occ >= startMs && (!until || occ <= until.getTime()) && occ <= windowEnd.getTime() && occ >= windowStart.getTime()) {
        out.push(new Date(occ));
      }
    }
    return out;
  }

  // Unsupported FREQ: only the literal first occurrence.
  if (startMs >= windowStart.getTime() && startMs <= windowEnd.getTime()) out.push(startUtc);
  return out;
}

/** Whether an all-day recurring event occurs on the target date. */
function allDayOccursOn(startDateStr: string, rule: Record<string, string> | null, targetDateStr: string): boolean {
  if (!rule) return startDateStr === targetDateStr;

  const start = new Date(`${startDateStr}T00:00:00.000Z`).getTime();
  const target = new Date(`${targetDateStr}T00:00:00.000Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(target) || target < start) return false;

  const until = rule.UNTIL ? parseUntil(rule.UNTIL, "UTC") : null;
  if (until && target > until.getTime()) return false;
  const count = rule.COUNT ? Number(rule.COUNT) : null;
  const interval = Math.max(1, Number(rule.INTERVAL ?? "1") || 1);
  const daysDiff = Math.round((target - start) / DAY_MS);

  if (rule.FREQ === "DAILY") {
    if (daysDiff % interval !== 0) return false;
    return count === null || daysDiff / interval < count;
  }
  if (rule.FREQ === "WEEKLY") {
    const startDow = new Date(start).getUTCDay();
    const targetDow = new Date(target).getUTCDay();
    const byday = (rule.BYDAY ?? "")
      .split(",")
      .map((c) => WEEKDAY_CODES[c.trim()])
      .filter((n): n is number => n !== undefined);
    const days = byday.length ? byday : [startDow];
    if (!days.includes(targetDow)) return false;
    const weeksDiff = Math.floor(daysDiff / 7);
    return weeksDiff % interval === 0;
  }
  if (rule.FREQ === "MONTHLY") {
    return new Date(target).getUTCDate() === new Date(start).getUTCDate();
  }
  if (rule.FREQ === "YEARLY") {
    const s = new Date(start);
    const t = new Date(target);
    return s.getUTCDate() === t.getUTCDate() && s.getUTCMonth() === t.getUTCMonth();
  }
  return startDateStr === targetDateStr;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** All events from an ICS document that occur on a local date ("YYYY-MM-DD") in `tz`. */
export function eventsOnLocalDate(icsText: string, dateStr: string, tz: string): CalendarEvent[] {
  const [y, mo, d] = dateStr.split("-").map(Number) as [number, number, number];
  const dayStart = zonedToUtc(y, mo, d, 0, 0, 0, tz);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS - 1);
  // Expand slightly so timezone offsets can't clip occurrences, then filter exactly.
  const windowStart = new Date(dayStart.getTime() - DAY_MS);
  const windowEnd = new Date(dayEnd.getTime() + DAY_MS);

  const results: CalendarEvent[] = [];

  for (const raw of parseVevents(icsText)) {
    const summary = (raw.SUMMARY?.value ?? "(untitled)").replace(/\\([,;nN])/g, (_, c) =>
      c.toLowerCase() === "n" ? " " : c
    );
    if (raw.STATUS?.value?.toUpperCase() === "CANCELLED") continue;

    const start = parseIcsDate(raw.DTSTART, tz);
    if (!start) continue;
    const rule = parseRrule(raw.RRULE);

    if (start.dateStr) {
      if (allDayOccursOn(start.dateStr, rule, dateStr)) {
        results.push({ summary, start: null, end: null, allDay: true });
      }
      continue;
    }

    const startUtc = start.utc!;
    const end = parseIcsDate(raw.DTEND, tz);
    const durationMs = end?.utc ? Math.max(0, end.utc.getTime() - startUtc.getTime()) : 0;

    const occurrences = rule
      ? timedOccurrences(startUtc, rule, windowStart, windowEnd, tz)
      : startUtc >= windowStart && startUtc <= windowEnd
        ? [startUtc]
        : [];

    for (const occ of occurrences) {
      if (localDateStr(occ, tz) !== dateStr) continue;
      results.push({
        summary,
        start: occ,
        end: durationMs > 0 ? new Date(occ.getTime() + durationMs) : null,
        allDay: false,
      });
    }
  }

  return results.sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0);
  });
}

const icsCache = new Map<string, { fetchedAt: number; text: string }>();

/** For tests. */
export function clearCalendarCache(): void {
  icsCache.clear();
}

async function fetchIcs(url: string): Promise<string> {
  const cached = icsCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.text;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`calendar feed returned ${res.status}`);
    const text = await res.text();
    icsCache.set(url, { fetchedAt: Date.now(), text });
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Today's events for a user's ICS feed. Throws on fetch/parse failure — callers degrade gracefully. */
export async function getTodaysEvents(icsUrl: string, tz: string): Promise<CalendarEvent[]> {
  const text = await fetchIcs(icsUrl);
  return eventsOnLocalDate(text, localDateStr(new Date(), tz), tz);
}

/** Compact message lines for a day's events (used by the nudge and the AI prompt). */
export function formatEventLines(events: CalendarEvent[], tz: string): string[] {
  const lines: string[] = [];
  for (const e of events.slice(0, MAX_EVENTS_SHOWN)) {
    if (e.allDay) {
      lines.push(`\u2022 all day — ${e.summary}`);
    } else {
      const range = e.end
        ? `${localTimeStr(e.start!, tz)}–${localTimeStr(e.end, tz)}`
        : localTimeStr(e.start!, tz);
      lines.push(`\u2022 ${range} ${e.summary}`);
    }
  }
  if (events.length > MAX_EVENTS_SHOWN) {
    lines.push(`\u2022 …and ${events.length - MAX_EVENTS_SHOWN} more`);
  }
  return lines;
}

/** Total busy hours across timed events (rough — overlaps count twice). */
export function totalBusyHours(events: CalendarEvent[]): number {
  let ms = 0;
  for (const e of events) {
    if (!e.allDay && e.start && e.end) ms += e.end.getTime() - e.start.getTime();
  }
  return Math.round((ms / 3_600_000) * 10) / 10;
}
