import type {
  CalendarDaySchedule,
  CalendarSchedulePayload,
  CalendarSlotInfo,
  PreferredSlotSelection,
  SlotState,
  SlotWindow,
} from '../types/contracts';
import type { KvNamespaceLike } from './slots';

export const EDMONTON_TZ = 'America/Edmonton';
export const MORNING_TIME_RANGE = '8:30 AM – 12:30 PM';
export const AFTERNOON_TIME_RANGE = '1:30 PM – 5:30 PM';

const CALENDAR_STORAGE_KEY = 'levelup_calendar_v1';
const BLOB_CALENDAR_PATH = 'levelup/calendar-schedule.json';
const BLOB_API_BASE = 'https://blob.vercel-storage.com';
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface CalendarStoreEnv {
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  BLOB_READ_WRITE_TOKEN?: string;
  LEVELUP_KV?: KvNamespaceLike;
}

export interface CalendarStoreOptions {
  daysCount?: number;
  now?: Date;
  fetchImpl?: typeof fetch;
}

interface PersistedSlotEntry {
  state: SlotState;
  leadId?: string;
}

interface PersistedDayRecord {
  morning?: PersistedSlotEntry;
  afternoon?: PersistedSlotEntry;
}

interface PersistedCalendarState {
  days: Record<string, PersistedDayRecord>;
  updatedAt: string;
}

type StorageBackend = 'upstash' | 'blob' | 'kv' | 'memory';

const memoryCalendarStore = new Map<string, PersistedDayRecord>();

export function hasMemoryCalendarOverrides(): boolean {
  return memoryCalendarStore.size > 0;
}

export function resetMemoryCalendarStore(): void {
  memoryCalendarStore.clear();
}

export function getEdmontonDateKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: EDMONTON_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function detectStorageBackend(env?: CalendarStoreEnv): StorageBackend {
  if (env?.UPSTASH_REDIS_REST_URL?.trim() && env?.UPSTASH_REDIS_REST_TOKEN?.trim()) {
    return 'upstash';
  }
  if (env?.BLOB_READ_WRITE_TOKEN?.trim()) {
    return 'blob';
  }
  if (env?.LEVELUP_KV) {
    return 'kv';
  }
  return 'memory';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSlotState(value: unknown): value is SlotState {
  return value === 'available' || value === 'pending' || value === 'booked';
}

function parseSlotEntry(raw: unknown): PersistedSlotEntry | undefined {
  if (!isPlainRecord(raw) || !isSlotState(raw.state)) {
    return undefined;
  }
  const leadId =
    typeof raw.leadId === 'string' && raw.leadId.trim().length > 0
      ? raw.leadId.trim().slice(0, 64)
      : undefined;
  return leadId ? { state: raw.state, leadId } : { state: raw.state };
}

function normalizePersistedState(raw: unknown): PersistedCalendarState {
  const days: Record<string, PersistedDayRecord> = {};
  if (isPlainRecord(raw) && isPlainRecord(raw.days)) {
    for (const [dateKey, dayVal] of Object.entries(raw.days)) {
      if (!DATE_KEY_PATTERN.test(dateKey) || !isPlainRecord(dayVal)) {
        continue;
      }
      const morning = parseSlotEntry(dayVal.morning);
      const afternoon = parseSlotEntry(dayVal.afternoon);
      if (morning || afternoon) {
        days[dateKey] = {
          ...(morning ? { morning } : {}),
          ...(afternoon ? { afternoon } : {}),
        };
      }
    }
  }
  const updatedAt =
    isPlainRecord(raw) && typeof raw.updatedAt === 'string'
      ? raw.updatedAt
      : new Date().toISOString();
  return { days, updatedAt };
}

function parseJsonState(raw: unknown): PersistedCalendarState {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return { days: {}, updatedAt: new Date().toISOString() };
    }
    try {
      return normalizePersistedState(JSON.parse(trimmed));
    } catch {
      return { days: {}, updatedAt: new Date().toISOString() };
    }
  }
  return normalizePersistedState(raw);
}

async function readPersistedState(
  backend: StorageBackend,
  env: CalendarStoreEnv | undefined,
  fetcher: typeof fetch,
): Promise<PersistedCalendarState> {
  if (backend === 'upstash' && env?.UPSTASH_REDIS_REST_URL && env?.UPSTASH_REDIS_REST_TOKEN) {
    const baseUrl = env.UPSTASH_REDIS_REST_URL.trim().replace(/\/+$/, '');
    const token = env.UPSTASH_REDIS_REST_TOKEN.trim();
    try {
      const response = await fetcher(`${baseUrl}/get/${CALENDAR_STORAGE_KEY}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        return { days: {}, updatedAt: new Date().toISOString() };
      }
      const payload = (await response.json()) as { result?: unknown };
      return parseJsonState(payload.result);
    } catch {
      return { days: {}, updatedAt: new Date().toISOString() };
    }
  }

  if (backend === 'blob' && env?.BLOB_READ_WRITE_TOKEN) {
    const token = env.BLOB_READ_WRITE_TOKEN.trim();
    try {
      const listResponse = await fetcher(
        `${BLOB_API_BASE}?prefix=${encodeURIComponent(BLOB_CALENDAR_PATH)}&limit=1`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );
      if (!listResponse.ok) {
        return { days: {}, updatedAt: new Date().toISOString() };
      }
      const listing = (await listResponse.json()) as {
        blobs?: Array<{ pathname?: string; url?: string }>;
      };
      const match = listing.blobs?.find((item) => item.pathname === BLOB_CALENDAR_PATH);
      if (!match?.url) {
        return { days: {}, updatedAt: new Date().toISOString() };
      }
      const dataResponse = await fetcher(match.url, {
        method: 'GET',
        headers: {
          'Cache-Control': 'no-cache',
        },
      });
      if (!dataResponse.ok) {
        return { days: {}, updatedAt: new Date().toISOString() };
      }
      const rawText = await dataResponse.text();
      return parseJsonState(rawText);
    } catch {
      return { days: {}, updatedAt: new Date().toISOString() };
    }
  }

  if (backend === 'kv' && env?.LEVELUP_KV) {
    try {
      const raw = await env.LEVELUP_KV.get(CALENDAR_STORAGE_KEY);
      return parseJsonState(raw);
    } catch {
      return { days: {}, updatedAt: new Date().toISOString() };
    }
  }

  const days: Record<string, PersistedDayRecord> = {};
  for (const [key, val] of memoryCalendarStore.entries()) {
    days[key] = {
      ...(val.morning ? { morning: { ...val.morning } } : {}),
      ...(val.afternoon ? { afternoon: { ...val.afternoon } } : {}),
    };
  }
  return { days, updatedAt: new Date().toISOString() };
}

async function writePersistedState(
  backend: StorageBackend,
  state: PersistedCalendarState,
  weeklyOpenSlots: number,
  env: CalendarStoreEnv | undefined,
  fetcher: typeof fetch,
): Promise<void> {
  const serialized = JSON.stringify(state);

  if (backend === 'upstash' && env?.UPSTASH_REDIS_REST_URL && env?.UPSTASH_REDIS_REST_TOKEN) {
    const baseUrl = env.UPSTASH_REDIS_REST_URL.trim().replace(/\/+$/, '');
    const token = env.UPSTASH_REDIS_REST_TOKEN.trim();
    try {
      await fetcher(`${baseUrl}/set/${CALENDAR_STORAGE_KEY}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: serialized,
      });
    } catch {
      return;
    }
    return;
  }

  if (backend === 'blob' && env?.BLOB_READ_WRITE_TOKEN) {
    const token = env.BLOB_READ_WRITE_TOKEN.trim();
    try {
      await fetcher(`${BLOB_API_BASE}/${BLOB_CALENDAR_PATH}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'x-add-random-suffix': 'false',
          'x-content-type': 'application/json',
          'cache-control-max-age': '0',
        },
        body: serialized,
      });
    } catch {
      return;
    }
    return;
  }

  if (backend === 'kv' && env?.LEVELUP_KV) {
    try {
      await env.LEVELUP_KV.put(CALENDAR_STORAGE_KEY, serialized);
      await env.LEVELUP_KV.put('weekly_open_slots', String(Math.min(9, Math.max(0, weeklyOpenSlots))));
    } catch {
      return;
    }
    return;
  }

  memoryCalendarStore.clear();
  for (const [key, val] of Object.entries(state.days)) {
    memoryCalendarStore.set(key, {
      ...(val.morning ? { morning: { ...val.morning } } : {}),
      ...(val.afternoon ? { afternoon: { ...val.afternoon } } : {}),
    });
  }
}

function getDeterministicDemoState(
  dayOffset: number,
  windowName: 'morning' | 'afternoon',
): SlotState {
  if (dayOffset === 1 && windowName === 'morning') {
    return 'booked';
  }
  if (dayOffset === 2 && windowName === 'afternoon') {
    return 'booked';
  }
  if (dayOffset === 4 && windowName === 'morning') {
    return 'booked';
  }
  if (dayOffset === 6 && windowName === 'afternoon') {
    return 'booked';
  }
  return 'available';
}

function buildSchedulePayload(
  persisted: PersistedCalendarState,
  backend: StorageBackend,
  daysCount: number,
  now: Date,
): CalendarSchedulePayload {
  const safeDaysCount = Math.min(90, Math.max(1, Math.round(daysCount)));
  const anchorKey = getEdmontonDateKey(now);
  const [yearStr, monthStr, dayStr] = anchorKey.split('-');
  const baseYear = Number(yearStr);
  const baseMonth = Number(monthStr);
  const baseDay = Number(dayStr);

  const dayLabelFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  });
  const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
  });

  const days: CalendarDaySchedule[] = [];

  for (let offset = 0; offset < safeDaysCount; offset += 1) {
    const utcDate = new Date(Date.UTC(baseYear, baseMonth - 1, baseDay + offset, 12, 0, 0));
    const y = utcDate.getUTCFullYear();
    const m = String(utcDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(utcDate.getUTCDate()).padStart(2, '0');
    const dateKey = `${y}-${m}-${d}`;
    const utcWeekday = utcDate.getUTCDay();
    const record = persisted.days[dateKey];

    const morningEntry = record?.morning;
    const afternoonEntry = record?.afternoon;

    const morningState: SlotState =
      morningEntry?.state ??
      (backend === 'memory' ? getDeterministicDemoState(offset, 'morning') : 'available');
    const afternoonState: SlotState =
      afternoonEntry?.state ??
      (backend === 'memory' ? getDeterministicDemoState(offset, 'afternoon') : 'available');

    const morning: CalendarSlotInfo = {
      window: 'morning',
      label: 'Morning',
      timeRange: MORNING_TIME_RANGE,
      state: morningState,
      ...(morningEntry?.leadId ? { leadId: morningEntry.leadId } : {}),
    };

    const afternoon: CalendarSlotInfo = {
      window: 'afternoon',
      label: 'Afternoon',
      timeRange: AFTERNOON_TIME_RANGE,
      state: afternoonState,
      ...(afternoonEntry?.leadId ? { leadId: afternoonEntry.leadId } : {}),
    };

    const availableWindows =
      (morning.state === 'available' ? 1 : 0) + (afternoon.state === 'available' ? 1 : 0);
    const fullDayAvailable = morning.state === 'available' && afternoon.state === 'available';

    let statusSummary: CalendarDaySchedule['statusSummary'];
    if (availableWindows === 2) {
      statusSummary = 'available';
    } else if (availableWindows === 1) {
      statusSummary = 'one_left';
    } else if (morning.state === 'pending' || afternoon.state === 'pending') {
      statusSummary = 'pending';
    } else {
      statusSummary = 'booked';
    }

    days.push({
      date: dateKey,
      dayLabel: dayLabelFormatter.format(utcDate),
      weekdayShort: weekdayFormatter.format(utcDate),
      isWeekend: utcWeekday === 0 || utcWeekday === 6,
      morning,
      afternoon,
      availableWindows,
      fullDayAvailable,
      statusSummary,
    });
  }

  const weeklyOpenSlots = days
    .slice(0, 7)
    .reduce((sum, day) => sum + day.availableWindows, 0);

  return {
    timezone: EDMONTON_TZ,
    generatedAt: now.toISOString(),
    storageBackend: backend,
    weeklyOpenSlots,
    days,
  };
}

export async function getCalendarSchedule(
  env?: CalendarStoreEnv,
  options?: CalendarStoreOptions,
): Promise<CalendarSchedulePayload> {
  const backend = detectStorageBackend(env);
  const fetcher = options?.fetchImpl ?? globalThis.fetch;
  const daysCount = options?.daysCount ?? 45;
  const now = options?.now ?? new Date();
  const persisted = await readPersistedState(backend, env, fetcher);
  return buildSchedulePayload(persisted, backend, daysCount, now);
}

export async function reserveCalendarSlot(
  selection: PreferredSlotSelection,
  leadId: string,
  env?: CalendarStoreEnv,
  options?: { now?: Date; fetchImpl?: typeof fetch },
): Promise<{ ok: boolean; reason?: string; schedule: CalendarSchedulePayload }> {
  const backend = detectStorageBackend(env);
  const fetcher = options?.fetchImpl ?? globalThis.fetch;
  const now = options?.now ?? new Date();
  const persisted = await readPersistedState(backend, env, fetcher);
  const currentSchedule = buildSchedulePayload(persisted, backend, 45, now);

  if (!DATE_KEY_PATTERN.test(selection.date)) {
    return {
      ok: false,
      reason: 'Invalid booking date format.',
      schedule: currentSchedule,
    };
  }

  const targetDay = currentSchedule.days.find((day) => day.date === selection.date);
  if (!targetDay) {
    return {
      ok: false,
      reason: 'Selected date is outside the 45-day Edmonton booking window.',
      schedule: currentSchedule,
    };
  }

  if (selection.window === 'morning') {
    if (targetDay.morning.state !== 'available') {
      return {
        ok: false,
        reason: 'Morning window is already booked or pending confirmation.',
        schedule: currentSchedule,
      };
    }
  } else if (selection.window === 'afternoon') {
    if (targetDay.afternoon.state !== 'available') {
      return {
        ok: false,
        reason: 'Afternoon window is already booked or pending confirmation.',
        schedule: currentSchedule,
      };
    }
  } else if (selection.window === 'full_day') {
    if (targetDay.morning.state !== 'available' || targetDay.afternoon.state !== 'available') {
      return {
        ok: false,
        reason: 'Full-day slot requires both morning and afternoon windows to be available.',
        schedule: currentSchedule,
      };
    }
  } else {
    return {
      ok: false,
      reason: 'Unsupported slot window selection.',
      schedule: currentSchedule,
    };
  }

  const existingDay = persisted.days[selection.date] ?? {};
  const nextDay: PersistedDayRecord = { ...existingDay };
  const cleanLeadId = leadId.trim().slice(0, 64);
  const pendingEntry: PersistedSlotEntry = {
    state: 'pending',
    ...(cleanLeadId ? { leadId: cleanLeadId } : {}),
  };

  if (selection.window === 'morning' || selection.window === 'full_day') {
    nextDay.morning = pendingEntry;
  }
  if (selection.window === 'afternoon' || selection.window === 'full_day') {
    nextDay.afternoon = pendingEntry;
  }

  const nextState: PersistedCalendarState = {
    days: {
      ...persisted.days,
      [selection.date]: nextDay,
    },
    updatedAt: now.toISOString(),
  };

  const nextSchedule = buildSchedulePayload(nextState, backend, 45, now);
  await writePersistedState(backend, nextState, nextSchedule.weeklyOpenSlots, env, fetcher);

  return {
    ok: true,
    schedule: nextSchedule,
  };
}

export async function setSlotStateAdmin(
  date: string,
  windowChoice: SlotWindow,
  targetState: SlotState,
  leadId?: string,
  env?: CalendarStoreEnv,
  options?: { now?: Date; fetchImpl?: typeof fetch },
): Promise<{ ok: boolean; schedule: CalendarSchedulePayload }> {
  const backend = detectStorageBackend(env);
  const fetcher = options?.fetchImpl ?? globalThis.fetch;
  const now = options?.now ?? new Date();
  const persisted = await readPersistedState(backend, env, fetcher);

  if (
    !DATE_KEY_PATTERN.test(date) ||
    !isSlotState(targetState) ||
    (windowChoice !== 'morning' && windowChoice !== 'afternoon' && windowChoice !== 'full_day')
  ) {
    return {
      ok: false,
      schedule: buildSchedulePayload(persisted, backend, 45, now),
    };
  }

  const existingDay = persisted.days[date] ?? {};
  const nextDay: PersistedDayRecord = { ...existingDay };
  const cleanLeadId = leadId?.trim().slice(0, 64);
  const nextEntry: PersistedSlotEntry =
    targetState === 'available'
      ? { state: 'available' }
      : { state: targetState, ...(cleanLeadId ? { leadId: cleanLeadId } : {}) };

  if (windowChoice === 'morning' || windowChoice === 'full_day') {
    nextDay.morning = nextEntry;
  }
  if (windowChoice === 'afternoon' || windowChoice === 'full_day') {
    nextDay.afternoon = nextEntry;
  }

  const nextState: PersistedCalendarState = {
    days: {
      ...persisted.days,
      [date]: nextDay,
    },
    updatedAt: now.toISOString(),
  };

  const nextSchedule = buildSchedulePayload(nextState, backend, 45, now);
  await writePersistedState(backend, nextState, nextSchedule.weeklyOpenSlots, env, fetcher);

  return {
    ok: true,
    schedule: nextSchedule,
  };
}
