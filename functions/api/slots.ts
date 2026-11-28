import {
  type CalendarStoreEnv,
  getCalendarSchedule,
  hasMemoryCalendarOverrides,
} from '../../src/lib/calendar-store';
import { getSlotsStatus } from '../../src/lib/slots';

export interface SlotsEnv extends CalendarStoreEnv {}

export interface SlotsFunctionContext {
  request: Request;
  env?: SlotsEnv;
  params?: Record<string, string | string[]>;
  waitUntil?: (promise: Promise<unknown>) => void;
  fetchImpl?: typeof fetch;
}

export async function onRequestGet(context: SlotsFunctionContext): Promise<Response> {
  let rawValue: unknown = undefined;

  try {
    if (context.env?.LEVELUP_KV) {
      const kvOverride = await context.env.LEVELUP_KV.get('weekly_open_slots');
      if (kvOverride !== null && kvOverride !== undefined) {
        rawValue = kvOverride;
      } else {
        const schedule = await getCalendarSchedule(context.env, {
          fetchImpl: context.fetchImpl,
        });
        rawValue = schedule.weeklyOpenSlots;
      }
    } else if (
      context.env?.UPSTASH_REDIS_REST_URL?.trim() ||
      context.env?.BLOB_READ_WRITE_TOKEN?.trim() ||
      hasMemoryCalendarOverrides()
    ) {
      const schedule = await getCalendarSchedule(context.env, {
        fetchImpl: context.fetchImpl,
      });
      rawValue = schedule.weeklyOpenSlots;
    }
  } catch {
    rawValue = undefined;
  }

  const status = getSlotsStatus(rawValue);

  return new Response(JSON.stringify(status), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
}
